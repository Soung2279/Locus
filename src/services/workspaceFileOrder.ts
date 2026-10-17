import { ipcInvoke } from "./ipc";
import { getLocusRuntime, type RuntimeUnsubscribe } from "./locusRuntime";
import type { WorkspaceRef } from "./project";

export interface WorkspaceFilePlacement {
  directory: string;
  item: string;
  anchor: string;
  side: "before" | "after";
}

export interface WorkspaceFileOrder {
  revision: number;
  placements: WorkspaceFilePlacement[];
}

export function workspaceFileOrder(workspaceRef: WorkspaceRef): Promise<WorkspaceFileOrder> {
  return ipcInvoke("workspace_file_order", { workspaceRef });
}

export function saveWorkspaceFileOrder(workspaceRef: WorkspaceRef, expectedRevision: number,
  directory: string, placements: WorkspaceFilePlacement[]): Promise<WorkspaceFileOrder> {
  return ipcInvoke("workspace_file_order_save", { workspaceRef, expectedRevision, directory, placements });
}

export function subscribeWorkspaceFileOrder(listener: (event: { root: string }) => void): Promise<RuntimeUnsubscribe> {
  return getLocusRuntime().subscribe("workspace-file-order-changed", listener,
    { owner: "workspaceFileOrder.subscribe" });
}
