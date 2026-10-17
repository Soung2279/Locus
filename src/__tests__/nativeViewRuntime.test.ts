import { describe, expect, it, vi } from "vitest";
import { createNativeViewRuntime } from "../services/nativeViewRuntime";
import { getLocusRuntime, installLocusRuntime, invokeLocusRuntime, withLocusInvocationSignal } from "../services/locusRuntime";
import { WORKSPACE_EVENT_NAME } from "../services/workspaceEventHub";

const token = "a".repeat(64);
const reply = (value: unknown) => new Response(JSON.stringify({ ok: true, result: value }), { headers: { "Content-Type": "application/json" } });
describe("native Unity View runtime", () => {
  it("requires a scoped loopback connection and sends the token only in the authorization header", async () => {
    expect(() => createNativeViewRuntime("https://example.com", token)).toThrow();
    expect(() => createNativeViewRuntime("http://127.0.0.1:1234", "short")).toThrow();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ value: 7 }));
    const bridge = createNativeViewRuntime("http://127.0.0.1:1234", token, fetcher);
    const release = installLocusRuntime(bridge.runtime);
    try {
      expect(getLocusRuntime().kind).toBe("unity");
      expect(await invokeLocusRuntime("unity_serialized_property_read", { request: { target: "test" } })).toEqual({ value: 7 });
      const [url, options] = fetcher.mock.calls[0]!;
      expect(url).toBe("http://127.0.0.1:1234/native-view/invoke");
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      expect(options?.body).toBe(JSON.stringify({ command: "unity_serialized_property_read", args: { request: { target: "test" } } }));
    } finally { release(); bridge.dispose(); }
  });
  it("shares one event poll and aborts it when the last View subscription leaves", async () => {
    let pendingSignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      pendingSignal = options?.signal as AbortSignal;
      pendingSignal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
    const bridge = createNativeViewRuntime("http://127.0.0.1:1234", token, fetcher);
    const first = await bridge.runtime.subscribe(WORKSPACE_EVENT_NAME, () => {});
    const second = await bridge.runtime.subscribe(WORKSPACE_EVENT_NAME, () => {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(bridge.stats().subscriptions).toBe(2);
    first(); expect(pendingSignal?.aborted).toBe(false);
    second(); expect(pendingSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(bridge.stats()).toEqual({ pending: 0, subscriptions: 0, eventPolling: false }));
    bridge.dispose();
  });
  it("disposes pending requests and rejects a delayed result", async () => {
    let complete!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const bridge = createNativeViewRuntime("http://127.0.0.1:1234", token, fetcher);
    const request = bridge.runtime.invoke("view_read");
    bridge.dispose(); complete(reply({ stale: true }));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(bridge.stats().pending).toBe(0);
  });
  it("keeps backend errors and rejects unsupported event channels", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "Cross-workspace request rejected" })));
    const bridge = createNativeViewRuntime("http://127.0.0.1:1234", token, fetcher);
    await expect(bridge.runtime.invoke("view_read")).rejects.toThrow("Cross-workspace");
    await expect(bridge.runtime.subscribe("tauri://private", () => {})).rejects.toThrow("not available");
    bridge.dispose();
  });
  it("cancels only the released binding's requests in a shared transport", async () => {
    const signals: AbortSignal[] = [];
    const complete: Array<(response: Response) => void> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((resolve, reject) => {
      const signal = options!.signal as AbortSignal; signals.push(signal); complete.push(resolve);
      signal.addEventListener("abort", () => reject(new DOMException("released", "AbortError")), { once: true });
    }));
    const bridge = createNativeViewRuntime("http://127.0.0.1:1234", token, fetcher);
    const uninstall = installLocusRuntime(bridge.runtime);
    try {
      const binding = new AbortController();
      const old = withLocusInvocationSignal(binding.signal, () => getLocusRuntime().invoke("view_read"));
      const other = invokeLocusRuntime("view_read");
      binding.abort();
      await expect(old).rejects.toMatchObject({ name: "AbortError" });
      expect(signals[1]!.aborted).toBe(false);
      complete[1]!(reply("other binding"));
      expect(await other).toBe("other binding");
      expect(bridge.stats().pending).toBe(0);
    } finally { uninstall(); bridge.dispose(); }
  });
});
