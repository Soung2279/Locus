
import { describe, expect, it } from "vitest";
import { parseLegacyTodoWriteOutput, parseTodoWriteArguments } from "../composables/todoWrite";

describe("todowrite presentation", () => {
  it("normalizes tool arguments into displayable todos", () => {
    expect(parseTodoWriteArguments(JSON.stringify({
      todos: [
        { content: "done", status: "completed", priority: "high" },
        { content: "active", status: "in_progress" },
        { content: "invalid", status: "unknown", priority: "unknown" },
        { status: "pending" },
      ],
    }))).toEqual([
      { content: "done", status: "completed", priority: "high" },
      { content: "active", status: "in_progress", priority: "medium" },
      { content: "invalid", status: "pending", priority: "medium" },
    ]);
  });

  it("supports echoed results from older sessions", () => {
    expect(parseLegacyTodoWriteOutput([
      "1 todos (0 remaining)",
      '[{"content":"done","status":"completed","priority":"low"}]',
    ].join("\n"))).toEqual([
      { content: "done", status: "completed", priority: "low" },
    ]);
  });
});
