//! Durable desktop session. Native windows own geometry; renderers own editor state.
//! This file is deliberately separate from the conversation database schema.
use crate::workspace_service::WindowPaneWorkspaceContext;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State, WindowEvent};

const FILE_NAME: &str = "desktop_work_state.json";
const SAVE_REQUEST: &str = "locus-work-state-save-requested";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkWindow {
    pub label: String,
    pub owner_label: String,
    #[serde(default)]
    pub bounds: Option<WindowBounds>,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default = "default_visible")]
    pub visible: bool,
    #[serde(default)]
    pub frontend: serde_json::Value,
}

fn default_visible() -> bool {
    true
}

impl WorkWindow {
    pub fn new(label: &str, owner_label: &str) -> Self {
        Self {
            label: label.into(),
            owner_label: owner_label.into(),
            bounds: None,
            maximized: false,
            always_on_top: false,
            visible: true,
            frontend: serde_json::Value::Null,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWorkState {
    pub schema_version: u32,
    pub windows: BTreeMap<String, WorkWindow>,
    #[serde(default)]
    pub focused_window: Option<String>,
    #[serde(default)]
    pub legacy_aux_import_pending: bool,
}

impl DesktopWorkState {
    fn from_legacy_state() -> Self {
        // Legacy pane contexts and layout caches do not track whether their
        // native workspace window was closed. Only the main shell is known to
        // exist on first migration; importing historical workspace IDs here
        // would resurrect closed windows. New sessions restore the explicit
        // window manifest instead. Legacy floating windows have a separate
        // open-window registry, which the main renderer imports once.
        let mut windows = BTreeMap::new();
        windows.insert("main".into(), WorkWindow::new("main", "main"));
        Self {
            schema_version: 1,
            windows,
            focused_window: Some("main".into()),
            legacy_aux_import_pending: true,
        }
    }

    fn remove_window(&mut self, label: &str) {
        self.windows
            .retain(|id, record| id != label && record.owner_label != label);
        if self
            .focused_window
            .as_ref()
            .is_some_and(|id| !self.windows.contains_key(id))
        {
            self.focused_window = None;
        }
    }
}

struct SaveBarrier {
    id: String,
    pending: BTreeSet<String>,
    notify: Arc<tokio::sync::Notify>,
}

pub struct WorkStateStore {
    path: PathBuf,
    state: Mutex<DesktopWorkState>,
    revision: AtomicU64,
    ready_renderers: Mutex<BTreeSet<String>>,
    closed_windows: Mutex<BTreeSet<String>>,
    geometry_pending: Mutex<BTreeSet<String>>,
    barrier: Mutex<Option<SaveBarrier>>,
    // The original target must not be overwritten by incidental startup focus events.
    restore_focus: Mutex<Option<String>>,
    restoring: Mutex<BTreeSet<String>>,
}

impl WorkStateStore {
    pub fn load(dir: &std::path::Path) -> Result<Arc<Self>, String> {
        let path = dir.join(FILE_NAME);
        let state = if path.exists() {
            let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
            match serde_json::from_slice::<DesktopWorkState>(&raw) {
                Ok(state) if state.schema_version == 1 => state,
                Ok(state) => {
                    return Err(format!(
                        "Unsupported desktop work state version: {}",
                        state.schema_version
                    ))
                }
                Err(error) => {
                    // Keep the damaged source for recovery; never silently overwrite it.
                    let backup = dir.join(format!(
                        "desktop_work_state.invalid-{}.json",
                        uuid::Uuid::new_v4()
                    ));
                    std::fs::rename(&path, &backup).map_err(|e| e.to_string())?;
                    eprintln!(
                        "[WorkState] invalid snapshot preserved at {}: {error}",
                        backup.display()
                    );
                    DesktopWorkState::from_legacy_state()
                }
            }
        } else {
            DesktopWorkState::from_legacy_state()
        };
        let restore_focus = state.focused_window.clone();
        let restoring = state.windows.keys().cloned().collect();
        let store = Arc::new(Self {
            path,
            state: Mutex::new(state),
            revision: AtomicU64::new(0),
            ready_renderers: Mutex::new(BTreeSet::new()),
            barrier: Mutex::new(None),
            closed_windows: Mutex::new(BTreeSet::new()),
            geometry_pending: Mutex::new(BTreeSet::new()),
            restore_focus: Mutex::new(restore_focus),
            restoring: Mutex::new(restoring),
        });
        store.flush()?;
        Ok(store)
    }

    pub fn snapshot(&self) -> DesktopWorkState {
        self.state.lock().unwrap().clone()
    }

    pub fn flush(&self) -> Result<(), String> {
        let state = self.state.lock().map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec_pretty(&*state).map_err(|e| e.to_string())?;
        crate::config::atomic_write_config(&self.path, &bytes)
    }

    fn schedule(self: &Arc<Self>) {
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        let store = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            if store.revision.load(Ordering::SeqCst) == revision {
                if let Err(error) = store.flush() {
                    eprintln!("[WorkState] save failed: {error}");
                }
            }
        });
    }

    pub fn register(&self, label: &str, owner: &str) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .windows
            .entry(label.into())
            .or_insert_with(|| WorkWindow::new(label, owner));
        self.flush()
    }

    pub fn set_visible(&self, label: &str, visible: bool) {
        if let Some(record) = self.state.lock().unwrap().windows.get_mut(label) {
            record.visible = visible;
        }
        if let Err(error) = self.flush() {
            eprintln!("[WorkState] visibility save failed: {error}");
        }
    }

    pub fn forget(&self, label: &str) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        let mut closed = self.closed_windows.lock().unwrap();
        closed.extend(
            state
                .windows
                .values()
                .filter(|record| record.label == label || record.owner_label == label)
                .map(|record| record.label.clone()),
        );
        closed.insert(label.into());
        state.remove_window(label);
        drop(closed);
        drop(state);
        self.flush()
    }

    pub fn retain_context(&self, context: &WindowPaneWorkspaceContext) -> bool {
        let state = self.state.lock().unwrap();
        state.windows.contains_key(&context.window_id)
            || (state.legacy_aux_import_pending && context.window_id.starts_with("workbench-"))
    }
}

fn capture_geometry(window: &tauri::Window, record: &mut WorkWindow) {
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(record.maximized);
    record.always_on_top = window.is_always_on_top().unwrap_or(record.always_on_top);
    record.maximized = maximized;
    // Remember the normal rectangle, not the monitor-sized maximized rectangle.
    if !maximized {
        if let (Ok(position), Ok(size), Ok(scale)) = (
            window.outer_position(),
            window.inner_size(),
            window.scale_factor(),
        ) {
            let position = position.to_logical::<f64>(scale);
            let size = size.to_logical::<f64>(scale);
            if size.width >= 200.0 && size.height >= 120.0 {
                record.bounds = Some(WindowBounds {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                });
            }
        }
    }
}

pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    if crate::commands::app_exit_started() {
        return;
    }
    let Some(store) = window.app_handle().try_state::<Arc<WorkStateStore>>() else {
        return;
    };
    if matches!(event, WindowEvent::Destroyed) {
        if let Err(error) = store.forget(window.label()) {
            eprintln!("[WorkState] close save failed: {error}");
        }
        store.ready_renderers.lock().unwrap().remove(window.label());
        store.restoring.lock().unwrap().remove(window.label());
        store.schedule();
        return;
    }
    if !matches!(
        event,
        WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::Focused(true)
    ) {
        return;
    }
    // Startup resize events must not overwrite the saved normal rectangle.
    if store.restoring.lock().unwrap().contains(window.label()) {
        return;
    }
    {
        let mut state = store.state.lock().unwrap();
        let Some(record) = state.windows.get_mut(window.label()) else {
            return;
        };
        if matches!(event, WindowEvent::Focused(true)) {
            record.visible = true;
            state.focused_window = Some(window.label().into());
        }
    }
    if !store
        .geometry_pending
        .lock()
        .unwrap()
        .insert(window.label().into())
    {
        return;
    }
    let store = store.inner().clone();
    let window = window.clone();
    // WebView2 window operations must run outside its synchronous event/IPC
    // callbacks. Coalesce drag/resize events before sampling the final rectangle.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        store
            .geometry_pending
            .lock()
            .unwrap()
            .remove(window.label());
        if crate::commands::app_exit_started() {
            return;
        }
        let geometry = store
            .state
            .lock()
            .unwrap()
            .windows
            .get(window.label())
            .cloned();
        let Some(mut geometry) = geometry else {
            return;
        };
        capture_geometry(&window, &mut geometry);
        {
            let mut state = store.state.lock().unwrap();
            let Some(record) = state.windows.get_mut(window.label()) else {
                return;
            };
            record.bounds = geometry.bounds;
            record.maximized = geometry.maximized;
            record.always_on_top = geometry.always_on_top;
        }
        store.schedule();
    });
}

/// Clamp to an attached monitor, retaining negative coordinates on left-hand displays.
pub fn fit_bounds(bounds: &WindowBounds, screens: &[WindowBounds]) -> WindowBounds {
    let screen = screens
        .iter()
        .find(|screen| {
            bounds.x + bounds.width > screen.x + 40.0
                && bounds.x < screen.x + screen.width - 40.0
                && bounds.y >= screen.y
                && bounds.y < screen.y + screen.height - 40.0
        })
        .or_else(|| screens.first());
    let Some(screen) = screen else {
        return bounds.clone();
    };
    let width = bounds.width.max(200.0).min(screen.width);
    let height = bounds.height.max(120.0).min(screen.height);
    WindowBounds {
        x: bounds.x.clamp(screen.x, screen.x + screen.width - width),
        y: bounds.y.clamp(screen.y, screen.y + screen.height - height),
        width,
        height,
    }
}

pub fn apply_geometry(window: &tauri::WebviewWindow, record: &WorkWindow) -> Result<(), String> {
    if let Some(bounds) = record.bounds.as_ref().filter(|b| {
        [b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite())
            && b.width > 0.0
            && b.height > 0.0
    }) {
        let screens = window
            .available_monitors()
            .unwrap_or_default()
            .into_iter()
            .map(|m| {
                let p = m.position().to_logical::<f64>(m.scale_factor());
                let s = m.size().to_logical::<f64>(m.scale_factor());
                WindowBounds {
                    x: p.x,
                    y: p.y,
                    width: s.width,
                    height: s.height,
                }
            })
            .collect::<Vec<_>>();
        let bounds = fit_bounds(bounds, &screens);
        window
            .set_size(tauri::LogicalSize::new(bounds.width, bounds.height))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::LogicalPosition::new(bounds.x, bounds.y))
            .map_err(|e| e.to_string())?;
    }
    window
        .set_always_on_top(record.always_on_top)
        .map_err(|e| e.to_string())?;
    if record.maximized {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn load_desktop_work_state(
    window: tauri::WebviewWindow,
    store: State<'_, Arc<WorkStateStore>>,
) -> DesktopWorkState {
    store
        .ready_renderers
        .lock()
        .unwrap()
        .insert(window.label().into());
    store.snapshot()
}

#[tauri::command]
pub async fn save_window_work_state(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    store: State<'_, Arc<WorkStateStore>>,
    label: String,
    frontend: serde_json::Value,
) -> Result<(), String> {
    let owner = window.label();
    if owner != "main" && !crate::workspace_window::is_workspace_window(owner) {
        return Err("Invalid work state owner".into());
    }
    if label != owner && !label.starts_with("workbench-") {
        return Err("Invalid work state window".into());
    }
    let target = app
        .get_webview_window(&label)
        .ok_or("Work state window is closed")?;
    // Native getters can marshal to the UI thread. Never hold the session lock
    // while waiting for that thread: its resize/focus callbacks use the same lock.
    let mut geometry = store
        .state
        .lock()
        .unwrap()
        .windows
        .get(&label)
        .cloned()
        .unwrap_or_else(|| WorkWindow::new(&label, owner));
    let restoring = store.restoring.lock().unwrap().contains(&label);
    if !restoring {
        capture_geometry(&target.as_ref().window(), &mut geometry);
    }
    let mut state = store.state.lock().unwrap();
    if store.closed_windows.lock().unwrap().contains(&label) {
        return Err("Work state window is closed".into());
    }
    let record = state
        .windows
        .entry(label.clone())
        .or_insert_with(|| WorkWindow::new(&label, owner));
    if record.owner_label != owner {
        return Err("Work state belongs to another renderer".into());
    }
    record.frontend = frontend;
    if !restoring {
        record.bounds = geometry.bounds;
        record.maximized = geometry.maximized;
        record.always_on_top = geometry.always_on_top;
    }
    drop(state);
    // The IPC acknowledgement means the snapshot reached disk, including during exit.
    store.flush()
}

#[tauri::command]
pub async fn show_work_state_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    store: State<'_, Arc<WorkStateStore>>,
    label: String,
) -> Result<(), String> {
    let snapshot = store.snapshot();
    let record = snapshot
        .windows
        .get(&label)
        .ok_or("Work state window is not registered")?;
    if record.owner_label != window.label() {
        return Err("Work state belongs to another renderer".into());
    }
    let target = app
        .get_webview_window(&label)
        .ok_or("Work state window is closed")?;
    apply_geometry(&target, record)?;
    let hide_main = label == "main"
        && !record.visible
        && snapshot.windows.keys().any(|id| {
            crate::workspace_window::is_workspace_window(id) && app.get_webview_window(id).is_some()
        });
    if !hide_main {
        target.show().map_err(|e| e.to_string())?;
    }
    store.restoring.lock().unwrap().remove(&label);
    let focused = store.restore_focus.lock().unwrap().clone();
    if let Some(focused) = focused {
        if !store.restoring.lock().unwrap().contains(&focused) {
            if let Some(target) = app
                .get_webview_window(&focused)
                .filter(|w| w.is_visible().unwrap_or(false))
            {
                let _ = target.set_focus();
            }
            if store.restoring.lock().unwrap().is_empty() {
                *store.restore_focus.lock().unwrap() = None;
            }
        }
    } else if !hide_main {
        let _ = target.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn finish_work_state_migration(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    store: State<'_, Arc<WorkStateStore>>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Ok(());
    }
    store.state.lock().unwrap().legacy_aux_import_pending = false;
    let snapshot = store.snapshot();
    let contexts = app.state::<Arc<crate::workspace_service::WindowContextRegistry>>();
    let persistence = app.state::<Arc<crate::commands::WindowContextPersistence>>();
    let _mutation = persistence.mutation.lock().map_err(|e| e.to_string())?;
    for context in contexts.snapshots().map_err(|e| e.to_string())? {
        if !snapshot.windows.contains_key(&context.window_id)
            && app.get_webview_window(&context.window_id).is_none()
        {
            if let Ok(epoch) = contexts.next_window_intent_epoch(&context.window_id) {
                let _ = contexts.remove_window(&context.window_id, epoch);
            }
        }
    }
    crate::commands::persist_window_context_recovery(&app, &contexts)?;
    store.flush()
}

#[tauri::command]
pub fn acknowledge_work_state_save(
    window: tauri::WebviewWindow,
    store: State<'_, Arc<WorkStateStore>>,
    request_id: String,
) {
    if let Some(barrier) = store
        .barrier
        .lock()
        .unwrap()
        .as_mut()
        .filter(|b| b.id == request_id)
    {
        barrier.pending.remove(window.label());
        barrier.notify.notify_one();
    }
}

pub async fn save_before_exit(app: &tauri::AppHandle) {
    let Some(store) = app.try_state::<Arc<WorkStateStore>>() else {
        return;
    };
    let notify = Arc::new(tokio::sync::Notify::new());
    let id = uuid::Uuid::new_v4().to_string();
    let pending = store
        .ready_renderers
        .lock()
        .unwrap()
        .iter()
        .filter(|id| app.get_webview_window(id).is_some())
        .cloned()
        .collect();
    *store.barrier.lock().unwrap() = Some(SaveBarrier {
        id: id.clone(),
        pending,
        notify: notify.clone(),
    });
    let _ = app.emit(SAVE_REQUEST, &id);
    let wait = async {
        loop {
            if store
                .barrier
                .lock()
                .unwrap()
                .as_ref()
                .is_none_or(|b| b.pending.is_empty())
            {
                break;
            }
            notify.notified().await;
        }
    };
    if tokio::time::timeout(std::time::Duration::from_secs(4), wait)
        .await
        .is_err()
    {
        eprintln!("[WorkState] renderer save timed out; retaining latest durable snapshots");
    }
    *store.barrier.lock().unwrap() = None;
    for mut record in store.snapshot().windows.into_values() {
        if let Some(window) = app.get_webview_window(&record.label) {
            capture_geometry(&window.as_ref().window(), &mut record);
            if let Some(saved) = store.state.lock().unwrap().windows.get_mut(&record.label) {
                saved.bounds = record.bounds;
                saved.maximized = record.maximized;
                saved.always_on_top = record.always_on_top;
            }
        }
    }
    if let Err(error) = store.flush() {
        eprintln!("[WorkState] final save failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_legacy_contexts(dir: &std::path::Path) -> Vec<WindowPaneWorkspaceContext> {
        let contexts: Vec<WindowPaneWorkspaceContext> = [
            ("main", "pane-a"),
            ("main", "pane-b"),
            ("workspace-app-closed-a", "pane-a"),
            ("workspace-app-closed-a", "pane-b"),
            ("workspace-app-closed-b", "pane-a"),
            ("workbench-shared-pool-unused", "pane-a"),
            ("sub-pool-1", "pane-a"),
        ]
        .into_iter()
        .map(|(window, pane)| {
            serde_json::from_value(serde_json::json!({
                "windowId":window,"paneId":pane,"focusedCheckoutId":"checkout-a",
                "workspaceGeneration":1,"materializationEpoch":0,"intentEpoch":1,"revision":1
            }))
            .unwrap()
        })
        .collect();
        std::fs::write(
            dir.join("window_workspace_contexts.json"),
            serde_json::to_vec(&contexts).unwrap(),
        )
        .unwrap();
        crate::commands::load_window_context_recovery(dir)
    }

    #[test]
    fn first_migration_does_not_reopen_historical_workspace_windows() {
        let dir = tempfile::tempdir().unwrap();
        let contexts = write_legacy_contexts(dir.path());
        assert_eq!(contexts.len(), 7);
        let store = WorkStateStore::load(dir.path()).unwrap();
        assert_eq!(
            store.snapshot().windows.keys().cloned().collect::<Vec<_>>(),
            vec!["main"]
        );
        // Keep both main panes, including their checkout/session projection.
        // Auxiliary contexts may wait for their explicit frontend open registry,
        // but must not create windows just because a pane context survived.
        let retained: Vec<_> = contexts
            .iter()
            .filter(|context| store.retain_context(context))
            .map(|context| (context.window_id.as_str(), context.pane_id.as_str()))
            .collect();
        assert_eq!(
            retained,
            vec![
                ("main", "pane-a"),
                ("main", "pane-b"),
                ("workbench-shared-pool-unused", "pane-a")
            ]
        );
        assert!(store.snapshot().windows["main"].frontend.is_null());
        let restarted = WorkStateStore::load(dir.path()).unwrap();
        assert_eq!(
            restarted
                .snapshot()
                .windows
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["main"]
        );
    }

    #[test]
    fn persisted_close_is_not_undone_by_legacy_contexts_on_restart() {
        let dir = tempfile::tempdir().unwrap();
        let contexts = write_legacy_contexts(dir.path());
        let store = WorkStateStore::load(dir.path()).unwrap();
        store
            .register("workspace-app-closed-a", "workspace-app-closed-a")
            .unwrap();
        store
            .register("workbench-a", "workspace-app-closed-a")
            .unwrap();
        store.forget("workspace-app-closed-a").unwrap();
        let restarted = WorkStateStore::load(dir.path()).unwrap();
        assert_eq!(
            restarted
                .snapshot()
                .windows
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["main"]
        );
        assert!(!restarted.retain_context(&contexts[2]));
    }
    #[test]
    fn session_round_trip_preserves_identity_layout_owner_and_normal_bounds() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkStateStore::load(dir.path()).unwrap();
        store
            .register("workspace-app-a", "workspace-app-a")
            .unwrap();
        store
            .register("workbench-shared-pool-a", "workspace-app-a")
            .unwrap();
        {
            let mut state = store.state.lock().unwrap();
            let window = state.windows.get_mut("workspace-app-a").unwrap();
            window.bounds = Some(WindowBounds {
                x: -1400.,
                y: 30.,
                width: 1100.,
                height: 700.,
            });
            window.maximized = true;
            window.frontend = serde_json::json!({"activeWorkspaceId":"checkout-a", "layouts":{"checkout-a":{"focusedPaneId":"pane-b"}}});
            state.focused_window = Some("workbench-shared-pool-a".into());
        }
        store.flush().unwrap();
        let contexts = write_legacy_contexts(dir.path());
        let restored_store = WorkStateStore::load(dir.path()).unwrap();
        assert!(!restored_store.retain_context(&contexts[2]));
        let restored = restored_store.snapshot();
        assert_eq!(restored.windows.len(), 3);
        assert_eq!(
            restored.windows["workbench-shared-pool-a"].owner_label,
            "workspace-app-a"
        );
        assert!(restored.windows["workspace-app-a"].maximized);
        assert_eq!(
            restored.windows["workspace-app-a"]
                .bounds
                .as_ref()
                .unwrap()
                .x,
            -1400.
        );
        assert_eq!(
            restored.windows["workspace-app-a"].frontend["layouts"]["checkout-a"]["focusedPaneId"],
            "pane-b"
        );
    }

    #[test]
    fn interactive_close_removes_owned_windows_but_keeps_other_workspaces() {
        let mut state = DesktopWorkState::from_legacy_state();
        for (id, owner) in [
            ("workspace-app-a", "workspace-app-a"),
            ("workspace-app-b", "workspace-app-b"),
            ("workbench-a", "workspace-app-a"),
        ] {
            state.windows.insert(id.into(), WorkWindow::new(id, owner));
        }
        state.focused_window = Some("workbench-a".into());
        state.remove_window("workspace-app-a");
        assert_eq!(
            state.windows.keys().cloned().collect::<Vec<_>>(),
            vec!["main", "workspace-app-b"]
        );
        assert!(state.focused_window.is_none());
    }

    #[test]
    fn disconnected_monitor_is_clamped_but_valid_negative_coordinates_survive() {
        let primary = WindowBounds {
            x: 0.,
            y: 0.,
            width: 1920.,
            height: 1080.,
        };
        let left = WindowBounds {
            x: -1920.,
            ..primary.clone()
        };
        let saved = WindowBounds {
            x: -1700.,
            y: 70.,
            width: 1000.,
            height: 700.,
        };
        assert_eq!(fit_bounds(&saved, &[primary.clone(), left]), saved);
        assert_eq!(fit_bounds(&saved, &[primary]).x, 0.);
    }

    #[test]
    fn unsupported_version_is_not_overwritten_and_corruption_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, r#"{"schemaVersion":2,"windows":{}}"#).unwrap();
        assert!(WorkStateStore::load(dir.path()).is_err());
        assert!(std::fs::read_to_string(&path).unwrap().contains(":2"));
        std::fs::write(&path, "broken").unwrap();
        let contexts = write_legacy_contexts(dir.path());
        let recovered = WorkStateStore::load(dir.path()).unwrap();
        assert!(!recovered.retain_context(&contexts[2]));
        assert_eq!(
            recovered
                .snapshot()
                .windows
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["main"]
        );
        let backup = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("desktop_work_state.invalid-")
            })
            .unwrap();
        assert_eq!(std::fs::read_to_string(backup).unwrap(), "broken");
    }
}
