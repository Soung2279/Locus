<script setup lang="ts">
import { computed, inject, provide } from "vue";
import type { UnityPropertyPathInput, UnityPropertyRuntime } from "./unityPropertyBinding";
import { UNITY_PROPERTY_SCOPE } from "./unityPropertyScope";
import { useUnityPropertyEditingContext } from "./unityPropertyEditingContext";
const props = withDefaults(defineProps<{
  target?: UnityPropertyPathInput;
  runtime?: UnityPropertyRuntime;
  readonly?: boolean;
  maxDepth?: number;
  maxArrayItems?: number;
}>(), { maxDepth: 4, maxArrayItems: 8 });
const parent = inject(UNITY_PROPERTY_SCOPE, null);
const editing = useUnityPropertyEditingContext();
provide(UNITY_PROPERTY_SCOPE, {
  runtime: computed(() => props.runtime ?? parent?.runtime.value ?? editing?.runtime),
  target: computed(() => props.target ?? parent?.target.value),
  readonly: computed(() => props.readonly || parent?.readonly.value || false),
  options: computed(() => ({ maxDepth: props.maxDepth, maxArrayItems: props.maxArrayItems })),
});
</script>
<template><slot /></template>
