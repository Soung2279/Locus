<script setup lang="ts">
import { computed } from "vue";
import { t } from "../../i18n";
import { formatShortcut, useKeyboardShortcuts } from "../../composables/useKeyboardShortcuts";
import { useGlobalSearchSettings } from "../../composables/useGlobalSearchSettings";
import BaseSwitch from "../ui/BaseSwitch.vue";
const { state, set } = useGlobalSearchSettings();
const { state: shortcuts } = useKeyboardShortcuts();
const shortcut = computed(() => formatShortcut(shortcuts.globalSearch));
</script>

<template>
  <div class="settings-section">
    <div class="section-label">{{ t("settings.tab.globalSearch") }}</div>
    <p class="section-desc">{{ t("globalSearch.shortcutHint", shortcut) }}</p>
    <div class="toggle-row">
      <BaseSwitch :model-value="state.enabled" :aria-label="t('globalSearch.enabled')" @update:model-value="set('enabled', $event)" />
      <span>{{ t("globalSearch.enabled") }}</span>
    </div>
  </div>
</template>

<style scoped>
.toggle-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; font-size: 13px; }
</style>
