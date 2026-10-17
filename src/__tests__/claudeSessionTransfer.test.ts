import { effectScope, reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useClaudeSessionTransfer } from '../composables/useClaudeSessionTransfer';
import * as service from '../services/claudeConnection';
vi.mock('../services/claudeConnection', () => ({ checkClaudeSessionTransfer: vi.fn(), restoreClaudeNativeSession: vi.fn() }));
const check: service.ClaudeSessionTransfer = { source: 'user@a', target: 'user@b', targetFingerprint: 'b', nativeId: 'native', archiveDigest: 'digest', updatedAt: 100, blockedReason: null };
function harness() {
  const scope = effectScope();
  const context = reactive({ sessionId: 'chat', modelId: 'claude_code/opus', enabled: true });
  const transfer = scope.run(() => useClaudeSessionTransfer(() => context))!;
  return { ...transfer, context, stop: () => scope.stop() };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(service.checkClaudeSessionTransfer).mockResolvedValue(check);
  vi.mocked(service.restoreClaudeNativeSession).mockResolvedValue({ nativeId: 'native', target: 'user@b', transferredBytes: 20 });
});
describe('Claude send-time server transfer', () => {
  it('only prompts on first send and pins the displayed destination on explicit restore', async () => {
    const h = harness();
    expect(await h.beforeSend()).toBe(false);
    expect(h.pending.value).toEqual(check);
    expect(service.restoreClaudeNativeSession).not.toHaveBeenCalled();
    h.dismiss();
    expect(h.pending.value).toBeNull();
    expect(service.restoreClaudeNativeSession).not.toHaveBeenCalled();
    await h.beforeSend();
    expect(await h.restore()).toBe(true);
    expect(service.restoreClaudeNativeSession).toHaveBeenCalledWith('chat', check);
    h.stop();
  });
  it('passes same-server and API sends without any upload', async () => {
    vi.mocked(service.checkClaudeSessionTransfer).mockResolvedValue(null);
    const h = harness();
    expect(await h.beforeSend()).toBe(true);
    expect(h.pending.value).toBeNull();
    h.context.enabled = false;
    expect(await h.beforeSend()).toBe(true);
    expect(service.checkClaudeSessionTransfer).toHaveBeenCalledTimes(1);
    expect(service.restoreClaudeNativeSession).not.toHaveBeenCalled();
    h.stop();
  });
  it('blocks missing backups', async () => {
    vi.mocked(service.checkClaudeSessionTransfer).mockResolvedValue({ ...check, blockedReason: 'noBackup', archiveDigest: null });
    const h = harness();
    expect(await h.beforeSend()).toBe(false);
    expect(await h.restore()).toBe(false);
    expect(service.restoreClaudeNativeSession).not.toHaveBeenCalled();
    h.stop();
  });
  it('keeps failed restores unsent and refreshes changed targets for explicit confirmation', async () => {
    const h = harness();
    await h.beforeSend();
    vi.mocked(service.restoreClaudeNativeSession).mockRejectedValue(new Error('destination changed'));
    vi.mocked(service.checkClaudeSessionTransfer).mockResolvedValue({ ...check, target: 'user@c', targetFingerprint: 'c' });
    expect(await h.restore()).toBe(false);
    expect(h.pending.value?.target).toBe('user@c');
    expect(h.error.value).toContain('destination changed');
    h.stop();
  });
  it('rejects duplicate clicks and stale completions after changing sessions', async () => {
    const h = harness();
    await h.beforeSend();
    let finish!: (value: { nativeId: string; target: string; transferredBytes: number }) => void;
    vi.mocked(service.restoreClaudeNativeSession).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = h.restore();
    expect(await h.restore()).toBe(false);
    h.context.sessionId = 'other';
    finish({ nativeId: 'native', target: 'user@b', transferredBytes: 20 });
    expect(await first).toBe(false);
    expect(h.pending.value).toBeNull();
    expect(service.restoreClaudeNativeSession).toHaveBeenCalledTimes(1);
    h.stop();
  });
});
