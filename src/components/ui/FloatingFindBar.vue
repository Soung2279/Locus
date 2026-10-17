<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import FindBar from "./FindBar.vue";

const props = defineProps<{
  anchor: HTMLElement | null;
  query: string;
  count: number;
  current: number;
  placeholder?: string;
}>();
const emit = defineEmits<{ "update:query": [value: string]; next: []; previous: []; close: [] }>();
const bar = ref<InstanceType<typeof FindBar> | null>(null);
const position = ref({ top: "0px", left: "0px", width: "0px" });
let release: (() => void) | undefined;

watch(() => props.anchor, (anchor) => {
  release?.();
  const owner = anchor?.ownerDocument.defaultView;
  if (!anchor || !owner) return;
  let frame = 0;
  function place() {
    frame = 0;
    const bounds = anchor!.getBoundingClientRect();
    const right = Math.min(owner!.innerWidth, bounds.right) - 8;
    const left = Math.max(0, bounds.left) + 8;
    const width = Math.max(0, Math.min(420, right - left));
    position.value = { top: `${Math.max(0, bounds.top) + 6}px`, left: `${right - width}px`, width: `${width}px` };
  }
  function schedule() { if (!frame) frame = owner!.requestAnimationFrame(place); }
  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
  observer?.observe(anchor);
  // Fixed positioning keeps the bar out of document/list flow. Keeping its DOM
  // inside the owner also makes retained hidden tabs hide their search UI.
  owner.addEventListener("resize", schedule);
  owner.document.addEventListener("scroll", schedule, true);
  place();
  void nextTick(place);
  release = () => {
    observer?.disconnect();
    owner.cancelAnimationFrame(frame);
    owner.removeEventListener("resize", schedule);
    owner.document.removeEventListener("scroll", schedule, true);
  };
}, { immediate: true, flush: "post" });
onBeforeUnmount(() => release?.());
defineExpose({ focus: () => bar.value?.focus() });
</script>

<template>
  <div class="floating-find-bar" :style="position">
    <FindBar ref="bar" :query="query" :count="count" :current="current" :placeholder="placeholder"
      @update:query="emit('update:query', $event)" @next="emit('next')" @previous="emit('previous')" @close="emit('close')" />
  </div>
</template>

<style scoped>
.floating-find-bar { position: fixed; z-index: 100; box-sizing: border-box; overflow: hidden; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--panel-bg); box-shadow: 0 4px 14px color-mix(in srgb, var(--text-color) 10%, transparent); }
.floating-find-bar :deep(.find-bar) { border-bottom: 0; }
</style>
