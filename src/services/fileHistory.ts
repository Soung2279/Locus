import { ipcInvoke } from "./ipc";
import type { WorkspaceRef } from "./project";
import type { AssetPreviewPayload } from "../types";
import type { ProjectExplorerFilePreview } from "../types/workbench";

export interface FileHistoryTarget { projectId: string; path: string; workspaceRef: WorkspaceRef | null }
export interface FileHistoryVersion {
  commit: string;
  author: string;
  email: string;
  modifiedAt: string;
  subject: string;
  path: string;
  blob: string;
}
export interface FileHistory {
  versions: FileHistoryVersion[];
  currentModifiedAt: string;
  currentHash: string;
  isRepository: boolean;
}
export interface FileHistoryPreview {
  file: ProjectExplorerFilePreview;
  asset: AssetPreviewPayload | null;
  contentHash: string;
  csvView: string | null;
}
export function fileHistory(target: FileHistoryTarget): Promise<FileHistory> {
  return ipcInvoke("file_history", { ...target });
}
export function fileHistoryPreview(target: FileHistoryTarget, commit: string | null): Promise<FileHistoryPreview> {
  return ipcInvoke("file_history_preview", { ...target, commit });
}
export function fileHistoryRestore(target: FileHistoryTarget, commit: string, expectedContentHash: string): Promise<void> {
  return ipcInvoke("file_history_restore", { ...target, commit, expectedContentHash });
}
