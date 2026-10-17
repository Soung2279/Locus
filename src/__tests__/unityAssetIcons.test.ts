
import { describe, expect, it } from "vitest";
import {
  UNITY_ASSET_ICON_FILE_EXTENSIONS,
  unityAssetIconClassForPath,
  unityAssetIconKindForPath,
  unityAssetIconNodeForPath,
} from "../components/icons/unityAssetIcons";

describe("Unity asset file format icons", () => {
  it("assigns distinct icon kinds to common code and document formats", () => {
    const cases = [
      ["Assets/Scripts/PlayerController.cs", "csharp"],
      ["skills/com.demo/scripts/extract_psd.py", "python"],
      ["skills/com.demo/skill.json", "json"],
      ["skills/com.demo/SKILL.md", "markdown"],
    ] as const;

    for (const [path, kind] of cases) {
      expect(unityAssetIconKindForPath(path, { isFolder: false })).toBe(kind);
    }

    const icons = cases.map(([path]) =>
      unityAssetIconNodeForPath(path, { isFolder: false }),
    );
    expect(new Set(icons).size).toBe(cases.length);
  });

  it("keeps extension classes available for shared file tree styling", () => {
    expect(unityAssetIconClassForPath("skill.json", { isFolder: false })).toContain(
      "unity-asset-icon--json",
    );
    expect(unityAssetIconClassForPath("SKILL.md", { isFolder: false })).toContain(
      "unity-asset-icon--markdown",
    );
    expect(UNITY_ASSET_ICON_FILE_EXTENSIONS).toEqual(
      expect.arrayContaining([".cs", ".py", ".json", ".md"]),
    );
  });
});
