<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { FileText, Image } from "lucide";
import BaseButton from "../BaseButton.vue";
import LucideIcon from "../../icons/LucideIcon.vue";
import { isMarkdownMentionImage, type MarkdownMentionResource } from "./markdownMentionResources";

const props = defineProps<{
  id: string;
  entries: MarkdownMentionResource[];
  selected: number;
  loading: boolean;
  pending: boolean;
  error: string;
}>();
const emit = defineEmits<{ select: [index: number]; highlight: [index: number] }>();
const list = ref<HTMLElement | null>(null);
watch(() => props.selected, () => {
  void nextTick(() => list.value?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }));
});
</script>

<template>
  <div class="md-mention-list" @mousedown.prevent>
    <div v-if="error || loading || pending || !entries.length" class="md-mention-status" role="status">
      {{ error || (pending ? '插入中…' : loading ? '搜索中…' : '没有匹配资源') }}
    </div>
    <div :id="id" ref="list" class="md-mention-results" role="listbox" aria-label="引用资源" :aria-busy="loading || pending">
      <BaseButton
        v-for="(entry, index) in entries" :id="`${id}-${index}`" :key="entry.relPath"
        class="md-mention-option" :class="{ 'is-highlighted': selected === index }"
        role="option" :aria-selected="selected === index" :title="entry.relPath" :disabled="pending"
        @click="emit('select', index)" @focus="emit('highlight', index)"
      >
        <LucideIcon :icon="isMarkdownMentionImage(entry.relPath) ? Image : FileText" :size="16" />
        <span class="md-mention-copy"><span>{{ entry.name }}</span><small>{{ entry.relPath }}</small></span>
      </BaseButton>
    </div>
  </div>
</template>

<style scoped>
.md-mention-list { display: flex; flex-direction: column; min-height: 0; max-height: inherit; font-family: var(--font-ui); font-size: 12px; }
.md-mention-results { min-height: 0; overflow: auto; overscroll-behavior: contain; }
.md-mention-option.base-button { width: 100%; justify-content: flex-start; height: 46px; padding: 6px 8px; border-color: transparent; gap: 8px; color: var(--text-secondary); }
.md-mention-option.base-button:hover, .md-mention-option.base-button.is-highlighted { background: var(--hover-bg); color: var(--text-color); border-color: transparent; }
.md-mention-option.base-button:focus-visible { outline: 1px solid var(--accent-color); outline-offset: -2px; }
.md-mention-option :deep(svg) { flex-shrink: 0; }
.md-mention-copy { display: flex; flex-direction: column; min-width: 0; align-items: flex-start; gap: 5px; text-align: left; }
.md-mention-copy > span { color: var(--text-color); font-weight: 500; }
.md-mention-copy > span, .md-mention-copy small { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-mention-copy small { color: var(--text-secondary); font-family: var(--font-mono-identifier); font-size: 11px; font-weight: 400; }
.md-mention-status { flex: 0 0 auto; padding: 8px; color: var(--text-secondary); }
</style>
