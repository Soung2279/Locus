// @vitest-environment jsdom
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownLivePreview } from "../components/ui/markdown-editor/markdownLivePreview";

let view: EditorView | null = null;

function mountLivePreview(doc: string, anchor = 0): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ extensions: GFM }), markdownLivePreview()],
    }),
  });
  return view;
}

beforeEach(() => {
  if (!(Range.prototype as Range & { getClientRects?: unknown }).getClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  }
  if (!(Range.prototype as Range & { getBoundingClientRect?: unknown }).getBoundingClientRect) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        width: 0,
        height: 0,
      }),
    });
  }
});

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
});

describe("markdown Live Preview", () => {
  it("decorates visible Markdown while retaining one EditorView DOM", () => {
    const mode = new Compartment();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc: [
        "intro",
        "",
        "# Heading",
        "",
        "**bold** and *italic* with ~~old~~ `code` and [docs](https://example.com)",
        "",
        "- [x] done",
        "1. ordered",
        "",
        "> quote",
        "",
        "---",
        "",
        "```ts",
        "const value = 1",
        "```",
      ].join("\n"),
      selection: { anchor: 0 },
      extensions: [
        markdown({ extensions: GFM }),
        mode.of(markdownLivePreview()),
      ],
    });

    view = new EditorView({ state, parent });
    const editorDom = view.dom;

    expect(editorDom.classList.contains("cm-live-preview")).toBe(true);
    expect(parent.querySelector(".cm-live-heading-1")).not.toBeNull();
    expect(parent.querySelector(".cm-live-strong")).not.toBeNull();
    expect(parent.querySelector(".cm-live-emphasis")).not.toBeNull();
    expect(parent.querySelector(".cm-live-strikethrough")).not.toBeNull();
    expect(parent.querySelector(".cm-live-inline-code")).not.toBeNull();
    expect(parent.querySelector(".cm-live-link")).not.toBeNull();
    expect(parent.querySelector(".cm-live-list-marker")).not.toBeNull();
    expect(parent.querySelector(".cm-live-task-checkbox")).not.toBeNull();
    expect(parent.querySelector(".cm-live-blockquote")).not.toBeNull();
    expect(parent.querySelector(".cm-live-horizontal-rule")).not.toBeNull();
    expect(parent.querySelector(".cm-live-fenced-code")).not.toBeNull();

    const checkbox = parent.querySelector<HTMLInputElement>(".cm-live-task-checkbox");
    checkbox?.dispatchEvent(new Event("change"));
    expect(view.state.doc.toString()).toContain("- [ ] done");

    view.dispatch({
      effects: mode.reconfigure(EditorView.editorAttributes.of({ class: "cm-source-mode" })),
      annotations: Transaction.addToHistory.of(false),
    });

    expect(view.dom).toBe(editorDom);
    expect(editorDom.classList.contains("cm-source-mode")).toBe(true);
    expect(parent.querySelectorAll(".cm-editor")).toHaveLength(1);
  });

  it.each([
    ["**", "strong"], ["__", "strong"], ["*", "emphasis"], ["_", "emphasis"],
    ["~~", "strikethrough"], ["`", "inline-code"], ["``", "inline-code"],
  ])("reveals paired %s markers only for the active formatted text", (marker, style) => {
    const doc = `plain ${marker}text${marker} and **other**`;
    const editor = mountLivePreview(doc);
    const from = doc.indexOf("text");
    expect(editor.contentDOM.textContent).toBe("plain text and other");

    editor.focus();
    editor.dispatch({ selection: { anchor: from + 2 } });
    expect(editor.contentDOM.textContent).toBe(`plain ${marker}text${marker} and other`);
    expect(editor.dom.querySelector(`.cm-live-${style}`)).not.toBeNull();
    expect(Array.from(editor.dom.querySelectorAll(".cm-live-syntax-marker"), el => el.textContent)).toEqual([marker, marker]);

    editor.dispatch({ selection: { anchor: from, head: from + 4 } });
    expect(editor.contentDOM.textContent).toBe(`plain ${marker}text${marker} and other`);

    editor.dispatch({ selection: { anchor: 1 } });
    expect(editor.contentDOM.textContent).toBe("plain text and other");
    expect(editor.dom.querySelector(".cm-live-syntax-marker")).toBeNull();
    expect(editor.state.doc.toString()).toBe(doc);
  });

  it("reveals both enclosing pairs for nested formatting", () => {
    const doc = "plain **bold *italic* text** and ~~other~~";
    const editor = mountLivePreview(doc);
    editor.focus();
    editor.dispatch({ selection: { anchor: doc.indexOf("italic") + 2 } });
    expect(editor.contentDOM.textContent).toBe("plain **bold *italic* text** and other");
    expect(Array.from(editor.dom.querySelectorAll(".cm-live-syntax-marker"), el => el.textContent)).toEqual(["**", "*", "*", "**"]);

    editor.dispatch({ selection: { anchor: doc.indexOf("bold") + 2 } });
    expect(editor.contentDOM.textContent).toBe("plain **bold italic text** and other");
  });

  it("reveals all inline pairs covered by a selection and hides them on blur or in read-only mode", async () => {
    const doc = "plain **bold** and *italic* with ~~old~~ `code`";
    const editor = mountLivePreview(doc);
    editor.focus();
    editor.dispatch({ selection: { anchor: 6, head: doc.length } });
    expect(editor.contentDOM.textContent).toBe(doc);

    editor.contentDOM.blur();
    await vi.waitFor(() => expect(editor.dom.querySelector(".cm-live-syntax-marker")).toBeNull());
    expect(editor.contentDOM.textContent).toBe("plain bold and italic with old code");

    editor.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    editor.focus();
    editor.dispatch({ selection: { anchor: 6, head: doc.length } });
    expect(editor.contentDOM.textContent).toBe("plain bold and italic with old code");
  });

  it("keeps list and task markers rendered while editing item text", () => {
    const doc = "- [ ] task text";
    const editor = mountLivePreview(doc);
    editor.focus();
    editor.dispatch({ selection: { anchor: doc.indexOf("task") + 2 } });

    expect(editor.dom.querySelector(".cm-live-list-marker")).not.toBeNull();
    expect(editor.dom.querySelector(".cm-live-task-checkbox")).not.toBeNull();
    expect(editor.contentDOM.textContent).not.toContain("-");
    expect(editor.contentDOM.textContent).not.toContain("[ ]");

    editor.dispatch({ selection: { anchor: 0 } });
    expect(editor.dom.querySelector(".cm-live-list-marker")).not.toBeNull();
    expect(editor.contentDOM.textContent).not.toContain("-");
    expect(editor.dom.querySelector(".cm-live-task-checkbox")).not.toBeNull();

    editor.dispatch({ selection: { anchor: 3 } });
    expect(editor.dom.querySelector(".cm-live-list-marker")).not.toBeNull();
    expect(editor.dom.querySelector(".cm-live-task-checkbox")).not.toBeNull();
    expect(editor.contentDOM.textContent).not.toContain("[ ]");
  });

  it.each([1, 2, 3, 4, 5, 6])("reveals the level %i heading prefix only while editing that heading", (level) => {
    const prefix = "#".repeat(level);
    const doc = `${prefix} Heading\n\n> quote`;
    const editor = mountLivePreview(doc);
    expect(editor.contentDOM.textContent).not.toContain("#");
    editor.focus();

    editor.dispatch({ selection: { anchor: doc.indexOf("Heading") + 2 } });
    expect(editor.contentDOM.textContent).toContain(`${prefix} Heading`);
    expect(editor.dom.querySelector(".cm-live-heading-marker")?.textContent).toBe(prefix);

    editor.dispatch({ selection: { anchor: doc.indexOf("Heading"), head: doc.indexOf("Heading") + 7 } });
    expect(editor.contentDOM.textContent).toContain(`${prefix} Heading`);

    editor.dispatch({ selection: { anchor: 1 } });
    expect(editor.contentDOM.textContent).toContain(`${prefix} Heading`);

    editor.dispatch({ selection: { anchor: doc.indexOf("quote") + 2 } });
    expect(editor.contentDOM.textContent).not.toContain(">");
    expect(editor.contentDOM.textContent).not.toContain("#");
    expect(editor.dom.querySelector(".cm-live-heading-marker")).toBeNull();

    editor.dispatch({ selection: { anchor: doc.indexOf(">") } });
    expect(editor.contentDOM.textContent).not.toContain("> quote");
    expect(editor.state.doc.toString()).toBe(doc);
  });

  it("updates the visible heading level without revealing optional closing marks", () => {
    const editor = mountLivePreview("## Heading ##");
    editor.focus();
    editor.dispatch({ selection: { anchor: 5 } });
    expect(editor.dom.querySelectorAll(".cm-live-heading-marker")).toHaveLength(1);
    expect(editor.contentDOM.textContent?.trim()).toBe("## Heading");

    editor.dispatch({ changes: { from: 0, insert: "#" } });
    expect(editor.dom.querySelector(".cm-live-heading-marker")?.textContent).toBe("###");
    expect(editor.dom.querySelector(".cm-live-heading-3")).not.toBeNull();

    editor.dispatch({ changes: { from: 0, to: 4 } });
    expect(editor.dom.querySelector(".cm-live-heading-marker")).toBeNull();
    expect(editor.dom.querySelector(".cm-live-heading")).toBeNull();
  });

  it("hides heading prefixes on blur and in read-only previews", async () => {
    const editor = mountLivePreview("## Heading", 5);
    editor.focus();
    await vi.waitFor(() => expect(editor.dom.querySelector(".cm-live-heading-marker")).not.toBeNull());

    editor.contentDOM.blur();
    await vi.waitFor(() => expect(editor.dom.querySelector(".cm-live-heading-marker")).toBeNull());

    editor.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    editor.focus();
    editor.dispatch({ selection: { anchor: 3, head: 10 } });
    expect(editor.hasFocus).toBe(true);
    expect(editor.contentDOM.textContent).not.toContain("#");
  });

  it("keeps link labels rendered when a selection lands in the destination", () => {
    const doc = "[label](target \"title\")";
    const editor = mountLivePreview(doc);
    editor.focus();

    editor.dispatch({ selection: { anchor: doc.indexOf("label") + 2 } });
    expect(editor.contentDOM.textContent).toBe("label");

    editor.dispatch({ selection: { anchor: doc.indexOf("target") + 2 } });
    expect(editor.contentDOM.textContent).toBe("label");

    editor.dispatch({ selection: { anchor: 0 } });
    expect(editor.contentDOM.textContent).toBe("label");
  });

  it("reveals inline code pairs while keeping fenced code delimiters local to the edited token", () => {
    const doc = [
      "`inline`",
      "",
      "```ts",
      "const value = 1",
      "```",
    ].join("\n");
    const editor = mountLivePreview(doc);
    editor.focus();

    editor.dispatch({ selection: { anchor: doc.indexOf("inline") + 2 } });
    expect(editor.contentDOM.textContent).toContain("`inline`");

    editor.dispatch({ selection: { anchor: 0 } });
    expect(editor.contentDOM.textContent).toContain("`inline`");

    editor.dispatch({ selection: { anchor: doc.indexOf("const") + 3 } });
    expect(editor.contentDOM.textContent).not.toContain("`inline`");
    expect(editor.contentDOM.textContent).not.toContain("```ts");

    editor.dispatch({ selection: { anchor: doc.indexOf("ts") + 1 } });
    expect(editor.contentDOM.textContent).toContain("```ts");
    expect(editor.contentDOM.textContent).not.toContain("```ts\nconst value = 1\n```");
  });
});
