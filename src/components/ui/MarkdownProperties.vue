<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue";
import { AlignLeft, Braces, CalendarDays, Check, CodeXml, Hash, List, Plus, SquareCheck, Trash2, X } from "lucide";
import LucideIcon from "../icons/LucideIcon.vue";
import BaseButton from "./BaseButton.vue";
import BaseCheckbox from "./BaseCheckbox.vue";
import BaseContextMenu from "./BaseContextMenu.vue";
import BaseDropdown from "./BaseDropdown.vue";
import { t } from "../../i18n";
import { convertPropertyValue, defaultPropertyValue, editProperties, parseProperties, propertyRows, type MarkdownProperty, type PropertyEdit, type PropertyType } from "../../document/markdownProperties";

const props = withDefaults(defineProps<{ yaml: string; disabled?: boolean; error?: string; title?: string; reservedKeys?: readonly string[] }>(), {
  disabled: false, error: "", title: "", reservedKeys: () => [],
});
const emit = defineEmits<{ change: [yaml: string]; shortcutSave: [] }>();
const adding = ref(false);
const newName = ref("");
const newType = ref<PropertyType>("text");
const editError = ref("");
const sourceOpen = ref(false);
const sourceDraft = ref("");
const newNameRef = ref<HTMLInputElement | null>(null);
const typeMenu = ref<{ key: string; x: number; y: number } | null>(null);
const typeMenuId = useId();
let typeMenuTrigger: HTMLElement | null = null;
let sourceBase = "";
const types: PropertyType[] = ["text", "list", "number", "boolean", "date"];
const typeIcons = { text: AlignLeft, list: List, number: Hash, boolean: SquareCheck, date: CalendarDays, yaml: Braces };
const typeOptions = computed(() => types.map((type) => ({ value: type, label: t(`editor.properties.${type}`) })));
const parsed = computed(() => {
  try { return { rows: propertyRows(props.yaml), error: props.error }; }
  catch { return { rows: [], error: t("editor.properties.invalidYaml") }; }
});
function apply(edit: PropertyEdit) {
  if (props.disabled || parsed.value.error) return;
  editError.value = "";
  try {
    if (props.reservedKeys.includes(edit.newKey ?? edit.key)) throw new Error("editor.properties.reservedName");
    emit("change", editProperties(props.yaml, edit));
  } catch (error) { editError.value = t(error instanceof Error ? error.message : "editor.properties.invalidYaml"); }
}
function changeValue(row: MarkdownProperty, event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.checkValidity()) { input.reportValidity(); return; }
  const value = row.type === "number" ? (input.value === "" ? null : Number(input.value)) : input.value;
  if (typeof value === "number" && !Number.isFinite(value)) return;
  apply({ key: row.key, value });
}
function changeList(row: MarkdownProperty, index: number, event: Event) {
  const values = [...row.value as string[]];
  values[index] = (event.target as HTMLInputElement).value;
  apply({ key: row.key, value: values });
}
function changeType(type: PropertyType) {
  const row = parsed.value.rows.find((candidate) => candidate.key === typeMenu.value?.key);
  closeTypeMenu();
  if (!row || row.type === type) return;
  try { apply({ key: row.key, value: convertPropertyValue(row.value, type), type }); }
  catch (error) { editError.value = t((error as Error).message); }
}
async function openTypeMenu(row: MarkdownProperty, event: MouseEvent) {
  if (row.type === "yaml") { openSource(); return; }
  typeMenuTrigger = event.currentTarget as HTMLElement;
  const rect = typeMenuTrigger.getBoundingClientRect();
  typeMenu.value = { key: row.key, x: rect.left, y: rect.bottom + 4 };
  await nextTick();
  document.getElementById(typeMenuId)?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
}
function closeTypeMenu() {
  typeMenu.value = null;
  if (typeMenuTrigger?.isConnected) typeMenuTrigger.focus();
  typeMenuTrigger = null;
}
function navigateTypeMenu(event: KeyboardEvent) {
  if (event.key === "Tab") { closeTypeMenu(); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = Array.from(document.getElementById(typeMenuId)?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[index]?.focus();
}
async function beginAddProperty() {
  adding.value = true;
  await nextTick();
  newNameRef.value?.focus();
}
function openSource() {
  sourceDraft.value = sourceBase = props.yaml;
  sourceOpen.value = true;
  editError.value = "";
}
function saveSource() {
  if (props.disabled || props.error) return;
  try {
    if (props.yaml !== sourceBase) throw new Error("editor.properties.changedExternally");
    const doc = parseProperties(sourceDraft.value);
    if (props.reservedKeys.some((key) => doc.has(key))) throw new Error("editor.properties.reservedName");
    emit("change", sourceDraft.value.endsWith("\n") ? sourceDraft.value : `${sourceDraft.value}\n`);
    sourceOpen.value = false;
    editError.value = "";
  } catch (error) { editError.value = t((error as Error).message); }
}
function addProperty() {
  if (parsed.value.rows.some((row) => row.key === newName.value.trim())) { editError.value = t("editor.properties.duplicateName"); return; }
  apply({ key: newName.value.trim(), value: defaultPropertyValue(newType.value), type: newType.value });
  if (!editError.value) { adding.value = false; newName.value = ""; }
}
function keydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    (event.target as HTMLElement).blur();
    if (sourceOpen.value) saveSource();
    emit("shortcutSave");
  }
}
watch(() => props.disabled, (disabled) => { if (disabled) closeTypeMenu(); });
</script>

<template>
  <section class="markdown-properties" :class="{ 'is-empty': !parsed.rows.length && !parsed.error && !adding && !sourceOpen }" :aria-label="title || t('editor.properties.title')" @keydown="keydown">
    <div v-if="parsed.rows.length || parsed.error || adding || sourceOpen" class="properties-toolbar">
      <span class="properties-heading">
        {{ title || t('editor.properties.title') }}
      </span>
      <BaseButton
        v-if="!props.error"
        class="property-icon property-source-trigger"
        :title="t('editor.properties.source')"
        :aria-label="t('editor.properties.source')"
        @click="openSource"
      ><LucideIcon :icon="CodeXml" :size="14" /></BaseButton>
    </div>
      <div v-if="sourceOpen" class="property-source">
        <textarea v-model="sourceDraft" :disabled="disabled" :aria-label="t('editor.properties.source')" spellcheck="false" />
        <div class="property-source-actions"><BaseButton v-if="!disabled" @click="saveSource">{{ t('editor.properties.apply') }}</BaseButton><BaseButton @click="sourceOpen = false">{{ t('editor.properties.cancel') }}</BaseButton></div>
      </div>
      <template v-else>
      <p v-if="parsed.error" class="properties-error" role="alert">{{ parsed.error }}</p>
      <div v-for="row in parsed.rows" :key="row.key" class="property-row">
        <div class="property-label">
          <BaseButton
            class="property-icon property-type"
            :disabled="disabled"
            :title="t(`editor.properties.${row.type === 'yaml' ? 'source' : row.type}`)"
            :aria-label="`${row.key} · ${t('editor.properties.type')}`"
            :aria-expanded="typeMenu?.key === row.key"
            :aria-haspopup="row.type === 'yaml' ? undefined : 'menu'"
            @click="openTypeMenu(row, $event)"
          ><LucideIcon :icon="typeIcons[row.type]" :size="14" :stroke-width="1.6" /></BaseButton>
          <input class="property-name" :value="row.key" :disabled="disabled" :aria-label="t('editor.properties.name')" @change="apply({ key: row.key, newKey: ($event.target as HTMLInputElement).value })" @keydown.enter="($event.target as HTMLElement).blur()" />
        </div>
        <div class="property-value">
          <BaseCheckbox v-if="row.type === 'boolean'" :model-value="Boolean(row.value)" :disabled="disabled" :aria-label="row.key" @update:model-value="apply({ key: row.key, value: $event })" />
          <div v-else-if="row.type === 'list'" class="property-list">
            <div v-for="(value, index) in (row.value as string[])" :key="index" class="property-list-item">
              <span class="property-list-field" :data-value="value || ' '"><input :value="value" :aria-label="`${row.key} ${index + 1}`" :disabled="disabled" @change="changeList(row, index, $event)" @keydown.enter="($event.target as HTMLElement).blur()" /></span>
              <BaseButton v-if="!disabled" class="property-icon property-list-remove" :title="t('editor.properties.removeValue')" :aria-label="t('editor.properties.removeValue')" @click="apply({ key: row.key, value: (row.value as string[]).filter((_, i) => i !== index) })"><LucideIcon :icon="X" :size="12" /></BaseButton>
            </div>
            <BaseButton v-if="!disabled" class="property-icon property-list-add" :title="t('editor.properties.addValue')" :aria-label="t('editor.properties.addValue')" @click="apply({ key: row.key, value: [...row.value as string[], ''] })"><LucideIcon :icon="Plus" :size="14" /></BaseButton>
          </div>
          <pre v-else-if="row.type === 'yaml'" class="property-yaml" :title="t('editor.properties.complexHint')">{{ row.value }}</pre>
          <textarea v-else-if="row.type === 'text' && String(row.value).includes('\n')" :value="String(row.value)" :aria-label="row.key" :disabled="disabled" @change="changeValue(row, $event)" />
          <input v-else :type="row.type === 'number' ? 'number' : row.type === 'date' ? 'date' : 'text'" step="any" :value="row.value ?? ''" :aria-label="row.key" :disabled="disabled" @change="changeValue(row, $event)" @keydown.enter="($event.target as HTMLElement).blur()" />
        </div>
        <BaseButton v-if="!disabled" class="property-icon property-remove" :title="t('editor.properties.remove')" :aria-label="`${t('editor.properties.remove')} ${row.key}`" @click="apply({ key: row.key, remove: true })"><LucideIcon :icon="X" :size="14" /></BaseButton>
      </div>
      <form v-if="adding && !disabled" class="property-add" @submit.prevent="addProperty">
        <input ref="newNameRef" v-model="newName" :placeholder="t('editor.properties.name')" :aria-label="t('editor.properties.name')" @keydown.esc="adding = false" />
        <BaseDropdown v-model="newType" class="property-new-type" :options="typeOptions" :aria-label="t('editor.properties.type')" teleport menu-align="start" />
        <BaseButton type="submit">{{ t('editor.properties.add') }}</BaseButton>
        <BaseButton class="property-icon" :aria-label="t('editor.properties.cancel')" @click="adding = false"><LucideIcon :icon="X" :size="14" /></BaseButton>
      </form>
      <BaseButton v-else-if="!disabled && !parsed.error" class="property-add-trigger" @click="beginAddProperty"><LucideIcon :icon="Plus" :size="14" />{{ t('editor.properties.add') }}</BaseButton>
      </template>
      <p v-if="editError" class="properties-error" role="alert">{{ editError }}</p>
    <BaseContextMenu
      v-if="typeMenu"
      :id="typeMenuId"
      :x="typeMenu.x"
      :y="typeMenu.y"
      :aria-label="`${typeMenu.key} · ${t('editor.properties.type')}`"
      @close="closeTypeMenu"
      @keydown="navigateTypeMenu"
    >
      <BaseButton
        v-for="type in types"
        :key="type"
        class="property-menu-item"
        role="menuitemradio"
        :aria-checked="parsed.rows.find((row) => row.key === typeMenu?.key)?.type === type"
        @click="changeType(type)"
      >
        <LucideIcon :icon="typeIcons[type]" :size="14" />
        <span>{{ t(`editor.properties.${type}`) }}</span>
        <LucideIcon v-if="parsed.rows.find((row) => row.key === typeMenu?.key)?.type === type" class="property-menu-check" :icon="Check" :size="12" />
      </BaseButton>
      <div class="base-context-menu-separator" />
      <BaseButton class="property-menu-item danger" role="menuitem" @click="apply({ key: typeMenu.key, remove: true }); closeTypeMenu()">
        <LucideIcon :icon="Trash2" :size="14" />{{ t('editor.properties.remove') }}
      </BaseButton>
    </BaseContextMenu>
  </section>
</template>

<style scoped>
.markdown-properties { min-width: 0; margin-bottom: 24px; font-family: var(--font-ui); font-size: 13px; line-height: 1.5; }
.markdown-properties.is-empty { margin-bottom: 8px; }
.properties-heading { color: var(--text-secondary); font-size: 12px; font-weight: 600; }
.properties-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 7px; }
.property-source-trigger { opacity: 0; }
.properties-toolbar:hover .property-source-trigger, .properties-toolbar:focus-within .property-source-trigger { opacity: 1; }
.markdown-properties textarea { box-sizing: border-box; width: 100%; min-height: 64px; resize: vertical; border: 1px solid var(--border-color); border-radius: 6px; background: transparent; color: var(--text-color); padding: 6px; font: inherit; }
.property-source textarea { min-height: 160px; font-family: var(--font-mono-editor); }
.property-source-actions { display: flex; gap: 6px; margin-top: 6px; }
.property-row { display: grid; grid-template-columns: 112px minmax(0, 1fr) 24px; align-items: start; gap: 12px; min-height: 30px; padding: 1px 0; }
.property-label { display: flex; align-items: center; gap: 2px; min-width: 0; }
.markdown-properties input, .markdown-properties select { box-sizing: border-box; width: 100%; min-width: 0; height: 28px; padding: 3px 6px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--text-color); font: inherit; outline: none; }
.markdown-properties input:hover:not(:disabled), .markdown-properties select:hover:not(:disabled) { background: var(--hover-bg); }
.markdown-properties input:focus, .markdown-properties select:focus-visible { border-color: var(--border-strong); background: var(--panel-bg); }
.markdown-properties input:disabled { opacity: 1; }
.markdown-properties select option { color: var(--text-color); background: var(--panel-bg); }
.markdown-properties .property-name { color: var(--text-secondary); font-size: 12px; padding-inline: 2px; }
.property-value { min-width: 0; min-height: 28px; display: flex; align-items: center; }
.property-list { display: flex; flex-wrap: wrap; align-items: center; gap: 0 4px; width: 100%; }
.property-list-item { display: flex; align-items: center; min-width: 40px; max-width: 100%; flex: 0 1 auto; }
.property-list-field { display: inline-grid; min-width: 32px; min-height: 28px; max-width: 100%; }
.property-list-field::after { content: attr(data-value); visibility: hidden; grid-area: 1 / 1; white-space: pre; padding: 3px 6px; border: 1px solid transparent; }
.property-list-field input { grid-area: 1 / 1; width: 0; min-width: 100%; }
.property-icon { width: 24px; min-width: 24px; min-height: 28px; padding: 0; border-color: transparent; }
.property-type { opacity: 0.7; }
.property-type:disabled { opacity: 0.7; }
.property-remove, .property-list-add { opacity: 0; }
.property-row:hover .property-remove, .property-row:focus-within .property-remove, .property-row:hover .property-list-add, .property-row:focus-within .property-list-add { opacity: 1; }
.property-list-remove { width: 20px; min-width: 20px; color: var(--text-tertiary, var(--text-secondary)); }
.property-menu-check { margin-inline-start: auto; }
.property-menu-item { justify-content: flex-start; }
.property-add { display: flex; gap: 6px; margin-top: 6px; align-items: center; }
.property-add input { max-width: 220px; border-color: var(--border-color); }
.property-new-type { width: 90px; flex: 0 0 90px; }
.property-new-type :deep(.base-dropdown-trigger) { min-width: 0; }
.property-add-trigger { border-color: transparent; padding: 0 4px; margin-top: 4px; font-weight: 400; }
.property-yaml { white-space: pre-wrap; overflow-wrap: anywhere; margin: 3px 6px; font: 12px/1.5 var(--font-mono-editor); color: var(--text-secondary); }
.properties-error { margin: 6px 0; color: var(--status-warn-fg); font-size: 12px; }
</style>
