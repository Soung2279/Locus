import { beforeEach, describe, expect, it, vi } from "vitest";
import { marked } from "marked";
import { ipcInvoke } from "../services/ipc";
import { relativeMarkdownResource } from "../services/markdownImage";
import { markdownMentionText, searchMarkdownMentionResources } from "../components/ui/markdown-editor/markdownMentionResources";

vi.mock("../services/ipc", () => ({ ipcInvoke: vi.fn() }));
vi.mock("../services/markdownImage", () => ({ relativeMarkdownResource: vi.fn() }));
const scope = { checkoutId: "one", expectedGeneration: 7, expectedMaterializationEpoch: 2 };

function knowledge(path: string, title: string, extra = {}) {
  return { id: path, path, title, type: "design", storageSource: "project", score: 5, snippet: "", ...extra };
}
beforeEach(() => { vi.clearAllMocks(); });

describe("Markdown mention resources", () => {
  it("merges files, images and knowledge titles, deduplicating their physical paths", async () => {
    vi.mocked(ipcInvoke).mockImplementation(async (command) => {
      if (command === "search_workspace_entries") return [
        { relPath: "Locus/knowledge/design/guide.md", name: "guide.md", isDir: false, matchScore: 4 },
        { relPath: "Assets/guide.png", name: "guide.png", isDir: false, matchScore: 2 },
        { relPath: "Assets/guide", name: "guide", isDir: true },
        { relPath: "Assets/guide.png.meta", name: "guide.png.meta", isDir: false },
      ];
      if (command === "search_workspace_assets") return [{ path: "Assets/guide.png", name: "guide.png", matchScore: 4 }];
      if (command === "knowledge_query") return [knowledge("guide.md", "Guide 文档"), knowledge("global.md", "global", { storageSource: "global" })];
      throw new Error(command);
    });
    const results = await searchMarkdownMentionResources("guide", scope);
    expect(results.map(item => item.relPath)).toEqual(["Locus/knowledge/design/guide.md", "Assets/guide.png"]);
    expect(results[0]?.name).toBe("Guide 文档");
    expect(ipcInvoke).toHaveBeenCalledWith("search_workspace_entries", expect.objectContaining({ query: "guide", workspaceRef: scope }));
  });

  it("lists initial documents and root files for bare @, keeping full-text-only hits", async () => {
    vi.mocked(ipcInvoke).mockImplementation(async command => {
      if (command === "list_dir_entries_page") return { entries: [{ relPath: "README.md", name: "README.md", isDir: false }] };
      if (command === "knowledge_list_page") return { items: [knowledge("design/topic.md", "Topic")], nextCursor: null };
      if (command === "knowledge_query") return [knowledge("topic.md", "Topic", { snippet: "semantic match" })];
      return [];
    });
    expect((await searchMarkdownMentionResources("", scope)).map(item => item.relPath))
      .toEqual(["README.md", "Locus/knowledge/design/topic.md"]);
    expect((await searchMarkdownMentionResources("different body keyword", scope)).map(item => item.name)).toEqual(["Topic"]);
  });

  it("retains successful providers and surfaces total failure", async () => {
    vi.mocked(ipcInvoke).mockImplementation(async command => {
      if (command === "search_workspace_entries") return [{ relPath: "docs/a.md", name: "a.md", isDir: false, matchScore: 1 }];
      throw new Error("offline");
    });
    expect(await searchMarkdownMentionResources("a", scope)).toHaveLength(1);
    vi.mocked(ipcInvoke).mockRejectedValue(new Error("offline"));
    await expect(searchMarkdownMentionResources("a", scope)).rejects.toThrow("资源搜索失败");
  });

  it.each([false, true])("inserts escaped labels with a document-relative URL (image=%s)", async image => {
    vi.mocked(relativeMarkdownResource).mockResolvedValue("../images/My%20file%20%281%29%23a.png");
    const path = image ? "images/My file (1)#a.png" : "docs/file.md";
    const text = await markdownMentionText({ name: "[my]*file*", relPath: path, parentPath: "", entryKind: "asset", matchScore: 0 }, scope, "docs/current.md");
    expect(relativeMarkdownResource).toHaveBeenCalledWith(scope, "docs/current.md", path);
    expect(text.startsWith(image ? "![" : "[")).toBe(true);
    const html = marked.parse(text) as string;
    expect(html).toContain("../images/My%20file%20%281%29%23a.png");
    expect(html).not.toContain("<em>"); expect(html).not.toContain("<strong>");
    expect(html).toContain("[my]*file*");
  });
});
