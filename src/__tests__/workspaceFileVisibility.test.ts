// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceFileVisibility, workspacePathIsHidden } from "../composables/useWorkspaceFileVisibility";
import { workspaceFileEntries } from "../components/explorer/workspaceFileTree";
import type { AssetExplorerNode } from "../composables/useAssetState";

const storageKey = (id: string) => `locus:workspaceHiddenFiles:${id}`;
const sync = (key: string | null = null) => window.dispatchEvent(new StorageEvent("storage", { key }));
beforeEach(() => { localStorage.clear(); sync(); });

describe("file mode visibility", () => {
  it("persists files and folders per checkout and restores across windows and remounts", () => {
    const store = useWorkspaceFileVisibility();
    store.setHidden("a", "Notes/draft.md", true);
    store.setHidden("a", "Library", true);
    store.setHidden("b", "README.md", true);
    expect(store.paths("a")).toEqual(["Notes/draft.md", "Library"]);
    expect(store.paths("b")).toEqual(["README.md"]);
    sync();
    expect(useWorkspaceFileVisibility().paths("a")).toEqual(["Notes/draft.md", "Library"]);
    localStorage.setItem(storageKey("a"), '["remote.md"]'); sync(storageKey("a"));
    expect(store.paths("a")).toEqual(["remote.md"]);
    store.setHidden("a", "remote.md", false);
    expect(JSON.parse(localStorage.getItem(storageKey("a"))!)).toEqual([]);
    expect(store.paths("b")).toEqual(["README.md"]);
  });

  it("keeps separately hidden descendants when their parent is restored", () => {
    const store = useWorkspaceFileVisibility();
    store.setHidden("a", "Notes/draft.md", true);
    store.setHidden("a", "Notes", true);
    expect(workspacePathIsHidden("Notes/visible.md", store.paths("a"))).toBe(true);
    expect(workspacePathIsHidden("Notes-old/draft.md", store.paths("a"))).toBe(false);
    store.setHidden("a", "Notes", false);
    expect(workspacePathIsHidden("Notes/visible.md", store.paths("a"))).toBe(false);
    expect(workspacePathIsHidden("Notes/draft.md", store.paths("a"))).toBe(true);
  });

  it("remaps hidden descendants after folder moves and removes deleted preferences", () => {
    const store = useWorkspaceFileVisibility();
    for (const path of ["Notes", "Notes/draft.md", "Notes-old/keep.md"]) store.setHidden("a", path, true);
    store.remap("a", "Notes", "Archive/Notes");
    store.remap("a", "Notes", "Archive/Notes"); // Duplicate cross-window event.
    expect(store.paths("a")).toEqual(["Archive/Notes", "Archive/Notes/draft.md", "Notes-old/keep.md"]);
    store.remap("a", "Archive/Notes", null);
    expect(store.paths("a")).toEqual(["Notes-old/keep.md"]);
  });

  it("recovers malformed storage and excludes roots, traversal and absolute paths", () => {
    localStorage.setItem(storageKey("a"), '[null,1,".","../x","C:/x","/x","Notes\\\\draft.md","Notes/draft.md"]');
    const store = useWorkspaceFileVisibility();
    expect(store.paths("a")).toEqual(["Notes/draft.md"]);
    localStorage.setItem(storageKey("a"), "bad json"); sync(storageKey("a"));
    expect(store.paths("a")).toEqual([]);
    for (const path of [".", "", "../x", "C:/x"]) store.setHidden("a", path, true);
    expect(store.paths("a")).toEqual([]);
  });

  it("filters whole subtrees without mutating nodes or removing the next-page control", () => {
    const file = (path: string): AssetExplorerNode => ({ kind: "file", path, name: path.split("/").pop()!, depth: 1 });
    const folder = (path: string, children: AssetExplorerNode[], isRoot = false): AssetExplorerNode => ({
      kind: "folder", path, name: path, children, isRoot, depth: 0, loaded: true, loading: false,
      hasMore: true, nextOffset: 200, totalCount: 201, hasChildFolders: true, hasChildFoldersKnown: true, branchProbeLoading: false,
    });
    const tree = [folder(".", [folder("Notes", [file("Notes/draft.md")]), file("hidden.md"), file("visible.md")], true)];
    const entries = workspaceFileEntries(tree, () => true, "More", path => workspacePathIsHidden(path, ["Notes", "hidden.md"]));
    expect(entries.map(entry => entry.key)).toEqual(["visible.md", ".::load-more"]);
    expect(tree[0]?.kind === "folder" && tree[0].children).toHaveLength(3);
  });
});
