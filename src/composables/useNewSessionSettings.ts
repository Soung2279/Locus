import { reactive, readonly } from "vue";
import type { AgentInfo } from "../types";
import type { NewSessionAgentMode } from "../stores/newSessionSelection";

const STORAGE_KEY = "locus-new-session-settings";

interface NewSessionSettings {
  agentMode: NewSessionAgentMode;
  /** The Agent used by "fixed" mode. */
  defaultAgentId: string;
  /** A pre-migration global default; seeds projects without remembered choices. */
  legacyAgentId: string;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSettings(value: unknown): NewSessionSettings {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const defaultAgentId = trimmedString(record.defaultAgentId);
  const mode = record.agentMode;
  if (mode === "remember" || mode === "workspace" || mode === "fixed") {
    return {
      agentMode: mode === "fixed" && !defaultAgentId ? "remember" : mode,
      defaultAgentId,
      legacyAgentId: trimmedString(record.legacyAgentId),
    };
  }
  // Older builds stored only an Agent id that overrode every manual switch.
  // It now seeds the remembered choice instead of pinning it.
  return { agentMode: "remember", defaultAgentId, legacyAgentId: defaultAgentId };
}

function load() {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
  } catch {
    return normalizeSettings(null);
  }
}

const state = reactive(load());

if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY || event.key === null) Object.assign(state, load());
});

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* optional persistence */ }
}

/** Plain catalog default: the preferred Agent when available, else the workspace default. */
export function resolveDefaultAgentId(
  agents: readonly Pick<AgentInfo, "id" | "isDefault">[],
  preferredId = "",
): string {
  return agents.find((agent) => agent.id === preferredId)?.id
    ?? agents.find((agent) => agent.isDefault)?.id
    ?? agents[0]?.id
    ?? "";
}

export function useNewSessionSettings() {
  return {
    state: readonly(state),
    setAgentMode(mode: NewSessionAgentMode) {
      state.agentMode = mode === "fixed" && !state.defaultAgentId ? "remember" : mode;
      persist();
    },
    /** Pins an Agent; an empty id follows the workspace default. */
    setDefaultAgentId(id: string) {
      const agentId = id.trim();
      state.defaultAgentId = agentId;
      state.agentMode = agentId ? "fixed" : "workspace";
      persist();
    },
    reset() {
      Object.assign(state, normalizeSettings(null));
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* optional persistence */ }
    },
  };
}
