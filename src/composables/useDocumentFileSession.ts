import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { useDocumentAutosave } from "./useDocumentAutosave";

export interface DocumentFileSessionOptions<TDocument, TDraft> {
  /** Resource identity, including the workspace lifetime; relocate can rebind it. */
  key: () => string;
  emptyDraft: () => TDraft;
  read: () => Promise<TDocument>;
  write: (document: TDocument, draft: TDraft) => Promise<TDocument>;
  toDraft: (document: TDocument) => TDraft;
  equals: (left: TDraft, right: TDraft) => boolean;
  canSave: (document: TDocument) => boolean;
  errorMessage: (error: unknown) => string;
  autoSave?: () => boolean;
  /** Return null to leave conflicting drafts untouched. */
  mergeDrafts?: (base: TDraft, local: TDraft, remote: TDraft) => TDraft | null;
}

/**
 * File/document lifecycle independent of CodeMirror, CSV, IPC and UI controls.
 * Drafts and read/write snapshots must be immutable; format adapters own codecs,
 * newline policy, revision checks and any explicit conflict resolution.
 */
export function useDocumentFileSession<TDocument, TDraft>(
  options: DocumentFileSessionOptions<TDocument, TDraft>,
) {
  const document = shallowRef<TDocument | null>(null);
  const draft = shallowRef<TDraft>(options.emptyDraft());
  const baseDraft = shallowRef<TDraft>(draft.value);
  // Feed the renderer only at synchronization boundaries, not on every keystroke.
  const modelDraft = shallowRef<TDraft>(draft.value);
  const loading = ref(false);
  const saving = ref(false);
  const relocating = ref(false);
  const error = ref("");
  const dirty = computed(() => document.value !== null
    && !options.equals(draft.value, baseDraft.value));
  let epoch = 0;
  let draftRevision = 0;
  let documentKey = "";
  let disposed = false;
  let activeSave: Promise<boolean> | null = null;
  const autosave = useDocumentAutosave({
    canSave: () => !!options.autoSave?.() && dirty.value && !loading.value && !saving.value && !relocating.value
      && !error.value && document.value !== null && options.canSave(document.value),
    save,
    onError: (cause) => { error.value = options.errorMessage(cause); },
  });
  watch([draft, saving, loading, () => options.autoSave?.()], () => autosave.schedule());

  function updateDraft(value: TDraft): void {
    draft.value = value;
    draftRevision += 1;
  }

  function isCurrent(requestEpoch: number, key: string): boolean {
    return !disposed && epoch === requestEpoch && options.key() === key;
  }

  async function load(settings: {
    keepCurrent?: boolean;
    /** Explicitly accept a new disk baseline while retaining the local draft. */
    keepDraft?: boolean;
    mergeDraft?: boolean;
    /** Adapter-specific protection for uncommitted input or companion drafts. */
    canApply?: () => boolean;
  } = {}): Promise<boolean> {
    if (disposed) return false;
    const requestEpoch = ++epoch;
    const key = options.key();
    const keepCurrent = !!settings.keepCurrent && documentKey === key;
    loading.value = true;
    saving.value = false;
    error.value = "";
    if (!keepCurrent) {
      document.value = null;
      updateDraft(options.emptyDraft());
      baseDraft.value = draft.value;
      modelDraft.value = draft.value;
      documentKey = key;
    }
    const revision = draftRevision;
    try {
      const next = await options.read();
      if (!isCurrent(requestEpoch, key)) return false;
      if (settings.canApply && !settings.canApply()) return false;
      if (keepCurrent && settings.keepDraft && !options.canSave(next)) return false;
      // Typing during a background reload must not silently accept a newer disk
      // baseline. The caller can now present its ordinary conflict choices.
      if (keepCurrent && revision !== draftRevision && !settings.keepDraft) return false;
      const nextDraft = options.toDraft(next);
      if (keepCurrent && settings.mergeDraft && dirty.value && options.mergeDrafts) {
        const merged = options.mergeDrafts(baseDraft.value, draft.value, nextDraft);
        if (merged === null) return false;
        updateDraft(merged);
      } else if (!keepCurrent || !settings.keepDraft) updateDraft(nextDraft);
      document.value = next;
      baseDraft.value = nextDraft;
      modelDraft.value = draft.value;
      return true;
    } catch (cause) {
      if (isCurrent(requestEpoch, key)) error.value = options.errorMessage(cause);
      return false;
    } finally {
      if (isCurrent(requestEpoch, key)) loading.value = false;
    }
  }

  /** True only if the current draft is saved; continued typing remains dirty. */
  function save(): Promise<boolean> {
    if (activeSave || relocating.value) return Promise.resolve(false);
    const request = saveDraft();
    activeSave = request;
    void request.finally(() => { if (activeSave === request) activeSave = null; });
    return request;
  }

  async function saveDraft(): Promise<boolean> {
    autosave.cancel();
    const current = document.value;
    const key = options.key();
    if (disposed || current === null || documentKey !== key || loading.value || saving.value
      || !options.canSave(current)) return false;
    if (!dirty.value) return true;
    const requestEpoch = epoch;
    const revision = draftRevision;
    const submitted = draft.value;
    saving.value = true;
    error.value = "";
    try {
      const next = await options.write(current, submitted);
      if (!isCurrent(requestEpoch, key)) return false;
      const nextDraft = options.toDraft(next);
      document.value = next;
      baseDraft.value = nextDraft;
      if (revision === draftRevision) updateDraft(nextDraft);
      modelDraft.value = draft.value;
      return !dirty.value;
    } catch (cause) {
      if (isCurrent(requestEpoch, key)) error.value = options.errorMessage(cause);
      return false;
    } finally {
      if (isCurrent(requestEpoch, key)) saving.value = false;
    }
  }

  /** Move the same file without reloading its draft or resetting editor history.
   * The adapter updates its resource key inside move, before returning metadata.
   * Foreground navigation can still call load to invalidate this operation.
   */
  async function relocate(move: (current: TDocument) => Promise<TDocument>): Promise<boolean> {
    if (disposed || relocating.value || document.value === null || documentKey !== options.key()) return false;
    relocating.value = true;
    autosave.cancel();
    error.value = "";
    let requestEpoch = epoch;
    const key = options.key();
    try {
      // A write already sent to the old path must finish before moving the file.
      await activeSave;
      if (!isCurrent(requestEpoch, key) || error.value) return false;
      requestEpoch = ++epoch;
      loading.value = false;
      const next = await move(document.value!);
      if (disposed || epoch !== requestEpoch) return false;
      documentKey = options.key();
      document.value = next;
      error.value = "";
      return true;
    } finally {
      relocating.value = false;
      autosave.schedule();
    }
  }

  onScopeDispose(() => { disposed = true; epoch += 1; });

  return { document, baseDraft, draft, modelDraft, loading, saving, relocating, error, dirty, updateDraft, load, save, relocate };
}
