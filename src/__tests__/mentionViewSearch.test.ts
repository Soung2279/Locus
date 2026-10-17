import { describe, expect, it } from "vitest";
import { mapViewMentionResult } from "../components/chat/mentionViewSearch";
import { rankMentionSearchResults } from "../components/chat/mentionSearchRanking";
import type { ViewPackageSummary } from "../services/view";

function view(overrides: Partial<ViewPackageSummary> = {}): ViewPackageSummary {
  return {
    id: "combat", name: "战斗面板", apiVersion: "v0.3.0", version: "1.0.0",
    displayPath: "Tools/Combat", packageRelPath: "combat", icon: "Table",
    packageRoot: "C:/project/Locus/View/combat", manifestPath: "C:/project/Locus/View/combat/combat.vue",
    updatedAt: 0, capabilities: { unity: false }, requirements: { unityConnection: false },
    ...overrides,
  };
}

describe("View mention resources", () => {
  it("references the Vue source and matches name, display path and View type", () => {
    const entry = mapViewMentionResult(view(), "c:\\project\\");
    expect(entry).toMatchObject({
      relPath: "Locus/View/combat/combat.vue", name: "战斗面板", entryKind: "view", viewIcon: "Table",
      isDir: false, localFile: { path: "C:/project/Locus/View/combat/combat.vue", isDir: false, typeLabel: "View" },
    });
    for (const query of ["战斗", "Combat", "view", "VIEW"]) {
      expect(rankMentionSearchResults([entry], query)).toEqual([entry]);
    }
  });

  it("attaches legacy packages as directories without making them browse candidates", () => {
    const entry = mapViewMentionResult(view({ manifestPath: "C:/project/Locus/View/combat/view.json" }), "C:/project");
    expect(entry).toMatchObject({
      relPath: "Locus/View/combat", isDir: false,
      localFile: { path: "C:/project/Locus/View/combat", isDir: true },
    });
  });

  it("preserves actual plugin and temporary source paths outside the workspace", () => {
    const entry = mapViewMentionResult(view({
      manifestPath: "E:\\plugins\\combat\\combat.vue", source: "plugin",
    }), "C:/project");
    expect(entry.relPath).toBe("E:/plugins/combat/combat.vue");
    expect(entry.localFile?.path).toBe(entry.relPath);
  });

  it("deduplicates filesystem hits in favor of View metadata regardless of response order", () => {
    const entry = mapViewMentionResult(view(), "C:/project");
    const file = { ...entry, entryKind: "asset" as const, name: "combat.vue", matchScore: 1000 };
    expect(rankMentionSearchResults([file, entry], "combat")).toEqual([entry]);
    expect(rankMentionSearchResults([entry, file], "combat")).toEqual([entry]);
  });

  it.each(["tab", "tree"] as const)("keeps a %s source file's priority without hiding its View name", (source) => {
    const entry = mapViewMentionResult(view(), "C:/project");
    const file = { ...entry, entryKind: "asset" as const, name: "combat.vue", source };
    for (const entries of [[entry, file], [file, entry]]) {
      expect(rankMentionSearchResults(entries, "战斗")).toEqual([{ ...entry, source }]);
    }
  });
});
