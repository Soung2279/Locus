// @vitest-environment jsdom
import { createApp, h, markRaw, nextTick, Teleport } from "vue";
import { createPinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import WorkbenchWindow from "../components/WorkbenchWindow.vue";
import { createWorkbenchEditorInput, useWorkbenchStore } from "../stores/workbench";
import { registerNativeViewHost } from "../components/view/viewHostRegistry";
import type { SharedWorkbenchWindowHost } from "../services/sharedWorkbenchWindow";

vi.mock("../composables/useAppBootstrap", () => ({
  useAppBootstrap: () => ({ bootstrapCritical: vi.fn(), registerListeners: vi.fn(), cleanup: vi.fn() }),
}));
vi.mock("../stores/workspaceContext", () => ({ useWorkspaceContextStore: () => ({}) }));
vi.mock("../components/TopBannerHost.vue", () => ({ default: { render: () => null } }));
vi.mock("../components/workbench/DevelopmentWorkbench.vue", () => ({ default: { render: () => null } }));

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach((dispose) => dispose()); localStorage.clear(); });

it("refreshes only the focused View in the owning window and protects other editor drafts", async () => {
  const frame = document.createElement("iframe");
  const root = document.createElement("div");
  document.body.append(frame, root);
  cleanups.push(() => { frame.remove(); root.remove(); });
  const child = frame.contentWindow!;
  const label = "workbench-shared-refresh-test";
  const appWindow = {
    label,
    setTitle: vi.fn(async () => {}),
    onCloseRequested: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
    onResized: vi.fn(async () => () => {}),
    isMaximized: vi.fn(async () => false),
    isAlwaysOnTop: vi.fn(async () => false),
  };
  const sharedHost: SharedWorkbenchWindowHost = {
    label, browserWindow: markRaw(child), appWindow: markRaw(appWindow as unknown as WebviewWindow),
    container: markRaw(child.document.body), transferToken: "", restoring: false, pooled: true,
    openedAt: 0, claimedAt: 0, disposeDocumentSync: () => {},
  };
  const pinia = createPinia();
  const store = useWorkbenchStore(pinia);
  const app = createApp({ render: () => h(Teleport, { to: child.document.body }, h(WorkbenchWindow, { sharedHost })) });
  app.use(pinia); app.mount(root);
  cleanups.push(() => app.unmount());
  await vi.waitFor(() => expect(appWindow.isAlwaysOnTop).toHaveBeenCalled());
  await nextTick();
  const firstPane = store.ensureWindow(label).focusedPaneId;
  const first = store.openEditor(label, createWorkbenchEditorInput({ kind: "view", projectId: "project", viewId: "first" }, "First"));
  const second = createWorkbenchEditorInput({ kind: "view", projectId: "project", viewId: "second" }, "Second");
  const pane = store.splitPane(label, firstPane, "right", second)!;
  const track = (windowLabel: string, instanceId: string) => {
    const reload = vi.fn(async () => {});
    cleanups.push(registerNativeViewHost({
      windowLabel, instanceId, viewId: "view", workspaceRef: { checkoutId: "test", expectedGeneration: 1 },
      active: () => true, root: () => null, ready: async () => {}, reload, activate: async () => {}, execute: async () => null,
    }));
    return reload;
  };
  const firstReload = track(label, first.editorId);
  const secondReload = track(label, second.editorId);
  const otherWindowReload = track("main", second.editorId);
  const press = async () => {
    const event = new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true });
    child.document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  await press();
  expect(secondReload).toHaveBeenCalledExactlyOnceWith({ force: true });
  expect(firstReload).not.toHaveBeenCalled();
  expect(otherWindowReload).not.toHaveBeenCalled();
  store.focusPane(label, firstPane);
  await press();
  expect(firstReload).toHaveBeenCalledExactlyOnceWith({ force: true });
  expect(secondReload).toHaveBeenCalledOnce();

  const draft = store.openEditor(label, createWorkbenchEditorInput({ kind: "workspaceFile", projectId: "project", path: "draft.txt" }, "Draft", { dirty: true }), { paneId: pane });
  await press();
  expect(store.activeEditor(label)?.editorId).toBe(draft.editorId);
  expect(store.activeEditor(label)?.dirty).toBe(true);
  expect(firstReload).toHaveBeenCalledOnce();
  expect(secondReload).toHaveBeenCalledOnce();
  expect(otherWindowReload).not.toHaveBeenCalled();
});
