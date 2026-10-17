// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref, type App, type VNodeChild } from "vue";
import UnityNumberField from "../components/unity/UnityNumberField.vue";
import UnityVectorField from "../components/unity/UnityVectorField.vue";
import UnityBoundsField from "../components/unity/UnityBoundsField.vue";
import UnityPropertyEditor from "../components/unity/UnityPropertyEditor.vue";
import UnitySerializedPropertyTree from "../components/unity/UnitySerializedPropertyTree.vue";
import UnityPropertyDraw from "../components/unity/UnityPropertyDraw.vue";
import { createPropertyTree } from "../services/propertyTree";
import { createUnityPropertyRuntime } from "../components/unity/unityPropertyBinding";
import type { UnitySerializedPropertySnapshot } from "../components/unity/unitySerializedValue";

const apps: App[] = [];
function mount(render: () => VNodeChild) {
  const root = document.createElement("div"); document.body.append(root);
  const app = createApp({ render }); apps.push(app); app.mount(root); return root;
}
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); document.body.innerHTML = ""; });
async function edit(input: HTMLInputElement, value: string) {
  input.value = value; input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true })); await nextTick();
}
function snapshot(unit = "米/秒"): UnitySerializedPropertySnapshot {
  return { propertyPath: "speed", valueType: "Float", value: 2.6, displayName: "Speed", unit, editable: true };
}

describe("input unit suffix", () => {
  it.each([undefined, "", "   "])("preserves the plain input and attribute target without a unit (%s)", unit => {
    const root = mount(() => h(UnityNumberField, { modelValue: 12, unit, id: "amount", "aria-describedby": "help", class: "custom-field" }));
    expect(root.querySelector(".input-unit")).toBeNull();
    expect(root.firstElementChild?.tagName).toBe("INPUT");
    expect(root.querySelector("input")?.id).toBe("amount");
    expect(root.querySelector("input")?.classList.contains("custom-field")).toBe(true);
    expect(root.querySelector("input")?.getAttribute("aria-describedby")).toBe("help");
  });
  it("keeps the suffix outside editable/selected text and announces it as a description", () => {
    const root = mount(() => h(UnityNumberField, { modelValue: 2.6, unit: " 米/秒 ", ariaLabel: "Speed", "aria-describedby": "help", id: "speed" }));
    const input = root.querySelector("input")!;
    const suffix = root.querySelector<HTMLElement>(".input-unit-suffix")!;
    expect(input.value).toBe("2.6"); expect(input.id).toBe("speed");
    expect(suffix.textContent).toBe("米/秒");
    expect(input.getAttribute("aria-describedby")).toBe(`help ${suffix.id}`);
    input.select(); expect(input.value.slice(input.selectionStart!, input.selectionEnd!)).toBe("2.6");
  });
  it.each([
    ["Float", 1.25, "2.75", 2.75], ["Integer", 10, "22", 22],
    ["Double", 1, "1.23456789012345", 1.23456789012345],
    ["Long", "0", "9223372036854775807", "9223372036854775807"],
    ["UnsignedLong", "0", "18446744073709551615", "18446744073709551615"],
  ] as const)("preserves %s parsing and exact values", async (propertyType, modelValue, text, expected) => {
    const commit = vi.fn();
    const root = mount(() => h(UnityNumberField, { modelValue, propertyType, unit: "帧", onCommit: commit }));
    await edit(root.querySelector("input")!, text);
    expect(commit).toHaveBeenCalledExactlyOnceWith(expected);
  });
  it("does not infer percentage conversions or accept numeric text with appended units", async () => {
    const commit = vi.fn();
    const root = mount(() => h(UnityNumberField, { modelValue: 0.5, unit: "%", onCommit: commit }));
    await edit(root.querySelector("input")!, "0.75"); expect(commit).toHaveBeenCalledExactlyOnceWith(0.75);
    commit.mockClear(); await edit(root.querySelector("input")!, "50%"); expect(commit).not.toHaveBeenCalled();
  });
  it("changing the unit alone neither changes nor commits a partially edited value", async () => {
    const unit = ref("秒"), commit = vi.fn();
    const root = mount(() => h(UnityNumberField, { modelValue: 1, unit: unit.value, onCommit: commit }));
    const input = root.querySelector("input")!;
    input.value = "1."; input.dispatchEvent(new Event("input", { bubbles: true })); await nextTick();
    unit.value = "帧"; await nextTick();
    expect(root.querySelector("input")?.value).toBe("1.");
    expect(root.querySelector(".input-unit-suffix")?.textContent).toBe("帧");
    expect(commit).not.toHaveBeenCalled();
    unit.value = ""; await nextTick();
    expect(root.querySelector(".input-unit-suffix")).toBeNull();
    expect(root.querySelector("input")?.value).toBe("1.");
  });
  it("keeps range input clamping, slider preview and accessible values", async () => {
    const commit = vi.fn(), preview = vi.fn();
    const root = mount(() => h(UnityNumberField, { modelValue: 5, unit: "秒", hasRange: true, rangeMin: 0, rangeMax: 10, onCommit: commit, onPreview: preview }));
    expect(root.querySelectorAll(".input-unit-suffix")).toHaveLength(1);
    const slider = root.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.getAttribute("aria-valuetext")).toBe("5 秒");
    await edit(root.querySelector<HTMLInputElement>(".unity-number-range-input")!, "100");
    expect(commit).toHaveBeenLastCalledWith(10);
    await edit(slider, "3"); expect(preview).toHaveBeenLastCalledWith(3);
    expect(commit).toHaveBeenLastCalledWith(3);
    expect(root.querySelector<HTMLInputElement>(".unity-number-range-input")?.value).toBe("3");
  });
  it.each(["readonly", "disabled"] as const)("preserves %s restrictions", async restriction => {
    const commit = vi.fn();
    const root = mount(() => h(UnityNumberField, { modelValue: 1, unit: "秒", [restriction]: true, onCommit: commit }));
    const input = root.querySelector("input")!;
    expect(restriction === "readonly" ? input.readOnly : input.disabled).toBe(true);
    await edit(input, "2"); expect(commit).not.toHaveBeenCalled();
    expect(root.querySelector(`.input-unit.${restriction}`)).not.toBeNull();
  });
  it("focuses the input from the suffix and keeps Escape cancellation value-only", async () => {
    const commit = vi.fn();
    const root = mount(() => h(UnityNumberField, { modelValue: 8, unit: "帧", onCommit: commit }));
    root.querySelector(".input-unit-suffix")!.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    const input = root.querySelector("input")!; expect(document.activeElement).toBe(input);
    input.value = "99"; input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await nextTick();
    expect(input.value).toBe("8"); expect(commit).not.toHaveBeenCalled();
  });
  it("uses a separate description per axis and preserves vector commits", async () => {
    const commit = vi.fn();
    const root = mount(() => h(UnityVectorField, { modelValue: { x: 1, y: 2, z: 3 }, unit: "m/s", ariaLabel: "Velocity", onCommit: commit }));
    const inputs = [...root.querySelectorAll("input")];
    const suffixes = [...root.querySelectorAll<HTMLElement>(".input-unit-suffix")];
    expect(suffixes.map(s => s.textContent)).toEqual(["m/s", "m/s", "m/s"]);
    expect(new Set(suffixes.map(s => s.id)).size).toBe(3);
    expect(inputs[0]!.getAttribute("aria-label")).toBe("Velocity X");
    await edit(inputs[1]!, "4"); expect(commit).toHaveBeenCalledExactlyOnceWith({ x: 1, y: 4, z: 3 });
  });
  it("decorates each Bounds coordinate without altering the bounds payload", async () => {
    const commit = vi.fn();
    const root = mount(() => h(UnityBoundsField, { modelValue: { center: { x: 1, y: 2, z: 3 }, extents: { x: 2, y: 3, z: 4 } }, unit: "米", onCommit: commit }));
    expect(root.querySelectorAll(".input-unit-suffix")).toHaveLength(6);
    await edit(root.querySelector("input")!, "5");
    expect(commit).toHaveBeenCalledOnce(); expect(commit.mock.calls[0]![0].center.x).toBe(5);
    expect(JSON.stringify(commit.mock.calls[0]![0])).not.toContain("米");
  });
  it("supports single-line text without changing the string payload", async () => {
    const commit = vi.fn();
    const root = mount(() => h(UnityPropertyEditor, { modelValue: "10", propertyType: "String", unit: "ms", onCommit: commit }));
    await edit(root.querySelector("input")!, "20");
    expect(commit).toHaveBeenCalledExactlyOnceWith("20");
    expect(root.querySelector(".input-unit-suffix")?.textContent).toBe("ms");
  });
  it.each(["Boolean", "Character", "String"])("does not decorate non-measurement controls (%s multiline)", propertyType => {
    const root = mount(() => h(UnityPropertyEditor, { modelValue: propertyType === "Boolean" ? true : "x", propertyType, multiline: true, unit: "m" }));
    expect(root.querySelector(".input-unit-suffix")).toBeNull();
  });
});

describe("property unit metadata", () => {
  it("normalizes units independently of the label/value and exposes them to custom drawers", async () => {
    const data = snapshot(" 米/秒 ");
    const tree = createPropertyTree(data); const property = tree.rootProperty!;
    expect(property.unit).toBe("米/秒"); expect(property.label).toBe("Speed"); expect(property.value).toBe(2.6);
    const drawer = defineComponent({ inheritAttrs: false, props: ["unit", "modelValue", "commit"],
      setup: p => () => h(UnityNumberField, { unit: p.unit, modelValue: p.modelValue, onCommit: p.commit }) });
    const committed = vi.fn();
    const root = mount(() => h(UnityPropertyDraw, { property, propertyDrawers: [{ valueType: "Float", drawer }], onCommit: committed }));
    expect(root.querySelector(".input-unit-suffix")?.textContent).toBe("米/秒");
    await edit(root.querySelector("input")!, "4");
    expect(committed.mock.calls[0]![0]).toMatchObject({ propertyPath: "speed", value: 4 });
  });
  it("carries units through a nested property tree without labeling parent objects", () => {
    const root = mount(() => h(UnitySerializedPropertyTree, { property: { propertyPath: "root", valueType: "Generic", value: null, children: [snapshot()] } }));
    expect(root.querySelectorAll(".input-unit-suffix")).toHaveLength(1);
    expect(root.querySelector(".property-name")?.textContent).toBe("root");
    expect(root.querySelector(".input-unit-suffix")?.textContent).toBe("米/秒");
  });
  it("keeps bound field writes unit-free", async () => {
    const write = vi.fn(async request => ({ ...snapshot(), ok: true, target: request.target, value: request.value }));
    const runtime = createUnityPropertyRuntime({ read: async request => ({ ...snapshot(), ok: true, target: request.target }), write, apply: vi.fn() });
    const tree = await runtime.readTree("selection/property/speed");
    const root = mount(() => tree.require("speed").drawDefaultEditor());
    expect(root.querySelector(".input-unit-suffix")?.textContent).toBe("米/秒");
    await edit(root.querySelector("input")!, "6");
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0]).toMatchObject({ target: { propertyPath: "speed" }, value: 6 });
  });
});
