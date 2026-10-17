// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { createPinia, setActivePinia } from "pinia";
import { createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkbenchEditorStack from "../components/workbench/WorkbenchEditorStack.vue";
import WorkbenchEditorTabs from "../components/workbench/WorkbenchEditorTabs.vue";
import WorkspaceFilePreview from "../components/workbench/WorkspaceFilePreview.vue";
import { provideInternalDragController } from "../composables/useInternalDrag";
import { createWorkbenchEditorInput, useWorkbenchStore } from "../stores/workbench";
import type { ProjectExplorerFilePreview, WorkbenchEditorInput, WorkbenchResourceRef } from "../types/workbench";

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
vi.mock("../stores/chat", () => ({
  useChatStore: () => ({ streamingSessionIds: new Set(), sessions: [] }),
}));

const cleanups: Array<() => void> = [];
const original = "# Notes\n\nSelect or edit this paragraph.\n";
function preview(text = original, hash = "v1"): ProjectExplorerFilePreview {
  return {
    path: "notes.md", name: "notes.md", extension: "md", kind: "text",
    mimeType: "text/markdown", text, size: text.length, contentHash: hash,
    totalLines: text.split("\n").length, truncated: false, editable: true,
    revision: { exists: true, size: text.length, modifiedAtNanos: hash, key: hash },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

beforeEach(() => {
  localStorage.clear();
  files.read.mockReset().mockResolvedValue(preview());
  files.write.mockReset();
  files.revision.mockReset().mockResolvedValue(preview().revision);
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true, value: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
  });
});

afterEach(() => {
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
  document.body.replaceChildren();
});

async function mountDocument(resource: WorkbenchResourceRef = {
  kind: "workspaceFile", projectId: "project", path: "notes.md",
}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useWorkbenchStore();
  store.ensureWindow("main");
  const group = store.windows.main!.groups.main!;
  const opened = store.openEditor("main", createWorkbenchEditorInput(resource, "notes.md", {
    sourcePath: "F:/Game/notes.md",
  }));
  const current = () => group.tabs.find((editor) => editor.editorId === opened.editorId)!;
  const pin = (editorId: string) => { store.pinEditor("main", "main", editorId); };
  const ready = new Map<string, () => void>();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup() {
    const controller = provideInternalDragController();
    cleanups.push(() => controller.dispose());
    return () => h("div", [
      h(WorkbenchEditorTabs, {
        windowId: "main", group, showSingleTab: true, onPin: pin,
        onActivate: (id: string) => { group.activeEditorId = id; },
      }),
      h(WorkbenchEditorStack, { group, onPin: pin }, {
        default: (slot: { editor: WorkbenchEditorInput; ready: () => void }) => {
          ready.set(slot.editor.editorId, slot.ready);
          const file = slot.editor.resource;
          return file.kind === "workspaceFile" || file.kind === "localFile"
            ? h(WorkspaceFilePreview, {
              projectId: "project", path: file.kind === "workspaceFile" ? file.path : slot.editor.sourcePath!,
              active: group.activeEditorId === slot.editor.editorId,
              onDirtyChange: (dirty: boolean) => {
                store.updateEditor("main", "main", slot.editor.editorId, { dirty });
              },
            })
            : h("textarea", { value: original });
        },
      }),
    ]);
  } });
  app.use(pinia);
  app.mount(host);
  cleanups.push(() => app.unmount());
  await flush();
  ready.get(opened.editorId)!();
  await flush();
  const surface = host.querySelector<HTMLElement>(`[data-editor-id="${opened.editorId}"]`)!;
  const body = surface.querySelector<HTMLElement>(".cm-content, textarea")!;
  const view = () => EditorView.findFromDOM(surface.querySelector<HTMLElement>(".cm-editor")!)!;
  const tab = () => host.querySelector<HTMLElement>(`[data-workbench-tab-id="${opened.editorId}"]`)!;
  const openNext = () => store.openEditor("main", createWorkbenchEditorInput({
    kind: "workspaceFile", projectId: "project", path: "next.md",
  }, "next.md"));
  const expectRetained = async () => {
    await flush();
    expect(current()).toMatchObject({ preview: false, pinned: true });
    expect(tab().closest(".base-tab-shell")?.classList.contains("preview")).toBe(false);
    openNext();
    expect(group.tabs.map((editor) => editor.title)).toEqual(["notes.md", "next.md"]);
  };
  return { store, group, current, surface, body, view, tab, openNext, expectRetained };
}

describe("document preview retention", () => {
  it("keeps automatic load and focus temporary so browsing another document still replaces it", async () => {
    const doc = await mountDocument();
    doc.view().focus();
    await flush();
    expect(doc.current()).toMatchObject({ preview: true, pinned: false });
    doc.openNext();
    expect(doc.group.tabs.map((editor) => editor.title)).toEqual(["next.md"]);
  });

  it.each<WorkbenchResourceRef>([
    { kind: "workspaceFile", projectId: "project", path: "notes.md" },
    { kind: "localFile", projectId: "project", nodeId: "mount" },
    { kind: "knowledge", projectId: "project", documentId: "notes" },
  ])("retains $kind on the first content click even when the child stops propagation", async (resource) => {
    const doc = await mountDocument(resource);
    doc.body.addEventListener("pointerdown", (event) => event.stopPropagation(), { once: true });
    const event = new MouseEvent("pointerdown", { button: 0, bubbles: true, cancelable: true });
    doc.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(doc.current().dirty).toBe(false);
    await doc.expectRetained();
  });

  it.each([
    { key: "ArrowRight", shiftKey: true },
    { key: "a", ctrlKey: true },
    { key: "a", metaKey: true },
  ])("retains a document on keyboard selection: %j", async (keys) => {
    const doc = await mountDocument({ kind: "knowledge", projectId: "project", documentId: "notes" });
    doc.body.dispatchEvent(new KeyboardEvent("keydown", { ...keys, bubbles: true }));
    await doc.expectRetained();
  });

  it("retains a document when its existing tab is clicked", async () => {
    const doc = await mountDocument();
    doc.tab().click();
    await doc.expectRetained();
  });

  it("retains the first edit through autosave and the next file open without requiring a click", async () => {
    const doc = await mountDocument();
    const view = doc.view();
    view.dispatch({ changes: { from: view.state.doc.length, insert: "Edited" }, userEvent: "input.type" });
    await flush();
    expect(doc.current()).toMatchObject({ preview: false, pinned: true, dirty: true });
    const selection = view.state.selection;
    files.write.mockResolvedValue(preview(view.state.doc.toString(), "v2"));
    await vi.waitFor(() => expect(files.write).toHaveBeenCalledOnce(), { timeout: 2000 });
    await flush();
    expect(doc.current().dirty).toBe(false);
    expect(doc.view()).toBe(view);
    expect(view.state.selection.eq(selection)).toBe(true);
    const saved = JSON.parse(localStorage.getItem("locus:workbench-window:main")!);
    expect(saved.groups.main.tabs[0]).toMatchObject({ preview: false, pinned: true });
    await doc.expectRetained();
  });

  it("does not retain on scrolling, right click, or focus navigation", async () => {
    const doc = await mountDocument();
    doc.body.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 40 }));
    doc.body.dispatchEvent(new MouseEvent("pointerdown", { button: 2, bubbles: true }));
    doc.surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    await flush();
    expect(doc.current()).toMatchObject({ preview: true, pinned: false });
  });

  it("preserves conversation preview behavior", async () => {
    const doc = await mountDocument({ kind: "newSession", projectId: "project" });
    doc.body.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
    doc.tab().click();
    await flush();
    expect(doc.current()).toMatchObject({ preview: true, pinned: false });
  });
});
