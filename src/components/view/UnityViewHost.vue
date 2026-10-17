<script setup lang="ts">
import { markRaw, nextTick, onBeforeUnmount, onMounted, shallowReactive } from "vue";
import type { NativeViewBootstrap } from "../../services/nativeViewRuntime";
import ViewRuntimeHost from "./ViewRuntimeHost.vue";
import { nativeViewHosts } from "./viewHostRegistry";

const props = defineProps<{ bootstrap: NativeViewBootstrap; diagnostics: () => unknown }>();
interface NativeChannel { postMessage(value: string): void; addEventListener(name: "message", handler: (event: MessageEvent) => void): void; removeEventListener(name: "message", handler: (event: MessageEvent) => void): void; }
interface BindMessage { type: string; id: number; generation: number; instanceId: string; viewId: string; theme?: string; context?: Record<string, unknown>; requestId?: string; kind?: string; payloadJson?: string; }
interface Surface { id: number; generation: number; instanceId: string; viewId: string; active: boolean; binding: Readonly<Record<string, unknown>>; window: Window; container: HTMLElement; }
const channel = (window as unknown as { chrome: { webview: NativeChannel } }).chrome.webview;
const surfaces = shallowReactive(new Map<number, Surface>());
const children = new Map<number, { window: Window; container: HTMLElement; cleanup(): void }>();
const generations = new Map<number, number>();
const send = (value: unknown) => channel.postMessage(JSON.stringify(value));
const errorMessage = (error: unknown) => error && typeof error === "object" && "message" in error ? String(error.message) : typeof error === "string" ? error : JSON.stringify(error);
let disposed = false;
function child(id: number) {
  const existing = children.get(id); if (existing && !existing.window.closed) return existing;
  const browser = window.open(`about:blank#locus-native-${id}`, "");
  if (!browser) throw new Error("Unable to create an associated native View.");
  const document = browser.document;
  document.title = "Locus View"; document.body.style.margin = "0";
  const container = document.createElement("div"); container.style.cssText = "position:fixed;inset:0;display:flex"; document.body.replaceChildren(container);
  let queued = false;
  const theme = () => {
    document.documentElement.className = window.document.documentElement.className;
    document.documentElement.dataset.theme = window.document.documentElement.dataset.theme ?? "light";
    document.body.style.background = "var(--bg-color)";
  };
  const styles = () => {
    queued = false;
    document.head.querySelectorAll("[data-locus-native-style]").forEach(node => node.remove());
    for (const source of window.document.head.querySelectorAll('style,link[rel="stylesheet"]')) {
      const clone = source.cloneNode(true) as HTMLElement; clone.setAttribute("data-locus-native-style", "");
      if (source instanceof HTMLLinkElement) (clone as HTMLLinkElement).href = source.href;
      document.head.append(clone);
    }
    theme();
  };
  styles();
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target === window.document.documentElement)) theme();
    if (records.some(record => record.target !== window.document.documentElement) && !queued) {
      queued = true; queueMicrotask(() => { if (!disposed && !browser.closed && children.has(id)) styles(); });
    }
  });
  observer.observe(window.document.head, { subtree: true, childList: true, characterData: true, attributes: true });
  observer.observe(window.document.documentElement, { attributes: true });
  const preventNavigation = (event: Event) => event.preventDefault();
  document.addEventListener("dragover", preventNavigation); document.addEventListener("drop", preventNavigation);
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    for (let node = event.target as HTMLElement | null; node && node !== document.body; node = node.parentElement) {
      const css = browser.getComputedStyle(node);
      if (/(auto|scroll)/.test(css.overflowY) && node.scrollHeight > node.clientHeight && ((event.deltaY < 0 && node.scrollTop > 0) || (event.deltaY > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1))) return;
    }
    event.preventDefault(); send({ type: "wheel", id, deltaX: event.deltaX, deltaY: event.deltaY, x: event.clientX, y: event.clientY });
  };
  document.addEventListener("wheel", wheel, { passive: false });
  const shortcut = (event: KeyboardEvent) => {
    if (!event.isComposing && event.keyCode !== 229 && event.ctrlKey && !event.altKey && event.key.toLowerCase() === "s") { event.preventDefault(); send({ type: "shortcut", id, key: "s", shift: event.shiftKey }); }
  };
  document.addEventListener("keydown", shortcut);
  const record = { window: markRaw(browser), container: markRaw(container), cleanup() { observer.disconnect(); document.removeEventListener("dragover", preventNavigation); document.removeEventListener("drop", preventNavigation); document.removeEventListener("wheel", wheel); document.removeEventListener("keydown", shortcut); container.remove(); } };
  children.set(id, record); return record;
}
async function receive(event: MessageEvent) {
  let value: BindMessage;
  try { value = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch { return; }
  if (disposed || !value || !Number.isSafeInteger(value.id) || value.id <= 0) return;
  try {
    if (value.type === "bind") {
      const theme = value.theme === "dark" ? "dark" : "light";
      if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
      if (!Number.isSafeInteger(value.generation) || value.generation <= (generations.get(value.id) ?? 0)) return;
      generations.set(value.id, value.generation); surfaces.delete(value.id); await nextTick();
      if (disposed || generations.get(value.id) !== value.generation) return;
      const host = child(value.id);
      const data = typeof value.context?.dataJson === "string" ? JSON.parse(value.context.dataJson) : undefined;
      const binding = Object.freeze(structuredClone({ ...value.context, data, instanceId: value.instanceId, generation: value.generation }));
      surfaces.set(value.id, { id: value.id, generation: value.generation, instanceId: value.instanceId, viewId: value.viewId, active: true, binding, window: host.window, container: host.container });
    } else if (value.type === "suspend" || value.type === "resume") {
      const surface = surfaces.get(value.id);
      if (surface && surface.generation === value.generation) surfaces.set(value.id, { ...surface, active: value.type === "resume" });
    } else if (value.type === "release") {
      if (generations.get(value.id) !== value.generation) return;
      surfaces.delete(value.id); await nextTick();
      if (generations.get(value.id) === value.generation) send({ type: "released", id: value.id, generation: value.generation });
    } else if (value.type === "destroy") {
      generations.delete(value.id); surfaces.delete(value.id); await nextTick();
      try { children.get(value.id)?.cleanup(); } finally { children.delete(value.id); }
    } else if (value.type === "automation") {
      try {
        if (value.kind === "hostStats") {
          send({ type: "automation-result", id: value.id, requestId: value.requestId, ok: true, resultJson: JSON.stringify({ surfaces: surfaces.size, children: children.size, transport: props.diagnostics() }) });
          return;
        }
        const surface = surfaces.get(value.id);
        if (!surface) throw new Error("Native View is not mounted.");
        const host = nativeViewHosts().find(host => host.instanceId === `${surface.instanceId}:${surface.generation}`);
        if (!host) throw new Error("Native View runtime is unavailable.");
        const result = await host.execute(value.kind ?? "snapshot", JSON.parse(value.payloadJson || "{}"));
        if (surfaces.get(value.id)?.generation !== surface.generation) throw new Error("Native View binding changed during automation.");
        send({ type: "automation-result", id: value.id, requestId: value.requestId, ok: true, resultJson: JSON.stringify(result ?? null) });
      } catch (error) { send({ type: "automation-result", id: value.id, requestId: value.requestId, ok: false, message: errorMessage(error) }); }
    } else if (value.type === "diagnostics") {
      send({ type: "diagnostics", id: value.id, surfaces: surfaces.size, children: children.size, transport: props.diagnostics() });
    }
  } catch (error) { send({ type: "child-error", id: value.id, generation: value.generation, message: errorMessage(error) }); }
}
function ready(surface: Surface) {
  if (surfaces.get(surface.id) === surface) send({ type: "bound", id: surface.id, generation: surface.generation });
}
onMounted(() => { channel.addEventListener("message", receive); send({ type: "host-ready" }); });
onBeforeUnmount(() => { disposed = true; channel.removeEventListener("message", receive); surfaces.clear(); for (const child of children.values()) child.cleanup(); children.clear(); });
</script>
<template>
  <Teleport v-for="surface in surfaces.values()" :key="surface.id + ':' + surface.generation" :to="surface.container">
    <ViewRuntimeHost :view-id="surface.viewId" :workspace-ref="bootstrap.workspaceRef" :instance-id="surface.instanceId + ':' + surface.generation" :window-label="'view-native-' + bootstrap.instanceId" :owner-window="surface.window" :binding="surface.binding" :active="surface.active" @ready="ready(surface)" @failed="message => send({ type: 'child-error', id: surface.id, generation: surface.generation, message })" />
  </Teleport>
</template>
