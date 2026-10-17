// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import AssetView from "../components/AssetView.vue";
import KnowledgeExplorer from "../components/knowledge/KnowledgeExplorer.vue";
import KnowledgeSearchBar from "../components/knowledge/KnowledgeSearchBar.vue";
import { createDefaultShortcutSettings, useKeyboardShortcuts } from "../composables/useKeyboardShortcuts";
import { useGlobalSearchShortcut } from "../composables/useSearchScope";
import { t } from "../i18n";
import type { KnowledgeDocumentSummary } from "../types";

const mocks = vi.hoisted(() => ({ searchFiles: vi.fn(), selectDirectory: vi.fn() }));
vi.mock("../stores/ui", () => ({ useUiStore: () => ({ pendingAssetOpen: null }) }));
vi.mock("../stores/workspaceContext", () => ({ useWorkspaceContextStore: () => ({ checkoutsById: {} }) }));
vi.mock("../components/explorer/ExplorerResourceActions.vue", () => ({ default: { render: () => null } }));
vi.mock("../composables/useAssetState", async () => {
  const { ref } = await import("vue");
  return { useAssetState: () => {
    const searchQuery = ref("");
    const searchResults = ref<Array<{ path: string; name: string; root: string; kind: string; isDirectory: boolean }>>([]);
    return {
      error: ref(""), searching: ref(false), searchQuery, searchResults,
      searchTruncated: ref(false), searchHasFallback: ref(false),
      explorerTree: ref([{ kind: "folder", name: "Library", path: "Library", depth: 0,
        children: [], loaded: false, loading: false, hasMore: false,
      }]),
      isPathExpanded: () => false, updateSearchScope: vi.fn(),
      selectFromSearchResult: mocks.selectDirectory,
      runFilenameSearch: (value: string) => {
        mocks.searchFiles(value);
        searchQuery.value = value;
        searchResults.value = value.trim() ? [
          { path: "Library/Hidden.cs", name: "Hidden.cs", root: "workspace", kind: "cs", isDirectory: false },
          { path: "Library/Nested", name: "Nested", root: "workspace", kind: "folder", isDirectory: true },
        ] : [];
      },
    };
  } };
});

const documentSummary: KnowledgeDocumentSummary = {
  id: "doc", type: "memory", path: "notes.md", title: "Notes", injectMode: "excerpt",
  effectiveInjectMode: "excerpt", readOnly: false, aiMaintained: false, effectiveAiMaintained: false, modifiedAt: 1,
};
let app: App | undefined;
async function settle() { await nextTick(); await nextTick(); await nextTick(); }
function point(target: Element) { target.dispatchEvent(new Event("pointerdown", { bubbles: true })); }
function key(target: EventTarget, key = "f", modifiers: KeyboardEventInit = { ctrlKey: true }) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  target.dispatchEvent(event);
  return event;
}
async function type(field: HTMLInputElement, value: string) {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

function fixture() {
  const globalSearch = vi.fn();
  const openFile = vi.fn();
  const knowledgeQuery = ref("");
  const active = ref(true);
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp(defineComponent({ setup() {
    const knowledgeScope = ref<HTMLElement | null>(null);
    useGlobalSearchShortcut(window, { open: globalSearch, enabled: () => true });
    return () => h("div", [
      h("aside", { "data-search-boundary": "", id: "knowledge" }, [
        h("button", { id: "knowledge-header" }, "Knowledge"),
        h("section", { ref: knowledgeScope, tabindex: -1 }, [
          h(KnowledgeSearchBar, { scope: knowledgeScope.value, active: active.value, query: knowledgeQuery.value, searching: false,
            "onUpdate:query": (value: string) => { knowledgeQuery.value = value; }, onClear: () => { knowledgeQuery.value = ""; } }),
          h(KnowledgeExplorer, {
            tree: [{ kind: "document", type: "memory", path: "memory/notes.md", name: "notes.md", depth: 0, document: documentSummary }],
            activeType: "memory", rootDirectoryConfigs: { design: {}, plan: {}, memory: {}, skill: {}, reference: {} },
            externalDirectorySources: {}, folderStats: {}, selectedPath: null, isPathExpanded: () => false,
            rootContentsLoaded: () => true, hasMoreRootDocuments: () => false, rootDocumentsLoading: () => false,
            hasMoreFolderDocuments: () => false, folderDocumentsLoaded: () => true, folderDocumentsLoading: () => false,
            loading: false, searchQuery: knowledgeQuery.value, searchResults: [], searching: false,
          }),
        ]),
      ]),
      h("aside", { "data-search-boundary": "", id: "files" }, [
        h("button", { id: "files-header" }, "Files"),
        h(AssetView, { workingDir: "F:/Game", listOnly: true, active: active.value, onOpenFile: openFile }),
      ]),
      h("input", { id: "editor-input" }),
    ]);
  } }));
  app.use(createPinia());
  app.mount(host);
  return { host, globalSearch, openFile, knowledgeQuery, active };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(useKeyboardShortcuts().state, createDefaultShortcutSettings("default"));
});
afterEach(() => {
  app?.unmount(); app = undefined;
  document.body.replaceChildren();
  Object.assign(useKeyboardShortcuts().state, createDefaultShortcutSettings("default"));
});

describe("knowledge and Files sidebar search", () => {
  it("occupies no space initially and opens the clicked pane from its header or nested tree", async () => {
    const f = fixture(); await settle();
    expect(f.host.querySelector("[role=search]")).toBeNull();
    const editor = f.host.querySelector<HTMLInputElement>("#editor-input")!;
    editor.focus();
    point(f.host.querySelector("#knowledge .workspace-tree-row")!);
    expect(key(editor).defaultPrevented).toBe(true); await settle();
    const knowledgeField = f.host.querySelector<HTMLInputElement>("#knowledge .explorer-search-input")!;
    expect(document.activeElement).toBe(knowledgeField);
    expect(knowledgeField.placeholder).toBe(t("knowledge.search.globalPlaceholder"));
    expect(f.host.querySelector(".floating-find-bar")).toBeNull();
    await type(knowledgeField, "notes");
    key(knowledgeField); await settle();
    expect(knowledgeField.selectionStart).toBe(0);
    expect(knowledgeField.selectionEnd).toBe(5);

    point(f.host.querySelector("#files-header")!);
    key(window); await settle();
    const filesField = f.host.querySelector<HTMLInputElement>("#files .explorer-search-input")!;
    expect(document.activeElement).toBe(filesField);
    expect(filesField.placeholder).toBe(t("asset.search.placeholder"));
    expect(f.globalSearch).not.toHaveBeenCalled();
    key(filesField, "F", { ctrlKey: true, shiftKey: true });
    expect(f.globalSearch).toHaveBeenCalledOnce();
    key(knowledgeField, "Escape", {}); await settle();
    expect(f.knowledgeQuery.value).toBe("");
    expect(f.host.querySelector("#knowledge [role=search]")).toBeNull();
  });

  it("searches files outside collapsed folders, opens results, and restores the tree on Escape", async () => {
    const f = fixture(); await settle();
    const treeRow = f.host.querySelector<HTMLButtonElement>("#files .workspace-tree-row")!;
    treeRow.focus(); point(treeRow); key(treeRow); await settle();
    const field = f.host.querySelector<HTMLInputElement>("#files .explorer-search-input")!;
    await type(field, "hidden");
    expect(mocks.searchFiles).toHaveBeenLastCalledWith("hidden");
    expect(f.host.querySelector("#files .workspace-tree")).toBeNull();
    f.host.querySelector<HTMLButtonElement>("#files .asr-row")!.click();
    expect(f.openFile).toHaveBeenCalledWith({ path: "Library/Hidden.cs", name: "Hidden.cs" });
    key(field, "Escape", {}); await settle();
    expect(mocks.searchFiles).toHaveBeenLastCalledWith("");
    expect(f.host.querySelector("#files [role=search]")).toBeNull();
    expect(f.host.querySelector("#files .workspace-tree-row")?.textContent).toContain("Library");
    expect(document.activeElement).toBe(f.host.querySelector("#files .ax-secondary-tree"));
  });

  it("defers Chinese composition, ignores composing Escape, and lets the close button reclaim space", async () => {
    const f = fixture(); await settle();
    point(f.host.querySelector("#knowledge-header")!); key(window); await settle();
    const field = f.host.querySelector<HTMLInputElement>("#knowledge .explorer-search-input")!;
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await type(field, "记");
    expect(f.knowledgeQuery.value).toBe("");
    expect(key(field, "Escape", { isComposing: true }).defaultPrevented).toBe(false);
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); await settle();
    expect(f.knowledgeQuery.value).toBe("记");
    f.host.querySelector<HTMLButtonElement>("#knowledge .explorer-search-close")!.click(); await settle();
    expect(f.knowledgeQuery.value).toBe("");
    expect(f.host.querySelector("#knowledge [role=search]")).toBeNull();
  });

  it("uses the current shortcut setting and skips inactive sidebars", async () => {
    const f = fixture(); await settle();
    useKeyboardShortcuts().state.findInContext = { ctrl: true, alt: false, meta: false, shift: false, key: "h" };
    point(f.host.querySelector("#files .workspace-tree-row")!);
    expect(key(window).defaultPrevented).toBe(false);
    key(window, "h"); await settle();
    expect(f.host.querySelector("#files .explorer-search-shortcut")?.textContent).toBe("Ctrl+H");
    f.active.value = false; await settle();
    point(f.host.querySelector("#knowledge-header")!); key(window, "h"); await settle();
    expect(f.host.querySelector("#knowledge [role=search]")).toBeNull();
    expect(f.globalSearch).toHaveBeenCalledOnce();
  });
});
