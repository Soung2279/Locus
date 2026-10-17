import { onScopeDispose, ref, watch } from 'vue';
import { checkClaudeSessionTransfer, restoreClaudeNativeSession, type ClaudeSessionTransfer } from '../services/claudeConnection';
import { normalizeAppError } from '../services/errors';

/** The first send only reads local metadata. Restoration requires the explicit button. */
export function useClaudeSessionTransfer(context: () => { sessionId: string | null; modelId: string; enabled: boolean }) {
  const pending = ref<ClaudeSessionTransfer | null>(null);
  const busy = ref(false);
  const error = ref('');
  let generation = 0;
  const reset = () => { generation++; pending.value = null; error.value = ''; };
  watch(() => [context().sessionId, context().modelId, context().enabled], reset, { flush: 'sync' });
  onScopeDispose(reset);

  async function beforeSend() {
    if (busy.value) return false;
    const { sessionId, enabled } = context();
    if (!enabled || !sessionId) return true;
    const version = generation;
    busy.value = true;
    try {
      const check = await checkClaudeSessionTransfer(sessionId);
      if (version !== generation) return false;
      pending.value = check;
      error.value = '';
      return check === null;
    } catch (cause) {
      if (version === generation) error.value = normalizeAppError(cause).message;
      return false;
    } finally { busy.value = false; }
  }

  async function restore() {
    const transfer = pending.value;
    const { sessionId, enabled } = context();
    if (busy.value || !enabled || !sessionId || !transfer?.archiveDigest || transfer.blockedReason) return false;
    const version = generation;
    busy.value = true;
    error.value = '';
    try {
      await restoreClaudeNativeSession(sessionId, transfer);
      if (version !== generation) return false;
      pending.value = null;
      return true;
    } catch (cause) {
      try {
        const check = await checkClaudeSessionTransfer(sessionId);
        if (version === generation) pending.value = check;
      } catch { /* Keep the last reminder and the restore error; do not submit. */ }
      if (version === generation) error.value = normalizeAppError(cause).message;
      return false;
    } finally { busy.value = false; }
  }
  return { pending, busy, error, beforeSend, restore, dismiss: reset };
}
