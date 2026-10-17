import type { LocusRuntime, RuntimeUnsubscribe } from "./locusRuntime";
import type { WorkspaceRef } from "./project";
import { WORKSPACE_EVENT_NAME, type WorkspaceEventSubscriptionOptions } from "./workspaceEventHub";

export interface NativeViewBootstrap { instanceId: string; workspaceRef: WorkspaceRef; }
/** One HTTP/event channel for the shared Vue owner; never one poll per child. */
export function createNativeViewRuntime(origin: string, token: string, request: typeof fetch = fetch) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid native View connection.");
  const listeners = new Map<string, Set<(value: unknown) => unknown>>();
  const pending = new Set<AbortController>();
  let disposed = false;
  let eventAbort: AbortController | null = null;
  let eventTask: Promise<void> | null = null;
  async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (disposed) throw new DOMException("Native View disconnected", "AbortError");
    if (pending.size >= 128) throw new Error("Native View request queue is full.");
    const controller = new AbortController(); pending.add(controller);
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(cancel, 60_000);
    try {
      const response = await request(`${origin}/native-view/${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(await response.text());
      const value = await response.json() as { ok: boolean; result?: T; error?: string };
      if (!value.ok) throw new Error(value.error || "Native View request failed.");
      if (disposed || controller.signal.aborted) throw new DOMException("Native View request cancelled", "AbortError");
      return value.result as T;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); pending.delete(controller); }
  }
  function startEvents() {
    if (eventTask || disposed || listeners.size === 0) return;
    const controller = new AbortController(); eventAbort = controller;
    eventTask = (async () => {
      while (!disposed && !controller.signal.aborted && listeners.size) {
        try {
          const events = await call<unknown[]>("events", undefined, controller.signal);
          for (const event of events) for (const handler of [...listeners.get(WORKSPACE_EVENT_NAME) ?? []]) {
            try { handler(event); } catch (error) { console.warn("[native-view] event handler failed", error); }
          }
        } catch (error) {
          if (controller.signal.aborted || disposed) break;
          console.warn("[native-view] event connection interrupted", error);
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, 1000); controller.signal.addEventListener("abort", done, { once: true });
          });
        }
      }
    })().finally(() => { eventTask = null; if (eventAbort === controller) eventAbort = null; if (!disposed && listeners.size) startEvents(); });
  }
  const runtime: LocusRuntime = {
    kind: "unity",
    invoke: <T>(command: string, args?: Record<string, unknown>, signal?: AbortSignal) => call<T>("invoke", { command, args: args ?? {} }, signal),
    async subscribe<T>(name: string, handler: (value: T) => unknown, options?: WorkspaceEventSubscriptionOptions): Promise<RuntimeUnsubscribe> {
      if (disposed || options?.signal?.aborted) return () => {};
      if (name !== WORKSPACE_EVENT_NAME) throw new Error(`Event '${name}' is not available in a native Unity View.`);
      let handlers = listeners.get(name); if (!handlers) listeners.set(name, handlers = new Set());
      const callback = handler as (value: unknown) => unknown; handlers.add(callback);
      let active = true;
      const release = () => { if (!active) return; active = false; handlers!.delete(callback); if (!handlers!.size) listeners.delete(name); options?.signal?.removeEventListener("abort", release); if (!listeners.size) eventAbort?.abort(); };
      options?.signal?.addEventListener("abort", release, { once: true }); startEvents(); return release;
    },
  };
  return {
    runtime,
    bootstrap: () => call<NativeViewBootstrap>("bootstrap"),
    stats: () => ({ pending: pending.size, subscriptions: [...listeners.values()].reduce((n, set) => n + set.size, 0), eventPolling: !!eventTask }),
    dispose() { if (disposed) return; disposed = true; listeners.clear(); eventAbort?.abort(); for (const controller of pending) controller.abort(); },
  };
}
