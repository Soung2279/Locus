<script setup lang="ts">
import { sessionReferenceUrl } from "../../composables/sessionReferences";
import { openSessionReference } from "../../services/sessionReference";
import "../../styles/markdown-links.css";

defineProps<{ sessionId: string; title: string }>();
</script>

<template>
  <a class="session-reference" :href="sessionReferenceUrl(sessionId)" :title="sessionId"
    @click.prevent.stop="openSessionReference(sessionId, title)"
    @auxclick.prevent.stop="($event.button === 1) && openSessionReference(sessionId, title)"
  >{{ title }}</a>
</template>
