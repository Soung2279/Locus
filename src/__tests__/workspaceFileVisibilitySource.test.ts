// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import WorkspaceFileTreeSource from "../components/explorer/WorkspaceFileTreeSource.vue";
import { useWorkspaceFileVisibility } from "../composables/useWorkspaceFileVisibility";
import type { AssetExplorerNode } from "../composables/useAssetState";
import type { WorkspaceFileTreeState } from "../components/explorer/workspaceFileTree";
import type { ExplorerFileActionEvent } from "../services/workspaceExplorer";

const mocks = vi.hoisted(() => ({ asset: vi.fn(), order: vi.fn(), actions: new Set<(event: ExplorerFileActionEvent) => void>() }));
vi.mock("../composables/useAssetState", () => ({ useAssetState: mocks.asset }));
vi.mock("../composables/useWorkspaceFileOrder", () => ({ useWorkspaceFileOrder: mocks.order }));
vi.mock("../services/workspaceExplorer", () => ({
  subscribeExplorerFileActions: vi.fn(async (listener: (event: ExplorerFileActionEvent) => void) => {
    mocks.actions.add(listener); return () => { mocks.actions.delete(listener); };
  }),
}));
let app: App | undefined;
afterEach(() => { app?.unmount(); app = undefined; });
async function flush() { for (let i = 0; i < 8; i++) await nextTick(); }

it("updates main-tree rows, filters reorder siblings and follows file moves only in the matching checkout", async () => {
  localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null }));
  const file = (path: string): AssetExplorerNode => ({ kind: "file", path, name: path, depth: 1 });
  const folder = (path: string, children: AssetExplorerNode[]): AssetExplorerNode => ({
    kind: "folder", path, name: path, children, isRoot: path === ".", depth: 0, loaded: true, loading: false,
    hasMore: false, nextOffset: 2, totalCount: 2, hasChildFolders: true, hasChildFoldersKnown: true, branchProbeLoading: false,
  });
  const tree = ref([folder(".", [folder("Notes", [file("Notes/draft.md")]), file("keep.md")])]);
  mocks.asset.mockReturnValue({ explorerTree: tree, isPathExpanded: () => true, togglePath: vi.fn(), loadMoreFolder: vi.fn(),
    applyExplorerFileChange: vi.fn(), error: ref("") });
  mocks.order.mockReturnValue({ order: ref({ revision: 0, placements: [] }), move: vi.fn() });
  let state!: WorkspaceFileTreeState;
  const renders = ref(0);
  app = createApp({ setup: () => () => {
    void renders.value;
    return h(WorkspaceFileTreeSource, { workingDir: "F:/Game", workspaceRef: { checkoutId: "a" },
      onChange: (value: WorkspaceFileTreeState) => { state = value; renders.value++; } });
  } });
  app.mount(document.createElement("div")); await flush();
  expect(renders.value).toBeLessThan(4);
  expect(state.entries.map(entry => entry.key)).toEqual(["Notes", "Notes/draft.md", "keep.md"]);
  const visibility = useWorkspaceFileVisibility();
  visibility.setHidden("a", "Notes", true); await flush();
  expect(state.entries.map(entry => entry.key)).toEqual(["keep.md"]);
  expect((await state.siblings(".")).map(entry => entry.key)).toEqual(["keep.md"]);
  visibility.setHidden("a", "Notes", false); await flush();
  expect(state.entries.map(entry => entry.key)).toEqual(["Notes", "Notes/draft.md", "keep.md"]);
  visibility.setHidden("a", "Notes/draft.md", true);
  const event = { projectId: "p", root: "F:/Game", path: "F:/Game/Notes", newPath: "F:/Game/Renamed", workspaceRef: { checkoutId: "other" } };
  for (const listener of mocks.actions) listener(event);
  expect(visibility.paths("a")).toEqual(["Notes/draft.md"]);
  for (const listener of mocks.actions) listener({ ...event, workspaceRef: { checkoutId: "a" } });
  expect(visibility.paths("a")).toEqual(["Renamed/draft.md"]);
  app.unmount(); app = undefined;
  expect(mocks.actions.size).toBe(0);
});
