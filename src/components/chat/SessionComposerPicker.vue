<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, watch, type CSSProperties } from "vue";
import { Check, MessagesSquare, Search } from "lucide";
import { t } from "../../i18n";
import type { SessionSummary } from "../../types";
import { useDisplaySettings } from "../../composables/useDisplaySettings";
import { formatWorkspaceUpdatedTime } from "../../composables/useFormatters";
import { isSessionUnread } from "../../services/sessionAttention";
import BaseButton from "../ui/BaseButton.vue";
import LucideIcon from "../icons/LucideIcon.vue";

const props = defineProps<{
  sessions: SessionSummary[];
  activeSessionId: string | null;
  active?: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{ selectSession: [id: string] }>();
const { state: displaySettings } = useDisplaySettings();
const timeNow = ref(Date.now() / 1000);
const root = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const search = ref<HTMLInputElement | null>(null);
const target = shallowRef<HTMLElement | null>(null);
const open = ref(false);
const query = ref("");
const panelId = useId();
const panelStyle = ref<CSSProperties>({});
const sessions = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return [...props.sessions]
    .filter(session => !term || title(session).toLocaleLowerCase().includes(term))
    .sort((left, right) => right.updatedAt - left.updatedAt);
});

function title(session: SessionSummary): string {
  return session.title || t("chat.session.newSession");
}

function unread(sessionId: string): boolean {
  return displaySettings.showSessionUnreadIndicators && isSessionUnread(sessionId);
}

function updatedTime(session: SessionSummary): string {
  return formatWorkspaceUpdatedTime(session.updatedAt, timeNow.value);
}

function sessionLabel(session: SessionSummary): string {
  return [title(session), updatedTime(session), unread(session.id) ? t("chat.session.unread") : ""]
    .filter(Boolean).join(" — ");
}

function positionPanel() {
  const element = root.value;
  const ownerWindow = element?.ownerDocument.defaultView;
  if (!open.value || !element || !ownerWindow) return;
  const rect = element.getBoundingClientRect();
  const margin = 8;
  const width = Math.max(0, Math.min(360, ownerWindow.innerWidth - margin * 2));
  panelStyle.value = {
    width: `${width}px`,
    left: `${Math.max(margin, Math.min(rect.left, ownerWindow.innerWidth - width - margin))}px`,
    bottom: `${ownerWindow.innerHeight - rect.top + 6}px`,
    maxHeight: `${Math.max(0, Math.min(340, rect.top - margin - 6))}px`,
  };
}

function close(restoreFocus = false) {
  open.value = false;
  if (restoreFocus) root.value?.querySelector("button")?.focus();
}

async function toggle() {
  if (props.disabled) return;
  if (open.value) return close();
  target.value = root.value?.ownerDocument.body ?? null;
  query.value = "";
  open.value = true;
  positionPanel();
  await nextTick();
  if (!open.value) return;
  search.value?.focus();
  panel.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function selectSession(id: string) {
  close(true);
  if (id !== props.activeSessionId) emit("selectSession", id);
}

function onOutside(event: Event) {
  const path = event.composedPath();
  if (root.value && path.includes(root.value)) return;
  if (panel.value && path.includes(panel.value)) return;
  close();
}

function onScroll(event: Event) {
  if (panel.value && event.composedPath().includes(panel.value)) return;
  positionPanel();
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Escape" && open.value) {
    event.preventDefault();
    event.stopPropagation();
    close(true);
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  event.stopPropagation();
  if (!open.value) {
    void toggle();
    return;
  }
  const options = Array.from(panel.value?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
  if (!options.length) return;
  const index = options.findIndex(option => option === option.ownerDocument.activeElement);
  const next = index < 0
    ? event.key === "ArrowDown" ? 0 : options.length - 1
    : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
  options[next]?.focus();
  options[next]?.scrollIntoView({ block: "nearest" });
}

watch(open, (value, _, onCleanup) => {
  const ownerDocument = root.value?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  if (!value || !ownerDocument || !ownerWindow) return;
  timeNow.value = Date.now() / 1000;
  const timeRefreshTimer = ownerWindow.setInterval(() => { timeNow.value = Date.now() / 1000; }, 60_000);
  ownerDocument.addEventListener("pointerdown", onOutside, true);
  ownerDocument.addEventListener("focusin", onOutside);
  ownerWindow.addEventListener("resize", positionPanel);
  ownerWindow.addEventListener("scroll", onScroll, true);
  onCleanup(() => {
    ownerWindow.clearInterval(timeRefreshTimer);
    ownerDocument.removeEventListener("pointerdown", onOutside, true);
    ownerDocument.removeEventListener("focusin", onOutside);
    ownerWindow.removeEventListener("resize", positionPanel);
    ownerWindow.removeEventListener("scroll", onScroll, true);
  });
});
watch(() => [props.activeSessionId, props.active, props.disabled], () => close());
</script>

<template>
  <div ref="root" class="session-composer-picker" @keydown="onKeydown">
    <BaseButton
      class="session-composer-trigger"
      :class="{ active: open }"
      :disabled="disabled"
      :title="t('chat.session.switch')"
      :aria-label="t('chat.session.switch')"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-controls="open ? panelId : undefined"
      @click="toggle"
    >
      <LucideIcon :icon="MessagesSquare" :size="14" />
    </BaseButton>
    <Teleport v-if="target" :to="target">
      <div
        v-if="open"
        :id="panelId"
        ref="panel"
        class="session-composer-panel"
        :style="panelStyle"
        role="dialog"
        :aria-label="t('chat.session.switch')"
        @keydown="onKeydown"
      >
        <label class="session-composer-search">
          <LucideIcon :icon="Search" :size="13" />
          <input
            ref="search"
            v-model="query"
            :placeholder="t('chat.session.search')"
            :aria-label="t('chat.session.search')"
            @keydown.enter.prevent="!$event.isComposing && sessions[0] && selectSession(sessions[0].id)"
          />
        </label>
        <div class="session-composer-list" role="listbox" :aria-label="t('chat.session.switch')">
          <button
            v-for="session in sessions"
            :key="session.id"
            class="session-composer-option"
            type="button"
            role="option"
            :aria-selected="session.id === activeSessionId"
            :title="sessionLabel(session)"
            :aria-label="sessionLabel(session)"
            @click="selectSession(session.id)"
          >
            <span class="session-composer-title">{{ title(session) }}</span>
            <span class="session-composer-meta">
              <span
                v-if="unread(session.id)"
                class="session-composer-unread-dot"
                role="img"
                :aria-label="t('chat.session.unread')"
                :title="t('chat.session.unread')"
              />
              <span v-else class="session-composer-updated-time">{{ updatedTime(session) }}</span>
              <LucideIcon v-if="session.id === activeSessionId" :icon="Check" :size="13" />
            </span>
          </button>
          <div v-if="!sessions.length" class="session-composer-empty">
            {{ t(query.trim() ? 'globalSearch.noResults' : 'chat.session.noSessions') }}
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.session-composer-picker {
  display: inline-flex;
  align-items: center;
  margin-left: 4px;
}
.session-composer-trigger.base-button {
  width: 24px;
  height: 24px;
  min-height: 24px;
  padding: 0;
  border-color: transparent;
  border-radius: 5px;
}
.session-composer-trigger:hover,
.session-composer-trigger.active,
.session-composer-trigger:focus-visible {
  background: var(--hover-bg);
  border-color: var(--border-color);
  color: var(--text-color);
}
.session-composer-panel {
  position: fixed;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--surface-elevated, var(--panel-bg));
  color: var(--text-color);
  font-size: 12px;
}
.session-composer-search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);
  color: var(--text-secondary);
}
.session-composer-search input {
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text-color);
  font: inherit;
}
.session-composer-search:focus-within {
  border-bottom-color: var(--border-strong);
}
.session-composer-list {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px;
}
.session-composer-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  text-align: left;
  cursor: pointer;
  box-shadow: none;
}
.session-composer-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-composer-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.session-composer-updated-time {
  max-width: 88px;
  overflow: hidden;
  color: var(--text-secondary);
  font-family: var(--font-ui);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-composer-unread-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--accent-color);
}
.session-composer-option:hover,
.session-composer-option:focus-visible {
  outline: none;
  border-color: var(--border-color);
  background: var(--hover-bg);
}
.session-composer-option[aria-selected="true"] {
  background: var(--active-bg);
}
.session-composer-empty {
  padding: 12px 8px;
  color: var(--text-secondary);
  text-align: center;
}
</style>
