
import { describe, expect, it } from "vitest";
import { buildCodexQuotaSummary } from "../services/codexQuotaSummary";
import type { CodexRateLimitsResponse } from "../services/auth";

describe("session context usage", () => {
  it("normalizes the Codex primary and secondary remaining quota", () => {
    const response: CodexRateLimitsResponse = {
      fetchedAtMs: 1,
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 28.4,
          remainingPercent: 71.6,
          windowMinutes: 300,
        },
        secondary: {
          usedPercent: 110,
          remainingPercent: -10,
          windowMinutes: 10080,
        },
      },
      rateLimitsByLimitId: {},
    };

    expect(buildCodexQuotaSummary(response)).toEqual([
      {
        key: "primary",
        limitId: "codex",
        limitName: null,
        remainingPercent: 71.6,
        windowMinutes: 300,
      },
      {
        key: "secondary",
        limitId: "codex",
        limitName: null,
        remainingPercent: 0,
        windowMinutes: 10080,
      },
    ]);
  });
});
