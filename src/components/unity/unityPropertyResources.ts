import type { UnityPropertyDataChanges } from "../../services/unitySerializedProperty";
import { markRaw, shallowReactive } from "vue";
import { resolveUnityPropertyTarget, unityPropertyObjectTarget, unityPropertyTargetKey } from "../../services/unityPropertyPath";
import type { UnityBoundPropertyTree, UnityBoundPropertyRuntimeOptions, UnityBoundPropertyWriteOptions, UnityBoundPropertyWriteResult, UnityPropertyPathInput, UnityPropertyRuntime } from "./unityPropertyBinding";

export interface UnityPropertyResource {
  readonly tree: UnityBoundPropertyTree | null;
  readonly property: ReturnType<UnityBoundPropertyTree["get"]>;
  readonly value: unknown;
  readonly loading: boolean;
  readonly error: string;
  retain(): () => void;
  refresh(): Promise<void>;
  write(value: unknown, options?: UnityBoundPropertyWriteOptions): Promise<UnityBoundPropertyWriteResult>;
}

/** Shared by the owning runtime/View, never across checkout/backend boundaries. */
export function createUnityPropertyResources(runtime: UnityPropertyRuntime) {
  type Entry = { resource: UnityPropertyResource; state: { tree: UnityBoundPropertyTree | null; loading: boolean; error: string };
    target: ReturnType<typeof resolveUnityPropertyTarget>; users: number; stale: boolean; pending: Promise<void> | null; invalidation: number };
  const entries = new Map<string, Entry>();
  const known = new Map<string, WeakRef<Entry>>();
  let disposed = false, hostActive = true, observedVersion: string | undefined;
  function prune() {
    let inactive = [...entries.values()].filter(entry => !entry.users && !entry.pending).length;
    for (const [key, entry] of entries) {
      if (inactive <= 128) break;
      if (!entry.users && !entry.pending) {
        entry.stale = true; entry.invalidation++; entry.state.tree = null;
        entries.delete(key); inactive--;
      }
    }
    if (known.size > 512) for (const [key, reference] of known) if (!reference.deref()) known.delete(key);
  }
  function sameObject(a: Entry["target"], b: Entry["target"]) {
    return a.globalObjectId && b.globalObjectId ? a.globalObjectId === b.globalObjectId
      : unityPropertyTargetKey(unityPropertyObjectTarget(a)) === unityPropertyTargetKey(unityPropertyObjectTarget(b));
  }
  function bind(input: UnityPropertyPathInput, options: UnityBoundPropertyRuntimeOptions = {}): UnityPropertyResource {
    if (disposed) throw new Error("Property bindings disposed.");
    const target = resolveUnityPropertyTarget(input);
    if (target.kind === "selection" && !target.globalObjectId) throw new Error("Declarative property bindings require a resolved object identity.");
    if (options.treeOptions) throw new Error("Configure custom drawers on the component; shared property bindings do not accept treeOptions.");
    const key = JSON.stringify([unityPropertyTargetKey(target), options.maxDepth ?? null, options.maxArrayItems ?? null, options.idPrefix ?? null]);
    const existing = entries.get(key) ?? known.get(key)?.deref();
    if (existing) return existing.resource;
    // Retained subscribers are never evicted. Inactive data has a bounded LRU.
    prune();
    const state = shallowReactive({ tree: null as UnityBoundPropertyTree | null, loading: false, error: "" });
    const entry: Entry = { resource: null!, state, target, users: 0, stale: true, pending: null, invalidation: 0 };
    async function refresh() {
      if (disposed) throw new Error("Property bindings disposed.");
      if (entry.pending) return entry.pending;
      const version = entry.invalidation;
      state.loading = true; state.error = "";
      entry.pending = (async () => {
        try {
          if (state.tree) await state.tree.refresh();
          else state.tree = markRaw(await runtime.readTree(target, options));
          if (state.tree) entry.target = { ...state.tree.target, propertyPath: target.propertyPath };
          entry.stale = entry.invalidation !== version;
        } catch (error) { entry.stale = true; state.error = error instanceof Error ? error.message : String(error); throw error; }
        finally { state.loading = false; entry.pending = null; prune(); }
      })();
      return entry.pending;
    }
    const resource: UnityPropertyResource = {
      get tree() { return state.tree; },
      get property() { return target.propertyPath ? state.tree?.get(target.propertyPath) ?? null : state.tree?.root ?? null; },
      get value() { return resource.property?.value; },
      get loading() { return state.loading; },
      get error() { return state.error || state.tree?.error || ""; },
      retain() {
        if (disposed) throw new Error("Property bindings disposed.");
        entry.users++;
        entries.delete(key); entries.set(key, entry);
        if (entry.stale && hostActive) void refresh().catch(() => {});
        let released = false;
        return () => { if (released) return; released = true; entry.users--; if (!observedVersion && !entry.users) entry.stale = true; prune(); };
      },
      refresh,
      async write(value, writeOptions) {
        // Initial load/conflict recovery is authoritative; ordinary consecutive
        // edits keep using the same live bound tree and its draft/Undo machinery.
        if (disposed) throw new Error("Property bindings disposed.");
        if (!state.tree || entry.stale) await refresh();
        const field = state.tree?.get(target.propertyPath || "");
        if (!field) throw new Error("Property binding is not a writable field.");
        try { return await field.write(value, writeOptions); }
        catch (error) { state.error = error instanceof Error ? error.message : String(error); throw error; }
      },
    };
    entry.resource = resource; entries.set(key, entry); known.set(key, new WeakRef(entry));
    return resource;
  }
  function invalidate(target?: Entry["target"], objectIds?: Set<string>) {
    for (const entry of entries.values()) {
      if (target && !sameObject(entry.target, target)) continue;
      if (objectIds && entry.state.tree && entry.target.globalObjectId && !objectIds.has(entry.target.globalObjectId) && !entry.state.tree.dependsOn(objectIds)) continue;
      entry.stale = true; entry.invalidation++;
      if (hostActive && entry.users && !entry.state.tree?.pending) void entry.resource.refresh().catch(() => {});
    }
  }
  function reconcile(result: UnityBoundPropertyWriteResult) {
    if (!result.target || result.ok === false) return;
    for (const entry of entries.values()) {
      if (!sameObject(entry.target, result.target)) continue;
      const scalar = !result.isArray && !result.isManagedReference && result.valueType !== "Generic";
      if (scalar && !result.refreshObject) entry.state.tree?.reconcileReceipt(result);
      else { entry.stale = true; entry.invalidation++; }
    }
  }
  return {
    bind, invalidate, reconcile,
    setActive(active: boolean) {
      if (hostActive === active) return;
      hostActive = active;
      // The host may suppress Editor events while hidden. Revalidate on return
      // while keeping mounted controls/values, not an empty loading page.
      invalidate();
    },
    observeVersion(version?: string, changes?: UnityPropertyDataChanges) {
      if (!version) return;
      const previous = observedVersion;
      const changed = previous !== undefined && previous !== version;
      observedVersion = version;
      if (changed) invalidate(undefined, changes && !changes.full && changes.fromVersion === previous ? new Set(changes.objects) : undefined);
      else if (previous === undefined) {
        // A first event can arrive after initial data was captured. Do not bless
        // an older capture merely because no earlier event was observed.
        for (const entry of entries.values()) if (entry.state.tree?.dataVersion && entry.state.tree.dataVersion !== version) invalidate(entry.target);
      }
      // Revisit invalidations that arrived while a read or draft was in flight.
      for (const entry of entries.values()) if (hostActive && entry.users && entry.stale && !entry.pending && !entry.state.tree?.pending && !entry.state.error)
        void entry.resource.refresh().catch(() => {});
    },
    dispose() { disposed = true; entries.clear(); known.clear(); },
  };
}
