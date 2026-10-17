import type { UnityBoundPropertyReadRequest, UnityBoundPropertyReadResult } from "../components/unity/unityPropertyBinding";

/** Collect synchronous component demands, not one timer/network trip per field.
 * Only immutable request identity is shared; this layer never caches live values.
 */
export function createPropertyReadCoordinator<R extends UnityBoundPropertyReadResult>(
  readOne: (request: UnityBoundPropertyReadRequest) => Promise<R>,
  readMany?: (requests: UnityBoundPropertyReadRequest[]) => Promise<R[]>,
) {
  type Job = { request: UnityBoundPropertyReadRequest; resolve: (value: R) => void; reject: (error: unknown) => void };
  const pending = new Map<string, Promise<R>>();
  let queued: Job[] = [], scheduled = false, disposed = false;
  const keyOf = (request: UnityBoundPropertyReadRequest) => JSON.stringify(request, (key, value) =>
    key === "bindingId" ? undefined : value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  async function flush() {
    scheduled = false;
    const jobs = queued; queued = [];
    // Bound each Editor turn. Do not silently truncate or widen field/array ranges.
    for (let offset = 0; offset < jobs.length; offset += 32) {
      const chunk = jobs.slice(offset, offset + 32);
      if (disposed) { chunk.forEach(job => job.reject(new Error("Property reader disposed."))); continue; }
      try {
        const results = chunk.length > 1 && readMany
          ? await readMany(chunk.map(job => job.request))
          : await Promise.all(chunk.map(job => readOne(job.request)));
        if (results.length !== chunk.length) throw new Error("Property read batch result count mismatch.");
        chunk.forEach((job, i) => disposed ? job.reject(new Error("Property reader disposed.")) : job.resolve(results[i]));
      } catch (error) { chunk.forEach(job => job.reject(error)); }
    }
  }
  function read(request: UnityBoundPropertyReadRequest): Promise<R> {
    if (disposed) return Promise.reject(new Error("Property reader disposed."));
    // Selection without a resolved identity must be evaluated at request time.
    if (request.target.kind === "selection" && !request.target.globalObjectId) return readOne(request);
    const input = { ...request, target: { ...request.target }, bindingId: undefined };
    const key = keyOf(input);
    let promise = pending.get(key);
    if (!promise) {
      promise = new Promise<R>((resolve, reject) => queued.push({ request: input, resolve, reject }));
      pending.set(key, promise);
      const release = () => { if (pending.get(key) === promise) pending.delete(key); };
      void promise.then(release, release);
      if (!scheduled) { scheduled = true; void Promise.resolve().then(flush); }
    }
    return promise.then(result => request.bindingId == null ? result : ({ ...result, bindingId: request.bindingId }));
  }
  return {
    read,
    invalidate() { pending.clear(); },
    dispose() { disposed = true; pending.clear(); queued.splice(0).forEach(job => job.reject(new Error("Property reader disposed."))); },
  };
}
