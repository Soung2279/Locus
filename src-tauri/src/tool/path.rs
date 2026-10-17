use std::path::{Component, Path, PathBuf};

/// Resolve caller-supplied filesystem paths without ever consulting the process
/// cwd. Locus's cwd belongs to the application, not to an agent's workspace.
pub(crate) fn resolve_workspace_path(
    working_dir: Option<&Path>,
    requested: &str,
) -> Result<PathBuf, String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Err("Path must not be empty".to_string());
    }
    let path = Path::new(requested);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    // Windows drive-relative (C:foo) and rooted-without-drive (\foo) paths
    // depend on ambient drive state and are not workspace-relative paths.
    if path.has_root() || matches!(path.components().next(), Some(Component::Prefix(_))) {
        return Err(format!(
            "Ambiguous path '{requested}': use a workspace-relative path or a fully absolute path"
        ));
    }
    let root = working_dir
        .filter(|root| root.is_absolute())
        .ok_or_else(|| {
            format!("Relative path '{requested}' requires an absolute workspace working directory")
        })?;
    if path == Path::new(".") {
        Ok(root.to_path_buf())
    } else {
        Ok(root.join(path))
    }
}

impl super::ToolExecutionContext {
    pub(crate) fn working_root(&self) -> Option<&Path> {
        self.execution
            .as_ref()
            .map(|execution| execution.root())
            .or_else(|| {
                self.working_dir
                    .as_deref()
                    .map(str::trim)
                    .filter(|root| !root.is_empty())
                    .map(Path::new)
            })
    }

    pub(crate) fn resolve_path(&self, requested: &str) -> Result<String, String> {
        resolve_workspace_path(self.working_root(), requested)
            .map(|path| path.to_string_lossy().into_owned())
    }
}

#[cfg(test)]
mod workspace_path_regression_tests {
    use super::*;

    #[test]
    fn relative_paths_always_use_the_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        for requested in [".", "./", "nested/file.txt", "../sibling/file.txt"] {
            assert_eq!(
                resolve_workspace_path(Some(workspace.path()), requested).unwrap(),
                workspace.path().join(requested)
            );
        }
        // Resolution must also work for write/patch destinations not created yet.
        assert!(
            !resolve_workspace_path(Some(workspace.path()), "new/file.txt")
                .unwrap()
                .exists()
        );
    }

    #[test]
    fn relative_paths_never_fall_back_to_process_cwd() {
        for root in [None, Some(Path::new("")), Some(Path::new("relative"))] {
            assert!(resolve_workspace_path(root, ".").is_err());
        }
        assert!(resolve_workspace_path(None, "").is_err());
        let external = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_workspace_path(None, &external.path().to_string_lossy()).unwrap(),
            external.path()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_do_not_depend_on_ambient_drive_state() {
        let root = Some(Path::new(r"D:\workspace"));
        for path in [r"C:relative.txt", r"\rooted.txt", "/rooted.txt"] {
            assert!(resolve_workspace_path(root, path).is_err(), "{path}");
        }
        for path in [r"C:\external\file.txt", r"\\server\share\file.txt"] {
            assert_eq!(resolve_workspace_path(root, path).unwrap(), Path::new(path));
        }
        assert_eq!(
            resolve_workspace_path(root, r".\nested\file.txt").unwrap(),
            Path::new(r"D:\workspace\.\nested\file.txt")
        );
    }

    #[test]
    fn checkout_context_takes_precedence_over_legacy_working_dir() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let identity =
            crate::workspace_service::identity::ProjectIdResolver::resolve(root.path()).unwrap();
        let runtime = crate::workspace_service::WorkspaceRuntime::new(identity, Vec::new(), 1);
        let execution = std::sync::Arc::new(crate::workspace_service::AgentExecutionContext::new(
            runtime,
            std::collections::HashMap::new(),
        ));
        let context = crate::tool::ToolExecutionContext {
            execution: Some(execution),
            working_dir: Some(other.path().to_string_lossy().into_owned()),
            ..Default::default()
        };
        let resolved = context.resolve_path("new/file.txt").unwrap();
        assert_eq!(Path::new(&resolved), root.path().join("new/file.txt"));
    }

    #[tokio::test]
    async fn filesystem_tools_reject_unscoped_relative_paths() {
        use serde_json::json;
        let registry = crate::tool::ToolRegistry::with_builtins();
        for (tool, args) in [
            ("grep", json!({"path":".", "pattern":"locus"})),
            ("list", json!({"path":"."})),
            ("read", json!({"filePath":"Cargo.toml"})),
            ("write", json!({"filePath":"unscoped.txt", "content":"bad"})),
            (
                "edit",
                json!({"filePath":"Cargo.toml", "oldString":"nope", "newString":"bad"}),
            ),
            (
                "apply_patch",
                json!({"patch":"*** Begin Patch\n*** Add File: unscoped.txt\n+bad\n*** End Patch"}),
            ),
            (
                "bash",
                json!({"workdir":".", "command":"echo unexpected", "readonly":true}),
            ),
            ("plugin_list", json!({"workingDir":"."})),
            ("plugin_install", json!({"path":"./plugin.zip"})),
            (
                "unity_recompile",
                json!({"project_path":".", "editor_status":"disconnected"}),
            ),
        ] {
            // Exercise implementations directly: callers beyond the agent loop
            // (SDK/MCP) must not rely on its argument injection for correctness.
            let result = (registry.get(tool).unwrap().execute)(args, Default::default()).await;
            assert!(result.is_error, "{tool}: {}", result.output);
            assert!(
                result
                    .output
                    .contains("requires an absolute workspace working directory"),
                "{tool}: {}",
                result.output
            );
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn code_tools_reject_ambient_drive_paths_before_accessing_services() {
        use serde_json::json;
        let root = tempfile::tempdir().unwrap();
        let identity =
            crate::workspace_service::identity::ProjectIdResolver::resolve(root.path()).unwrap();
        let runtime = crate::workspace_service::WorkspaceRuntime::new(identity, Vec::new(), 1);
        let context = crate::tool::ToolExecutionContext {
            execution: Some(std::sync::Arc::new(
                crate::workspace_service::AgentExecutionContext::new(
                    runtime,
                    std::collections::HashMap::new(),
                ),
            )),
            working_dir: Some(root.path().to_string_lossy().into_owned()),
            ..Default::default()
        };
        let registry = crate::tool::ToolRegistry::with_builtins();
        for (name, args) in [
            (
                "code_goto_definition",
                json!({"file_path":"C:script.cs", "symbol":"Test"}),
            ),
            (
                "code_find_references",
                json!({"file_path":"C:script.cs", "symbol":"Test"}),
            ),
            (
                "code_hover",
                json!({"file_path":"C:script.cs", "symbol":"Test"}),
            ),
            ("code_diagnostics", json!({"file_path":"C:script.cs"})),
            ("unity_code_usages", json!({"file_path":"C:script.cs"})),
            ("unity_hot_reload", json!({"paths":["C:script.cs"]})),
        ] {
            let result = (registry.get(name).unwrap().execute)(args, context.clone()).await;
            assert!(result.is_error, "{name}: {}", result.output);
            assert!(
                result.output.contains("Ambiguous path"),
                "{name}: {}",
                result.output
            );
        }
    }
}
