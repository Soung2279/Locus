<script setup lang="ts">
import { ChevronRight } from "lucide";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import {
  createInspectorPropertyTreeBinding,
  createPropertyTree,
  resolveInspectorFieldPresentation,
  type InspectorFieldPresentationResolver,
  type InspectorPropertyFieldAction,
  type InspectorPropertyCommit,
  type InspectorPropertyDrawerInput,
  type InspectorManagedReferenceTypeOption,
  type InspectorProperty,
  type InspectorPropertySnapshot,
  type InspectorPropertyTreeBinding,
  type InspectorPropertyTreeBindingInput,
} from "../../services/propertyTree";
import PropertyField from "../property-field/PropertyField.vue";
import { propertyFieldAccess, type PropertyFieldAction } from "../property-field/propertyField";
import UnityPropertyDraw from "./UnityPropertyDraw.vue";
import UnityPropertyEditor from "./UnityPropertyEditor.vue";
import UnityPropertyList from "./UnityPropertyList.vue";
import { propertyFoldoutGroup, propertyIsVisible } from "./unityPropertyList";
import type {
  UnitySerializedPropertyCommitEvent,
  UnitySerializedPropertySnapshot,
} from "./unitySerializedValue";
import {
  UNITY_FLOAT_DRAG_STEP,
  constrainUnityNumberDragValue,
  constrainUnityNumberValue,
  formatUnityNumberValue,
  isUnityIntegerPropertyType,
  tryParseUnitySerializedEditValue,
} from "./unitySerializedValue";
import LucideIcon from "../icons/LucideIcon.vue";
import BaseDropdown, { type DropdownOption } from "../ui/BaseDropdown.vue";
import BaseButton from "../ui/BaseButton.vue";
import { t } from "../../i18n";

const props = withDefaults(defineProps<{
  property?: UnitySerializedPropertySnapshot | null;
  source?: InspectorPropertyTreeBindingInput | null;
  /**
   * Internal recursion input: reuse an InspectorProperty from the parent tree
   * instead of rebuilding a PropertyTree for every nesting level.
   */
  node?: InspectorProperty | null;
  disabled?: boolean;
  readonly?: boolean;
  compact?: boolean;
  hideRootObjectHeader?: boolean;
  propertyDrawers?: InspectorPropertyDrawerInput;
  fieldPresentation?: InspectorFieldPresentationResolver;
}>(), {
  property: null,
  source: null,
  node: null,
  disabled: false,
  readonly: false,
  compact: false,
  hideRootObjectHeader: false,
  propertyDrawers: undefined,
});

const emit = defineEmits<{
  fieldAction: [event: InspectorPropertyFieldAction];
  commit: [event: UnitySerializedPropertyCommitEvent];
  preview: [event: UnitySerializedPropertyCommitEvent];
}>();

const propertyTreeBinding = computed<InspectorPropertyTreeBinding>(() =>
  createInspectorPropertyTreeBinding({
    ...(props.source ?? {}),
    snapshots: props.source?.snapshots ?? props.property ?? null,
    disabled: props.disabled || props.source?.disabled === true,
    readonly: props.readonly || props.source?.readonly === true,
  }),
);
const rootSnapshot = computed<UnitySerializedPropertySnapshot | null>(() => {
  const snapshots = propertyTreeBinding.value.snapshots;
  if (Array.isArray(snapshots)) return (snapshots[0] as UnitySerializedPropertySnapshot | undefined) ?? null;
  return (snapshots as UnitySerializedPropertySnapshot | null) ?? null;
});
const tree = computed(() => {
  if (props.node) return null;
  return createPropertyTree(rootSnapshot.value, {
    id: propertyTreeBinding.value.id,
    targetId: propertyTreeBinding.value.targetId,
    disabled: propertyTreeBinding.value.disabled,
    readonly: propertyTreeBinding.value.readonly || !propertyTreeBinding.value.editable,
    propertyDrawers: props.propertyDrawers,
  });
});
const inspectorProperty = computed(() => props.node ?? tree.value?.rootProperty ?? null);
const children = computed(() => inspectorProperty.value?.children ?? []);
const propertyType = computed(() => inspectorProperty.value?.valueType || "String");
const field = computed(() => inspectorProperty.value ? resolveInspectorFieldPresentation(inspectorProperty.value, props.fieldPresentation) : {});
const fieldAccess = computed(() => propertyFieldAccess(field.value));
const canEdit = computed(() => inspectorProperty.value?.canEdit === true && fieldAccess.value.visible && !editorDisabled.value && !editorReadonly.value);
const editorDisabled = computed(() => propertyTreeBinding.value.disabled || fieldAccess.value.disabled);
const editorReadonly = computed(() => propertyTreeBinding.value.readonly || !propertyTreeBinding.value.editable || fieldAccess.value.readonly);
const fieldProps = computed(() => ({
  ...field.value, label: inspectorProperty.value?.label ?? "", showLabel: false,
  fieldKey: field.value.fieldKey || `${propertyTreeBinding.value.targetId}:${inspectorProperty.value?.propertyPath ?? ''}`,
  tooltip: inspectorProperty.value?.tooltip ?? "", disabled: editorDisabled.value, readonly: editorReadonly.value || inspectorProperty.value?.editable === false,
}));
function fieldAction(action: PropertyFieldAction) {
  const property = inspectorProperty.value;
  if (property) emit("fieldAction", { action, property, propertyPath: property.propertyPath, snapshot: property.snapshot });
}
const hasCustomDraw = computed(() => inspectorProperty.value?.hasPropertyDrawer() === true);
const listStateKey = computed(() => {
  const snapshot = inspectorProperty.value?.root.snapshot;
  const target = snapshot?.bindingTarget ?? snapshot?.target;
  return target || props.source?.targetId || props.source?.id
    ? `${props.source?.targetId || props.source?.id || ""}:${JSON.stringify(target ?? {})}:${inspectorProperty.value?.propertyPath}` : "";
});
const groupedChildren = computed(() => {
  const groups: { key: string; label: string; children: InspectorProperty[] }[] = [];
  for (const child of children.value.filter(propertyIsVisible)) {
    const label = propertyFoldoutGroup(child);
    const previous = groups[groups.length - 1];
    if (previous?.label === label) previous.children.push(child);
    else groups.push({ key: child.propertyPath, label, children: [child] });
  }
  return groups;
});
// hideRootObjectHeader always refers to this component instance's local root
// (inspectorProperty), so no depth check: with node-based recursion the local
// root keeps its depth from the original tree.
const hideObjectHeader = computed(() => {
  const property = inspectorProperty.value;
  return props.hideRootObjectHeader &&
    !field.value.actions?.length &&
    field.value.provenance?.state !== "overridden" &&
    !field.value.provenance?.hasOverriddenChildren &&
    !!property &&
    children.value.length > 0 &&
    !property.isArray &&
    !property.isManagedReference;
});
const hideLeafLabel = computed(() => props.hideRootObjectHeader && !!inspectorProperty.value);
const managedTypeQuery = ref("");
const selectedManagedType = computed(() => inspectorProperty.value?.managedReferenceFullTypename || "");
const selectedManagedTypeOption = computed(() => inspectorProperty.value?.selectedManagedReferenceType ?? null);
const loadingChildren = ref(false);
const childrenError = ref("");
async function loadChildren() {
  const property = inspectorProperty.value;
  if (!property || !propertyTreeBinding.value.loadChildren || loadingChildren.value) return;
  loadingChildren.value = true; childrenError.value = "";
  try { await propertyTreeBinding.value.loadChildren(property); }
  catch (error) { childrenError.value = error instanceof Error ? error.message : String(error); }
  finally { loadingChildren.value = false; }
}
const numberLabelDrag = shallowRef<{
  property: InspectorProperty;
  propertyPath: string;
  startX: number;
  startValue: number;
  latestValue: number;
  step: number;
  pointerId: number;
} | null>(null);
const numberLabelDragPreview = ref<{ propertyPath: string; value: number } | null>(null);
let numberLabelCommitFrame = 0;
let pendingNumberLabelCommit: { property: InspectorProperty; value: number } | null = null;
const managedTypeOptions = computed<InspectorManagedReferenceTypeOption[]>(() => {
  const property = inspectorProperty.value;
  if (!property) return [];
  const options = property.searchManagedReferenceTypes(managedTypeQuery.value, { limit: 80 });
  const selected = selectedManagedTypeOption.value;
  if (!selected || options.some((option) => option.value === selected.value)) return options;
  return managedTypeQuery.value.trim() ? [...options, selected] : [selected, ...options];
});
const managedTypeDropdownOptions = computed<DropdownOption[]>(() => [
  { value: "", label: t("unity.property.managedType.none") },
  ...managedTypeOptions.value.map((option) => ({
    value: option.value,
    label: option.label,
    labelStyle: { fontFamily: "var(--font-mono-identifier)" },
  })),
]);

watch(selectedManagedType, () => {
  managedTypeQuery.value = "";
});

watch(
  () => [inspectorProperty.value?.propertyPath, inspectorProperty.value?.value] as const,
  () => {
    if (!numberLabelDrag.value) numberLabelDragPreview.value = null;
  },
);

onBeforeUnmount(() => {
  stopNumberLabelDragListeners();
  if (numberLabelCommitFrame) {
    cancelAnimationFrame(numberLabelCommitFrame);
    numberLabelCommitFrame = 0;
  }
});

function propertyLabel(property: InspectorProperty): string {
  return property.label || property.propertyPath;
}

function childSnapshot(property: InspectorProperty): UnitySerializedPropertySnapshot {
  return property.snapshot as UnitySerializedPropertySnapshot;
}

function childSource(property: InspectorProperty): InspectorPropertyTreeBindingInput {
  const binding = propertyTreeBinding.value;
  return {
    id: binding.id,
    targetId: binding.targetId,
    snapshots: childSnapshot(property) as InspectorPropertySnapshot,
    loading: binding.loading,
    error: binding.error,
    disabled: binding.disabled,
    readonly: binding.readonly,
    editable: binding.editable,
    commit: binding.commit,
    loadChildren: binding.loadChildren,
  };
}

function leafBindingTarget(property: InspectorProperty) {
  const root = property.root.snapshot as UnitySerializedPropertySnapshot;
  const own = property.snapshot as UnitySerializedPropertySnapshot;
  const target = own.bindingTarget ?? own.target ?? root.bindingTarget ?? root.target ?? null;
  if (!target) return null;
  return { ...target, propertyPath: property.propertyPath };
}

function toUnityCommitEvent(
  commit: InspectorPropertyCommit,
  writeMode: UnitySerializedPropertyCommitEvent["writeMode"] = "commit",
): UnitySerializedPropertyCommitEvent {
  const target = (commit.snapshot as UnitySerializedPropertySnapshot).bindingTarget
    ?? (commit.snapshot as UnitySerializedPropertySnapshot).target
    ?? (commit.property.root.snapshot as UnitySerializedPropertySnapshot).bindingTarget
    ?? (commit.property.root.snapshot as UnitySerializedPropertySnapshot).target
    ?? null;
  return {
    propertyPath: commit.propertyPath,
    value: commit.value,
    property: commit.snapshot as UnitySerializedPropertySnapshot,
    target,
    writeMode,
  };
}

function canEditProperty(property: InspectorProperty): boolean {
  const access = propertyFieldAccess(resolveInspectorFieldPresentation(property, props.fieldPresentation));
  return property.canEdit && !editorDisabled.value && !editorReadonly.value && access.visible && !access.readonly && !access.disabled;
}

function commitProperty(property: InspectorProperty, value: unknown) {
  if (!canEditProperty(property)) return;
  const commit = property.createCommit(value);
  void Promise.resolve(propertyTreeBinding.value.commit(commit)).catch((error) => {
    console.warn("[UnitySerializedPropertyTree] commit handler failed:", error);
  });
  emit("commit", toUnityCommitEvent(commit));
}

function findTreeProperty(propertyPath: string): InspectorProperty | null {
  if (!propertyPath) return null;
  if (tree.value) return tree.value.getProperty(propertyPath);
  const root = inspectorProperty.value;
  if (!root) return null;
  if (root.propertyPath === propertyPath) return root;
  return root.descendants().find((child) => child.propertyPath === propertyPath) ?? null;
}

function commitDrawEvent(event: UnitySerializedPropertyCommitEvent) {
  // Strict path lookup: falling back to the local root would commit a child
  // value onto the wrong property when the event no longer matches the tree.
  const property = findTreeProperty(event.propertyPath)
    ?? findTreeProperty(event.property.propertyPath);
  if (!property) {
    console.warn("[UnitySerializedPropertyTree] dropped commit for unknown property path:", event.propertyPath);
    return;
  }
  commitProperty(property, event.value);
}

function emitCommit(property: InspectorProperty, value: unknown) {
  commitProperty(property, value);
}

function emitPreview(property: InspectorProperty, value: unknown) {
  if (!canEditProperty(property)) return;
  const commit = property.createCommit(value);
  emit("preview", toUnityCommitEvent(commit, "preview"));
}

function commitLeaf(value: unknown) {
  const property = inspectorProperty.value;
  if (!property) return;
  emitCommit(property, value);
}

function previewLeaf(value: unknown) {
  const property = inspectorProperty.value;
  if (!property) return;
  emitPreview(property, value);
}

function leafModelValue(property: InspectorProperty): unknown {
  const preview = numberLabelDragPreview.value;
  return preview?.propertyPath === property.propertyPath ? preview.value : property.value;
}

function canDragNumberLabel(property: InspectorProperty): boolean {
  return property.drawer.kind === "number" && canEditProperty(property);
}

function numberConstraints(property: InspectorProperty) {
  return {
    hasRange: property.hasRange,
    rangeMin: property.rangeMin,
    rangeMax: property.rangeMax,
  };
}

function numberValue(property: InspectorProperty, rawValue: unknown): number | null {
  const parsed = tryParseUnitySerializedEditValue(property.valueType, rawValue);
  if (!parsed.ok || typeof parsed.value !== "number") return null;
  return constrainUnityNumberValue(property.valueType, parsed.value, numberConstraints(property));
}

function numberDragStep(property: InspectorProperty, startValue: number): number {
  const isInteger = isUnityIntegerPropertyType(property.valueType);
  if (isInteger) return 1;
  if (property.numberStep > 0) return Math.max(UNITY_FLOAT_DRAG_STEP, property.numberStep);
  if (property.hasRange && Number.isFinite(property.rangeMin) && Number.isFinite(property.rangeMax)) {
    const range = Math.abs(property.rangeMax - property.rangeMin);
    if (range > 0) return Math.max(UNITY_FLOAT_DRAG_STEP, range / 200);
  }
  const magnitude = Math.abs(startValue);
  if (magnitude >= 1000) return 10;
  if (magnitude >= 100) return 1;
  if (magnitude >= 10) return 0.1;
  return UNITY_FLOAT_DRAG_STEP;
}

function numberDragValue(property: InspectorProperty, rawValue: number): number {
  return constrainUnityNumberDragValue(property.valueType, rawValue, numberConstraints(property));
}

function numberDragMultiplier(event: PointerEvent | KeyboardEvent): number {
  if (event.shiftKey) return 10;
  if (event.altKey || event.ctrlKey || event.metaKey) return 0.1;
  return 1;
}

function startNumberLabelDrag(property: InspectorProperty, event: PointerEvent) {
  if (event.button !== 0 || !canDragNumberLabel(property)) return;
  const startValue = numberValue(property, leafModelValue(property));
  if (startValue == null) return;
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget as HTMLElement | null;
  target?.setPointerCapture?.(event.pointerId);
  numberLabelDrag.value = {
    property,
    propertyPath: property.propertyPath,
    startX: event.clientX,
    startValue,
    latestValue: startValue,
    step: numberDragStep(property, startValue),
    pointerId: event.pointerId,
  };
  numberLabelDragPreview.value = { propertyPath: property.propertyPath, value: startValue };
  window.addEventListener("pointermove", handleNumberLabelDragMove);
  window.addEventListener("pointerup", stopNumberLabelDrag);
  window.addEventListener("pointercancel", stopNumberLabelDrag);
  window.addEventListener("keydown", handleNumberLabelDragKeydown, true);
}

function handleNumberLabelDragMove(event: PointerEvent) {
  const drag = numberLabelDrag.value;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  const delta = event.clientX - drag.startX;
  const rawValue = drag.startValue + delta * drag.step * numberDragMultiplier(event);
  const nextValue = numberDragValue(drag.property, rawValue);
  if (Object.is(nextValue, drag.latestValue)) return;
  drag.latestValue = nextValue;
  numberLabelDragPreview.value = { propertyPath: drag.propertyPath, value: nextValue };
  queueNumberLabelCommit(drag.property, nextValue);
}

function stopNumberLabelDrag() {
  const drag = numberLabelDrag.value;
  flushNumberLabelCommit();
  if (drag && !Object.is(drag.latestValue, drag.startValue)) {
    emitCommit(drag.property, drag.latestValue);
  }
  numberLabelDrag.value = null;
  stopNumberLabelDragListeners();
}

function cancelNumberLabelDrag() {
  const drag = numberLabelDrag.value;
  if (!drag) return;
  if (numberLabelCommitFrame) {
    cancelAnimationFrame(numberLabelCommitFrame);
    numberLabelCommitFrame = 0;
  }
  pendingNumberLabelCommit = null;
  numberLabelDrag.value = null;
  numberLabelDragPreview.value = null;
  if (!Object.is(drag.latestValue, drag.startValue)) {
    emitPreview(drag.property, drag.startValue);
  }
  stopNumberLabelDragListeners();
}

function handleNumberLabelDragKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !numberLabelDrag.value) return;
  event.preventDefault();
  event.stopPropagation();
  cancelNumberLabelDrag();
}

function stopNumberLabelDragListeners() {
  window.removeEventListener("pointermove", handleNumberLabelDragMove);
  window.removeEventListener("pointerup", stopNumberLabelDrag);
  window.removeEventListener("pointercancel", stopNumberLabelDrag);
  window.removeEventListener("keydown", handleNumberLabelDragKeydown, true);
}

function queueNumberLabelCommit(property: InspectorProperty, value: number) {
  pendingNumberLabelCommit = { property, value };
  if (numberLabelCommitFrame) return;
  numberLabelCommitFrame = requestAnimationFrame(() => {
    numberLabelCommitFrame = 0;
    flushNumberLabelCommit();
  });
}

function flushNumberLabelCommit() {
  if (numberLabelCommitFrame) {
    cancelAnimationFrame(numberLabelCommitFrame);
    numberLabelCommitFrame = 0;
  }
  const pending = pendingNumberLabelCommit;
  pendingNumberLabelCommit = null;
  if (!pending) return;
  emitPreview(pending.property, pending.value);
}

function nudgeNumberLabel(property: InspectorProperty, direction: 1 | -1, event: KeyboardEvent) {
  if (!canDragNumberLabel(property)) return;
  const currentValue = numberValue(property, leafModelValue(property));
  if (currentValue == null) return;
  event.preventDefault();
  const rawValue = currentValue + direction * numberDragStep(property, currentValue) * numberDragMultiplier(event);
  const nextValue = numberDragValue(property, rawValue);
  numberLabelDragPreview.value = { propertyPath: property.propertyPath, value: nextValue };
  emitCommit(property, nextValue);
}

function numberLabelTitle(property: InspectorProperty): string {
  const label = property.tooltip || property.propertyPath;
  if (!property.hasRange) return label;
  const min = formatUnityNumberValue(property.valueType, property.rangeMin, numberConstraints(property));
  const max = formatUnityNumberValue(property.valueType, property.rangeMax, numberConstraints(property));
  return `${label} (${min}..${max})`;
}

function updateManagedTypeQuery(event: Event) {
  managedTypeQuery.value = (event.target as HTMLInputElement | null)?.value || "";
}

function commitFirstManagedType() {
  const property = inspectorProperty.value;
  if (!canEdit.value || !property) return;
  const option = managedTypeOptions.value[0];
  if (option) emitCommit(property, property.createManagedReferenceTypeCommit(option).value);
}

function commitManagedType(value: string) {
  const property = inspectorProperty.value;
  if (!canEdit.value) return;
  if (!property) return;
  const option = property.managedReferenceTypes.find((item) => item.value === value) ?? value;
  emitCommit(property, property.createManagedReferenceTypeCommit(option).value);
}
</script>

<template>
  <div v-if="inspectorProperty && fieldAccess.visible && propertyIsVisible(inspectorProperty)" class="unity-property-tree" :class="{ compact }">
    <div v-if="inspectorProperty.header" class="property-header-label">
      {{ inspectorProperty.header }}
    </div>
    <UnityPropertyDraw
      v-if="hasCustomDraw"
      :property="inspectorProperty"
      :property-drawers="propertyDrawers"
      :field-presentation="fieldPresentation"
      @field-action="$emit('fieldAction', $event)"
      :disabled="editorDisabled"
      :readonly="editorReadonly"
      :compact="compact"
      @commit="commitDrawEvent"
    />

    <div v-else-if="inspectorProperty.isArray" class="property-container array-container">
        <UnityPropertyList :property="inspectorProperty" :editable="canEdit" :state-key="listStateKey"
          :field-presentation="fieldProps" @field-action="fieldAction"
          :load-children="propertyTreeBinding.loadChildren" @command="commitLeaf">
          <template #default="{ item }">
            <UnitySerializedPropertyTree :node="item" :source="childSource(item)"
              :disabled="editorDisabled" :readonly="editorReadonly" :property-drawers="propertyDrawers"
              :field-presentation="fieldPresentation" @field-action="$emit('fieldAction', $event)"
              hide-root-object-header compact @commit="$emit('commit', $event)" @preview="$emit('preview', $event)" />
          </template>
        </UnityPropertyList>
    </div>

    <div v-else-if="inspectorProperty.isManagedReference" class="property-container managed-reference-container">
      <PropertyField v-bind="fieldProps" class="property-chrome" @action="fieldAction">
      <div class="property-container-header" :title="inspectorProperty.tooltip || inspectorProperty.propertyPath">
        <span class="property-name">{{ propertyLabel(inspectorProperty) }}</span>
        <div class="managed-type-control">
          <input
            class="managed-type-search"
            type="search"
            :value="managedTypeQuery"
            :disabled="!canEdit"
            :readonly="editorReadonly"
            :placeholder="t('unity.property.managedType.search')"
            :title="inspectorProperty.managedReferenceFieldTypename || inspectorProperty.propertyPath"
            @input="updateManagedTypeQuery"
            @keydown.enter.prevent="commitFirstManagedType"
          />
          <BaseDropdown
            class="managed-type-select"
            :model-value="selectedManagedType"
            :options="managedTypeDropdownOptions"
            :disabled="!canEdit"
            :title="inspectorProperty.propertyPath"
            size="sm"
            menu-align="end"
            teleport
            :aria-label="inspectorProperty.propertyPath"
            @update:model-value="commitManagedType"
          />
        </div>
      </div>
      </PropertyField>
      <div v-if="children.length" class="property-children">
        <UnitySerializedPropertyTree
          v-for="child in children"
          :key="child.propertyPath"
          :node="child"
          :source="childSource(child)"
          :disabled="editorDisabled"
          :readonly="editorReadonly"
          :property-drawers="propertyDrawers"
          :field-presentation="fieldPresentation"
          @field-action="$emit('fieldAction', $event)"
          compact
          @commit="$emit('commit', $event)"
          @preview="$emit('preview', $event)"
        />
      </div>
    </div>

    <div
      v-else-if="children.length && inspectorProperty.drawer.container"
      class="property-container object-container"
      :class="{ 'hide-root-header': hideObjectHeader }"
    >
      <PropertyField v-if="!hideObjectHeader" v-bind="fieldProps" class="property-chrome" @action="fieldAction">
      <div
        class="property-container-header"
        :title="inspectorProperty.tooltip || inspectorProperty.propertyPath"
      >
        <span class="property-name">{{ propertyLabel(inspectorProperty) }}</span>
        <span class="property-type">{{ propertyType }}</span>
      </div>
      </PropertyField>
      <div class="property-children">
        <template v-for="group in groupedChildren" :key="group.key">
          <details v-if="group.label" class="property-foldout-group">
            <summary><LucideIcon :icon="ChevronRight" :size="13" />{{ group.label }}</summary>
            <div class="property-group-body">
              <UnitySerializedPropertyTree v-for="child in group.children" :key="child.propertyPath"
                :node="child" :source="childSource(child)" :disabled="editorDisabled" :readonly="editorReadonly"
                :property-drawers="propertyDrawers" :field-presentation="fieldPresentation" compact
                @field-action="$emit('fieldAction', $event)" @commit="$emit('commit', $event)" @preview="$emit('preview', $event)" />
            </div>
          </details>
          <template v-else>
            <UnitySerializedPropertyTree v-for="child in group.children" :key="child.propertyPath"
              :node="child" :source="childSource(child)" :disabled="editorDisabled" :readonly="editorReadonly"
              :property-drawers="propertyDrawers" :field-presentation="fieldPresentation" compact
              @field-action="$emit('fieldAction', $event)" @commit="$emit('commit', $event)" @preview="$emit('preview', $event)" />
          </template>
        </template>
      </div>
    </div>

    <PropertyField v-else v-bind="fieldProps" class="property-chrome" @action="fieldAction">
    <div class="property-leaf" :class="{ 'hide-leaf-label': hideLeafLabel }" :title="numberLabelTitle(inspectorProperty)">
      <button
        v-if="!hideLeafLabel && canDragNumberLabel(inspectorProperty)"
        type="button"
        class="property-name property-name-drag"
        :class="{ dragging: numberLabelDrag?.propertyPath === inspectorProperty.propertyPath }"
        :title="numberLabelTitle(inspectorProperty)"
        @pointerdown="startNumberLabelDrag(inspectorProperty, $event)"
        @keydown.arrow-left="nudgeNumberLabel(inspectorProperty, -1, $event)"
        @keydown.arrow-right="nudgeNumberLabel(inspectorProperty, 1, $event)"
      >{{ propertyLabel(inspectorProperty) }}</button>
      <span v-else-if="!hideLeafLabel" class="property-name">{{ propertyLabel(inspectorProperty) }}</span>
      <UnityPropertyEditor
        :model-value="leafModelValue(inspectorProperty)"
        :property-type="propertyType"
        :display-value="inspectorProperty.displayValue || ''"
        :editable="inspectorProperty.editable !== false"
        :disabled="editorDisabled"
        :readonly="editorReadonly"
        :enum-options="inspectorProperty.enumOptions"
        :is-flags-enum="inspectorProperty.isFlagsEnum"
        :enum-value-index="inspectorProperty.enumValueIndex"
        :enum-value-flag="inspectorProperty.enumValueFlag"
        :title="inspectorProperty.propertyPath"
        :tooltip="inspectorProperty.tooltip"
        :unit="inspectorProperty.unit"
        :has-range="inspectorProperty.hasRange"
        :range-min="inspectorProperty.rangeMin"
        :range-max="inspectorProperty.rangeMax"
        :number-step="inspectorProperty.numberStep"
        :multiline="inspectorProperty.multiline"
        :min-lines="inspectorProperty.minLines"
        :max-lines="inspectorProperty.maxLines"
        :reference-type-full-name="inspectorProperty.referenceTypeFullName"
        :reference-type-assembly="inspectorProperty.referenceTypeAssembly"
        :binding-target="leafBindingTarget(inspectorProperty)"
        @preview="previewLeaf"
        @commit="commitLeaf"
      />
    </div>
    </PropertyField>
    <div v-if="inspectorProperty.snapshot.childrenTruncated && !inspectorProperty.isArray" class="property-continuation">
      <BaseButton v-if="propertyTreeBinding.loadChildren" class="property-load-more" :disabled="loadingChildren" @click="loadChildren">
        {{ loadingChildren ? t('common.loading') : t('common.loadMore') }}
      </BaseButton>
      <span v-else>{{ t('common.truncated') }}</span>
      <span v-if="childrenError" role="alert">{{ childrenError }}</span>
    </div>
  </div>
</template>

<style scoped>
.unity-property-tree {
  --unity-property-row-height: 26px;
  width: 100%;
  min-width: 0;
  display: grid;
  gap: 6px;
  font-size: 12px;
}

.property-container {
  min-width: 0;
  display: grid;
  gap: 6px;
}

.property-header-label {
  min-width: 0;
  padding: 4px 0 2px;
  color: var(--text-color);
  font-size: 12px;
  font-weight: 600;
}

.property-container-header,
.property-leaf {
  min-width: 0;
  min-height: var(--unity-property-row-height);
  display: grid;
  grid-template-columns: var(--unity-property-columns, minmax(84px, 0.42fr) minmax(0, 1fr));
  align-items: center;
  gap: 8px;
}

.unity-property-tree.compact {
  --unity-property-columns: minmax(72px, 0.34fr) minmax(0, 1fr);
}

.property-chrome.overridden :deep(.property-name) { font-weight: 600; }

.property-name,
.property-type {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.property-name {
  color: var(--text-color);
}

.property-type {
  color: var(--text-secondary);
}

.property-name-drag {
  width: 100%;
  min-height: var(--unity-property-row-height);
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  text-align: left;
  cursor: ew-resize;
  user-select: none;
}

.property-name-drag:hover,
.property-name-drag:focus-visible,
.property-name-drag.dragging {
  color: var(--text-color);
}

.property-name-drag:focus-visible {
  outline: 1px solid var(--accent-color);
  outline-offset: 2px;
}

.property-type {
  font-family: var(--font-mono-identifier);
  font-size: 11px;
}

.property-children {
  min-width: 0;
  display: grid;
  gap: 6px;
  padding-left: 10px;
  border-left: 1px solid var(--border-color);
}

.object-container.hide-root-header {
  gap: 0;
}

.object-container.hide-root-header > .property-children {
  padding-left: 0;
  border-left: 0;
}

.managed-type-control {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(96px, 0.34fr) minmax(0, 1fr);
  gap: 6px;
}

.managed-type-search {
  width: 100%;
  min-width: 0;
  min-height: 26px;
  padding: 0 7px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--text-color);
  font: inherit;
  box-sizing: border-box;
}

.managed-type-select {
  width: 100%;
  min-width: 0;
}

.managed-type-select :deep(.base-dropdown-trigger) {
  min-width: 0;
  min-height: 26px;
  padding: 0 7px;
  background: var(--input-bg);
  font: inherit;
  font-family: var(--font-mono-identifier);
}

.property-leaf.hide-leaf-label {
  grid-template-columns: minmax(0, 1fr);
}

.managed-type-search {
  font-family: var(--font-mono-identifier);
}

.managed-type-search:focus {
  outline: none;
  border-color: var(--accent-color);
}

button {
  min-height: 24px;
  padding: 0 7px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: color-mix(in srgb, var(--panel-bg) 72%, var(--sidebar-bg) 28%);
  color: var(--text-color);
  font: inherit;
  font-size: 11px;
}

button:focus-visible {
  outline: 1px solid var(--accent-color);
  outline-offset: 2px;
}

button:disabled,
.managed-type-search:disabled {
  opacity: 0.58;
}

button.property-name-drag {
  min-height: var(--unity-property-row-height);
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  font-size: inherit;
}
.property-foldout-group { min-width: 0; }
.property-foldout-group > summary { display: flex; align-items: center; gap: 4px; min-height: 26px; cursor: pointer; color: var(--text-secondary); list-style: none; }
.property-foldout-group > summary::-webkit-details-marker { display: none; }
.property-foldout-group[open] > summary svg { transform: rotate(90deg); }
.property-foldout-group > summary:focus-visible { outline: 1px solid var(--accent-color); outline-offset: -1px; }
.property-group-body { display: grid; gap: 6px; padding: 4px 0 4px 12px; border-left: 1px solid var(--border-color); }
</style>
