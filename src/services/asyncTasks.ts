import type { AsyncTaskStatus } from "../types";
import { ipcInvoke } from "./ipc";
import { getLocusRuntime } from "./locusRuntime";

export interface BackgroundTaskInfo {
  taskId: string;
  sessionId: string;
  localId: string;
  toolName: string;
  description: string | null;
  status: AsyncTaskStatus;
  progress: string | null;
  createdAt: number;
  startedAt: number | null;
}

export function listBackgroundTasks(sessionId: string): Promise<BackgroundTaskInfo[]> {
  return ipcInvoke("list_background_tasks", { sessionId });
}

export function cancelBackgroundTask(sessionId: string, taskId: string): Promise<BackgroundTaskInfo> {
  return ipcInvoke("cancel_background_task", { sessionId, taskId });
}

export function subscribeAsyncTasksEnabled(handler: (enabled: boolean) => void) {
  return getLocusRuntime().subscribe<boolean>("async-tasks-enabled-changed", handler);
}
