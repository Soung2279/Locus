// @vitest-environment jsdom
import { createApp, defineComponent, h, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provideInternalDragController, useInternalDragController, type InternalDragController } from "../composables/useInternalDrag";
import { useWorkspaceFileOrderDrop } from "../composables/useWorkspaceFileOrderDrop";

vi.mock("../stores/notification", () => ({ useNotificationStore: () => ({ addNotice: vi.fn() }) }));
let app: App | undefined;
let drag: InternalDragController;
afterEach(() => { drag?.dispose(); app?.unmount(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function pointer(type: string, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: 50, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
  return event as PointerEvent;
}

describe("workspace file order drop", () => {
  it.each(["new-session", "folder"])("keeps %s center actions separate from row-edge sorting", (kind) => {
    const move = vi.fn().mockResolvedValue(undefined), insideDrop = vi.fn();
    const scope = { projectId: "project", workspaceRef: { checkoutId: "checkout" } };
    const source = { ...scope, item: "file:a.txt" };
    const List = defineComponent({ setup() {
      const root = ref<HTMLElement | null>(null);
      const controller = useInternalDragController();
      useWorkspaceFileOrderDrop({ root: () => root.value, source: () => source,
        row: hit => hit.closest("[data-target]") ? { ...scope, item: "node:target", element: hit as HTMLElement,
          folder: kind === "folder", insideDrop: kind === "new-session" } : null,
        move,
      });
      return () => h("div", { ref: root }, [h("button", {
        onPointerdown: (event: PointerEvent) => controller.start(event, {
          id: "source", payload: { type: "file", data: null }, preview: { label: "a.txt" },
        }),
      }, "a.txt"), h("div", { "data-target": "" }, kind)]);
    } });
    const host = document.createElement("div"); document.body.append(host);
    app = createApp({ setup() { drag = provideInternalDragController(); return () => h(List); } }); app.mount(host);
    const target = host.querySelector<HTMLElement>("[data-target]")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 247, 27));
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    drag.registerTarget({ id: "inside", root: () => target, accepts: () => true,
      resolve: () => ({ key: "attach", operation: "copy", intent: null }), drop: insideDrop });
    host.querySelector("button")!.dispatchEvent(pointer("pointerdown", 50));
    window.dispatchEvent(pointer("pointermove", 102));
    expect(target.classList.contains("is-pin-drop-before")).toBe(true);
    window.dispatchEvent(pointer("pointermove", 126));
    expect(target.classList.contains("is-pin-drop-after")).toBe(true);
    window.dispatchEvent(pointer("pointermove", 113));
    expect(target.classList.contains("is-pin-drop-after")).toBe(false);
    expect(drag.activeTarget.value?.registrationId).toBe("inside");
    window.dispatchEvent(pointer("pointerup", 113));
    expect(insideDrop).toHaveBeenCalledOnce();
    expect(move).not.toHaveBeenCalled();
  });
});
