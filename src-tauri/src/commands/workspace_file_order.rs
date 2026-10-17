use crate::error::AppError;
use crate::workspace_file_order::{FileOrder, FilePlacement};
use crate::workspace_service::{ProjectRegistry, WorkspaceRef};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

fn order_error(error: String) -> AppError {
    let conflict = error == "workspace_file_order_revision_conflict";
    AppError::new(
        if conflict {
            "workspace.file_order_revision_conflict"
        } else {
            "workspace.file_order_failed"
        },
        if conflict {
            "The file order changed in another window."
        } else {
            "The file order could not be saved."
        },
    )
    .detail(error)
    .retryable(conflict)
}

#[tauri::command]
pub async fn workspace_file_order(
    workspace_ref: WorkspaceRef,
    registry: State<'_, Arc<ProjectRegistry>>,
) -> Result<FileOrder, AppError> {
    let scope = registry
        .resolve_workspace_ref(&workspace_ref)
        .map_err(|e| order_error(e.to_string()))?;
    crate::workspace_file_order::snapshot(scope.runtime().root()).map_err(order_error)
}

#[tauri::command]
pub async fn workspace_file_order_save(
    workspace_ref: WorkspaceRef,
    expected_revision: i64,
    directory: String,
    placements: Vec<FilePlacement>,
    registry: State<'_, Arc<ProjectRegistry>>,
    app_handle: AppHandle,
) -> Result<FileOrder, AppError> {
    let scope = registry
        .resolve_workspace_ref(&workspace_ref)
        .map_err(|e| order_error(e.to_string()))?;
    let root = scope.runtime().root();
    let order = crate::workspace_file_order::save(root, expected_revision, &directory, placements)
        .map_err(order_error)?;
    app_handle
        .emit(
            "workspace-file-order-changed",
            serde_json::json!({ "root": root }),
        )
        .map_err(|e| order_error(e.to_string()))?;
    Ok(order)
}
