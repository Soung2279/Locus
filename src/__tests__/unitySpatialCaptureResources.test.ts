import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Unity capture resource packaging", () => {
  it("ships valid Unity GUIDs so a clean plugin install imports the depth shader", () => {
    const metas = ["Editor/Resources.meta", "Editor/Resources/LocusCaptureDepth.shader.meta"];
    const guids = metas.map(path => {
      const text = readFileSync(resolve("locus_unity", path), "utf8");
      const guid = text.match(/^guid:\s*(\S+)/m)?.[1];
      expect(guid, path).toMatch(/^[0-9a-f]{32}$/);
      return guid;
    });
    expect(new Set(guids).size).toBe(guids.length);
    const shader = readFileSync(resolve("locus_unity/Editor/Resources/LocusCaptureDepth.shader"), "utf8");
    expect(shader).toContain('Shader "Hidden/Locus/CaptureDepth"');
  });
});
