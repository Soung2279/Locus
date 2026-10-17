import { shallowRef } from "vue";

export type WorkspaceNavigationMode = "sessions" | "files";
const STORAGE_KEY = "locus:workspaceNavigationModes";

function readModes(): Record<string, WorkspaceNavigationMode> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, mode]) => mode === "files" || mode === "sessions"));
  } catch { return {}; }
}

const modes = shallowRef(readModes());
if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {
    if (event.key === null || event.key === STORAGE_KEY) modes.value = readModes();
  });
}

export function useWorkspaceNavigationMode() {
  function getMode(checkoutId: string | undefined): WorkspaceNavigationMode {
    return (checkoutId && modes.value[checkoutId]) || "sessions";
  }
  function setMode(checkoutId: string, mode: WorkspaceNavigationMode) {
    if (!checkoutId) return;
    modes.value = { ...modes.value, ...readModes(), [checkoutId]: mode };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(modes.value)); } catch { /* Keep usable in memory. */ }
  }
  return { getMode, setMode };
}
