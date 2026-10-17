// @vitest-environment jsdom
import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import { useDisplaySettings } from "../composables/useDisplaySettings";
import { viewOpenPreferenceKey } from "../services/viewOpening";
import ViewResourceMenuItems from "../components/view/ViewResourceMenuItems.vue";
import ViewConfigDialog from "../components/view/ViewConfigDialog.vue";
import type { ViewPackageSummary } from "../services/view";

const mocks = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn() }));
vi.mock("../services/view", async original => ({ ...await original<object>(), viewRead: mocks.read, viewUpdateMetadata: mocks.update }));
const apps: App[] = [];
const view: ViewPackageSummary = { id: "hero", name: "Hero", icon: "View", apiVersion: "1", version: "0.1.0", displayPath: "Tools/hero", packageRoot: "F:/project/Locus/View/hero", manifestPath: "F:/project/Locus/View/hero/hero.vue", updatedAt: 0, capabilities: { unity: false }, requirements: { unityConnection: false } };
const scope = { checkoutId: "checkout", expectedGeneration: 4, expectedMaterializationEpoch: 2 };
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick(); } }
function mount(component: typeof ViewConfigDialog | typeof ViewResourceMenuItems, props: Record<string, unknown>) {
  const root = document.createElement("div"); document.body.append(root);
  const app = createApp(component, props); apps.push(app); app.mount(root); return root;
}
function button(root: ParentNode, text: string) { return [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text)!; }
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.open = true; } });
  useDisplaySettings().set("viewOpenOverrides", {});
  mocks.read.mockResolvedValue({ summary: view, manifest: { name: view.name, icon: view.icon } });
  mocks.update.mockImplementation(async (_scope, request) => ({ ...view, name: request.name, icon: request.icon }));
});
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); document.body.replaceChildren(); });

describe("View configuration and domain menu parity", () => {
  it("exposes the complete domain menu with working action dispatch", () => {
    const action = vi.fn();
    const root = mount(ViewResourceMenuItems, { view, onAction: action });
    const actions = [
      ["view.tree.rename", "rename"], ["view.config.title", "configure"],
      ["view.action.openInUnity", "unity"], ["view.action.export", "export"],
      ["view.action.reveal", "reveal"], ["knowledge.explorer.copyRelativePath", "copy"], ["view.tree.delete", "delete"],
    ];
    for (const [key, value] of actions) { button(root, t(key!)).click(); expect(action).toHaveBeenLastCalledWith(value); }
  });
  it("keeps plugin configuration accessible without offering package mutations", () => {
    const root = mount(ViewResourceMenuItems, { view: { ...view, pluginId: "plugin.hero", pluginName: "Hero Plugin" } });
    expect(button(root, t("view.config.title"))).toBeDefined();
    for (const key of ["view.tree.rename", "view.tree.delete", "view.action.export"]) expect(button(root, t(key))).toBeUndefined();
    expect(root.textContent).toContain("Hero Plugin");
  });
  it("saves name, icon and the per-view target against the captured checkout", async () => {
    const close = vi.fn();
    mount(ViewConfigDialog, { view, workspaceRef: scope, onClose: close }); await flush();
    const dialog = document.querySelector("dialog")!;
    const inputs = dialog.querySelectorAll("input");
    inputs[0]!.value = "Character Editor"; inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    inputs[1]!.value = "ContactRound"; inputs[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    button(dialog, t("settings.display.viewOpenWindow")).click();
    dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await flush();
    expect(mocks.update).toHaveBeenCalledWith(scope, { viewId: view.id, name: "Character Editor", icon: "ContactRound" });
    expect(useDisplaySettings().state.viewOpenOverrides[viewOpenPreferenceKey(scope, view.id)]).toBe("window");
    expect(close).toHaveBeenCalledOnce();
  });
  it("does not save a preference or close the dialog when metadata saving fails", async () => {
    mocks.update.mockRejectedValue(new Error("Write failed"));
    const close = vi.fn(); mount(ViewConfigDialog, { view, workspaceRef: scope, onClose: close }); await flush();
    const dialog = document.querySelector("dialog")!;
    const input = dialog.querySelector("input")!; input.value = "Changed"; input.dispatchEvent(new Event("input", { bubbles: true }));
    button(dialog, t("settings.display.viewOpenWindow")).click();
    dialog.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await flush();
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Write failed");
    expect(close).not.toHaveBeenCalled();
    expect(useDisplaySettings().state.viewOpenOverrides).toEqual({});
  });
  it("lets plugin views override opening without rewriting their package", async () => {
    const plugin = { ...view, pluginId: "plugin.hero" };
    mocks.read.mockResolvedValue({ summary: plugin, manifest: { name: plugin.name, icon: plugin.icon } });
    mount(ViewConfigDialog, { view: plugin, workspaceRef: scope }); await flush();
    const dialog = document.querySelector("dialog")!;
    expect([...dialog.querySelectorAll("input")].every(input => input.disabled)).toBe(true);
    button(dialog, t("settings.display.viewOpenTab")).click();
    dialog.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await flush();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(useDisplaySettings().state.viewOpenOverrides[viewOpenPreferenceKey(scope, view.id)]).toBe("tab");
  });
});
