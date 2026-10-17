// @vitest-environment jsdom
import { redo, undo, undoDepth } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createApp, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceFilePreview from "../components/workbench/WorkspaceFilePreview.vue";
import type { ProjectExplorerFilePreview, WorkbenchEditorTransferSnapshot } from "../types/workbench";

const files = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), revision: vi.fn() }));
vi.mock("../services/workspaceExplorer", () => ({
  projectExplorerPreviewFile: files.read,
  workspaceFilePreview: files.read,
  projectExplorerWriteFile: files.write,
  workspaceFileWrite: files.write,
  projectExplorerFileRevision: files.revision,
  workspaceFileRevision: files.revision,
  subscribeWorkspaceFileChanges: vi.fn(async () => () => {}),
}));

const original = "# Notes\n\nFirst paragraph\n\nLast paragraph\n";
let app: App<Element> | null = null;

function preview(text: string, hash: string, extension = "md"): ProjectExplorerFilePreview {
  return {
    path: `F:/Game/notes.${extension}`, name: `notes.${extension}`, extension,
    kind: "text", mimeType: "text/plain", text, size: text.length,
    contentHash: hash, totalLines: text.split("\n").length, truncated: false, editable: true,
    revision: { exists: true, size: text.length, modifiedAtNanos: hash, key: hash },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountEditor(extension = "md", workspace = false) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const active = ref(true);
  const editor = ref<{
    saveFile(): Promise<boolean>;
    refreshIfChanged(): Promise<void>;
    restoreWorkState(snapshot: WorkbenchEditorTransferSnapshot): Promise<boolean>;
    exportTransferSnapshot(): WorkbenchEditorTransferSnapshot;
  } | null>(null);
  const dirty = ref(false);
  files.read.mockResolvedValue(preview(original, "v1", extension));
  files.revision.mockResolvedValue(preview(original, "v1", extension).revision);
  app = createApp({
    setup: () => () => h(WorkspaceFilePreview, {
      ref: editor,
      projectId: workspace ? undefined : "project-a",
      path: workspace ? `notes.${extension}` : `F:/Game/notes.${extension}`,
      workspaceRef: workspace ? { checkoutId: "checkout-a", expectedGeneration: 7 } : null,
      active: active.value,
      onDirtyChange: (value: boolean) => { dirty.value = value; },
    }),
  });
  app.mount(host);
  await flush();
  const getView = () => EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
  const view = getView();
  // jsdom does not load SFC CSS; give auto-grow the same scroll ancestor as WebView2.
  const scroller = host.querySelector<HTMLElement>(".document-scroller");
  if (scroller) scroller.style.overflowY = "auto";
  return { host, active, editor, dirty, view, getView, scroller: scroller ?? view.scrollDOM };
}

function insert(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: view.state.doc.length, insert: text },
    selection: { anchor: view.state.doc.length + text.length },
    userEvent: "input.type",
  });
}

function pressSave(view: EditorView): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  files.read.mockReset();
  files.write.mockReset();
  files.revision.mockReset();
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true, value: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
  });
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.replaceChildren();
});

describe("workspace file editor continuity", () => {
  it("recovers an unsaved buffer, cursor and scroll after a fresh editor mount", async () => {
    const { editor, view, scroller, dirty } = await mountEditor("txt");
    expect(await editor.value!.restoreWorkState({ kind: "workspaceFile", text: "Recovered draft", contentHash: "v1",
      originalLineEnding: "\n", dirty: true, selection: { anchor: 2, head: 8 }, scrollTop: 120 })).toBe(true);
    await flush();
    expect(view.state.doc.toString()).toBe("Recovered draft");
    expect(view.state.selection.main.anchor).toBe(2);
    expect(view.state.selection.main.head).toBe(8);
    expect(scroller.scrollTop).toBe(120);
    expect(dirty.value).toBe(true);
    expect(files.write).not.toHaveBeenCalled();
  });

  it("keeps an external disk change when the recovered editor had no unsaved edits", async () => {
    const { editor, view, dirty } = await mountEditor();
    await editor.value!.restoreWorkState({ kind: "workspaceFile", text: "outdated text", contentHash: "old-hash",
      originalLineEnding: "\n", dirty: false, selection: { anchor: 2, head: 2 } });
    await flush();
    expect(view.state.doc.toString()).toBe(original);
    expect(dirty.value).toBe(false);
    expect(files.write).not.toHaveBeenCalled();
  });

  it("recovers conflicting dirty input without autosaving over external edits, including another restart", async () => {
    const { editor, view, host } = await mountEditor();
    await editor.value!.restoreWorkState({ kind: "workspaceFile", text: "unsaved local input", contentHash: "old-hash",
      originalLineEnding: "\n", dirty: true });
    await flush();
    expect(view.state.doc.toString()).toBe("unsaved local input");
    expect(host.querySelector(".workspace-file-preview-conflict")).not.toBeNull();
    const saved = editor.value!.exportTransferSnapshot();
    expect(saved).toMatchObject({ dirty: true, conflicted: true, text: "unsaved local input" });
    app!.unmount(); app = null;
    const restarted = await mountEditor();
    await restarted.editor.value!.restoreWorkState(saved);
    await flush();
    expect(restarted.host.querySelector(".workspace-file-preview-conflict")).not.toBeNull();
    expect(restarted.view.state.doc.toString()).toBe("unsaved local input");
    expect(files.write).not.toHaveBeenCalled();
  });
  it("automatically saves Markdown while keeping the active editing state", async () => {
    const { view, dirty } = await mountEditor();
    insert(view, "automatic");
    const text = view.state.doc.toString();
    files.write.mockResolvedValue(preview(text, "auto-v2"));
    const selection = view.state.selection;
    await vi.waitFor(() => expect(files.write).toHaveBeenCalledOnce(), { timeout: 2000 });
    await flush();
    expect(dirty.value).toBe(false);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(original);
  });
  it.each([
    ["md", false], ["md", true], ["txt", false],
  ] as const)("preserves selection, scroll, focus and undo across Ctrl+S (%s, workspace=%s)", async (extension, workspace) => {
    const { view, getView, scroller, dirty } = await mountEditor(extension, workspace);
    insert(view, "local edit");
    const edited = view.state.doc.toString();
    files.write.mockResolvedValue(preview(edited, "v2", extension));
    view.dispatch({ selection: EditorSelection.create([
      EditorSelection.range(20, 12), EditorSelection.cursor(edited.length),
    ], 1) });
    view.focus();
    const state = view.state;
    scroller.scrollTop = 420;
    scroller.scrollLeft = 24;
    expect(pressSave(view).defaultPrevented).toBe(true);
    await flush();

    expect(files.write).toHaveBeenCalledOnce();
    expect(getView()).toBe(view);
    expect(view.state.selection.eq(state.selection)).toBe(true);
    expect(view.state).toBe(state);
    expect(view.hasFocus).toBe(true);
    expect(scroller.scrollTop).toBe(420);
    expect(scroller.scrollLeft).toBe(24);
    expect(dirty.value).toBe(false);
    pressSave(view);
    await flush();
    expect(files.write).toHaveBeenCalledOnce();
    expect(undo(view)).toBe(true);
    await flush();
    expect(view.state.doc.toString()).toBe(original);
    expect(dirty.value).toBe(true);
    expect(redo(view)).toBe(true);
    await flush();
    expect(view.state.doc.toString()).toBe(edited);
    expect(dirty.value).toBe(false);
  });

  it("retains input and cursor movement made while the save is in flight", async () => {
    const { view, dirty, editor } = await mountEditor();
    insert(view, "submitted");
    const submitted = view.state.doc.toString();
    let resolveSave!: (value: ProjectExplorerFilePreview) => void;
    files.write.mockReturnValueOnce(new Promise<ProjectExplorerFilePreview>((resolve) => { resolveSave = resolve; }));
    const saving = editor.value!.saveFile();
    insert(view, " and continued");
    view.dispatch({ selection: { anchor: 18 } });
    const state = view.state;
    resolveSave(preview(submitted, "v2"));
    await expect(saving).resolves.toBe(false);
    await flush();
    expect(view.state).toBe(state);
    expect(dirty.value).toBe(true);
    files.write.mockResolvedValueOnce(preview(state.doc.toString(), "v3"));
    await expect(editor.value!.saveFile()).resolves.toBe(true);
    await flush();
    expect(files.write.mock.lastCall?.[3]).toBe("v2");
    expect(view.state.selection.main.head).toBe(18);
  });

  it("keeps the draft and undo after a failed save, then preserves them on retry", async () => {
    const { view, editor, dirty } = await mountEditor();
    insert(view, "local edit");
    const state = view.state;
    files.write.mockRejectedValueOnce(new Error("write failed"));
    await expect(editor.value!.saveFile()).resolves.toBe(false);
    await flush();
    expect(dirty.value).toBe(true);
    expect(view.state).toBe(state);
    files.write.mockResolvedValueOnce(preview(state.doc.toString(), "v2"));
    await expect(editor.value!.saveFile()).resolves.toBe(true);
    await flush();
    expect(view.state).toBe(state);
  });

  it("maps the caret through an external update while retaining local undo", async () => {
    const { view, editor } = await mountEditor();
    insert(view, "local edit");
    const saved = view.state.doc.toString();
    files.write.mockResolvedValueOnce(preview(saved, "v2"));
    await editor.value!.saveFile();
    await flush();
    view.dispatch({ selection: { anchor: saved.length } });
    const external = preview(`remote\n${saved}`, "v3");
    files.revision.mockResolvedValueOnce(external.revision);
    files.read.mockResolvedValueOnce(external);
    await editor.value!.refreshIfChanged();
    await flush();
    expect(view.state.selection.main.head).toBe(saved.length + 7);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`remote\n${original}`);
  });

  it("accepts a new disk baseline without replacing the local draft or its undo history", async () => {
    const { host, view, editor, dirty } = await mountEditor();
    const from = original.indexOf("Last");
    view.dispatch({ changes: { from, to: from + 4, insert: "Local" }, selection: { anchor: from + 5 } });
    const state = view.state;
    const external = preview(original.replace("Last", "Remote"), "v2");
    files.revision.mockResolvedValueOnce(external.revision);
    files.read.mockResolvedValueOnce(external);
    await editor.value!.refreshIfChanged();
    await flush();
    const buttons = host.querySelectorAll<HTMLButtonElement>(".workspace-file-preview-conflict button");
    expect(buttons).toHaveLength(2);
    buttons[1]!.click();
    await flush();
    expect(host.querySelector(".workspace-file-preview-conflict")).toBeNull();
    expect(view.state).toBe(state);
    expect(dirty.value).toBe(true);
    expect(undoDepth(view.state)).toBe(1);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(original);
  });

  it("restores the saved document's caret and undo when returning to an inactive tab", async () => {
    const { view, active, getView, editor } = await mountEditor();
    insert(view, "local edit");
    const saved = view.state.doc.toString();
    const selection = view.state.selection;
    let resolveSave!: (value: ProjectExplorerFilePreview) => void;
    files.write.mockReturnValueOnce(new Promise<ProjectExplorerFilePreview>((resolve) => { resolveSave = resolve; }));
    const saving = editor.value!.saveFile();
    active.value = false;
    await flush();
    resolveSave(preview(saved, "v2"));
    await saving;
    await flush();
    active.value = true;
    await flush();
    const resumed = getView();
    expect(resumed.state.selection.eq(selection)).toBe(true);
    expect(resumed.state.doc.toString()).toBe(saved);
    expect(undo(resumed)).toBe(true);
    expect(resumed.state.doc.toString()).toBe(original);
  });
});
