import { ipcInvoke } from "./ipc";
import type { WorkspaceRef } from "./project";
import type { EffortLevel } from "../types";

export interface AgentSelectionMemory {
  modelId: string;
  effort: string;
}

/** The user's last explicit choice in one project (shared by its worktrees). */
export interface WorkspaceSelectionMemory {
  agentId: string;
  modelId: string;
  effort: string;
  fastMode?: boolean | null;
  /** The model each Agent last used in this project. */
  agents: Record<string, AgentSelectionMemory>;
  updatedAtMs: number;
}

export interface WorkspaceSelectionSnapshot {
  projectId: string;
  memory: WorkspaceSelectionMemory;
  /** Most recent explicit Agent choice in any project. */
  lastAgentId: string;
  /** Explicit default from the workspace's `Locus/config.json`. */
  workspaceDefaultAgentId: string | null;
}

export interface WorkspaceSelectionPatch {
  agentId?: string;
  modelId?: string;
  effort?: EffortLevel;
  fastMode?: boolean;
}

export function getWorkspaceSelection(workspaceRef: WorkspaceRef): Promise<WorkspaceSelectionSnapshot> {
  return ipcInvoke<WorkspaceSelectionSnapshot>("get_workspace_selection", { workspaceRef });
}

export function saveWorkspaceSelection(
  workspaceRef: WorkspaceRef,
  selection: WorkspaceSelectionPatch,
): Promise<WorkspaceSelectionSnapshot> {
  return ipcInvoke<WorkspaceSelectionSnapshot>("save_workspace_selection", { workspaceRef, selection });
}
