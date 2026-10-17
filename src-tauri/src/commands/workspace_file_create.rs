use super::*;
use std::io::Write;
use tauri::Manager;

fn create_error(error: impl ToString) -> AppError {
    AppError::new("workspace.file_create_failed", error.to_string())
}

fn document_path(root: &Path, directory: &str, name: &str) -> Result<PathBuf, AppError> {
    let relative = super::super::workspace::normalize_workspace_sub_path(directory)?;
    let root = dunce::canonicalize(root).map_err(create_error)?;
    let parent = dunce::canonicalize(root.join(relative)).map_err(create_error)?;
    if !parent.is_dir() || !parent.starts_with(&root) {
        return Err(create_error("The destination must be a folder within this workspace"));
    }
    let relative = parent.strip_prefix(&root).map_err(create_error)?.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    if relative == ".git" || relative.starts_with(".git/")
        || relative == ".locus" || relative.starts_with(".locus/")
        || relative == "locus/workspace-trees" || relative.starts_with("locus/workspace-trees/") {
        return Err(create_error("Documents cannot be created in workspace configuration folders"));
    }
    let path = super::explorer_file_actions::sibling_file(&parent.join("document"), name)?;
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(extension.as_str(), "md" | "markdown" | "csv") {
        return Err(create_error("A Markdown document or CSV table is required"));
    }
    for suffix in ["", ".meta", ".view", ".view.meta"] {
        if std::fs::symlink_metadata(format!("{}{suffix}", path.to_string_lossy())).is_ok() {
            return Err(create_error(format!("Target already exists: {}", path.display())));
        }
    }
    Ok(path)
}

fn initial_body(path: &Path) -> &'static str {
    if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("csv")) { "id,name\n" } else { "" }
}

fn create_document_file(path: &Path) -> Result<(), AppError> {
    // Never truncate an existing document, including one created after preflight.
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(create_error)?;
    if let Err(error) = file.write_all(initial_body(path).as_bytes()).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(create_error(error));
    }
    Ok(())
}

#[tauri::command]
pub async fn workspace_create_document(
    workspace_ref: WorkspaceRef,
    directory: String,
    name: String,
    registry: State<'_, Arc<ProjectRegistry>>,
    app_handle: AppHandle,
) -> Result<String, AppError> {
    let scope = registry.resolve_workspace_ref(&workspace_ref).map_err(create_error)?;
    let root = dunce::canonicalize(scope.runtime().root()).map_err(create_error)?;
    let path = document_path(&root, &directory, &name)?;
    let relative = path.strip_prefix(&root).map_err(create_error)?.to_string_lossy().replace('\\', "/");
    let app_knowledge: State<'_, crate::commands::knowledge::AppKnowledgeDir> = app_handle.state();
    let sources = crate::knowledge_source_registry::KnowledgeSourceRegistry::build(&root.to_string_lossy(), app_knowledge.0.as_ref().as_ref());
    if let Some(target) = sources.classify_path(&path) {
        if target.kind != crate::knowledge_source_registry::KnowledgeSourceKind::WorkspaceKnowledge
            || !target.mutability.is_writable() {
            return Err(create_error("This knowledge source is read-only"));
        }
        crate::commands::knowledge_create(workspace_ref, crate::knowledge_store::KnowledgeCreateRequest {
            kind: crate::knowledge_store::KnowledgeTargetKind::Document,
            doc_type: Some(target.doc_type), path: target.logical_path,
            document: Some(crate::knowledge_store::KnowledgeDocumentPatch {
                body: Some(Some(initial_body(&path).to_string())), ..Default::default()
            }),
        }, app_handle.clone(), registry).await?;
    } else {
        create_document_file(&path)?;
    }
    // Refresh all file trees even when there is no Unity filesystem watcher.
    use crate::workspace_changes::{hub_for_workspace, WorkspaceChangeKind, WorkspaceChangeSource};
    if let Some(event) = hub_for_workspace(&root).observe(&relative, WorkspaceChangeKind::Upsert, WorkspaceChangeSource::LocusWrite) {
        crate::workspace_service::event::emit_for_workspace_scope(&app_handle,
            &crate::workspace_service::event::WorkspaceEventScope::for_runtime(scope.runtime()),
            "workspace-file-changed", event);
    }
    Ok(relative)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_markdown_and_csv_without_overwriting_existing_files() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("docs")).unwrap();
        for (directory, name, body) in [(".", "notes.md", ""), ("docs", "data.csv", "id,name\n")] {
            let path = document_path(root.path(), directory, name).unwrap();
            create_document_file(&path).unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), body);
            std::fs::write(&path, "existing").unwrap();
            assert!(document_path(root.path(), directory, name).is_err());
            assert!(create_document_file(&path).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "existing");
        }
    }

    #[test]
    fn rejects_invalid_names_paths_and_companion_collisions() {
        let root = tempfile::tempdir().unwrap();
        for name in ["../notes.md", "..\\notes.md", "CON.md", "a?.md", "a.md.", "a.txt"] {
            assert!(document_path(root.path(), ".", name).is_err(), "{name}");
        }
        for directory in ["../", "missing"] {
            assert!(document_path(root.path(), directory, "a.md").is_err());
        }
        for directory in [".git", ".locus", "Locus/workspace-trees"] {
            std::fs::create_dir_all(root.path().join(directory)).unwrap();
            assert!(document_path(root.path(), directory, "a.md").is_err());
        }
        std::fs::write(root.path().join("data.csv.view"), "existing view").unwrap();
        assert!(document_path(root.path(), ".", "data.csv").is_err());
        assert!(!root.path().join("data.csv").exists());
    }
}
