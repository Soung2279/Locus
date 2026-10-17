import type { useWorkspaceContextStore } from "../stores/workspaceContext";
import { workspaceWindowRef } from "../services/workspaceWindow";
import { savedWindowState } from "../services/workState";

type WorkspaceStore = ReturnType<typeof useWorkspaceContextStore>;

/** Each full application WebView owns its own Pinia and native window label. */
export async function bootstrapWorkspaceWindow(
  workspace: WorkspaceStore,
  windowId: string,
  search: string,
): Promise<void> {
  await workspace.ensureInitialized(windowId, "main");
  const saved = savedWindowState(windowId);
  const focusedPane = saved?.layouts[saved.activeWorkspaceId ?? ""]?.focusedPaneId;
  // A reload must retain a workspace selected in this window, even when the
  // focused split pane is no longer named "main". Never adopt another window.
  const restored = Object.values(workspace.paneContexts)
    .filter((context) => context.windowId === windowId)
    .filter((context) => !saved?.activeWorkspaceId || context.focusedCheckoutId === saved.activeWorkspaceId)
    .sort((left, right) => {
      return Number(right.paneId === focusedPane) - Number(left.paneId === focusedPane)
        || right.intentEpoch - left.intentEpoch;
    })[0];
  if (restored) {
    workspace.activatePane(windowId, restored.paneId);
    return;
  }
  // An empty editor group has no backend pane lease. The durable window still
  // remembers its checkout, which can be opened lazily from the project catalog.
  if (saved?.activeWorkspaceId && workspace.checkoutsById[saved.activeWorkspaceId]?.available !== false
    && workspace.checkoutsById[saved.activeWorkspaceId]) {
    const context = await workspace.focusCheckoutInPane(saved.activeWorkspaceId, windowId, focusedPane ?? "main");
    if (context) return;
  }
  if (windowId === "main") return;
  // Keep a missing workspace's window and saved layout available for recovery.
  const params = new URLSearchParams(search);
  if (params.get("restore") === "1" && !params.has("checkoutId")) return;
  const context = await workspace.focusWorkspaceRefInPane(
    workspaceWindowRef(search), windowId, "main",
  );
  if (!context) throw new Error("The workspace window could not bind its workspace.");
}
