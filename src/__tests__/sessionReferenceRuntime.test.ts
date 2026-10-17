// @vitest-environment jsdom
import { createPinia } from "pinia";
import { createApp, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatTranscript from "../components/chat/ChatTranscript.vue";
import MarkdownRenderer from "../components/MarkdownRenderer.vue";
import { formatSessionReference } from "../composables/sessionReferences";
import { openSessionReference } from "../services/sessionReference";

const mocks = vi.hoisted(() => ({ open: vi.fn(), notice: vi.fn(), external: vi.fn() }));
vi.mock("../services/chatSessionWindow", () => ({ openChatSessionWindow: mocks.open }));
vi.mock("../stores/notification", () => ({ useNotificationStore: () => ({ addNotice: mocks.notice }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.external }));

let app: App | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  mocks.open.mockReset().mockResolvedValue(true);
  mocks.notice.mockReset();
  mocks.external.mockReset();
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => { app?.unmount(); app = null; host.remove(); });

describe("session reference activation", () => {
  it.each(["plain", "asset"] as const)("renders and opens persisted references in %s user messages", async (userContentMode) => {
    const content = `参考 ${formatSessionReference("previous-id", "旧会话 [Shader]")} 继续`;
    app = createApp({ render: () => h(ChatTranscript, {
      messages: [{ id: "m", role: "user", content, createdAt: 1 }], userContentMode,
      streamingText: "", isStreaming: false, isThinking: false, activeToolCalls: [],
    }) });
    app.use(createPinia());
    app.mount(host);
    await nextTick();
    const link = host.querySelector<HTMLAnchorElement>(".session-reference")!;
    expect(link.textContent).toBe("旧会话 [Shader]");
    expect(link.parentElement?.textContent?.trim()).toBe("参考 旧会话 [Shader] 继续");
    link.click();
    await nextTick();
    expect(mocks.open).toHaveBeenCalledWith({ sessionId: "previous-id", title: "旧会话 [Shader]" });
    expect(mocks.external).not.toHaveBeenCalled();
  });

  it("opens assistant Markdown links through the same session window, without external navigation", async () => {
    app = createApp({ render: () => h(MarkdownRenderer, { content: formatSessionReference("previous-id", "Shader 调试") }) });
    app.use(createPinia());
    app.mount(host);
    await nextTick();
    const link = host.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe("#locus-session/previous-id");
    link.click();
    await nextTick();
    expect(mocks.open).toHaveBeenCalledWith({ sessionId: "previous-id", title: "Shader 调试" });
    expect(mocks.external).not.toHaveBeenCalled();
  });

  it("reports an unavailable window without an unhandled rejection", async () => {
    mocks.open.mockRejectedValue(new Error("window failed"));
    await openSessionReference("previous-id", "Shader");
    expect(mocks.notice).toHaveBeenCalledWith("error", expect.stringContaining("window failed"), expect.any(Object));
    mocks.open.mockResolvedValue(false);
    await openSessionReference("previous-id", "Shader");
    expect(mocks.notice).toHaveBeenCalledTimes(2);
  });
});
