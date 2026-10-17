// @vitest-environment jsdom
import { createPinia } from "pinia";
import { createApp, nextTick } from "vue";
import { describe, expect, it } from "vitest";
import ToolCallBlock from "../components/ToolCallBlock.vue";
import hljs from "../hljs";

describe("highlight theme", () => {
  it("overrides Markdown emphasis that can span numbered Skill output", () => {
    const highlighted = hljs.highlight([
      "1\t---",
      "2\tid: kd_01ea75c3-43c6-4ef7-a0bd-d509c6378eb8",
      "3\tinjectMode: excerpt",
    ].join("\n"), { language: "markdown" }).value;

    expect(highlighted).toContain('class="hljs-emphasis"');
  });

  it("renders numbered Markdown reads as stable plain text", async () => {
    const host = document.createElement("div");
    const app = createApp(ToolCallBlock, {
      toolCall: {
        id: "read-skill",
        name: "read",
        arguments: JSON.stringify({
          filePath: "Locus/knowledge/skill/ecs-action-authoring.md",
        }),
        status: "done",
        output: [
          "<content>",
          "1\t---",
          "2\tid: kd_01ea75c3-43c6-4ef7-a0bd-d509c6378eb8",
          "3\tinjectMode: excerpt",
          "</content>",
        ].join("\n"),
      },
    });
    app.use(createPinia());
    app.mount(host);
    host.querySelector<HTMLButtonElement>(".tool-call-header")?.click();
    await nextTick();

    const output = host.querySelector(".tool-call-pre");
    expect(output?.classList.contains("hljs")).toBe(false);
    expect(output?.textContent).toContain("kd_01ea75c3-43c6-4ef7-a0bd-d509c6378eb8");
    expect(output?.textContent).not.toContain("<content>");

    app.unmount();
  });
});
