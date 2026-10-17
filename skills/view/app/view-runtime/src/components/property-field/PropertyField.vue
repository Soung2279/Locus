<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue";
import { Ellipsis, RotateCcw, ExternalLink, Plus, ArrowUpToLine } from "lucide";
import BaseButton from "../ui/BaseButton.vue";
import BaseContextMenu from "../ui/BaseContextMenu.vue";
import LucideIcon from "../icons/LucideIcon.vue";
import { t } from "../../i18n";
import { useWindowSurface } from "../../composables/useWindowSurface";
import {
  propertyFieldAccess, propertyFieldActions, propertyFieldActionDisabled,
  type PropertyFieldAction, type PropertyFieldPresentation,
} from "./propertyField";

const props = withDefaults(defineProps<PropertyFieldPresentation & {
  label?: string;
  showLabel?: boolean;
  tooltip?: string;
}>(), { label: "", fieldKey: "", showLabel: true, tooltip: "" });
const emit = defineEmits<{ action: [action: PropertyFieldAction] }>();
const { ownerDocument } = useWindowSurface();
const root = ref<HTMLElement | null>(null);
const menuContent = ref<HTMLElement | null>(null);
const menu = ref<{ x: number; y: number } | null>(null);
let returnFocus: HTMLElement | null = null;
const descriptionId = `property-field-${useId()}`;
const access = computed(() => propertyFieldAccess(props));
const actions = computed(() => propertyFieldActions(props));
const quickAction = computed(() => actions.value.find(action => action.quick));
const quickIcon = computed(() => {
  switch (quickAction.value?.kind) {
    case "inspect-source": return ExternalLink;
    case "create-override": return Plus;
    case "apply-to-template": return ArrowUpToLine;
    case "revert": case "reset-default": return RotateCcw;
    default: return Ellipsis;
  }
});
const state = computed(() => props.provenance?.state ?? "local");
const description = computed(() => {
  const parts = [props.tooltip];
  if (props.scope === "template-only") parts.push(t("propertyField.templateOnly"));
  if (props.scope === "instance-only") parts.push(t("propertyField.instanceOnly"));
  if (state.value !== "local") parts.push(t(`propertyField.${state.value}`));
  if (props.provenance?.hasOverriddenChildren) parts.push(t("propertyField.childrenOverridden"));
  if (props.provenance?.sourceLabel) parts.push(t("propertyField.source", props.provenance.sourceLabel));
  if (props.provenance?.inheritedDisplayValue != null) parts.push(t("propertyField.inheritedValue", props.provenance.inheritedDisplayValue));
  return parts.filter(Boolean).join("\n");
});

function ownsEvent(event: Event): boolean {
  return (event.target as Element | null)?.closest?.(".property-field") === root.value;
}
function closeMenu(restoreFocus = true) {
  menu.value = null;
  if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}
async function openMenu(event: MouseEvent | KeyboardEvent) {
  if (!actions.value.length || !ownsEvent(event)) return;
  event.preventDefault(); event.stopPropagation();
  returnFocus = ownerDocument.activeElement as HTMLElement | null;
  const bounds = root.value!.getBoundingClientRect();
  const mouse = event as MouseEvent;
  menu.value = event.type === "contextmenu" && (mouse.clientX || mouse.clientY)
    ? { x: mouse.clientX, y: mouse.clientY }
    : { x: bounds.left, y: bounds.bottom };
  await nextTick();
  menuContent.value?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}
function onFieldKeydown(event: KeyboardEvent) {
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) void openMenu(event);
}
function onMenuKeydown(event: KeyboardEvent) {
  if (event.key === "Tab") { closeMenu(); return; }
  const buttons = Array.from(menuContent.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
  if (!buttons.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  const index = buttons.indexOf(ownerDocument.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}
function invoke(id: string) {
  // Revalidate current capabilities: the selection or permissions may have changed while open.
  const action = actions.value.find(item => item.id === id);
  if (!action || propertyFieldActionDisabled(action, props)) return;
  closeMenu();
  emit("action", action);
}
watch(() => props.fieldKey, () => closeMenu(false));
watch(() => [access.value.visible, actions.value.length] as const, ([visible, count]) => {
  if (!visible || !count) closeMenu(false);
});
</script>

<template>
  <div v-if="access.visible" ref="root" class="property-field"
    :class="{ overridden: state === 'overridden', 'children-overridden': provenance?.hasOverriddenChildren }"
    :data-field-state="state" :data-field-scope="scope" :data-field-key="fieldKey || undefined"
    role="group" :aria-label="label || undefined" :aria-describedby="description ? descriptionId : undefined"
    :aria-busy="busy || undefined" :title="description || undefined"
    @contextmenu="openMenu" @keydown="onFieldKeydown">
    <span v-if="description" :id="descriptionId" class="property-field-description">{{ description }}</span>
    <div class="property-field-line">
      <div class="property-field-content" :class="{ labelled: showLabel }">
        <div v-if="showLabel" class="property-field-label"><slot name="label">{{ label }}</slot></div>
        <div class="property-field-editor"><slot :readonly="access.readonly" :disabled="access.disabled" /></div>
      </div>
      <div v-if="actions.length" class="property-field-actions">
        <BaseButton v-if="quickAction" class="property-field-icon" size="sm"
          :disabled="propertyFieldActionDisabled(quickAction, props)"
          :title="quickAction.disabledReason || quickAction.tooltip || quickAction.label" :aria-label="quickAction.label"
          @click.stop="invoke(quickAction.id)">
          <LucideIcon :icon="quickIcon" :size="13" />
        </BaseButton>
        <BaseButton class="property-field-icon" size="sm" :title="t('propertyField.actions')"
          :aria-label="t('propertyField.actionsFor', label)" aria-haspopup="menu" :aria-expanded="!!menu"
          @click="openMenu"><LucideIcon :icon="Ellipsis" :size="14" /></BaseButton>
      </div>
    </div>
    <slot name="children" />
    <BaseContextMenu v-if="menu" :x="menu.x" :y="menu.y" :aria-label="t('propertyField.actionsFor', label)" @close="closeMenu()">
      <div ref="menuContent" @keydown="onMenuKeydown">
        <div v-if="description" class="property-field-menu-description">{{ description }}</div>
        <template v-for="(action, index) in actions" :key="action.id">
          <div v-if="index && action.group !== actions[index - 1]?.group" class="ctx-separator" role="separator" />
          <button type="button" role="menuitem" :data-field-action="action.id"
            :disabled="propertyFieldActionDisabled(action, props)"
            :title="action.disabledReason || action.tooltip || undefined" @click="invoke(action.id)">{{ action.label }}</button>
        </template>
      </div>
    </BaseContextMenu>
  </div>
</template>

<style scoped>
.property-field { min-width: 0; position: relative; }
.property-field-line { position: relative; display: flex; align-items: center; gap: 4px; min-width: 0; padding-inline-start: 6px; }
.property-field-line::before { content: ""; position: absolute; inset-inline-start: 0; top: 3px; bottom: 3px; width: 2px; background: transparent; }
.children-overridden > .property-field-line::before { background: color-mix(in srgb, var(--property-override-color, var(--accent-color)) 35%, transparent); }
.overridden > .property-field-line::before { background: var(--property-override-color, var(--accent-color)); }
.property-field-content { flex: 1; min-width: 0; }
.property-field-content.labelled { display: grid; grid-template-columns: var(--property-field-label-width, minmax(84px, 0.42fr)) minmax(0, 1fr); align-items: center; gap: 8px; }
.property-field-label { min-width: 0; color: var(--text-color); overflow-wrap: anywhere; }
.overridden > .property-field-line > .property-field-content > .property-field-label { font-weight: 600; }
.property-field-editor { min-width: 0; }
.property-field-actions { display: flex; align-items: center; flex-shrink: 0; opacity: 0; pointer-events: none; }
.property-field-line:hover > .property-field-actions,
.property-field-line:focus-within > .property-field-actions { opacity: 1; pointer-events: auto; }
.property-field-icon.base-button { min-height: 24px; width: 24px; padding: 0; border-color: transparent; border-radius: 4px; }
.property-field-icon.base-button:hover:not(:disabled), .property-field-icon.base-button:focus-visible { border-color: var(--border-color); background: var(--hover-bg); }
.property-field-icon.base-button:focus-visible { outline: 1px solid var(--accent-color); outline-offset: -1px; }
.property-field-description { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.property-field-menu-description { padding: 4px 10px 7px; color: var(--text-secondary); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 360px; }
</style>
