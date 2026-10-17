// @vitest-environment jsdom
import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactedContextOutput } from "../types";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: vi.fn(), destroy: vi.fn() }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../services/session", () => ({ getCompactedContextOutput: mocks.load }));
vi.mock("../services/subWindow", () => ({ getSubWindowClaimedQuery: vi.fn(async () => null) }));
vi.mock("../services/contextCompactionWindow", () => ({
  CONTEXT_COMPACTION_WINDOW_EVENT: "compact", CONTEXT_COMPACTION_WINDOW_LABEL: "compact",
  getContextCompactionWindowPayload: () => ({ sessionId: "session", messageId: "compact" }),
}));
vi.mock("../i18n", () => ({ t: (key: string) => key }));
vi.mock("../components/MarkdownRenderer.vue", () => ({
  default: { props: ["content"], template: '<article class="native-markdown">{{ content }}</article>' },
}));
vi.mock("../components/AssetChip.vue", () => ({ default: { template: "<span />" } }));
vi.mock("../components/icons/LucideIcon.vue", () => ({ default: { template: "<span />" } }));

import ContextCompactionWindow from "../components/ContextCompactionWindow.vue";

let app: App | undefined;
const nativeText = "This session is being continued from a previous conversation.\n\n## Summary\nNative content.";
function fixture(kind = "claudeNative"): CompactedContextOutput {
  return { messageId: "compact", compactionKind: kind, snapshotStatus: "complete", checkpoint: "empty",
    messages: [{ id: "compact", role: "user", content: nativeText, promptPrefixPlaceholder: false, promptSuffixPlaceholder: false }] };
}
async function mount(output: CompactedContextOutput) {
  mocks.load.mockResolvedValue(output);
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(ContextCompactionWindow);
  app.mount(root);
  await Promise.resolve();
  await nextTick();
  return root;
}
beforeEach(() => mocks.load.mockReset());
afterEach(() => { app?.unmount(); app = undefined; document.body.replaceChildren(); });

describe("native Claude compact preview", () => {
  it("renders only the original provider result without local roles or system placeholders", async () => {
    const root = await mount(fixture());
    expect(root.querySelector(".compacted-context-title")?.textContent).toBe("chat.compactedContext.claudeNativeTitle");
    expect(root.querySelector(".native-markdown")?.textContent).toBe(nativeText);
    expect(root.querySelector(".compacted-context-role")).toBeNull();
    expect(root.querySelector(".compacted-context-injection-placeholder")).toBeNull();
    expect(root.textContent).not.toContain("systemPlaceholder");
    expect(root.textContent).not.toContain("Context Handoff");
  });

  it("does not render a local fallback or empty sentinel as native output", async () => {
    const output = fixture(); output.snapshotStatus = "partial"; output.messages[0]!.content = "empty";
    const root = await mount(output);
    expect(root.textContent).toContain("chat.compactedContext.nativeUnavailable");
    expect(root.querySelector(".native-markdown")).toBeNull();
  });

  it("keeps the existing context layout for other providers", async () => {
    const output = fixture("readable"); output.messages[0]!.promptPrefixPlaceholder = true;
    const root = await mount(output);
    expect(root.querySelector(".compacted-context-title")?.textContent).toBe("chat.compactedContext.windowTitle");
    expect(root.textContent).toContain("chat.compactedContext.systemPlaceholder");
    expect(root.querySelector(".compacted-context-injection-placeholder")).not.toBeNull();
    expect(root.querySelector(".native-markdown")?.textContent).toBe(nativeText);
  });
});
