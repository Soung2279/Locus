<view>
{"name":"Unity Renderer","unity":true,"scripts":[{"name":"renderer","path":"unity/RendererExample.cs","entryType":"RendererExample"}]}
</view>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, shallowRef, ref } from "vue";
import { locus } from "@locus/frontend";
import { view } from "@locus/view-runtime";
import { BaseButton, UnityRenderSurface } from "@locus/components";

const output = shallowRef(null);
const playing = ref(true);
const error = ref("");
const connecting = ref(false);
let released = false;
async function connect() {
  if (connecting.value || released) return;
  connecting.value = true;
  error.value = "";
  try {
    await output.value?.dispose(); output.value = null;
    const capability = await locus.unity.renderer.capabilities();
    if (!capability.supported) throw new Error(capability.reason);
    const next = await locus.unity.renderer.createOutput();
    if (released) { await next.dispose(); return; }
    output.value = next;
    await view.callScript("renderer", "Open", { outputId: next.id });
    playing.value = true;
  } catch (value) {
    error.value = String(value?.message ?? value);
    await output.value?.dispose(); output.value = null;
  } finally { connecting.value = false; }
}
async function command(method, args = {}) {
  if (!output.value) return;
  try { await view.callScript("renderer", method, { outputId: output.value.id, ...args }); }
  catch (value) { error.value = String(value?.message ?? value); }
}
async function toggle() { playing.value = !playing.value; await command("SetPlaying", { playing: playing.value }); }
onMounted(connect);
onBeforeUnmount(() => { released = true; void output.value?.dispose(); });
</script>

<template>
  <section class="renderer-example">
    <header>
      <BaseButton size="sm" :disabled="!output" @click="toggle">{{ playing ? "暂停" : "播放" }}</BaseButton>
      <BaseButton size="sm" :disabled="!output" @click="command('Seek', { time: 0 })">复位</BaseButton>
      <BaseButton size="sm" :disabled="connecting" @click="connect">重新连接</BaseButton>
    </header>
    <p v-if="error" role="alert">{{ error }}</p>
    <UnityRenderSurface v-else :source="output" label="场景预览" />
  </section>
</template>

<style scoped>
.renderer-example { height: 100%; display: flex; flex-direction: column; min-height: 0; background: var(--panel-bg); }
header { display: flex; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border-color); }
.unity-render-surface { flex: 1; }
p { margin: 12px; color: var(--text-secondary); font-size: 12px; }
</style>
