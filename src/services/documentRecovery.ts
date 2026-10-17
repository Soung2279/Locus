import { ipcInvoke } from "./ipc";

export interface DocumentSnapshot { text: string; at: number }
export interface DocumentRecovery { schemaVersion: 1; base: string; draft: DocumentSnapshot | null; snapshots: DocumentSnapshot[] }
export function readDocumentRecovery(key: string, includeHistory = false): Promise<DocumentRecovery> {
  return ipcInvoke("markdown_recovery_read", { key, includeHistory });
}
export function writeDocumentRecovery(key: string, base: string, text: string, saved: boolean): Promise<void> {
  return ipcInvoke("markdown_recovery_write", { key, base, text, saved });
}
