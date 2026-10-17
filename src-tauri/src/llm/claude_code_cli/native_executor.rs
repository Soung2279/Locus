//! Called by ToolRegistry only after the Agent's permission/path/plan/undo
//! checks. All nested operations retain the same checkout execution context.
use super::native_scope::NativeInvocation;
use crate::tool::{ToolExecutionContext, ToolRegistry, ToolResult};
use serde_json::{json, Value};

pub(crate) async fn execute(
    registry: &ToolRegistry,
    ctx: ToolExecutionContext,
    scope: NativeInvocation,
) -> ToolResult {
    let result = match scope.call.tool.as_str() {
        "Write" => write(registry, &ctx, &scope).await,
        "Glob" | "Grep" => search(&ctx, &scope).await,
        "TaskOutput" | "TaskStop" => task(&ctx, &scope).await,
        _ => {
            return ToolResult {
                output: "Unsupported native adapter".into(),
                is_error: true,
            }
        }
    };
    match result {
        Ok(value) => {
            scope.set_result(value.clone());
            ToolResult {
                output: value.to_string(),
                is_error: false,
            }
        }
        Err(output) => ToolResult {
            output,
            is_error: true,
        },
    }
}

async fn write(
    registry: &ToolRegistry,
    ctx: &ToolExecutionContext,
    scope: &NativeInvocation,
) -> Result<Value, String> {
    let input = &scope.call.input;
    let path = ctx.resolve_path(
        input["file_path"]
            .as_str()
            .ok_or("Write requires file_path")?,
    )?;
    let content = input["content"].as_str().ok_or("Write requires content")?;
    let original = match tokio::fs::read_to_string(&path).await {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    // Existing files go through Locus's atomic, conflict-checked edit handler.
    // Its explicit native replacement entry handles empty files as well.
    let result = if let Some(original) = &original {
        NativeInvocation::without(Box::pin(registry.execute_with_context(
            "edit",
            &json!({"filePath":path,
            "edits":[{"oldString":original,"newString":content,"replaceAll":false}]}),
            ctx.clone(),
        )))
        .await
    } else {
        NativeInvocation::without(Box::pin(registry.execute_with_context(
            "write",
            &json!({"filePath":path,"content":content}),
            ctx.clone(),
        )))
        .await
    };
    if result.is_error {
        return Err(result.output);
    }
    let actual = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(
        json!({"type":if original.is_some(){"update"}else{"create"},"filePath":path,
        "content":actual,"originalFile":original,"structuredPatch":[],"userModified":false}),
    )
}

async fn search(ctx: &ToolExecutionContext, scope: &NativeInvocation) -> Result<Value, String> {
    let input = scope.call.input.clone();
    let root = ctx.resolve_path(input.get("path").and_then(Value::as_str).unwrap_or("."))?;
    let is_glob = scope.call.tool == "Glob";
    tokio::task::spawn_blocking(move || search_sync(&root, &input, is_glob))
        .await
        .map_err(|e| e.to_string())?
}

fn search_sync(root: &str, input: &Value, is_glob: bool) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let pattern = input["pattern"].as_str().ok_or("Search requires pattern")?;
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(false)
        .follow_links(false)
        .git_ignore(true)
        .git_exclude(true);
    let glob = if is_glob {
        Some(pattern)
    } else {
        input["glob"].as_str()
    };
    if let Some(glob) = glob {
        let base = if std::path::Path::new(root).is_file() {
            std::path::Path::new(root).parent().unwrap()
        } else {
            std::path::Path::new(root)
        };
        let mut overrides = ignore::overrides::OverrideBuilder::new(base);
        overrides.add(glob).map_err(|e| e.to_string())?;
        builder.overrides(overrides.build().map_err(|e| e.to_string())?);
    }
    if let Some(kind) = input["type"].as_str() {
        let mut types = ignore::types::TypesBuilder::new();
        types.add_defaults();
        types.select(kind);
        builder.types(types.build().map_err(|e| e.to_string())?);
    }
    let regex = if is_glob {
        None
    } else {
        Some(
            regex::RegexBuilder::new(pattern)
                .case_insensitive(input["-i"].as_bool().unwrap_or(false))
                .multi_line(true)
                .dot_matches_new_line(input["multiline"].as_bool().unwrap_or(false))
                .build()
                .map_err(|e| e.to_string())?,
        )
    };
    let mode = input["output_mode"]
        .as_str()
        .unwrap_or("files_with_matches");
    if !is_glob && !["files_with_matches", "content", "count"].contains(&mode) {
        return Err("Invalid Grep output_mode".into());
    }
    let offset = input["offset"].as_u64().unwrap_or(0).min(1_000_000) as usize;
    let limit = input["head_limit"].as_u64().unwrap_or(200) as usize;
    let limit = if limit == 0 { 10000 } else { limit.min(10000) };
    let context = input["-C"].as_u64().or_else(|| input["context"].as_u64());
    let before = context
        .or_else(|| input["-B"].as_u64())
        .unwrap_or(0)
        .min(1000) as usize;
    let after = context
        .or_else(|| input["-A"].as_u64())
        .unwrap_or(0)
        .min(1000) as usize;
    let numbered = input["-n"].as_bool().unwrap_or(true);
    let mut filenames = Vec::new();
    let mut rows = Vec::new();
    let mut matches = 0usize;
    let mut scanned = 0usize;
    let mut paths = Vec::new();
    for entry in builder.build() {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_some_and(|t| t.is_file()) {
            paths.push(entry.into_path());
        }
        if paths.len() > 100000 {
            return Err("Search exceeded 100000 files; narrow the path or glob".into());
        }
    }
    paths.sort();
    for path in paths {
        if is_glob {
            filenames.push(path.to_string_lossy().into_owned());
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        if bytes.len() > 20 * 1024 * 1024 || bytes.contains(&0) {
            continue;
        }
        scanned += 1;
        let text = String::from_utf8_lossy(&bytes);
        let regex = regex.as_ref().unwrap();
        let spans: Vec<_> = regex.find_iter(&text).collect();
        if spans.is_empty() {
            continue;
        }
        let file = path.to_string_lossy().into_owned();
        filenames.push(file.clone());
        matches += spans.len();
        if mode == "count" {
            rows.push(format!("{file}:{}", spans.len()));
            continue;
        }
        if mode != "content" {
            continue;
        }
        let lines: Vec<_> = text.lines().collect();
        let mut selected = std::collections::BTreeSet::new();
        let mut matching = std::collections::HashSet::new();
        for m in spans {
            let first = text[..m.start()].bytes().filter(|b| *b == b'\n').count();
            let last = text[..m.end()].bytes().filter(|b| *b == b'\n').count();
            for line in first..=last {
                matching.insert(line);
            }
            for line in
                first.saturating_sub(before)..=(last + after).min(lines.len().saturating_sub(1))
            {
                selected.insert(line);
            }
        }
        for line in selected {
            if let Some(text) = lines.get(line) {
                let sep = if matching.contains(&line) { ":" } else { "-" };
                rows.push(if numbered {
                    format!("{file}{sep}{}{sep}{text}", line + 1)
                } else {
                    format!("{file}{sep}{text}")
                });
            }
        }
        if rows.len() > 100000 {
            return Err("Search output exceeded 100000 lines; narrow the query".into());
        }
    }
    if is_glob {
        let total = filenames.len();
        filenames.truncate(100);
        return Ok(
            json!({"durationMs":started.elapsed().as_millis(),"numFiles":filenames.len(),"filenames":filenames,
            "truncated":total>100,"totalMatches":total,"countIsComplete":true}),
        );
    }
    let total_files = filenames.len();
    let total_lines = rows.len();
    if mode == "files_with_matches" {
        filenames = filenames.into_iter().skip(offset).take(limit).collect();
    }
    let selected: Vec<_> = rows.into_iter().skip(offset).take(limit).collect();
    Ok(
        json!({"mode":mode,"numFiles":filenames.len(),"filenames":filenames,"content":selected.join("\n"),
        "numLines":selected.len(),"numMatches":matches,"totalFiles":total_files,"totalLines":total_lines,
        "appliedLimit":limit,"appliedOffset":offset,"scannedFiles":scanned}),
    )
}

async fn task(ctx: &ToolExecutionContext, scope: &NativeInvocation) -> Result<Value, String> {
    use tauri::Manager;
    let app = ctx
        .app_handle
        .as_ref()
        .ok_or("Background task control requires a Locus runtime")?;
    let manager = app.state::<std::sync::Arc<crate::async_tasks::AsyncTaskManager>>();
    let requested = scope.call.input["task_id"]
        .as_str()
        .ok_or("task_id is required")?;
    let id = requested.strip_prefix("locus:").unwrap_or(requested);
    let current = manager.get_session_task(&scope.session_id, id)?;
    if scope.call.tool == "TaskStop" {
        manager.cancel(&current.task_id)?;
        return Ok(
            json!({"message":"Cancellation requested","task_id":requested,"task_type":"local_bash"}),
        );
    }
    let block = scope.call.input["block"].as_bool().unwrap_or(true);
    let timeout = scope.call.input["timeout"]
        .as_u64()
        .unwrap_or(30000)
        .min(600000);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout);
    let mut snapshot = current;
    while block && !snapshot.status.is_terminal() && tokio::time::Instant::now() < deadline {
        let remaining = deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .as_millis() as u64;
        snapshot = manager.wait_task(&scope.session_id, id, remaining).await?;
    }
    let output = snapshot.output.clone().unwrap_or_default();
    let exit_code = output
        .strip_prefix("Exit code: ")
        .and_then(|s| s.lines().next())
        .and_then(|s| s.parse::<i32>().ok());
    Ok(
        json!({"retrieval_status":if snapshot.status.is_terminal(){"success"}else if block{"timeout"}else{"not_ready"},
        "task":{"task_id":requested,"task_type":"local_bash","status":snapshot.status,"description":snapshot.description,
        "output":output,"exitCode":exit_code}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn run(root: &std::path::Path, tool: &str, input: Value) -> (ToolResult, Value) {
        let call = super::super::native_tools::adapt("native_test", tool, &input).unwrap();
        let scope = NativeInvocation::new(call.clone(), "test_session".into());
        let registry = ToolRegistry::with_builtins();
        let result = scope
            .run(registry.execute_with_context(
                call.locus_name,
                &call.locus_input,
                ToolExecutionContext {
                    working_dir: Some(root.to_string_lossy().into_owned()),
                    ..Default::default()
                },
            ))
            .await;
        (result, scope.result().unwrap_or(Value::Null))
    }
    #[tokio::test]
    async fn write_creates_overwrites_and_handles_empty_existing_files() {
        let root = tempfile::tempdir().unwrap();
        for original in [None, Some("old\n"), Some("")] {
            let file = root
                .path()
                .join(format!("file-{}.txt", original.map(str::len).unwrap_or(99)));
            if let Some(text) = original {
                std::fs::write(&file, text).unwrap();
            }
            let (result, raw) = run(
                root.path(),
                "Write",
                json!({"file_path":file,"content":"new\n"}),
            )
            .await;
            assert!(!result.is_error, "{}", result.output);
            assert_eq!(
                std::fs::read_to_string(file).unwrap().replace("\r\n", "\n"),
                "new\n"
            );
            assert_eq!(
                raw["type"],
                if original.is_some() {
                    "update"
                } else {
                    "create"
                }
            );
        }
    }
    #[tokio::test]
    async fn native_search_supports_globs_case_context_count_and_pagination() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("sub")).unwrap();
        std::fs::write(
            root.path().join("sub/a.cs"),
            "first\nNeedle\nlast\nneedle\n",
        )
        .unwrap();
        std::fs::write(root.path().join("b.txt"), "needle\n").unwrap();
        let (_, glob) = run(root.path(), "Glob", json!({"pattern":"**/*.cs"})).await;
        assert_eq!(glob["numFiles"], 1);
        let (_, grep) = run(
            root.path(),
            "Grep",
            json!({"pattern":"needle","-i":true,"glob":"*.cs","output_mode":"content","-C":1}),
        )
        .await;
        assert_eq!(grep["numMatches"], 2);
        assert!(grep["content"].as_str().unwrap().contains("first"));
        let (_, count) = run(
            root.path(),
            "Grep",
            json!({"pattern":"needle","output_mode":"count","head_limit":1}),
        )
        .await;
        assert_eq!(count["numFiles"], 2);
        assert_eq!(count["numLines"], 1);
        let (bad, _) = run(root.path(), "Grep", json!({"pattern":"["})).await;
        assert!(bad.is_error);
    }
}
