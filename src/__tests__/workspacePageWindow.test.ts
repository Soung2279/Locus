
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
  buildWorkspacePageWindowQuery,
  buildWorkspacePageWindowUrl,
  getWorkspacePageWindowPayload,
  isWorkspacePageWindowLocation,
  openWorkspacePageWindow,
  workspacePageWindowKind,
  type WorkspacePageWindowPayload,
} from "../services/workspacePageWindow";

function stubTauriWindow() {
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
}

const checkoutPayload = (
  checkoutId: string,
  page: "chat" | "knowledge" | "collab" | "asset" | "views" | "agent" = "knowledge",
): Extract<WorkspacePageWindowPayload, { scope: "checkout" }> => ({
  scope: "checkout",
  page,
  checkoutId,
  workspaceGeneration: 7,
  title: `${page} title`,
});

describe("workspacePageWindow", () => {
  beforeEach(() => {
    subWindowMocks.invokeMock.mockReset();
    subWindowMocks.getByLabelMock.mockReset();
    subWindowMocks.getByLabelMock.mockResolvedValue(null);
    stubTauriWindow();
  });

  it("round-trips checkout and app payloads without an implicit workspace", () => {
    const checkout = checkoutPayload("checkout-A/unsafe?");
    const checkoutUrl = buildWorkspacePageWindowUrl(checkout);
    const checkoutSearch = checkoutUrl.slice(checkoutUrl.indexOf("?"));
    expect(checkoutUrl).toContain("/window.html?workspacePageWindow=1");
    expect(isWorkspacePageWindowLocation({ search: checkoutSearch } as Location)).toBe(true);
    expect(getWorkspacePageWindowPayload(checkoutSearch)).toEqual(checkout);

    const app: WorkspacePageWindowPayload = {
      scope: "app",
      page: "plugins",
      title: "插件",
    };
    const appQuery = buildWorkspacePageWindowQuery(app);
    expect(getWorkspacePageWindowPayload(`?${appQuery}`)).toEqual(app);
    expect(appQuery).not.toContain("checkoutId");
    expect(appQuery).not.toContain("workspaceGeneration");
  });

  it("keeps the same checkout page independent across A and B", () => {
    const kindA = workspacePageWindowKind(checkoutPayload("checkout-a"));
    const kindB = workspacePageWindowKind(checkoutPayload("checkout-b"));

    expect(kindA).not.toBe(kindB);
    expect(kindA).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(kindB).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(workspacePageWindowKind({
      ...checkoutPayload("checkout-a"),
      workspaceGeneration: 8,
    })).not.toBe(kindA);
    const agentKind = workspacePageWindowKind(checkoutPayload("checkout-a", "agent"));
    expect(agentKind).toContain("workspace-page-agent-");
  });

  it("round-trips the global search settings destination for auxiliary workbenches", () => {
    const payload: WorkspacePageWindowPayload = {
      scope: "app", page: "settings", title: "全局搜索", settingsCategory: "globalSearch",
    };
    const query = buildWorkspacePageWindowQuery(payload);
    expect(getWorkspacePageWindowPayload(`?${query}`)).toEqual(payload);
    expect(getWorkspacePageWindowPayload(`?${query.replace("globalSearch", "unknown")}`))
      .toEqual({ scope: "app", page: "settings", title: "全局搜索" });
  });

  it("maps legacy app URLs and rejects legacy checkout ambiguity", () => {
    expect(getWorkspacePageWindowPayload("?workspacePageWindow=1&page=settings&title=设置"))
      .toEqual({ scope: "app", page: "settings", title: "设置" });
    expect(getWorkspacePageWindowPayload("?workspacePageWindow=1&page=knowledge&title=知识"))
      .toBeNull();
    expect(isWorkspacePageWindowLocation({
      search: "?workspacePageWindow=1&page=knowledge",
    } as Location)).toBe(false);
  });

  it("rejects cross-scope pages and malformed checkout identities", () => {
    expect(getWorkspacePageWindowPayload(
      "?workspacePageWindow=1&scope=checkout&page=settings&checkoutId=a&workspaceGeneration=1",
    )).toBeNull();
    expect(getWorkspacePageWindowPayload(
      "?workspacePageWindow=1&scope=app&page=knowledge",
    )).toBeNull();
    expect(getWorkspacePageWindowPayload(
      "?workspacePageWindow=1&scope=app&page=agent&workspaceGeneration=x",
    )).toBeNull();
    expect(getWorkspacePageWindowPayload(
      "?workspacePageWindow=1&scope=checkout&page=knowledge&checkoutId=a&workspaceGeneration=x",
    )).toBeNull();
    expect(() => buildWorkspacePageWindowQuery({
      scope: "checkout",
      page: "settings",
      checkoutId: "checkout-a",
      workspaceGeneration: 1,
      title: "invalid",
    } as unknown as WorkspacePageWindowPayload)).toThrow("Invalid workspace page window payload");
  });

  it("opens a checkout-bound resizable standalone window", async () => {
    const payload = checkoutPayload("checkout-a", "asset");
    subWindowMocks.invokeMock.mockResolvedValue({
      label: workspacePageWindowKind(payload),
      existing: false,
      pooled: false,
    });

    await expect(openWorkspacePageWindow(payload)).resolves.toBe(true);

    expect(subWindowMocks.invokeMock).toHaveBeenCalledWith("sub_window_open", {
      request: expect.objectContaining({
        kind: workspacePageWindowKind(payload),
        title: "Locus - asset title",
        width: 1280,
        height: 820,
        minimizable: true,
        closable: true,
        query: expect.stringContaining("checkoutId=checkout-a"),
      }),
    });
  });
});
