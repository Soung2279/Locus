// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceArchivedFiles from "../components/explorer/WorkspaceArchivedFiles.vue";
import { useWorkspaceFileVisibility } from "../composables/useWorkspaceFileVisibility";
import type { DirEntriesPage, WorkspaceEntryStat } from "../services/project";

const mocks = vi.hoisted(() => ({ stat: vi.fn(), list: vi.fn(), changes: new Set<(event: any) => void>() }));
vi.mock("../services/project", () => ({ statWorkspaceEntries: mocks.stat, listDirEntriesPage: mocks.list }));
vi.mock("../services/workspaceExplorer", () => ({
  subscribeWorkspaceFileChanges: vi.fn(async (listener: (event: any) => void) => {
    mocks.changes.add(listener); return () => { mocks.changes.delete(listener); };
  }),
  subscribeExplorerFileActions: vi.fn(async () => () => {}),
}));
let app: App | undefined;
const visibility = useWorkspaceFileVisibility();
async function flush() { for (let i = 0; i < 12; i++) await nextTick(); }
function page(paths: string[], hasMore = false, offset = paths.length): DirEntriesPage {
  return { entries: paths.map(path => ({ relPath: path, name: path.split("/").pop()!, isDir: false })),
    hasMore, nextOffset: offset, totalCount: offset + Number(hasMore) };
}
async function mount() {
  const host = document.createElement("div"); document.body.appendChild(host);
  const open = vi.fn(), context = vi.fn(), error = vi.fn();
  const props = reactive({ workingDir: "F:/Game", workspaceRef: { checkoutId: "a", expectedGeneration: 1 },
    onOpenFile: open, onContextmenu: context, onError: error });
  app = createApp({ setup: () => () => h(WorkspaceArchivedFiles, props) }); app.mount(host); await flush();
  const rows = () => [...host.querySelectorAll<HTMLButtonElement>(".workspace-tree-row")];
  return { host, rows, props, open, context, error };
}
beforeEach(() => {
  localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null }));
  mocks.stat.mockReset().mockImplementation(async (paths: string[]) => paths.map(path => ({
    path, exists: true, entryKind: path.includes(".") ? "file" : "folder",
  })));
  mocks.list.mockReset().mockResolvedValue(page([]));
});
afterEach(() => { app?.unmount(); app = undefined; document.body.replaceChildren(); vi.useRealTimers(); });

describe("archived workspace files", () => {
  it("lists nested hidden paths without reading their visible ancestors and supports opening/context menus", async () => {
    visibility.setHidden("a", "Closed/Sub/note.md", true);
    visibility.setHidden("a", "Other/note.md", true);
    const { rows, open, context } = await mount();
    expect(rows().map(row => row.textContent?.trim())).toEqual(["Closed/Sub/note.md", "Other/note.md"]);
    expect(mocks.list).not.toHaveBeenCalled();
    rows()[0]!.click();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: "Closed/Sub/note.md", name: "note.md" }));
    rows()[1]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(context.mock.calls[0]?.[0].node.path).toBe("Other/note.md");
    visibility.setHidden("a", "Closed/Sub/note.md", false); await flush();
    expect(rows().map(row => row.textContent?.trim())).toEqual(["Other/note.md"]);
  });

  it("deduplicates nested hides, expands directories, and continues paginated children", async () => {
    visibility.setHidden("a", "Library", true);
    visibility.setHidden("a", "Library/first.md", true);
    mocks.list.mockResolvedValueOnce(page(["Library/first.md"], true, 200)).mockResolvedValueOnce(page(["Library/last.md"], false, 201));
    const { rows } = await mount();
    expect(rows()).toHaveLength(1);
    rows()[0]!.click(); await flush();
    expect(rows().map(row => row.textContent?.trim())).toEqual(["Library", "first.md", "last.md"]);
    expect(mocks.list.mock.calls[1]?.slice(0, 4)).toEqual(["Library", { checkoutId: "a", expectedGeneration: 1 }, 200, 200]);
    visibility.setHidden("a", "Library", false); await flush();
    expect(rows().map(row => row.textContent?.trim())).toEqual(["Library/first.md"]);
  });

  it("refreshes expanded directories on workspace changes and releases subscriptions", async () => {
    vi.useFakeTimers();
    visibility.setHidden("a", "Library", true);
    mocks.list.mockResolvedValueOnce(page(["Library/old.md"])).mockResolvedValueOnce(page(["Library/new.md"]));
    const { rows } = await mount(); rows()[0]!.click(); await flush();
    for (const listener of mocks.changes) listener({ checkoutId: "other" });
    await vi.advanceTimersByTimeAsync(160); expect(mocks.list).toHaveBeenCalledTimes(1);
    for (const listener of mocks.changes) listener({ checkoutId: "a" });
    await vi.advanceTimersByTimeAsync(160); await flush();
    expect(rows().map(row => row.textContent?.trim())).toEqual(["Library", "new.md"]);
    app!.unmount(); app = undefined; expect(mocks.changes.size).toBe(0);
  });

  it("discards late responses after switching checkout", async () => {
    visibility.setHidden("a", "old.md", true); visibility.setHidden("b", "new.md", true);
    let resolve!: (value: WorkspaceEntryStat[]) => void;
    mocks.stat.mockImplementationOnce(() => new Promise<WorkspaceEntryStat[]>(done => { resolve = done; }));
    const { rows, props } = await mount();
    props.workspaceRef = { checkoutId: "b", expectedGeneration: 2 }; await flush();
    expect(rows().map(row => row.textContent?.trim())).toEqual(["new.md"]);
    resolve([{ path: "old.md", exists: true, entryKind: "file" }]); await flush();
    expect(rows().map(row => row.textContent?.trim())).toEqual(["new.md"]);
  });

  it("skips deleted entries and shows read failures instead of a false empty state", async () => {
    visibility.setHidden("a", "gone.md", true);
    mocks.stat.mockResolvedValueOnce([{ path: "gone.md", exists: false, entryKind: "missing" }]);
    const { rows, host } = await mount(); expect(rows()).toHaveLength(0);
    mocks.stat.mockRejectedValueOnce(new Error("cannot read archive"));
    visibility.setHidden("a", "next.md", true); await flush();
    expect(host.textContent).toContain("cannot read archive");
  });
});
