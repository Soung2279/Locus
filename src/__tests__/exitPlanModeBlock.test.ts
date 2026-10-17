// @vitest-environment jsdom
import { createPinia } from "pinia";
import { createApp, nextTick } from "vue";
import { describe, expect, it } from "vitest";
import { parseExitPlanModeBlock } from "../composables/exitPlanModeBlock";
import ExitPlanModeToolBlock from "../components/tool-block-overrides/ExitPlanModeToolBlock.vue";

const APPROVED_OUTPUT = [
  "User has approved your plan. You can now start coding. Start with updating your todo list if applicable.",
  "",
  "Your plan has been saved to: C:/Locus/data/plan/proj/12345678.md",
  "You can refer back to it if needed during implementation.",
  "",
  "## Approved Plan:",
  "## 修改范围",
  "",
  "- 保留 `ReadFromFields()`",
  "- 更新解析流程",
].join("\n");

describe("exit plan mode transcript block", () => {
  it("parses the four lifecycle states from status and output", () => {
    expect(parseExitPlanModeBlock({ status: "running" })).toEqual({ kind: "awaiting" });

    expect(parseExitPlanModeBlock({ status: "done", output: APPROVED_OUTPUT })).toEqual({
      kind: "approved",
      plan: "## 修改范围\n\n- 保留 `ReadFromFields()`\n- 更新解析流程",
    });

    expect(
      parseExitPlanModeBlock({
        status: "error",
        output:
          "The user rejected the plan and wants changes before implementation can begin. Stay in plan mode, address the feedback, update the plan file, then call exit_plan_mode again.\nUser feedback: 先别动数据库",
      }),
    ).toEqual({ kind: "rejected", feedback: "先别动数据库" });

    expect(
      parseExitPlanModeBlock({
        status: "error",
        output:
          "The user rejected the plan. Stay in plan mode; refine the plan file or ask clarifying questions before requesting approval again.",
      }),
    ).toEqual({ kind: "rejected", feedback: "" });

    expect(
      parseExitPlanModeBlock({
        status: "error",
        output: "You are not in plan mode. This tool is only for exiting plan mode after writing a plan.",
      }),
    ).toEqual({
      kind: "error",
      detail: "You are not in plan mode. This tool is only for exiting plan mode after writing a plan.",
    });
  });

  it("renders an approved plan as expanded Markdown in the transcript", async () => {
    const host = document.createElement("div");
    const app = createApp(ExitPlanModeToolBlock, {
      toolCall: {
        id: "tool-exit-plan",
        name: "exit_plan_mode",
        arguments: "{}",
        status: "done",
        output: APPROVED_OUTPUT,
      },
    });
    app.use(createPinia());
    app.mount(host);
    await nextTick();

    const content = host.querySelector(".exit-plan-content .markdown-body");
    expect(content?.querySelector("h2")?.textContent).toBe("修改范围");
    expect(content?.querySelectorAll("li")).toHaveLength(2);
    expect(content?.querySelector("code")?.textContent).toBe("ReadFromFields()");
    expect(content?.textContent).not.toContain("Approved Plan:");
    expect(host.textContent).not.toContain("User has approved your plan");

    app.unmount();
  });

  it("renders a rejected plan as a neutral state, not an error", async () => {
    const host = document.createElement("div");
    const app = createApp(ExitPlanModeToolBlock, {
      toolCall: {
        id: "tool-exit-plan",
        name: "exit_plan_mode",
        arguments: "{}",
        status: "error",
        output: `${"The user rejected the plan"} and wants changes before implementation can begin. Stay in plan mode, address the feedback, update the plan file, then call exit_plan_mode again.\nUser feedback: 分层太多了`,
      },
    });
    app.use(createPinia());
    app.mount(host);
    await nextTick();

    const icon = host.querySelector(".tool-call-icon");
    expect(icon?.classList.contains("error")).toBe(false);
    expect(icon?.classList.contains("check")).toBe(true);
    expect(host.querySelector(".exit-plan-tool-block")?.classList.contains("state-rejected")).toBe(true);

    app.unmount();
  });
});
