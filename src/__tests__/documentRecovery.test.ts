// @vitest-environment jsdom
import { createApp, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentRecovery } from "../composables/useDocumentRecovery";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("../services/documentRecovery", () => ({ readDocumentRecovery: mocks.read, writeDocumentRecovery: mocks.write }));
vi.mock("../services/tauriRuntime", () => ({ hasTauriWindowRuntime: () => true }));
let app: App | null = null;
const empty = () => ({ schemaVersion: 1, base: "base", draft: null, snapshots: [] });
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick(); } }
async function mount() {
  const key = ref("a"); const base = ref("base"); const text = ref("base"); const enabled = ref(true);
  let recovery!: ReturnType<typeof useDocumentRecovery>;
  app = createApp({ setup() {
    recovery = useDocumentRecovery({ key: () => key.value, base: () => base.value, text: () => text.value, enabled: () => enabled.value, apply: value => { text.value = value; } });
    return () => null;
  } });
  app.mount(document.createElement("div")); await flush();
  return { key, base, text, enabled, recovery };
}
beforeEach(() => { vi.useFakeTimers(); mocks.read.mockResolvedValue(empty()); mocks.write.mockResolvedValue(empty()); });
afterEach(async () => { app?.unmount(); await flush(); mocks.read.mockReset(); mocks.write.mockReset(); vi.useRealTimers(); });
describe("shared durable document recovery", () => {
  it("offers a recovered draft without overwriting the current disk contents", async () => {
    mocks.read.mockResolvedValue({ ...empty(), draft: { text: "unsaved", at: 1 } });
    const { recovery, text } = await mount();
    expect(recovery.pending.value?.text).toBe("unsaved");
    expect(text.value).toBe("base");
    expect(mocks.write).not.toHaveBeenCalled();
    recovery.restore(recovery.pending.value!); await flush(); await vi.advanceTimersByTimeAsync(301);
    expect(text.value).toBe("unsaved");
    expect(mocks.write).toHaveBeenCalledWith("a", "base", "unsaved", false);
    expect(mocks.write).toHaveBeenCalledWith("a", "base", "base", true);
  });
  it("backs up continued typing against the acknowledged save, not the latest renderer model", async () => {
    const { recovery, text, base } = await mount();
    text.value = "submitted and continued"; recovery.changed();
    base.value = "submitted"; await flush(); await vi.advanceTimersByTimeAsync(301);
    expect(mocks.write).toHaveBeenLastCalledWith("a", "submitted", "submitted and continued", false);
  });
  it("flushes the previous document before switching to a read-only document", async () => {
    const { recovery, text, key, enabled } = await mount();
    text.value = "unsaved a"; recovery.changed();
    key.value = "b"; enabled.value = false; text.value = "b";
    await flush();
    expect(mocks.write).toHaveBeenCalledWith("a", "base", "unsaved a", false);
  });
  it("keeps a failed recovery read visible and does not overwrite the backup", async () => {
    mocks.read.mockRejectedValue(new Error("corrupt backup"));
    const { recovery, text } = await mount();
    text.value = "new"; recovery.changed(); await vi.advanceTimersByTimeAsync(1000);
    expect(recovery.error.value).toContain("corrupt backup");
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
