import { onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { hasTauriWindowRuntime } from "../services/tauriRuntime";
import { readDocumentRecovery, writeDocumentRecovery, type DocumentSnapshot } from "../services/documentRecovery";

/** Persist outside the workspace, without putting draft state into Markdown files. */
export function useDocumentRecovery(options: {
  key: () => string;
  base: () => string;
  text: () => string | { toString(): string };
  enabled: () => boolean;
  apply: (text: string) => void;
}) {
  const pending = shallowRef<DocumentSnapshot | null>(null);
  const snapshots = shallowRef<DocumentSnapshot[]>([]);
  const error = ref("");
  const historyOpen = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let serial = Promise.resolve();
  let activeKey = "";
  let loaded = false;
  let disposed = false;
  let activeBase = "";
  let latestText: string | { toString(): string } = "";
  function enqueue(key: string, base: string, text: string, saved: boolean) {
    serial = serial.then(async () => {
      await writeDocumentRecovery(key, base, text, saved);
      if (!disposed && activeKey === key) error.value = "";
    }).catch(reason => { if (!disposed && activeKey === key) error.value = `草稿备份失败：${String(reason)}`; });
  }
  function flush() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!loaded || !activeKey || pending.value) return;
    enqueue(activeKey, activeBase, latestText.toString(), false);
  }
  function changed() {
    latestText = options.text();
    if (!loaded || !activeKey || pending.value) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, 300);
  }
  watch(() => [options.key(), options.enabled()] as const, async ([key, enabled]) => {
    flush();
    activeKey = enabled && hasTauriWindowRuntime() ? key : "";
    loaded = false; pending.value = null; snapshots.value = []; historyOpen.value = false;
    activeBase = options.base(); latestText = options.text();
    if (!activeKey) return;
    const identity = activeKey;
    try {
      await serial;
      const record = await readDocumentRecovery(identity);
      if (disposed || activeKey !== identity) return;
      snapshots.value = record.snapshots;
      if (record.draft && record.draft.text !== options.base() && record.draft.text !== options.text().toString()) pending.value = record.draft;
      loaded = true;
      if (!pending.value) { enqueue(identity, options.base(), options.base(), true); changed(); }
    } catch (reason) { if (activeKey === identity) error.value = `无法读取草稿：${String(reason)}`; }
  }, { immediate: true });
  watch(options.base, (base) => {
    activeBase = base;
    if (loaded && activeKey && !pending.value) { enqueue(activeKey, base, base, true); changed(); }
  });
  function restore(snapshot: DocumentSnapshot) {
    // Keep the current contents available before a deliberate restoration.
    if (activeKey) enqueue(activeKey, options.base(), options.text().toString(), true);
    pending.value = null; historyOpen.value = false;
    options.apply(snapshot.text); changed();
  }
  function dismiss() { pending.value = null; flush(); }
  async function openHistory() {
    if (!activeKey) return;
    const key = activeKey;
    try { await serial; const record = await readDocumentRecovery(key, true); if (activeKey === key && !disposed) { snapshots.value = record.snapshots; historyOpen.value = true; } }
    catch (reason) { error.value = String(reason); }
  }
  const beforeUnload = () => flush();
  window.addEventListener("pagehide", beforeUnload);
  onBeforeUnmount(() => { flush(); disposed = true; window.removeEventListener("pagehide", beforeUnload); });
  return { pending, snapshots, error, historyOpen, changed, flush, restore, dismiss, openHistory };
}
