// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNewSessionSettings } from "../composables/useNewSessionSettings";
import { useAgentStore } from "../stores/agent";
import type { AgentInfo } from "../types";

const services = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listSubagentDefs: vi.fn(),
  listWorkspaceAgents: vi.fn(),
  listWorkspaceSubagentDefs: vi.fn(),
}));
vi.mock("../services/agent", () => services);
const selection = vi.hoisted(() => ({
  getWorkspaceSelection: vi.fn(),
  saveWorkspaceSelection: vi.fn(),
}));
vi.mock("../services/selectionMemory", () => selection);

function remembered(projectId: string, agentId: string) {
  return {
    projectId,
    memory: { agentId, modelId: "", effort: "", agents: {}, updatedAtMs: 1 },
    lastAgentId: agentId,
    workspaceDefaultAgentId: null,
  };
}

function agent(id: string, isDefault = false): AgentInfo {
  return { id, name: id, description: "", projectTypes: [], isDefault, source: "app" };
}
const agents = [agent("unity", true), agent("simple"), agent("manual")];

beforeEach(() => {
  setActivePinia(createPinia());
  useNewSessionSettings().reset();
  vi.resetAllMocks();
  services.listAgents.mockResolvedValue(agents);
  services.listSubagentDefs.mockResolvedValue([]);
  services.listWorkspaceAgents.mockResolvedValue(agents);
  services.listWorkspaceSubagentDefs.mockResolvedValue([]);
});

describe("default Agent for new sessions", () => {
  it("applies the saved preference at startup and when starting another session", async () => {
    useNewSessionSettings().setDefaultAgentId("simple");
    const store = useAgentStore();
    await store.loadAgents();
    expect(store.selectedAgentId).toBe("simple");
    store.selectAgent("manual");
    store.resetToDefault();
    expect(store.selectedAgentId).toBe("simple");
  });

  it("applies the preference when switching workspaces without replacing manual selections on refresh", async () => {
    useNewSessionSettings().setDefaultAgentId("simple");
    const store = useAgentStore();
    await store.loadWorkspaceAgents({ checkoutId: "first" });
    expect(store.selectedAgentId).toBe("simple");
    store.selectAgent("manual");
    await store.loadWorkspaceAgents({ checkoutId: "first" });
    await store.loadAppAgents();
    expect(store.selectedAgentId).toBe("manual");
    await store.loadWorkspaceAgents({ checkoutId: "second" });
    expect(store.selectedAgentId).toBe("simple");
  });

  it("falls back for unavailable Agents without losing the saved preference", async () => {
    useNewSessionSettings().setDefaultAgentId("simple");
    const store = useAgentStore();
    services.listWorkspaceAgents.mockResolvedValueOnce([agent("unity", true)]);
    await store.loadWorkspaceAgents({ checkoutId: "first" });
    expect(store.selectedAgentId).toBe("unity");
    expect(useNewSessionSettings().state.defaultAgentId).toBe("simple");
    await store.loadWorkspaceAgents({ checkoutId: "second" });
    expect(store.selectedAgentId).toBe("simple");
    store.agents = [agent("only")];
    store.resetToDefault();
    expect(store.selectedAgentId).toBe("only");
    store.agents = [];
    store.resetToDefault();
    expect(store.selectedAgentId).toBe("");
  });

  it("starts each workspace with its own remembered Agent", async () => {
    selection.getWorkspaceSelection.mockImplementation(async (ref: { checkoutId: string }) => (
      ref.checkoutId === "first" ? remembered("p1", "manual") : remembered("p2", "")
    ));
    const store = useAgentStore();
    await store.loadWorkspaceAgents({ checkoutId: "first" });
    expect(store.selectedAgentId).toBe("manual");
    await store.loadWorkspaceAgents({ checkoutId: "second" });
    expect(store.selectedAgentId).toBe("unity");
    useNewSessionSettings().setDefaultAgentId("simple");
    await store.loadWorkspaceAgents({ checkoutId: "first" });
    expect(store.selectedAgentId).toBe("simple");
  });

  it("keeps existing selections and the legacy-session fallback independent of new-session settings", async () => {
    const store = useAgentStore();
    await store.loadAgents();
    store.selectAgent("manual");
    useNewSessionSettings().setDefaultAgentId("simple");
    expect(store.selectedAgentId).toBe("manual");
    store.resetToDefault({ forNewSession: false });
    expect(store.selectedAgentId).toBe("unity");
    useNewSessionSettings().setDefaultAgentId("");
    store.resetToDefault();
    expect(store.selectedAgentId).toBe("unity");
  });
});
