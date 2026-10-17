import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../services/ipc", () => ({ ipcInvoke: vi.fn() }));
import { ipcInvoke } from "../services/ipc";
import { knowledgeEdit, knowledgeList, knowledgeRead } from "../services/knowledge";

const invoke = vi.mocked(ipcInvoke);
const workspaceRef = { checkoutId: "properties-checkout", expectedGeneration: 1 };
const document = { id: "kd_character", type: "design", path: "人物.md", title: "人物", injectMode: "none", body: "# 正文", updatedAt: 0 };
beforeEach(() => invoke.mockReset());

describe("knowledge custom properties IPC", () => {
  it("reads custom YAML separately from the editable body", async () => {
    invoke.mockResolvedValueOnce({ kind: "document", document: { ...document, propertiesYaml: "类型: 角色\n别名: [Elora]\n" } });
    const result = await knowledgeRead({ kind: "document", type: "design", path: "人物.md" }, workspaceRef);
    expect(result.document?.propertiesYaml).toBe("类型: 角色\n别名: [Elora]\n");
    expect(result.document?.body).toBe("# 正文");
  });
  it("sends the expected property snapshot even when clearing every property", async () => {
    invoke.mockResolvedValueOnce({ kind: "document", document });
    await knowledgeEdit({ kind: "document", type: "design", path: "人物.md", document: {
      propertiesYaml: "", expectedPropertiesYaml: "类型: 角色\n",
    } }, workspaceRef);
    expect(invoke).toHaveBeenCalledWith("knowledge_edit", expect.objectContaining({ workspaceRef, request: expect.objectContaining({
      path: "design/人物.md", document: { propertiesYaml: "", expectedPropertiesYaml: "类型: 角色\n" },
    }) }));
  });
  it("does not clear loaded custom properties through lightweight list refreshes", async () => {
    invoke.mockResolvedValueOnce([document]);
    const result = await knowledgeList({}, workspaceRef);
    expect(result[0]).not.toHaveProperty("propertiesYaml");
  });
});
