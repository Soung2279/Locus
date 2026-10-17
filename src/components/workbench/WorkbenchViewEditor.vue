<script setup lang="ts">
import { ref } from "vue";
import type { WorkspaceRef } from "../../services/project";
import ViewRuntimeHost from "../view/ViewRuntimeHost.vue";
defineProps<{ viewId: string; instanceId: string; workspaceRef: WorkspaceRef | null; active: boolean; windowLabel?: string; ownerWindow?: Window }>();
const emit = defineEmits<{ activate: []; 'icon-change': [icon: string | null]; 'title-change': [title: string] }>();
const host = ref<InstanceType<typeof ViewRuntimeHost> | null>(null);
defineExpose({
  ensureMounted: async () => { await host.value?.ensureMounted(); },
  relinquish: () => {},
  exportTransferSnapshot: () => host.value?.exportState() ?? {},
  applyTransferSnapshot: (state: Record<string, unknown>) => { host.value?.restoreState(state); return true; },
});
</script>
<template>
  <ViewRuntimeHost v-if="workspaceRef" ref="host" :key="instanceId" :view-id="viewId" :instance-id="instanceId" :workspace-ref="workspaceRef" :active="active" :window-label="windowLabel" :owner-window="ownerWindow" @activate="emit('activate')" @icon-change="emit('icon-change', $event)" @title-change="emit('title-change', $event)" />
</template>
