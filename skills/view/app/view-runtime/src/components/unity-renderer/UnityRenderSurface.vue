<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { UnityRenderOutput, UnityRenderStatus, UnityRenderSurfaceHandle } from "../../services/unityRenderer";

const props = withDefaults(defineProps<{ source: UnityRenderOutput | null; visible?: boolean; label?: string }>(), { visible: true, label: "Unity Render" });
const emit = defineEmits<{ status: [value: UnityRenderStatus]; error: [message: string] }>();
const root = ref<HTMLElement | null>(null);
const error = ref("");
let revision = 0;
let surface: UnityRenderSurfaceHandle | null = null;
let unsubscribe: (() => void) | null = null;
let release = Promise.resolve();
function bind() {
  const current = ++revision;
  // Include the pending mount in this chain: source changes can arrive before
  // the native window has finished mounting.
  release = release.then(async () => {
  unsubscribe?.(); unsubscribe = null;
  const previous = surface; surface = null;
  await previous?.dispose();
  if (current !== revision || !root.value || !props.source) return;
  error.value = "";
  unsubscribe = props.source.subscribe((value) => { if (current !== revision) return; error.value = value.error ?? ""; emit("status", value); });
  try {
    const mounted = await props.source.mount(root.value);
    if (current !== revision) { await mounted.dispose(); return; }
    surface = mounted; mounted.setVisible(props.visible);
  } catch (value) {
    if (current !== revision) return;
    error.value = String((value as Error)?.message ?? value); emit("error", error.value);
  }
  }).catch((value) => { if (current === revision) { error.value = String(value?.message ?? value); emit("error", error.value); } });
}
onMounted(bind);
watch(() => props.source, bind);
watch(() => props.visible, (visible) => surface?.setVisible(visible));
onBeforeUnmount(() => { revision++; unsubscribe?.(); release = release.then(async () => { await surface?.dispose(); surface = null; }).catch(() => {}); });
</script>

<template>
  <div ref="root" class="unity-render-surface" role="region" :aria-label="label">
    <span v-if="error" class="unity-render-error" role="alert">{{ error }}</span>
  </div>
</template>

<style scoped>
.unity-render-surface { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; background: var(--bg-color); }
.unity-render-error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 12px; color: var(--text-secondary); font-size: 12px; }
</style>
