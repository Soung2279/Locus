import { StateField, type EditorState, type Text } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { frontmatterRange, parseProperties, type FrontmatterRange } from "../../../document/markdownProperties";

export interface MarkdownFrontmatter { range: FrontmatterRange | null; yaml: string; invalid: boolean; decorations: DecorationSet }
const MAX_FRONTMATTER_LENGTH = 256_000;

function readFrontmatter(doc: Text): MarkdownFrontmatter {
  const empty: MarkdownFrontmatter = { range: null, yaml: "", invalid: false, decorations: Decoration.none };
  if (!/^\uFEFF?---[\t ]*$/.test(doc.line(1).text) || doc.lines === 1) return empty;
  let end = doc.line(1).to;
  for (let number = 2; number <= doc.lines; number++) {
    const line = doc.line(number);
    end = line.to;
    if (/^(?:---|\.\.\.)[\t ]*$/.test(line.text) || end > MAX_FRONTMATTER_LENGTH) break;
  }
  const source = doc.sliceString(0, end);
  const range = frontmatterRange(source);
  if (!range) return empty;
  const yaml = source.slice(range.yamlFrom, range.yamlTo);
  let invalid = !range.closed || end > MAX_FRONTMATTER_LENGTH;
  try { if (!invalid) parseProperties(yaml); } catch { invalid = true; }
  return { range, yaml, invalid, decorations: invalid ? Decoration.none : Decoration.set([
    Decoration.replace({ block: true }).range(range.from, range.to),
  ]) };
}

export const markdownFrontmatterField = StateField.define<MarkdownFrontmatter>({
  create: (state) => readFrontmatter(state.doc),
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    let touched = false;
    const limit = value.range?.to ?? transaction.startState.doc.line(1).to;
    transaction.changes.iterChangedRanges((from) => { if (from <= limit + 1) touched = true; });
    return touched ? readFrontmatter(transaction.state.doc) : value;
  },
});

export const markdownFrontmatterHiding = [
  EditorView.decorations.from(markdownFrontmatterField, (value) => value.decorations),
  EditorView.atomicRanges.of((view) => view.state.field(markdownFrontmatterField).decorations),
];

export function frontmatterEnd(state: EditorState): number {
  return state.field(markdownFrontmatterField, false)?.range?.to ?? 0;
}
