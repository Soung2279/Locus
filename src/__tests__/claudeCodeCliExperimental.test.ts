import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const read = (relPath: string) => readFileSync(resolve(process.cwd(), relPath), "utf8");

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

  it("is configured from experimental settings instead of model defaults", () => {
    const experimental = read("src/components/settings/ExperimentalSettings.vue");
    const modelDefaults = read("src/components/settings/ModelDefaults.vue");
    const apiProviders = read("src/components/settings/ApiProviders.vue");
    const types = read("src/types.ts");
    const system = read("src-tauri/src/commands/system.rs");
    const lib = read("src-tauri/src/lib.rs");

    expect(experimental).toContain("setClaudeCodeCliEnabled");
    expect(experimental).toContain("settings.experimental.claudeCodeCliDesc");
    expect(modelDefaults).not.toContain("claudeCodeEnable");
    expect(modelDefaults).not.toContain('type="checkbox"');
    expect(types).not.toContain("claudeCodeEnabled");
    expect(apiProviders).toContain("claudeCodeCliEnabled && claudeCodeProvider");
    expect(system).toContain("CLAUDE_CODE_CLI_ENABLED_CHANGED_EVENT");
    expect(lib).toContain("commands::set_claude_code_cli_enabled");
  });
});
