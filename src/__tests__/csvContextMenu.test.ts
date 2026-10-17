// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import CsvContextMenu from "../components/csv/CsvContextMenu.vue";

let app: App | undefined;
async function flush() { for (let index = 0; index < 8; index++) { await Promise.resolve(); await nextTick(); } }
async function mount() {
  const host = document.createElement("div"); document.body.append(host);
  const onAction = vi.fn(), onClose = vi.fn(), insert = vi.fn();
  app = createApp({ render: () => h(CsvContextMenu, { x: 800, y: 80, onAction, onClose, items: [
    { label: "Save", disabled: true, action: vi.fn() },
    { label: "Insert", children: [
      { label: "Unavailable", disabled: true, action: vi.fn() },
      { label: "Row above", action: insert },
      { separator: true },
      { label: "Column left", action: vi.fn() },
    ] },
    { label: "Copy", action: vi.fn() },
  ] }) });
  app.mount(host); await flush();
  return { onAction, onClose, insert, trigger: document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')! };
}
function key(value: string) {
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
}
afterEach(() => { app?.unmount(); app = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); vi.useRealTimers(); });

describe("CSV grouped context menu", () => {
  it("supports keyboard entry, navigation, return and activation without running the group", async () => {
    const { trigger, onAction, onClose, insert } = await mount();
    expect(document.activeElement).toBe(trigger);
    key("ArrowRight"); await flush();
    expect(document.activeElement?.textContent).toBe("Row above");
    key("ArrowDown"); expect(document.activeElement?.textContent).toBe("Column left");
    key("ArrowUp"); expect(document.activeElement?.textContent).toBe("Row above");
    key("ArrowLeft"); await flush();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onAction).not.toHaveBeenCalled();
    trigger.click(); await flush();
    (document.activeElement as HTMLButtonElement).click();
    expect(onAction).toHaveBeenCalledWith(insert);
    key("Escape"); expect(onClose).toHaveBeenCalled();
  });

  it("flips a submenu to the left near the viewport edge and keeps it open while the pointer crosses", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("csv-context-submenu")
        ? new DOMRect(0, 0, 200, 100) : new DOMRect(780, 80, 150, 90);
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("csv-context-submenu") ? 208 : 260;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
    const { trigger } = await mount();
    expect(document.querySelector<HTMLElement>(".csv-context-menu")!.style.left).toBe(`${window.innerWidth - 260 - 8}px`);
    trigger.dispatchEvent(new MouseEvent("mouseenter")); await flush();
    const submenu = document.querySelector<HTMLElement>(".csv-context-submenu")!;
    expect(submenu.style.left).toBe("573px");
    document.querySelector(".csv-context-menu")!.dispatchEvent(new MouseEvent("mouseleave"));
    await vi.advanceTimersByTimeAsync(80);
    submenu.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.advanceTimersByTimeAsync(250);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    submenu.dispatchEvent(new MouseEvent("mouseleave"));
    await vi.advanceTimersByTimeAsync(250);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
