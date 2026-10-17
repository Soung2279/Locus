// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provideWindowSurface } from "../composables/useWindowSurface";
import BaseContextMenu from "../components/ui/BaseContextMenu.vue";

const applications: App[] = [];
afterEach(() => { for (const app of applications.splice(0)) app.unmount(); document.body.replaceChildren(); });
describe("shared Vue document ownership", () => {
  it("renders menus and handles Escape in their owning document, then removes the listener", async () => {
    const frame = document.createElement("iframe"); document.body.append(frame);
    const owner = frame.contentWindow!; const closed = vi.fn();
    const container = document.createElement("div"); document.body.append(container);
    const app = createApp({ setup() {
      provideWindowSurface(owner, "unity");
      return () => h(BaseContextMenu, { x: 10, y: 20, onClose: closed }, () => h("button", "Action"));
    } });
    applications.push(app); app.mount(container); await nextTick();
    expect(document.querySelector(".base-context-menu")).toBeNull();
    expect(owner.document.querySelector(".base-context-menu")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); expect(closed).not.toHaveBeenCalled();
    owner.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); expect(closed).toHaveBeenCalledTimes(1);
    app.unmount(); applications.pop();
    owner.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); expect(closed).toHaveBeenCalledTimes(1);
    expect(owner.document.querySelector(".base-context-menu")).toBeNull();
  });
});
