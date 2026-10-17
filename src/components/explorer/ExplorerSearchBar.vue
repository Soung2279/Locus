<script setup lang="ts">
import { computed, nextTick, ref, toRef } from "vue";
import { LoaderCircle, Search, X } from "lucide";
import { t } from "../../i18n";
import { formatShortcut, useKeyboardShortcuts } from "../../composables/useKeyboardShortcuts";
import { isSearchScopeVisible, useSearchScope } from "../../composables/useSearchScope";
import BaseButton from "../ui/BaseButton.vue";
import LucideIcon from "../icons/LucideIcon.vue";

const props = defineProps<{
  scope: HTMLElement | null;
  query: string;
  searching: boolean;
  placeholder: string;
  active?: boolean;
}>();
const emit = defineEmits<{
  "update:query": [value: string];
  clear: [];
}>();
const visible = ref(false);
const input = ref<HTMLInputElement | null>(null);
const composing = ref(false);
const { state: shortcuts } = useKeyboardShortcuts();
const shortcutLabel = computed(() => formatShortcut(shortcuts.findInContext));
let previousFocus: HTMLElement | null = null;

async function open() {
  if (!visible.value) {
    const active = props.scope?.ownerDocument.activeElement as HTMLElement | null;
    previousFocus = props.scope?.contains(active) ? active : props.scope;
  }
  visible.value = true;
  await nextTick();
  input.value?.focus({ preventScroll: true });
  input.value?.select();
}

async function close() {
  visible.value = false;
  composing.value = false;
  emit("clear");
  await nextTick();
  const target = previousFocus && isSearchScopeVisible(previousFocus) ? previousFocus : props.scope;
  target?.focus({ preventScroll: true });
}

function keydown(event: KeyboardEvent) {
  if (event.isComposing || composing.value || event.keyCode === 229 || event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  void close();
}

// Register the whole list even while the search bar is absent from the layout.
useSearchScope(toRef(props, "scope"), () => { void open(); }, { enabled: () => props.active !== false });
</script>

<template>
  <div v-if="visible" class="explorer-search-wrap" role="search" :aria-label="placeholder" @keydown="keydown">
    <div class="explorer-search-bar">
      <LucideIcon :icon="searching ? LoaderCircle : Search" :size="16" class="explorer-search-icon" :class="{ spinning: searching }" />
      <input
        ref="input"
        class="explorer-search-input"
        type="text"
        :value="query"
        :placeholder="placeholder"
        :aria-label="placeholder"
        autocomplete="off"
        spellcheck="false"
        @compositionstart="composing = true"
        @compositionend="composing = false; emit('update:query', ($event.target as HTMLInputElement).value)"
        @input="!composing && emit('update:query', ($event.target as HTMLInputElement).value)"
      />
      <span v-if="!query" class="explorer-search-shortcut">{{ shortcutLabel }}</span>
      <BaseButton class="explorer-search-close" :title="t('globalSearch.close')" :aria-label="t('globalSearch.close')" @click="close">
        <LucideIcon :icon="X" :size="14" />
      </BaseButton>
    </div>
  </div>
</template>

<style scoped>
.explorer-search-wrap {
  padding: var(--explorer-search-padding, 8px 14px);
  border-bottom: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--panel-bg) 82%, var(--bg-color));
  flex-shrink: 0;
}

.explorer-search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--explorer-search-height, 32px);
  padding: 0 9px 0 10px;
  background: color-mix(in srgb, var(--panel-bg) 74%, var(--input-bg, var(--hover-bg)) 26%);
  border: 1px solid var(--border-color);
  border-radius: var(--explorer-search-radius, 7px);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.explorer-search-bar:hover {
  border-color: color-mix(in srgb, var(--text-secondary) 50%, var(--border-color));
}

.explorer-search-bar:focus-within {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-color) 14%, transparent);
}

.explorer-search-icon {
  flex-shrink: 0;
  color: var(--text-secondary);
}

.explorer-search-icon.spinning {
  animation: explorer-search-spin 0.9s linear infinite;
}

@keyframes explorer-search-spin {
  to { transform: rotate(360deg); }
}

.explorer-search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-color);
  font-family: inherit;
  font-size: var(--explorer-search-font-size, 12px);
}

.explorer-search-input::placeholder {
  color: var(--text-secondary);
  opacity: 0.7;
}

.explorer-search-shortcut {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: color-mix(in srgb, var(--panel-bg) 84%, var(--bg-color));
  color: var(--text-secondary);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.02em;
}

.explorer-search-close {
  flex-shrink: 0;
  width: 20px;
  min-height: 20px;
  padding: 0;
  border-color: transparent;
  border-radius: 4px;
}

.explorer-search-close:focus-visible {
  border-color: var(--border-strong);
  background: var(--hover-bg);
  color: var(--text-color);
}
</style>
