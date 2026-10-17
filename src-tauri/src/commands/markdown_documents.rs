use crate::{
    error::AppError,
    markdown_attachments as attachments,
    workspace_service::{ProjectRegistry, WorkspaceRef},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager, State};

fn error(value: impl ToString) -> AppError {
    AppError::new("markdown.document", value.to_string())
}

fn document_path(root: &Path, content_path: &str) -> Result<PathBuf, AppError> {
    if content_path.trim().is_empty() {
        return Err(error("A document path is required"));
    }
    let path = attachments::normalize(&root.join(content_path));
    let parent = dunce::canonicalize(
        path.parent()
            .ok_or_else(|| error("Invalid document path"))?,
    )
    .map_err(error)?;
    if !crate::knowledge_source_registry::path_is_within(&parent, root) {
        return Err(error("Document is outside the workspace"));
    }
    Ok(parent.join(
        path.file_name()
            .ok_or_else(|| error("Invalid document path"))?,
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMarkdownImage {
    path: String,
    relative_path: String,
}

#[tauri::command]
pub async fn markdown_relative_path(
    workspace_ref: WorkspaceRef,
    content_path: String,
    target_path: String,
    registry: State<'_, Arc<ProjectRegistry>>,
) -> Result<String, AppError> {
    let scope = super::knowledge::resolve_knowledge_workspace_scope(
        registry.inner().as_ref(),
        &workspace_ref,
    )?;
    let root = dunce::canonicalize(scope.runtime().root()).map_err(error)?;
    let document = document_path(&root, &content_path)?;
    Ok(attachments::relative_url(
        &document,
        &root.join(target_path),
    ))
}

#[tauri::command]
pub async fn markdown_import_image(
    workspace_ref: WorkspaceRef,
    content_path: String,
    name: String,
    data: Option<String>,
    source_path: Option<String>,
    registry: State<'_, Arc<ProjectRegistry>>,
) -> Result<ImportedMarkdownImage, AppError> {
    let scope = super::knowledge::resolve_knowledge_workspace_scope(
        registry.inner().as_ref(),
        &workspace_ref,
    )?;
    let root = dunce::canonicalize(scope.runtime().root()).map_err(error)?;
    let document = document_path(&root, &content_path)?;
    let bytes = if let Some(data) = data {
        if data.len() > 28 * 1024 * 1024 {
            return Err(error("Image exceeds 20 MiB"));
        }
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(error)?
    } else if let Some(path) = source_path {
        if std::fs::metadata(&path).map_err(error)?.len() > 20 * 1024 * 1024 {
            return Err(error("Image exceeds 20 MiB"));
        }
        std::fs::read(path).map_err(error)?
    } else {
        return Err(error("Image data is required"));
    };
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return Err(error("Image exceeds 20 MiB or is empty"));
    }
    let extension = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "jpg"
    } else if bytes.starts_with(b"GIF8") {
        "gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "webp"
    } else if bytes.starts_with(b"BM") {
        "bmp"
    } else if name.to_lowercase().ends_with(".svg")
        && std::str::from_utf8(&bytes).is_ok_and(|s| s.contains("<svg"))
    {
        "svg"
    } else {
        return Err(error("Unsupported image format"));
    };
    let directory = root.join(attachments::IMAGE_DIRECTORY);
    // Reject symlinked attachment directories before creating or writing files.
    let mut ancestor = root.clone();
    for part in Path::new(attachments::IMAGE_DIRECTORY).components() {
        ancestor.push(part);
        if std::fs::symlink_metadata(&ancestor).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(error("Attachment directory must be inside the workspace"));
        }
    }
    std::fs::create_dir_all(&directory).map_err(error)?;
    let path = directory.join(format!("image-{}.{}", uuid::Uuid::new_v4(), extension));
    crate::config::atomic_write_config(&path, &bytes).map_err(error)?;
    Ok(ImportedMarkdownImage {
        path: path.to_string_lossy().replace('\\', "/"),
        relative_path: attachments::relative_url(&document, &path),
    })
}

#[tauri::command]
pub async fn markdown_rewrite_image_links(
    workspace_ref: WorkspaceRef,
    content_path: String,
    text: String,
    old_path: String,
    new_path: String,
    registry: State<'_, Arc<ProjectRegistry>>,
) -> Result<String, AppError> {
    let scope = super::knowledge::resolve_knowledge_workspace_scope(
        registry.inner().as_ref(),
        &workspace_ref,
    )?;
    let root = dunce::canonicalize(scope.runtime().root()).map_err(error)?;
    let document = document_path(&root, &content_path)?;
    Ok(attachments::rewrite_image_links(
        &text,
        &root,
        &document,
        Path::new(&old_path),
        Path::new(&new_path),
    ))
}

static RECOVERY_LOCK: Mutex<()> = Mutex::new(());
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub text: String,
    pub at: i64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRecovery {
    pub schema_version: u32,
    #[serde(default)]
    pub key: String,
    pub base: String,
    pub draft: Option<DocumentSnapshot>,
    pub snapshots: Vec<DocumentSnapshot>,
}
impl Default for DocumentRecovery {
    fn default() -> Self {
        Self {
            schema_version: 1,
            key: String::new(),
            base: String::new(),
            draft: None,
            snapshots: Vec::new(),
        }
    }
}
fn recovery_path(app: &AppHandle, key: &str) -> Result<PathBuf, AppError> {
    let root = crate::runtime_paths::runtime_config_dir_from_env()
        .map_err(error)?
        .unwrap_or(app.path().app_data_dir().map_err(error)?);
    Ok(root
        .join("document-recovery")
        .join(format!("{}.json", blake3::hash(key.as_bytes()).to_hex())))
}
fn read_recovery(path: &Path) -> Result<DocumentRecovery, AppError> {
    if !path.exists() {
        return Ok(DocumentRecovery::default());
    }
    let record: DocumentRecovery =
        serde_json::from_slice(&std::fs::read(path).map_err(error)?).map_err(error)?;
    if record.schema_version != 1 {
        return Err(error("Unsupported document recovery version"));
    }
    Ok(record)
}
#[tauri::command]
pub async fn markdown_recovery_read(
    key: String,
    include_history: Option<bool>,
    app: AppHandle,
) -> Result<DocumentRecovery, AppError> {
    let _guard = RECOVERY_LOCK.lock().map_err(error)?;
    let path = recovery_path(&app, &key)?;
    let mut record = read_recovery(&path)?;
    if include_history.unwrap_or(false) && path.with_extension("history.json").exists() {
        let history = read_recovery(&path.with_extension("history.json"))?;
        record.snapshots = history.snapshots;
    } else {
        record.snapshots.clear();
    }
    Ok(record)
}
#[tauri::command]
pub async fn markdown_recovery_write(
    key: String,
    base: String,
    text: String,
    saved: bool,
    app: AppHandle,
) -> Result<(), AppError> {
    if text.len() > 2 * 1024 * 1024 || base.len() > 2 * 1024 * 1024 {
        return Err(error("Document recovery exceeds 2 MiB"));
    }
    let _guard = RECOVERY_LOCK.lock().map_err(error)?;
    let path = recovery_path(&app, &key)?;
    let mut record = read_recovery(&path)?;
    record.key = key;
    let history_path = path.with_extension("history.json");
    if saved && history_path.exists() {
        record.snapshots = read_recovery(&history_path)?.snapshots;
    }
    let previous_snapshot = record.snapshots.last().map(|s| s.text.clone());
    update_recovery(&mut record, base, text, saved);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(error)?;
    if saved && previous_snapshot.as_deref() != Some(record.base.as_str()) {
        let history = DocumentRecovery {
            snapshots: record.snapshots.clone(),
            key: record.key.clone(),
            ..DocumentRecovery::default()
        };
        crate::config::atomic_write_config(
            &history_path,
            &serde_json::to_vec(&history).map_err(error)?,
        )
        .map_err(error)?;
    }
    record.snapshots.clear();
    crate::config::atomic_write_config(&path, &serde_json::to_vec(&record).map_err(error)?)
        .map_err(error)?;
    Ok(())
}

fn update_recovery(record: &mut DocumentRecovery, base: String, text: String, saved: bool) {
    let now = chrono::Utc::now().timestamp_millis();
    if record.snapshots.is_empty() {
        record.snapshots.push(DocumentSnapshot {
            text: base.clone(),
            at: now,
        });
    }
    if saved {
        if record.snapshots.last().is_none_or(|s| s.text != text) {
            let at = now.max(record.snapshots.last().map_or(now, |s| s.at + 1));
            record.snapshots.push(DocumentSnapshot {
                text: text.clone(),
                at,
            });
        }
        if record.snapshots.len() > 20 {
            record.snapshots.remove(0);
        }
        // A late acknowledgement from another view must not erase a newer draft.
        if record.draft.as_ref().is_some_and(|d| d.text == text) {
            record.draft = None;
        }
        record.base = text;
    } else {
        record.base = base.clone();
        record.draft = (text != base).then_some(DocumentSnapshot { text, at: now });
    }
}

pub(crate) fn recovery_image_updates(
    app: &AppHandle,
    root: &Path,
    checkout: Option<&str>,
    old: &Path,
    new: &Path,
) -> Result<Vec<attachments::ReferenceUpdate>, AppError> {
    let _guard = RECOVERY_LOCK.lock().map_err(error)?;
    let directory = recovery_path(app, "")?.parent().unwrap().to_path_buf();
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut updates = Vec::new();
    for entry in std::fs::read_dir(directory).map_err(error)? {
        let path = entry.map_err(error)?.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let before = std::fs::read_to_string(&path).map_err(error)?;
        let mut record: DocumentRecovery = serde_json::from_str(&before).map_err(error)?;
        let Ok(key) = serde_json::from_str::<Vec<serde_json::Value>>(&record.key) else {
            continue;
        };
        if checkout.is_none() || key.first().and_then(|v| v.as_str()) != checkout {
            continue;
        }
        let Some(content_path) = key.get(2).and_then(|v| v.as_str()) else {
            continue;
        };
        let document = root.join(content_path);
        let rewrite =
            |text: &str| attachments::rewrite_image_links(text, root, &document, old, new);
        record.base = rewrite(&record.base);
        if let Some(draft) = &mut record.draft {
            draft.text = rewrite(&draft.text);
        }
        for snapshot in &mut record.snapshots {
            snapshot.text = rewrite(&snapshot.text);
        }
        let after = serde_json::to_string(&record).map_err(error)?;
        if after != before {
            updates.push(attachments::ReferenceUpdate {
                path,
                before,
                after,
            });
        }
    }
    Ok(updates)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acknowledges_saved_text_without_losing_newer_drafts() {
        let mut record = DocumentRecovery::default();
        update_recovery(
            &mut record,
            "base".into(),
            "submitted and continued".into(),
            false,
        );
        update_recovery(&mut record, "base".into(), "submitted".into(), true);
        assert_eq!(
            record.draft.as_ref().unwrap().text,
            "submitted and continued"
        );
        update_recovery(
            &mut record,
            "submitted".into(),
            "submitted and continued".into(),
            true,
        );
        assert!(record.draft.is_none());
        assert_eq!(record.snapshots[0].text, "base");
        assert_eq!(
            record.snapshots.last().unwrap().text,
            "submitted and continued"
        );
    }
    #[test]
    fn bounds_history_and_preserves_explicit_schema() {
        let mut record = DocumentRecovery::default();
        for i in 0..30 {
            update_recovery(&mut record, "base".into(), format!("version {i}"), true);
        }
        assert_eq!(record.snapshots.len(), 20);
        assert_eq!(record.schema_version, 1);
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("recovery.json");
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(read_recovery(&path).unwrap().snapshots.len(), 20);
        record.schema_version = 999;
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(read_recovery(&path).is_err());
    }
    #[test]
    fn document_import_is_scoped_to_workspace() {
        let root = tempfile::tempdir().unwrap();
        let canonical = dunce::canonicalize(root.path()).unwrap();
        std::fs::create_dir(root.path().join("Docs")).unwrap();
        assert!(document_path(&canonical, "Docs/readme.md").is_ok());
        assert!(document_path(&canonical, "../outside.md").is_err());
    }
}
