// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const key = "locus-new-session-settings";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe("new session settings", () => {
  it.each([null, "{invalid", "null", '{"defaultAgentId":42}'])(
    "uses the workspace default for absent or invalid settings: %s",
    async (saved) => {
      if (saved !== null) localStorage.setItem(key, saved);
      const { useNewSessionSettings } = await import("../composables/useNewSessionSettings");
      expect(useNewSessionSettings().state.defaultAgentId).toBe("");
    },
  );

  it("persists an explicit Agent and the workspace-default choice across reloads", async () => {
    const first = (await import("../composables/useNewSessionSettings")).useNewSessionSettings();
    first.setDefaultAgentId(" simple ");
    vi.resetModules();
    const second = (await import("../composables/useNewSessionSettings")).useNewSessionSettings();
    expect(second.state.defaultAgentId).toBe("simple");
    second.setDefaultAgentId("");
    vi.resetModules();
    expect((await import("../composables/useNewSessionSettings")).useNewSessionSettings().state.defaultAgentId).toBe("");
  });

  it("remembers the last choice by default and seeds it from a pre-migration Agent", async () => {
    const fresh = (await import("../composables/useNewSessionSettings")).useNewSessionSettings();
    expect(fresh.state.agentMode).toBe("remember");
    localStorage.setItem(key, JSON.stringify({ defaultAgentId: "simple" }));
    vi.resetModules();
    const migrated = (await import("../composables/useNewSessionSettings")).useNewSessionSettings();
    expect(migrated.state).toMatchObject({ agentMode: "remember", legacyAgentId: "simple" });
    migrated.setAgentMode("workspace");
    vi.resetModules();
    const reloaded = (await import("../composables/useNewSessionSettings")).useNewSessionSettings();
    expect(reloaded.state.agentMode).toBe("workspace");
    reloaded.setDefaultAgentId("unity");
    expect(reloaded.state).toMatchObject({ agentMode: "fixed", defaultAgentId: "unity" });
    reloaded.setDefaultAgentId("");
    expect(reloaded.state.agentMode).toBe("workspace");
  });

  it("syncs detached windows and clears the saved preference on reset", async () => {
    const settings = (await import("../composables/useNewSessionSettings")).useNewSessionSettings();
    localStorage.setItem(key, JSON.stringify({ defaultAgentId: "simple" }));
    window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(settings.state.defaultAgentId).toBe("simple");
    settings.reset();
    expect(settings.state.defaultAgentId).toBe("");
    expect(localStorage.getItem(key)).toBeNull();
    settings.setDefaultAgentId("unity");
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(settings.state.defaultAgentId).toBe("");
  });
});
