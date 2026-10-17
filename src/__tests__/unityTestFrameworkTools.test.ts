// @vitest-environment jsdom
import { createPinia } from "pinia";
import { createApp, nextTick } from "vue";
import { describe, expect, it } from "vitest";
import ToolCallBlock from "../components/ToolCallBlock.vue";

describe("Unity Test Framework tools", () => {
  it("hides empty optional filters from Unity Test tool details", async () => {
    const host = document.createElement("div");
    const app = createApp(ToolCallBlock, {
      toolCall: {
        id: "unity-test-list",
        name: "unity_test_list",
        arguments: JSON.stringify({
          mode: "edit|play",
          assemblies: [],
          tests: [],
          groups: [],
          categories: [],
          max_results: 500,
        }),
        status: "done",
        output: "Unity tests: mode=\"edit|play\" matched=0 shown=0 truncated=false\n└─ <empty>",
      },
    });
    app.use(createPinia());
    app.mount(host);
    host.querySelector<HTMLButtonElement>(".tool-call-header")?.click();
    await nextTick();

    const keys = [...host.querySelectorAll<HTMLElement>(".tool-arg-key")]
      .map((element) => element.textContent);
    expect(keys).toEqual(["mode", "max results"]);
    expect(host.querySelector(".tool-call-pre")?.textContent).toContain("└─ <empty>");

    app.unmount();
  });
});
