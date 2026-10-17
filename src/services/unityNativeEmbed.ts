import { markRaw, nextTick, shallowReactive, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Window as TauriWindow } from "@tauri-apps/api/window";
import type { WorkspaceRef } from "./project";
import { synchronizeDocument } from "./sharedWorkbenchWindow";
import { resolvedTheme, useTheme } from "../composables/useTheme";
import { enableComposerDraftRecovery } from "../composables/chatComposerDraftMemory";
import { installUnityNativeFileDrop } from "./unityNativeFileDrop";

export interface UnityNativeEmbedSurface {
  label: string;
  windowId: string;
  targetKind: string;
  targetId: string;
  title: string;
  workspaceRef: WorkspaceRef;
  generation: string;
  documentId: string;
  visible: boolean;
  ready: boolean;
  error: string | null;
}
export interface UnityNativeEmbedHost {
  surface: UnityNativeEmbedSurface;
  ownerWindow: Window;
  container: HTMLElement;
  dispose: () => void;
  releases: Set<() => void>;
  disposed: boolean;
}
export const unityNativeEmbedHosts = shallowReactive(new Map<string, UnityNativeEmbedHost>());
// At most four active + two parked documents. Native expiry closes the Core
// and emits document-closed; the JS cache never determines native lifetime.
const documents = new Map<string, Window>();
let syncing: Promise<void> = Promise.resolve();
let stopped = false;

export function reportUnityNativeEmbedFailure(surface: UnityNativeEmbedSurface, error: unknown): Promise<unknown> {
  return invoke("unity_native_embed_failed", {
    label: surface.label, generation: surface.generation,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 1024),
  }).catch(failure => console.warn("[UnityWebView] failure report", failure));
}

async function reconcile(surfaces: UnityNativeEmbedSurface[]): Promise<void> {
  if (stopped) return;
  const current = new Map(surfaces.map(surface => [surface.label, surface]));
  const removed: UnityNativeEmbedHost[] = [];
  for (const [label, host] of unityNativeEmbedHosts) {
    if (current.get(label)?.generation === host.surface.generation && !host.ownerWindow.closed) continue;
    unityNativeEmbedHosts.delete(label); removed.push(host);
  }
  await nextTick();
  for (const host of removed) {
    try { host.dispose(); } catch (error) { console.warn("[UnityWebView] release failed", error); }
  }
  if (stopped) return;
  for (const surface of surfaces) {
    const existing = unityNativeEmbedHosts.get(surface.label);
    if (existing) { existing.surface = surface; continue; }
    if (surface.error) continue; // Unity displays the error and the recovery action.
    try {
    let browser = documents.get(surface.documentId);
    if (!browser || browser.closed) {
      browser = window.open(`about:blank#locus-unity-workbench-${surface.documentId}`, "") ?? undefined;
    }
    if (!browser) throw new Error("Unable to open the Unity workbench WebView.");
    documents.set(surface.documentId, browser);
    const ownerWindow = browser;
    const theme = () => { ownerWindow.document.documentElement.dataset.theme = resolvedTheme("unityEmbed"); };
    const document = synchronizeDocument(ownerWindow, surface.label, theme);
    const releaseTheme = watch(useTheme().unityEmbedPreference, theme, { immediate: true });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", theme);
    ownerWindow.document.title = surface.title;
    const host = shallowReactive({
      surface, ownerWindow: markRaw(ownerWindow), container: markRaw(document.container),
      releases: markRaw(new Set<() => void>()), disposed: false,
      dispose: () => {
        if (host.disposed) return;
        host.disposed = true;
        try {
          for (const release of host.releases) { try { release(); } catch (error) { console.warn("[UnityWebView] listener release", error); } }
          host.releases.clear();
          releaseTheme(); media.removeEventListener("change", theme);
          document.dispose(); document.container.remove();
        } finally {
          void invoke("unity_native_embed_release", { generation: host.surface.generation }).catch(() => {});
        }
      },
    });
    host.releases.add(installUnityNativeFileDrop(ownerWindow, surface.generation));
    unityNativeEmbedHosts.set(surface.label, host);
    } catch (error) {
      await reportUnityNativeEmbedFailure(surface, error);
    }
  }
}
/** Only the desktop Vue owner runs this listener. Child WebViews have no app bootstrap. */
export async function startUnityNativeEmbedHosts(): Promise<() => void> {
  enableComposerDraftRecovery();
  stopped = false;
  documents.clear();
  let revision = 0;
  const enqueue = (surfaces: UnityNativeEmbedSurface[]) => {
    syncing = syncing.then(() => reconcile(surfaces)).catch(error => console.error("[UnityWebView] reconcile failed", error));
    return syncing;
  };
  const unlistenClosed = await listen<string>("unity-native-embed:document-closed", event => { documents.delete(event.payload); });
  const unlisten = await listen<UnityNativeEmbedSurface[]>("unity-native-embed:changed", event => { revision++; void enqueue(event.payload); });
  const initialRevision = revision;
  const initial = await invoke<UnityNativeEmbedSurface[]>("unity_native_embed_attach");
  if (revision === initialRevision) await enqueue(initial);
  else await syncing;
  return () => {
    stopped = true; unlisten(); unlistenClosed(); documents.clear();
    const hosts = [...unityNativeEmbedHosts.values()]; unityNativeEmbedHosts.clear();
    void nextTick().then(() => { for (const host of hosts) host.dispose(); });
  };
}
export function markUnityNativeEmbedReady(host: UnityNativeEmbedHost): Promise<void> {
  return invoke("unity_native_embed_ready", { label: host.surface.label, generation: host.surface.generation });
}
export function nativeEmbedWindowHandle(host: UnityNativeEmbedHost): Pick<TauriWindow, "label" | "listen" | "setFocus"> {
  return {
    label: host.surface.label,
    listen<T>(name: string, handler: (event: import("@tauri-apps/api/event").Event<T>) => void) {
      // Tauri routes the logical target independently of the JS owner's label.
      // This preserves both directed window events and process broadcasts.
      return listen<T>(name, event => { if (!host.disposed) handler(event); }, { target: { kind: "Window", label: host.surface.label } }).then(release => {
        if (host.disposed) { release(); return () => {}; }
        const dispose = () => { host.releases.delete(dispose); release(); };
        host.releases.add(dispose); return dispose;
      });
    },
    setFocus() {
      if (host.disposed) return Promise.resolve();
      return invoke("unity_native_embed_focus", { label: host.surface.label, generation: host.surface.generation });
    },
  };
}
