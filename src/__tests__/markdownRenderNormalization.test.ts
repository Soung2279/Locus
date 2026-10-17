
import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { normalizeMarkdownForRender } from "../composables/markdownRender";

describe("markdownRender normalization", () => {
  it("normalizes loose blockquotes before MarkdownRenderer parses them", () => {
    const markdown = [
      "> 受击打断",
      "",
      "> 强调动作游戏的主动反应",
      "",
      "> BOSS也应该对玩家的动作进行响应",
    ].join("\n");
    const html = new Marked({ breaks: true, gfm: true }).parse(
      normalizeMarkdownForRender(markdown),
    ) as string;
    expect(normalizeMarkdownForRender(markdown)).toBe([
      "> 受击打断",
      ">",
      "> 强调动作游戏的主动反应",
      ">",
      "> BOSS也应该对玩家的动作进行响应",
    ].join("\n"));
    expect(html).toBe([
      "<blockquote>",
      "<p>受击打断</p>",
      "<p>强调动作游戏的主动反应</p>",
      "<p>BOSS也应该对玩家的动作进行响应</p>",
      "</blockquote>",
      "",
    ].join("\n"));
  });

  it("adds a parsing boundary after punctuation-terminated bold labels", () => {
    const markdown = "> **特色：**强交互受击打断、高机动性（只有Top-Down能做）";
    const normalized = normalizeMarkdownForRender(markdown);
    const html = new Marked({ breaks: true, gfm: true }).parse(normalized) as string;

    expect(normalized).toBe("> **特色：** 强交互受击打断、高机动性（只有Top-Down能做）");
    expect(html).toContain("<strong>特色：</strong> 强交互受击打断、高机动性（只有Top-Down能做）");
  });
});
