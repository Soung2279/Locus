import type { UnityPropertyDataChanges } from "./unitySerializedProperty";
import { createPropertyReadCoordinator } from "./propertyReadCoordinator";
import { unityPropertyObjectTarget, unityPropertyTargetKey } from "./unityPropertyPath";
import type { UnitySerializedPropertyTarget as Target, UnitySerializedPropertySnapshot as Snapshot,
  UnitySerializedPropertyReadRequest as Read, UnitySerializedPropertyReadResult as ReadResult,
  UnitySerializedPropertyWriteRequest as Write, UnitySerializedPropertyWriteResult as WriteResult } from "./unitySerializedProperty";

export interface PropertyValueNode {
  p: string; parent: string | null; s: string; v: unknown; d: string; e: boolean;
  o?: boolean; h?: boolean; a?: number; t?: boolean; count?: number;
  r?: Target | null; i?: number; f?: number; name?: string; displayName?: string;
  attributes?: Snapshot["attributes"];
}
export interface PropertyObjectRead { target: Target; revision?: string; maxDepth: number; maxArrayItems: number; }
export interface PropertyObjectPacket {
  unsupported?: boolean; error?: string; objectKey: string; target: Target;
  revision: string; dataVersion: string; baseRevision?: string | null; complete: boolean;
  maxDepth: number; maxArrayItems: number; rootProjection?: boolean; conservativeInvalidation?: boolean; nodes: PropertyValueNode[]; removed: string[];
}
export interface PropertyObjectReceipt {
  unsupported?: boolean; ok: boolean; target: Target; node: PropertyValueNode;
  beforeSnapshot: Snapshot; restoreState?: string; applied: boolean; persisted: boolean; saved: boolean;
  refreshObject: boolean; dataVersion: string;
}
export interface PropertyObjectResponse {
  protocol: 1; unsupported?: boolean; schemas?: Record<string, Omit<Snapshot, "value" | "propertyPath">>;
  results?: PropertyObjectPacket[]; result?: PropertyObjectReceipt;
}
export type PropertyObjectRequest = { action: "read"; reads: PropertyObjectRead[]; knownSchemas: string[] }
  | { action: "write"; write: Write; knownSchemas: string[] };
export type PropertyObjectTransport = (request: PropertyObjectRequest) => Promise<PropertyObjectResponse>;
export interface ObjectReadRequest extends Read { force?: boolean; }

/** One owning runtime/checkout. Schemas never cross domains; mutable values never
 * cross runtimes. A field is a projection of an object, not an independent cache. */
export function createPropertyObjectData(
  legacyRead: (request: Read) => Promise<ReadResult>,
  legacyMany?: (requests: Read[]) => Promise<ReadResult[]>,
  transport?: PropertyObjectTransport,
) {
  type Entry = { key: string; target: Target; aliases: Set<string>; nodes: Map<string, PropertyValueNode>;
    snapshots: Map<string, Snapshot>; dependencies: Set<string>; conservative?: boolean; revision?: string; dataVersion?: string; stale: boolean;
    unsupported: boolean; rootProjection?: boolean; maxDepth: number; maxArrayItems: number; epoch: number; pending?: Promise<void> };
  const entries = new Map<string, Entry>();
  const aliases = new Map<string, Entry>();
  const schemas = new Map<string, Omit<Snapshot, "value" | "propertyPath">>();
  const legacy = createPropertyReadCoordinator<ReadResult>(legacyRead, legacyMany);
  let supported = !!transport, disposed = false, version: string | undefined;
  const objectKey = (target: Target) => unityPropertyTargetKey(unityPropertyObjectTarget(target));
  function active() { if (disposed) throw new Error("Property object cache disposed."); }
  function prune() {
    for (const [key, entry] of entries) {
      if (entries.size <= 128) break;
      if (entry.pending) continue;
      entries.delete(key); entry.aliases.forEach(alias => aliases.delete(alias));
    }
    if (schemas.size > 8192) { schemas.clear(); entries.clear(); aliases.clear(); }
  }
  function entryFor(target: Target): Entry {
    const key = objectKey(target);
    let entry = aliases.get(key);
    if (!entry) {
      entry = { key, target: unityPropertyObjectTarget(target), aliases: new Set([key]), nodes: new Map(), snapshots: new Map(), dependencies: new Set(),
        stale: true, unsupported: false, maxDepth: 6, maxArrayItems: 8, epoch: 0 };
      entries.set(key, entry); aliases.set(key, entry);
    } else { entries.delete(entry.key); entries.set(entry.key, entry); }
    prune(); return entry;
  }
  function matches(entry: Entry, target: Target) {
    return entry.aliases.has(objectKey(target)) || !!(target.globalObjectId && entry.target.globalObjectId === target.globalObjectId);
  }
  function receiveSchemas(response: PropertyObjectResponse) {
    if (!response || response.protocol !== 1) throw new Error("Unsupported property object protocol.");
    for (const [id, schema] of Object.entries(response.schemas ?? {})) schemas.set(id, schema);
  }
  function hydrate(node: PropertyValueNode): Snapshot {
    const schema = schemas.get(node.s);
    if (!schema) throw new Error("Property object schema missing; refresh the View.");
    return { ...schema, propertyPath: node.p, value: node.v, displayValue: node.d, editable: node.e,
      prefabOverride: node.o ?? false, hasChildren: node.h ?? false, arraySize: node.a ?? -1,
      visibleChildCount: node.count ?? 0, childrenTruncated: node.t ?? false, referenceTarget: node.r ?? null,
      enumValueIndex: node.i ?? -1, enumValueFlag: node.f ?? 0,
      managedReferenceFullTypename: "", managedReferenceFieldTypename: "", managedReferenceDisplayName: "",
      ...(node.name === undefined ? {} : { name: node.name }),
      ...(node.displayName === undefined ? {} : { displayName: node.displayName }),
      ...(node.p === "" ? { name: String(node.v ?? ""), displayName: node.d } : {}),
      ...(node.attributes === undefined ? {} : { attributes: node.attributes }), children: [] };
  }
  function rebuild(entry: Entry) {
    entry.dependencies = new Set([...entry.nodes.values()].map(node => node.r?.globalObjectId).filter((id): id is string => !!id));
    entry.snapshots = new Map([...entry.nodes].map(([path, node]) => [path, hydrate(node)]));
    for (const [path, node] of entry.nodes) {
      if (node.parent === null) continue;
      const parent = entry.snapshots.get(node.parent);
      if (!parent) throw new Error("Property object snapshot has a missing parent.");
      parent.children!.push(entry.snapshots.get(path)!);
    }
  }
  function patchSnapshot(entry: Entry, node: PropertyValueNode) {
    const previous = entry.snapshots.get(node.p);
    let path = node.p;
    let snapshot = { ...hydrate(node), children: previous?.children ?? [] };
    entry.snapshots.set(path, snapshot);
    let parent = node.parent;
    while (parent !== null) {
      const before = entry.snapshots.get(parent);
      if (!before) { entry.stale = true; return; }
      snapshot = { ...before, children: (before.children ?? []).map(child => child.propertyPath === path ? snapshot : child) };
      entry.snapshots.set(parent, snapshot);
      path = parent; parent = entry.nodes.get(parent)?.parent ?? null;
    }
    entry.dependencies = new Set([...entry.nodes.values()].map(value => value.r?.globalObjectId).filter((id): id is string => !!id));
  }
  function install(entry: Entry, packet: PropertyObjectPacket) {
    if (packet.error) throw new Error(packet.error);
    if (packet.unsupported) { entry.unsupported = true; entry.stale = false; return; }
    if (!packet.complete && packet.baseRevision !== entry.revision) throw new Error("Property object delta base mismatch.");
    const nodes = packet.complete ? new Map<string, PropertyValueNode>() : new Map(entry.nodes);
    for (const path of packet.removed ?? []) nodes.delete(path);
    for (const node of packet.nodes) nodes.set(node.p, node);
    if (!nodes.has("")) throw new Error("Property object root missing.");
    entry.nodes = nodes; entry.target = unityPropertyObjectTarget(packet.target);
    entry.revision = packet.revision; entry.dataVersion = packet.dataVersion;
    entry.aliases.add(objectKey(entry.target)); aliases.set(objectKey(entry.target), entry);
    entry.maxDepth = packet.maxDepth; entry.maxArrayItems = packet.maxArrayItems; entry.rootProjection = packet.rootProjection;
    entry.conservative = packet.conservativeInvalidation;
    rebuild(entry); entry.stale = false;
  }
  type Job = { entry: Entry; epoch: number; resolve: () => void; reject: (error: unknown) => void };
  let jobs: Job[] = [], scheduled = false;
  async function flush() {
    scheduled = false; const batch = jobs; jobs = [];
    for (let offset = 0; offset < batch.length; offset += 32) {
      const chunk = batch.slice(offset, offset + 32);
      try {
        active();
        const response = await transport!({ action: "read", knownSchemas: [...schemas.keys()], reads: chunk.map(({ entry }) => ({
          target: entry.target, revision: entry.revision, maxDepth: entry.maxDepth, maxArrayItems: entry.maxArrayItems,
        })) });
        active(); receiveSchemas(response);
        if (response.unsupported) { supported = false; chunk.forEach(job => job.resolve()); continue; }
        if (response.results?.length !== chunk.length) throw new Error("Property object result count mismatch.");
        chunk.forEach((job, i) => {
          try { if (job.epoch === job.entry.epoch) install(job.entry, response.results![i]); job.resolve(); }
          catch (error) { job.reject(error); }
        });
      } catch (error) { chunk.forEach(job => job.reject(error)); }
    }
  }
  function load(entry: Entry) {
    if (entry.pending) return entry.pending;
    entry.pending = new Promise<void>((resolve, reject) => jobs.push({ entry, epoch: entry.epoch, resolve, reject }));
    const pending = entry.pending;
    void pending.finally(() => { if (entry.pending === pending) entry.pending = undefined; prune(); }).catch(() => {});
    if (!scheduled) { scheduled = true; void Promise.resolve().then(flush); }
    return pending;
  }
  function projection(entry: Entry, request: Read): ReadResult | null {
    const path = request.target.propertyPath ?? "", root = entry.snapshots.get(path);
    if (!root || (!path && entry.rootProjection === false)) return null;
    const maxDepth = request.maxDepth && request.maxDepth > 0 ? Math.min(16, request.maxDepth) : 4;
    const maxItems = request.maxArrayItems && request.maxArrayItems > 0 ? Math.min(1024, request.maxArrayItems) : 64;
    let incomplete = false;
    const project = (snapshot: Snapshot, depth: number): Snapshot => {
      const available = snapshot.children ?? [];
      if (depth < maxDepth && snapshot.childrenTruncated && (!snapshot.isArray || available.length < Math.min(snapshot.arraySize ?? 0, maxItems))) incomplete = true;
      const children = depth >= maxDepth ? [] : (snapshot.isArray ? available.slice(0, maxItems) : available).map(child => project(child, depth + 1));
      return { ...snapshot, children, visibleChildCount: children.length,
        childrenTruncated: snapshot.isArray ? (snapshot.arraySize ?? 0) > children.length
          : !!snapshot.childrenTruncated || available.length > children.length };
    };
    const result = project(root, 0);
    if (incomplete) return null;
    return { ...result, ok: true, message: "ok", bindingId: request.bindingId,
      target: { ...entry.target, propertyPath: path }, backend: "live", dataVersion: entry.dataVersion,
      dependencyObjectIds: [...entry.dependencies], conservativeInvalidation: entry.conservative };
  }
  async function read(request: ObjectReadRequest): Promise<ReadResult> {
    active();
    if (!supported || request.arrayOffset || request.autoExpandCharLimit ||
        request.target.kind === "selection" || !["asset", "scene", "component"].includes(request.target.kind) ||
        (!request.target.propertyPath && request.target.kind !== "asset")) return legacy.read(request);
    const entry = entryFor(request.target);
    if (entry.unsupported) return legacy.read(request);
    if (request.force) entry.stale = true;
    // Bounded root prefetch covers ordinary pages, never unbounded graphs. Deep
    // or paged demands retain their exact legacy read rather than narrowing data.
    if (entry.stale) await load(entry);
    active();
    if (!supported || entry.unsupported) return legacy.read(request);
    if (entry.stale) return { ...(await legacy.read(request)), stale: true } as ReadResult;
    return projection(entry, request) ?? legacy.read(request);
  }
  function invalidate(target?: Target, resetEligibility = false) {
    legacy.invalidate();
    for (const entry of entries.values()) if (!target || matches(entry, target)) {
      entry.stale = true; entry.epoch++;
      if (resetEligibility) entry.unsupported = false;
    }
  }
  function reconcile(receipt: WriteResult, capturedNode?: PropertyValueNode) {
    if (!receipt.ok || !receipt.target) return;
    for (const entry of entries.values()) {
      if (!matches(entry, receipt.target)) continue;
      const node = entry.nodes.get(receipt.propertyPath);
      if (!node || receipt.refreshObject || receipt.isArray || receipt.isManagedReference || receipt.valueType === "Generic") {
        entry.stale = true; entry.epoch++; continue;
      }
      // The acknowledgement is authoritative only for this leaf. Do not make a
      // previously stale object's unrelated fields fresh as a side effect.
      const updated = { ...node, ...(capturedNode ?? {}), parent: node.parent, v: receipt.value, d: receipt.displayValue ?? node.d,
        e: receipt.editable ?? node.e, o: receipt.prefabOverride, r: receipt.referenceTarget,
        h: receipt.hasChildren ?? node.h, t: receipt.childrenTruncated ?? node.t, count: receipt.visibleChildCount ?? node.count,
        i: receipt.enumValueIndex, f: receipt.enumValueFlag, attributes: receipt.attributes ?? node.attributes };
      entry.nodes.set(node.p, updated);
      entry.revision = undefined; entry.epoch++; patchSnapshot(entry, updated);
    }
  }
  function invalidatePending() {
    legacy.invalidate();
    for (const entry of entries.values()) if (entry.pending) { entry.epoch++; entry.stale = true; }
  }
  async function write(request: Write, fallback: () => Promise<WriteResult>): Promise<WriteResult> {
    active();
    const fallbackWrite = async () => {
      try { const result = await fallback(); reconcile(result); return result; }
      catch (error) { invalidate(request.target); throw error; }
    };
    const entry = [...entries.values()].find(item => matches(item, request.target));
    if (!supported || !entry || entry.unsupported || request.writeMode === "preview") return fallbackWrite();
    // No re-send after an uncertain mutation, including an invalid receipt.
    const epoch = ++entry.epoch;
    try {
      const response = await transport!({ action: "write", write: request, knownSchemas: [...schemas.keys()] });
      active(); receiveSchemas(response);
      if (response.unsupported || response.result?.unsupported) {
        if (response.unsupported) supported = false;
        return await fallbackWrite();
      }
      const result = response.result;
      if (!result?.ok || !result.node) throw new Error("Invalid property object write receipt.");
      const receipt: WriteResult = { ...hydrate(result.node), ok: true, message: "ok", target: result.target,
        bindingId: request.bindingId, saved: result.saved, beforeSnapshot: result.beforeSnapshot, restoreState: result.restoreState,
        refreshObject: result.refreshObject, applied: result.applied, persisted: result.persisted, dataVersion: result.dataVersion };
      if (entry.epoch === epoch) reconcile(receipt, result.node);
      else { entry.stale = true; }
      return receipt;
    } catch (error) { invalidate(request.target); throw error; }
  }
  return {
    read, write, reconcile, invalidate, invalidatePending,
    observeVersion(next?: string, changes?: UnityPropertyDataChanges) {
      if (!next) return;
      const previous = version;
      if (next.split(":")[0] !== previous?.split(":")[0]) {
        supported = !!transport;
        if (previous !== undefined) { schemas.clear(); for (const entry of entries.values()) entry.unsupported = false; }
      }
      if (previous !== undefined && next !== previous) {
        if (changes && !changes.full && changes.fromVersion === previous) {
          const ids = new Set(changes.objects);
          for (const entry of entries.values()) if (!entry.nodes.size || !entry.target.globalObjectId || ids.has(entry.target.globalObjectId) ||
              entry.conservative || [...entry.dependencies].some(id => ids.has(id))) invalidate(entry.target);
        } else invalidate(undefined, true);
      } else if (previous === undefined) {
        for (const entry of entries.values()) if (entry.dataVersion && entry.dataVersion !== next) invalidate(entry.target);
      }
      version = next;
    },
    dispose() { disposed = true; legacy.dispose(); jobs.splice(0).forEach(job => job.reject(new Error("Property object cache disposed."))); entries.clear(); aliases.clear(); schemas.clear(); },
  };
}
