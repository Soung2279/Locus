<script setup lang="ts">
import { ChevronDown, ChevronLeft, ChevronRight, Ellipsis, GripVertical, Plus, Search, Trash2, X } from "lucide";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import type { InspectorProperty } from "../../services/propertyTree";
import PropertyField from "../property-field/PropertyField.vue";
import { propertyFieldAccess, type PropertyFieldPresentation, type PropertyFieldAction } from "../property-field/propertyField";
import { useWindowSurface } from "../../composables/useWindowSurface";
import { t } from "../../i18n";
import BaseButton from "../ui/BaseButton.vue";
import BaseContextMenu from "../ui/BaseContextMenu.vue";
import LucideIcon from "../icons/LucideIcon.vue";
import UnityObjectReferenceField from "./UnityObjectReferenceField.vue";
import { useUnityPropertyListDrop } from "./useUnityPropertyListDrop";
import {
  canDuplicateListItem, isComplexListItem, propertyListItemMatches, propertyListItemSummary,
  propertyListSettings, propertyListElementType, recalledPropertyList, rememberPropertyList,
} from "./unityPropertyList";

const props = defineProps<{
  property: InspectorProperty;
  editable: boolean;
  stateKey: string;
  fieldPresentation?: PropertyFieldPresentation;
  loadChildren?: (property: InspectorProperty) => unknown | Promise<unknown>;
}>();
const emit = defineEmits<{ command: [value: Record<string, unknown>]; fieldAction: [action: PropertyFieldAction] }>();
const { ownerWindow, ownerDocument } = useWindowSurface();
const root = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const menuContent = ref<HTMLElement | null>(null);
const settings = computed(() => propertyListSettings(props.property.snapshot));
const elementType = computed(() => propertyListElementType(props.property.snapshot));
const count = computed(() => Math.max(0, props.property.arraySize >= 0 ? props.property.arraySize : props.property.children.length));
const fieldAccess = computed(() => propertyFieldAccess(props.fieldPresentation));
const canChange = computed(() => props.editable && !settings.value.readOnly && fieldAccess.value.visible && !fieldAccess.value.readonly && !fieldAccess.value.disabled);
const collapsed = ref(false);
const expanded = ref(new Set<number>());
const page = ref(0);
const query = ref("");
const searching = ref(false);
const loading = ref(false);
const error = ref("");
const menu = ref<{ x: number; y: number; index: number | null } | null>(null);
const resize = ref(false);
const referenceInsert = ref<number | null>(null);
const sizeDraft = ref("");
const menuTrigger = shallowRef<HTMLElement | null>(null);
const pendingReveal = ref<{ previousCount: number; index: number } | null>(null);
const pendingFocus = ref<number | null>(null);
const drag = shallowRef<{ pointerId: number; startX: number; startY: number; source: number; target: number; active: boolean; y: number } | null>(null);
let scrollFrame = 0;
const items = computed(() => props.property.children.map((child, index) => ({ child, index })));
const matches = computed(() => items.value.filter(item => propertyListItemMatches(item.child, query.value)));
const pageSize = computed(() => settings.value.paging ? settings.value.pageSize : Math.max(1, count.value));
const total = computed(() => query.value.trim() ? matches.value.length : count.value);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const visibleItems = computed(() => {
  const result = matches.value.slice(page.value * pageSize.value, (page.value + 1) * pageSize.value);
  const moving = drag.value;
  if (moving?.active && moving.source !== moving.target) {
    const from = result.findIndex(item => item.index === moving.source);
    const to = result.findIndex(item => item.index === moving.target);
    if (from >= 0 && to >= 0) result.splice(to, 0, result.splice(from, 1)[0]!);
  }
  return result;
});
const truncated = computed(() => props.property.snapshot.childrenTruncated === true || props.property.children.length < count.value);
const hasComplex = computed(() => items.value.some(item => isComplexListItem(item.child)));
const menuItem = computed(() => menu.value?.index != null ? items.value[menu.value.index] : null);
const assetDrop = useUnityPropertyListDrop({
  root, enabled: () => canChange.value && !settings.value.hideAdd && elementType.value.reference === true,
  stateKey: () => props.stateKey, count: () => count.value, insert: insertReferences,
  error: cause => { error.value = cause instanceof Error ? cause.message : String(cause); },
});

function saveState() {
  rememberPropertyList(props.stateKey, { collapsed: collapsed.value, expanded: expanded.value, page: page.value, query: query.value });
}
watch(() => props.stateKey, (key, oldKey) => {
  if (oldKey) rememberPropertyList(oldKey, { collapsed: collapsed.value, expanded: expanded.value, page: page.value, query: query.value });
  cancelDrag(); closeMenu(false); pendingReveal.value = null; pendingFocus.value = null;
  const previous = recalledPropertyList(key);
  collapsed.value = settings.value.showFoldout && (previous?.collapsed ?? !(settings.value.defaultExpanded ?? count.value <= 24));
  expanded.value = previous?.expanded ?? new Set();
  page.value = Math.min(previous?.page ?? 0, Math.max(0, Math.ceil(count.value / pageSize.value) - 1));
  query.value = previous?.query ?? "";
  searching.value = !!query.value;
}, { immediate: true });
watch([collapsed, expanded, page, query], saveState, { deep: true });
watch(pageCount, pages => { page.value = Math.min(page.value, pages - 1); });
watch(query, () => { page.value = 0; cancelDrag(); });
watch(() => props.editable, editable => { if (!editable) cancelDrag(); });
watch(() => props.property.children, async () => {
  cancelDrag(); closeMenu(false);
  const requested = pendingFocus.value;
  if (requested === null) return;
  pendingFocus.value = null;
  const key = props.stateKey;
  const index = Math.max(0, Math.min(count.value - 1, requested));
  const position = query.value.trim() ? matches.value.findIndex(item => item.index === index) : index;
  await showPage(Math.floor(Math.max(0, position) / pageSize.value));
  await nextTick();
  if (key !== props.stateKey) return;
  (root.value?.querySelector<HTMLElement>(`[data-array-source-index="${index}"] .array-index-handle:not(:disabled)`)
    ?? root.value?.querySelector<HTMLElement>(".array-item-toggle, .array-fold-button"))?.focus({ preventScroll: true });
});
watch(count, async () => {
  const pending = pendingReveal.value;
  if (!pending || count.value <= pending.previousCount) return;
  pendingReveal.value = null;
  await showPage(Math.floor(pending.index / pageSize.value));
  expanded.value.add(pending.index);
  await nextTick();
  root.value?.querySelector<HTMLElement>(`[data-array-source-index="${pending.index}"] .array-item-toggle, [data-array-source-index="${pending.index}"] input`)?.focus({ preventScroll: true });
});
onBeforeUnmount(() => { saveState(); cancelDrag(); });

async function loadMore() {
  if (!props.loadChildren || loading.value) return;
  loading.value = true; error.value = "";
  try { await props.loadChildren(props.property); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { loading.value = false; }
}
async function showPage(value: number) {
  cancelDrag();
  page.value = Math.max(0, Math.min(pageCount.value - 1, value));
  const end = Math.min(count.value, (page.value + 1) * pageSize.value);
  while (!query.value.trim() && props.property.snapshot.childrenTruncated === true && props.property.children.length < end && props.loadChildren && !loading.value) {
    const before = props.property.children.length;
    await loadMore();
    await nextTick();
    if (props.property.children.length <= before || error.value) break;
  }
}
function toggleItem(index: number) {
  if (expanded.value.has(index)) expanded.value.delete(index); else expanded.value.add(index);
}
function toggleList() { collapsed.value = !collapsed.value; cancelDrag(); }
async function toggleSearch() {
  searching.value = !searching.value;
  if (!searching.value) query.value = "";
  else { collapsed.value = false; await nextTick(); searchInput.value?.focus(); }
}
function change(command: Record<string, unknown>) {
  if (!canChange.value) return;
  emit("command", command);
}
function insert(index: number, duplicate = false) {
  if (!canChange.value || settings.value.hideAdd) return;
  const child = props.property.children[index];
  if (duplicate && (index < 0 || index >= count.value || child && !canDuplicateListItem(child))) return;
  const inserted = duplicate ? index + 1 : index;
  expanded.value = new Set([...expanded.value].map(value => value >= inserted ? value + 1 : value));
  pendingReveal.value = { previousCount: count.value, index: inserted };
  collapsed.value = false; query.value = "";
  closeMenu();
  change({ action: duplicate ? "duplicate" : "insert", index, ...(!duplicate && elementType.value.native ? { initialize: true } : {}) });
}
function requestInsert(index: number, event?: MouseEvent) {
  if (!canChange.value || settings.value.hideAdd) return;
  if (settings.value.copyLast && index === count.value && count.value > 0 && !settings.value.alwaysDefault) { insert(count.value - 1, true); return; }
  if (!elementType.value.reference || settings.value.alwaysDefault) { insert(index); return; }
  if (event) { void openMenu(event, null).then(() => { referenceInsert.value = index; }); }
  else referenceInsert.value = index;
}
function insertReferences(index: number, values: string[]) {
  if (!canChange.value || settings.value.hideAdd || !elementType.value.reference || !values.length) return;
  closeMenu(); collapsed.value = false; query.value = "";
  expanded.value = new Set([...expanded.value].map(value => value >= index ? value + values.length : value));
  pendingReveal.value = { previousCount: count.value, index };
  change({ action: "insertReferences", index, values });
}
function remove(index: number) {
  if (!canChange.value || settings.value.hideRemove || index < 0 || index >= count.value) return;
  expanded.value = new Set([...expanded.value].filter(value => value !== index).map(value => value > index ? value - 1 : value));
  pendingReveal.value = null; pendingFocus.value = index;
  closeMenu(); change({ action: "delete", index });
}
function move(index: number, target: number) {
  if (!canChange.value || !settings.value.draggable || index === target || target < 0 || target >= count.value) return;
  expanded.value = new Set([...expanded.value].map(value => value === index ? target
    : index < target && value > index && value <= target ? value - 1
    : index > target && value >= target && value < index ? value + 1 : value));
  pendingReveal.value = null; pendingFocus.value = target;
  closeMenu(); change({ action: "move", index, toIndex: target });
}
function canDrag(index: number) { return canChange.value && settings.value.draggable && count.value > 1 && !query.value.trim() && index < props.property.children.length; }

function closeMenu(focus = true) {
  menu.value = null; resize.value = false; referenceInsert.value = null;
  if (focus && menuTrigger.value?.isConnected) menuTrigger.value.focus({ preventScroll: true });
  menuTrigger.value = null;
}
async function openMenu(event: MouseEvent, index: number | null) {
  event.stopPropagation();
  cancelDrag();
  menuTrigger.value = event.currentTarget as HTMLElement;
  const rect = menuTrigger.value.getBoundingClientRect();
  menu.value = { x: rect.right - 180, y: rect.bottom, index };
  resize.value = false; referenceInsert.value = null;
  await nextTick();
  menuContent.value?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
}
function menuKeydown(event: KeyboardEvent) {
  if (event.key === "Tab") { closeMenu(); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || resize.value || referenceInsert.value !== null) return;
  const buttons = [...(menuContent.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
  if (!buttons.length) return;
  event.preventDefault();
  const current = buttons.indexOf(ownerDocument.activeElement as HTMLButtonElement);
  const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[index]?.focus();
}
async function beginResize() {
  sizeDraft.value = String(count.value); resize.value = true;
  await nextTick(); menuContent.value?.querySelector<HTMLInputElement>("input")?.select();
}
const validSize = computed(() => /^\d+$/.test(String(sizeDraft.value).trim()) && Number.isSafeInteger(Number(sizeDraft.value)) && Number(sizeDraft.value) <= 100000);
function applySize() {
  if (!canChange.value || !validSize.value) return;
  const size = Number(sizeDraft.value);
  if (size > count.value && settings.value.hideAdd || size < count.value && settings.value.hideRemove) return;
  closeMenu(); if (size !== count.value) change({ action: "resize", size });
}
function expandAll(value: boolean) {
  expanded.value = value ? new Set(items.value.map(item => item.index)) : new Set();
  closeMenu();
}

function dragDestination(clientY: number) {
  const current = drag.value;
  if (!current || !root.value) return;
  const rows = [...root.value.querySelectorAll<HTMLElement>(":scope > .array-items > .array-item")]
    .filter(row => Number(row.dataset.arraySourceIndex) !== current.source);
  if (!rows.length) return;
  const slot = rows.findIndex(row => clientY <= row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
  // Slots are page-relative positions, not row IDs. Excluding the moving row
  // keeps hit testing stable after the live preview moves that row.
  const target = page.value * pageSize.value + (slot < 0 ? rows.length : slot);
  drag.value = { ...current, target, y: clientY };
}
function scrollDuringDrag() {
  scrollFrame = 0;
  const current = drag.value;
  if (!current?.active || !root.value) return;
  let parent = root.value.parentElement;
  while (parent && !(parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(ownerWindow.getComputedStyle(parent).overflowY))) parent = parent.parentElement;
  if (parent) {
    const rect = parent.getBoundingClientRect();
    const delta = current.y < rect.top + 32 ? -10 : current.y > rect.bottom - 32 ? 10 : 0;
    if (delta) { parent.scrollTop += delta; dragDestination(current.y); }
  }
  scrollFrame = ownerWindow.requestAnimationFrame(scrollDuringDrag);
}
function startDrag(index: number, event: PointerEvent) {
  if (event.button !== 0 || !canDrag(index)) return;
  event.preventDefault(); event.stopPropagation();
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  drag.value = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, source: index, target: index, active: false, y: event.clientY };
  ownerWindow.addEventListener("pointermove", dragMove);
  ownerWindow.addEventListener("pointerup", finishDrag);
  ownerWindow.addEventListener("pointercancel", cancelDrag);
  ownerWindow.addEventListener("keydown", dragKeydown, true);
}
function dragMove(event: PointerEvent) {
  const current = drag.value;
  if (!current || current.pointerId !== event.pointerId) return;
  if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 4) return;
  event.preventDefault();
  drag.value = { ...current, active: true, y: event.clientY };
  dragDestination(event.clientY);
  if (!scrollFrame) scrollFrame = ownerWindow.requestAnimationFrame(scrollDuringDrag);
}
function finishDrag(event: PointerEvent) {
  const current = drag.value;
  if (!current || current.pointerId !== event.pointerId) return;
  cancelDrag();
  if (current.active) move(current.source, current.target);
}
function dragKeydown(event: KeyboardEvent) { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelDrag(); } }
function cancelDrag() {
  drag.value = null;
  if (scrollFrame) ownerWindow.cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
  ownerWindow.removeEventListener("pointermove", dragMove);
  ownerWindow.removeEventListener("pointerup", finishDrag);
  ownerWindow.removeEventListener("pointercancel", cancelDrag);
  ownerWindow.removeEventListener("keydown", dragKeydown, true);
}
</script>

<template>
  <div v-if="fieldAccess.visible" ref="root" class="unity-property-list" :class="{ 'asset-drop': assetDrop.hovering.value }" :aria-busy="loading || undefined"
    @dragover="assetDrop.dragover" @dragleave="assetDrop.dragleave" @drop="assetDrop.drop">
    <PropertyField v-bind="fieldPresentation" class="property-list-header" :label="property.label"
      :field-key="fieldPresentation?.fieldKey || stateKey" :show-label="false"
      :readonly="!editable || settings.readOnly || fieldAccess.readonly" @action="$emit('fieldAction', $event)">
    <slot name="header" :collapsed="collapsed" :toggle="toggleList">
      <div class="array-toolbar">
        <BaseButton v-if="settings.showFoldout" class="array-fold-button list-title" :aria-expanded="!collapsed" @click="toggleList">
          <LucideIcon :icon="collapsed ? ChevronRight : ChevronDown" :size="13" /><span>{{ property.label }}</span>
        </BaseButton>
        <span v-else class="list-title">{{ property.label }}</span>
        <span v-if="settings.showCount" class="array-count">{{ t('unity.property.array.count', count) }}</span>
        <BaseButton v-if="!settings.hideAdd" class="list-icon array-add-button" :disabled="!canChange" :title="t('unity.property.array.add')" :aria-label="t('unity.property.array.add')" @click="requestInsert(count, $event)"><LucideIcon :icon="Plus" :size="14" /></BaseButton>
        <BaseButton class="list-icon array-menu-button" :title="t('unity.property.array.options')" :aria-label="t('unity.property.array.options')" aria-haspopup="menu" :aria-expanded="menu?.index === null" @click="openMenu($event, null)"><LucideIcon :icon="Ellipsis" :size="14" /></BaseButton>
      </div>
    </slot>
    </PropertyField>
    <div v-if="searching && !collapsed" class="array-search">
      <LucideIcon :icon="Search" :size="13" />
      <input ref="searchInput" v-model="query" type="search" :aria-label="t('unity.property.array.search')" :placeholder="t('unity.property.array.search')" @keydown.esc.stop="toggleSearch" />
      <BaseButton class="list-icon" :aria-label="t('common.close')" @click="toggleSearch"><LucideIcon :icon="X" :size="13" /></BaseButton>
    </div>
    <div v-if="!collapsed" class="array-items">
      <div v-if="!visibleItems.length" class="array-empty">{{ loading ? t('common.loading') : query ? t('unity.property.array.noMatches') : count ? t('unity.property.array.notLoaded') : t('unity.property.array.empty') }}</div>
      <div v-for="item in visibleItems" :key="item.child.propertyPath" class="array-item" :class="{ complex: isComplexListItem(item.child), expanded: expanded.has(item.index), dragging: drag?.active && drag.source === item.index }" :data-array-source-index="item.index">
        <div class="array-item-row">
          <BaseButton class="list-icon array-index-handle" :disabled="!canDrag(item.index)" :title="t('unity.property.array.dragToReorder')" :aria-label="t('unity.property.array.move', item.index)" @pointerdown="startDrag(item.index, $event)" @keydown.up.prevent="move(item.index, item.index - 1)" @keydown.down.prevent="move(item.index, item.index + 1)"><LucideIcon :icon="GripVertical" :size="13" /></BaseButton>
          <span v-if="settings.showIndex" class="array-item-index">{{ item.index }}</span>
          <BaseButton v-if="isComplexListItem(item.child)" class="array-item-toggle" :aria-expanded="expanded.has(item.index)" :title="propertyListItemSummary(item.child)" @click="toggleItem(item.index)">
            <LucideIcon :icon="expanded.has(item.index) ? ChevronDown : ChevronRight" :size="13" />
            <span>{{ propertyListItemSummary(item.child) || t('unity.property.array.element', item.index + 1) }}</span>
          </BaseButton>
          <div v-else class="array-item-content"><slot :item="item.child" :index="item.index" /></div>
          <BaseButton v-if="!settings.hideRemove" class="list-icon array-remove-button" :disabled="!canChange" :aria-label="t('unity.property.array.remove', item.index)" :title="t('unity.property.array.remove', item.index)" @click="remove(item.index)"><LucideIcon :icon="Trash2" :size="13" /></BaseButton>
          <BaseButton class="list-icon array-item-menu" :aria-label="t('unity.property.array.itemOptions', item.index + 1)" aria-haspopup="menu" :aria-expanded="menu?.index === item.index" @click="openMenu($event, item.index)"><LucideIcon :icon="Ellipsis" :size="13" /></BaseButton>
        </div>
        <div v-if="isComplexListItem(item.child) && expanded.has(item.index)" class="array-item-body"><slot :item="item.child" :index="item.index" /></div>
      </div>
    </div>
    <div v-if="!collapsed && (pageCount > 1 || truncated)" class="array-footer">
      <span v-if="query && truncated" class="array-search-scope">{{ t('unity.property.array.searchLoaded', property.children.length, count) }}</span>
      <BaseButton v-if="truncated && loadChildren" class="property-load-more" :disabled="loading" @click="loadMore">{{ loading ? t('common.loading') : t('common.loadMore') }}</BaseButton>
      <span v-else-if="truncated" class="array-search-scope">{{ t('common.truncated') }}</span>
      <div v-if="pageCount > 1" class="array-pagination">
        <BaseButton class="list-icon array-page-previous" :disabled="page === 0 || loading" :aria-label="t('unity.property.array.previousPage')" @click="showPage(page - 1)"><LucideIcon :icon="ChevronLeft" :size="13" /></BaseButton>
        <span>{{ page + 1 }} / {{ pageCount }}</span>
        <BaseButton class="list-icon array-page-next" :disabled="page >= pageCount - 1 || loading || (!loadChildren && !query && (page + 1) * pageSize >= property.children.length)" :aria-label="t('unity.property.array.nextPage')" @click="showPage(page + 1)"><LucideIcon :icon="ChevronRight" :size="13" /></BaseButton>
      </div>
    </div>
    <span v-if="error" class="array-error" role="alert">{{ error }}</span>
    <BaseContextMenu v-if="menu" :x="menu.x" :y="menu.y" :aria-label="t('unity.property.array.options')" @close="closeMenu()">
      <div ref="menuContent" @keydown="menuKeydown">
        <div v-if="referenceInsert !== null" class="array-reference-form">
          <UnityObjectReferenceField model-value="" :reference-type-full-name="elementType.fullName" :reference-type-assembly="elementType.assembly"
            :aria-label="t('unity.property.array.chooseReference')" :placeholder="t('unity.property.array.chooseReference')" :disabled="!canChange"
            @commit="value => value && referenceInsert !== null && insertReferences(referenceInsert, [value])" />
          <BaseButton :disabled="!canChange" @click="insert(referenceInsert)">{{ t('unity.property.array.addEmptyReference') }}</BaseButton>
        </div>
        <form v-else-if="resize" class="array-size-form" @submit.prevent="applySize">
          <label>{{ t('unity.property.array.setSize') }}<input v-model="sizeDraft" class="array-size-input" type="number" min="0" max="100000" step="1" :aria-label="t('unity.property.array.setSize')" /></label>
          <p v-if="validSize && Number(sizeDraft) < count">{{ t('unity.property.array.shrinkWarning', count - Number(sizeDraft)) }}</p>
          <div><BaseButton @click="closeMenu()">{{ t('common.cancel') }}</BaseButton><BaseButton type="submit" :disabled="!canChange || !validSize || (settings.hideAdd && Number(sizeDraft) > count) || (settings.hideRemove && Number(sizeDraft) < count)">{{ t('common.confirm') }}</BaseButton></div>
        </form>
        <template v-else-if="menuItem">
          <button v-if="!settings.hideAdd" class="ctx-item" role="menuitem" data-list-action="duplicate" :disabled="!canChange || !canDuplicateListItem(menuItem.child)" @click="insert(menuItem.index, true)">{{ t('unity.property.array.duplicate') }}</button>
          <button v-if="!settings.hideAdd" class="ctx-item" role="menuitem" data-list-action="insertBefore" :disabled="!canChange" @click="requestInsert(menuItem.index)">{{ t('unity.property.array.insertBefore') }}</button>
          <button v-if="!settings.hideAdd" class="ctx-item" role="menuitem" data-list-action="insertAfter" :disabled="!canChange" @click="requestInsert(menuItem.index + 1)">{{ t('unity.property.array.insertAfter') }}</button>
          <div class="ctx-separator" />
          <button class="ctx-item" role="menuitem" data-list-action="moveUp" :disabled="!canChange || !settings.draggable || menuItem.index === 0" @click="move(menuItem.index, menuItem.index - 1)">{{ t('unity.property.array.moveUp') }}</button>
          <button class="ctx-item" role="menuitem" data-list-action="moveDown" :disabled="!canChange || !settings.draggable || menuItem.index >= count - 1" @click="move(menuItem.index, menuItem.index + 1)">{{ t('unity.property.array.moveDown') }}</button>
          <button v-if="!settings.hideRemove" class="ctx-item danger" role="menuitem" data-list-action="delete" :disabled="!canChange" @click="remove(menuItem.index)">{{ t('unity.property.array.delete') }}</button>
        </template>
        <template v-else>
          <button class="ctx-item" role="menuitem" data-list-action="search" @click="closeMenu(); toggleSearch()">{{ t('unity.property.array.search') }}</button>
          <button v-if="hasComplex" class="ctx-item" role="menuitem" data-list-action="expand" @click="expandAll(true)">{{ t('unity.property.array.expandAll') }}</button>
          <button v-if="hasComplex" class="ctx-item" role="menuitem" data-list-action="collapse" @click="expandAll(false)">{{ t('unity.property.array.collapseAll') }}</button>
          <div v-if="!settings.hideAdd || !settings.hideRemove" class="ctx-separator" />
          <button v-if="!settings.hideAdd || !settings.hideRemove" class="ctx-item" role="menuitem" data-list-action="resize" :disabled="!canChange" @click="beginResize">{{ t('unity.property.array.setSize') }}</button>
        </template>
      </div>
    </BaseContextMenu>
  </div>
</template>

<style scoped>
.property-list-header.overridden :deep(.list-title) { font-weight: 600; }
.unity-property-list { min-width: 0; font-size: 12px; }
.unity-property-list.asset-drop { outline: 1px solid var(--accent-color); background: var(--accent-soft); }
.array-reference-form { width: 250px; display: grid; gap: 8px; padding: 8px; }
.array-toolbar, .array-item-row, .array-footer, .array-search { display: flex; align-items: center; gap: 4px; min-width: 0; }
.array-toolbar { min-height: 28px; border-bottom: 1px solid var(--border-color); }
.list-title { flex: 1; min-width: 0; text-align: left; justify-content: flex-start; color: var(--text-color); }
.list-title span, .array-item-toggle span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.array-count, .array-item-index, .array-pagination, .array-search-scope { color: var(--text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.array-count { white-space: nowrap; padding: 0 4px; }
.list-icon.base-button { min-width: 24px; width: 24px; min-height: 24px; padding: 0; flex-shrink: 0; border-color: transparent; }
.list-title.base-button, .array-item-toggle.base-button { padding: 0 4px; min-height: 28px; border-color: transparent; font: inherit; font-weight: 500; }
.list-icon.base-button:hover:not(:disabled), .list-title.base-button:hover, .array-item-toggle.base-button:hover { background: var(--hover-bg); border-color: var(--border-color); }
.base-button:focus-visible { outline: 1px solid var(--accent-color); outline-offset: -1px; }
.array-items { min-width: 0; }
.array-item { min-width: 0; border-bottom: 1px solid var(--border-color); }
.array-item:nth-child(even) { background: color-mix(in srgb, var(--sidebar-bg) 35%, transparent); }
.array-item-row { min-height: 30px; padding: 2px 0; }
.array-item-index { min-width: 16px; text-align: right; font-family: var(--font-mono-identifier); padding-right: 2px; }
.array-item-toggle { flex: 1; min-width: 0; justify-content: flex-start; text-align: left; color: var(--text-color); }
.array-item-content { flex: 1; min-width: 0; }
.array-item-body { padding: 6px 8px 10px 28px; border-top: 1px solid color-mix(in srgb, var(--border-color) 55%, transparent); }
.array-index-handle:not(:disabled) { cursor: grab; touch-action: none; }
.array-index-handle:active:not(:disabled) { cursor: grabbing; }
.array-item.dragging { background: var(--accent-soft); box-shadow: inset 0 1px var(--accent-color), inset 0 -1px var(--accent-color); }
.array-remove-button:not(:focus-visible), .array-item-menu:not(:focus-visible) { opacity: 0; }
.array-item-row:hover > .array-remove-button, .array-item-row:hover > .array-item-menu, .array-item-row:focus-within > .array-remove-button, .array-item-row:focus-within > .array-item-menu { opacity: 1; }
.array-remove-button.base-button:hover:not(:disabled) { color: var(--status-danger-fg); background: var(--status-danger-bg); border-color: var(--status-danger-border); }
.array-empty { padding: 9px 8px; color: var(--text-secondary); font-size: 11px; }
.array-footer { min-height: 28px; flex-wrap: wrap; }
.array-pagination { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.property-load-more.base-button { min-height: 24px; padding: 0 6px; font-size: 11px; border-color: transparent; }
.array-search { margin: 4px 0; padding-left: 6px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-secondary); background: var(--input-bg); }
.array-search input { width: 100%; min-width: 0; height: 26px; border: 0; outline: 0; background: transparent; color: var(--text-color); font: inherit; }
.array-search:focus-within { border-color: var(--accent-color); }
.array-error { color: var(--status-danger-fg); font-size: 11px; }
.array-size-form { padding: 8px; display: grid; gap: 8px; }
.array-size-form label { display: grid; gap: 6px; color: var(--text-color); font-size: 12px; }
.array-size-input { box-sizing: border-box; width: 100%; min-width: 0; height: 28px; padding: 0 6px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--input-bg); color: var(--text-color); font: inherit; }
.array-size-form p { margin: 0; font-size: 11px; color: var(--status-warn-fg); }
.array-size-form > div { display: flex; justify-content: flex-end; gap: 6px; }
</style>
