import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { useWorkspaceContextStore } from "../stores/workspaceContext";
import { bootstrapWorkspaceWindow } from "../composables/bootstrapWorkspaceWindow";
import { openWorkspaceWindow, workspaceWindowQuery, workspaceWindowRef } from "../services/workspaceWindow";
import type { WindowPaneWorkspaceContext, WorkspaceRef, WorkspaceRuntimeDescriptor } from "../services/project";

const mocks = vi.hoisted(() => ({
  ipcInvoke: vi.fn(),
  openWorkspace: vi.fn(),
  listProjectContexts: vi.fn(),
  listWindowWorkspaceContexts: vi.fn(),
  listWindowWorkspaceIntentEpochs: vi.fn(),
  focusWorkspace: vi.fn(),
  setActiveWorkspaceSession: vi.fn(),
  detachWorkspaceWindow: vi.fn(),
  savedWindowState: vi.fn(),
}));
vi.mock("../services/ipc", () => ({ ipcInvoke: mocks.ipcInvoke }));
vi.mock("../composables/useTheme", () => ({ currentThemeBackgroundColor: () => "#202020" }));
vi.mock("../services/tauriRuntime", () => ({ hasTauriWindowRuntime: () => true }));
vi.mock("../services/workState", () => ({ savedWindowState: mocks.savedWindowState }));
vi.mock("../services/project", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/project")>(),
  ...mocks,
}));

const runtimes: WorkspaceRuntimeDescriptor[] = ["a", "b", "c"].map((id) => ({
  projectId: `project-${id}`,
  checkoutId: `checkout-${id}`,
  root: `F:/work/${id}`,
  workspaceGeneration: 1,
  materializationEpoch: 1,
  leaseCount: 0,
  detectedServices: [],
}));
const initialRef: WorkspaceRef = {
  checkoutId: "checkout-b", expectedGeneration: 1, expectedMaterializationEpoch: 1,
};
let contexts: Map<string, WindowPaneWorkspaceContext>;
const paneKey = (windowId: string, paneId: string) => `${windowId}/${paneId}`;

describe("independent workspace windows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.savedWindowState.mockReturnValue(null);
    contexts = new Map();
    mocks.listProjectContexts.mockResolvedValue(runtimes.map((runtime) => ({
      projectId: runtime.projectId, detectedServices: [],
      checkouts: [{ ...runtime, normalizedRoot: runtime.root, lastOpenedAt: 1, runtime }],
    })));
    mocks.listWindowWorkspaceContexts.mockImplementation(async () => [...contexts.values()]);
    mocks.listWindowWorkspaceIntentEpochs.mockResolvedValue([]);
    mocks.openWorkspace.mockImplementation(async (path: string) => {
      const runtime = runtimes.find((runtime) => runtime.root === path);
      if (!runtime) throw new Error("Directory missing");
      return runtime;
    });
    mocks.focusWorkspace.mockImplementation(async (
      windowId: string, paneId: string, workspaceRef: WorkspaceRef, intentEpoch: number,
    ) => {
      const context: WindowPaneWorkspaceContext = {
        windowId, paneId, focusedCheckoutId: workspaceRef.checkoutId,
        workspaceGeneration: 1, materializationEpoch: 1,
        activeSessionId: null, intentEpoch, revision: intentEpoch,
      };
      contexts.set(paneKey(windowId, paneId), context);
      return context;
    });
    mocks.setActiveWorkspaceSession.mockImplementation(async (
      windowId: string, paneId: string, activeSessionId: string, intentEpoch: number,
    ) => {
      const context = { ...contexts.get(paneKey(windowId, paneId))!, activeSessionId, intentEpoch, revision: intentEpoch };
      contexts.set(paneKey(windowId, paneId), context);
      return context;
    });
    mocks.detachWorkspaceWindow.mockImplementation(async (windowId: string) => {
      let removed = 0;
      for (const [key, context] of contexts) {
        if (context.windowId === windowId) { contexts.delete(key); removed += 1; }
      }
      return removed;
    });
    mocks.ipcInvoke.mockResolvedValue("workspace-app-new");
  });

  it("opens the selected workspace without moving the source window or its session", async () => {
    const source = useWorkspaceContextStore(createPinia());
    await source.initialize("main", "main");
    await source.openAndFocus("F:/work/a");
    await source.setActiveSession("session-a");
    mocks.focusWorkspace.mockClear();

    expect(await openWorkspaceWindow("F:/work/b")).toBe("workspace-app-new");
    expect(mocks.ipcInvoke).toHaveBeenCalledWith("open_workspace_window", {
      workspaceRef: initialRef, backgroundColor: "#202020",
    });
    expect(source.focusedRoot).toBe("F:/work/a");
    expect(source.focusedPaneContext?.activeSessionId).toBe("session-a");
    expect(mocks.focusWorkspace).not.toHaveBeenCalled();
  });

  it("keeps switches, sessions and window disposal isolated across independent renderers", async () => {
    const source = useWorkspaceContextStore(createPinia());
    await source.initialize("main", "main");
    await source.openAndFocus("F:/work/a");
    await source.setActiveSession("session-a");
    const target = useWorkspaceContextStore(createPinia());
    await bootstrapWorkspaceWindow(target, "workspace-app-new", workspaceWindowQuery(initialRef));
    expect(target.focusedRoot).toBe("F:/work/b");
    expect(target.focusedPaneContext?.activeSessionId).toBeNull();
    await target.openAndFocus("F:/work/c");
    await target.setActiveSession("session-c");
    expect(source.focusedRoot).toBe("F:/work/a");
    expect(source.focusedPaneContext?.activeSessionId).toBe("session-a");
    await target.disposeWindow();
    expect(contexts.get("main/main")?.activeSessionId).toBe("session-a");
    expect([...contexts.values()].every((pane) => pane.windowId === "main")).toBe(true);
  });

  it("restores this window's latest pane on reload instead of the original URL or another window", async () => {
    const target = useWorkspaceContextStore(createPinia());
    await bootstrapWorkspaceWindow(target, "workspace-app-new", workspaceWindowQuery(initialRef));
    await target.openAndFocusInPane("F:/work/c", "workspace-app-new", "split-pane");
    await target.setActiveSession("session-c");
    // A higher intent in a different window must not win restoration.
    contexts.set("main/main", { ...contexts.get("workspace-app-new/split-pane")!, windowId: "main", intentEpoch: 99 });
    const reloaded = useWorkspaceContextStore(createPinia());
    mocks.focusWorkspace.mockClear();
    await bootstrapWorkspaceWindow(reloaded, "workspace-app-new", workspaceWindowQuery(initialRef));
    expect(reloaded.focusedRoot).toBe("F:/work/c");
    expect(reloaded.paneId).toBe("split-pane");
    expect(reloaded.focusedPaneContext?.activeSessionId).toBe("session-c");
    expect(mocks.focusWorkspace).not.toHaveBeenCalled();
  });

  it("rejects an unavailable folder before creating a native window", async () => {
    await expect(openWorkspaceWindow("F:/missing")).rejects.toThrow("Directory missing");
    expect(mocks.ipcInvoke).not.toHaveBeenCalled();
  });

  it.each(["main", "workspace-app-restored"])("restores %s from its saved checkout when an empty pane has no backend context", async (windowId) => {
    mocks.savedWindowState.mockReturnValue({ version: 1, activeWorkspaceId: "checkout-b",
      layouts: { "checkout-b": { focusedPaneId: "empty-pane" } }, editors: {} });
    const target = useWorkspaceContextStore(createPinia());
    await bootstrapWorkspaceWindow(target, windowId, "workspaceWindow=1&restore=1");
    expect(target.focusedRoot).toBe("F:/work/b");
    expect(target.paneId).toBe("empty-pane");
    expect(contexts.get(`${windowId}/empty-pane`)?.focusedCheckoutId).toBe("checkout-b");
  });

  it("rejects stale checkout assignments instead of substituting the source workspace", async () => {
    const target = useWorkspaceContextStore(createPinia());
    await expect(bootstrapWorkspaceWindow(target, "workspace-app-new", workspaceWindowQuery({
      ...initialRef, expectedMaterializationEpoch: 2,
    }))).rejects.toThrow("stale");
    expect(target.focusedRoot).toBe("");
    expect(mocks.focusWorkspace).not.toHaveBeenCalled();
  });

  it("round trips scoped URLs and rejects malformed workspace identities", () => {
    const ref = { ...initialRef, checkoutId: "checkout/中文 & special" };
    expect(workspaceWindowRef(workspaceWindowQuery(ref))).toEqual(ref);
    for (const search of ["", "workspaceWindow=1", "workspaceWindow=1&checkoutId=a&workspaceGeneration=-1",
      "workspaceWindow=1&checkoutId=a&workspaceGeneration=1&materializationEpoch=bad"]) {
      expect(() => workspaceWindowRef(search)).toThrow();
    }
  });
});
