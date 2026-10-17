// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import { createPinia } from "pinia";
import UnitySerializedPropertyTree from "../components/unity/UnitySerializedPropertyTree.vue";
import { provideWindowSurface } from "../composables/useWindowSurface";
import type { UnitySerializedPropertySnapshot } from "../components/unity/unitySerializedValue";

const apps: App[] = [];
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); document.body.innerHTML = ""; });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await nextTick(); };
function scalar(path: string, value = 1): UnitySerializedPropertySnapshot {
  return { propertyPath: path, displayName: "Power", valueType: "Integer", value, displayValue: String(value), editable: true };
}
function list(count = 12, complex = true): UnitySerializedPropertySnapshot {
  return { propertyPath: "rules", displayName: "Rules", valueType: "Generic", isArray: true, arraySize: count, value: null, editable: true,
    children: Array.from({ length: count }, (_, index) => complex ? {
      propertyPath: `rules.Array.data[${index}]`, displayName: `Element ${index}`, valueType: "Generic", value: null,
      attributes: [{ type: "Locus.ListElementLabel", value: `Rule ${index} → Action ${index}` }],
      children: [scalar(`rules.Array.data[${index}].power`), scalar(`rules.Array.data[${index}].weight`, 2)],
    } : scalar(`rules.Array.data[${index}]`, index)) };
}
function mount(snapshot = list(), options: Record<string, unknown> = {}, surface?: Window) {
  const data = ref(snapshot), commit = vi.fn();
  const doc = surface?.document ?? document;
  const root = doc.createElement("div"); doc.body.append(root);
  const app = createApp({ setup() { if (surface) provideWindowSurface(surface, "unity"); return () => h(UnitySerializedPropertyTree, { property: data.value, onCommit: commit, ...options }); } });
  app.use(createPinia()); app.mount(root); apps.push(app);
  return { root, data, commit, doc };
}
async function click(root: ParentNode, selector: string) { const button = root.querySelector<HTMLButtonElement>(selector)!; expect(button).not.toBeNull(); button.click(); await flush(); }

describe("default Unity list editing", () => {
  it("shows bounded summaries and mounts a complex editor only when its row is expanded", async () => {
    const { root } = mount();
    expect(root.querySelectorAll(".array-item")).toHaveLength(10);
    expect(root.textContent).toContain("Rule 0 → Action 0");
    expect(root.querySelectorAll(".property-leaf")).toHaveLength(0);
    await click(root, ".array-item-toggle");
    expect(root.querySelectorAll(".property-leaf")).toHaveLength(2);
    await click(root, ".array-item-toggle");
    expect(root.querySelectorAll(".property-leaf")).toHaveLength(0);
    await click(root, ".array-page-next");
    expect(root.querySelectorAll(".array-item")).toHaveLength(2);
    expect(root.textContent).toContain("Rule 11 → Action 11");
  });

  it("keeps simple values editable inline and emits their exact serialized path", async () => {
    const { root, commit } = mount(list(3, false));
    expect(root.querySelector(".array-item-toggle")).toBeNull();
    expect(root.querySelectorAll(".property-leaf")).toHaveLength(3);
    const input = root.querySelector<HTMLInputElement>(".property-leaf input")!;
    input.value = "8"; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); await flush();
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]![0]).toMatchObject({ propertyPath: "rules.Array.data[0]", value: 8 });
  });

  it("searches summaries and deletes the original index rather than the filtered position", async () => {
    const { root, commit } = mount();
    await click(root, ".array-menu-button"); await click(document, '[data-list-action="search"]');
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = "Action 11"; input.dispatchEvent(new Event("input", { bubbles: true })); await flush();
    expect(root.querySelectorAll(".array-item")).toHaveLength(1);
    expect(root.querySelector<HTMLButtonElement>(".array-index-handle")!.disabled).toBe(true);
    await click(root, ".array-remove-button");
    expect(commit.mock.calls[0]![0].value).toEqual({ action: "delete", index: 11 });
  });

  it("uses absolute indices for second-page keyboard moves and insertion menus", async () => {
    const { root, commit } = mount();
    await click(root, ".array-page-next");
    root.querySelector(".array-index-handle")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); await flush();
    expect(commit.mock.calls[0]![0].value).toEqual({ action: "move", index: 10, toIndex: 9 });
    await click(root, ".array-item-menu"); await click(document, '[data-list-action="insertAfter"]');
    expect(commit.mock.calls[1]![0].value).toEqual({ action: "insert", index: 11 });
  });

  it("copies on the backend without serializing a truncated element as the new value", async () => {
    const snapshot = list(1); snapshot.children![0]!.childrenTruncated = true;
    const { root, commit } = mount(snapshot);
    await click(root, ".array-item-menu"); await click(document, '[data-list-action="duplicate"]');
    expect(commit.mock.calls[0]![0].value).toEqual({ action: "duplicate", index: 0 });
  });

  it("does not offer graph duplication for managed reference elements", async () => {
    const snapshot = list(1); snapshot.children![0]!.isManagedReference = true;
    const { root } = mount(snapshot);
    await click(root, ".array-item-menu");
    expect(document.querySelector<HTMLButtonElement>('[data-list-action="duplicate"]')!.disabled).toBe(true);
  });

  it("separates structural read-only settings from element editing", async () => {
    const snapshot = list(2, false);
    snapshot.attributes = [{ type: "Sirenix.OdinInspector.ListDrawerSettingsAttribute", value: JSON.stringify({ IsReadOnly: true }) }];
    const { root, commit } = mount(snapshot);
    expect(root.querySelector<HTMLButtonElement>(".array-add-button")!.disabled).toBe(true);
    expect(root.querySelector<HTMLInputElement>(".property-leaf input")!.disabled).toBe(false);
    expect(root.querySelector<HTMLInputElement>(".property-leaf input")!.readOnly).toBe(false);
    root.querySelector(".array-index-handle")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(commit).not.toHaveBeenCalled();
  });

  it("respects hidden add/remove controls and explicit paging settings", () => {
    const snapshot = list(); snapshot.attributes = [{ type: "Sirenix.OdinInspector.ListDrawerSettingsAttribute", value: JSON.stringify({ HideAddButton: true, HideRemoveButton: true, ShowIndexLabels: false, NumberOfItemsPerPage: 3 }) }];
    const { root } = mount(snapshot);
    expect(root.querySelectorAll(".array-item")).toHaveLength(3);
    expect(root.querySelector(".array-add-button, .array-remove-button, .array-item-index")).toBeNull();
  });

  it("does not mutate the list from an empty size input and explicitly applies a reduction", async () => {
    const { root, commit } = mount(list(3));
    expect(root.querySelector(".array-size-input")).toBeNull();
    await click(root, ".array-menu-button"); await click(document, '[data-list-action="resize"]');
    const input = document.querySelector<HTMLInputElement>(".array-size-input")!;
    input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); await flush();
    document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(commit).not.toHaveBeenCalled();
    input.value = "1"; input.dispatchEvent(new Event("input", { bubbles: true })); await flush();
    expect(document.querySelector(".array-size-form p")).not.toBeNull();
    document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await flush();
    expect(commit.mock.calls[0]![0].value).toEqual({ action: "resize", size: 1 });
  });

  it("keeps complex item expansion on value refresh and isolates another target", async () => {
    const snapshot = list(2); snapshot.target = { kind: "asset", path: "Assets/ListOne.asset" };
    const { root, data } = mount(snapshot);
    await click(root, ".array-item-toggle");
    data.value = { ...snapshot, children: [...snapshot.children!] }; await flush();
    expect(root.querySelectorAll(".array-item-body")).toHaveLength(1);
    data.value = { ...snapshot, target: { kind: "asset", path: "Assets/ListTwo.asset" } }; await flush();
    expect(root.querySelectorAll(".array-item-body")).toHaveLength(0);
  });

  it("uses declared groups and resolved visibility inside an expanded element", async () => {
    const snapshot = list(1);
    snapshot.children![0]!.children![0]!.attributes = [{ type: "Sirenix.OdinInspector.FoldoutGroupAttribute", value: "Conditions" }];
    snapshot.children![0]!.children![1]!.attributes = [{ type: "Locus.PropertyVisibility", value: "false" }];
    const { root } = mount(snapshot);
    await click(root, ".array-item-toggle");
    expect(root.querySelector("details summary")!.textContent).toContain("Conditions");
    expect(root.querySelectorAll(".property-leaf")).toHaveLength(1);
  });

  it("loads a requested page while keeping mounted rows bounded", async () => {
    const all = list(35, false), snapshot = { ...all, children: all.children!.slice(0, 8), childrenTruncated: true };
    let data: ReturnType<typeof mount>["data"];
    const loadChildren = vi.fn(async () => { data.value = { ...all, children: all.children!.slice(0, 20), childrenTruncated: true }; });
    const mounted = mount(snapshot, { source: { loadChildren } }); data = mounted.data;
    await click(mounted.root, ".array-fold-button");
    await click(mounted.root, ".array-page-next");
    expect(loadChildren).toHaveBeenCalledOnce();
    expect(mounted.root.querySelectorAll(".array-item")).toHaveLength(10);
    expect(mounted.root.querySelector(".array-item")!.getAttribute("data-array-source-index")).toBe("10");
  });

  it("renders list menus into their owning Unity document", async () => {
    const frame = document.createElement("iframe"); document.body.append(frame);
    const { root, doc } = mount(list(1), {}, frame.contentWindow!);
    await click(root, ".array-item-menu");
    expect(doc.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("requests initialized native elements and uses a picker for reference lists", async () => {
    const snapshot = list(1);
    snapshot.attributes = [{ type: "Locus.ListElementType", value: JSON.stringify({ native: true, reference: false }) }];
    const { root, data, commit } = mount(snapshot);
    await click(root, ".array-add-button");
    expect(commit.mock.calls[0]![0].value).toEqual({ action: "insert", index: 1, initialize: true });
    data.value = { ...snapshot, attributes: [{ type: "Locus.ListElementType", value: JSON.stringify({ native: true, reference: true, fullName: "UnityEngine.Texture" }) }] }; await flush();
    await click(root, ".array-add-button");
    expect(document.querySelector(".array-reference-form")).not.toBeNull();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("inserts a dropped resource batch once without replacing an existing row", async () => {
    const snapshot = list(2, false);
    snapshot.attributes = [{ type: "Locus.ListElementType", value: JSON.stringify({ native: true, reference: true }) }];
    const { root, commit } = mount(snapshot);
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["text/plain"], getData: () => "Assets/A.asset\nAssets/B.asset" } });
    root.querySelector(".array-toolbar")!.dispatchEvent(event); await flush();
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]![0].value).toEqual({ action: "insertReferences", index: 2, values: ["Assets/A.asset", "Assets/B.asset"] });
  });

  it("cancels pointer sorting without committing, and moves to the visible end rather than an unloaded tail", async () => {
    const snapshot = list(100, false);
    snapshot.children = snapshot.children!.slice(0, 12); snapshot.childrenTruncated = true;
    const { root, commit } = mount(snapshot);
    await click(root, ".array-fold-button");
    const pointer = (name: string, y: number) => {
      const event = new Event(name, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 1, button: 0, clientX: 10, clientY: y });
      return event;
    };
    root.querySelector(".array-index-handle")!.dispatchEvent(pointer("pointerdown", 0));
    window.dispatchEvent(pointer("pointermove", 500));
    window.dispatchEvent(pointer("pointercancel", 500)); await flush();
    expect(commit).not.toHaveBeenCalled();
    root.querySelector(".array-index-handle")!.dispatchEvent(pointer("pointerdown", 0));
    window.dispatchEvent(pointer("pointermove", 500));
    window.dispatchEvent(pointer("pointerup", 500)); await flush();
    expect(commit.mock.calls[0]![0].value).toEqual({ action: "move", index: 0, toIndex: 9 });
  });

  it("keeps keyboard focus on the moved element across page boundaries", async () => {
    const { root, data, commit } = mount(list(12, false));
    commit.mockImplementation(event => {
      const { index, toIndex } = event.value;
      const children = [...data.value.children!];
      children.splice(toIndex, 0, children.splice(index, 1)[0]!);
      data.value = { ...data.value, children: children.map((child, i) => ({ ...child, propertyPath: `rules.Array.data[${i}]` })) };
    });
    const handle = root.querySelectorAll<HTMLButtonElement>(".array-index-handle")[9]!;
    handle.focus(); handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); await flush();
    expect(document.activeElement?.closest(".array-item")?.getAttribute("data-array-source-index")).toBe("10");
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); await flush();
    expect(data.value.children![11]!.value).toBe(9);
  });
});
