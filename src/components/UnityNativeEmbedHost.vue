<script setup lang="ts">
import { defineAsyncComponent, onUnmounted, onErrorCaptured } from "vue";
import { provideDiffOverlay } from "../composables/useDiffOverlay";
import { markUnityNativeEmbedReady, nativeEmbedWindowHandle, reportUnityNativeEmbedFailure, type UnityNativeEmbedHost } from "../services/unityNativeEmbed";
import { useWorkbenchStore } from "../stores/workbench";
import { useWorkspaceContextStore } from "../stores/workspaceContext";
import DevelopmentWorkbench from "./workbench/DevelopmentWorkbench.vue";
import ViewRuntimeHost from "./view/ViewRuntimeHost.vue";
import TopBannerHost from "./TopBannerHost.vue";
import { provideWindowSurface } from "../composables/useWindowSurface";

const props = defineProps<{ host: UnityNativeEmbedHost }>();
provideWindowSurface(props.host.ownerWindow, "unity");
const nativeWindow = nativeEmbedWindowHandle(props.host);
const workbench = useWorkbenchStore();
const workspace = useWorkspaceContextStore();
onUnmounted(() => { workbench.deleteWindow(props.host.surface.label); void workspace.disposeWindow(props.host.surface.label).catch(() => 0); });
const diffOverlay = provideDiffOverlay();
const FileDiffOverlay = defineAsyncComponent(() => import("./diff/FileDiffOverlay.vue"));
function ready() { void markUnityNativeEmbedReady(props.host).catch(error => reportUnityNativeEmbedFailure(props.host.surface, error)); }
function failed(message: string) { void reportUnityNativeEmbedFailure(props.host.surface, message); }
onErrorCaptured(error => {
  void reportUnityNativeEmbedFailure(props.host.surface, error);
  return false;
});
</script>
<template>
  <main class="unity-native-workbench">
    <TopBannerHost />
    <ViewRuntimeHost v-if="host.surface.targetKind === 'view'"
      :view-id="host.surface.targetId" :workspace-ref="host.surface.workspaceRef"
      :instance-id="host.surface.generation"
      :window-label="host.surface.label" :owner-window="host.ownerWindow"
      :active="host.surface.visible" @ready="ready" @error="failed" />
    <DevelopmentWorkbench v-else :window-id="host.surface.label"
      :native-window="nativeWindow"
      :owner-window="host.ownerWindow" :initial-session-id="host.surface.targetId"
      :fixed-workspace-ref="host.surface.workspaceRef" @ready="ready" />
    <FileDiffOverlay v-if="diffOverlay.visible.value" :owner-window="host.ownerWindow" />
  </main>
</template>
<style scoped>
.unity-native-workbench {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--text-color);
  background: var(--bg-color);
}
</style>
