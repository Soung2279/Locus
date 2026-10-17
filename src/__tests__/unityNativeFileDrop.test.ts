// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installUnityNativeFileDrop } from "../services/unityNativeFileDrop";

describe("raw WebView2 file drops", () => {
  it("passes native File objects with the current generation and releases listeners", () => {
    const document = new EventTarget();
    const window = new EventTarget();
    const bridge = { postMessage: vi.fn(), postMessageWithAdditionalObjects: vi.fn() };
    Object.assign(window, { document });
    const release = installUnityNativeFileDrop(window as unknown as Window, "generation-a");
    // The related document can be returned before the SDK injects its bridge.
    Object.assign(window, { chrome: { webview: bridge } });
    const file = new File(["fixture"], "fixture.txt");
    const event = (type: string) => Object.assign(new Event(type, { cancelable: true }), {
      clientX: 14, clientY: 28, dataTransfer: { files: [file], types: ["Files"], items: [file], dropEffect: "none" },
    });
    document.dispatchEvent(event("dragover"));
    const drop = event("drop"); document.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(bridge.postMessageWithAdditionalObjects).toHaveBeenCalledWith({ type: "native-file-drop", generation: "generation-a", x: 14, y: 28 }, [file]);
    release();
    document.dispatchEvent(event("drop"));
    expect(bridge.postMessageWithAdditionalObjects).toHaveBeenCalledTimes(1);
  });
});
