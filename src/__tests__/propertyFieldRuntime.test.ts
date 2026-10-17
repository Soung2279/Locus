// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref, type App, type VNodeChild } from "vue";
import PropertyField from "../components/property-field/PropertyField.vue";
import {
  propertyFieldAccess, propertyFieldActions, propertyFieldActionDisabled,
  type PropertyFieldAction, type PropertyFieldPresentation,
} from "../components/property-field/propertyField";
import {
  createPropertyTree, resolveInspectorFieldPresentation,
  type InspectorFieldPresentationResolver,
} from "../services/propertyTree";
import type { UnitySerializedPropertySnapshot } from "../components/unity/unitySerializedValue";
import UnitySerializedPropertyTree from "../components/unity/UnitySerializedPropertyTree.vue";
import UnityPropertyDraw from "../components/unity/UnityPropertyDraw.vue";
import { createUnityPropertyRuntime } from "../components/unity/unityPropertyBinding";
import { provideWindowSurface } from "../composables/useWindowSurface";

const apps: App[] = [];
function mount(render: () => VNodeChild, doc = document, setup?: () => void) {
  const root = doc.createElement("div"); doc.body.append(root);
  const app = createApp({ setup() { setup?.(); return render; } });
  apps.push(app); app.mount(root); return root;
}
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); document.body.innerHTML = ""; });
const revert: PropertyFieldAction = { id: "revert", kind: "revert", label: "Restore template value", quick: true };
const apply: PropertyFieldAction = { id: "apply", kind: "apply-to-template", label: "Apply to EnemyBase" };
const inspect: PropertyFieldAction = { id: "source", kind: "inspect-source", label: "Locate source", group: "source" };
const create: PropertyFieldAction = { id: "create", kind: "create-override", label: "Create override" };
const reset: PropertyFieldAction = { id: "reset", kind: "reset-default", label: "Reset initial default" };
function field(state: "local" | "inherited" | "overridden" = "overridden"): PropertyFieldPresentation {
  return { scope: "template-and-instance", context: "instance", provenance: { state, sourceLabel: "EnemyBase", inheritedDisplayValue: "120" }, actions: [create, revert, apply, reset, inspect] };
}
function number(path = "health", extra: Partial<UnitySerializedPropertySnapshot> = {}): UnitySerializedPropertySnapshot {
  return { propertyPath: path, displayName: path, valueType: "Float", value: 150, editable: true, ...extra };
}
async function contextMenu(element: Element) {
  element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 18 }));
  await nextTick(); await nextTick();
}
function menuAction(id: string, doc = document) { return doc.querySelector<HTMLButtonElement>(`[data-field-action="${id}"]`)!; }

describe("field authoring policy", () => {
  it.each([
    ["template-only", "template", true, false], ["template-only", "instance", true, true],
    ["instance-only", "template", false, false], ["instance-only", "instance", true, false],
    ["template-and-instance", "template", true, false], ["template-and-instance", "instance", true, false],
  ] as const)("%s in %s", (scope, context, visible, readonly) => {
    expect(propertyFieldAccess({ scope, context })).toMatchObject({ visible, readonly });
  });
  it("keeps ownership, restrictions and explicit overrides independent", () => {
    expect(propertyFieldActions(field("inherited")).map(a => a.id)).toEqual(["create", "reset", "source"]);
    expect(propertyFieldActions(field()).map(a => a.id)).toEqual(["revert", "apply", "reset", "source"]);
    expect(propertyFieldActions({ ...field(), scope: "instance-only" }).map(a => a.id)).toEqual(["reset", "source"]);
    expect(propertyFieldActions({ ...field(), scope: "template-only" }).map(a => a.id)).toEqual(["reset", "source"]);
    expect(propertyFieldActionDisabled(revert, { ...field(), readonly: true })).toBe(true);
    expect(propertyFieldActionDisabled(inspect, { ...field(), readonly: true })).toBe(false);
    expect(propertyFieldActionDisabled({ ...apply, mutates: false }, { ...field(), readonly: true })).toBe(true);
    expect(propertyFieldActionDisabled(inspect, { ...field(), busy: true })).toBe(true);
  });
  it("does not infer an override from changed UI state or equal values", () => {
    const tree = createPropertyTree(number("health", { prefabOverride: true, value: 120 }), { changedPaths: ["health"] });
    expect(resolveInspectorFieldPresentation(tree.rootProperty!).provenance?.state).toBe("overridden");
    expect(resolveInspectorFieldPresentation(createPropertyTree(number(), { changedPaths: ["health"] }).rootProperty!)).toEqual({});
    expect(resolveInspectorFieldPresentation(tree.rootProperty!, () => ({ scope: "instance-only", provenance: { state: "local" } })).provenance?.state).toBe("local");
    expect(resolveInspectorFieldPresentation(tree.rootProperty!, () => null)).toEqual({});
  });
});

describe("PropertyField interaction", () => {
  it("is available through the public View component module", async () => {
    const { LOCUS_COMPONENTS } = await import("../components/view/viewRuntime");
    expect(LOCUS_COMPONENTS.PropertyField).toBe(PropertyField);
  });
  it("marks only explicit overrides; source information is not a persistent badge", async () => {
    const state = ref(field());
    const root = mount(() => h(PropertyField, { ...state.value, label: "Health" }, { default: () => h("input", { value: 120 }) }));
    expect(root.querySelector(".property-field.overridden")).not.toBeNull();
    expect(root.querySelector(".parameter-state, .source-scope")).toBeNull();
    expect(root.querySelector(".property-field-description")?.textContent).toContain("EnemyBase");
    state.value = field("inherited"); await nextTick();
    expect(root.querySelector(".property-field.overridden")).toBeNull();
    expect(root.querySelector<HTMLInputElement>("input")?.disabled).toBe(false);
  });
  it("passes policy restrictions to editors and hides instance-only fields in templates", async () => {
    const state = ref<PropertyFieldPresentation>({ scope: "template-only", context: "instance" });
    const root = mount(() => h(PropertyField, { ...state.value, label: "Health" }, {
      default: (access: { readonly: boolean; disabled: boolean }) => h("input", { readonly: access.readonly, disabled: access.disabled }),
    }));
    expect(root.querySelector<HTMLInputElement>("input")?.readOnly).toBe(true);
    state.value = { scope: "instance-only", context: "template" }; await nextTick();
    expect(root.querySelector(".property-field")).toBeNull();
  });
  it("supports right-click, keyboard navigation, Escape and restoring focus", async () => {
    const action = vi.fn();
    const root = mount(() => h(PropertyField, { ...field(), label: "Health", onAction: action }, { default: () => h("input") }));
    const input = root.querySelector("input")!; input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, shiftKey: true, key: "F10" }));
    await nextTick(); await nextTick();
    expect(document.activeElement).toBe(menuAction("revert"));
    menuAction("revert").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" }));
    expect(document.activeElement).toBe(menuAction("source"));
    menuAction("source").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await nextTick();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(input);
    await contextMenu(input); menuAction("apply").click(); await nextTick();
    expect(action).toHaveBeenCalledExactlyOnceWith(apply);
  });
  it("rechecks permissions while open and keeps inspection available in read-only mode", async () => {
    const readonly = ref(false); const action = vi.fn();
    const root = mount(() => h(PropertyField, { ...field(), label: "Health", readonly: readonly.value, onAction: action }, { default: () => h("input") }));
    await contextMenu(root.querySelector("input")!);
    readonly.value = true; await nextTick();
    expect(menuAction("revert").disabled).toBe(true);
    menuAction("revert").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(action).not.toHaveBeenCalled();
    expect(menuAction("source").disabled).toBe(false);
    menuAction("source").click(); expect(action).toHaveBeenCalledExactlyOnceWith(inspect);
  });
  it("closes stale menus when field identity changes", async () => {
    const key = ref("a");
    const root = mount(() => h(PropertyField, { ...field(), fieldKey: key.value }, { default: () => h("input") }));
    await contextMenu(root.querySelector("input")!);
    key.value = "b"; await nextTick();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it("does not route a child field's context menu to a parent field", async () => {
    const parent = vi.fn(), child = vi.fn();
    const root = mount(() => h(PropertyField, { ...field(), onAction: parent }, {
      default: () => h(PropertyField, { ...field(), onAction: child }, { default: () => h("input") }),
    }));
    await contextMenu(root.querySelector("input")!);
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    menuAction("revert").click();
    expect(child).toHaveBeenCalledOnce(); expect(parent).not.toHaveBeenCalled();
  });
  it("teleports into the owning document, including embedded View windows", async () => {
    const iframe = document.createElement("iframe"); document.body.append(iframe);
    const doc = iframe.contentDocument!;
    const root = mount(() => h(PropertyField, field(), { default: () => h("input") }), doc,
      () => provideWindowSurface(iframe.contentWindow!));
    await contextMenu(root.querySelector("input")!);
    expect(doc.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("Unity field presentation integration", () => {
  it("renders native prefab overrides and loaded-child summaries without inventing write capabilities", () => {
    const root = mount(() => h(UnitySerializedPropertyTree, { property: {
      propertyPath: "settings", valueType: "Generic", value: null,
      children: [number("settings.health", { prefabOverride: true }), number("settings.speed")],
    } }));
    expect(root.querySelectorAll(".property-field.overridden")).toHaveLength(1);
    expect(root.querySelectorAll(".property-field.children-overridden")).toHaveLength(1);
    expect(root.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(0);
  });
  it("keeps list-level chrome on the title, without marking inherited child rows", () => {
    const root = mount(() => h(UnitySerializedPropertyTree, { property: {
      propertyPath: "values", valueType: "Generic", value: null, isArray: true, arraySize: 1,
      fieldPresentation: field(), children: [number("values.Array.data[0]")],
    } }));
    const title = root.querySelector(".property-list-header.overridden")!;
    expect(title).not.toBeNull();
    expect(title.querySelector(".array-items")).toBeNull();
    expect(root.querySelector(".array-items .property-field.overridden")).toBeNull();
  });
  it("routes nested array field actions to their exact property and never commits a value", async () => {
    const committed = vi.fn(), action = vi.fn();
    const fieldPresentation: InspectorFieldPresentationResolver = p => p.propertyPath.includes("data[0]") ? field() : {};
    const root = mount(() => h(UnitySerializedPropertyTree, { property: {
      propertyPath: "values", valueType: "Generic", value: null, isArray: true, arraySize: 1,
      children: [number("values.Array.data[0]")],
    }, fieldPresentation, onFieldAction: action, onCommit: committed }));
    await contextMenu(root.querySelector(".property-leaf input")!);
    menuAction("revert").click();
    expect(action).toHaveBeenCalledOnce();
    expect(action.mock.calls[0]![0]).toMatchObject({ propertyPath: "values.Array.data[0]", snapshot: { propertyPath: "values.Array.data[0]" }, action: revert });
    expect(committed).not.toHaveBeenCalled();
  });
  it("honors scope in recursive fields, including number-label drag and array mutation controls", () => {
    const root = mount(() => h(UnitySerializedPropertyTree, { property: {
      propertyPath: "settings", valueType: "Generic", value: null,
      children: [number("shared"), number("instance"), { propertyPath: "array", valueType: "Generic", value: [], isArray: true, arraySize: 0 }],
    }, fieldPresentation: p => p.propertyPath === "instance" ? { scope: "instance-only", context: "template" }
      : p.propertyPath === "settings" ? {} : { scope: "template-only", context: "instance" } }));
    expect(root.querySelectorAll(".property-leaf")).toHaveLength(1);
    expect(root.querySelector<HTMLInputElement>(".property-leaf input")?.readOnly).toBe(true);
    expect(root.querySelector(".property-name-drag")).toBeNull();
    expect(root.querySelector<HTMLButtonElement>(".array-add-button")?.disabled).toBe(true);
  });
  it("keeps group override actions reachable when array object headers would normally be hidden", () => {
    const root = mount(() => h(UnitySerializedPropertyTree, { property: {
      propertyPath: "element", valueType: "Generic", value: null, children: [number("element.x")], fieldPresentation: field(),
    }, hideRootObjectHeader: true }));
    expect(root.querySelector('[data-field-key$=":element"] [aria-haspopup="menu"]')).not.toBeNull();
  });
  it("decorates custom drawers exactly once and suppresses read-only commits", async () => {
    const committed = vi.fn(), action = vi.fn();
    const drawer = defineComponent({ inheritAttrs: false, props: ["commit"], setup: props => () => h("button", { class: "custom-drawer", onClick: () => props.commit(200) }, "Write") });
    const root = mount(() => h(UnitySerializedPropertyTree, { property: number(), readonly: true,
      propertyDrawers: [{ valueType: "Float", drawer }], fieldPresentation: () => field(), onCommit: committed, onFieldAction: action }));
    expect(root.querySelectorAll(".property-field")).toHaveLength(1);
    root.querySelector<HTMLButtonElement>(".custom-drawer")!.click();
    expect(committed).not.toHaveBeenCalled();
    await contextMenu(root.querySelector(".custom-drawer")!); menuAction("source").click();
    expect(action).toHaveBeenCalledOnce();
  });
  it("supports standalone UnityPropertyDraw and raw draw() without duplicate chrome", async () => {
    const property = createPropertyTree(number("health", { fieldPresentation: field() })).rootProperty!;
    const action = vi.fn();
    const root = mount(() => h(UnityPropertyDraw, { property, onFieldAction: action }));
    expect(root.querySelectorAll(".property-field")).toHaveLength(1);
    await contextMenu(root.querySelector(".inspector-property-draw-row")!); menuAction("revert").click();
    expect(action.mock.calls[0]![0].property).toBe(property);
  });
  it("keeps fallback group chrome on the header rather than around every descendant", () => {
    const property = createPropertyTree({ propertyPath: "root", valueType: "Generic", editable: false,
      children: [number("root.health", { prefabOverride: true })] }).rootProperty!;
    const root = mount(() => h(UnityPropertyDraw, { property }));
    const group = root.querySelector(".inspector-property-draw-group")!;
    const header = group.querySelector(":scope > .property-field")!;
    expect(header.querySelector(".inspector-property-draw-children")).toBeNull();
    expect(group.querySelector(":scope > .inspector-property-draw-children .property-field.overridden")).not.toBeNull();
  });
  it("keeps editable children of non-editable custom group headers editable", () => {
    const committed = vi.fn();
    const group = defineComponent({ inheritAttrs: false, props: ["drawChild"], setup: p => () => h("div", [p.drawChild("root.health")]) });
    const scalar = defineComponent({ inheritAttrs: false, props: ["commit"], setup: p => () => h("button", { onClick: () => p.commit(200) }, "Write") });
    const property = createPropertyTree({ propertyPath: "root", valueType: "Generic", editable: false, children: [number("root.health")] }).rootProperty!;
    const root = mount(() => h(UnityPropertyDraw, { property,
      propertyDrawers: [{ valueType: "Generic", drawer: group }, { valueType: "Float", drawer: scalar }], onCommit: committed }));
    root.querySelector("button")!.click();
    expect(committed).toHaveBeenCalledOnce();
    expect(committed.mock.calls[0]![0].propertyPath).toBe("root.health");
  });
  it("does not allow child drawer options to bypass an explicit parent scope restriction", () => {
    const committed = vi.fn();
    const group = defineComponent({ inheritAttrs: false, props: ["drawChild"], setup: p => () => h("div", [p.drawChild("root.health", { readonly: false })]) });
    const scalar = defineComponent({ inheritAttrs: false, props: ["commit"], setup: p => () => h("button", { onClick: () => p.commit(200) }, "Write") });
    const property = createPropertyTree({ propertyPath: "root", valueType: "Generic", children: [number("root.health")] }).rootProperty!;
    const root = mount(() => h(UnityPropertyDraw, { property,
      fieldPresentation: p => p.propertyPath === "root" ? { scope: "template-only", context: "instance" } : {},
      propertyDrawers: [{ valueType: "Generic", drawer: group }, { valueType: "Float", drawer: scalar }], onCommit: committed }));
    root.querySelector("button")!.click(); expect(committed).not.toHaveBeenCalled();
  });
  it("does not let native summaries contradict explicit business ownership", () => {
    const property = createPropertyTree({ propertyPath: "root", valueType: "Generic", children: [number("root.health", { prefabOverride: true })] }).rootProperty!;
    expect(resolveInspectorFieldPresentation(property, p => p.propertyPath === "root.health" ? { scope: "instance-only", provenance: { state: "local" } } : undefined)).toEqual({});
  });
  it("bound scalar/default-tree editors expose actions but leave execution to the owner", async () => {
    const writes = vi.fn();
    const runtime = createUnityPropertyRuntime({ read: async r => ({ ...number(), ok: true, target: r.target }), write: writes, apply: vi.fn() });
    const tree = await runtime.readTree("selection/property/health");
    const action = vi.fn();
    const root = mount(() => tree.require("health").drawDefaultEditor({ fieldPresentation: () => field(), onFieldAction: action }));
    await contextMenu(root.querySelector("input")!); menuAction("apply").click();
    expect(action).toHaveBeenCalledOnce(); expect(writes).not.toHaveBeenCalled();
    const readonlyRoot = mount(() => tree.drawDefaultEditor({ fieldPresentation: () => ({ scope: "template-only", context: "instance" }) }));
    expect(readonlyRoot.querySelector<HTMLInputElement>("input")?.readOnly).toBe(true);
  });
});
