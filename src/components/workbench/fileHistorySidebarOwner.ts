import type { WorkbenchEditorGroup, WorkbenchEditorInput } from "../../types/workbench";

/** Bind the history list to its editor, including after moving the tab. */
export function findFileHistorySidebarOwner(
  groups: Record<string, WorkbenchEditorGroup>,
  target: { editorId?: string; checkoutId: string },
): { paneId: string; editor: WorkbenchEditorInput } | null {
  for (const group of Object.values(groups)) {
    const editor = group.tabs.find(candidate => candidate.editorId === target.editorId);
    if (editor?.resource.kind === "fileHistory" && editor.availability !== "unavailable"
      && editor.checkoutBinding?.checkoutId === target.checkoutId) return { paneId: group.paneId, editor };
  }
  return null;
}
