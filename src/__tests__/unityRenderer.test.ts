// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUnityRenderer } from "../services/unityRenderer";
import { installLocusRuntime } from "../services/locusRuntime";
import { measureRenderLayout } from "../services/unityRenderLayout";
import { createApp, h, nextTick, shallowRef } from "vue";
import UnityRenderSurface from "../components/unity-renderer/UnityRenderSurface.vue";
import type { UnityRenderOutput, UnityRenderSurfaceHandle } from "../services/unityRenderer";

const scope = { checkoutId: "project", expectedGeneration: 3, expectedMaterializationEpoch: 4 };
const reference = { id: "output", owner: "owner", domainGeneration: "domain" };
let uninstall: () => void;
const cleanups: Array<() => Promise<void>> = [];
let invoke = vi.fn();
function rect(element: HTMLElement, x: number, y: number, width: number, height: number) {
  element.getBoundingClientRect = () => ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON() { return {}; } });
}
function mountedElement() { const element = document.createElement("div"); document.body.append(element); rect(element, 100, 80, 400, 240); return element; }
beforeEach(() => {
  invoke = vi.fn(async (command) => command === "unity_renderer_create" ? reference : command === "unity_renderer_status" ? { state: "ready" } : undefined);
  uninstall = installLocusRuntime({ kind: "tauri", invoke, subscribe: async () => () => {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(async () => { await Promise.all(cleanups.splice(0).map((dispose) => dispose())); uninstall(); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function renderer(options = {}) { const api = createUnityRenderer(scope, options); cleanups.push(api.dispose); return api; }

describe("GPU output lifetime", () => {
  it("binds outputs to their display windows even when both use the opener's IPC", async () => {
    let sequence = 0;
    invoke.mockImplementation(async (command) => command === "unity_renderer_create" ? { ...reference, id: `output-${++sequence}` } : { state: "ready" });
    const main = await renderer({ windowLabel: "main" }).createOutput();
    const child = await renderer({ windowLabel: "workbench-shared-child" }).createOutput();
    expect(invoke.mock.calls.filter(([command]) => command === "unity_renderer_create").map(([, args]) => args)).toEqual([
      { workspaceRef: scope, windowLabel: "main" },
      { workspaceRef: scope, windowLabel: "workbench-shared-child" },
    ]);
    await main.mount(mountedElement());
    await child.mount(mountedElement());
    await child.dispose();
    expect(invoke).toHaveBeenCalledWith("unity_renderer_close", { workspaceRef: scope, output: { ...reference, id: child.id } }, expect.any(AbortSignal));
    await expect(main.status()).resolves.toEqual({ state: "ready" });
  });

  it("closes a late create reply when its View was disposed in flight", async () => {
    let finish!: (value: typeof reference) => void;
    invoke.mockImplementation((command) => command === "unity_renderer_create" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(undefined));
    const controller = new AbortController(), api = renderer({ signal: controller.signal });
    const pending = api.createOutput(); controller.abort(); finish(reference);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).toHaveBeenCalledWith("unity_renderer_close", { workspaceRef: scope, output: reference }, expect.any(AbortSignal));
  });
  it("detaches before closing and releases an output only once", async () => {
    const api = renderer(), output = await api.createOutput();
    await output.mount(mountedElement());
    await output.dispose(); await output.dispose();
    const operations = invoke.mock.calls.map(([command]) => command);
    expect(operations.filter((command) => command === "unity_renderer_close")).toHaveLength(1);
    expect(operations.indexOf("unity_renderer_detach")).toBeLessThan(operations.indexOf("unity_renderer_close"));
    await expect(output.status()).rejects.toThrow("closed");
  });
  it("rejects duplicate mounts and renderer ownership mismatches", async () => {
    const api = renderer(), other = renderer(), output = await api.createOutput(), element = mountedElement();
    await expect(other.mount(element, output)).rejects.toThrow("different renderer");
    await output.mount(element);
    await expect(output.mount(element)).rejects.toThrow("already mounted");
  });
  it("hides a native surface even when WebView animation frames are suspended", async () => {
    const output = await renderer().createOutput();
    await output.mount(mountedElement());
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(invoke).toHaveBeenCalledWith("unity_renderer_layout", expect.objectContaining({ layout: expect.objectContaining({ visible: false }) }), expect.any(AbortSignal));
  });
  it("cleans up a mount that completes after output disposal", async () => {
    const api = renderer(), output = await api.createOutput();
    let mounted!: () => void;
    invoke.mockImplementation((command) => command === "unity_renderer_mount" ? new Promise<void>((resolve) => { mounted = resolve; }) : Promise.resolve(undefined));
    const pending = output.mount(mountedElement());
    await output.dispose(); mounted();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke.mock.calls.filter(([command]) => command === "unity_renderer_detach")).toHaveLength(1);
  });
});

describe("native surface layout", () => {
  it("maps physical pixels and excludes DOM popovers", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const element = mountedElement(), menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu); rect(menu, 200, 100, 100, 80);
    const layout = measureRenderLayout(element);
    expect(layout.rect).toEqual({ x: 200, y: 160, width: 800, height: 480 });
    expect(layout.occluders).toContainEqual({ x: 400, y: 200, width: 200, height: 160 });
  });
  it("clips scrolling ancestors and hides detached/inactive views", () => {
    const parent = document.createElement("div"); parent.style.overflowX = "hidden"; parent.style.overflowY = "hidden"; document.body.append(parent); rect(parent, 120, 100, 200, 150);
    Object.defineProperties(parent, { clientWidth: { value: 200 }, clientHeight: { value: 150 }, offsetWidth: { value: 200 }, offsetHeight: { value: 150 } });
    const element = mountedElement(); parent.append(element);
    expect(measureRenderLayout(element).clip).toEqual({ x: 120, y: 100, width: 200, height: 150 });
    expect(measureRenderLayout(element, false).visible).toBe(false);
    element.remove(); expect(measureRenderLayout(element).visible).toBe(false);
  });
});

it("serializes component source changes while a native mount is still pending", async () => {
  let finish!: (handle: UnityRenderSurfaceHandle) => void;
  const firstHandle = { dispose: vi.fn(async () => {}), setVisible: vi.fn(), refreshLayout: vi.fn() };
  const secondHandle = { dispose: vi.fn(async () => {}), setVisible: vi.fn(), refreshLayout: vi.fn() };
  const first = { subscribe: () => () => {}, mount: vi.fn(() => new Promise<UnityRenderSurfaceHandle>((resolve) => { finish = resolve; })) } as unknown as UnityRenderOutput;
  const second = { subscribe: () => () => {}, mount: vi.fn(async () => secondHandle) } as unknown as UnityRenderOutput;
  const source = shallowRef(first);
  const app = createApp({ render: () => h(UnityRenderSurface, { source: source.value }) });
  app.mount(mountedElement());
  try {
    await vi.waitFor(() => expect(first.mount).toHaveBeenCalledOnce());
    source.value = second; await nextTick(); await Promise.resolve();
    expect(second.mount).not.toHaveBeenCalled();
    finish(firstHandle);
    await vi.waitFor(() => expect(second.mount).toHaveBeenCalledOnce());
    expect(firstHandle.dispose).toHaveBeenCalledOnce();
  } finally { app.unmount(); }
  await vi.waitFor(() => expect(secondHandle.dispose).toHaveBeenCalledOnce());
});
