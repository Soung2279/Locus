import { describe, expect, it, vi } from "vitest";
import { createPropertyObjectData, type PropertyObjectPacket, type PropertyObjectRequest, type PropertyObjectResponse, type PropertyValueNode } from "../services/propertyObjectData";
import type { UnitySerializedPropertyReadRequest, UnitySerializedPropertyReadResult, UnitySerializedPropertyWriteResult } from "../services/unitySerializedProperty";

const target = { kind: "asset", path: "Assets/A.asset" };
const definitions = {
  root: { type: "Config", valueType: "Object", nodeKind: "object" },
  float: { type: "Float", valueType: "Float", displayName: "Speed", tooltip: "cached schema", hasRange: true, rangeMin: 0, rangeMax: 10 },
  group: { type: "Generic", valueType: "Generic" },
  array: { type: "Generic", valueType: "Generic", isArray: true },
};
const node = (p: string, v: unknown, parent = "", s = "float"): PropertyValueNode => ({ p, parent, s, v, d: String(v), e: true });
function packet(nodes = [node("speed", 1), node("other", 2)], revision = "r1"): PropertyObjectPacket {
  return { objectKey: "global:A", target: { ...target, globalObjectId: "global:A" }, revision, dataVersion: "domain:1", complete: true,
    maxDepth: 6, maxArrayItems: 8, removed: [], nodes: [{ ...node("", "A", "", "root"), parent: null, h: true, count: nodes.filter(n => n.parent === "").length }, ...nodes] };
}
const response = (value = packet()): PropertyObjectResponse => ({ protocol: 1, schemas: definitions, results: [value] });
const legacyResult = (p = "speed"): UnitySerializedPropertyReadResult => ({ ok: true, message: "legacy", target: { ...target, propertyPath: p }, propertyPath: p, value: 99 });
function setup(transport = vi.fn(async (_request: PropertyObjectRequest) => response())) {
  const legacy = vi.fn(async (request: UnitySerializedPropertyReadRequest) => legacyResult(request.target.propertyPath ?? ""));
  return { cache: createPropertyObjectData(legacy, undefined, transport), transport, legacy };
}
const read = (cache: ReturnType<typeof createPropertyObjectData>, propertyPath = "speed", extra = {}) => cache.read({ target: { ...target, propertyPath }, maxDepth: 4, maxArrayItems: 8, ...extra });
const tick = () => Promise.resolve();

describe("object value cache and static schema protocol", () => {
  it("deduplicates mounted fields into one object and serves another page without IPC", async () => {
    const { cache, transport, legacy } = setup();
    const values = await Promise.all([read(cache), read(cache, "other"), read(cache)]);
    expect(values.map(x => x.value)).toEqual([1, 2, 1]);
    expect(values[0]).toMatchObject({ tooltip: "cached schema", hasRange: true, target: { propertyPath: "speed", globalObjectId: "global:A" } });
    await read(cache, "other"); expect(transport).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled();
    expect(transport.mock.calls[0][0]).toMatchObject({ action: "read", reads: [{ target: { path: "Assets/A.asset" }, maxDepth: 6, maxArrayItems: 8 }] });
  });
  it("recognizes the canonical identity returned by Unity", async () => {
    const { cache, transport } = setup(); const first = await read(cache);
    expect((await cache.read({ target: first.target })).value).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not merge different objects that have the same field names", async () => {
    const transport = vi.fn(async (r: PropertyObjectRequest): Promise<PropertyObjectResponse> => ({ protocol: 1, schemas: definitions,
      results: r.action === "read" ? r.reads.map((item, i) => ({ ...packet([node("speed", i + 1)]), target: item.target, objectKey: item.target.path! })) : [] }));
    const { cache } = setup(transport);
    const values = await Promise.all([read(cache), cache.read({ target: { kind: "asset", path: "Assets/B.asset", propertyPath: "speed" } })]);
    expect(values.map(x => x.value)).toEqual([1, 2]); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("refreshes values by revision without retransmitting schemas", async () => {
    const { cache, transport } = setup(); await read(cache);
    transport.mockResolvedValueOnce({ protocol: 1, schemas: {}, results: [{ ...packet([node("speed", 4)], "r2"), complete: false, baseRevision: "r1", nodes: [node("speed", 4)] }] });
    expect((await read(cache, "speed", { force: true })).value).toBe(4);
    expect((await read(cache, "other")).value).toBe(2);
    expect(transport.mock.calls[1][0]).toMatchObject({ knownSchemas: ["root", "float", "group", "array"], reads: [{ revision: "r1" }] });
  });
  it("rejects deltas based on an unknown snapshot", async () => {
    const { cache, transport } = setup(); await read(cache);
    transport.mockResolvedValueOnce({ protocol: 1, schemas: {}, results: [{ ...packet(), complete: false, baseRevision: "wrong" }] });
    await expect(read(cache, "speed", { force: true })).rejects.toThrow("delta base mismatch");
  });
  it("isolates a per-object error inside a batch", async () => {
    const transport = vi.fn(async (): Promise<PropertyObjectResponse> => ({ ...response(), results: [packet(), { error: "missing B" } as PropertyObjectPacket] }));
    const { cache } = setup(transport);
    const results = await Promise.allSettled([read(cache), cache.read({ target: { kind: "asset", path: "Assets/B.asset", propertyPath: "speed" } })]);
    expect(results[0].status).toBe("fulfilled"); expect(results[1].status).toBe("rejected");
  });
  it("invalidates values on observed changes and retries unsupported objects after domain reload", async () => {
    const { cache, transport } = setup(); cache.observeVersion("one:1"); await read(cache);
    cache.observeVersion("one:2"); await read(cache); expect(transport).toHaveBeenCalledTimes(2);
    transport.mockResolvedValueOnce({ protocol: 1, results: [{ unsupported: true } as PropertyObjectPacket] });
    cache.invalidate(target); expect((await read(cache)).value).toBe(99);
    await read(cache); expect(transport).toHaveBeenCalledTimes(3);
    cache.observeVersion("two:1"); expect((await read(cache)).value).toBe(1);
  });
  it("never silently truncates a deep or array page demand to the prefetch budget", async () => {
    const { cache, transport, legacy } = setup();
    transport.mockResolvedValue(response(packet([{ ...node("items", null, "", "array"), a: 20, h: true, t: true, count: 1 }, node("items.Array.data[0]", 1, "items")])));
    await read(cache, "items", { maxArrayItems: 64 }); expect(legacy).toHaveBeenCalledTimes(1);
    await read(cache, "items", { arrayOffset: 8, maxArrayItems: 128 }); expect(legacy.mock.calls[1][0]).toMatchObject({ arrayOffset: 8, maxArrayItems: 128 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("projects caller depth without changing the shared object snapshot", async () => {
    const { cache, transport } = setup();
    transport.mockResolvedValue(response(packet([{ ...node("group", null, "", "group"), h: true, count: 1 },
      { ...node("group.inner", null, "group", "group"), h: true, count: 1 }, node("group.inner.speed", 5, "group.inner")])));
    const shallow = await read(cache, "group", { maxDepth: 1 }); expect(shallow.children?.[0].children).toEqual([]); expect(shallow.children?.[0].childrenTruncated).toBe(true);
    const deep = await read(cache, "group"); expect(deep.children?.[0].children?.[0].value).toBe(5); expect(transport).toHaveBeenCalledTimes(1);
    const defaults = await read(cache, "group", { maxDepth: 0, maxArrayItems: 0 });
    expect(defaults.children?.[0].children?.[0].value).toBe(5);
  });
  it("uses exact legacy semantics for selection, compound roots and explicit paging", async () => {
    const { cache, transport, legacy } = setup();
    await cache.read({ target: { kind: "selection", propertyPath: "speed" } });
    await cache.read({ target: { kind: "scene", scenePath: "Assets/A.unity", objectPath: "Player" } });
    expect(legacy).toHaveBeenCalledTimes(2); expect(transport).not.toHaveBeenCalled();
  });
  it("falls back only on explicit unsupported, not timeouts", async () => {
    const { cache, transport, legacy } = setup(); transport.mockRejectedValueOnce(new Error("timed out"));
    await expect(read(cache)).rejects.toThrow("timed out"); expect(legacy).not.toHaveBeenCalled();
    transport.mockResolvedValueOnce({ protocol: 1, unsupported: true }); expect((await read(cache)).value).toBe(99);
    await read(cache); expect(transport).toHaveBeenCalledTimes(2);
  });
  it("does not install a read that crossed external invalidation", async () => {
    let complete!: (value: PropertyObjectResponse) => void;
    const transport = vi.fn(() => new Promise<PropertyObjectResponse>(resolve => { complete = resolve; }));
    const { cache } = setup(transport); const pending = read(cache); await tick(); cache.invalidate(target); complete(response());
    expect(await pending).toMatchObject({ value: 99, stale: true });
    transport.mockImplementation(async () => response(packet([node("speed", 3)]))); expect((await read(cache)).value).toBe(3);
  });
  it("patches a scalar acknowledgement without marking unrelated stale fields fresh", async () => {
    const { cache, transport } = setup(); await read(cache);
    const receipt: UnitySerializedPropertyWriteResult = { ...legacyResult(), saved: true, value: 7, valueType: "Float" };
    cache.reconcile(receipt); expect((await read(cache)).value).toBe(7); expect(transport).toHaveBeenCalledTimes(1);
    cache.invalidate(target); cache.reconcile({ ...receipt, value: 8 }); await read(cache); expect(transport).toHaveBeenCalledTimes(2);
  });
  it("compact writes retain authoritative Undo state and applied/persisted distinction", async () => {
    const { cache, transport } = setup(); await read(cache);
    transport.mockResolvedValueOnce({ protocol: 1, schemas: {}, result: { ok: true, target: { ...target, propertyPath: "speed" }, node: node("speed", 9),
      beforeSnapshot: { propertyPath: "speed", value: 1, restoreState: "authoritative" }, saved: true, applied: true, persisted: false, refreshObject: false, dataVersion: "domain:1" } });
    const fallback = vi.fn(); const result = await cache.write({ target: { ...target, propertyPath: "speed" }, value: 9 }, fallback);
    expect(result).toMatchObject({ value: 9, tooltip: "cached schema", applied: true, persisted: false, beforeSnapshot: { restoreState: "authoritative" } });
    expect(fallback).not.toHaveBeenCalled(); expect((await read(cache)).value).toBe(9); expect(transport).toHaveBeenCalledTimes(2);
  });
  it("never retries a write with an uncertain outcome", async () => {
    const { cache, transport } = setup(); await read(cache); transport.mockRejectedValueOnce(new Error("write timed out"));
    const fallback = vi.fn(); await expect(cache.write({ target: { ...target, propertyPath: "speed" }, value: 9 }, fallback)).rejects.toThrow("timed out");
    expect(fallback).not.toHaveBeenCalled(); await read(cache); expect(transport).toHaveBeenCalledTimes(3);
  });
  it("validation/structural receipts invalidate instead of inventing sibling values", async () => {
    const { cache, transport } = setup(); await read(cache);
    cache.reconcile({ ...legacyResult(), value: 9, saved: true, refreshObject: true }); await read(cache);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("scopes continuous change events and falls back conservatively across a gap", async () => {
    const transport = vi.fn(async (r: PropertyObjectRequest): Promise<PropertyObjectResponse> => ({ protocol: 1, schemas: definitions,
      results: r.action === "read" ? r.reads.map(item => ({ ...packet(), target: { ...item.target, globalObjectId: item.target.path! }, objectKey: item.target.path! })) : [] }));
    const { cache } = setup(transport); cache.observeVersion("domain:1");
    const b = { kind: "asset", path: "Assets/B.asset", propertyPath: "speed" };
    await Promise.all([read(cache), cache.read({ target: b })]);
    cache.observeVersion("domain:2", { fromVersion: "domain:1", full: false, objects: ["Assets/A.asset"] });
    await cache.read({ target: b }); expect(transport).toHaveBeenCalledTimes(1);
    await read(cache); expect(transport).toHaveBeenCalledTimes(2);
    cache.observeVersion("domain:4", { fromVersion: "domain:3", full: false, objects: [] });
    await cache.read({ target: b }); expect(transport).toHaveBeenCalledTimes(3);
  });
  it("does not bless old values on the first observed editor event", async () => {
    const { cache, transport } = setup(); await read(cache);
    cache.observeVersion("domain:2"); await read(cache); expect(transport).toHaveBeenCalledTimes(2);
  });
  it("keeps specialized component root rendering on the legacy path", async () => {
    const { cache, transport, legacy } = setup();
    transport.mockResolvedValue(response({ ...packet(), rootProjection: false }));
    await read(cache, ""); expect(legacy).toHaveBeenCalledTimes(1);
    expect((await read(cache)).value).toBe(1); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("discards a receipt as an object-cache baseline if an external change crossed the write", async () => {
    const { cache, transport } = setup(); await read(cache);
    let finish!: (value: PropertyObjectResponse) => void;
    transport.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const write = cache.write({ target: { ...target, propertyPath: "speed" }, value: 5 }, vi.fn()); await tick();
    cache.invalidate(target);
    finish({ protocol: 1, result: { ok: true, target: { ...target, propertyPath: "speed" }, node: node("speed", 5), beforeSnapshot: { propertyPath: "speed", value: 1 },
      saved: true, applied: true, persisted: false, refreshObject: false, dataVersion: "domain:1" } });
    await write; await read(cache); expect(transport).toHaveBeenCalledTimes(3);
  });
  it("invalidates objects whose reference display data depends on a changed object", async () => {
    const { cache, transport } = setup();
    transport.mockResolvedValue(response(packet([{ ...node("speed", 1), r: { kind: "scene", globalObjectId: "referenced" } }])));
    cache.observeVersion("domain:1"); await read(cache);
    cache.observeVersion("domain:2", { fromVersion: "domain:1", full: false, objects: ["referenced"] });
    await read(cache); expect(transport).toHaveBeenCalledTimes(2);
  });
  it("keeps unknown getter dependencies conservative", async () => {
    const { cache, transport } = setup();
    transport.mockResolvedValue(response({ ...packet(), conservativeInvalidation: true }));
    cache.observeVersion("domain:1"); await read(cache);
    cache.observeVersion("domain:2", { fromVersion: "domain:1", full: false, objects: ["unrelated"] });
    await read(cache); expect(transport).toHaveBeenCalledTimes(2);
  });
  it("merges a receipt's schema and updates ancestor projections without a full read", async () => {
    const { cache, transport } = setup(); await read(cache);
    transport.mockResolvedValueOnce({ protocol: 1, schemas: { newer: { ...definitions.float, tooltip: "new schema" } }, result: { ok: true,
      target: { ...target, propertyPath: "speed" }, node: { ...node("speed", 6), s: "newer", parent: null },
      beforeSnapshot: { propertyPath: "speed", value: 1, restoreState: "before" }, restoreState: "after",
      saved: true, applied: true, persisted: false, refreshObject: false, dataVersion: "domain:1" } });
    await cache.write({ target: { ...target, propertyPath: "speed" }, value: 6 }, vi.fn());
    expect(await read(cache)).toMatchObject({ value: 6, tooltip: "new schema" });
    const whole = await read(cache, ""); expect(whole.children?.find(n => n.propertyPath === "speed")?.value).toBe(6);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("retries eligibility after a full edit-mode/structure invalidation", async () => {
    const { cache, transport } = setup(); cache.observeVersion("domain:1");
    transport.mockResolvedValueOnce({ protocol: 1, results: [{ unsupported: true } as PropertyObjectPacket] });
    await read(cache); cache.observeVersion("domain:2", { fromVersion: "domain:1", full: true, objects: [] });
    expect((await read(cache)).value).toBe(1); expect(transport).toHaveBeenCalledTimes(2);
  });
  it("rejects pending and future work after disposal", async () => {
    let complete!: (value: PropertyObjectResponse) => void;
    const { cache } = setup(vi.fn(() => new Promise<PropertyObjectResponse>(resolve => { complete = resolve; })));
    const pending = read(cache); await tick(); cache.dispose(); complete(response());
    await expect(pending).rejects.toThrow("disposed"); await expect(read(cache)).rejects.toThrow("disposed");
  });
});
