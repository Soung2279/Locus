import { ipcInvoke } from "./ipc";
import type { WorkspaceRef } from "./project";

export async function startWorkspaceFileWatch(workspaceRef: WorkspaceRef): Promise<() => Promise<void>> {
  const token = await ipcInvoke<string | null>("workspace_file_watch_start", { workspaceRef });
  let released = false;
  return async () => {
    if (released || !token) return;
    released = true;
    await ipcInvoke("workspace_file_watch_stop", { token });
  };
}
