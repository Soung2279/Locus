<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { confirm } from "@tauri-apps/plugin-dialog";
import { RotateCcw, RefreshCw } from "lucide";
import { t } from "../../i18n";
import { fileHistory, fileHistoryPreview, fileHistoryRestore, type FileHistory, type FileHistoryPreview as Preview, type FileHistoryTarget } from "../../services/fileHistory";
import { normalizeAppError } from "../../services/errors";
import { useNotificationStore } from "../../stores/notification";
import BaseButton from "../ui/BaseButton.vue";
import LucideIcon from "../icons/LucideIcon.vue";
import FileHistoryPreview from "./FileHistoryPreview.vue";

const props = defineProps<{
  target: FileHistoryTarget;
  sidebarTarget?: HTMLElement | null;
  sidebarToolbarTarget?: HTMLElement | null;
  activateEditor?: () => Promise<void>;
}>();
const emit = defineEmits<{ restored: [] }>();
// Capture the checkout with the request, including its generation. Changing
// the active workspace while this editor is open must not retarget a restore.
const target = { ...props.target, workspaceRef: props.target.workspaceRef ? { ...props.target.workspaceRef } : null };
const notification = useNotificationStore();
const history = ref<FileHistory | null>(null);
const selected = ref<string | null>(null);
const preview = ref<Preview | null>(null);
const loading = ref(false);
const previewLoading = ref(false);
const restoring = ref(false);
const error = ref("");
const previewError = ref("");
let request = 0;
let selectionIntent = 0;
let alive = true;
const name = target.path.replace(/\\/g, "/").split("/").pop() ?? target.path;
const version = computed(() => history.value?.versions.find(item => item.commit === selected.value));
const canRestore = computed(() => !!version.value && !!preview.value && !loading.value && !previewLoading.value && !restoring.value
  && preview.value.contentHash !== history.value?.currentHash);
function date(value: string, nanos = false): string {
  const timestamp = nanos ? Number(value) / 1_000_000 : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString() : "";
}
async function select(commit: string | null) {
  if (restoring.value) return;
  const id = ++request;
  selected.value = commit;
  preview.value = null;
  previewError.value = "";
  previewLoading.value = true;
  try {
    const result = await fileHistoryPreview(target, commit);
    if (!alive || id !== request) return;
    preview.value = result;
    if (commit === null && history.value) history.value.currentHash = result.contentHash;
  } catch (cause) {
    if (alive && id === request) previewError.value = normalizeAppError(cause).message;
  } finally { if (alive && id === request) previewLoading.value = false; }
}
async function selectFromSidebar(commit: string | null) {
  if (restoring.value || loading.value) return;
  const intent = ++selectionIntent;
  try {
    await props.activateEditor?.();
    if (alive && intent === selectionIntent) await select(commit);
  } catch (cause) { if (alive && intent === selectionIntent) error.value = normalizeAppError(cause).message; }
}
async function refresh() {
  if (loading.value || restoring.value) return;
  ++selectionIntent;
  ++request;
  loading.value = true;
  preview.value = null;
  error.value = "";
  previewError.value = "";
  try {
    const result = await fileHistory(target);
    if (!alive) return;
    history.value = result;
    await select(null);
  } catch (cause) { if (alive) error.value = normalizeAppError(cause).message; }
  finally { if (alive) loading.value = false; }
}
async function restore() {
  if (!canRestore.value || !version.value || !history.value) return;
  const commit = version.value.commit;
  const hash = history.value.currentHash;
  restoring.value = true;
  error.value = "";
  let restored = false;
  try {
    const approved = await confirm(t("fileHistory.restoreConfirm", name, commit.slice(0, 8)), {
      title: t("fileHistory.restore"), kind: "warning", okLabel: t("fileHistory.restore"), cancelLabel: t("common.cancel"),
    });
    if (!approved || !alive) return;
    await fileHistoryRestore(target, commit, hash);
    if (!alive) return;
    restored = true;
    notification.addNotice("success", t("fileHistory.restored"));
    emit("restored");
  } catch (cause) { if (alive) error.value = normalizeAppError(cause).message; }
  finally { restoring.value = false; }
  if (restored) await refresh();
}
onMounted(() => { void refresh(); });
onBeforeUnmount(() => { alive = false; ++request; ++selectionIntent; });
</script>

<template>
  <section class="file-history-panel" :aria-label="`${name} · ${t('fileHistory.title')}`">
    <Teleport v-if="sidebarTarget" :to="sidebarTarget">
      <nav class="history-list" :aria-label="`${name} · ${t('fileHistory.title')}`" :aria-busy="loading">
        <button v-if="history" type="button" class="history-version" :class="{ selected: selected === null }"
          :aria-current="selected === null ? 'true' : undefined" :disabled="restoring || loading" @click="selectFromSidebar(null)">
          <span class="history-subject">{{ t('fileHistory.current') }}</span>
          <time>{{ date(history.currentModifiedAt, true) }}</time>
        </button>
        <button v-for="item in history?.versions ?? []" :key="item.commit" type="button" class="history-version"
          :class="{ selected: selected === item.commit }" :aria-current="selected === item.commit ? 'true' : undefined"
          :disabled="restoring || loading" @click="selectFromSidebar(item.commit)">
          <span class="history-subject" :title="item.subject">{{ item.subject }}</span>
          <span class="history-author" :title="item.email">{{ item.author }}</span>
          <span class="history-meta"><time :datetime="item.modifiedAt">{{ date(item.modifiedAt) }}</time><code :title="item.commit">{{ item.commit.slice(0, 8) }}</code></span>
        </button>
        <p v-if="loading && !history" class="history-state">{{ t('common.loading') }}</p>
        <p v-else-if="history && !history.versions.length" class="history-state">{{ t(history.isRepository ? 'fileHistory.empty' : 'fileHistory.noRepository') }}</p>
      </nav>
    </Teleport>
    <p v-if="error" class="history-error" role="alert">{{ error }}</p>
    <section class="history-content" :aria-busy="previewLoading">
      <div class="history-toolbar">
        <span :title="version?.path">{{ version ? version.commit.slice(0, 8) : t('fileHistory.current') }}</span>
        <Teleport :to="sidebarToolbarTarget ?? 'body'" :disabled="!sidebarToolbarTarget">
          <BaseButton class="history-icon secondary-sidebar-tool" :disabled="loading || restoring" :title="t('common.refresh')" :aria-label="t('common.refresh')" @click="refresh"><LucideIcon :icon="RefreshCw" :size="14" /></BaseButton>
        </Teleport>
        <BaseButton :disabled="!canRestore" @click="restore"><LucideIcon :icon="RotateCcw" :size="13" />{{ t(restoring ? 'common.loading' : 'fileHistory.restore') }}</BaseButton>
      </div>
      <p v-if="previewLoading" class="history-state">{{ t('common.loading') }}</p>
      <p v-else-if="previewError" class="history-error" role="alert">{{ previewError }}</p>
      <FileHistoryPreview v-else-if="preview" :key="selected ?? 'current'" :preview="preview" :workspace-ref="target.workspaceRef" />
    </section>
  </section>
</template>

<style scoped>
.file-history-panel { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; background: var(--panel-bg); color: var(--text-color); overflow: hidden; }
.history-icon { width: 28px; padding: 0; border-color: transparent; }
.history-list { flex: 1; min-width: 0; min-height: 0; overflow: auto; background: var(--sidebar-bg); }
.history-version { display: flex; flex-direction: column; gap: 6px; width: 100%; padding: 12px 14px; border: 0; border-bottom: 1px solid var(--border-color); background: transparent; color: var(--text-secondary); font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
.history-version:hover { background: var(--hover-bg); }
.history-version.selected { background: var(--accent-soft); color: var(--text-color); }
.history-version:focus-visible { outline: 1px solid var(--accent-color); outline-offset: -2px; }
.history-subject { font-size: 12px; color: var(--text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-author { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; justify-content: space-between; }
code { font-family: var(--font-mono-identifier); font-size: 11px; }
.history-content { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.history-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 42px; padding: 0 12px; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 12px; }
.history-toolbar > span { flex: 1; }
.history-state { padding: 18px 14px; font-size: 12px; color: var(--text-secondary); }
.history-error { margin: 0; padding: 10px 14px; font-size: 12px; color: var(--status-danger-fg); overflow-wrap: anywhere; }
</style>
