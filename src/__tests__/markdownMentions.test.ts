// @vitest-environment jsdom
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownMentionRange, markdownMentions } from "../components/ui/markdown-editor/markdownMentions";
import { markdownLivePreview } from "../components/ui/markdown-editor/markdownLivePreview";
import type { MarkdownMentionResource } from "../components/ui/markdown-editor/markdownMentionResources";

const resource = (name: string, path = `docs/${name}.md`): MarkdownMentionResource => ({ name, relPath: path, parentPath: "docs", entryKind: "asset", matchScore: 0 });
const search = vi.fn<(query: string) => Promise<MarkdownMentionResource[]>>();
const insert = vi.fn(async (item: MarkdownMentionResource) => `[${item.name}](${item.relPath})`);
let view: EditorView;
let context = { workspaceRef: { checkoutId: "test", expectedGeneration: 1, expectedMaterializationEpoch: 1 }, contentPath: "docs/current.md", key: "one" };
const readonly = new Compartment();

beforeEach(() => {
  search.mockReset().mockResolvedValue([resource("Alpha"), resource("Beta")]);
  insert.mockClear();
  context = { workspaceRef: { checkoutId: "test", expectedGeneration: 1, expectedMaterializationEpoch: 1 }, contentPath: "docs/current.md", key: "one" };
  if (!Range.prototype.getClientRects) Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  if (!Range.prototype.getBoundingClientRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ left: 10, right: 10, top: 10, bottom: 30, width: 0, height: 20 }) });
});
afterEach(() => { view?.destroy(); document.body.replaceChildren(); });

function mount(text = "", rendered = false) {
  view = new EditorView({ parent: document.body, state: EditorState.create({ doc: text, selection: { anchor: text.length },
    extensions: [markdown(), history(), keymap.of(defaultKeymap), readonly.of(EditorState.readOnly.of(false)),
      ...(rendered ? [markdownLivePreview()] : []), markdownMentions({ context: () => context, search, insert })] }) });
  view.focus();
}
function type(text: string) { view.dispatch({ ...view.state.replaceSelection(text), userEvent: "input.type" }); }
function key(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(event); return event;
}
function popup() { return view.dom.querySelector(".cm-mention-tooltip"); }
async function loaded() { await vi.waitFor(() => expect(popup()?.querySelectorAll("[role=option]")).toHaveLength(2)); }

describe("Markdown @ references", () => {
  it.each([false, true])("searches at the caret and inserts an undoable reference (rendered=%s)", async rendered => {
    mount("参考：", rendered); type("@");
    expect(popup()).not.toBeNull(); await loaded();
    expect(search).toHaveBeenCalledWith("", context.workspaceRef);
    key("ArrowDown"); expect(view.contentDOM.getAttribute("aria-activedescendant")).toMatch(/-1$/);
    expect(key("Enter").defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("参考：[Beta](docs/Beta.md)"));
    expect(popup()).toBeNull(); expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe("参考：@"); expect(popup()).toBeNull();
  });

  it("keeps focus for mouse selection and replaces only the mention before trailing text", async () => {
    mount("before  after"); view.dispatch({ selection: { anchor: 7 } }); type("@Al"); await loaded();
    const button = popup()!.querySelector<HTMLButtonElement>("button")!;
    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); button.click();
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("before [Alpha](docs/Alpha.md) after"));
    expect(view.hasFocus).toBe(true);
  });

  it("dismisses with Escape and does not reopen until a new @ is typed", async () => {
    mount(); type("@"); await loaded(); key("Escape"); expect(popup()).toBeNull();
    type("Alpha"); expect(popup()).toBeNull(); type(" @"); expect(popup()).not.toBeNull();
  });

  it("debounces input and discards stale search results", async () => {
    let finish!: (items: MarkdownMentionResource[]) => void;
    search.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mount(); type("@a"); await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    type("b"); type("c"); finish([resource("Old")]);
    await loaded(); expect(search.mock.calls.map(call => call[0])).toEqual(["a", "abc"]);
    expect(popup()?.textContent).not.toContain("Old");
  });

  it("leaves IME Enter to the composition and searches the committed query", async () => {
    mount(); type("@"); await loaded();
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type("中文"); expect(key("Process", { isComposing: true, keyCode: 229 }).defaultPrevented).toBe(false);
    expect(insert).not.toHaveBeenCalled();
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.waitFor(() => expect(search).toHaveBeenLastCalledWith("中文", context.workspaceRef));
  });

  it.each(["user@example", "\\@escaped", "`@code`", "```ts\n@code\n```", "    @code", "[label](@target)", "![label](@image)", "<a href='@html'>", "---\nname: @yaml\n---"])("does not trigger inside %s", text => {
    const head = text.indexOf("@") + 1;
    const state = EditorState.create({ doc: text, selection: { anchor: head }, extensions: [markdown()] });
    expect(markdownMentionRange(state)).toBeNull();
  });

  it("supports Chinese text and filenames with spaces", async () => {
    mount("参考"); type("@设计 文档"); await loaded();
    expect(search).toHaveBeenCalledWith("设计 文档", context.workspaceRef);
    key("Tab"); await vi.waitFor(() => expect(view.state.doc.toString()).toBe("参考[Alpha](docs/Alpha.md)"));
  });

  it("closes on cursor movement, outside clicks, and read-only reconfiguration", async () => {
    mount(); type("@"); await loaded(); view.dispatch({ selection: { anchor: 0 } }); expect(popup()).toBeNull();
    view.dispatch({ selection: { anchor: view.state.doc.length } }); type(" @"); await loaded();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); expect(popup()).toBeNull();
    type(" @"); await loaded(); view.dispatch({ effects: readonly.reconfigure(EditorState.readOnly.of(true)) }); expect(popup()).toBeNull();
  });

  it("never applies a pending insertion after typing or changing workspace generation", async () => {
    let finish!: (text: string) => void;
    insert.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mount(); type("@"); await loaded(); key("Enter"); type("new"); finish("WRONG");
    await Promise.resolve(); await Promise.resolve(); expect(view.state.doc.toString()).toBe("@new");
    await loaded(); insert.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); key("Enter");
    context.workspaceRef = { ...context.workspaceRef, expectedMaterializationEpoch: 2 }; finish("WRONG");
    await Promise.resolve(); await Promise.resolve(); expect(view.state.doc.toString()).toBe("@new");
  });

  it("shows a search error without swallowing ordinary input", async () => {
    search.mockRejectedValue(new Error("offline")); mount(); type("@");
    await vi.waitFor(() => expect(popup()?.textContent).toContain("资源搜索失败"));
    expect(key("Enter").defaultPrevented).toBe(true); // The normal editor keymap inserts a newline.
    expect(view.state.doc.toString()).toBe("@\n"); expect(popup()).toBeNull();
  });

  it("keeps page navigation in range for a short result list", async () => {
    search.mockResolvedValue([resource("A"), resource("B"), resource("C"), resource("D")]);
    mount(); type("@"); await vi.waitFor(() => expect(popup()?.querySelectorAll("button")).toHaveLength(4));
    key("PageUp"); expect(popup()?.querySelector('[aria-selected="true"]')?.textContent).toContain("A");
    key("PageDown"); expect(popup()?.querySelector('[aria-selected="true"]')?.textContent).toContain("D");
  });

  it("does not reopen after switching documents or destroying an editor with a pending search", async () => {
    let finish!: (items: MarkdownMentionResource[]) => void;
    search.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mount(); type("@"); await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    context = { ...context, key: "two" };
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "other document" } });
    finish([resource("Late")]); await Promise.resolve(); await Promise.resolve();
    expect(popup()).toBeNull(); expect(view.state.doc.toString()).toBe("other document");
    search.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    type(" @"); await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    view.destroy(); finish([resource("Late")]); await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector(".cm-mention-tooltip")).toBeNull();
  });
});
