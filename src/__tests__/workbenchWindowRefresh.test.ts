// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSharedWorkbenchWindowRefresh } from "../services/workbenchWindowRefresh";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((dispose) => dispose()); vi.restoreAllMocks(); });

function fixture(refresh = vi.fn(async () => {})) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const child = frame.contentWindow!;
  cleanup.push(() => frame.remove());
  cleanup.push(installSharedWorkbenchWindowRefresh(child, refresh));
  const input = child.document.createElement("input");
  input.value = "unsaved";
  child.document.body.append(input);
  const press = (options: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...options });
    input.dispatchEvent(event);
    return event;
  };
  return { child, input, press, refresh };
}

describe("shared Workbench window refresh", () => {
  it.each<KeyboardEventInit>([
    { key: "F5" }, { key: "F5", ctrlKey: true }, { key: "F5", shiftKey: true },
    { key: "r", ctrlKey: true }, { key: "R", ctrlKey: true, shiftKey: true },
    { key: "r", metaKey: true }, { key: "R", metaKey: true, shiftKey: true },
  ])("refreshes the View without navigating the child document: %j", async (options) => {
    const { input, press, refresh } = fixture();
    const editorKeydown = vi.fn();
    input.addEventListener("keydown", editorKeydown);
    expect(press(options).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(editorKeydown).not.toHaveBeenCalled();
    expect(input.value).toBe("unsaved");
    expect(input.isConnected).toBe(true);
  });

  it("leaves ordinary keys and main-window refresh alone", () => {
    const { press, refresh } = fixture();
    for (const options of [{ key: "r" }, { key: "F12" }, { key: "r", ctrlKey: true, altKey: true }]) {
      expect(press(options).defaultPrevented).toBe(false);
    }
    const mainEvent = new KeyboardEvent("keydown", { key: "F5", cancelable: true });
    window.dispatchEvent(mainEvent);
    expect(mainEvent.defaultPrevented).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("consumes repeated refresh keys while a View is loading and allows another refresh after failure", async () => {
    let fail!: (error: Error) => void;
    const refresh = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { press } = fixture(refresh);
    expect(press({ key: "F5", repeat: true }).defaultPrevented).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    press({ key: "F5" });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(press({ key: "r", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    fail(new Error("failed"));
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    press({ key: "F5" });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    fail(new Error("failed again"));
    await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(2));
  });

  it("removes its listener when the shared host unmounts", () => {
    const { press, refresh } = fixture();
    cleanup.pop()!();
    expect(press({ key: "F5" }).defaultPrevented).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("cancels a queued refresh when the shared host unmounts", async () => {
    const { press, refresh } = fixture();
    press({ key: "F5" });
    cleanup.pop()!();
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
  });
});
