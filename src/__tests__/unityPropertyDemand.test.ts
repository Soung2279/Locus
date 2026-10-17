// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import { createPinia } from "pinia";
import UnityPropertyScope from "../components/unity/UnityPropertyScope.vue";
import UnityPropertyField from "../components/unity/UnityPropertyField.vue";
import { createUnityPropertyRuntime, type UnityBoundPropertyReadRequest } from "../components/unity/unityPropertyBinding";
import { createPropertyReadCoordinator } from "../services/propertyReadCoordinator";
const apps: App[] = [];
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); document.body.innerHTML = ""; });
const target = { kind: "asset", path: "Assets/Test.asset", propertyPath: "speed" };
const snapshot = (request: UnityBoundPropertyReadRequest, value = 1) => ({ ok: true, message: "", target: request.target, bindingId: request.bindingId,
  propertyPath: request.target.propertyPath ?? "", displayName: request.target.propertyPath || "Object", valueType: "Float", value, editable: true, children: [] });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); await nextTick(); };
function setup() {
  let value = 1;
  const one = vi.fn(async (request: UnityBoundPropertyReadRequest) => snapshot(request, value));
  const many = vi.fn(async (requests: UnityBoundPropertyReadRequest[]) => requests.map(request => snapshot(request, value)));
  const reads = createPropertyReadCoordinator(one, many);
  const runtime = createUnityPropertyRuntime({ read: reads.read, write: async request => {
    const beforeSnapshot = snapshot(request, value); value = Number(request.value);
    return { ...snapshot(request, value), saved: true, beforeSnapshot };
  }, apply: async () => ({ ok: true, results: [] }) });
  return { one, many, reads, runtime };
}
describe("component-driven property data", () => {
  it("collects nine displayed fields into one batch without a separate field manifest", async () => {
    const { runtime, one, many } = setup();
    const host = document.createElement("div"); document.body.append(host);
    const app = createApp({ render: () => h(UnityPropertyScope, { target: { ...target, propertyPath: "" }, runtime },
      () => Array.from({ length: 9 }, (_, i) => h(UnityPropertyField, { path: `field${i}` }))) });
    app.use(createPinia()); apps.push(app); app.mount(host); await flush();
    expect(one).not.toHaveBeenCalled(); expect(many).toHaveBeenCalledTimes(1);
    expect(many.mock.calls[0][0]).toHaveLength(9);
    expect(host.querySelectorAll("input"), host.innerHTML).toHaveLength(9);
    expect(host.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
  });
  it("shares a binding across controls and keeps accepted values through tab reactivation", async () => {
    const { runtime, one } = setup(); runtime.observeDataVersion("domain:1");
    const a = runtime.bind(target), b = runtime.bind({ ...target });
    expect(a).toBe(b);
    const off = a.retain(); await flush(); await a.write(7);
    expect(b.value).toBe(7); expect(one).toHaveBeenCalledTimes(1);
    off(); const off2 = b.retain(); await flush(); expect(one).toHaveBeenCalledTimes(1); off2();
  });
  it("invalidates active data on external changes and defers inactive data until needed", async () => {
    const { runtime, many, one } = setup(); runtime.observeDataVersion("domain:1");
    const a = runtime.bind(target), b = runtime.bind({ ...target, propertyPath: "other" });
    const off = a.retain(); const offB = b.retain(); await flush(); offB();
    runtime.observeDataVersion("domain:2"); await flush();
    expect(many).toHaveBeenCalledTimes(1); expect(one).toHaveBeenCalledTimes(1);
    b.retain()(); await flush(); expect(one).toHaveBeenCalledTimes(2); off();
  });
  it("defers hidden Workbench data and revalidates when the View becomes active", async () => {
    const { runtime, one } = setup(); runtime.observeDataVersion("domain:1");
    const field = runtime.bind(target); field.retain(); await flush();
    runtime.setActive(false); runtime.observeDataVersion("domain:2"); await flush();
    expect(one).toHaveBeenCalledTimes(1); expect(field.value).toBe(1);
    runtime.setActive(true); await flush(); expect(one).toHaveBeenCalledTimes(2);
  });
  it("does not treat an old bridge as a perpetual freshness guarantee", async () => {
    const { runtime, one } = setup(); const a = runtime.bind(target);
    const off = a.retain(); await flush(); off(); a.retain()(); await flush();
    expect(one).toHaveBeenCalledTimes(2);
  });
  it("isolates item failures and avoids an automatic error retry loop", async () => {
    const reads = createPropertyReadCoordinator(async request => ({ ...snapshot(request), ok: false, message: "missing" }));
    const read = vi.fn(reads.read);
    const runtime = createUnityPropertyRuntime({ read, write: vi.fn(), apply: vi.fn() });
    runtime.observeDataVersion("d:1"); const a = runtime.bind(target); a.retain(); await flush();
    expect(a.error).toBe("missing"); runtime.observeDataVersion("d:1"); await flush(); expect(read).toHaveBeenCalledTimes(1);
    await expect(a.refresh()).rejects.toThrow("missing"); expect(read).toHaveBeenCalledTimes(2);
  });
  it("reconciles canonical Editor identities back into path-addressed cached bindings", async () => {
    const canonical = { ...target, globalObjectId: "stable-object", targetFileId: "11400000" };
    const runtime = createUnityPropertyRuntime({
      read: async request => ({ ...snapshot(request), target: { ...canonical, propertyPath: request.target.propertyPath } }),
      write: async request => ({ ...snapshot(request, 9), target: { ...canonical, propertyPath: request.target.propertyPath }, saved: true }),
      apply: vi.fn(),
    });
    const a = runtime.bind(target); a.retain(); await flush();
    await runtime.write(target, 9);
    expect(a.value).toBe(9);
  });
  it("does not allow a released runtime to start a new write", async () => {
    const { runtime } = setup(); const a = runtime.bind(target); a.retain(); await flush(); runtime.dispose();
    await expect(a.write(2)).rejects.toThrow("disposed");
    await expect(runtime.write(target, 2)).rejects.toThrow("disposed");
  });
  it("evicts inactive data without losing the identity of a binding retained by View code", async () => {
    const { runtime } = setup(); runtime.observeDataVersion("domain:1");
    const fields = Array.from({ length: 130 }, (_, i) => runtime.bind({ ...target, propertyPath: `f${i}` }));
    const releases = fields.map(field => field.retain()); await flush(); releases.forEach(release => release());
    expect(fields[0].tree).toBeNull();
    expect(runtime.bind({ ...target, propertyPath: "f0" })).toBe(fields[0]);
    const release = fields[0].retain(); await flush(); expect(fields[0].value).toBe(1); release();
  });
  it("keeps expanded array data during authoring revalidation", async () => {
    const read = vi.fn(async (request: UnityBoundPropertyReadRequest) => {
      const offset = request.arrayOffset ?? 0, count = Math.min(16 - offset, request.maxArrayItems ?? 8);
      return { ...snapshot(request), propertyPath: "items", valueType: "Generic", isArray: true, arraySize: 16,
        childrenTruncated: offset + count < 16, children: Array.from({ length: count }, (_, i) => ({
          ...snapshot({ target: { ...target, propertyPath: `items.Array.data[${offset + i}]` } }),
        })) };
    });
    const runtime = createUnityPropertyRuntime({ read, write: vi.fn(), apply: vi.fn() });
    const tree = await runtime.readTree({ ...target, propertyPath: "items" }, { maxArrayItems: 8 });
    await tree.loadChildren(tree.require("items").raw); expect(tree.require("items").raw.children).toHaveLength(16);
    await tree.refresh(); expect(tree.require("items").raw.children).toHaveLength(16);
    expect(read.mock.calls[read.mock.calls.length - 1]?.[0].maxArrayItems).toBe(16);
  });
  it("keeps targets and read ranges distinct, and remaps only binding IDs", async () => {
    const { reads, many } = setup();
    const values = await Promise.all([
      reads.read({ target, bindingId: "a" }), reads.read({ target, bindingId: "b" }),
      reads.read({ target: { ...target, path: "Assets/Other.asset" } }),
      reads.read({ target, arrayOffset: 64 }),
    ]);
    expect(many.mock.calls[0][0]).toHaveLength(3); expect(values[0].bindingId).toBe("a"); expect(values[1].bindingId).toBe("b");
  });
  it("bounds batches, rejects disposal, and preserves all requested fields", async () => {
    const { reads, many } = setup();
    const values = await Promise.all(Array.from({ length: 70 }, (_, i) => reads.read({ target: { ...target, propertyPath: `f${i}` } })));
    expect(values).toHaveLength(70); expect(many.mock.calls.map(call => call[0].length)).toEqual([32, 32, 6]);
    reads.dispose(); await expect(reads.read({ target })).rejects.toThrow("disposed");
  });
  it("retargets a mounted field without publishing a previous object's delayed result", async () => {
    let release!: () => void; const gate = new Promise<void>(r => release = r);
    const runtime = createUnityPropertyRuntime({ read: async request => { if (request.target.path === "Assets/A.asset") await gate; return snapshot(request, request.target.path === "Assets/A.asset" ? 1 : 2); }, write: vi.fn(), apply: vi.fn() });
    const path = ref("Assets/A.asset"); const host = document.createElement("div"); document.body.append(host);
    const app = createApp({ render: () => h(UnityPropertyScope, { target: { kind: "asset", path: path.value }, runtime }, () => h(UnityPropertyField, { path: "speed" })) });
    app.use(createPinia()); apps.push(app); app.mount(host); await flush(); path.value = "Assets/B.asset"; await flush(); release(); await flush();
    expect(host.querySelector<HTMLInputElement>("input")?.value, host.innerHTML).toBe("2");
  });
});
