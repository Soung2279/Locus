<script lang="ts">
let nextSvgIconInstance = 0;
</script>

<script setup lang="ts">
import type { IconNode } from "lucide";
import { computed } from "vue";

defineOptions({
  inheritAttrs: false,
});

const props = withDefaults(defineProps<{
  icon: IconNode;
  size?: number | string;
  strokeWidth?: number | string;
}>(), {
  size: 14,
  strokeWidth: 2,
});

const svgInstancePrefix = `locus-icon-${++nextSvgIconInstance}-`;
const renderedIcon = computed<IconNode>(() => {
  if (props.icon[0]?.[0] !== "svg") return props.icon;
  // Cached SVG nodes can appear in several lists/tabs at once. Each rendered
  // instance needs its own paint/clip ids, including in drag previews.
  return props.icon.map(([tag, attrs]) => [tag, Object.fromEntries(
    Object.entries(attrs).map(([name, value]) => [name, typeof value === "string"
      ? value.replace(/locus-view-svg-\d+-/g, svgInstancePrefix) : value]),
  )]);
});
</script>

<template>
  <svg
    v-bind="$attrs"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <component
      :is="tag"
      v-for="([tag, attrs], idx) in renderedIcon"
      :key="idx"
      v-bind="attrs"
    />
  </svg>
</template>
