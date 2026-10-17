// @vitest-environment jsdom
import { createApp, nextTick } from "vue";
import { describe, expect, it } from "vitest";
import KnowledgeQueryToolBlock from "../components/tool-block-overrides/KnowledgeQueryToolBlock.vue";

describe("knowledgeQueryProgress", () => {
  it("renders knowledge_query arguments with the standard key-value layout", async () => {
    const host = document.createElement("div");
    const app = createApp(KnowledgeQueryToolBlock, {
      toolCall: {
        id: "tool-knowledge-query",
        name: "knowledge_query",
        arguments: JSON.stringify({
          lexicalQuery: "memory preferences",
          limit: 5,
          includeSummary: false,
          includeHitContext: true,
        }),
        status: "done",
        output: "No results.",
      },
    });
    app.mount(host);
    host.querySelector<HTMLButtonElement>(".tool-call-header")?.click();
    await nextTick();

    const rows = [...host.querySelectorAll<HTMLElement>(".tool-arg-row")];
    expect(rows.map((row) => row.querySelector(".tool-arg-key")?.textContent)).toEqual([
      "lexical query",
      "limit",
      "include summary",
      "include hit context",
    ]);
    expect(rows.map((row) => row.querySelector(".tool-arg-value")?.textContent)).toEqual([
      "memory preferences",
      "5",
      "false",
      "true",
    ]);
    expect(host.querySelector(".tool-call-section:first-child .tool-call-pre")).toBeNull();

    app.unmount();
  });
});
