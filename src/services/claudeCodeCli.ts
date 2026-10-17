import { computed, ref } from "vue";
import { ipcInvoke } from "./ipc";
import { getLocusRuntime } from "./locusRuntime";

/** Experimental gate for the Claude Code CLI provider, shared by all windows. */
export const CLAUDE_CODE_CLI_ENABLED_CHANGED_EVENT = "claude-code-cli-enabled-changed";

// `null` until the persisted value is read. Display treats unknown as off;
// a selected CLI model is only released once the gate is known to be off.
const state = ref<boolean | null>(null);
let stateVersion = 0;
let pendingLoad: Promise<boolean> | null = null;
let subscribed = false;

export const claudeCodeCliEnabled = computed(() => state.value === true);
export const claudeCodeCliDisabled = computed(() => state.value === false);

function applyClaudeCodeCliEnabled(value: boolean) {
  stateVersion += 1;
  state.value = value;
}

function ensureSubscription() {
  if (subscribed) return;
  subscribed = true;
  getLocusRuntime()
    .subscribe<boolean>(CLAUDE_CODE_CLI_ENABLED_CHANGED_EVENT, (value) => {
      applyClaudeCodeCliEnabled(value === true);
    })
    .catch(() => {
      subscribed = false;
    });
}

export function loadClaudeCodeCliEnabled(): Promise<boolean> {
  ensureSubscription();
  if (!pendingLoad) {
    const version = stateVersion;
    pendingLoad = ipcInvoke<boolean>("get_claude_code_cli_enabled")
      .then((value) => {
        if (version === stateVersion) state.value = value === true;
        return state.value === true;
      })
      .finally(() => {
        pendingLoad = null;
      });
  }
  return pendingLoad;
}

export async function setClaudeCodeCliEnabled(value: boolean): Promise<void> {
  const previous = state.value;
  applyClaudeCodeCliEnabled(value);
  try {
    await ipcInvoke<void>("set_claude_code_cli_enabled", { value });
  } catch (error) {
    stateVersion += 1;
    state.value = previous;
    throw error;
  }
}
