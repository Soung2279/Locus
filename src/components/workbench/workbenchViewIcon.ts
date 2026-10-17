import type { WorkbenchEditorInput } from "../../types/workbench";
import type { WorkspaceViewReference } from "../view/viewWorkspaceDrag";

export function workbenchViewIconValue(
  editor: WorkbenchEditorInput,
  loadedIcons: Record<string, string | null>,
  viewResources: Record<string, WorkspaceViewReference[]>,
): string | null | undefined {
  if (editor.resource.kind !== "view") return null;
  // Read even a missing key so Vue tracks the first async metadata arrival.
  const icon = loadedIcons[editor.editorId];
  if (icon !== undefined) return icon;
  const { projectId, viewId } = editor.resource;
  return viewResources[projectId]?.find((item) => item.view.id === viewId
    && item.workspaceRef.checkoutId === editor.checkoutBinding?.checkoutId)?.view.icon;
}
