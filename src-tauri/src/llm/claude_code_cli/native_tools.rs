//! First native-tool adapters. These deliberately reject unsupported semantics
//! rather than silently performing a different operation or falling back to CLI.
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct NativeCall {
    pub id: String,
    pub tool: String,
    pub input: Value,
    pub locus_name: &'static str,
    pub locus_input: Value,
}

pub fn adapt(id: &str, tool: &str, input: &Value) -> Result<NativeCall, String> {
    if id.is_empty() || !input.is_object() {
        return Err("Native tool call requires an ID and object input".into());
    }
    let string = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{tool} requires {key}"))
    };
    let (locus_name, locus_input) = match tool {
        "Read" => {
            if input.get("pages").is_some() {
                return Err("PDF page reads are not adapted yet".into());
            }
            (
                "read",
                json!({"filePath":string("file_path")?,
                "offset":input.get("offset").cloned().unwrap_or(json!(1)),
                "limit":input.get("limit").cloned().unwrap_or(json!(2000))}),
            )
        }
        "Write" => (
            "write",
            json!({"filePath":string("file_path")?,"content":string("content")?}),
        ),
        "Edit" => {
            if string("old_string")?.is_empty() {
                return Err(
                    "Use Write to create a file; empty Edit replacements are not adapted yet"
                        .into(),
                );
            }
            (
                "edit",
                json!({"filePath":string("file_path")?,"edits":[{
                    "oldString":string("old_string")?,"newString":string("new_string")?,
                    "replaceAll":input.get("replace_all").and_then(Value::as_bool).unwrap_or(false)
                }]}),
            )
        }
        "Bash" => (
            "bash",
            json!({"command":string("command")?,
                "workdir":".","readonly":false,
                "async":if input["run_in_background"].as_bool().unwrap_or(false){"async"}else{"sync"},
                "description":input.get("description").cloned().unwrap_or(json!("")),
                "timeout":input.get("timeout").cloned().unwrap_or(json!(120000))}),
        ),
        "Glob" | "Grep" => {
            let mut args = input.clone();
            args["path"] = json!(input.get("path").and_then(Value::as_str).unwrap_or("."));
            let _ = string("pattern")?;
            (if tool == "Glob" { "list" } else { "grep" }, args)
        }
        "TaskOutput" | "TaskStop" => {
            let id = string("task_id")?;
            if id.is_empty() {
                return Err("Task ID is required".into());
            }
            let method = if tool == "TaskStop" {
                "cancel_task"
            } else {
                "get_task_status"
            };
            (
                "python",
                json!({"code":format!("await locus.{method}({})",json!(id.trim_start_matches("locus:"))),"readonly":true}),
            )
        }
        "AskUserQuestion" => {
            let questions = input["questions"]
                .as_array()
                .filter(|q| !q.is_empty())
                .ok_or("AskUserQuestion requires questions")?;
            for question in questions {
                if question["question"].as_str().unwrap_or_default().is_empty() {
                    return Err("Question text is required".into());
                }
                if question["kind"]
                    .as_str()
                    .is_some_and(|kind| kind != "select" && kind != "text")
                {
                    return Err(
                        "This question kind is not supported by the Locus question panel".into(),
                    );
                }
            }
            ("ask_user_question", questions[0].clone())
        }
        _ => {
            return Err(format!(
                "Native tool {tool} is not adapted for local execution"
            ))
        }
    };
    Ok(NativeCall {
        id: id.into(),
        tool: tool.into(),
        input: input.clone(),
        locus_name,
        locus_input,
    })
}

pub fn locus_name(name: &str) -> &str {
    match name {
        "Read" => "read",
        "Write" => "write",
        "Edit" => "edit",
        "Bash" => "bash",
        "Glob" => "list",
        "Grep" => "grep",
        "TaskOutput" | "TaskStop" => "python",
        "AskUserQuestion" => "ask_user_question",
        other => other,
    }
}

pub fn finish_result(
    call: &NativeCall,
    result: &super::ClaudeCodeToolResult,
    structured: Option<Value>,
) -> Value {
    if result.is_error || result.output == crate::session::history::INTERRUPTED_TOOL_RESULT {
        return json!({"callId":call.id,"deny":result.output});
    }
    if let Some(structured) = structured {
        return json!({"callId":call.id,"result":structured});
    }
    if call.tool == "Read" {
        if let Some(image) = result.images.as_ref().and_then(|images| images.first()) {
            let size = image.data.len() * 3 / 4
                - image.data.chars().rev().take_while(|c| *c == '=').count();
            return json!({"callId":call.id,"result":{"type":"image","file":{"base64":image.data,"type":image.mime_type,"originalSize":size}}});
        }
    }
    if call.tool == "Bash" && call.input["run_in_background"] == true {
        if let Some(id) = result
            .output
            .strip_prefix("Async task: id=")
            .and_then(|s| s.split_whitespace().next())
        {
            let id = serde_json::from_str::<String>(id).unwrap_or_else(|_| id.to_string());
            let code = format!("task = await locus.wait_task({}, timeout=30)\nprint(task.status, task.output)", json!(id));
            return json!({"callId":call.id,"result":{"stdout":"","stderr":"","interrupted":false,"backgroundTaskId":id},
                "context":[format!("This background task runs in Locus. Read its output with mcp__locus__python, readonly=true, code: {code}. Use locus.get_task_status with the same task ID for a nonblocking check, or native TaskStop to stop it. Task APIs are scoped to the current Locus session.")]});
        }
        // Immediate commands can finish during the background startup handshake.
    }
    finish(call, &result.output, false)
}

/// Claude's schema parser can fill optional defaults before firing the Mod.
/// Compare the actual Locus operation, not JSON spelling (e.g. replace_all=false).
pub fn same_operation(id: &str, tool: &str, observed: &Value, forwarded: &Value) -> bool {
    // These adapters consume fields outside the canonical Locus arguments.
    if matches!(tool, "TaskOutput" | "TaskStop" | "AskUserQuestion") {
        return observed.as_object().is_some_and(|fields| {
            fields
                .iter()
                .all(|(key, value)| forwarded.get(key) == Some(value))
        }) && forwarded.as_object().is_some_and(|fields| {
            fields.iter().all(|(key, value)| {
                observed.get(key) == Some(value)
                    || (tool == "TaskOutput"
                        && ((key == "block" && value == true)
                            || (key == "timeout" && value == 30000)))
            })
        });
    }
    match (adapt(id, tool, observed), adapt(id, tool, forwarded)) {
        (Ok(left), Ok(right)) => left.locus_input == right.locus_input,
        _ => observed == forwarded,
    }
}

/// Convert only the Locus result that passed its permission/execution pipeline.
/// Never re-read a path here: that could bypass scope checks or race the tool.
pub fn finish(call: &NativeCall, output: &str, is_error: bool) -> Value {
    let deny = |reason: &str| json!({"callId":call.id,"deny":reason});
    if is_error {
        return deny(output);
    }
    let result = match call.tool.as_str() {
        "Bash" => json!({"stdout":output,"stderr":"","interrupted":false,"isImage":false}),
        "Write" => json!({"type":"create","filePath":call.input["file_path"],
            "content":call.input["content"],"structuredPatch":[],"originalFile":null}),
        "Edit" => json!({"filePath":call.input["file_path"],"oldString":call.input["old_string"],
            "newString":call.input["new_string"],"originalFile":null,"structuredPatch":[],
            "userModified":false,"replaceAll":call.input.get("replace_all").and_then(Value::as_bool).unwrap_or(false)}),
        "Read" => {
            // Locus text reads frame each physical line as <number>\t<content>.
            // Only strip a sequential prefix, preserving tabs/numbers in content.
            let Some(body) = output
                .strip_prefix("<content>\n")
                .and_then(|s| s.strip_suffix("\n</content>"))
            else {
                return deny("This Read result is not an adapted text file (image/PDF/directory reads are not supported yet)");
            };
            let start = call
                .input
                .get("offset")
                .and_then(Value::as_u64)
                .unwrap_or(1);
            let mut lines = Vec::new();
            for line in body.lines() {
                let prefix = format!("{}\t", start + lines.len() as u64);
                if let Some(content) = line.strip_prefix(&prefix) {
                    lines.push(content);
                } else {
                    break;
                }
            }
            let summary = body.rsplit_once("\n\n").map(|(_, s)| s).unwrap_or(body);
            let total = summary
                .strip_prefix("(End of file — ")
                .and_then(|s| s.strip_suffix(" lines total)"))
                .and_then(|s| s.parse::<u64>().ok())
                .or_else(|| {
                    summary
                        .split_once(" of ")
                        .and_then(|(_, s)| s.split('.').next())
                        .and_then(|s| s.parse::<u64>().ok())
                });
            let Some(total) = total else {
                return deny("Read output was capped or unrecognized; retry with a smaller limit");
            };
            json!({"type":"text","file":{"filePath":call.input["file_path"],
                "content":lines.join("\n"),"numLines":lines.len(),"startLine":start,"totalLines":total}})
        }
        _ => return deny("Unsupported native result"),
    };
    let mut answer = json!({"callId":call.id,"result":result});
    // Writes may include Unity/import or knowledge metadata which the native
    // result schema cannot carry. Read/Bash already carry their whole output.
    if matches!(call.tool.as_str(), "Write" | "Edit") {
        answer["context"] = json!([output]);
    }
    answer
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_locus_output_never_becomes_a_successful_native_write() {
        let call = adapt("write-cancelled","Write",&json!({"file_path":"a","content":"new content"})).unwrap();
        let output = super::super::ClaudeCodeToolResult {
            output:crate::session::history::INTERRUPTED_TOOL_RESULT.into(),is_error:false,images:None,
        };
        let reply = finish_result(&call,&output,Some(json!({"type":"create"})));
        assert_eq!(reply["deny"],crate::session::history::INTERRUPTED_TOOL_RESULT);
        assert!(reply.get("result").is_none());
    }

    #[test]
    fn background_result_unquotes_locus_ids_and_accepts_local_task_control(){
        let call=adapt("b1","Bash",&json!({"command":"sleep 1","run_in_background":true})).unwrap();
        let output=super::super::ClaudeCodeToolResult{output:"Async task: id=\"t4\" status=queued notify=false".into(),is_error:false,images:None};
        let result = finish_result(&call,&output,None);
        assert_eq!(result["result"]["backgroundTaskId"],"t4");
        let context = result["context"][0].as_str().unwrap();
        assert!(context.contains("mcp__locus__python"));
        assert!(context.contains("readonly=true"));
        assert!(context.contains("await locus.wait_task(\"t4\", timeout=30)"));
        assert!(context.contains("print(task.status, task.output)"));
        assert!(adapt("s1","TaskStop",&json!({"task_id":"t4"})).is_ok());
        assert!(adapt("r1","TaskOutput",&json!({"task_id":"t4"})).is_ok());
    }
    #[test]
    fn edits_use_locus_atomic_batch_schema() {
        let call = adapt(
            "t1",
            "Edit",
            &json!({"file_path":"a.txt","old_string":"old","new_string":"new","replace_all":true}),
        )
        .unwrap();
        assert_eq!(call.locus_name, "edit");
        assert_eq!(call.locus_input["edits"][0]["replaceAll"], true);
        assert_eq!(
            finish(&call, "permission denied", true)["deny"],
            "permission denied"
        );
    }
    #[test]
    fn text_read_preserves_numbered_lines_and_tabs() {
        let call = adapt("t2", "Read", &json!({"file_path":"a.txt","offset":2})).unwrap();
        let answer = finish(
            &call,
            "<content>\n2\t1\tvalue\n3\t\n\n(End of file — 3 lines total)\n</content>",
            false,
        );
        assert_eq!(answer["result"]["file"]["content"], "1\tvalue\n");
        assert_eq!(answer["result"]["file"]["totalLines"], 3);
    }
    #[test]
    fn unsupported_semantics_never_reach_the_host() {
        assert!(adapt(
            "t",
            "Bash",
            &json!({"command":"echo ok","run_in_background":true})
        )
        .is_ok());
        assert!(adapt("t", "Read", &json!({"file_path":"a.pdf","pages":"1"})).is_err());
        assert!(adapt("t", "Unknown", &json!({})).is_err());
    }

    #[test]
    fn correlation_accepts_schema_defaults_but_not_changed_operations() {
        let original = json!({"file_path":"a","old_string":"a","new_string":"b"});
        let mut forwarded = original.clone();
        forwarded["replace_all"] = json!(false);
        assert!(same_operation("id", "Edit", &original, &forwarded));
        forwarded["new_string"] = json!("other");
        assert!(!same_operation("id", "Edit", &original, &forwarded));
    }
}
