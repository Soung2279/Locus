// @vitest-environment jsdom
import { createPinia } from "pinia";
import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../services/ipc", () => ({ ipcInvoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../components/ui/BaseMarkdownEditor.vue", () => ({ default: defineComponent(() => () => h("div")) }));
import AgentView from "../components/AgentView.vue";
import { useAgentStore } from "../stores/agent";
import { useNewSessionSettings } from "../composables/useNewSessionSettings";
import { t } from "../i18n";

const workspaceRef = { checkoutId: "a", expectedGeneration: 2, expectedMaterializationEpoch: 3 };
function agent(id: string, isDefault = false): AgentInfo {
  return { id, name: id, description: "", projectTypes: [], isDefault, source: "app" };
}
let app: App | undefined;
let host: HTMLDivElement;
let defaults: Record<string, string>;
async function flush() { for (let i = 0; i < 20; i++) await nextTick(); }
function row(id: string) {
  return Array.from(host.querySelectorAll<HTMLButtonElement>(".agent-tab"))
    .find(element => element.querySelector(".agent-tab-name")?.textContent === id)!;
}
async function openMenu(id: string) {
  row(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 30 }));
  await flush();
  return document.querySelector<HTMLButtonElement>(".agent-list-ctx-menu button");
}
async function mount(props: Record<string, unknown> = {}) {
  app = createApp(() => h(AgentView, { listOnly: true, workingDir: "F:/a", workspaceRef, ...props }));
  const pinia = createPinia();
  app.use(pinia); app.mount(host); await flush();
  return pinia;
}

beforeEach(() => {
  defaults = { a: "simple", b: "unity" };
  useNewSessionSettings().reset();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, any>) => {
    switch (command) {
      case "list_workspace_agents": return ["simple", "unity"].map(id => agent(id, defaults[args!.workspaceRef.checkoutId] === id));
      case "list_workspace_subagent_defs": return [agent("explorer")];
      case "set_workspace_default_agent": defaults[args!.workspaceRef.checkoutId] = args!.agentId; return;
      default: return [];
    }
  });
  host = document.createElement("div"); document.body.appendChild(host);
});
afterEach(() => { app?.unmount(); app = undefined; document.body.innerHTML = ""; });

describe("workspace default Agent", () => {
  it("marks the workspace default and persists the context-menu choice for new sessions", async () => {
    const onOpenAgent = vi.fn();
    const pinia = await mount({ onOpenAgent });
    const store = useAgentStore(pinia);
    await store.loadWorkspaceAgents(workspaceRef);
    expect(row("simple").querySelector(".agent-tab-default")?.textContent).toBe(t("agent.selector.default"));
    expect(row("simple").querySelector(".agent-tab-default")?.getAttribute("title")).toBe(t("agent.workspaceDefault"));
    expect(host.querySelectorAll(".agent-tab-default")).toHaveLength(1);
    const action = await openMenu("unity");
    expect(action?.textContent).toBe(t("agent.setWorkspaceDefault"));
    action!.click(); await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("set_workspace_default_agent", { workspaceRef, agentId: "unity" });
    expect(onOpenAgent).not.toHaveBeenCalled();
    expect(row("simple").querySelector(".agent-tab-default")).toBeNull();
    expect(row("unity").querySelector(".agent-tab-default")).not.toBeNull();
    await store.loadWorkspaceAgents(workspaceRef);
    expect(store.selectedAgentId).toBe("simple"); // Existing selection stays intact.
    store.resetToDefault();
    expect(store.selectedAgentId).toBe("unity");
  });

  it("disables the current default and excludes subagents and app-only lists", async () => {
    await mount();
    expect((await openMenu("simple"))?.disabled).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); await flush();
    expect(await openMenu("explorer")).toBeNull();
    app!.unmount(); app = undefined;
    await mount({ workspaceRef: null, agentList: [agent("simple", true)] });
    expect(host.querySelector(".agent-tab-default")).toBeNull();
    expect(await openMenu("simple")).toBeNull();
  });

  it("retains the original default and displays a failed save", async () => {
    await mount();
    const implementation = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "set_workspace_default_agent"
      ? Promise.reject(new Error("Cannot save workspace default")) : implementation(command, args));
    (await openMenu("unity"))!.click(); await flush();
    expect(row("simple").querySelector(".agent-tab-default")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Cannot save workspace default");
    expect((await openMenu("unity"))?.disabled).toBe(false);
  });

  it("closes the menu when the workspace changes and ignores a late save error", async () => {
    const props = reactive({ workspaceRef, workingDir: "F:/a" });
    await mount(props);
    let reject!: (error: Error) => void;
    const implementation = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "set_workspace_default_agent"
      ? new Promise<void>((_resolve, fail) => { reject = fail; }) : implementation(command, args));
    (await openMenu("unity"))!.click(); await flush();
    await openMenu("simple");
    props.workspaceRef = { ...workspaceRef, checkoutId: "b" };
    props.workingDir = "F:/b";
    await flush();
    expect(document.querySelector(".agent-list-ctx-menu")).toBeNull();
    expect(row("unity").querySelector(".agent-tab-default")).not.toBeNull();
    reject(new Error("Old workspace failure")); await flush();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(row("unity").querySelector(".agent-tab-default")).not.toBeNull();
  });
});
