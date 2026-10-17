// @vitest-environment jsdom
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownLivePreview, type MarkdownLivePreviewOptions } from "../components/ui/markdown-editor/markdownLivePreview";
import { markdownEditorBaseExtensions } from "../components/ui/markdown-editor/codeMirrorMarkdownExtensions";

let view: EditorView;
beforeEach(() => {
  if (!Range.prototype.getClientRects) Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  if (!Range.prototype.getBoundingClientRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) });
});
afterEach(() => { view?.destroy(); document.body.replaceChildren(); });

function mount(doc: string, options: MarkdownLivePreviewOptions = {}, readOnly = false) {
  const parent = document.createElement("div");
  document.body.append(parent);
  view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [
    ...markdownEditorBaseExtensions(() => undefined),
    markdown({ extensions: GFM }), markdownLivePreview(options), EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
  ] }) });
  return view;
}

function click(element: Element) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

describe("document hyperlinks", () => {
  it("renders escaped mention labels as plain text and keeps the Markdown source intact", () => {
    const doc = String.raw`[005\_塞拉维亚教会国.md](005_%E5%A1%9E%E6%8B%89.md) [\[标题\]\*\_\~\|\<文档\> &amp; &#35; \\path](notes.md)`;
    mount(doc);
    expect(view.contentDOM.textContent).toBe("005_塞拉维亚教会国.md [标题]*_~|<文档> & # \\path");
    expect(view.dom.querySelector(".cm-live-link-icon")?.getAttribute("data-icon-kind")).toBe("markdown");
    expect(view.dom.querySelectorAll(".cm-live-link-icon")).toHaveLength(2);
    expect(view.state.doc.toString()).toBe(doc);
    view.focus();
    view.dispatch({ selection: { anchor: doc.indexOf("塞") } });
    expect(view.contentDOM.textContent).not.toContain("\\_");
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("preserves formatted labels and literal code backslashes", () => {
    mount(String.raw`[**说明** \_引用\_ ` + "`a\\b`" + "](doc.md)");
    expect(view.dom.querySelector(".cm-live-strong")?.textContent).toBe("说明");
    expect(view.contentDOM.textContent).toBe("说明 _引用_ a\\b");
  });

  it.each([
    ["../Assets/Player.cs", "csharp"], ["../Assets/Hero.prefab", "prefab"],
    ["../data%2Ecsv#sheet", "spreadsheet"], ["../README.MD", "markdown"],
    ["../docs/", "folder"], ["https://example.com/readme.md", null],
    ["//example.com/readme.md", null], ["mailto:dev@example.com", null], ["#标题", null],
  ])("reuses the file icon for %s", (href, kind) => {
    mount(`[引用](${href})`);
    expect(view.dom.querySelector(".cm-live-link-icon")?.getAttribute("data-icon-kind") ?? null).toBe(kind);
  });

  it.each([false, true])("opens the link by text, icon and keyboard (readOnly=%s)", readOnly => {
    const onLinkOpen = vi.fn(); const onEditTarget = vi.fn();
    mount("[文件](../docs/file.md)", { onLinkOpen, onEditTarget }, readOnly);
    const link = view.dom.querySelector<HTMLAnchorElement>("a.cm-live-link")!;
    expect(link.tabIndex).toBe(0);
    click(link);
    click(link.querySelector("svg path")!);
    link.focus();
    const key = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    link.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(onLinkOpen.mock.calls).toEqual([["../docs/file.md"], ["../docs/file.md"], ["../docs/file.md"]]);
    expect(onEditTarget).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("[文件](../docs/file.md)");
  });

  it("opens the destination editor on right click after surrounding text changes", () => {
    const onEditTarget = vi.fn(); const onLinkOpen = vi.fn();
    mount('[说明](doc.md "标题")', { onEditTarget, onLinkOpen });
    view.dispatch({ changes: { from: 0, insert: "前文 " } });
    const link = view.dom.querySelector(".cm-live-link")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    link.querySelector("svg")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onEditTarget).toHaveBeenCalledWith(expect.objectContaining({ from: 3, label: "说明", url: "doc.md", title: "标题" }));
    expect(onLinkOpen).not.toHaveBeenCalled();
  });

  it("lets Tab leave a focused link without indenting the document", () => {
    const doc = "[文件](doc.md)";
    mount(doc);
    const link = view.dom.querySelector<HTMLAnchorElement>(".cm-live-link")!;
    link.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("routes middle click through the app instead of navigating the WebView", () => {
    const onLinkOpen = vi.fn();
    mount("[文件](doc.md)", { onLinkOpen });
    const event = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    view.dom.querySelector(".cm-live-link")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onLinkOpen).toHaveBeenCalledWith("doc.md");
  });

  it("does not navigate while selecting link text", () => {
    const onLinkOpen = vi.fn();
    mount("[拖选文字](doc.md)", { onLinkOpen });
    const link = view.dom.querySelector(".cm-live-link")!;
    const range = document.createRange(); range.selectNodeContents(link);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    click(link);
    expect(onLinkOpen).not.toHaveBeenCalled();
  });

  it("never makes executable destinations into anchors", () => {
    mount("[无效](javascript:alert%281%29) [无效](data:text/html,hello)");
    expect(view.dom.querySelector("a")).toBeNull();
  });

  it("keeps source mode escaped and free of link decorations", () => {
    const mode = new Compartment();
    const doc = String.raw`[005\_文档.md](005_文档.md)`;
    const parent = document.createElement("div"); document.body.append(parent);
    view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [markdown(), mode.of(markdownLivePreview())] }) });
    view.dispatch({ effects: mode.reconfigure([]) });
    expect(view.contentDOM.textContent).toBe(doc);
    expect(view.dom.querySelector(".cm-live-link-icon")).toBeNull();
  });
});
