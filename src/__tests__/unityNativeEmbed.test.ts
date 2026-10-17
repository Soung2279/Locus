import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), syncDocument: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../services/sharedWorkbenchWindow", () => ({ synchronizeDocument: mocks.syncDocument }));
vi.mock("../composables/useTheme", async () => {
  const { ref } = await import("vue");
  return { resolvedTheme: () => "dark", useTheme: () => ({ unityEmbedPreference: ref("dark") }) };
});
import { nativeEmbedWindowHandle, startUnityNativeEmbedHosts, unityNativeEmbedHosts, type UnityNativeEmbedSurface } from "../services/unityNativeEmbed";

const surface = (generation = "one", label = "unity-embed-a"): UnityNativeEmbedSurface => ({ label, generation, documentId: generation, windowId: "session", targetKind: "session", targetId: "", title: "Locus", workspaceRef: { checkoutId: "a", expectedGeneration: 1 }, visible: true, ready: false, error: null });
let changed: (event: { payload: UnityNativeEmbedSurface[] }) => void;
let documentClosed: (event: { payload: string }) => void;
let stop: (() => void) | undefined;
let open: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue([]);
  mocks.listen.mockImplementation(async (name: string, handler: typeof changed & typeof documentClosed) => { if (name === "unity-native-embed:changed") changed = handler; if (name === "unity-native-embed:document-closed") documentClosed = handler; return vi.fn(); });
  mocks.syncDocument.mockImplementation(() => ({ container: { remove: vi.fn() }, dispose: vi.fn() }));
  open = vi.fn(() => ({ document: { title: "", documentElement: { dataset: {} }, addEventListener: vi.fn(), removeEventListener: vi.fn() }, closed: false, focus: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("window", { open, matchMedia: () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
});
afterEach(async () => { stop?.(); stop = undefined; await nextTick(); vi.unstubAllGlobals(); });
async function update(values: UnityNativeEmbedSurface[]) { changed({ payload: values }); await vi.waitFor(() => expect(unityNativeEmbedHosts.size).toBe(values.length)); await nextTick(); }

describe("shared native Unity workbenches", () => {
  it("reports a failed child without preventing another workbench from mounting", async () => {
    open.mockImplementationOnce(() => null);
    mocks.invoke.mockResolvedValueOnce([surface(), surface("two", "unity-embed-b")]);
    stop = await startUnityNativeEmbedHosts();
    expect(unityNativeEmbedHosts.has("unity-embed-a")).toBe(false);
    expect(unityNativeEmbedHosts.has("unity-embed-b")).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("unity_native_embed_failed", expect.objectContaining({ label: "unity-embed-a", generation: "one" }));
  });
  it("acknowledges release even when a disconnected document cannot be cleaned", async () => {
    mocks.invoke.mockResolvedValueOnce([surface()]);
    stop = await startUnityNativeEmbedHosts();
    mocks.syncDocument.mock.results[0]!.value.dispose.mockImplementation(() => { throw new Error("document stopped"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await update([]);
    expect(mocks.invoke).toHaveBeenCalledWith("unity_native_embed_release", { generation: "one" });
    warn.mockRestore();
  });
  it("keeps expected waiting and native error snapshots quiet", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.invoke.mockResolvedValueOnce([{ ...surface(), error: "load-timeout" }]);
    stop = await startUnityNativeEmbedHosts();
    expect(open).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
  it("reuses a parked document with a fresh component scope and drops it on native expiry", async () => {
    mocks.invoke.mockResolvedValue([surface()]); stop = await startUnityNativeEmbedHosts();
    const first = unityNativeEmbedHosts.get("unity-embed-a")!;
    await update([]);
    expect(first.disposed).toBe(true); expect(first.container.remove).toHaveBeenCalledOnce();
    await update([{ ...surface("two"), documentId: "one" }]);
    const second = unityNativeEmbedHosts.get("unity-embed-a")!;
    expect(second).not.toBe(first); expect(second.ownerWindow).toBe(first.ownerWindow);
    expect(open).toHaveBeenCalledTimes(1); expect(mocks.syncDocument).toHaveBeenCalledTimes(2);
    await update([]); documentClosed({ payload: "one" });
    await update([{ ...surface("three"), documentId: "one" }]);
    expect(open).toHaveBeenCalledTimes(2);
  });
  it("keeps the same document for geometry/visibility updates and creates fresh state after close", async () => {
    mocks.invoke.mockResolvedValue([surface()]); stop = await startUnityNativeEmbedHosts();
    const first = unityNativeEmbedHosts.get("unity-embed-a")!;
    await update([{ ...surface(), visible: false, ready: true }]);
    expect(unityNativeEmbedHosts.get("unity-embed-a")).toBe(first);
    expect(open).toHaveBeenCalledTimes(1);
    await update([]); expect(first.disposed).toBe(true); expect(first.container.remove).toHaveBeenCalledOnce();
    await update([surface("two")]); expect(open).toHaveBeenCalledTimes(2);
    expect(unityNativeEmbedHosts.get("unity-embed-a")!.ownerWindow).not.toBe(first.ownerWindow);
  });
  it("routes listeners by logical window and releases registrations that finish after close", async () => {
    mocks.invoke.mockResolvedValue([surface()]); stop = await startUnityNativeEmbedHosts();
    const host = unityNativeEmbedHosts.get("unity-embed-a")!;
    const callback = vi.fn(); const release = vi.fn(); let resolve!: (value: () => void) => void;
    mocks.listen.mockImplementationOnce(() => new Promise<() => void>(done => { resolve = done; }));
    const pending = nativeEmbedWindowHandle(host).listen("workbench-file-open", callback);
    expect(mocks.listen).toHaveBeenLastCalledWith("workbench-file-open", expect.any(Function), { target: { kind: "Window", label: "unity-embed-a" } });
    await update([]); resolve(release); await pending;
    expect(release).toHaveBeenCalledOnce(); expect(host.releases.size).toBe(0);
    const handler = mocks.listen.mock.calls[mocks.listen.mock.calls.length - 1]![1]; handler({ payload: {} }); expect(callback).not.toHaveBeenCalled();
  });
  it("does not replace a newer event with a stale initial snapshot", async () => {
    let resolve!: (value: UnityNativeEmbedSurface[]) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise< UnityNativeEmbedSurface[]>(done => { resolve = done; }));
    const pending = startUnityNativeEmbedHosts(); await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    await update([surface()]); resolve([]); stop = await pending;
    expect(unityNativeEmbedHosts.size).toBe(1); expect(open).toHaveBeenCalledTimes(1);
  });
  it("focuses the current native controller and ignores late requests from a closed host", async () => {
    mocks.invoke.mockResolvedValue([surface()]); stop = await startUnityNativeEmbedHosts();
    const host = unityNativeEmbedHosts.get("unity-embed-a")!;
    const handle = nativeEmbedWindowHandle(host);
    await handle.setFocus();
    expect(mocks.invoke).toHaveBeenLastCalledWith("unity_native_embed_focus", { label: "unity-embed-a", generation: "one" });
    expect(host.ownerWindow.focus).not.toHaveBeenCalled();
    await update([]); const calls = mocks.invoke.mock.calls.length;
    await handle.setFocus(); expect(mocks.invoke).toHaveBeenCalledTimes(calls);
  });
});
