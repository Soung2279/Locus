// @vitest-environment jsdom
import { history, redo, undo } from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownPunctuationPairing } from "../components/ui/markdown-editor/markdownPunctuationPairing";

let view: EditorView;
const pairing = new Compartment();

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true, value: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
  });
});
afterEach(() => {
  view?.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function create(doc = "", from = doc.length, to = from, readOnly = false) {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc, selection: EditorSelection.range(from, to),
      extensions: [history(), EditorState.readOnly.of(readOnly), pairing.of(markdownPunctuationPairing())],
    }),
  });
  view.focus();
  return view;
}

function type(text: string) {
  const { from, to } = view.state.selection.main;
  const insert = () => view.state.update(view.state.replaceSelection(text), { userEvent: "input.type" });
  const handled = view.state.facet(EditorView.inputHandler).some(handler => handler(view, from, to, text, insert));
  if (!handled && !view.state.readOnly) view.dispatch(insert());
  return handled;
}

function compositionStart() {
  view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
}
function compositionText(text: string) {
  view.dispatch(view.state.update(view.state.replaceSelection(text), { userEvent: "input.type.compose.start" }));
}
async function compositionEnd(text: string) {
  view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
  await vi.advanceTimersByTimeAsync(1);
}

describe("document punctuation pairing", () => {
  it.each([
    ["「", "」"], ["『", "』"], ["“", "”"], ["‘", "’"], ["（", "）"],
    ["【", "】"], ["《", "》"], ["〈", "〉"], ["(", ")"], ["[", "]"], ["{", "}"], ['"', '"'], ["'", "'"],
  ])("pairs %s and places the caret inside", (open, close) => {
    create();
    expect(type(open)).toBe(true);
    expect(view.state.doc.toString()).toBe(open + close);
    expect(view.state.selection.main.head).toBe(1);
  });

  it("wraps selected text and keeps it selected", () => {
    create("文字", 0, 2);
    type('"');
    expect(view.state.doc.toString()).toBe('"文字"');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("文字");
  });

  it("does not pair English apostrophes inside words or a manually closed quote", () => {
    create("don");
    expect(type("'")).toBe(false);
    type("t");
    expect(view.state.doc.toString()).toBe("don't");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '"word' }, selection: { anchor: 5 } });
    expect(type('"')).toBe(false);
    expect(view.state.doc.toString()).toBe('"word"');
  });

  it("preserves nested pairs and skips only generated closing punctuation", () => {
    create();
    type("("); type("["); type("]"); type(")");
    expect(view.state.doc.toString()).toBe("([])");
    expect(view.state.selection.main.head).toBe(4);
    view.dispatch({ changes: { from: 4, insert: ")" }, selection: { anchor: 4 } });
    expect(type(")")).toBe(false);
    expect(view.state.doc.toString()).toBe("([])))");
  });

  it("deletes an empty generated pair together", () => {
    create(); type("「");
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe("");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("「」");
  });

  it("restores pairing behavior through undo and redo", () => {
    create(); type("「");
    expect(view.state.selection.main.head).toBe(1);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("");
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("「」");
    view.dispatch({ selection: { anchor: 1 } }); // CodeMirror redo places the caret after the insertion.
    expect(type("」")).toBe(true);
    expect(view.state.doc.toString()).toBe("「」");
  });

  it("waits until composition ends and undoes the entire pair in one step", async () => {
    create(); compositionStart(); compositionText("「");
    expect(view.state.doc.toString()).toBe("「");
    await compositionEnd("「");
    expect(view.state.doc.toString()).toBe("「」");
    expect(view.state.selection.main.head).toBe(1);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("");
  });

  it("handles a final DOM change arriving after compositionend", async () => {
    create(); compositionStart();
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "（" }));
    compositionText("（");
    await vi.advanceTimersByTimeAsync(1);
    expect(view.state.doc.toString()).toBe("（）");
  });

  it("does not duplicate a pair supplied by the IME or alter its caret", async () => {
    create(); compositionStart(); compositionText("「」");
    await compositionEnd("「」");
    expect(view.state.doc.toString()).toBe("「」");
    expect(view.state.selection.main.head).toBe(2);
    view.dispatch({ selection: { anchor: 1 } }); // IME's later ArrowLeft
    expect(view.state.selection.main.head).toBe(1);
  });

  it("skips a generated closing quote submitted by the IME", async () => {
    create(); type("「"); compositionStart(); compositionText("」");
    await compositionEnd("」");
    expect(view.state.doc.toString()).toBe("「」");
    expect(view.state.selection.main.head).toBe(2);
  });

  it("supports alternating IME quotes with intervening text and normalizes a stale closing quote", async () => {
    create();
    for (const text of ["「", "中文", "」", "」"]) {
      compositionStart(); compositionText(text); await compositionEnd(text);
    }
    expect(view.state.doc.toString()).toBe("「中文」「」");
    expect(view.state.selection.main.head).toBe(5);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("「中文」");
  });

  it.each([
    ["「文字", "「文字」"], ["「旧」", "「旧」「」"], ["「外「内」", "「外「内」」"],
    ["「前行\n", "「前行\n「」"], ["「" + "文".repeat(512), "「" + "文".repeat(512) + "「」"],
  ])("resolves closing quotes from bounded context: %s", (doc, expected) => {
    create(doc); type("」"); expect(view.state.doc.toString()).toBe(expected);
  });

  it("keeps generated closing tracking beyond the context scan limit", () => {
    create(); type("「"); type("文".repeat(1000)); type("」");
    expect(view.state.doc.toString()).toBe("「" + "文".repeat(1000) + "」");
  });

  it("wraps a selection after a one-character IME commit", async () => {
    create("文字", 0, 2); compositionStart(); compositionText("「");
    await compositionEnd("「");
    expect(view.state.doc.toString()).toBe("「文字」");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("文字");
  });

  it("leaves ordinary IME commits and cancelled composition alone", async () => {
    create(); compositionStart(); compositionText("中文");
    await compositionEnd("中文");
    expect(view.state.doc.toString()).toBe("中文");
    compositionStart(); await compositionEnd("");
    expect(view.state.doc.toString()).toBe("中文");
  });

  it("never pairs external document updates or pasted text", async () => {
    create(); compositionStart(); compositionText("「");
    view.dispatch({ changes: { from: 0, to: 1, insert: "（" }, selection: { anchor: 1 } });
    await compositionEnd("（");
    expect(view.state.doc.toString()).toBe("（");
    view.dispatch(view.state.update(view.state.replaceSelection("「"), { userEvent: "input.paste" }));
    expect(view.state.doc.toString()).toBe("（「");
  });

  it("cancels pending pairing immediately when switched off", async () => {
    create(); compositionStart(); compositionText("「");
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "「" }));
    view.dispatch({ effects: pairing.reconfigure([]) });
    await vi.advanceTimersByTimeAsync(1);
    expect(view.state.doc.toString()).toBe("「");
    expect(type("(")).toBe(false);
    expect(view.state.doc.toString()).toBe("「(");
  });

  it("does not modify read-only content", () => {
    create("", 0, 0, true);
    expect(type("「")).toBe(false);
    expect(view.state.doc.toString()).toBe("");
  });

  it("leaves multi-cursor typing to CodeMirror", () => {
    create("a\nb");
    view.dispatch({
      effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)),
    });
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]),
    });
    expect(type("「")).toBe(false);
    expect(view.state.doc.toString()).toBe("a「\nb「");
  });
});
