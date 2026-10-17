<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import { ArrowDown, ArrowUp, Search, X } from "lucide";
import { t } from "../../i18n";
import BaseButton from "./BaseButton.vue";
import LucideIcon from "../icons/LucideIcon.vue";

defineProps<{ query: string; count: number; current: number; placeholder?: string }>();
const emit = defineEmits<{
  "update:query": [value: string]; next: []; previous: []; close: [];
}>();
const input = ref<HTMLInputElement | null>(null);
const composing = ref(false);
function focus() { input.value?.focus({ preventScroll: true }); input.value?.select(); }
function keydown(event: KeyboardEvent) {
  if (event.isComposing || composing.value || event.keyCode === 229) return;
  if (event.key === "Escape" || event.key === "Enter" || event.key === "F3") {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") emit("close");
    else if (event.shiftKey) emit("previous");
    else emit("next");
  }
}
onMounted(() => { void nextTick(focus); });
defineExpose({ focus });
</script>

<template>
  <div class="find-bar" role="search" :aria-label="t('search.context')" @keydown="keydown">
    <LucideIcon :icon="Search" :size="14" class="find-bar-icon" />
    <input ref="input" main-field class="find-bar-input" :value="query"
      :placeholder="placeholder || t('search.documentPlaceholder')" :aria-label="placeholder || t('search.documentPlaceholder')"
      autocomplete="off" spellcheck="false"
      @compositionstart="composing = true"
      @compositionend="composing = false; emit('update:query', ($event.target as HTMLInputElement).value)"
      @input="!composing && emit('update:query', ($event.target as HTMLInputElement).value)" />
    <span class="find-bar-count" role="status" aria-live="polite">{{ query ? `${current}/${count}` : '' }}</span>
    <BaseButton class="find-bar-button" :disabled="!count" :title="t('search.previous')" :aria-label="t('search.previous')" @click="emit('previous')"><LucideIcon :icon="ArrowUp" :size="14" /></BaseButton>
    <BaseButton class="find-bar-button" :disabled="!count" :title="t('search.next')" :aria-label="t('search.next')" @click="emit('next')"><LucideIcon :icon="ArrowDown" :size="14" /></BaseButton>
    <BaseButton class="find-bar-button" :title="t('globalSearch.close')" :aria-label="t('globalSearch.close')" @click="emit('close')"><LucideIcon :icon="X" :size="14" /></BaseButton>
  </div>
</template>

<style scoped>
.find-bar { display: flex; align-items: center; flex-shrink: 0; gap: 2px; min-width: 0; min-height: 34px; padding: 3px 6px; border-bottom: 1px solid var(--border-color); background: var(--panel-bg); color: var(--text-color); font-family: var(--font-ui); font-size: 12px; }
.find-bar-icon { flex-shrink: 0; margin-right: 4px; color: var(--text-secondary); }
.find-bar-input { flex: 1; width: 0; min-width: 24px; height: 26px; padding: 2px 4px; border: 1px solid transparent; border-radius: 4px; outline: none; background: transparent; color: var(--text-color); font: inherit; }
.find-bar-input:focus { border-color: var(--border-strong); background: var(--bg-color); }
.find-bar-input::placeholder, .find-bar-count { color: var(--text-secondary); }
.find-bar-count { flex-shrink: 0; padding: 0 4px; font-size: 11px; font-variant-numeric: tabular-nums; }
.find-bar-button { flex-shrink: 0; width: 26px; min-height: 26px; padding: 0; border-color: transparent; }
</style>
