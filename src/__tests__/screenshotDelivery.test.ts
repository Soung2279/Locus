import { beforeEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ invoke: vi.fn(), notice: vi.fn() }));
vi.mock("../services/ipc", () => ({ ipcInvoke: transport.invoke }));
vi.mock("../stores/notification", () => ({ useNotificationStore: () => ({ addNotice: transport.notice }) }));
vi.mock("../i18n", () => ({ t: (key: string, ...args: unknown[]) => [key, ...args].join(":") }));
import { registerScreenshotInput } from "../services/screenshots";
import { readSharedComposerDraft, writeSharedComposerDraft } from "../composables/chatComposerDraftMemory";

const image = { data: "png", mimeType: "image/png", capture: { id: "capture-race" } };
beforeEach(() => vi.clearAllMocks());

describe("Unity screenshot commands", () => {
  it("attaches the image and spatial reference together to the originating composer", async () => {
    transport.invoke.mockResolvedValue({ image });
    const add = vi.fn(() => true);
    const input = registerScreenshotInput(() => "capture-current", () => ({ checkoutId: "project-a" }), add);
    await input.capture("scene");
    expect(transport.invoke).toHaveBeenCalledWith("capture_unity_attachment", { target: "scene", workspaceRef: { checkoutId: "project-a" } });
    expect(add).toHaveBeenCalledWith(image);
    input.dispose();
  });

  it("preserves the original draft after switching conversations while a capture is in flight", async () => {
    let resolve!: (value: unknown) => void;
    transport.invoke.mockImplementation(() => new Promise(r => { resolve = r; }));
    let key = "capture-before-switch";
    const workspace = { checkoutId: "project-a" };
    writeSharedComposerDraft(key, { text: "保留这个问题", images: [{ data: "existing", mimeType: "image/png" }], assetRefs: [], localFiles: [], consoleTexts: [], intent: { mode: "build", skills: [] } });
    const add = vi.fn(() => true);
    const input = registerScreenshotInput(() => key, () => workspace, add);
    const pending = input.capture("game");
    key = "capture-after-switch";
    workspace.checkoutId = "project-b";
    resolve({ image });
    await pending;
    expect(transport.invoke.mock.calls[0][1].workspaceRef.checkoutId).toBe("project-a");
    expect(add).not.toHaveBeenCalled();
    expect(readSharedComposerDraft("capture-before-switch")).toMatchObject({ text: "保留这个问题", images: [{ data: "existing" }, image] });
    expect(readSharedComposerDraft(key)).toBeNull();
    input.dispose();
  });

  it("retains a capture when the composer unmounts and ignores repeated activation while pending", async () => {
    let resolve!: (value: unknown) => void;
    transport.invoke.mockImplementation(() => new Promise(r => { resolve = r; }));
    const add = vi.fn(() => true);
    const input = registerScreenshotInput(() => "capture-unmounted", () => ({ checkoutId: "project-a" }), add);
    const pending = input.capture("scene");
    await input.capture("scene");
    expect(transport.invoke).toHaveBeenCalledTimes(1);
    input.dispose();
    resolve({ image });
    await pending;
    expect(add).not.toHaveBeenCalled();
    expect(readSharedComposerDraft("capture-unmounted")?.images).toEqual([image]);
  });

  it("allows retry after a failed capture and keeps an attachment if only clipboard copying fails", async () => {
    transport.invoke.mockRejectedValueOnce(new Error("disconnected")).mockResolvedValueOnce({ image, clipboardError: "busy" });
    const add = vi.fn(() => true);
    const input = registerScreenshotInput(() => "capture-retry", () => ({ checkoutId: "project-a" }), add);
    await expect(input.capture("game")).rejects.toThrow("disconnected");
    await input.capture("game");
    expect(add).toHaveBeenCalledOnce();
    expect(transport.notice).toHaveBeenCalledWith("warning", "capture.clipboardFailed");
    input.dispose();
  });

  it("does not request a capture without a workspace", async () => {
    const input = registerScreenshotInput(() => "no-project", () => null, () => true);
    await expect(input.capture("game")).rejects.toThrow("capture.workspaceRequired");
    expect(transport.invoke).not.toHaveBeenCalled();
    input.dispose();
  });

  it("reports spatial capture failure through the Locus error banner and retains the image", async () => {
    transport.invoke.mockResolvedValue({ image, spatialError: "Depth copy shader unavailable" });
    const add = vi.fn(() => true);
    const input = registerScreenshotInput(() => "capture-partial", () => ({ checkoutId: "project-a" }), add);
    await input.capture("scene");
    expect(add).toHaveBeenCalledWith(image);
    expect(transport.notice).toHaveBeenCalledWith("error", "capture.spatialUnavailable:Depth copy shader unavailable", { operation: "screenshot", replaceOperation: true });
    input.dispose();
  });
});
