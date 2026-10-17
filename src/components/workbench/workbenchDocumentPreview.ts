import type { WorkbenchEditorInput } from "../../types/workbench";
import { isWorkbenchDocumentPath } from "../../stores/workbench";

export function isDocumentPreview(editor: WorkbenchEditorInput): boolean {
  if (!editor.preview || editor.pinned || editor.availability === "unavailable") return false;
  const resource = editor.resource;
  return resource.kind === "workspaceFile"
    || resource.kind === "localFile"
    || resource.kind === "knowledge"
    || (resource.kind === "asset" && isWorkbenchDocumentPath(resource.path))
    || (resource.kind === "section" && resource.section === "agents" && !!resource.agentId);
}
