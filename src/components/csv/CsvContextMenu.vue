<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, useId, watch } from "vue";
import { ChevronRight } from "lucide";
import { t } from "../../i18n";
import LucideIcon from "../icons/LucideIcon.vue";
import BaseContextMenu from "../ui/BaseContextMenu.vue";

export interface CsvMenuCommand {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action: () => unknown;
}
export interface CsvMenuSeparator { separator: true }
export interface CsvMenuGroup {
  label: string;
  disabled?: boolean;
  children: Array<CsvMenuCommand | CsvMenuSeparator>;
}
export type CsvMenuEntry = CsvMenuCommand | CsvMenuSeparator | CsvMenuGroup;

const props = defineProps<{ x: number; y: number; items: CsvMenuEntry[] }>();
const emit = defineEmits<{ close: []; action: [action: () => unknown] }>();
const menuId = useId();
const submenuId = `${menuId}-submenu`;
const submenu = shallowRef<{ index: number; x: number; y: number; trigger: HTMLButtonElement } | null>(null);
const group = computed(() => {
  const item = submenu.value && props.items[submenu.value.index];
  return item && "children" in item ? item : null;
});
let closeTimer: ReturnType<typeof setTimeout> | undefined;

function cancelClose(): void {
  clearTimeout(closeTimer);
  closeTimer = undefined;
}
function closeSubmenu(restoreFocus = false): void {
  cancelClose();
  const trigger = submenu.value?.trigger;
  submenu.value = null;
  if (restoreFocus) trigger?.focus();
}
function scheduleClose(): void {
  cancelClose();
  closeTimer = setTimeout(() => closeSubmenu(), 180);
}
function disabled(item: CsvMenuCommand | CsvMenuGroup): boolean {
  return !!item.disabled || "children" in item && item.children.every((child) => "separator" in child || child.disabled);
}
function buttons(id: string): HTMLButtonElement[] {
  return Array.from(document.getElementById(id)?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
}
async function openSubmenu(index: number, trigger: HTMLButtonElement, focus = false): Promise<void> {
  cancelClose();
  const item = props.items[index];
  if (!item || !("children" in item) || disabled(item)) { closeSubmenu(); return; }
  const parent = document.getElementById(menuId)?.getBoundingClientRect();
  if (!parent) return;
  const rect = trigger.getBoundingClientRect();
  const current = { index, trigger, x: parent.right - 1, y: rect.top - 6 };
  submenu.value = current;
  await nextTick();
  if (submenu.value !== current) return;
  const width = document.getElementById(submenuId)?.offsetWidth ?? 0;
  if (parent.right + width > window.innerWidth - 8) {
    submenu.value = { ...current, x: parent.left - width + 1 };
  }
  if (focus) buttons(submenuId)[0]?.focus();
}
function hoverItem(index: number, event: MouseEvent): void {
  const item = props.items[index];
  if (item && "children" in item) void openSubmenu(index, event.currentTarget as HTMLButtonElement);
  else closeSubmenu();
}
function activate(item: CsvMenuCommand | CsvMenuGroup, index: number, event: MouseEvent): void {
  if (disabled(item)) return;
  if ("children" in item) void openSubmenu(index, event.currentTarget as HTMLButtonElement, true);
  else emit("action", item.action);
}
function navigate(event: KeyboardEvent, nested = false): void {
  if (event.key === "Tab") { event.preventDefault(); emit("close"); return; }
  if (nested && event.key === "ArrowLeft") {
    event.preventDefault(); closeSubmenu(true); return;
  }
  const target = event.target as HTMLButtonElement;
  if (!nested && event.key === "ArrowRight") {
    const index = Number(target.dataset.menuIndex);
    if (Number.isInteger(index)) { event.preventDefault(); void openSubmenu(index, target, true); }
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const entries = buttons(nested ? submenuId : menuId);
  const index = entries.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
    : (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
  if (!nested) closeSubmenu();
  entries[next]?.focus();
}

watch(() => [props.x, props.y], () => closeSubmenu());
onMounted(async () => { await nextTick(); buttons(menuId)[0]?.focus(); });
onBeforeUnmount(cancelClose);
</script>

<template>
  <BaseContextMenu :id="menuId" class="csv-context-menu" :x="x" :y="y" :aria-label="t('editor.contextMenu')"
    @close="emit('close')" @keydown="navigate($event)" @mouseleave="scheduleClose" @mouseenter="cancelClose" @scroll="closeSubmenu()">
    <template v-for="(item, index) in items" :key="index">
      <div v-if="'separator' in item" class="base-context-menu-separator" role="separator" />
      <button v-else type="button" role="menuitem" :disabled="disabled(item)" :data-menu-index="index"
        :aria-haspopup="'children' in item ? 'menu' : undefined"
        :aria-expanded="'children' in item ? submenu?.index === index : undefined"
        :aria-controls="submenu?.index === index ? submenuId : undefined"
        :class="{ 'csv-menu-expanded': submenu?.index === index }"
        @mouseenter="hoverItem(index, $event)" @click="activate(item, index, $event)"
        @focus="submenu?.index !== index && closeSubmenu()">
        <span>{{ item.label }}</span>
        <LucideIcon v-if="'children' in item" class="csv-menu-chevron" :icon="ChevronRight" :size="13" />
        <span v-else-if="item.shortcut" class="csv-menu-shortcut">{{ item.shortcut }}</span>
      </button>
    </template>
  </BaseContextMenu>
  <BaseContextMenu v-if="submenu && group" :id="submenuId" class="csv-context-submenu"
    :x="submenu.x" :y="submenu.y" :z-index="10001" :show-backdrop="false" :aria-label="group.label"
    @close="emit('close')" @keydown="navigate($event, true)" @mouseenter="cancelClose" @mouseleave="scheduleClose">
    <template v-for="(item, index) in group.children" :key="index">
      <div v-if="'separator' in item" class="base-context-menu-separator" role="separator" />
      <button v-else type="button" role="menuitem" :disabled="disabled(group) || item.disabled" @click="emit('action', item.action)">
        <span>{{ item.label }}</span><span v-if="item.shortcut" class="csv-menu-shortcut">{{ item.shortcut }}</span>
      </button>
    </template>
  </BaseContextMenu>
</template>

<style scoped>
.csv-menu-shortcut { margin-left: auto; padding-left: 24px; color: var(--text-secondary); font-size: 11px; }
.csv-menu-chevron { margin-left: auto; color: var(--text-secondary); }
.csv-context-menu button.csv-menu-expanded { background: var(--hover-bg); }
</style>
