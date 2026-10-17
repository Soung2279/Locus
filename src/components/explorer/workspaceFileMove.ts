import type { WorkspaceRef } from "../../services/project";
import type { WorkbenchReferenceDragData } from "../workbench/workbenchReferenceDrag";

export interface WorkspaceFileDropScope {
  projectId: string;
  workspaceRef: WorkspaceRef;
  root: string;
  directory: string;
}

export function workspaceRelativeEntryPath(root: string, value: string): string | null {
  let path = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const fold = (text: string) => /^[a-z]:\//i.test(normalizedRoot) ? text.toLowerCase() : text;
  if (fold(path) === fold(normalizedRoot)) path = "";
  else if (fold(path).startsWith(`${fold(normalizedRoot)}/`)) path = path.slice(normalizedRoot.length + 1);
  if (/^(?:\/|[a-z]:)/i.test(path)) return null;
  const parts = path.split("/").filter(part => part && part !== ".");
  if (parts.includes("..") || path.includes("\0")) return null;
  return parts.join("/");
}

export function workspaceFileParent(path: string): string {
  return path.replace(/\\/g, "/").split("/").slice(0, -1).join("/") || ".";
}

export function workspaceMovedPath(path: string, source: string, target: string, isDirectory: boolean): string | null {
  const normalized = path.replace(/\\/g, "/");
  const from = source.replace(/\\/g, "/").replace(/\/+$/, "");
  const to = target.replace(/\\/g, "/").replace(/\/+$/, "");
  const fold = (value: string) => /^[a-z]:\//i.test(from) ? value.toLowerCase() : value;
  if (fold(normalized) === fold(from)) return to;
  return isDirectory && fold(normalized).startsWith(`${fold(from)}/`) ? to + normalized.slice(from.length) : null;
}

export function resolveWorkspaceFileMove(data: WorkbenchReferenceDragData, target: WorkspaceFileDropScope) {
  if (!data.fileSystemMove || data.entries.length !== 1 || data.origin.projectId !== target.projectId) return null;
  const from = data.origin.workspaceRef;
  const to = target.workspaceRef;
  if (from.checkoutId !== to.checkoutId || from.expectedGeneration !== to.expectedGeneration
    || from.expectedMaterializationEpoch !== to.expectedMaterializationEpoch) return null;
  const entry = data.entries[0];
  if (entry?.kind !== "file") return null;
  const sourcePath = workspaceRelativeEntryPath(data.origin.workspaceRoot, entry.path);
  const directory = workspaceRelativeEntryPath(target.root, target.directory);
  if (!sourcePath || directory === null) return null;
  const fold = (path: string) => /^[a-z]:[/\\]/i.test(target.root) ? path.toLowerCase() : path;
  if (fold(workspaceFileParent(sourcePath)) === fold(directory || ".")) return null;
  if (entry.isDir && (fold(directory) === fold(sourcePath) || fold(directory).startsWith(`${fold(sourcePath)}/`))) return null;
  return { sourcePath, targetDirectory: directory || ".", workspaceRef: { ...to } };
}
