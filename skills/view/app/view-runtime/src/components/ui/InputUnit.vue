<script setup lang="ts">
import { computed, ref, useId } from "vue";

// Internal shared chrome: the unit is never part of the input's editable value.
defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{ unit?: string; disabled?: boolean; readonly?: boolean }>(), {
  unit: "", disabled: false, readonly: false,
});
const text = computed(() => props.unit.trim());
const unitId = `input-unit-${useId()}`;
const frame = ref<HTMLElement | null>(null);
function focusInput(event: PointerEvent) {
  event.preventDefault();
  if (!props.disabled) frame.value?.querySelector<HTMLInputElement>("input")?.focus();
}
</script>

<template>
  <span v-if="text" ref="frame" class="input-unit with-unit" :class="{ disabled, readonly }">
    <slot :unit-id="unitId" />
    <span :id="unitId" class="input-unit-suffix" :title="text" @pointerdown="focusInput">{{ text }}</span>
  </span>
  <slot v-else :unit-id="undefined" />
</template>

<style scoped>
.input-unit.with-unit {
  display: inline-flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  min-height: var(--unity-property-row-height, 26px);
  box-sizing: border-box;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--text-color);
}
.input-unit.with-unit:focus-within { border-color: var(--accent-color); }
.input-unit.with-unit :deep(input) {
  flex: 1 1 0%;
  width: 0;
  min-width: 0;
  min-height: 24px;
  padding-inline-end: 2px;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.input-unit.with-unit :deep(input:focus) { outline: none; }
.input-unit.with-unit.disabled, .input-unit.with-unit.readonly { opacity: 0.65; }
.input-unit.with-unit :deep(input:disabled), .input-unit.with-unit :deep(input:read-only) { opacity: 1; }
.input-unit-suffix {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 50%;
  margin-inline-end: var(--input-unit-end-padding, 7px);
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  line-height: 1.3;
  text-transform: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
  cursor: text;
}
.disabled > .input-unit-suffix { cursor: default; }
</style>
