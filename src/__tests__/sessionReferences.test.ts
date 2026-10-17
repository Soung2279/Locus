// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { appendSessionReferences, extractSessionReferences, formatSessionReference, normalizeSessionReferences, parseSessionReferences, sessionIdFromReference } from "../composables/sessionReferences";
import { markdownEngine } from "../composables/markdownEngine";
import { sanitizeRenderedMarkdownHtml } from "../composables/markdownSanitize";
import { extractChatAssetRefs } from "../composables/chatAssetRefs";
import { mapSessionMentionResult } from "../components/chat/mentionSessionSearch";
import { rankMentionSearchResults } from "../components/chat/mentionSearchRanking";

describe("session references", () => {
  it("keeps duplicate titles separate by stable ID and searches only titles", () => {
    const entries = ["first", "second"].map((id) => mapSessionMentionResult({ id, title: "Shader 调试", archived: id === "second", updatedAt: 1 }));
    expect(rankMentionSearchResults(entries, "shader")).toEqual(entries);
    expect(rankMentionSearchResults(entries, "调试")).toEqual(entries);
    expect(rankMentionSearchResults(entries, "second")).toEqual([]);
    expect(entries[1]!.relPath).toBe("locus://session/second");
  });

  it("extracts links into attachments without losing surrounding text and serializes stable IDs on send", () => {
    const text = "参考 [旧会话](locus://session/session-1) 然后继续";
    expect(parseSessionReferences(text)).toEqual([
      { type: "text", value: "参考 " }, { type: "session", value: "旧会话", sessionId: "session-1" },
      { type: "text", value: " 然后继续" },
    ]);
    const extracted = extractSessionReferences(text);
    expect(extracted).toEqual({ text: "参考  然后继续", sessionRefs: [{ sessionId: "session-1", title: "旧会话" }] });
    expect(appendSessionReferences(extracted.text, extracted.sessionRefs))
      .toBe("参考  然后继续\n\n[旧会话](locus://session/session-1)");
    expect(appendSessionReferences("", extracted.sessionRefs)).toBe("[旧会话](locus://session/session-1)");
  });

  it("deduplicates by ID, retains renamed titles and rejects malformed clipboard data", () => {
    expect(normalizeSessionReferences([
      { sessionId: "s1", title: "Same title" }, { sessionId: "s2", title: "Same title" },
      { sessionId: "s1", title: "Renamed" }, null, { sessionId: "bad/id", title: "bad" },
    ])).toEqual([{ sessionId: "s1", title: "Renamed" }, { sessionId: "s2", title: "Same title" }]);
  });

  it("escapes arbitrary titles, preserves assets and renders a sanitized internal link", () => {
    const title = '<img src=x onerror=alert(1)> [test] `@Assets/A.cs` & *bold*';
    const markdown = formatSessionReference("session-1", title);
    expect(parseSessionReferences(markdown)).toEqual([{ type: "session", value: title, sessionId: "session-1" }]);
    expect(extractChatAssetRefs(markdown)).toEqual({ text: markdown, refs: [] });
    const root = document.createElement("div");
    root.innerHTML = sanitizeRenderedMarkdownHtml(markdownEngine.parse(markdown) as string);
    expect(root.querySelector("a")?.getAttribute("href")).toBe("#locus-session/session-1");
    expect(root.querySelector("a")?.textContent).toBe(title);
    expect(root.querySelector("img, script, strong, code")).toBeNull();
  });

  it("does not recognize malformed or external URLs as session references", () => {
    for (const value of ["locus://session/", "locus://session/../a", "locus://session/a?x=1", "https://example.com/a", "javascript:alert(1)"]) {
      expect(sessionIdFromReference(value)).toBeNull();
    }
    expect(() => formatSessionReference('a" onclick="oops', "test")).toThrow();
  });
});
