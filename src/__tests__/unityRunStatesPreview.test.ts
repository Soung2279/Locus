
import { describe, expect, it } from "vitest";
import {
  buildUnityRunStatesRuntimePreview,
  parseUnityRunStatesArguments,
  parseUnityRunStatesOutput,
} from "../composables/unityRunStatesPreview";

describe("unityRunStatesPreview", () => {
  it("formats states into stable start update end phases", () => {
    const preview = parseUnityRunStatesArguments(JSON.stringify({
      request_editor_status: "playing",
      initial_state: "wait_player",
      states: [
        {
          name: "wait_player",
          variables: "int checks = 0;",
          start: "ctx.PromptUser(\"jump_debug\", \"press jump\");",
          update: "checks += 1;\nif (ready) { ctx.Goto(\"jump_once\"); return; }\nctx.Sleep(1);",
          end: "",
        },
        {
          name: "jump_once",
          variables: "int visits = 0;",
          update: "visits += 1; var hits = ctx.Global(\"hits\", 0); hits.Value += 1; ctx.Print($\"frame={ctx.TotalFrames},hits={hits.Value},visits={visits}\"); ctx.Done(\"ok\");",
        },
      ],
    }));

    expect(preview?.requestEditorStatus).toBe("playing");
    expect(preview?.initialState).toBe("wait_player");
    expect(preview?.states[0]?.isInitial).toBe(true);
    expect(preview?.states[0]?.phases.map((phase) => phase.key)).toEqual([
      "variables",
      "start",
      "update",
      "end",
    ]);
    expect(preview?.states[0]?.phases[0]?.code).toContain("int checks = 0;");
    expect(preview?.states[0]?.phases[2]?.code).toContain("if (ready) {");
    expect(preview?.states[0]?.phases[2]?.code).toContain("  ctx.Goto(\"jump_once\");");
    expect(preview?.states[0]?.phases[3]?.empty).toBe(true);
    expect(preview?.states[1]?.phases[0]?.code).toContain("int visits = 0;");
    expect(preview?.states[1]?.phases[2]?.code).toContain("ctx.Global(\"hits\", 0)");
  });

  it("parses run output into summary fields and prints", () => {
    const preview = parseUnityRunStatesOutput([
      "status: ok",
      "final_state: jump_once",
      "frames: 93",
      "duration_ms: 476",
      "message: done",
      "prints:",
      "frame,t,state,posY",
      "21,0.179,JumpAscending,0.213",
    ].join("\n"));

    expect(preview?.fields.map((field) => field.key)).toEqual([
      "status",
      "final_state",
      "frames",
      "duration_ms",
      "message",
    ]);
    expect(preview?.fields[1]?.label).toBe("final state");
    expect(preview?.prints).toContain("frame,t,state,posY");
  });

  it("does not present argument snippets as live runtime progress before output arrives", () => {
    const args = JSON.stringify({
      request_editor_status: "playing",
      initial_state: "wait_player",
      states: [
        {
          name: "wait_player",
          start: [
            "ctx.PromptUser(\"jump_debug\", \"press jump\");",
            "ctx.Print(\"ready for jump\");",
          ].join("\n"),
          update: "ctx.Goto(\"jump_once\");",
        },
        {
          name: "jump_once",
          update: "ctx.Print($\"frame={ctx.TotalFrames}\"); ctx.Done(\"ok\");",
        },
      ],
    });

    const running = buildUnityRunStatesRuntimePreview(args, undefined, "running");
    expect(running).toBeNull();

    const done = buildUnityRunStatesRuntimePreview(args, [
      "status: ok",
      "final_state: jump_once",
      "message: ok",
      "prints:",
      "frame=12",
    ].join("\n"), "done");
    expect(done?.currentState).toBe("jump_once");
    expect(done?.finalStatus).toBe("ok");
    expect(done?.finalMessage).toBe("ok");
    expect(done?.printText).toBe("frame=12");
    expect(done?.printCount).toBe(1);
    expect(done?.isFinal).toBe(true);
  });

  it("shows large print output metadata instead of static print hints", () => {
    const args = JSON.stringify({
      request_editor_status: "playing",
      initial_state: "sample",
      states: [
        {
          name: "sample",
          update: "ctx.Print(\"fallback\"); ctx.Done(\"ok\");",
        },
      ],
    });

    const preview = buildUnityRunStatesRuntimePreview(args, [
      "status: ok",
      "final_state: sample",
      "print_lines: 12000",
      "print_tokens_estimate: 100001",
      "print_output: too large",
      "result_file: F:\\Project\\Library\\Locus\\RunStates\\run-states.txt",
    ].join("\n"), "done");

    expect(preview?.printText).toContain("too large");
    expect(preview?.printText).toContain("12000 lines");
    expect(preview?.printText).toContain("run-states.txt");
    expect(preview?.printText).not.toContain("fallback");
    expect(preview?.printCount).toBe(12000);
  });
});
