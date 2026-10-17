// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { useAssetState } from "../composables/useAssetState";
import type { ExplorerFileActionEvent } from "../services/workspaceExplorer";

const mocks = vi.hoisted(() => ({ files: new Set(["Source/a.txt"]), actions: new Set<(event: ExplorerFileActionEvent) => void>() }));
vi.mock("../services/project", () => ({
  listDirEntriesPage: vi.fn(async (path: string, _scope: unknown, offset: number, limit: number) => {
    const entries = path === "." ? ["Source", "Target"].map(name => ({ name, relPath: name, isDir: true }))
      : [...mocks.files].filter(file => file.startsWith(path + "/")).map(file => ({ name: file.split("/").pop()!, relPath: file, isDir: false }));
    return { entries: entries.slice(offset, offset + limit), nextOffset: Math.min(entries.length, offset + limit), totalCount: entries.length, hasMore: offset + limit < entries.length };
  }),
  statWorkspaceEntries: vi.fn(async (paths: string[]) => paths.map(path => ({ path, exists: mocks.files.has(path), entryKind: "file" }))),
  searchWorkspaceEntries: vi.fn(async () => []),
}));
vi.mock("../services/workspaceExplorer", () => ({
  subscribeWorkspaceFileChanges: vi.fn(async () => () => {}),
  subscribeExplorerFileActions: vi.fn(async (listener: (event: ExplorerFileActionEvent) => void) => {
    mocks.actions.add(listener); return () => { mocks.actions.delete(listener); };
  }),
}));
vi.mock("../services/workspaceEventHub", () => ({ listenWorkspaceEvent: vi.fn(async () => () => {}) }));
vi.mock("../services/asset", () => ({ assetDbOverview: vi.fn(), assetDbScanStart: vi.fn(), previewWorkspaceAsset: vi.fn(),
  previewWorkspaceAssetTarget: vi.fn(), getWatcherTuning: vi.fn(), setWatcherTuning: vi.fn() }));
const apps: App[] = [];
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); document.body.replaceChildren(); });
async function flush() { for (let i = 0; i < 16; i++) await nextTick(); }

it("refreshes every mounted file list after a move without relying on Unity's watcher", async () => {
  const reference = { checkoutId: "a", expectedGeneration: 1, expectedMaterializationEpoch: 0 };
  const props = reactive({ workingDir: "F:/Game", workspaceRef: { ...reference }, includeFilesInTree: true });
  const states: ReturnType<typeof useAssetState>[] = [];
  for (let i = 0; i < 2; i++) {
    const host = document.createElement("div"); document.body.appendChild(host);
    const app = createApp(defineComponent({ setup() { states.push(useAssetState(props)); return () => h("div"); } }));
    apps.push(app); app.mount(host);
  }
  await flush();
  expect(mocks.actions.size).toBe(2);
  for (const state of states) { await state.togglePath("Source"); await state.togglePath("Target"); }
  const event = { projectId: "p", root: "F:/Game", path: "F:/Game/Source/a.txt", newPath: "F:/Game/Target/a.txt", workspaceRef: reference };
  mocks.files.delete("Source/a.txt"); mocks.files.add("Target/a.txt");
  for (const listener of mocks.actions) listener(event);
  props.workspaceRef = { ...reference };
  await flush();
  for (const state of states) {
    const root = state.explorerTree.value[0]!;
    if (root.kind !== "folder") throw Error("Expected root");
    const source = root.children.find(node => node.path === "Source")!;
    const target = root.children.find(node => node.path === "Target")!;
    expect(source.kind === "folder" && source.children.length).toBe(0);
    expect(target.kind === "folder" && target.children.map(node => node.path)).toEqual(["Target/a.txt"]);
  }
  for (const listener of mocks.actions) listener({ ...event, path: event.newPath, newPath: "F:/Game/Source/a.txt", workspaceRef: { ...reference, checkoutId: "other" } });
  await flush();
  expect(states[0]!.error.value).toBe("");
  apps.splice(0).forEach(app => app.unmount());
  expect(mocks.actions.size).toBe(0);
});
