import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestWorkspaceSetup, useWorkspaceSetup } from "../composables/useWorkspaceSetup";
import { inspectWorkspaceSetup, saveWorkspaceSetup, projectKnowledgeEnabled } from "../services/project";

vi.mock("../services/project", async original => ({
  ...await original<typeof import("../services/project")>(),
  inspectWorkspaceSetup: vi.fn(),
  saveWorkspaceSetup: vi.fn(),
}));
const inspect = vi.mocked(inspectWorkspaceSetup);
const save = vi.mocked(saveWorkspaceSetup);
const setup = useWorkspaceSetup();
beforeEach(() => {
  vi.clearAllMocks();
  inspect.mockResolvedValue({ isUnityProject: false, knowledgeEnabled: false, unityTestToolsEnabled: false });
  save.mockImplementation(async (_path, value) => value);
});
afterEach(() => setup.cancel());

describe("workspace setup", () => {
  it("does not save anything when directory configuration is cancelled", async () => {
    const result = requestWorkspaceSetup("G:/story");
    await vi.waitFor(() => expect(setup.request.value?.path).toBe("G:/story"));
    expect(setup.request.value?.setup.knowledgeEnabled).toBe(false);
    setup.cancel();
    expect(await result).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("saves the confirmed Unity defaults before allowing the workspace to open", async () => {
    inspect.mockResolvedValue({ isUnityProject: true, knowledgeEnabled: true, unityTestToolsEnabled: false });
    const result = requestWorkspaceSetup("G:/unity");
    await vi.waitFor(() => expect(setup.request.value).not.toBeNull());
    expect(setup.request.value?.setup.knowledgeEnabled).toBe(true);
    await setup.save();
    expect(await result).toBe(true);
    expect(save).toHaveBeenCalledWith("G:/unity", { isUnityProject: true, knowledgeEnabled: true, unityTestToolsEnabled: false, extraWorkdirs: [] });
    expect(setup.request.value).toBeNull();
  });

  it("keeps the panel and user choices after a save failure for retry", async () => {
    save.mockRejectedValueOnce(new Error("read-only directory"));
    const result = requestWorkspaceSetup("G:/story");
    await vi.waitFor(() => expect(setup.request.value).not.toBeNull());
    setup.request.value!.setup.knowledgeEnabled = true;
    await expect(setup.save()).rejects.toThrow("read-only directory");
    expect(setup.saving.value).toBe(false);
    expect(setup.request.value?.setup.knowledgeEnabled).toBe(true);
    await setup.save();
    expect(await result).toBe(true);
  });

  it("does not expose a knowledge catalog for disabled or missing checkouts", () => {
    expect(projectKnowledgeEnabled({ projectId: "p", detectedServices: [], checkouts: [{
      projectId: "p", checkoutId: "c", root: "G:/story", normalizedRoot: "g:/story", lastOpenedAt: 0, knowledgeEnabled: false,
    }] })).toBe(false);
  });
});
