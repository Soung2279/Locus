
import { describe, expect, it } from "vitest";
import {
  formatUnityExecuteProgressPercent,
  parseUnityExecuteProgressOutput,
  UNITY_EXECUTE_PROGRESS_TAG,
} from "../composables/unityExecuteProgress";

function progressLine(payload: Record<string, unknown>) {
  return `<${UNITY_EXECUTE_PROGRESS_TAG}>${JSON.stringify(payload)}</${UNITY_EXECUTE_PROGRESS_TAG}>`;
}

describe("unityExecuteProgress", () => {
  it("extracts the latest progress event and hides progress markers from output", () => {
    const preview = parseUnityExecuteProgressOutput([
      "before",
      progressLine({
        active: true,
        title: "unity_execute async test",
        info: "Calculating primes... 825,000/2,500,000",
        progress: 0.33,
        revision: 8,
      }),
      "after",
      progressLine({
        active: true,
        title: "unity_execute async test",
        info: "Calculating primes... 1,250,000/2,500,000",
        progress: 0.5,
        revision: 9,
      }),
    ].join("\n"));

    expect(preview.displayOutput).toBe("before\nafter");
    expect(preview.progress?.title).toBe("unity_execute async test");
    expect(preview.progress?.info).toContain("1,250,000");
    expect(preview.progress?.revision).toBe(9);
    expect(preview.progress ? formatUnityExecuteProgressPercent(preview.progress) : "").toBe("50%");
  });

  it("clamps progress values for stable UI width and labels", () => {
    const preview = parseUnityExecuteProgressOutput(progressLine({
      active: true,
      title: "Scan",
      info: "Done",
      progress: 1.4,
      revision: 1,
    }));

    expect(preview.progress?.progress).toBe(1);
    expect(preview.progress ? formatUnityExecuteProgressPercent(preview.progress) : "").toBe("100%");
  });
});
