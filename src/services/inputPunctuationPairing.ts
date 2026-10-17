import { watch } from "vue";
import { useDocumentEditingSettings } from "../composables/useDocumentEditingSettings";
import { canPairPunctuation, isPairingCharacter, punctuationContextLimit, punctuationPairs, resolvePunctuation } from "../utils/punctuationPairing";

type TextInput = HTMLInputElement | HTMLTextAreaElement;
interface Snapshot { value: string; from: number; to: number }
interface Closing { position: number; text: string }
interface FieldState { value: string; closings: Closing[] }
interface PendingInput { target: TextInput; before: Snapshot }
interface Composition extends PendingInput { text: string | null }

function textInput(target: EventTarget | null): TextInput | null {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
    || target.disabled || target.readOnly || target.closest(".cm-editor")
    || target.inputMode === "numeric" || target.inputMode === "decimal"
    || target instanceof HTMLInputElement && !["text", "search", "url", "tel"].includes(target.type)) return null;
  return target;
}

function snapshot(target: TextInput): Snapshot {
  return { value: target.value, from: target.selectionStart ?? 0, to: target.selectionEnd ?? 0 };
}

function replaced(before: Snapshot, text: string): string {
  return before.value.slice(0, before.from) + text + before.value.slice(before.to);
}

let uninstall: (() => void) | undefined;

/** Delegation also covers dynamically mounted dialogs and teleported inputs. */
export function installInputPunctuationPairing(): () => void {
  if (uninstall) return uninstall;
  const { state: settings } = useDocumentEditingSettings();
  let fields = new WeakMap<TextInput, FieldState>();
  let pending: PendingInput | null = null;
  let composition: Composition | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let editing: { target: TextInput; from: number; to: number } | null = null;

  function reset() {
    clearTimeout(timer);
    timer = undefined;
    pending = composition = null;
  }

  function field(target: TextInput): FieldState {
    let value = fields.get(target);
    // External v-model updates are not typing; discard stale auto-close marks.
    if (!value || value.value !== target.value) {
      value = { value: target.value, closings: [] };
      fields.set(target, value);
    }
    return value;
  }

  function record(target: TextInput, before: Snapshot, text: string, closing?: Closing) {
    const previous = fields.get(target);
    const value = target.value;
    const delta = text.length - (before.to - before.from);
    const closings = previous?.value === before.value ? previous.closings.flatMap(item => {
      if (item.position >= before.from && item.position < before.to) return [];
      const position = item.position < before.from ? item.position : item.position + delta;
      return value[position] === item.text ? [{ ...item, position }] : [];
    }) : [];
    if (closing) closings.push(closing);
    // Native text fields only need nearby marks. Long documents use CodeMirror.
    fields.set(target, { value, closings: closings.slice(-128) });
  }

  function generated(target: TextInput, at: number, text: string): boolean {
    return field(target).closings.some(item => item.position === at && item.text === text);
  }

  function edit(target: TextInput, from: number, to: number, text: string, start: number, end = start, closing?: Closing) {
    const before = { value: target.value, from, to };
    const expected = replaced(before, text);
    if (target.maxLength >= 0 && expected.length > target.maxLength) return false;
    editing = { target, from: start, to: end };
    try {
      target.setSelectionRange(from, to);
      // Chromium's native edit command preserves undo, unlike assigning value.
      // The nested input event reaches Vue with the final value and selection.
      target.ownerDocument.execCommand?.("insertText", false, text);
      if (target.value === before.value && target.value !== expected) {
        target.setRangeText(text, from, to, "end");
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
      target.setSelectionRange(start, end);
      if (target.value !== expected) { field(target); return false; }
      record(target, before, text, closing);
      return true;
    } finally {
      editing = null;
    }
  }

  function opening(before: Snapshot, text: string): string | null {
    if (!isPairingCharacter(text)) return null;
    const context = before.value.slice(Math.max(0, before.from - punctuationContextLimit), before.from);
    const resolved = resolvePunctuation(text, context);
    return canPairPunctuation(resolved, context, before.value.slice(before.to, before.to + 1), before.from !== before.to) ? resolved : null;
  }

  // Runs after an IME commit (or a non-cancelable native input), never while
  // candidate text is active. Both the actual edit and caret must still match.
  function finishInput(target: TextInput, before: Snapshot, text: string) {
    const caret = before.from + text.length;
    if (!settings.punctuationPairing || !textInput(target) || document.activeElement !== target
      || target.value !== replaced(before, text) || target.selectionStart !== caret || target.selectionEnd !== caret) {
      field(target); return;
    }
    record(target, before, text);
    if (text.length !== 1) return;
    if (before.from === before.to && generated(target, caret, text)) {
      edit(target, before.from, caret, "", before.from + 1);
      return;
    }
    const open = opening(before, text);
    if (!open) return;
    const selected = before.value.slice(before.from, before.to);
    const close = punctuationPairs[open];
    // Keep the original IME character when possible and append only the suffix.
    edit(target, open === text ? caret : before.from, caret,
      (open === text ? "" : open) + selected + close, caret, caret + selected.length,
      { position: caret + selected.length, text: close });
  }

  function finishComposition() {
    const current = composition;
    reset();
    if (current?.text != null) finishInput(current.target, current.before, current.text);
  }

  function beforeInput(event: Event) {
    const input = event as InputEvent;
    if (editing || !settings.punctuationPairing) return;
    const target = textInput(event.target);
    if (!target) return;
    if (input.isComposing || input.inputType?.includes("Composition")) return;
    if (composition?.text != null) finishComposition();
    if (composition) return;
    pending = null;
    // Ordinary typing in fields without auto-closes needs no text snapshot.
    if (!fields.get(target)?.closings.length && (input.inputType !== "insertText" || !isPairingCharacter(input.data ?? ""))) return;
    field(target);
    const before = snapshot(target);
    pending = { target, before };
    if (input.defaultPrevented || !input.cancelable || input.inputType !== "insertText" || input.data?.length !== 1) return;
    const text = input.data;
    if (before.from === before.to && generated(target, before.from, text)) {
      input.preventDefault(); pending = null;
      target.setSelectionRange(before.from + 1, before.from + 1);
      return;
    }
    const open = opening(before, text);
    if (!open) return;
    const selected = before.value.slice(before.from, before.to);
    const insert = open + selected + punctuationPairs[open];
    if (target.maxLength >= 0 && replaced(before, insert).length > target.maxLength) return;
    input.preventDefault(); pending = null;
    edit(target, before.from, before.to, insert, before.from + 1, before.from + 1 + selected.length,
      { position: before.from + 1 + selected.length, text: punctuationPairs[open] });
  }

  function onInput(event: Event) {
    if (editing) {
      if (event.target === editing.target) editing.target.setSelectionRange(editing.from, editing.to);
      return;
    }
    if (!settings.punctuationPairing) return;
    const target = textInput(event.target);
    if (!target || composition || (event as InputEvent).isComposing) return;
    const previous = pending;
    pending = null;
    const input = event as InputEvent;
    if (previous?.target === target) {
      const { before } = previous;
      if (input.inputType === "insertText" && input.data != null) {
        finishInput(target, before, input.data);
      } else {
        // Paste, deletion and other edits only move existing marks, never pair.
        if (before.from === before.to && input.inputType?.startsWith("delete")) {
          before.from = Math.min(before.from, target.selectionStart ?? before.from);
          before.to = before.from + before.value.length - target.value.length;
        }
        const length = target.value.length - before.value.length + before.to - before.from;
        const text = target.value.slice(before.from, before.from + length);
        if (length >= 0 && target.value === replaced(before, text)) record(target, before, text);
        else field(target);
      }
    } else if (fields.get(target)?.closings.length) field(target);
  }

  function startComposition(event: Event) {
    if (!settings.punctuationPairing || editing) return;
    const target = textInput(event.target);
    if (!target) return;
    if (composition?.text != null) finishComposition();
    reset(); field(target);
    composition = { target, before: snapshot(target), text: null };
  }

  function endComposition(event: Event) {
    if (composition?.target !== event.target) return;
    composition.text = (event as CompositionEvent).data;
    // Vue clears its own composing flag in the target's compositionend handler.
    // Allow that handler and Chromium's last input event to finish first.
    timer = setTimeout(finishComposition, 0);
  }

  function keydown(event: Event) {
    const key = event as KeyboardEvent;
    if (!settings.punctuationPairing || composition || key.defaultPrevented || key.key !== "Backspace"
      || key.isComposing || key.keyCode === 229 || key.ctrlKey || key.metaKey || key.altKey || key.shiftKey) return;
    const target = textInput(event.target);
    if (!target) return;
    const { from, to, value } = snapshot(target);
    const close = punctuationPairs[value[from - 1]];
    if (from !== to || !close || !generated(target, from, close)) return;
    key.preventDefault(); pending = null;
    edit(target, from - 1, from + 1, "", from - 1);
  }

  const listeners: [string, EventListener][] = [
    ["beforeinput", beforeInput], ["input", onInput], ["compositionstart", startComposition],
    ["compositionend", endComposition], ["keydown", keydown], ["focusout", reset],
  ];
  for (const [name, listener] of listeners) document.addEventListener(name, listener, true);
  const stop = watch(() => settings.punctuationPairing, () => { reset(); fields = new WeakMap(); }, { flush: "sync" });
  uninstall = () => {
    reset(); stop();
    for (const [name, listener] of listeners) document.removeEventListener(name, listener, true);
    uninstall = undefined;
  };
  return uninstall;
}

if (import.meta.hot) import.meta.hot.dispose(() => uninstall?.());
