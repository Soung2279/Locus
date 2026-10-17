// @vitest-environment jsdom
import { createApp, nextTick } from "vue";
import { describe, expect, it } from "vitest";
import UnityTestRunToolBlock from "../components/tool-block-overrides/UnityTestRunToolBlock.vue";
import { resolveToolBlockOverride } from "../components/tool-block-overrides/toolBlockOverrides";

import type { ToolCallDisplay } from "../types";

function mount(toolCall: ToolCallDisplay) {
  const host = document.createElement("div");
  const app = createApp(UnityTestRunToolBlock, { toolCall });
  app.mount(host);
  return { host, app };
}

const args = JSON.stringify({
  mode: "edit",
  assemblies: [],
  tests: [],
  groups: [],
  categories: ["Smoke"],
  result_detail: "failures",
});

describe("unityTestRunProgress", () => {
  it("routes unity_test_run to its progress-aware tool block", () => {
    expect(resolveToolBlockOverride("unity_test_run")).toBe(UnityTestRunToolBlock);
  });

  it("renders counted test progress as a progress bar", () => {
    const { host, app } = mount({
      id: "unity-test-run",
      name: "unity_test_run",
      arguments: args,
      status: "running",
      progress: {
        title: "Running Unity tests",
        info: "3/8 · 1 failed · PlayerTests.Jumps",
        progress: 0.375,
        state: "running",
      },
    });

    expect(host.querySelector(".unity-test-progress-title")?.textContent).toBe("Running Unity tests");
    expect(host.querySelector(".unity-test-progress-info")?.textContent).toBe("3/8 · 1 failed · PlayerTests.Jumps");
    expect(host.querySelector(".unity-test-progress-percent")?.textContent).toBe("38%");
    expect(host.querySelector<HTMLElement>(".unity-test-progress-fill")?.style.width).toBe("38%");
    expect(host.querySelector(".unity-tool-call-block")?.classList.contains("is-framed")).toBe(true);
    expect(host.querySelector(".tool-call-summary")?.textContent).not.toContain("Running Unity tests");

    app.unmount();
  });

  it("shows stages without a known ratio inline in the header", () => {
    const { host, app } = mount({
      id: "unity-test-run",
      name: "unity_test_run",
      arguments: args,
      status: "running",
      progress: {
        title: "Waiting for Unity Editor",
        info: "",
        progress: null,
        state: "running",
      },
    });

    expect(host.querySelector(".tool-call-summary")?.textContent).toBe("Waiting for Unity Editor");
    expect(host.querySelector(".tool-call-progress-line")).toBeNull();

    app.unmount();
  });

  it("drops stale progress and hides empty filters once the run finishes", async () => {
    const { host, app } = mount({
      id: "unity-test-run",
      name: "unity_test_run",
      arguments: args,
      status: "done",
      output: "Unity test run: status=passed total=8",
      progress: {
        title: "Running Unity tests",
        info: "8/8",
        progress: 1,
        state: "running",
      },
    });

    expect(host.querySelector(".tool-call-progress-line")).toBeNull();
    host.querySelector<HTMLButtonElement>(".tool-call-header")?.click();
    await nextTick();

    const keys = [...host.querySelectorAll<HTMLElement>(".tool-arg-key")].map((element) => element.textContent);
    expect(keys).toEqual(["mode", "categories", "result detail"]);
    expect(host.querySelector(".tool-call-pre")?.textContent).toContain("status=passed");

    app.unmount();
  });
});
