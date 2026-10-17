import { reactive, readonly } from "vue";

const STORAGE_KEY = "locus-document-editing-settings";

export function normalizeDocumentEditingSettings(value: unknown) {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { punctuationPairing: record.punctuationPairing === true };
}

function load() {
  try {
    return normalizeDocumentEditingSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
  } catch {
    return normalizeDocumentEditingSettings(null);
  }
}

const state = reactive(load());

// Document and settings windows share the same origin and storage.
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY || event.key === null) Object.assign(state, load());
});

export function useDocumentEditingSettings() {
  return {
    state: readonly(state),
    setPunctuationPairing(enabled: boolean) {
      state.punctuationPairing = enabled;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* optional persistence */ }
    },
  };
}
