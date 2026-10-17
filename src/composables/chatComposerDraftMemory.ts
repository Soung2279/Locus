import { emptyComposerIntent, hasComposerIntent } from "./chatInputIntents";
import type { UserMessageDraft } from "./chatMessageDraft";

const MAX_SHARED_COMPOSER_DRAFTS = 64;
const sharedComposerDrafts = new Map<string, UserMessageDraft>();
const RECOVERY_KEY = "locus:composer-recovery:v1";
const MAX_RECOVERY_CHARS = 1024 * 1024;
let recoveryEnabled = false;
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;

/** Opted in by the native shared host. Session storage survives a renderer
 * reload without writing drafts to the conversation database or disk exports. */
export function enableComposerDraftRecovery(): void {
  if (recoveryEnabled) return;
  recoveryEnabled = true;
  try {
    const saved = JSON.parse(sessionStorage.getItem(RECOVERY_KEY) ?? "null");
    if (saved?.version === 1 && Array.isArray(saved.drafts)) {
      for (const [key, value] of saved.drafts.slice(-MAX_SHARED_COMPOSER_DRAFTS)) {
        if (typeof key === "string" && !sharedComposerDrafts.has(key)) {
          try { touchComposerDraft(key, cloneComposerDraft(value)); } catch { /* Discard an invalid cached record. */ }
        }
      }
    }
  } catch { /* Storage may be unavailable or an older record malformed. */ }
}

function saveRecovery(): void {
  recoveryTimer = undefined;
  try {
    const drafts: Array<[string, UserMessageDraft]> = [];
    let size = 0;
    for (const entry of [...sharedComposerDrafts.entries()].reverse()) {
      // Avoid serializing large image/console drafts just to discover they do
      // not fit. Keep recovery work proportional to the bounded cache budget.
      let strings = 0;
      const pending: unknown[] = [entry];
      while (pending.length && strings <= MAX_RECOVERY_CHARS - size) {
        const value = pending.pop();
        if (typeof value === "string") strings += value.length;
        else if (value && typeof value === "object") pending.push(...Object.values(value));
      }
      if (strings > MAX_RECOVERY_CHARS - size) continue;
      const length = JSON.stringify(entry).length;
      if (size + length > MAX_RECOVERY_CHARS) continue;
      size += length;
      drafts.unshift(entry);
    }
    sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ version: 1, drafts }));
  } catch { /* Quota/storage errors must not interrupt editing or flood logs. */ }
}

function scheduleRecovery(): void {
  if (recoveryEnabled && recoveryTimer === undefined) recoveryTimer = setTimeout(saveRecovery, 200);
}

function normalizedKey(key: string | null | undefined): string {
  return key?.trim() ?? "";
}

function cloneComposerDraft(draft: UserMessageDraft): UserMessageDraft {
  return {
    text: draft.text,
    images: draft.images.map((image) => ({ ...image })),
    assetRefs: draft.assetRefs.map((assetRef) => ({ ...assetRef })),
    ...(draft.knowledgeQuotes
      ? { knowledgeQuotes: draft.knowledgeQuotes.map((quote) => ({ ...quote })) }
      : {}),
    ...(draft.sessionRefs ? { sessionRefs: draft.sessionRefs.map((reference) => ({ ...reference })) } : {}),
    localFiles: draft.localFiles.map((file) => ({ ...file })),
    consoleTexts: draft.consoleTexts.map((entry) => ({ ...entry })),
    intent: {
      mode: draft.intent.mode,
      skills: draft.intent.skills.map((skill) => ({ ...skill })),
    },
  };
}

function emptyComposerDraft(text = ""): UserMessageDraft {
  return {
    text,
    images: [],
    assetRefs: [],
    knowledgeQuotes: [],
    localFiles: [],
    consoleTexts: [],
    intent: emptyComposerIntent(),
  };
}

function composerDraftHasContent(draft: UserMessageDraft): boolean {
  return !!draft.text
    || draft.images.length > 0
    || draft.assetRefs.length > 0
    || (draft.knowledgeQuotes?.length ?? 0) > 0
    || (draft.sessionRefs?.length ?? 0) > 0
    || draft.localFiles.length > 0
    || draft.consoleTexts.length > 0
    || hasComposerIntent(draft.intent);
}

function touchComposerDraft(key: string, draft: UserMessageDraft): void {
  sharedComposerDrafts.delete(key);
  sharedComposerDrafts.set(key, draft);
  while (sharedComposerDrafts.size > MAX_SHARED_COMPOSER_DRAFTS) {
    const oldest = sharedComposerDrafts.keys().next().value as string | undefined;
    if (!oldest) break;
    sharedComposerDrafts.delete(oldest);
  }
  scheduleRecovery();
}

export function readSharedComposerDraft(key: string | null | undefined): UserMessageDraft | null {
  const normalized = normalizedKey(key);
  if (!normalized) return null;
  const draft = sharedComposerDrafts.get(normalized);
  if (!draft) return null;
  touchComposerDraft(normalized, draft);
  return cloneComposerDraft(draft);
}

export function writeSharedComposerDraft(
  key: string | null | undefined,
  draft: UserMessageDraft,
): void {
  const normalized = normalizedKey(key);
  if (!normalized) return;
  if (!composerDraftHasContent(draft)) {
    sharedComposerDrafts.delete(normalized);
    scheduleRecovery();
    return;
  }
  touchComposerDraft(normalized, cloneComposerDraft(draft));
}

export function updateSharedComposerDraftText(
  key: string | null | undefined,
  text: string,
): void {
  const normalized = normalizedKey(key);
  if (!normalized) return;
  const existing = sharedComposerDrafts.get(normalized);
  if (!existing) {
    if (text) touchComposerDraft(normalized, emptyComposerDraft(text));
    return;
  }
  const next = { ...existing, text };
  if (!composerDraftHasContent(next)) {
    sharedComposerDrafts.delete(normalized);
    scheduleRecovery();
    return;
  }
  touchComposerDraft(normalized, next);
}

export function clearSharedComposerDraft(key: string | null | undefined): void {
  const normalized = normalizedKey(key);
  if (normalized) sharedComposerDrafts.delete(normalized);
  scheduleRecovery();
}
