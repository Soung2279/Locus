// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import InternalDragOverlay from "../components/ui/InternalDragOverlay.vue";
import { provideInternalDragController, type InternalDragController } from "../composables/useInternalDrag";

let app: App | undefined;
let drag: InternalDragController;
afterEach(() => {
  drag?.dispose();
  app?.unmount();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
  return event as PointerEvent;
}

describe("internal drag overlay", () => {
  it("preserves the latest raw pointer position across rerenders and inline target transitions", async () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1400);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(900);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.body });
    const host = document.createElement("div");
    document.body.append(host);
    app = createApp({ setup() {
      drag = provideInternalDragController();
      return () => [h("button", {
        onPointerdown: (event: PointerEvent) => drag.start(event, {
          id: "file", payload: { type: "file", data: null }, preview: { label: "File.txt", kind: "file" },
        }),
      }, "File.txt"), h(InternalDragOverlay)];
    } });
    app.mount(host);
    host.querySelector("button")!.dispatchEvent(pointer("pointerdown", 10, 10));
    window.dispatchEvent(pointer("pointermove", 90, 383));
    await nextTick();
    const preview = () => document.querySelector<HTMLElement>("[data-internal-drag-preview]");
    expect(preview()?.style.transform).toBe("translate3d(98px, 389px, 0)");

    window.dispatchEvent(pointer("pointerrawupdate", 120, 410));
    expect(drag.point.value).toEqual({ x: 90, y: 383 });
    drag.activeTarget.value = { registrationId: "other", decision: { key: "other", operation: "copy", intent: null } };
    await nextTick();
    expect(preview()?.style.transform).toBe("translate3d(128px, 416px, 0)");

    const marker = document.createElement("div");
    marker.className = "is-pin-drop-after";
    vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 393, 247, 27));
    host.append(marker);
    drag.activeTarget.value = { registrationId: "row", decision: { key: "after", operation: "move", intent: null } };
    await nextTick();
    expect(preview()?.style.transform).toBe("translate3d(128px, 423px, 0)");
    marker.remove();

    drag.previewMode.value = "inline";
    await nextTick();
    expect(preview()).toBeNull();
    window.dispatchEvent(pointer("pointerrawupdate", 150, 440));
    drag.previewMode.value = "floating";
    await nextTick();
    expect(preview()?.style.transform).toBe("translate3d(158px, 446px, 0)");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(preview()).toBeNull();
  });
});
