/** Find rendered text across inline markup without rewriting Vue-owned DOM. */
export function documentSearchRanges(root: HTMLElement, query: string, textSelector?: string): Range[] {
  if (!query) return [];
  const nodes: Array<{ node: Text; from: number; to: number }> = [];
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
  let text = "";
  let block: Element | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    if (!parent || !node.data || parent.closest('script, style, textarea, button, [hidden], [aria-hidden="true"], [data-search-ignore]')) continue;
    if (textSelector && !parent.closest(textSelector)) continue;
    const nextBlock = parent.closest('p, li, h1, h2, h3, h4, h5, h6, tr, pre, .atv-text');
    if (nextBlock !== block && text) text += "\n";
    block = nextBlock;
    const from = text.length;
    text += node.data;
    nodes.push({ node, from, to: text.length });
  }
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const ranges: Range[] = [];
  let nodeIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const from = match.index;
    const to = from + match[0].length;
    while (nodes[nodeIndex] && nodes[nodeIndex]!.to <= from) nodeIndex += 1;
    const first = nodes[nodeIndex];
    let lastIndex = nodeIndex;
    while (nodes[lastIndex] && nodes[lastIndex]!.to < to) lastIndex += 1;
    const last = nodes[lastIndex];
    if (!first || !last || from < first.from || to > last.to) continue;
    const range = root.ownerDocument.createRange();
    range.setStart(first.node, from - first.from);
    range.setEnd(last.node, to - last.from);
    ranges.push(range);
  }
  return ranges;
}
