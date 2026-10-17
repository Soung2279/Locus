<script setup lang="ts">
import { t } from "../../i18n";
import ExplorerSearchBar from "../explorer/ExplorerSearchBar.vue";

defineProps<{
  scope: HTMLElement | null;
  query: string;
  searching: boolean;
  active?: boolean;
}>();
const emit = defineEmits<{
  "update:query": [value: string];
  clear: [];
}>();
</script>

<template>
  <ExplorerSearchBar
    :scope="scope"
    :query="query"
    :searching="searching"
    :active="active"
    :placeholder="t('knowledge.search.globalPlaceholder')"
    @update:query="emit('update:query', $event)"
    @clear="emit('clear')"
  />
</template>
