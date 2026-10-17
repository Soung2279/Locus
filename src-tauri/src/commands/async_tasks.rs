use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::async_tasks::{emit_task_updated, AsyncTaskManager, BackgroundTaskInfo};
use crate::error::AppError;

#[tauri::command]
pub(crate) fn list_background_tasks(
    session_id: String,
    tasks: State<'_, Arc<AsyncTaskManager>>,
) -> Vec<BackgroundTaskInfo> {
    tasks.list_background_tasks(&session_id)
}

#[tauri::command]
pub(crate) fn cancel_background_task(
    session_id: String,
    task_id: String,
    tasks: State<'_, Arc<AsyncTaskManager>>,
    app: AppHandle,
) -> Result<BackgroundTaskInfo, AppError> {
    let snapshot = tasks
        .cancel_background_task(&session_id, &task_id)
        .map_err(AppError::from)?;
    if let (Some(message_id), Some(tool_call_id)) = (
        snapshot.assistant_message_id.as_deref(),
        snapshot.tool_call_id.as_deref(),
    ) {
        emit_task_updated(&app, message_id, tool_call_id, &snapshot);
    }
    Ok(BackgroundTaskInfo::from(&snapshot))
}
