// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { createViewExecutionScope } from "../components/view/viewExecutionScope";

const scope = () => createViewExecutionScope({ viewId: "test", editorId: crypto.randomUUID(), workspaceRef: { checkoutId: "test", expectedGeneration: 1 }, ownerWindow: window, binding: {}, active: ref(true), state: new Map(), log() {} });

describe("pooled native View execution", () => {
  it("isolates custom window globals between bindings and clears released state", () => {
    const first = scope(); const second = scope();
    const a = first.globals({}).window as Window & { viewState?: unknown };
    const b = second.globals({}).window as typeof a;
    a.viewState = { target: "first" };
    expect((first.globals({}).window as typeof a).viewState).toEqual({ target: "first" });
    expect(b.viewState).toBeUndefined();
    expect((window as typeof a).viewState).toBeUndefined();
    first.dispose(); expect(a.viewState).toBeUndefined();
    a.viewState = "late callback"; expect(a.viewState).toBeUndefined(); second.dispose();
  });
  it("disconnects a native View's observer and ignores callbacks after disposal", () => {
    let notify!: (...args: unknown[]) => void;
    const disconnect = vi.fn();
    const previous = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
    Object.defineProperty(window, "ResizeObserver", { configurable: true, value: class { constructor(callback: (...args: unknown[]) => void) { notify = callback; } disconnect = disconnect; } });
    const execution = scope(); const callback = vi.fn();
    try {
      const Observer = execution.globals({}).ResizeObserver as typeof ResizeObserver;
      new Observer(callback); notify([]); expect(callback).toHaveBeenCalledTimes(1);
      execution.dispose(); expect(disconnect).toHaveBeenCalledOnce(); notify([]); expect(callback).toHaveBeenCalledTimes(1);
    } finally { execution.dispose(); if (previous) Object.defineProperty(window, "ResizeObserver", previous); else Reflect.deleteProperty(window, "ResizeObserver"); }
  });
});
