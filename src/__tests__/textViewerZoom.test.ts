// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import AssetTextViewer from "../components/asset/AssetTextViewer.vue";
import {
  normalizeTextViewerZoomScale,
  resetTextViewerZoomScale,
  stepTextViewerZoomScale,
  TEXT_VIEWER_ZOOM_STORAGE_KEY,
} from "../composables/useTextViewerZoom";

let app: App<Element> | null = null;

beforeEach(() => {
  resetTextViewerZoomScale();
  document.body.replaceChildren();
});

afterEach(() => {
  app?.unmount();
  app = null;
  resetTextViewerZoomScale();
  document.body.replaceChildren();
});

describe("text viewer font zoom", () => {
  it("steps in bounded increments and treats missing storage as the default scale", () => {
    expect(normalizeTextViewerZoomScale(null)).toBe(1);
    expect(normalizeTextViewerZoomScale("invalid")).toBe(1);
    expect(normalizeTextViewerZoomScale(0.2)).toBe(0.7);
    expect(normalizeTextViewerZoomScale(4)).toBe(2);
    expect(stepTextViewerZoomScale(1, -120)).toBe(1.1);
    expect(stepTextViewerZoomScale(1, 120)).toBe(0.9);
    expect(stepTextViewerZoomScale(2, -120)).toBe(2);
  });

  it("zooms a read-only text viewer with Ctrl+wheel and suppresses WebView zoom", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp({
      render: () => h(AssetTextViewer, {
        snippet: "const value = 1;",
        truncated: false,
        totalLines: 1,
        language: "typescript",
      }),
    });
    app.mount(host);
    await nextTick();

    const root = host.querySelector<HTMLElement>(".atv-root")!;
    const body = host.querySelector<HTMLElement>(".atv-body")!;
    const zoomEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -120,
    });
    body.dispatchEvent(zoomEvent);
    await nextTick();

    expect(zoomEvent.defaultPrevented).toBe(true);
    expect(root.style.getPropertyValue("--text-viewer-font-scale")).toBe("1.1");
    expect(localStorage.getItem(TEXT_VIEWER_ZOOM_STORAGE_KEY)).toBe("1.1");

    app.unmount();
    app = createApp({
      render: () => h(AssetTextViewer, {
        snippet: "second file",
        truncated: false,
        totalLines: 1,
        language: "text",
      }),
    });
    app.mount(host);
    await nextTick();
    expect(
      host.querySelector<HTMLElement>(".atv-root")?.style.getPropertyValue(
        "--text-viewer-font-scale",
      ),
    ).toBe("1.1");

    const scrollEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    host.querySelector<HTMLElement>(".atv-body")?.dispatchEvent(scrollEvent);
    expect(scrollEvent.defaultPrevented).toBe(false);
  });
});
