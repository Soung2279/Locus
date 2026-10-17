use crate::error::AppError;
use crate::workspace_service::{ProjectRegistry, WorkspaceRef};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, WebviewWindow};

#[tauri::command]
pub async fn workspace_file_watch_start(
    workspace_ref: WorkspaceRef,
    registry: State<'_, Arc<ProjectRegistry>>,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, AppError> {
    let scope = registry
        .resolve_workspace_ref(&workspace_ref)
        .map_err(|e| AppError::new("workspace.file_watch_failed", e.to_string()))?;
    let watch = scope.runtime().core().file_watch();
    let token = watch
        .acquire(scope.runtime(), &app_handle, window.label())
        .map_err(|e| AppError::new("workspace.file_watch_failed", e))?;
    if app_handle.get_webview_window(window.label()).is_none() {
        if let Some(token) = &token {
            watch.release(window.label(), Some(token));
        }
    }
    Ok(token)
}

#[tauri::command]
pub fn workspace_file_watch_stop(
    token: String,
    registry: State<'_, Arc<ProjectRegistry>>,
    window: WebviewWindow,
) {
    // Release even if the caller's generation has already changed.
    for runtime in registry.runtimes() {
        runtime
            .core()
            .file_watch()
            .release(window.label(), Some(&token));
    }
}
