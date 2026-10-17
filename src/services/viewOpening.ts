import { getCurrentWindow } from "@tauri-apps/api/window";
import { useDisplaySettings, type ViewOpenTarget } from "../composables/useDisplaySettings";
import { t } from "../i18n";
import { workspaceMaterializationMatches, type WorkspaceRef } from "./project";
import { checkViewOpenRequirements, viewRead, viewRun } from "./view";
import { isWorkspaceWindowLabel } from "./workspaceWindow";
import type { WorkbenchEditorTransferRecord } from "../types/workbench";
import type { WorkbenchWindowScreenPoint, WorkbenchWindowTransferAckPayload } from "./workbenchWindow";

async function openStandaloneViewWindow(
  record: WorkbenchEditorTransferRecord,
  point: WorkbenchWindowScreenPoint,
  windows: typeof import("./workbenchWindow"),
): Promise<void> {
  let acknowledge!: (payload: WorkbenchWindowTransferAckPayload | null) => void;
  const acknowledgement = new Promise<WorkbenchWindowTransferAckPayload | null>(resolve => { acknowledge = resolve; });
  const unlisten = await getCurrentWindow().listen<WorkbenchWindowTransferAckPayload>(
    windows.WORKBENCH_WINDOW_TRANSFER_ACK_EVENT,
    event => { if (event.payload.token === record.token) acknowledge(event.payload); },
  );
  const timer = setTimeout(() => acknowledge(null), windows.WORKBENCH_TRANSFER_TIMEOUT_MS);
  let createdLabel: string | undefined;
  try {
    await windows.persistWorkbenchTransferRecord(record);
    createdLabel = (await windows.createDetachedWorkbenchWindow(record.token, point, record.dragStartedAt)).label;
    const result = await acknowledgement;
    if (!result || result.error || !result.editorId || !result.paneId || result.targetWindowId !== createdLabel) {
      throw new Error(result?.error || t("workbench.window.targetUnavailable"));
    }
  } catch (error) {
    if (createdLabel) {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const created = await WebviewWindow.getByLabel(createdLabel).catch(() => null);
      await created?.close().catch(() => undefined);
      windows.unregisterWorkbenchAuxWindow(createdLabel);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    unlisten();
    await windows.removeWorkbenchTransferRecord(record.token);
  }
}

export function viewOpenPreferenceKey(workspaceRef: WorkspaceRef, viewId: string): string {
  return JSON.stringify([workspaceRef.checkoutId, viewId]);
}

export function setViewOpenOverride(workspaceRef: WorkspaceRef, viewId: string, target: ViewOpenTarget | "default"): void {
  const { state, set } = useDisplaySettings();
  const overrides = { ...state.viewOpenOverrides };
  const key = viewOpenPreferenceKey(workspaceRef, viewId);
  if (target === "default") delete overrides[key];
  else overrides[key] = target;
  set("viewOpenOverrides", overrides);
}

/** User-initiated opens follow the preference; SDK viewRun keeps an explicit tab target. */
export async function openViewPackage(
  workspaceRef: WorkspaceRef,
  viewId: string,
  windowLabel?: string,
): Promise<void> {
  const { state } = useDisplaySettings();
  const target = state.viewOpenOverrides[viewOpenPreferenceKey(workspaceRef, viewId)] ?? state.viewOpenTarget;
  if (target !== "window") {
    await viewRun(workspaceRef, viewId, windowLabel);
    return;
  }

  const scope = { ...workspaceRef };
  const detail = await viewRead(scope, viewId);
  const requirementError = await checkViewOpenRequirements(scope, detail.manifest);
  if (requirementError) throw requirementError;

  const [windows, sharedWindows, sharedTransfers, editors, contexts] = await Promise.all([
    import("./workbenchWindow"),
    import("./sharedWorkbenchWindow"),
    import("./sharedWorkbenchTransfer"),
    import("../stores/workbench"),
    import("../stores/workspaceContext"),
  ]);
  const checkout = contexts.useWorkspaceContextStore().checkoutsById[scope.checkoutId];
  if (!checkout?.runtime
    || checkout.runtime.workspaceGeneration !== scope.expectedGeneration
    || !workspaceMaterializationMatches(scope.expectedMaterializationEpoch, checkout.runtime.materializationEpoch)) {
    throw new Error(t("workbench.unavailable.checkout"));
  }
  const editor = editors.createWorkbenchEditorInput({
    kind: "view", projectId: checkout.projectId, viewId: detail.summary.id,
  }, detail.summary.name, {
    preview: false,
    pinned: true,
    capabilities: { split: false, detach: true, duplicate: false },
    checkoutBinding: scope,
  });
  const runtimeLabel = getCurrentWindow().label;
  const sourceLabel = windowLabel ?? runtimeLabel;
  const record = windows.createInMemoryWorkbenchTransferRecord({
    sourceWindowId: sourceLabel,
    sourcePaneId: editors.useWorkbenchStore().windows[sourceLabel]?.focusedPaneId ?? "main",
    sourceEditorId: editor.editorId,
    editor,
    snapshot: { kind: "resource" },
    dragStartedAt: Date.now(),
  });
  const point = await windows.currentWorkbenchCursorPosition();
  // Standalone preview/editor pages have no App renderer for shared popups.
  // Their new View windows use the existing persisted transfer protocol.
  if (runtimeLabel !== "main" && !isWorkspaceWindowLabel(runtimeLabel)) {
    await openStandaloneViewWindow(record, point, windows);
    return;
  }
  const created = await sharedWindows.createSharedDetachedWorkbenchWindow(record.token, point, record.dragStartedAt);
  try {
    const acknowledgement = await sharedTransfers.dispatchSharedWorkbenchTransfer(created.label, record, null);
    if (!acknowledgement || acknowledgement.error || !acknowledgement.editorId || !acknowledgement.paneId) {
      throw new Error(acknowledgement?.error || t("workbench.window.targetUnavailable"));
    }
  } catch (error) {
    await sharedTransfers.cancelSharedWorkbenchTransfer(created.label, record.token).catch(() => undefined);
    await sharedWindows.removeSharedWorkbenchWindowHost(created.label).catch(() => undefined);
    throw error;
  }
}
