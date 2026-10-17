
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ipcInvoke: vi.fn(),
  handlers: new Map<string, (payload: unknown) => unknown>(),
}));

vi.mock("../services/ipc", () => ({ ipcInvoke: mocks.ipcInvoke }));
vi.mock("../services/locusRuntime", () => ({
  getLocusRuntime: () => ({
    subscribe: async (eventName: string, handler: (payload: unknown) => unknown) => {
      mocks.handlers.set(eventName, handler);
      return () => mocks.handlers.delete(eventName);
    },
  }),
}));

describe("Claude Code CLI experimental gate", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.ipcInvoke.mockReset();
    mocks.handlers.clear();
  });

  it("stays hidden until the persisted setting is read as enabled", async () => {
    const gate = await import("../services/claudeCodeCli");
    expect(gate.claudeCodeCliEnabled.value).toBe(false);
    expect(gate.claudeCodeCliDisabled.value).toBe(false);

    mocks.ipcInvoke.mockResolvedValueOnce(true);
    await expect(gate.loadClaudeCodeCliEnabled()).resolves.toBe(true);
    expect(mocks.ipcInvoke).toHaveBeenCalledWith("get_claude_code_cli_enabled");
    expect(gate.claudeCodeCliEnabled.value).toBe(true);
  });

  it("follows changes made in other windows", async () => {
    const gate = await import("../services/claudeCodeCli");
    mocks.ipcInvoke.mockResolvedValueOnce(false);
    await gate.loadClaudeCodeCliEnabled();
    expect(gate.claudeCodeCliDisabled.value).toBe(true);

    mocks.handlers.get(gate.CLAUDE_CODE_CLI_ENABLED_CHANGED_EVENT)?.(true);
    expect(gate.claudeCodeCliEnabled.value).toBe(true);
  });

  it("restores the previous value when saving fails", async () => {
    const gate = await import("../services/claudeCodeCli");
    mocks.ipcInvoke.mockResolvedValueOnce(false);
    await gate.loadClaudeCodeCliEnabled();

    mocks.ipcInvoke.mockRejectedValueOnce(new Error("disk full"));
    await expect(gate.setClaudeCodeCliEnabled(true)).rejects.toThrow("disk full");
    expect(mocks.ipcInvoke).toHaveBeenLastCalledWith("set_claude_code_cli_enabled", { value: true });
    expect(gate.claudeCodeCliEnabled.value).toBe(false);
  });
});
