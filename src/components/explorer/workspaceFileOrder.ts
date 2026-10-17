import type { WorkspaceFilePlacement } from "../../services/workspaceFileOrder";
import type { WorkspaceTreeItem } from "./WorkspaceTree.vue";
import { workspaceFileParent } from "./workspaceFileMove";

export const workspaceFileOrderKey = (path: string) => `file:${path.replace(/\\/g, "/")}`;
export const workspaceNodeOrderKey = (nodeId: string) => `node:${nodeId}`;
export function workspaceOrderDirectory(key: string): string {
  return key.startsWith("file:") ? workspaceFileParent(key.slice(5)) : ".";
}

/** Unchanged siblings retain their natural order. Missing anchors stay dormant. */
export function applyWorkspaceFileOrder(base: string[], placements: WorkspaceFilePlacement[]): string[] {
  const present = new Set(base);
  const active = new Map(placements.filter(p => present.has(p.item) && present.has(p.anchor) && p.item !== p.anchor)
    .map(p => [p.item, p]));
  const before = new Map<string, string[]>(), after = new Map<string, string[]>();
  for (const p of active.values()) {
    const map = p.side === "before" ? before : after;
    map.set(p.anchor, [...(map.get(p.anchor) ?? []), p.item]);
  }
  const visited = new Set<string>(), visiting = new Set<string>(), result: string[] = [];
  function visit(key: string) {
    if (visited.has(key) || visiting.has(key)) return;
    visiting.add(key);
    for (const child of before.get(key) ?? []) visit(child);
    if (!visited.has(key)) { visited.add(key); result.push(key); }
    for (const child of after.get(key) ?? []) visit(child);
    visiting.delete(key);
  }
  for (const key of base) if (!active.has(key)) visit(key);
  // Also recover malformed cycles rather than losing rows.
  for (const key of base) visit(key);
  return result;
}

function longestUnchanged(base: string[], desired: string[], excluded: Set<string>): Set<string> {
  const positions = new Map(base.map((key, index) => [key, index]));
  const candidates = desired.filter(key => !excluded.has(key) && positions.has(key));
  const tails: number[] = [], previous: number[] = [];
  candidates.forEach((key, index) => {
    const value = positions.get(key)!;
    let low = 0, high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions.get(candidates[tails[middle]!]!)! < value) low = middle + 1;
      else high = middle;
    }
    previous[index] = low > 0 ? tails[low - 1]! : -1;
    tails[low] = index;
  });
  const stable = new Set<string>();
  for (let index = tails[tails.length - 1] ?? -1; index >= 0; index = previous[index]!) stable.add(candidates[index]!);
  return stable;
}

/** A longest unchanged subsequence yields the minimum number of stored items.
 * Prefer keeping the dragged item as the override when several minima exist. */
export function minimalWorkspaceFileOrder(base: string[], desired: string[], directory: string,
  moved: Set<string> = new Set()): WorkspaceFilePlacement[] {
  const longest = longestUnchanged(base, desired, new Set());
  const preferred = longestUnchanged(base, desired, moved);
  const stable = preferred.size === longest.size ? preferred : longest;
  const nextStable: Array<string | undefined> = [];
  let next: string | undefined;
  for (let index = desired.length - 1; index >= 0; index--) {
    if (stable.has(desired[index]!)) next = desired[index];
    nextStable[index] = next;
  }
  let last: string | undefined;
  return desired.flatMap((item, index) => {
    if (stable.has(item)) { last = item; return []; }
    const anchor = nextStable[index] ?? last;
    return anchor ? [{ directory, item, anchor, side: nextStable[index] ? "before" as const : "after" as const }] : [];
  });
}

/** Sort sibling blocks, carrying each expanded folder's descendants with it. */
export function orderWorkspaceFileRows<T extends WorkspaceTreeItem>(items: T[],
  placements: WorkspaceFilePlacement[], keyOf: (item: T) => string | null): T[] {
  if (!items.length) return [];
  const depth = items[0]!.treeRow?.depth ?? 0;
  const blocks: T[][] = [];
  for (const item of items) {
    if (!blocks.length || (item.treeRow?.depth ?? depth) <= depth) blocks.push([item]);
    else blocks[blocks.length - 1]!.push(item);
  }
  const keyed = new Map(blocks.flatMap(block => {
    const key = keyOf(block[0]!);
    return key ? [[key, block] as const] : [];
  }));
  const base = [...keyed.keys()];
  const directory = base[0] ? workspaceOrderDirectory(base[0]) : ".";
  const ordered = applyWorkspaceFileOrder(base, placements.filter(p => p.directory === directory));
  const sorted = ordered.map(key => keyed.get(key)!);
  // Paging rows remain at the end of their own directory.
  sorted.push(...blocks.filter(block => !keyOf(block[0]!)));
  return sorted.flatMap(block => [block[0]!, ...orderWorkspaceFileRows(block.slice(1), placements, keyOf)]);
}
