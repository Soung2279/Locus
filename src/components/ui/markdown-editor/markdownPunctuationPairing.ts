import { EditorSelection, MapMode, Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { invertedEffects, isolateHistory } from "@codemirror/commands";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { canPairPunctuation, isPairingCharacter, punctuationContextLimit, punctuationPairs as pairs, resolvePunctuation } from "../../../utils/punctuationPairing";

interface Closing { position: number; text: string }
const addClosing = StateEffect.define<Closing>({
  map(value, changes) {
    const position = changes.mapPos(value.position, 1, MapMode.TrackDel);
    return position === null ? undefined : { ...value, position };
  },
});
const closings = StateField.define<readonly Closing[]>({
  create: () => [],
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.effects.some(effect => effect.is(addClosing))) return value;
    const next: Closing[] = [];
    for (const closing of value) {
      const position = transaction.changes.mapPos(closing.position, 1, MapMode.TrackDel);
      if (position !== null && transaction.newDoc.sliceString(position, position + 1) === closing.text) {
        next.push({ ...closing, position });
      }
    }
    for (const effect of transaction.effects) if (effect.is(addClosing)) next.push(effect.value);
    return next;
  },
});

function generatedClosing(state: EditorState, position: number, text: string): boolean {
  return state.field(closings).some(closing => closing.position === position && closing.text === text);
}

function canOpen(state: EditorState, from: number, to: number, text: string): boolean {
  return canPairPunctuation(text, state.sliceDoc(Math.max(0, from - 2), from), state.sliceDoc(to, to + 1), from !== to);
}

function resolveInput(state: EditorState, from: number, text: string): string {
  return isPairingCharacter(text)
    ? resolvePunctuation(text, state.sliceDoc(Math.max(0, from - punctuationContextLimit), from))
    : text;
}

interface Composition {
  from: number;
  to: number;
  original: string;
  startState: EditorState;
  startFrom: number;
  startTo: number;
  ended: boolean;
  text: string;
}

const pairingPlugin = ViewPlugin.fromClass(class {
  composition: Composition | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly view: EditorView) {}

  reset() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.composition = null;
  }

  start() {
    this.reset();
    const { state } = this.view;
    if (state.readOnly || state.selection.ranges.length !== 1) return;
    const { from, to } = state.selection.main;
    this.composition = {
      from, to, original: state.sliceDoc(from, to), startState: state,
      startFrom: from, startTo: to, ended: false, text: "",
    };
  }

  update(update: ViewUpdate) {
    for (const transaction of update.transactions) {
      const pending = this.composition;
      if (!pending) break;
      if (transaction.docChanged) {
        // Never pair pasted text, external updates, undo or commands.
        if (!transaction.isUserEvent("input.type")) { this.reset(); break; }
        let contained = true;
        transaction.changes.iterChangedRanges((from, to) => {
          if (from < pending.from || to > pending.to) contained = false;
        });
        if (!contained) { this.reset(); break; }
        pending.from = transaction.changes.mapPos(pending.from, -1);
        pending.to = transaction.changes.mapPos(pending.to, 1);
      } else if (transaction.isUserEvent("select")) {
        this.reset();
      }
    }
  }

  end(text: string) {
    if (!this.composition) return;
    this.composition.ended = true;
    this.composition.text = text;
    // CodeMirror flushes the final composition DOM changes in a microtask.
    // Only change the document after that flush, never during composition.
    this.timer = setTimeout(() => this.finish(), 0);
  }

  finish() {
    const pending = this.composition;
    this.reset();
    const { view } = this;
    const { state } = view;
    if (!pending?.ended || !view.hasFocus || view.compositionStarted || state.readOnly || state.selection.ranges.length !== 1) return;
    const { from, to, text } = pending;
    if (text.length !== 1 || state.sliceDoc(from, to) !== text || !state.selection.main.empty || state.selection.main.head !== to) return;
    if (generatedClosing(state, to, text)) {
      view.dispatch({
        changes: { from, to }, selection: { anchor: from + 1 },
        userEvent: "input.type.compose", annotations: isolateHistory.of("after"),
      });
    } else {
      const input = resolveInput(pending.startState, pending.startFrom, text);
      if (!canOpen(pending.startState, pending.startFrom, pending.startTo, input)) return;
      view.dispatch({
        changes: { from, to, insert: input + pending.original + pairs[input] },
        selection: EditorSelection.range(to, to + pending.original.length),
        effects: addClosing.of({ position: to + pending.original.length, text: pairs[input]! }),
        userEvent: "input.type.compose", annotations: isolateHistory.of("after"),
      });
    }
  }

  destroy() { this.reset(); }
}, {
  eventHandlers: {
    compositionstart() { this.start(); return false; },
    compositionend(event) { this.end(event.data); return false; },
    blur() { this.reset(); return false; },
  },
});

export function markdownPunctuationPairing(): Extension {
  return [
    closings,
    invertedEffects.of(transaction => !transaction.docChanged ? [] : transaction.startState.field(closings).filter(closing => {
      const position = transaction.changes.mapPos(closing.position, 1, MapMode.TrackDel);
      return position === null || transaction.newDoc.sliceString(position, position + 1) !== closing.text;
    }).map(closing => addClosing.of(closing))),
    pairingPlugin,
    EditorView.inputHandler.of((view, from, to, text) => {
      const { state } = view;
      if (state.readOnly || state.selection.ranges.length !== 1 || text.length !== 1
        || view.compositionStarted || view.plugin(pairingPlugin)?.composition) return false;
      const selection = state.selection.main;
      if (from !== selection.from || to !== selection.to) return false;
      if (from === to && generatedClosing(state, from, text)) {
        view.dispatch({ selection: { anchor: from + 1 }, userEvent: "select" });
        return true;
      }
      text = resolveInput(state, from, text);
      if (!canOpen(state, from, to, text)) return false;
      const selected = state.sliceDoc(from, to);
      view.dispatch({
        changes: { from, to, insert: text + selected + pairs[text] },
        selection: EditorSelection.range(from + 1, from + 1 + selected.length),
        effects: addClosing.of({ position: from + 1 + selected.length, text: pairs[text]! }),
        userEvent: "input.type", scrollIntoView: true,
      });
      return true;
    }),
    Prec.high(EditorView.domEventHandlers({
      keydown(event, view) {
        if (event.key !== "Backspace" || event.isComposing || view.compositionStarted
          || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
          || view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
        const { main } = view.state.selection;
        if (!main.empty || main.head === 0) return false;
        const close = pairs[view.state.sliceDoc(main.head - 1, main.head)];
        if (!close || !generatedClosing(view.state, main.head, close)) return false;
        view.dispatch({ changes: { from: main.head - 1, to: main.head + 1 }, selection: { anchor: main.head - 1 }, userEvent: "delete.backward", annotations: isolateHistory.of("full") });
        return true;
      },
    })),
  ];
}
