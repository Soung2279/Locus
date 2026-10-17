<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { t } from "../../i18n";
import { buildToolCallArgsSummary } from "../toolCallSummary";
import { persistedOutputDisplay } from "../toolPersistedOutput";

import type { ToolCallDisplay } from "../../types";

const props = withDefaults(defineProps<{
  toolCall: ToolCallDisplay;
  collapseEnabled?: boolean;
}>(), {
  collapseEnabled: true,
});

const emit = defineEmits<{
  (e: "toolViewportAnchorStart", anchor: HTMLElement): void;
  (e: "toolViewportAnchorEnd", anchor: HTMLElement): void;
}>();

/** Optional filters the model usually sends as empty arrays. */
const UNITY_TEST_FILTER_KEYS = ["assemblies", "tests", "groups", "categories"];

const infoExpanded = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const headerRef = ref<HTMLElement | null>(null);

function runOnNextFrame(callback: () => void) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => callback());
    return;
  }
  setTimeout(callback, 16);
}

function setExpanded(value: boolean) {
  if (infoExpanded.value === value) return;
  const anchor = headerRef.value ?? rootRef.value;
  if (anchor) emit("toolViewportAnchorStart", anchor);
  infoExpanded.value = value;

  if (anchor) {
    nextTick(() => {
      runOnNextFrame(() => emit("toolViewportAnchorEnd", anchor));
    });
  }
}

function toggleExpanded() {
  setExpanded(!infoExpanded.value);
}

function expandFromBlockClick(event: MouseEvent) {
  if (infoExpanded.value || !hasInfoDetail.value) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest("button, a, input, textarea, select, [role='button'], .tool-call-detail, .ui-select-text")) {
    return;
  }
  setExpanded(true);
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

const outputDisplay = computed(() => {
  const output = props.toolCall.output;
  return output ? persistedOutputDisplay(output) : { kind: "normal" as const, text: "" };
});

const displayOutput = computed(() => outputDisplay.value.text);
const isDeletedOutput = computed(() => outputDisplay.value.kind === "deleted");
const deletedOutputPath = computed(() => outputDisplay.value.path || "");
const progress = computed(() => props.toolCall.status === "running" ? props.toolCall.progress : null);
const progressRatio = computed(() =>
  typeof progress.value?.progress === "number" ? clampProgress(progress.value.progress) : null,
);
const progressPercent = computed(() =>
  progressRatio.value === null ? "" : `${Math.round(progressRatio.value * 100)}%`,
);
const showProgressLine = computed(() => progressRatio.value !== null);

const parsedArgObject = computed<Record<string, unknown> | null>(() => {
  try {
    const args = JSON.parse(props.toolCall.arguments);
    return typeof args === "object" && args !== null && !Array.isArray(args) ? args : null;
  } catch {
    return null;
  }
});
const parsedArgs = computed(() => Object.entries(parsedArgObject.value ?? {})
  .filter(([key, value]) => (
    !UNITY_TEST_FILTER_KEYS.includes(key)
    || !Array.isArray(value)
    || value.length > 0
  ))
  .map(([key, value]) => ({
    key,
    value,
    isLong: typeof value === "string" && value.length > 80,
    isMultiline: typeof value === "string" && value.includes("\n"),
  })));
// Malformed arguments stay visible for diagnostics; a valid object whose
// entries were all empty filters has nothing worth showing.
const rawArgsFallback = computed(() => (
  parsedArgObject.value ? "" : props.toolCall.arguments
));

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value, null, 2);
}

function prettifyKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

// Stages without a known ratio (waiting for the Editor, starting the run) are
// shown inline in the header; once tests are counted, the progress line below
// carries the stage and the header keeps the call's argument summary.
const headerSummary = computed(() => {
  if (progress.value && !showProgressLine.value) {
    return [progress.value.title, progress.value.info].filter((part) => part.trim()).join(" - ");
  }
  return buildToolCallArgsSummary(props.toolCall.name, props.toolCall.arguments);
});

const statusIcon = computed(() => {
  switch (props.toolCall.status) {
    case "running": return "spinner";
    case "done": return "check";
    case "error": return "error";
    case "interrupted": return "error";
  }
});

const showRuntimeOnly = computed(() => props.toolCall.status === "running");
const hasInfoDetail = computed(() => !showRuntimeOnly.value || Boolean(displayOutput.value) || isDeletedOutput.value);
const isFramed = computed(() => infoExpanded.value || showProgressLine.value);
</script>

<template>
  <div
    ref="rootRef"
    class="unity-tool-call-block unity-test-run-tool-block"
    :class="[toolCall.status, { 'is-expanded': infoExpanded, 'is-framed': isFramed }]"
    @click="expandFromBlockClick"
  >
    <button
      ref="headerRef"
      type="button"
      class="tool-call-header ui-select-none"
      :aria-expanded="infoExpanded && hasInfoDetail"
      @click.stop="toggleExpanded"
    >
      <span class="tool-call-icon" :class="statusIcon">
        <span v-if="toolCall.status === 'running'" class="spinner-anim"></span>
        <span v-else class="tool-call-status-dot"></span>
      </span>
      <span class="tool-call-name">{{ toolCall.name }}</span>
      <span v-if="headerSummary" class="tool-call-summary" :title="headerSummary">{{ headerSummary }}</span>
    </button>

    <div v-if="showProgressLine && progress" class="tool-call-progress-line" aria-live="polite">
      <div class="unity-test-progress">
        <div class="unity-test-progress-row">
          <span class="unity-test-progress-title">{{ progress.title }}</span>
          <span v-if="progress.info" class="unity-test-progress-info" :title="progress.info">{{ progress.info }}</span>
          <span class="unity-test-progress-percent">{{ progressPercent }}</span>
        </div>
        <div class="unity-test-progress-track" aria-hidden="true">
          <div class="unity-test-progress-fill" :style="{ width: progressPercent }"></div>
        </div>
      </div>
    </div>

    <div v-if="infoExpanded && hasInfoDetail" class="tool-call-detail">
      <template v-if="!showRuntimeOnly">
        <div v-if="parsedArgs.length > 0 || rawArgsFallback" class="tool-call-section">
          <div class="tool-call-section-label">{{ t("tool.section.args") }}</div>
          <div v-if="parsedArgs.length > 0" class="tool-args-table">
            <div
              v-for="arg in parsedArgs"
              :key="arg.key"
              class="tool-arg-row"
              :class="{ 'arg-block': arg.isMultiline || arg.isLong }"
            >
              <span class="tool-arg-key">{{ prettifyKey(arg.key) }}</span>
              <pre v-if="arg.isMultiline" class="tool-arg-value-block ui-select-text">{{ formatValue(arg.value) }}</pre>
              <span
                v-else
                class="tool-arg-value ui-select-text"
                :class="{ 'value-bool': typeof arg.value === 'boolean', 'value-num': typeof arg.value === 'number' }"
              >{{ formatValue(arg.value) }}</span>
            </div>
          </div>
          <pre v-else class="tool-call-pre ui-select-text">{{ rawArgsFallback }}</pre>
        </div>

        <div v-if="toolCall.output !== undefined" class="tool-call-section">
          <div class="tool-call-section-label">{{ t("tool.section.output") }}</div>
          <div v-if="isDeletedOutput" class="tool-output-deleted">
            <div class="tool-output-deleted-title">{{ t("tool.persistedOutputDeleted") }}</div>
            <code v-if="deletedOutputPath" class="tool-output-deleted-path">
              {{ t("tool.persistedOutputDeletedPath", deletedOutputPath) }}
            </code>
          </div>
          <pre v-else-if="displayOutput" class="tool-call-pre ui-select-text" :class="{ 'error-output': toolCall.status === 'error' }">{{ displayOutput }}</pre>
          <pre v-else class="tool-call-pre ui-select-text">{{ t("tool.noOutput") }}</pre>
        </div>
      </template>

      <div v-else-if="displayOutput" class="tool-call-section">
        <div class="tool-call-section-label">{{ t("tool.section.output") }}</div>
        <pre class="tool-call-pre ui-select-text streaming-output">{{ displayOutput }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.unity-tool-call-block {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  max-width: 100%;
  margin: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  overflow: hidden;
  font-size: 13px;
  transition: background 0.18s ease, border-color 0.18s ease, border-radius 0.18s ease, padding 0.18s ease;
}

.unity-tool-call-block.is-framed {
  width: 100%;
  padding: 4px 6px 6px;
  border: 1px solid color-mix(in srgb, #8b7cf6 46%, var(--border-color));
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel-bg) 82%, var(--msg-assistant-bg) 18%);
}

.unity-tool-call-block:not(.is-expanded) {
  cursor: pointer;
}

.tool-call-header {
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  width: 100%;
  max-width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 4px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  min-height: 22px;
  text-align: left;
  transition: color 0.12s ease, background 0.12s ease;
}

.tool-call-header:hover {
  background: color-mix(in srgb, var(--hover-bg) 76%, transparent);
}

.tool-call-header:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--accent-color) 36%, transparent);
  outline-offset: 1px;
}

.tool-call-icon {
  width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.tool-call-icon.spinner {
  color: var(--accent-color);
}

.tool-call-icon.check {
  color: var(--text-secondary);
}

.tool-call-icon.error {
  color: var(--status-danger-fg);
}

.tool-call-status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.7;
}

.tool-call-icon.check .tool-call-status-dot {
  opacity: 0.46;
}

.tool-call-icon.error .tool-call-status-dot {
  width: 6px;
  height: 6px;
  opacity: 0.78;
}

.spinner-anim {
  width: 10px;
  height: 10px;
  border: 1.5px solid color-mix(in srgb, var(--accent-color) 18%, transparent);
  border-top-color: var(--accent-color);
  border-radius: 50%;
  animation: tool-spin 0.8s linear infinite;
  display: inline-block;
}

@keyframes tool-spin {
  to { transform: rotate(360deg); }
}

.tool-call-name {
  font-weight: 400;
  font-family: var(--font-ui-label);
  color: var(--text-secondary);
  font-size: 13px;
  flex-shrink: 0;
}

.unity-tool-call-block.is-expanded .tool-call-name {
  color: var(--text-color);
  font-family: var(--font-mono-identifier);
  font-size: 12px;
  font-weight: 600;
}

.tool-call-summary {
  color: var(--text-secondary);
  font-family: var(--font-mono-identifier);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.tool-call-progress-line {
  align-self: stretch;
  margin-top: 4px;
  padding: 5px 2px 0 20px;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 58%, transparent);
}

.unity-test-progress {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 2px 2px 1px;
  background: transparent;
}

.unity-test-progress-row {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.4;
}

.unity-test-progress-title {
  min-width: 0;
  color: var(--text-color);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unity-test-progress-info {
  min-width: 0;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unity-test-progress-percent {
  color: var(--text-secondary);
  font-family: var(--font-mono-identifier);
  font-size: 11px;
}

.unity-test-progress-track {
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--border-color) 70%, transparent);
}

.unity-test-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--accent-color);
  transition: width 0.16s ease;
}

.tool-call-detail {
  align-self: stretch;
  margin-top: 6px;
  padding: 6px 2px 0 20px;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 58%, transparent);
}

.tool-call-section {
  margin-bottom: 6px;
}

.tool-call-section:last-child {
  margin-bottom: 0;
}

.tool-call-section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.tool-args-table {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--hover-bg);
}

.tool-arg-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  line-height: 1.5;
}

.tool-arg-row.arg-block {
  flex-direction: column;
  gap: 2px;
}

.tool-arg-key {
  min-width: 60px;
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 500;
}

.tool-arg-value,
.tool-arg-value-block {
  min-width: 0;
  margin: 0;
  color: var(--text-color);
  font-family: var(--font-mono-identifier);
  font-size: 12px;
  word-break: break-word;
}

.tool-arg-value-block {
  align-self: stretch;
  overflow-x: auto;
  white-space: pre-wrap;
}

.tool-arg-value.value-bool {
  color: var(--md-syntax-literal);
}

.tool-arg-value.value-num {
  color: var(--md-syntax-number);
}

.tool-call-pre {
  font-family: var(--font-mono-block);
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-color);
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--hover-bg);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.tool-output-deleted {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--hover-bg);
  color: var(--text-secondary);
  font-size: 12px;
}

.tool-output-deleted-title {
  color: var(--text-color);
  font-weight: 600;
}

.tool-output-deleted-path {
  font-family: var(--font-mono-identifier);
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.streaming-output {
  max-height: 220px;
}

.error-output {
  color: var(--status-danger-fg);
}
</style>
