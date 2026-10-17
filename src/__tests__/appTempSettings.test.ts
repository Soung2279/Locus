
import { describe, expect, it } from "vitest";
import { persistedOutputDisplay } from "../components/toolPersistedOutput";

describe("app temporary files settings", () => {
  it("renders deleted persisted tool outputs without raw wrapper text", () => {
    const parsed = persistedOutputDisplay(
      "<persisted-output-deleted>\nFull output file deleted: C:\\temp\\tool.txt\n</persisted-output-deleted>",
    );

    expect(parsed.kind).toBe("deleted");
    expect(parsed.path).toBe("C:\\temp\\tool.txt");
  });
});
