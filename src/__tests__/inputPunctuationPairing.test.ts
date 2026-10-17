// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentEditingSettings } from "../composables/useDocumentEditingSettings";
import { installInputPunctuationPairing } from "../services/inputPunctuationPairing";

const settings = useDocumentEditingSettings();
let uninstall: () => void;
let input: HTMLInputElement | HTMLTextAreaElement;
beforeEach(() => {
  vi.useFakeTimers();
  settings.setPunctuationPairing(true);
  uninstall = installInputPunctuationPairing();
});
afterEach(() => {
  uninstall(); settings.setPunctuationPairing(false);
  document.body.replaceChildren(); vi.useRealTimers();
});

function create(kind = "text", value = "", from = value.length, to = from) {
  input = kind === "textarea" ? document.createElement("textarea") : document.createElement("input");
  if (input instanceof HTMLInputElement) input.type = kind;
  document.body.append(input);
  input.value = value; input.focus();
  if (input.selectionStart !== null) input.setSelectionRange(from, to);
  return input;
}

function type(text: string, inputType = "insertText", cancelable = true) {
  const event = new InputEvent("beforeinput", { bubbles: true, cancelable, inputType, data: text });
  input.dispatchEvent(event);
  if (!event.defaultPrevented) {
    input.setRangeText(text, input.selectionStart!, input.selectionEnd!, "end");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: text }));
  }
}

function startComposition(text: string) {
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertCompositionText", data: text, isComposing: true }));
  input.setRangeText(text, input.selectionStart!, input.selectionEnd!, "end");
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: text, isComposing: true }));
}

async function endComposition(text: string) {
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
  await vi.advanceTimersByTimeAsync(1);
}

async function compose(text: string) { startComposition(text); await endComposition(text); }

describe("text field punctuation pairing", () => {
  it.each(["text", "search", "url", "tel", "textarea"])("pairs in dynamically mounted %s fields with the caret inside", (kind) => {
    create(kind); type("「");
    expect(input.value).toBe("「」");
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(1);
  });

  it.each([["(", ")"], ["[", "]"], ["{", "}"], ['"', '"'], ["'", "'"], ["（", "）"], ["【", "】"]])("pairs %s and skips its closing", (open, close) => {
    create(); type(open); type(close);
    expect(input.value).toBe(open + close);
    expect(input.selectionStart).toBe(2);
  });

  it("notifies component input handlers with the final text and caret", () => {
    create(); let observed: unknown;
    input.addEventListener("input", () => { observed = [input.value, input.selectionStart]; });
    type("「"); expect(observed).toEqual(["「」", 1]);
  });

  it("wraps selected text", () => {
    create("textarea", "文字", 0, 2); type("(");
    expect(input.value).toBe("(文字)");
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
  });

  it("leaves apostrophes in English words and ordinary typing unchanged", () => {
    create("text", "don"); type("'"); type("t");
    expect(input.value).toBe("don't");
    create("text", '"word'); type('"'); expect(input.value).toBe('"word"');
  });

  it.each([false, true])("supports alternating IME quotes around text (composition: %s)", async (composition) => {
    create();
    const insert = async (text: string) => composition ? compose(text) : type(text);
    await insert("「"); await insert("中文"); await insert("」");
    expect(input.value).toBe("「中文」");
    expect(input.selectionStart).toBe(4);
    await insert("」"); // IME state may be out of sync with this field.
    expect(input.value).toBe("「中文」「」");
    expect(input.selectionStart).toBe(5);
  });

  it.each(["」", "』", "”", "’"])("normalizes a lone closing %s to a new pair", async (close) => {
    const pairs: Record<string, string> = { "」": "「」", "』": "『』", "”": "“”", "’": "‘’" };
    create(); await compose(close);
    expect(input.value).toBe(pairs[close]); expect(input.selectionStart).toBe(1);
  });

  it.each([
    ["「前文", "「前文」"], ["「旧文」", "「旧文」「」"],
    ["「外「内」", "「外「内」」"], ["「上一行\n", "「上一行\n「」"],
    ["「" + "文".repeat(512), "「" + "文".repeat(512) + "「」"],
  ])("uses bounded, balanced context: %s", (before, expected) => {
    create("textarea", before); type("」"); expect(input.value).toBe(expected);
  });

  it("skips a known generated closing even in a long quoted paragraph", () => {
    create("textarea"); type("「"); type("文".repeat(1000)); type("」");
    expect(input.value).toBe("「" + "文".repeat(1000) + "」");
  });

  it("does not change an IME candidate or an already paired IME commit", async () => {
    create(); startComposition("「"); expect(input.value).toBe("「");
    await endComposition("「"); expect(input.value).toBe("「」");
    create(); await compose("「」"); expect(input.value).toBe("「」"); expect(input.selectionStart).toBe(2);
  });

  it("preserves selection wrapping after composition", async () => {
    create("text", "文字", 0, 2); await compose("「");
    expect(input.value).toBe("「文字」"); expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
  });

  it("waits for a final composition edit that arrives after compositionend", async () => {
    create();
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "「" }));
    input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertFromComposition", data: "「" }));
    input.setRangeText("「", 0, 0, "end");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromComposition", data: "「" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(input.value).toBe("「」"); expect(input.selectionStart).toBe(1);
  });

  it("handles non-cancelable input without duplicating the opening", () => {
    create(); type("「", "insertText", false); type("」", "insertText", false);
    expect(input.value).toBe("「」"); expect(input.selectionStart).toBe(2);
  });

  it("does not transform pasted text, and still tracks an enclosing pair", () => {
    create(); type("「"); type("文字", "insertFromPaste"); type("」");
    expect(input.value).toBe("「文字」");
    create(); type("」", "insertFromPaste"); expect(input.value).toBe("」");
  });

  it("tracks deletion inside an enclosing pair", () => {
    create(); type("「"); type("ab");
    input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "deleteContentBackward" }));
    input.setRangeText("", 2, 3, "end");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    type("」"); expect(input.value).toBe("「a」"); expect(input.selectionStart).toBe(3);
  });

  it("deletes nested empty pairs together", () => {
    create(); type("("); type("[");
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace" }));
    expect(input.value).toBe("()"); expect(input.selectionStart).toBe(1);
    type(")"); expect(input.value).toBe("()"); expect(input.selectionStart).toBe(2);
  });

  it("discards marks on programmatic replacement", () => {
    create(); type("("); input.value = "x)"; input.setSelectionRange(1, 1); type(")");
    expect(input.value).toBe("x))");
  });

  it("keeps field state separate across focus changes", () => {
    const first = create(); type("「");
    create(); type("」"); expect(input.value).toBe("「」");
    input = first; input.focus(); type("」"); expect(input.value).toBe("「」"); expect(input.selectionStart).toBe(2);
  });

  it("honors maxlength and numeric fields", () => {
    create(); input.maxLength = 1; type("「"); expect(input.value).toBe("「");
    create(); input.inputMode = "decimal"; type("("); expect(input.value).toBe("(");
  });

  it.each(["password", "number", "email"])("does not intercept %s fields", (kind) => {
    create(kind);
    const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "「" });
    input.dispatchEvent(event); expect(event.defaultPrevented).toBe(false); expect(input.value).toBe("");
  });

  it("excludes readonly, disabled, and CodeMirror inputs", () => {
    for (const mode of ["readOnly", "disabled", "codemirror"]) {
      create(); if (mode === "codemirror") input.classList.add("cm-editor"); else input[mode as "readOnly" | "disabled"] = true;
      const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "「" });
      input.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
    }
  });

  it("cancels delayed composition when disabled, blurred, or replaced", async () => {
    create(); startComposition("「"); settings.setPunctuationPairing(false); await endComposition("「"); expect(input.value).toBe("「");
    type("("); expect(input.value).toBe("「(");
    settings.setPunctuationPairing(true);
    create(); startComposition("「"); input.blur(); await endComposition("「"); expect(input.value).toBe("「");
    create(); startComposition("「"); input.value = "外部更新"; await endComposition("「"); expect(input.value).toBe("外部更新");
  });

  it("does not register multiple listeners and removes them on disposal", () => {
    expect(installInputPunctuationPairing()).toBe(uninstall);
    create(); type("「"); expect(input.value).toBe("「」");
    uninstall(); create(); type("「"); expect(input.value).toBe("「");
  });
});
