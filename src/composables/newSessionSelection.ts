import type { WorkspaceRef } from "../services/project";
import { useAgentStore } from "../stores/agent";
import { useModelStore } from "../stores/model";
import { useSelectionMemoryStore } from "../stores/selectionMemory";

/**
 * Applies the model/effort/fast mode a new session in the current workspace
 * starts with to the shared chat stores. The Agent is resolved separately by
 * `agentStore.resetToDefault()` or chosen by the user.
 */
export function applyNewSessionSelection(options: { agentId?: string } = {}): void {
  const agentStore = useAgentStore();
  const agentId = (options.agentId ?? agentStore.selectedAgentId).trim();
  const agent = agentStore.agents.find((item) => item.id === agentId) ?? (agentId ? { id: agentId } : null);
  const execution = useSelectionMemoryStore().resolveExecution(agentStore.workspaceCheckoutId, agent);
  useModelStore().applyNewSessionSelection(execution);
}

/** Records the shared chat stores' current selection as the user's explicit choice. */
export function rememberChatSelection(workspaceRef: WorkspaceRef | null | undefined): void {
  const agentStore = useAgentStore();
  const modelStore = useModelStore();
  useSelectionMemoryStore().remember(workspaceRef, {
    agentId: agentStore.selectedAgentId,
    modelId: modelStore.selectedModelId,
    effort: modelStore.effortSupported ? modelStore.effort : null,
    fastMode: modelStore.codexFastModeAvailable ? modelStore.codexFastMode : null,
  });
}
