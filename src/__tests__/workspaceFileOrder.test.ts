import { describe, expect, it } from "vitest";
import { applyWorkspaceFileOrder, minimalWorkspaceFileOrder, orderWorkspaceFileRows } from "../components/explorer/workspaceFileOrder";
import type { WorkspaceFilePlacement } from "../services/workspaceFileOrder";
import type { WorkspaceTreeItem } from "../components/explorer/WorkspaceTree.vue";

const base = ["node:new", "node:sessions", "file:Assets", "file:a.md", "file:b.md", "file:c.md"];
function move(current: string[], item: string, anchor: string, side = "before") {
  const desired = current.filter(key => key !== item);
  desired.splice(desired.indexOf(anchor) + (side === "after" ? 1 : 0), 0, item);
  return desired;
}

describe("sparse workspace file ordering", () => {
  it("stores one dragged relationship and restores mixed system, folder and file order", () => {
    const desired = move(base, "file:c.md", "node:sessions");
    const saved = minimalWorkspaceFileOrder(base, desired, ".", new Set(["file:c.md"]));
    expect(saved).toEqual([{ directory: ".", item: "file:c.md", anchor: "node:sessions", side: "before" }]);
    expect(applyWorkspaceFileOrder(base, JSON.parse(JSON.stringify(saved)))).toEqual(desired);
    expect(applyWorkspaceFileOrder([...base, "file:d.md"], saved)).toEqual([...desired, "file:d.md"]);
  });

  it("keeps previous moves when an anchor is dragged again and removes overrides after restoring defaults", () => {
    let current = base;
    for (const [item, anchor, side] of [["file:c.md", "file:a.md", "before"],
      ["file:b.md", "file:c.md", "before"], ["file:c.md", "file:Assets", "after"]]) {
      current = move(current, item!, anchor!, side);
      const saved = minimalWorkspaceFileOrder(base, current, ".", new Set([item!]));
      expect(applyWorkspaceFileOrder(base, saved)).toEqual(current);
    }
    expect(current).toEqual(["node:new", "node:sessions", "file:Assets", "file:c.md", "file:b.md", "file:a.md"]);
    expect(minimalWorkspaceFileOrder(base, base, ".")).toEqual([]);
  });

  it("handles missing anchors, paging and repeated rendering without mutating metadata", () => {
    const saved: WorkspaceFilePlacement[] = [{ directory: ".", item: "file:c.md", anchor: "file:a.md", side: "before" }];
    expect(applyWorkspaceFileOrder(base.filter(key => key !== "file:a.md"), saved)).toEqual(base.filter(key => key !== "file:a.md"));
    expect(applyWorkspaceFileOrder(base, saved)).toEqual(move(base, "file:c.md", "file:a.md"));
    expect(saved).toEqual([{ directory: ".", item: "file:c.md", anchor: "file:a.md", side: "before" }]);
  });

  it("carries expanded descendants with their folders and orders nested siblings independently", () => {
    const row = (key: string, depth: number): WorkspaceTreeItem => ({ key, treeRow: { key, name: key, depth, kind: "file" } });
    const rows = [row("node:sessions", 0), row("file:Assets", 0), row("file:Assets/Sub", 1),
      row("file:Assets/Sub/a", 2), row("file:Assets/a", 1), row("file:Assets/z", 1), row("more", 1), row("file:a.md", 0)];
    const saved: WorkspaceFilePlacement[] = [
      { directory: ".", item: "file:a.md", anchor: "file:Assets", side: "before" },
      { directory: "Assets", item: "file:Assets/z", anchor: "file:Assets/Sub", side: "before" },
    ];
    const sorted = orderWorkspaceFileRows(rows, saved, item => item.key === "more" ? null : item.key);
    expect(sorted.map(row => row.key)).toEqual(["node:sessions", "file:a.md", "file:Assets", "file:Assets/z",
      "file:Assets/Sub", "file:Assets/Sub/a", "file:Assets/a", "more"]);
    expect(rows[1]!.key).toBe("file:Assets");
  });

  it("roundtrips all permutations with the fewest overridden entries", () => {
    function permutations(values: string[]): string[][] {
      return values.length ? values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest])) : [[]];
    }
    const keys = base.slice(0, 5);
    for (const desired of permutations(keys)) {
      const saved = minimalWorkspaceFileOrder(keys, desired, ".");
      expect(applyWorkspaceFileOrder(keys, saved)).toEqual(desired);
      // Independently count the largest naturally ordered subset of this small fixture.
      const naturalSubsets = Array.from({ length: 1 << keys.length }, (_, mask) => keys.filter((_, index) => mask & (1 << index)));
      const longest = Math.max(...naturalSubsets.filter(subset => {
        const kept = desired.filter(key => subset.includes(key));
        return kept.join() === subset.join();
      }).map(subset => subset.length));
      expect(saved).toHaveLength(keys.length - longest);
    }
  });
});
