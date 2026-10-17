//! Versioned Markdown access for generated Views. The original file remains the data source.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::knowledge_source_registry::{
    path_is_within, KnowledgeSourceKind, KnowledgeSourceRegistry, ResolvedKnowledgePath,
};
use crate::knowledge_store::{self, KnowledgeReadRequest, KnowledgeTargetKind, KnowledgeType};
use crate::workspace_service::{ProjectRegistry, WorkspaceRef};

const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
pub(crate) static DOCUMENT_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ViewDocumentRef {
    Workspace {
        path: String,
    },
    Knowledge {
        path: String,
        #[serde(rename = "type")]
        doc_type: KnowledgeType,
        #[serde(default, rename = "sourceId", skip_serializing_if = "Option::is_none")]
        source_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewDocumentSnapshot {
    pub reference: ViewDocumentRef,
    pub path: String,
    pub content: String,
    pub revision: String,
    pub read_only: bool,
    pub reserved_keys: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewDocumentWrite {
    pub reference: ViewDocumentRef,
    pub content: String,
    pub expected_revision: String,
}

fn error(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(format!("document.{code}"), message)
}

fn resolve(
    root: &Path,
    sources: &KnowledgeSourceRegistry,
    reference: &ViewDocumentRef,
) -> Result<(PathBuf, Option<ResolvedKnowledgePath>), AppError> {
    let mut resolved_source = None;
    let candidate = match reference {
        ViewDocumentRef::Workspace { path } => {
            let requested = Path::new(path);
            let path = if requested.is_absolute() {
                requested.to_path_buf()
            } else {
                root.join(requested)
            };
            if !path_is_within(&path, root) {
                return Err(error("invalid_path", "Document is outside this workspace."));
            }
            path
        }
        ViewDocumentRef::Knowledge {
            path,
            doc_type,
            source_id,
        } => {
            let target = sources
                .resolve_logical(*doc_type, path)
                .ok_or_else(|| error("not_found", "Knowledge document was not found."))?;
            if source_id.as_ref().is_some_and(|id| id != &target.source_id) {
                return Err(error(
                    "source_changed",
                    "The knowledge source changed. Resolve the document again.",
                ));
            }
            resolved_source = Some(target.source_id);
            target.physical_path
        }
    };
    let canonical =
        dunce::canonicalize(&candidate).map_err(|e| error("not_found", e.to_string()))?;
    if !canonical
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
    {
        return Err(error(
            "unsupported_format",
            "A Markdown document is required.",
        ));
    }
    let classified = sources.classify_path(&canonical);
    if let ViewDocumentRef::Knowledge {
        doc_type,
        source_id,
        ..
    } = reference
    {
        let target = classified
            .as_ref()
            .ok_or_else(|| error("invalid_path", "Document is outside its knowledge source."))?;
        if target.doc_type != *doc_type
            || resolved_source
                .as_ref()
                .is_some_and(|id| id != &target.source_id)
            || source_id.as_ref().is_some_and(|id| id != &target.source_id)
        {
            return Err(error(
                "source_changed",
                "The knowledge source changed. Resolve the document again.",
            ));
        }
    }
    Ok((canonical, classified))
}

fn read_text(path: &Path) -> Result<String, AppError> {
    let file = std::fs::File::open(path).map_err(|e| error("read_failed", e.to_string()))?;
    if !file
        .metadata()
        .map_err(|e| error("read_failed", e.to_string()))?
        .is_file()
    {
        return Err(error("invalid_path", "Document must be a regular file."));
    }
    let mut bytes = Vec::new();
    file.take(MAX_DOCUMENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| error("read_failed", e.to_string()))?;
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(error(
            "too_large",
            "Document exceeds the 1 MiB editing limit.",
        ));
    }
    if bytes.contains(&0) {
        return Err(error("invalid_encoding", "Document must be UTF-8 text."));
    }
    String::from_utf8(bytes).map_err(|e| error("invalid_encoding", e.to_string()))
}

fn revision(path: &Path, content: &str) -> String {
    let mut hash = blake3::Hasher::new();
    let path = path.to_string_lossy().replace('\\', "/");
    let path = if cfg!(windows) {
        path.to_lowercase()
    } else {
        path
    };
    hash.update(path.as_bytes());
    hash.update(&[0]);
    hash.update(content.as_bytes());
    hash.finalize().to_hex().to_string()
}

fn snapshot(
    root: &Path,
    app_root: Option<&PathBuf>,
    sources: &KnowledgeSourceRegistry,
    reference: &ViewDocumentRef,
) -> Result<ViewDocumentSnapshot, AppError> {
    let (path, target) = resolve(root, sources, reference)?;
    let content = read_text(&path)?;
    let mut read_only = std::fs::metadata(&path)
        .map_err(|e| error("read_failed", e.to_string()))?
        .permissions()
        .readonly();
    let mut reserved_keys = Vec::new();
    let reference = if let Some(target) = target {
        read_only |= !target.mutability.is_writable();
        if target.mutability.is_writable() {
            if target.kind == KnowledgeSourceKind::WorkspaceKnowledge {
                read_only |= knowledge_store::inspect_workspace_document_policy(
                    &root.to_string_lossy(),
                    target.doc_type,
                    &target.logical_path,
                )
                .map_err(|e| error("policy_failed", e))?
                .read_only;
            } else {
                let result = super::knowledge::execute_knowledge_read_request(
                    &root.to_string_lossy(),
                    app_root,
                    KnowledgeReadRequest {
                        kind: KnowledgeTargetKind::Document,
                        path: target.logical_path.clone(),
                        doc_type: Some(target.doc_type),
                        part: Some("full".into()),
                        include_history: false,
                    },
                )
                .map_err(|e| error("policy_failed", e))?;
                read_only |= result
                    .document
                    .as_ref()
                    .is_none_or(|doc| doc.document.read_only);
            }
        }
        if target.kind == KnowledgeSourceKind::WorkspaceKnowledge {
            reserved_keys.extend(
                knowledge_store::CANONICAL_FRONTMATTER_KEYS
                    .iter()
                    .chain(knowledge_store::LEGACY_FRONTMATTER_KEYS)
                    .map(|key| (*key).to_string()),
            );
        }
        ViewDocumentRef::Knowledge {
            path: target.logical_path,
            doc_type: target.doc_type,
            source_id: Some(target.source_id),
        }
    } else {
        ViewDocumentRef::Workspace {
            path: path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/"),
        }
    };
    Ok(ViewDocumentSnapshot {
        reference,
        revision: revision(&path, &content),
        path: path.to_string_lossy().replace('\\', "/"),
        content,
        read_only,
        reserved_keys,
    })
}

// Validate reserved metadata on the native side as well; generated clients may not bypass policy.
fn properties(content: &str) -> Result<serde_yaml::Mapping, AppError> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.split_inclusive('\n');
    if lines.next().is_none_or(|line| line.trim_end() != "---") {
        return Ok(serde_yaml::Mapping::new());
    }
    let mut yaml = String::new();
    for line in lines {
        if matches!(line.trim_end(), "---" | "...") {
            if yaml.trim().is_empty() {
                return Ok(serde_yaml::Mapping::new());
            }
            return serde_yaml::from_str(&yaml).map_err(|e| error("invalid_yaml", e.to_string()));
        }
        yaml.push_str(line);
    }
    Err(error(
        "invalid_yaml",
        "The YAML properties block is not terminated.",
    ))
}

fn write(
    root: &Path,
    app_root: Option<&PathBuf>,
    sources: &KnowledgeSourceRegistry,
    request: ViewDocumentWrite,
) -> Result<ViewDocumentSnapshot, AppError> {
    let _guard = DOCUMENT_WRITE_LOCK
        .lock()
        .map_err(|e| error("write_lock", e.to_string()))?;
    let mut current = snapshot(root, app_root, sources, &request.reference)?;
    if current.read_only {
        return Err(error("read_only", "Document is read-only."));
    }
    if request.expected_revision.is_empty() || current.revision != request.expected_revision {
        return Err(error(
            "conflict",
            "Document changed since it was read. Read it again before editing.",
        ));
    }
    if request.content.len() > MAX_DOCUMENT_BYTES || request.content.as_bytes().contains(&0) {
        return Err(error(
            "too_large",
            "Document must be UTF-8 text within the 1 MiB editing limit.",
        ));
    }
    let before = properties(&current.content)?;
    let after = properties(&request.content)?;
    for key in &current.reserved_keys {
        let key_value = serde_yaml::Value::String(key.clone());
        if before.get(&key_value) != after.get(&key_value) {
            return Err(error(
                "reserved_property",
                format!("Property '{key}' is managed by Knowledge settings."),
            ));
        }
    }
    let path = Path::new(&current.path);
    if current.content != request.content {
        // Recheck after policy/format validation, just before replacing the file.
        if revision(path, &read_text(path)?) != current.revision {
            return Err(error("conflict", "Document changed while saving."));
        }
        crate::config::atomic_write_config(path, request.content.as_bytes())
            .map_err(|e| error("write_failed", e))?;
    }
    current.revision = revision(path, &request.content);
    current.content = request.content;
    Ok(current)
}

#[tauri::command]
pub async fn view_document_read(
    reference: ViewDocumentRef,
    workspace_ref: WorkspaceRef,
    registry: State<'_, Arc<ProjectRegistry>>,
    app_knowledge_dir: State<'_, super::AppKnowledgeDir>,
) -> Result<ViewDocumentSnapshot, AppError> {
    let scope = registry
        .resolve_workspace_ref(&workspace_ref)
        .map_err(|e| error("workspace_unavailable", e.to_string()))?;
    let root = scope.runtime().root();
    let app_root = app_knowledge_dir.0.as_ref().as_ref();
    let sources = KnowledgeSourceRegistry::build(&root.to_string_lossy(), app_root);
    snapshot(root, app_root, &sources, &reference)
}

#[tauri::command]
pub async fn view_document_write(
    request: ViewDocumentWrite,
    workspace_ref: WorkspaceRef,
    app_handle: AppHandle,
    registry: State<'_, Arc<ProjectRegistry>>,
    app_knowledge_dir: State<'_, super::AppKnowledgeDir>,
) -> Result<ViewDocumentSnapshot, AppError> {
    let scope = registry
        .resolve_workspace_ref(&workspace_ref)
        .map_err(|e| error("workspace_unavailable", e.to_string()))?;
    let root = scope.runtime().root();
    let app_root = app_knowledge_dir.0.as_ref().as_ref();
    let sources = KnowledgeSourceRegistry::build(&root.to_string_lossy(), app_root);
    let saved = write(root, app_root, &sources, request)?;
    let event_scope =
        crate::workspace_service::event::WorkspaceEventScope::for_runtime(scope.runtime());
    crate::workspace_service::event::emit_for_workspace_scope(
        &app_handle,
        &event_scope,
        "view-document-changed",
        serde_json::json!({ "reference": saved.reference, "path": saved.path }),
    );
    // Existing filesystem watchers reconcile Knowledge's derived indexes from the original file.
    if let ViewDocumentRef::Knowledge { doc_type, path, .. } = &saved.reference {
        super::knowledge::emit_knowledge_changed_with_target_for_scope(
            &app_handle,
            &event_scope,
            &root.to_string_lossy(),
            "view_document_write",
            super::KnowledgeChangedTarget {
                doc_type: Some(*doc_type),
                path: Some(path.clone()),
                target_kind: Some("document"),
                change_kind: Some("content"),
                ..Default::default()
            },
        );
    }
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_source_registry::{KnowledgeSource, KnowledgeSourceMutability};
    use crate::knowledge_store::KnowledgeStorageSource;

    fn sources(root: &Path) -> KnowledgeSourceRegistry {
        KnowledgeSourceRegistry::from_sources_for_test(Some(root.to_path_buf()), vec![])
    }
    fn workspace(path: &str) -> ViewDocumentRef {
        ViewDocumentRef::Workspace { path: path.into() }
    }
    fn save(
        root: &Path,
        sources: &KnowledgeSourceRegistry,
        before: &ViewDocumentSnapshot,
        content: &str,
    ) -> Result<ViewDocumentSnapshot, AppError> {
        write(
            root,
            None,
            sources,
            ViewDocumentWrite {
                reference: before.reference.clone(),
                content: content.into(),
                expected_revision: before.revision.clone(),
            },
        )
    }
    fn knowledge_sources(
        root: &Path,
        mutability: KnowledgeSourceMutability,
    ) -> KnowledgeSourceRegistry {
        KnowledgeSourceRegistry::from_sources_for_test(
            Some(root.to_path_buf()),
            vec![KnowledgeSource {
                source_id: "project-design".into(),
                kind: KnowledgeSourceKind::WorkspaceKnowledge,
                doc_type: KnowledgeType::Design,
                physical_root: root.join("Locus/knowledge/design"),
                logical_prefix: String::new(),
                storage_source: KnowledgeStorageSource::Project,
                mutability,
                watch: true,
                priority: 500,
            }],
        )
    }
    fn knowledge_file(root: &Path, text: &str) -> PathBuf {
        let path = root.join("Locus/knowledge/design/role.md");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn markdown_round_trip_preserves_exact_file_and_requires_fresh_revision() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sources = sources(root);
        let path = root.join("role.md");
        let original = "\u{feff}---\r\nlevel: 1 # comment\r\n---\r\n\r\n# 正文  \r\n";
        std::fs::write(&path, original).unwrap();
        let before = snapshot(root, None, &sources, &workspace("role.md")).unwrap();
        assert_eq!(before.content, original);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        let changed = original.replace("level: 1", "level: 2");
        let saved = save(root, &sources, &before, &changed).unwrap();
        assert_ne!(saved.revision, before.revision);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), changed);
        assert_eq!(
            snapshot(root, None, &sources, &saved.reference)
                .unwrap()
                .revision,
            saved.revision
        );
        assert_eq!(
            save(root, &sources, &before, original).unwrap_err().code,
            "document.conflict"
        );
    }

    #[test]
    fn rejects_external_edits_and_cross_document_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sources = sources(root);
        std::fs::write(root.join("one.md"), "# One\n").unwrap();
        std::fs::write(root.join("two.md"), "# One\n").unwrap();
        let before = snapshot(root, None, &sources, &workspace("one.md")).unwrap();
        let mut wrong = before.clone();
        wrong.reference = workspace("two.md");
        assert_eq!(
            save(root, &sources, &wrong, "bad").unwrap_err().code,
            "document.conflict"
        );
        std::fs::write(root.join("one.md"), "# Agent edit\n").unwrap();
        assert_eq!(
            save(root, &sources, &before, "bad").unwrap_err().code,
            "document.conflict"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("one.md")).unwrap(),
            "# Agent edit\n"
        );
    }

    #[test]
    fn concurrent_views_cannot_both_commit_the_same_revision() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sources = sources(root);
        std::fs::write(root.join("role.md"), "# Body\n").unwrap();
        let before = snapshot(root, None, &sources, &workspace("role.md")).unwrap();
        let results = std::thread::scope(|scope| {
            let a = scope.spawn(|| save(root, &sources, &before, "# A\n"));
            let b = scope.spawn(|| save(root, &sources, &before, "# B\n"));
            [a.join().unwrap(), b.join().unwrap()]
        });
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .next()
                .unwrap()
                .code,
            "document.conflict"
        );
    }

    #[test]
    fn knowledge_alias_uses_native_policy_and_keeps_reserved_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sources = knowledge_sources(root, KnowledgeSourceMutability::Writable);
        let original = "---\nid: kd_role\nstatus: todo # preserve\n---\n# Body\n";
        let path = knowledge_file(root, original);
        let before = snapshot(
            root,
            None,
            &sources,
            &workspace("Locus/knowledge/design/role.md"),
        )
        .unwrap();
        assert!(
            matches!(&before.reference, ViewDocumentRef::Knowledge { source_id: Some(id), .. } if id == "project-design")
        );
        assert!(before.reserved_keys.contains(&"id".to_string()));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            original,
            "reading policy must not migrate or normalize the document"
        );
        assert_eq!(
            save(
                root,
                &sources,
                &before,
                &original.replace("kd_role", "kd_other")
            )
            .unwrap_err()
            .code,
            "document.reserved_property"
        );
        let saved = save(root, &sources, &before, &original.replace("todo", "done")).unwrap();
        assert!(saved.content.contains("status: done # preserve"));
    }

    #[test]
    fn read_only_knowledge_and_source_replacement_cannot_be_bypassed_with_workspace_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        knowledge_file(root, "---\nid: kd_role\nreadOnly: true\n---\n# Locked\n");
        let sources = knowledge_sources(root, KnowledgeSourceMutability::Writable);
        let before = snapshot(
            root,
            None,
            &sources,
            &workspace("Locus/knowledge/design/role.md"),
        )
        .unwrap();
        assert!(before.read_only);
        assert_eq!(
            save(root, &sources, &before, "# bypass").unwrap_err().code,
            "document.read_only"
        );
        let stale = ViewDocumentRef::Knowledge {
            doc_type: KnowledgeType::Design,
            path: "role.md".into(),
            source_id: Some("another-source".into()),
        };
        assert_eq!(
            snapshot(root, None, &sources, &stale).unwrap_err().code,
            "document.source_changed"
        );
        let managed = knowledge_sources(root, KnowledgeSourceMutability::Managed);
        assert!(
            snapshot(
                root,
                None,
                &managed,
                &workspace("Locus/knowledge/design/role.md")
            )
            .unwrap()
            .read_only
        );
    }

    #[test]
    fn rejects_paths_outside_the_workspace_non_markdown_and_invalid_yaml() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let sources = sources(&root);
        std::fs::write(dir.path().join("outside.md"), "# Outside").unwrap();
        assert_eq!(
            snapshot(&root, None, &sources, &workspace("../outside.md"))
                .unwrap_err()
                .code,
            "document.invalid_path"
        );
        std::fs::write(root.join("data.csv"), "a,b").unwrap();
        assert_eq!(
            snapshot(&root, None, &sources, &workspace("data.csv"))
                .unwrap_err()
                .code,
            "document.unsupported_format"
        );
        std::fs::write(root.join("role.md"), "# Body").unwrap();
        let before = snapshot(&root, None, &sources, &workspace("role.md")).unwrap();
        for invalid in [
            "---\nnot closed",
            "---\na: 1\na: 2\n---\n",
            "---\na: [broken\n---\n",
        ] {
            assert_eq!(
                save(&root, &sources, &before, invalid).unwrap_err().code,
                "document.invalid_yaml"
            );
        }
        assert_eq!(
            std::fs::read_to_string(root.join("role.md")).unwrap(),
            "# Body"
        );
    }
}
