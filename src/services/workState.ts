import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentTauriWindowLabel, hasTauriWindowRuntime } from "./tauriRuntime";
import type { WorkbenchEditorTransferSnapshot, WorkbenchWindowState } from "../types/workbench";

export interface WindowFrontendState {
  version: 1;
  activeWorkspaceId: string | null;
  activePage?: string;
  sidebar?: WorkbenchWindowState["sidebar"];
  layouts: Record<string, WorkbenchWindowState>;
  editors: Record<string, WorkbenchEditorTransferSnapshot>;
  navigation?: Record<string, {
    expanded: string[];
    secondary: { section: import("../components/workbench/workspaceSecondaryNavigation").WorkspaceSecondarySection;
      projectId: string; checkoutId: string; editorId?: string } | null;
  }>;
}

export interface SavedWorkWindow {
  label: string;
  ownerLabel: string;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  maximized: boolean;
  alwaysOnTop: boolean;
  visible: boolean;
  frontend: WindowFrontendState | null;
}

interface DesktopWorkState {
  schemaVersion: number;
  windows: Record<string, SavedWorkWindow>;
  focusedWindow?: string | null;
  legacyAuxImportPending: boolean;
}

const records = new Map<string, SavedWorkWindow>();
const dirty = new Set<string>();
const providers = new Map<string, () => void | Promise<void>>();
let ownerLabel: string | null = null;
let initialized: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let saving = Promise.resolve();
let exiting = false;
let legacyAuxImport = false;
let captureInstalled = false;

const layoutPrefix = (label: string) => `locus:workbench-window:${label}`;
const pageKey = (label: string) => label === "main" ? "locus:activePage:v1" : `locus:activePage:v1:${label}`;
const emptyFrontend = (): WindowFrontendState => ({ version: 1, activeWorkspaceId: null, layouts: {}, editors: {} });

export function savedWindowState(label: string): WindowFrontendState | null {
  return records.get(label)?.frontend ?? null;
}

function readLegacyFrontend(label: string): WindowFrontendState {
  const state = emptyFrontend();
  try {
    state.activePage = localStorage.getItem(pageKey(label)) ?? undefined;
    for (const key of Object.keys(localStorage)) {
      const prefix = layoutPrefix(label);
      if (key !== prefix && !key.startsWith(`${prefix}:workspace:`)) continue;
      try {
        const layout = JSON.parse(localStorage.getItem(key)!);
        if (layout?.schemaVersion !== 1 || layout.windowId !== label || !layout.groups) continue;
        const scope = key === prefix ? "" : decodeURIComponent(key.slice(`${prefix}:workspace:`.length));
        state.layouts[scope] = layout;
      } catch { /* One damaged old layout must not discard the other workspaces. */ }
    }
  } catch (error) { console.warn("[work-state] legacy layout unavailable", error); }
  return state;
}

function hydrate(record: SavedWorkWindow): void {
  const state = record.frontend?.version === 1 ? record.frontend : readLegacyFrontend(record.label);
  record.frontend = state;
  state.layouts = Object.fromEntries(Object.entries(state.layouts ?? {}).filter(([, layout]) =>
    layout?.schemaVersion === 1 && layout.windowId === record.label && layout.groups && layout.layout));
  state.editors = Object.fromEntries(Object.entries(state.editors ?? {}).filter(([, editor]) =>
    editor && typeof editor === "object" && typeof editor.kind === "string"));
  state.sidebar ??= state.layouts[state.activeWorkspaceId ?? ""]?.sidebar;
  try {
    for (const [scope, layout] of Object.entries(state.layouts)) {
      if (layout.windowId !== record.label) continue;
      const key = scope ? `${layoutPrefix(record.label)}:workspace:${encodeURIComponent(scope)}` : layoutPrefix(record.label);
      // Sidebar geometry belongs to the native window. Seed the unscoped cache
      // too, because the store carries that geometry into the active checkout.
      localStorage.setItem(key, JSON.stringify({ ...layout, sidebar: state.sidebar ?? layout.sidebar }));
    }
    if (state.activePage) localStorage.setItem(pageKey(record.label), state.activePage);
  } catch (error) { console.warn("[work-state] layout cache hydrate failed", error); }
  records.set(record.label, record);
}

export function initializeWorkState(label: string): Promise<void> {
  if (!hasTauriWindowRuntime()) return Promise.resolve();
  if (initialized) return initialized;
  ownerLabel = label;
  initialized = (async () => {
    await listen<string>("locus-work-state-save-requested", ({ payload }) => {
      exiting = true;
      void flushWorkState().then(() => invoke("acknowledge_work_state_save", { requestId: payload }))
        .catch(error => console.error("[work-state] exit save failed", error));
    });
    const snapshot = await invoke<DesktopWorkState>("load_desktop_work_state");
    if (snapshot.schemaVersion !== 1) throw new Error("Unsupported desktop work state version");
    legacyAuxImport = label === "main" && snapshot.legacyAuxImportPending;
    for (const record of Object.values(snapshot.windows)) {
      if (record.ownerLabel === label) hydrate(record);
    }
    if (!records.has(label)) hydrate({ label, ownerLabel: label, visible: true, maximized: false, alwaysOnTop: false, frontend: null });
    if (!captureInstalled) {
      captureInstalled = true;
      // Capture view-only changes as well as edits. No periodic whole-app polling.
      for (const type of ["input", "change", "pointerup", "scroll", "focusout"]) {
        document.addEventListener(type, scheduleWorkStateCapture, { capture: true, passive: true });
      }
      window.addEventListener("pagehide", () => { void flushWorkState(); });
    }
  })().catch(error => { initialized = null; throw error; });
  return initialized;
}

export function registerWorkStateProvider(label: string, provider: () => void | Promise<void>): () => void {
  providers.set(label, provider);
  return () => { if (providers.get(label) === provider) providers.delete(label); };
}

export function ensureWorkWindow(label: string): void {
  if (!ownerLabel || records.has(label)) return;
  hydrate({ label, ownerLabel, visible: true, maximized: false, alwaysOnTop: false, frontend: null });
  dirty.add(label);
}

export function updateWindowWorkState(label: string, patch: Partial<WindowFrontendState>): void {
  if (!ownerLabel) return;
  ensureWorkWindow(label);
  const record = records.get(label)!;
  const next = { ...record.frontend!, ...patch, version: 1 as const };
  if (JSON.stringify(next) === JSON.stringify(record.frontend)) return;
  record.frontend = next;
  dirty.add(label);
  scheduleWorkStateCapture();
}

export function recordWorkbenchLayout(label: string, scope: string | null, layout: WorkbenchWindowState): void {
  if (!ownerLabel || !records.has(label)) return;
  const state = savedWindowState(label)!;
  // Copy before enqueuing so later reactive mutations cannot change a queued write.
  const copy = JSON.parse(JSON.stringify(layout)) as WorkbenchWindowState;
  updateWindowWorkState(label, { layouts: { ...state.layouts, [scope ?? ""]: copy }, activeWorkspaceId: scope, sidebar: copy.sidebar });
}

export function recordActivePage(page: string): void {
  if (ownerLabel) updateWindowWorkState(ownerLabel, { activePage: page });
}

export function scheduleWorkStateCapture(): void {
  if (!ownerLabel || exiting || timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushWorkState().catch(error => console.warn("[work-state] save failed", error));
  }, 400);
}

export function flushWorkState(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const operation = async () => {
    for (const provider of providers.values()) await provider();
    for (const label of [...dirty]) {
      const record = records.get(label);
      if (!record) { dirty.delete(label); continue; }
      const frontend = record.frontend;
      await invoke("save_window_work_state", { label, frontend });
      if (record.frontend === frontend) dirty.delete(label);
    }
  };
  saving = saving.catch(() => {}).then(operation);
  return saving;
}

export function forgetWorkWindow(label: string): void {
  records.delete(label);
  dirty.delete(label);
  providers.delete(label);
}

export function isWorkStateExiting(): boolean { return exiting; }

export function restoredAuxWindows(): SavedWorkWindow[] {
  return [...records.values()].filter(record => record.label !== record.ownerLabel && record.ownerLabel === ownerLabel);
}

export function shouldImportLegacyAuxWindows(): boolean { return legacyAuxImport; }

export async function finishWorkStateRestore(): Promise<void> {
  await flushWorkState();
  if (ownerLabel === "main") {
    await invoke("finish_work_state_migration");
    legacyAuxImport = false;
  }
}

export async function revealWorkStateWindow(label = getCurrentTauriWindowLabel() ?? "main"): Promise<void> {
  if (!hasTauriWindowRuntime()) return;
  ensureWorkWindow(label);
  dirty.add(label);
  await flushWorkState();
  await invoke("show_work_state_window", { label });
}
