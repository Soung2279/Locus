
import { beforeEach, describe, expect, it, vi } from "vitest";

const subWindowMocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getByLabelMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: subWindowMocks.invokeMock,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(() => ({ label: "main" })),
  WebviewWindow: class {
    static getByLabel = subWindowMocks.getByLabelMock;
  },
}));

import {
  KNOWLEDGE_MARKDOWN_PREVIEW_WINDOW_EVENT,
  buildKnowledgeMarkdownPreviewWindowUrl,
  getKnowledgeMarkdownPreviewWindowPayload,
  openKnowledgeMarkdownPreviewWindow,
} from "../services/knowledgeMarkdownPreviewWindow";

describe("knowledgeMarkdownPreviewWindow", () => {
  const payload = {
    docType: "memory" as const,
    path: "memory/project-notes.md",
    workspaceRef: { checkoutId: "checkout-feature", expectedGeneration: 7 },
  };

  beforeEach(() => {
    subWindowMocks.invokeMock.mockReset();
    subWindowMocks.getByLabelMock.mockReset();
    subWindowMocks.getByLabelMock.mockResolvedValue(null);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { pathname: "/", search: "" },
        __TAURI_INTERNALS__: {
          invoke: vi.fn(),
          metadata: { currentWindow: { label: "main" } },
        },
      },
    });
  });

  it("builds and parses lightweight-window URLs", () => {
    const url = buildKnowledgeMarkdownPreviewWindowUrl(payload);

    expect(url).toContain("/window.html?knowledgeMarkdownPreview=1");
    expect(getKnowledgeMarkdownPreviewWindowPayload(url.slice(url.indexOf("?")))).toEqual(payload);
  });

  it("updates an existing Markdown preview window", async () => {
    subWindowMocks.invokeMock.mockResolvedValue({
      label: "sub-pool-4",
      existing: true,
      pooled: false,
    });
    const existingWindow = { emit: vi.fn() };
    subWindowMocks.getByLabelMock.mockResolvedValue(existingWindow);

    await openKnowledgeMarkdownPreviewWindow(payload);

    expect(existingWindow.emit).toHaveBeenCalledWith(
      KNOWLEDGE_MARKDOWN_PREVIEW_WINDOW_EVENT,
      payload,
    );
  });

  it("opens through the shared sub-window route", async () => {
    subWindowMocks.invokeMock.mockResolvedValue({
      label: "knowledge-markdown-preview",
      existing: false,
      pooled: false,
    });

    await expect(openKnowledgeMarkdownPreviewWindow(payload)).resolves.toBe(true);
    expect(subWindowMocks.invokeMock).toHaveBeenCalledWith("sub_window_open", {
      request: expect.objectContaining({
        kind: expect.stringMatching(/^knowledge-markdown-preview-/),
        query: expect.stringContaining("path=memory%2Fproject-notes.md"),
        width: 920,
        height: 720,
      }),
    });
  });
});
