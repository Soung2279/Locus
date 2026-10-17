// @vitest-environment jsdom
import { createApp, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetExplorerNode } from "../composables/useAssetState";
import { WORKSPACE_FILE_ROW_HEIGHT, workspaceFileEntries } from "../components/explorer/workspaceFileTree";
import WorkspaceTree from "../components/explorer/WorkspaceTree.vue";
import AssetLegacyExplorer from "../components/asset/AssetLegacyExplorer.vue";

const file = (path: string): AssetExplorerNode => ({ kind: "file", path, name: path.split("/").pop()!, depth: path.split("/").length });
const folder = (path: string, children: AssetExplorerNode[] = [], extra = {}): AssetExplorerNode => ({
  kind: "folder", path, name: path === "." ? "Workspace" : path.split("/").pop()!, depth: path === "." ? 0 : 1,
  isRoot: path === ".", children, loaded: true, loading: false, hasMore: false, nextOffset: 0, totalCount: children.length,
  hasChildFoldersKnown: true, hasChildFolders: false, branchProbeLoading: false, ...extra,
});
let app: App | undefined;
afterEach(() => { app?.unmount(); app = undefined; document.body.innerHTML = ""; });

describe("workspace file tree", () => {
  it("hides CSV view sidecars like Unity metadata while keeping CSVs, other views and folders visible", () => {
    const tree = [folder(".", [
      file("事件大纲表.csv"), file("事件大纲表.csv.view"), file("事件大纲表.csv.meta"), file("事件大纲表.csv.view.meta"),
      file("orphan.csv.view"), file("dashboard.view"), file("notes.csv.view.md"),
      folder("Nested", [file("Nested/DATA.CSV"), file("Nested/DATA.CSV.VIEW")]),
      folder("Archive.csv.view", [file("Archive.csv.view/README.md")]),
    ], { hasMore: true })];
    const entries = workspaceFileEntries(tree, () => true, "More");
    expect(entries.map(entry => entry.key)).toEqual([
      "事件大纲表.csv", "dashboard.view", "notes.csv.view.md", "Nested", "Nested/DATA.CSV",
      "Archive.csv.view", "Archive.csv.view/README.md", ".::load-more",
    ]);
    expect(tree[0]?.kind === "folder" && tree[0].children).toHaveLength(9);
  });

  it("reveals the whole last row below the navigation's top padding", async () => {
    const host = document.createElement("div"); document.body.appendChild(host);
    const entries = workspaceFileEntries([folder(".", Array.from({ length: 20 }, (_,i) => file(`${i}.md`)))], () => true, "More");
    app = createApp(WorkspaceTree, { items: entries, rowHeight: WORKSPACE_FILE_ROW_HEIGHT, navigation: true });
    const tree = app.mount(host) as unknown as { scrollToIndex: (index: number) => void };
    await nextTick();
    const list = host.querySelector<HTMLElement>(".file-tree-list")!;
    list.style.paddingTop = "12px";
    Object.defineProperty(list, "clientHeight", { value: WORKSPACE_FILE_ROW_HEIGHT * 2 });
    tree.scrollToIndex(19);
    expect(list.scrollTop + list.clientHeight).toBe(12 + entries.length * WORKSPACE_FILE_ROW_HEIGHT);
  });

  it("omits the redundant root but keeps nested expansion and pagination", () => {
    const tree = [folder(".", [folder("Assets", [file("Assets/Main.cs")], { hasMore: true }), file("README.md")], { hasMore: true })];
    const closed = workspaceFileEntries(tree, () => false, "More");
    expect(closed.map(item => item.key)).toEqual(["Assets", "README.md", ".::load-more"]);
    expect(closed.map(item => item.treeRow?.depth)).toEqual([0, 0, 0]);
    const open = workspaceFileEntries(tree, path => path === "Assets", "More");
    expect(open.map(item => [item.key, item.treeRow?.depth])).toEqual([
      ["Assets", 0], ["Assets/Main.cs", 1], ["Assets::load-more", 1], ["README.md", 0], [".::load-more", 0],
    ]);
    expect(tree[0]?.depth).toBe(0);
  });

  it("uses the session tree component and forwards file, folder and context actions", async () => {
    const select = vi.fn(), toggle = vi.fn(), context = vi.fn(), loadMore = vi.fn();
    const props = reactive({ workingDir: "C:/Project", workspaceStyle: true,
      tree: [folder(".", [folder("Assets", [file("Assets/Main.cs")]), file("README.md")])],
      selectedPath: "README.md", isPathExpanded: (path: string) => path === "Assets",
      onSelect: select, onToggle: toggle, onFileContextmenu: context, onLoadMore: loadMore,
    });
    const host = document.createElement("div"); document.body.appendChild(host);
    app = createApp(AssetLegacyExplorer, props); app.mount(host); await nextTick();
    expect(host.querySelector(".workspace-tree.is-navigation")).not.toBeNull();
    expect(host.querySelector(".alx-row")).toBeNull();
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".workspace-tree-row")];
    expect(rows.map(row => row.textContent?.trim())).toEqual(["Assets", "Main.cs", "README.md"]);
    rows[0]!.click(); expect(toggle).toHaveBeenCalledWith("Assets");
    rows[2]!.click(); expect(select.mock.calls[0]?.[0].path).toBe("README.md");
    rows[2]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(context.mock.calls[0]?.[0].path).toBe("README.md");
    rows[0]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(context.mock.calls[1]?.[0].path).toBe("Assets");
    expect(host.querySelector('.workspace-tree-row-shell.selected')?.textContent).toContain("README.md");
    expect(rows[2]!.tabIndex).toBe(0);
  });

  it("loads the hidden root's next page when it enters the virtual window", async () => {
    const more = vi.fn();
    const host = document.createElement("div");
    app = createApp(AssetLegacyExplorer, { workspaceStyle: true,
      tree: [folder(".", [file("README.md")], { hasMore: true })],
      selectedPath: null, isPathExpanded: () => true, onLoadMore: more });
    app.mount(host); await nextTick();
    expect(more).toHaveBeenCalledWith(".");
  });
});
