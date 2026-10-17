<script setup lang="ts">
import { Box, Copy, Download, FolderOpen, PencilLine, Settings2, Trash2 } from "lucide";
import { t } from "../../i18n";
import type { ViewPackageSummary } from "../../services/view";
import { isPluginView, viewPluginAttribution } from "./viewTreeActions";
import LucideIcon from "../icons/LucideIcon.vue";
import type { ViewResourceAction } from "./viewResourceActions";
defineProps<{ view: ViewPackageSummary; busy?: boolean }>();
const emit = defineEmits<{ action: [action: ViewResourceAction] }>();
</script>
<template>
  <button v-if="!isPluginView(view)" type="button" @click="emit('action', 'rename')"><LucideIcon :icon="PencilLine" :size="13" />{{ t('view.tree.rename') }}</button>
  <button type="button" @click="emit('action', 'configure')"><LucideIcon :icon="Settings2" :size="13" />{{ t('view.config.title') }}</button>
  <div class="base-context-menu-separator" role="separator" />
  <button type="button" :disabled="busy" @click="emit('action', 'unity')"><LucideIcon :icon="Box" :size="13" />{{ t('view.action.openInUnity') }}</button>
  <button v-if="!isPluginView(view)" type="button" :disabled="busy" @click="emit('action', 'export')"><LucideIcon :icon="Download" :size="13" />{{ t('view.action.export') }}</button>
  <button type="button" @click="emit('action', 'reveal')"><LucideIcon :icon="FolderOpen" :size="13" />{{ t('view.action.reveal') }}</button>
  <button type="button" @click="emit('action', 'copy')"><LucideIcon :icon="Copy" :size="13" />{{ t('knowledge.explorer.copyRelativePath') }}</button>
  <div v-if="viewPluginAttribution(view)" class="base-context-menu-label">{{ viewPluginAttribution(view) }}</div>
  <template v-if="!isPluginView(view)">
    <div class="base-context-menu-separator" role="separator" />
    <button type="button" class="danger" :disabled="busy" @click="emit('action', 'delete')"><LucideIcon :icon="Trash2" :size="13" />{{ t('view.tree.delete') }}</button>
  </template>
</template>
