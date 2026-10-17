import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const key = "locus:composer-recovery:v1";
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), clear: () => data.clear() });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("native host composer recovery", () => {
  it("restores session-only attachments after a renderer reload", async () => {
    let drafts = await import("../composables/chatComposerDraftMemory");
    drafts.enableComposerDraftRecovery();
    drafts.writeSharedComposerDraft("session-attachments", {
      text: "", images: [], assetRefs: [], localFiles: [], consoleTexts: [],
      sessionRefs: [{ sessionId: "previous", title: "历史会话" }], intent: { mode: "build", skills: [] },
    });
    await vi.advanceTimersByTimeAsync(200);
    vi.resetModules();
    drafts = await import("../composables/chatComposerDraftMemory");
    drafts.enableComposerDraftRecovery();
    expect(drafts.readSharedComposerDraft("session-attachments")?.sessionRefs)
      .toEqual([{ sessionId: "previous", title: "历史会话" }]);
  });
  it("coalesces writes and restores text after the Vue owner module is recreated", async () => {
    let drafts = await import("../composables/chatComposerDraftMemory");
    drafts.enableComposerDraftRecovery();
    drafts.updateSharedComposerDraftText("workspace:session", "first");
    drafts.updateSharedComposerDraftText("workspace:session", "latest");
    expect(sessionStorage.getItem(key)).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    vi.resetModules();
    drafts = await import("../composables/chatComposerDraftMemory");
    drafts.enableComposerDraftRecovery();
    expect(drafts.readSharedComposerDraft("workspace:session")?.text).toBe("latest");
    drafts.clearSharedComposerDraft("workspace:session");
    await vi.advanceTimersByTimeAsync(200);
    expect(JSON.parse(sessionStorage.getItem(key)!).drafts).toEqual([]);
  });
  it("bounds retained data and remains usable with malformed recovery records", async () => {
    sessionStorage.setItem(key, JSON.stringify({ version: 1, drafts: [["bad", {}]] }));
    const drafts = await import("../composables/chatComposerDraftMemory");
    drafts.enableComposerDraftRecovery();
    expect(drafts.readSharedComposerDraft("bad")).toBeNull();
    drafts.updateSharedComposerDraftText("large", "x".repeat(1100000));
    drafts.updateSharedComposerDraftText("small", "keep");
    await vi.advanceTimersByTimeAsync(200);
    expect(sessionStorage.getItem(key)!.length).toBeLessThan(1024 * 1024);
    expect(JSON.parse(sessionStorage.getItem(key)!).drafts.map((v: [string]) => v[0])).toEqual(["small"]);
    expect(drafts.readSharedComposerDraft("large")?.text.length).toBe(1100000);
  });
});
