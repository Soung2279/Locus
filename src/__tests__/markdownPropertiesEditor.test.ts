// @vitest-environment jsdom
import { undo, redo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { createApp, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BaseMarkdownEditor from "../components/ui/BaseMarkdownEditor.vue";
import type { MarkdownEditorDocumentChange } from "../components/ui/markdown-editor/markdownEditorDocumentChange";
import { markdownFrontmatterField } from "../components/ui/markdown-editor/markdownFrontmatter";
import { parse } from "yaml";

vi.mock("../i18n", () => ({ t: (key: string) => key }));
let app: App | null = null;
beforeEach(() => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { app?.unmount(); app = null; document.body.replaceChildren(); });

async function mount(source: string, disabled = false) {
  const editor = ref<{ getEditorView(): EditorView } | null>(null);
  const mode = ref<"rendered" | "native">("rendered");
  const model = ref(source);
  const key = ref("a");
  const changes: MarkdownEditorDocumentChange[] = [];
  const save = vi.fn();
  const root = document.createElement("div"); document.body.append(root);
  app = createApp({ setup: () => () => h(BaseMarkdownEditor, {
    ref: editor, modelValue: model.value, contentKey: key.value, viewMode: mode.value,
    contentPath: "人物.md", showProperties: true, transactionModel: true, disabled,
    onDocumentChange: (change: MarkdownEditorDocumentChange) => changes.push(change), onShortcutSave: save,
  }) });
  app.mount(root); await nextTick();
  return { root, view: editor.value!.getEditorView(), changes, mode, model, key, save };
}
function input(root: HTMLElement, label: string, value: string) {
  const target = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(target).toBeTruthy();
  target.value = value; target.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Markdown properties editor", () => {
  it("edits the actual document, emits transactions and shares undo with source mode", async () => {
    const source = "---\n类型: 角色 # keep\n别名:\n  - Elora\n---\n\n# 正文\n保持正文。\n";
    const { root, view, changes, mode, save } = await mount(source);
    expect(root.querySelectorAll(".property-row")).toHaveLength(2);
    expect(view.contentDOM.textContent).not.toContain("类型:");
    input(root, "类型", "主角"); await nextTick();
    expect(changes).toHaveLength(1);
    expect(view.state.doc.toString()).toContain("类型: 主角 # keep");
    expect(view.state.doc.toString().endsWith("# 正文\n保持正文。\n")).toBe(true);
    const propertyInput = root.querySelector<HTMLInputElement>('input[aria-label="类型"]')!;
    propertyInput.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    expect(save).toHaveBeenCalledOnce();
    mode.value = "native"; await nextTick();
    expect(root.querySelector(".markdown-properties")).toBeNull();
    expect(view.contentDOM.textContent).toContain("类型:");
    undo(view); await nextTick(); expect(view.state.doc.toString()).toBe(source);
    redo(view); await nextTick(); expect(view.state.doc.toString()).toContain("主角");
    mode.value = "rendered"; await nextTick();
    expect(root.querySelector<HTMLInputElement>('input[aria-label="类型"]')!.value).toBe("主角");
  });
  it("edits lists and checkbox values without changing their types", async () => {
    const { root, view } = await mount("---\n别名: [Elora]\n主角: false\n---\n\n正文");
    input(root, "别名 1", "女剑士"); await nextTick();
    root.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click(); await nextTick();
    const value = parse(view.state.field(markdownFrontmatterField).yaml);
    expect(value).toEqual({ 别名: ["女剑士"], 主角: true });
  });
  it("creates frontmatter and keeps the draft across document sessions", async () => {
    const { root, view, key, model } = await mount("# Body");
    root.querySelector<HTMLButtonElement>(".property-add-trigger")!.click(); await nextTick();
    const name = root.querySelector<HTMLInputElement>(".property-add input")!;
    name.value = "类型"; name.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await nextTick();
    input(root, "类型", "角色"); await nextTick();
    expect(parse(view.state.field(markdownFrontmatterField).yaml)).toEqual({ 类型: "角色" });
    expect(view.state.doc.toString().endsWith("---\n\n# Body")).toBe(true);
    key.value = "b"; model.value = "Second"; await nextTick();
    expect(root.querySelectorAll(".property-row")).toHaveLength(0);
    key.value = "a"; model.value = "# Body"; await nextTick();
    expect(root.querySelector<HTMLInputElement>('input[aria-label="类型"]')!.value).toBe("角色");
  });
  it("reflects external changes and keeps invalid YAML visible in the editor", async () => {
    const { root, view, model } = await mount("---\n类型: 角色\n---\n正文");
    model.value = "---\n类型: [broken\n---\n正文"; await nextTick();
    expect(root.querySelector('[role="alert"]')).toBeTruthy();
    expect(view.contentDOM.textContent).toContain("类型: [broken");
    expect(root.querySelector(".property-add-trigger")).toBeNull();
    model.value = "---\n类型: 地点\n---\n正文"; await nextTick();
    expect(root.querySelector<HTMLInputElement>('input[aria-label="类型"]')!.value).toBe("地点");
  });
  it("shows disabled properties for read-only documents", async () => {
    const { root, changes } = await mount("---\n类型: 角色\n---\n正文", true);
    expect(root.querySelector<HTMLInputElement>('input[aria-label="类型"]')!.disabled).toBe(true);
    expect(root.querySelector(".property-remove")).toBeNull();
    input(root, "类型", "changed"); expect(changes).toHaveLength(0);
  });
  it("switches property types from the icon menu and preserves the existing value", async () => {
    const { root, view } = await mount('---\n年龄: "19"\n---\n正文');
    const trigger = root.querySelector<HTMLButtonElement>('.property-type')!;
    trigger.click(); await nextTick(); await nextTick();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const choice = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
      .find((button) => button.textContent?.includes("editor.properties.number"))!;
    expect(choice).toBeTruthy();
    choice.click(); await nextTick();
    expect(parse(view.state.field(markdownFrontmatterField).yaml).年龄).toBe(19);
    expect(root.querySelector<HTMLInputElement>('input[aria-label="年龄"]')!.type).toBe("number");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
