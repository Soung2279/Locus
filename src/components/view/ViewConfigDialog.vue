<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from "vue";
import { t } from "../../i18n";
import { useWindowSurface } from "../../composables/useWindowSurface";
import { useDisplaySettings, type ViewOpenTarget } from "../../composables/useDisplaySettings";
import type { WorkspaceRef } from "../../services/project";
import { normalizeViewError, viewRead, viewUpdateMetadata, type ViewPackageSummary } from "../../services/view";
import { setViewOpenOverride, viewOpenPreferenceKey } from "../../services/viewOpening";
import { isPluginView, viewPluginAttribution } from "./viewTreeActions";
import { LOCUS_VIEW_ICON_NAMES, resolveLocusViewIcon } from "../icons/locusViewIcons";
import LucideIcon from "../icons/LucideIcon.vue";
import BaseButton from "../ui/BaseButton.vue";
import BaseSegmented from "../ui/BaseSegmented.vue";

const props = defineProps<{ view: ViewPackageSummary; workspaceRef: WorkspaceRef }>();
const emit = defineEmits<{ close: []; saved: [view: ViewPackageSummary] }>();
const { ownerDocument } = useWindowSurface();
const { state } = useDisplaySettings();
const id = useId();
const dialog = ref<HTMLDialogElement | null>(null);
const name = ref(props.view.name);
const icon = ref(props.view.icon ?? "");
const current = ref(props.view);
const loading = ref(true);
const loaded = ref(false);
const saving = ref(false);
const error = ref("");
const readOnly = computed(() => isPluginView(current.value));
const target = ref<ViewOpenTarget | "default">(state.viewOpenOverrides[viewOpenPreferenceKey(props.workspaceRef, props.view.id)] ?? "default");
const options = computed(() => [
  { value: "default", label: t("view.config.followDefault"), disabled: saving.value },
  { value: "tab", label: t("settings.display.viewOpenTab"), disabled: saving.value },
  { value: "window", label: t("settings.display.viewOpenWindow"), disabled: saving.value },
]);
function close() { if (!saving.value) emit("close"); }
onMounted(async () => {
  await nextTick();
  dialog.value?.showModal();
  try {
    const detail = await viewRead(props.workspaceRef, props.view.id);
    current.value = detail.summary;
    name.value = detail.manifest.name;
    icon.value = detail.manifest.icon ?? "";
    loaded.value = true;
  } catch (cause) { error.value = normalizeViewError(cause).message; }
  finally { loading.value = false; }
});
async function save() {
  if (saving.value || !loaded.value || !name.value.trim()) return;
  saving.value = true;
  error.value = "";
  try {
    let summary = current.value;
    if (!readOnly.value && (name.value.trim() !== summary.name || icon.value.trim() !== (summary.icon ?? ""))) {
      summary = await viewUpdateMetadata(props.workspaceRef, { viewId: summary.id, name: name.value.trim(), icon: icon.value.trim() || null });
    }
    setViewOpenOverride(props.workspaceRef, summary.id, target.value);
    emit("saved", summary);
    emit("close");
  } catch (cause) { error.value = normalizeViewError(cause).message; }
  finally { saving.value = false; }
}
</script>

<template>
  <Teleport :to="ownerDocument.body">
    <dialog ref="dialog" class="view-config-dialog" :aria-labelledby="`${id}-title`" @cancel.prevent="close" @click.self="close">
      <form @submit.prevent="save">
        <header :id="`${id}-title`">{{ t('view.config.title') }}</header>
        <div class="view-config-body">
          <label :for="`${id}-name`">{{ t('view.metadata.name') }}</label>
          <input :id="`${id}-name`" v-model="name" autofocus :disabled="readOnly || loading || saving" required />
          <label :for="`${id}-icon`">{{ t('view.config.icon') }}</label>
          <div class="view-config-icon">
            <LucideIcon :icon="resolveLocusViewIcon(icon)" :size="18" />
            <input :id="`${id}-icon`" v-model="icon" :list="`${id}-icons`" :disabled="readOnly || loading || saving" :placeholder="t('view.config.iconPlaceholder')" spellcheck="false" />
            <datalist :id="`${id}-icons`"><option v-for="item in LOCUS_VIEW_ICON_NAMES" :key="item" :value="item" /></datalist>
          </div>
          <span>{{ t('settings.display.viewOpenTarget') }}</span>
          <BaseSegmented :model-value="target" :options="options" :aria-label="t('settings.display.viewOpenTarget')" size="sm" @update:model-value="target = $event as ViewOpenTarget | 'default'" />
          <span>{{ t('view.metadata.id') }}</span><span class="view-config-mono">{{ current.id }}</span>
          <span>{{ t('view.metadata.version') }}</span><span class="view-config-mono">{{ current.version }}</span>
          <span>{{ t('view.metadata.location') }}</span><span class="view-config-mono view-config-path">{{ current.packageRoot }}</span>
          <p v-if="readOnly" class="view-config-note">{{ viewPluginAttribution(current) }}</p>
          <p v-if="error" class="view-config-error" role="alert">{{ error }}</p>
        </div>
        <footer>
          <BaseButton :disabled="saving" @click="close">{{ t('common.cancel') }}</BaseButton>
          <BaseButton type="submit" :disabled="!loaded || saving || !name.trim()">{{ t('common.save') }}</BaseButton>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.view-config-dialog { width: min(520px, calc(100vw - 40px)); margin: auto; padding: 0; border: 1px solid var(--border-color); border-radius: 8px; background: var(--panel-bg); color: var(--text-color); font-family: var(--font-ui); font-size: 13px; }
.view-config-dialog::backdrop { background: color-mix(in srgb, var(--bg-color) 55%, transparent); }
header { padding: 14px 18px; border-bottom: 1px solid var(--border-color); font-weight: 600; }
.view-config-body { display: grid; grid-template-columns: 90px minmax(0, 1fr); align-items: center; gap: 14px 12px; padding: 18px; max-height: 65vh; overflow: auto; }
input { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--border-color); border-radius: 4px; padding: 6px 8px; background: var(--input-bg, var(--bg-color)); color: var(--text-color); font: inherit; }
input:focus-visible { outline: 1px solid var(--accent-color); }
input:disabled { opacity: .6; }
.view-config-icon { display: flex; align-items: center; gap: 10px; min-width: 0; }
.view-config-mono { font-family: var(--font-mono-identifier); color: var(--text-secondary); font-size: 12px; }
.view-config-path { overflow-wrap: anywhere; }
.view-config-note, .view-config-error { grid-column: 1 / -1; margin: 0; font-size: 12px; }
.view-config-note { color: var(--text-secondary); }
.view-config-error { color: var(--status-danger-fg); }
footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border-color); }
</style>
