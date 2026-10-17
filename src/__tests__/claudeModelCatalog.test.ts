import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { nextTick } from 'vue';
import { useModelStore } from '../stores/model';
import { useAuthStore } from '../stores/auth';
import { getClaudeConnection, type ClaudeConnection } from '../services/claudeConnection';
import type { ModelOption } from '../types';

const mocks = vi.hoisted(() => ({
  ipcInvoke: vi.fn(), getModelDefaults: vi.fn(), getClaudeCodeModels: vi.fn(), saveLastModel: vi.fn(),
}));
vi.mock('../services/ipc', () => ({ ipcInvoke: mocks.ipcInvoke }));
vi.mock('../services/model', () => mocks);

const local: ClaudeConnection = {
  version: 1, permissionMode: 'auto', remote: null, info: null, authorizedTarget: null,
};
const remote = (target: string, model: string | null = null): ClaudeConnection => ({
  ...local,
  remote: { target, port: 22, identityFile: null, knownHostsFile: null, cliPath: null },
  info: { pythonInstalled: true, cliVersion: 'test', cliSupported: true, model, authenticated: true, home: null },
});
const option = (model: string): ModelOption => ({ id: `claude_code/${model}`, name: model, provider: 'claude_code' });
const flush = async () => { await Promise.resolve(); await nextTick(); };
async function connection(value: ClaudeConnection) {
  mocks.ipcInvoke.mockImplementation(async (command: string) =>
    command === 'get_claude_code_cli_enabled' ? true : value);
  await getClaudeConnection();
  await flush();
}
let pinia: Pinia;
beforeEach(async () => {
  vi.resetAllMocks();
  await connection(local);
  pinia = createPinia();
  setActivePinia(pinia);
  mocks.getModelDefaults.mockResolvedValue({});
  mocks.getClaudeCodeModels.mockResolvedValue([option('deepseek-flash')]);
  mocks.saveLastModel.mockResolvedValue(undefined);
  useAuthStore().claudeCodeAvailable = true;
});
afterEach(() => disposePinia(pinia));

describe('Claude Code model catalog connection isolation', () => {
  it('replaces discovery results when refreshing the same connection', async () => {
    const store = useModelStore();
    await store.loadModelDefaults();
    expect(store.availableModels.map(m => m.id)).toContain('claude_code/deepseek-flash');
    mocks.getClaudeCodeModels.mockResolvedValue([]);
    await store.loadModelDefaults();
    expect(store.availableModels.map(m => m.id)).not.toContain('claude_code/deepseek-flash');
  });

  it('clears local models on SSH selection and preserves the selected stable model ID', async () => {
    const store = useModelStore();
    await store.loadModelDefaults();
    store.selectModel('claude_code/claude-opus-5-5');
    mocks.getClaudeCodeModels.mockResolvedValue([]);
    await connection(remote('user@mac'));
    expect(store.availableModels.filter(m => m.provider === 'claude_code').map(m => m.name)).toEqual([
      'Claude Opus 5.5', 'Claude Fable 5.1', 'Claude Sonnet 5.5', 'Claude Haiku 5.5',
    ]);
    expect(store.selectedModelId).toBe('claude_code/claude-opus-5-5');
    mocks.getClaudeCodeModels.mockResolvedValue([option('deepseek-flash')]);
    await connection(local);
    expect(store.availableModels.map(m => m.id)).toContain('claude_code/deepseek-flash');
  });

  it('isolates different SSH servers and updates the same server after inspection', async () => {
    const store = useModelStore();
    await store.loadModelDefaults();
    await connection(remote('user@wsl', 'deepseek-flash'));
    expect(store.availableModels.map(m => m.id)).toContain('claude_code/deepseek-flash');
    mocks.getClaudeCodeModels.mockResolvedValue([]);
    await connection(remote('user@mac'));
    expect(store.availableModels.map(m => m.id)).not.toContain('claude_code/deepseek-flash');
    mocks.getClaudeCodeModels.mockResolvedValue([option('gateway-new')]);
    await connection(remote('user@mac', 'gateway-new'));
    expect(store.availableModels.map(m => m.id)).toContain('claude_code/gateway-new');
  });

  it('discards an old discovery response that arrives after switching servers', async () => {
    const store = useModelStore();
    let finishOld!: (models: ModelOption[]) => void;
    mocks.getClaudeCodeModels.mockReturnValueOnce(new Promise<ModelOption[]>(resolve => { finishOld = resolve; }));
    const oldRequest = store.loadModelDefaults();
    await flush();
    mocks.getClaudeCodeModels.mockResolvedValue([]);
    await connection(remote('user@mac'));
    finishOld([option('deepseek-flash')]);
    await oldRequest;
    expect(store.availableModels.map(m => m.id)).not.toContain('claude_code/deepseek-flash');
  });

  it('does not retain stale models if discovery fails or import them from session history', async () => {
    const store = useModelStore();
    await store.loadModelDefaults();
    mocks.getClaudeCodeModels.mockRejectedValue(new Error('unavailable'));
    await connection(remote('user@mac'));
    store.applySessionModel('claude_code/deepseek-flash');
    expect(store.selectedModelId).toBe('claude_code/deepseek-flash');
    expect(store.availableModels.map(m => m.id)).not.toContain('claude_code/deepseek-flash');
    store.applySessionModel('claude_code/claude-opus-5-5');
    expect(store.availableModels.map(m => m.id)).not.toContain('claude_code/deepseek-flash');
  });
});
