import { onScopeDispose, ref } from "vue";

export const DOCUMENT_AUTOSAVE_DELAY_MS = 700;

/** Shared debounce policy; adapters retain their own revisions and conflict checks. */
export function useDocumentAutosave(options: {
  canSave: () => boolean;
  save: () => Promise<unknown>;
  onError?: (error: unknown) => void;
}) {
  const queued = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    queued.value = false;
  }
  function schedule() {
    cancel();
    if (!options.canSave()) return;
    queued.value = true;
    timer = setTimeout(() => {
      cancel();
      if (options.canSave()) void options.save().catch((error) => options.onError?.(error));
    }, DOCUMENT_AUTOSAVE_DELAY_MS);
  }
  onScopeDispose(cancel);
  return { queued, schedule, cancel };
}
