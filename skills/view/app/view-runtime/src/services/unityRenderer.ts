import type { WorkspaceRef } from "./project";
import { getLocusRuntime } from "./locusRuntime";
import { measureRenderLayout, type RenderLayout } from "./unityRenderLayout";

interface OutputReference { id: string; owner: string; domainGeneration: string; }
export interface UnityRendererCapabilities { supported: boolean; reason?: string; transport?: string; protocolVersion?: number; formats?: string[]; maxDimension?: number; maxOutputs?: number; }
export interface UnityRenderStatus { state: "unmounted" | "waiting" | "ready" | "detached" | "closed" | "failed"; error?: string | null; width?: number; height?: number; frames?: number; generation?: number; inputs?: number; inputToPresentP95Ms?: number | null; }
export interface UnityRenderSurfaceHandle { dispose(): Promise<void>; setVisible(visible: boolean): void; refreshLayout(): void; }
export interface UnityRenderOutput {
  readonly id: string;
  readonly domainGeneration: string;
  mount(element: HTMLElement): Promise<UnityRenderSurfaceHandle>;
  status(): Promise<UnityRenderStatus>;
  subscribe(listener: (status: UnityRenderStatus) => void): () => void;
  dispose(): Promise<void>;
}
export interface UnityRenderer {
  capabilities(): Promise<UnityRendererCapabilities>;
  createOutput(): Promise<UnityRenderOutput>;
  mount(element: HTMLElement, output: UnityRenderOutput): Promise<UnityRenderSurfaceHandle>;
  dispose(): Promise<void>;
}
export interface UnityRendererOptions { signal?: AbortSignal; windowLabel?: string; ownerWindow?: Window; active?: { readonly value: boolean }; }

/** Transport, mounting and input only. C# business methods continue through the
 * existing View callScript API and get RenderOutput.Get(output.id). */
export function createUnityRenderer(workspaceRef: WorkspaceRef, options: UnityRendererOptions = {}): UnityRenderer {
  const reference = Object.freeze({ ...workspaceRef });
  const outputs = new Set<UnityRenderOutput>();
  const cleanupSignal = new AbortController().signal;
  let disposed = false;
  const invoke = <T>(command: string, args: Record<string, unknown> = {}) => getLocusRuntime().invoke<T>(command, { workspaceRef: reference, ...args }, cleanupSignal);
  const assertLive = () => { if (disposed || options.signal?.aborted) throw new DOMException("Renderer execution was released", "AbortError"); };
  const ownerWindow = () => options.ownerWindow ?? window;
  async function dispose() {
    if (disposed) return;
    disposed = true; options.signal?.removeEventListener("abort", onAbort);
    await Promise.allSettled([...outputs].map((output) => output.dispose()));
  }
  const onAbort = () => { void dispose(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  async function createOutput(): Promise<UnityRenderOutput> {
    assertLive();
    // Shared Workbench Views execute in their opener, so IPC's caller window
    // is not necessarily the document that will contain the native surface.
    const ref = await invoke<OutputReference>("unity_renderer_create", options.windowLabel === undefined ? {} : { windowLabel: options.windowLabel });
    if (disposed || options.signal?.aborted) {
      await invoke("unity_renderer_close", { output: ref }).catch(() => {});
      throw new DOMException("Renderer execution was released", "AbortError");
    }
    let closed = false, mounted: UnityRenderSurfaceHandle | null = null, mounting = false;
    let last: UnityRenderStatus = { state: "unmounted" };
    const listeners = new Set<(value: UnityRenderStatus) => void>();
    const publish = (value: UnityRenderStatus) => { last = value; for (const listener of listeners) { try { listener(value); } catch (error) { console.warn("[renderer] status observer failed", error); } } };
    const assertOutput = () => { assertLive(); if (closed) throw new Error("GPU output is closed"); };
    let polling = false;
    async function status() {
      assertOutput();
      const value = await invoke<UnityRenderStatus>("unity_renderer_status", { output: ref });
      if (!closed) publish(value);
      return value;
    }
    // Renews both host and native-window leases even when no layout changes.
    const heartbeat = ownerWindow().setInterval(() => {
      if (closed || polling) return;
      polling = true;
      void status().catch((error) => { if (!closed) publish({ state: "failed", error: error instanceof Error ? error.message : String(error?.message ?? error) }); }).finally(() => { polling = false; });
    }, 1000);
    const output: UnityRenderOutput = {
      id: ref.id, domainGeneration: ref.domainGeneration, status,
      subscribe(listener) { listeners.add(listener); listener(last); return () => listeners.delete(listener); },
      async mount(element) {
        assertOutput();
        if (mounted || mounting) throw new Error("GPU output is already mounted");
        if (element.ownerDocument !== ownerWindow().document || !element.isConnected) throw new Error("Mount into a connected element in the output's owner window");
        mounting = true;
        let visible = true, released = false, dirty = true, frame = 0, inFlight = false;
        let previous = "", previousBounds = "";
        const owner = ownerWindow() as Window & typeof globalThis;
        const active = () => visible && (options.active?.value ?? true);
        const refreshLayout = () => {
          dirty = true;
          // Hidden WebViews may stop rAF. Hide the HWND immediately rather than
          // leaving it above another View until animations resume.
          if (!released && !closed && !inFlight && mounted && (!active() || owner.document.visibilityState === "hidden")) {
            dirty = false; void push(measureRenderLayout(element, active()));
          }
        };
        const push = async (layout: RenderLayout) => {
          const key = JSON.stringify(layout);
          if (key === previous) return;
          previous = key; inFlight = true;
          try { await invoke("unity_renderer_layout", { output: ref, layout }); }
          catch (error) { previous = ""; if (!released && !closed) publish({ state: "failed", error: String((error as Error)?.message ?? error) }); }
          finally { inFlight = false; if (dirty) refreshLayout(); }
        };
        const tick = () => {
          if (released || closed) return;
          const r = element.getBoundingClientRect();
          const bounds = `${r.x},${r.y},${r.width},${r.height},${owner.devicePixelRatio},${active()},${element.isConnected},${owner.document.visibilityState}`;
          if (!inFlight && (dirty || bounds !== previousBounds)) {
            dirty = false; previousBounds = bounds;
            void push(measureRenderLayout(element, active()));
          }
          frame = owner.requestAnimationFrame(tick);
        };
        const observer = new owner.MutationObserver(refreshLayout);
        const resize = new owner.ResizeObserver(refreshLayout);
        const stopObservers = () => {
          owner.cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect();
          owner.removeEventListener("scroll", refreshLayout, true); owner.removeEventListener("resize", refreshLayout);
          owner.document.removeEventListener("visibilitychange", refreshLayout);
        };
        const handle: UnityRenderSurfaceHandle = {
          async dispose() {
            if (released) return; released = true; stopObservers();
            if (mounted === handle) mounted = null;
            await invoke("unity_renderer_detach", { output: ref });
          },
          setVisible(value) { visible = value; refreshLayout(); }, refreshLayout,
        };
        try {
          const layout = measureRenderLayout(element, active());
          await invoke("unity_renderer_mount", { output: ref, layout });
          if (closed || disposed || options.signal?.aborted) { await handle.dispose(); throw new DOMException("Renderer execution was released", "AbortError"); }
          previous = JSON.stringify(layout); mounted = handle;
          observer.observe(owner.document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "hidden", "open"] });
          resize.observe(element);
          owner.addEventListener("scroll", refreshLayout, true); owner.addEventListener("resize", refreshLayout);
          owner.document.addEventListener("visibilitychange", refreshLayout);
          frame = owner.requestAnimationFrame(tick);
          void status().catch(() => {});
          return handle;
        } catch (error) { stopObservers(); throw error; }
        finally { mounting = false; }
      },
      async dispose() {
        if (closed) return; closed = true;
        ownerWindow().clearInterval(heartbeat); outputs.delete(output);
        const current = mounted; mounted = null;
        try { if (current) await current.dispose(); }
        finally { await invoke("unity_renderer_close", { output: ref }); publish({ state: "closed" }); listeners.clear(); }
      },
    };
    outputs.add(output); return output;
  }
  return {
    async capabilities() { assertLive(); if (getLocusRuntime().kind !== "tauri") return { supported: false, reason: "GPU surfaces require a Locus desktop window" }; return invoke<UnityRendererCapabilities>("unity_renderer_capabilities"); },
    createOutput,
    mount(element, output) { assertLive(); if (!outputs.has(output)) return Promise.reject(new Error("GPU output belongs to a different renderer execution")); return output.mount(element); },
    dispose,
  };
}
