// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provideInternalDragController, useInternalDragController, type InternalDragController } from "../composables/useInternalDrag";
import { useWorkspaceFileDrop } from "../composables/useWorkspaceFileDrop";
import { assetWorkspaceReferenceDragData } from "../components/asset/assetWorkspaceDrag";
import { workbenchReferenceInternalDragSource } from "../components/workbench/workbenchReferenceDrag";
import AssetView from "../components/AssetView.vue";

vi.mock("../stores/ui", () => ({ useUiStore: () => ({ pendingAssetOpen: null }) }));
vi.mock("../stores/workspaceContext", () => ({ useWorkspaceContextStore: () => ({ checkoutsById: { workspace: { projectId: "p" } } }) }));
vi.mock("../components/explorer/ExplorerResourceActions.vue", () => ({ default: { render: () => null } }));
vi.mock("../composables/useAssetState", async () => {
  const { ref } = await import("vue");
  const folder = (name: string, path: string, children: unknown[], isRoot = false) => ({ kind: "folder", name, path, children,
    depth: isRoot ? 0 : 1, isRoot, loaded: true, loading: false, hasMore: false, hasChildFoldersKnown: true, hasChildFolders: false });
  return { useAssetState: () => ({
    error: ref(""), explorerTree: ref([folder("Game", ".", [
      { kind: "file", name: "a.txt", path: "Source/a.txt", depth: 1 }, folder("Target", "Target", []),
    ], true)]), isPathExpanded: () => false, updateSearchScope: vi.fn(),
    searchQuery: ref(""), searching: ref(false),
  }) };
});

const mocks = vi.hoisted(() => ({ move: vi.fn(), notice: vi.fn() }));
vi.mock("../services/workspaceExplorer", () => ({ moveWorkspaceFile: mocks.move }));
vi.mock("../stores/notification", () => ({ useNotificationStore: () => ({ addNotice: mocks.notice }) }));
const workspaceRef = { checkoutId: "workspace", expectedGeneration: 2, expectedMaterializationEpoch: 0 };
const source = assetWorkspaceReferenceDragData({ projectId: "p", workspaceRef, workspaceRoot: "F:/Game" }, {
  kind: "file", name: "a.txt", path: "Source/a.txt", depth: 1,
})!;
let app: App | undefined;
let controller: InternalDragController | undefined;
afterEach(() => { app?.unmount(); controller?.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.clearAllMocks(); });

function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
  return event as PointerEvent;
}

function mountLists() {
  const List = defineComponent({ props: { name: { type: String, required: true } }, setup(props) {
    const root = ref<HTMLElement | null>(null);
    const drag = useInternalDragController();
    useWorkspaceFileDrop({ root: () => root.value, resolve: hit => {
      const element = hit.closest<HTMLElement>("[data-folder]");
      return element ? { root: "F:/Game", projectId: "p", workspaceRef, directory: element.dataset.folder!, element } : null;
    } });
    return () => h("div", { ref: root, "data-list": props.name }, [
      h("button", { "data-source": props.name, onPointerdown: (event: PointerEvent) => drag.start(event, workbenchReferenceInternalDragSource(source, event.currentTarget as HTMLElement)) }, "a.txt"),
      h("div", { "data-folder": props.name }, "Target"),
    ]);
  } });
  const Parent = defineComponent({ setup() { controller = provideInternalDragController(); return () => [h(List, { name: "Primary" }), h(List, { name: "Secondary" })]; } });
  const host = document.createElement("div"); document.body.appendChild(host); app = createApp(Parent); app.mount(host);
  return host;
}

describe("file drop targets shared by worktree and Files lists", () => {
  it("accepts drops in a standalone Files sidebar when active and projectId are omitted", async () => {
    mocks.move.mockResolvedValue({});
    const Parent = defineComponent({ setup() {
      controller = provideInternalDragController();
      return () => h(AssetView, { workingDir: "F:/Game", workspaceRef, listOnly: true });
    } });
    const host = document.createElement("div"); document.body.appendChild(host); app = createApp(Parent); app.mount(host);
    const target = host.querySelector<HTMLElement>('[data-file-drop-directory="Target"]')!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    host.querySelector('[data-tree-key="Source/a.txt"] button')!.dispatchEvent(pointer("pointerdown", 15, 15));
    document.dispatchEvent(pointer("pointermove", 100, 100));
    expect(target.classList.contains("is-workspace-file-drop-target")).toBe(true);
    document.dispatchEvent(pointer("pointerup", 100, 100));
    await nextTick(); await nextTick();
    expect(mocks.move).toHaveBeenCalledExactlyOnceWith(workspaceRef, "Source/a.txt", "Target");
  });
  it.each(["Primary", "Secondary"])("commits a filesystem move when dropping onto %s", async (name) => {
    mocks.move.mockResolvedValue({});
    const host = mountLists();
    const target = host.querySelector<HTMLElement>(`[data-folder="${name}"]`)!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    host.querySelector('[data-source="Primary"]')!.dispatchEvent(pointer("pointerdown", 15, 15));
    document.dispatchEvent(pointer("pointermove", 100, 100));
    expect(target.classList.contains("is-workspace-file-drop-target")).toBe(true);
    document.dispatchEvent(pointer("pointerup", 100, 100));
    await nextTick(); await nextTick();
    expect(mocks.move).toHaveBeenCalledExactlyOnceWith(workspaceRef, "Source/a.txt", name);
    expect(target.classList.contains("is-workspace-file-drop-target")).toBe(false);
  });
  it("clears feedback without a move when Escape cancels the gesture", async () => {
    const host = mountLists(); const target = host.querySelector<HTMLElement>('[data-folder="Secondary"]')!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    host.querySelector('[data-source="Primary"]')!.dispatchEvent(pointer("pointerdown", 15, 15));
    document.dispatchEvent(pointer("pointermove", 100, 100));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(mocks.move).not.toHaveBeenCalled();
    expect(target.classList.contains("is-workspace-file-drop-target")).toBe(false);
  });
  it("reports a rejected filesystem move and releases the drag", async () => {
    mocks.move.mockRejectedValueOnce(new Error("Target already exists"));
    const host = mountLists(); const target = host.querySelector<HTMLElement>('[data-folder="Secondary"]')!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    host.querySelector('[data-source="Primary"]')!.dispatchEvent(pointer("pointerdown", 15, 15));
    document.dispatchEvent(pointer("pointermove", 100, 100));
    document.dispatchEvent(pointer("pointerup", 100, 100));
    await nextTick(); await nextTick();
    expect(mocks.notice).toHaveBeenCalledWith("error", "Target already exists");
    expect(controller?.phase.value).toBe("idle");
  });
});
