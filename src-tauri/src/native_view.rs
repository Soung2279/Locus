//! Scoped loopback transport for Unity's in-process shared Vue host. This does
//! not expose the desktop Tauri dispatcher or the general Python SDK token.
use crate::workspace_service::{ProjectRegistry, ResolvedWorkspaceScope, WorkspaceRef};
use http_body_util::{BodyExt, Full};
use hyper::{body::Bytes, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Listener, Manager};
use tokio::{
    net::TcpListener,
    sync::{Notify, Semaphore},
};

const MAX_BODY: usize = 2 * 1024 * 1024;
const IDLE_SESSION: Duration = Duration::from_secs(30 * 60);
struct Session {
    id: String,
    token: String,
    reference: WorkspaceRef,
    scope: ResolvedWorkspaceScope,
    views: Mutex<HashSet<String>>,
    watches: Mutex<HashMap<String, (String, String)>>,
    events: Mutex<EventQueue>,
    notify: Notify,
    touched: Mutex<Instant>,
}
#[derive(Default)]
struct EventQueue {
    entries: VecDeque<(usize, Value)>,
    bytes: usize,
}
impl EventQueue {
    fn push(&mut self, value: Value, size: usize) {
        if size > MAX_BODY {
            return;
        }
        while self.entries.len() >= 128 || self.bytes + size > MAX_BODY {
            if let Some((size, _)) = self.entries.pop_front() {
                self.bytes -= size;
            } else {
                break;
            }
        }
        self.bytes += size;
        self.entries.push_back((size, value));
    }
    fn drain(&mut self) -> Vec<Value> {
        self.bytes = 0;
        self.entries.drain(..).map(|(_, value)| value).collect()
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(watches) = self.watches.lock() {
            for (token, (view, label)) in watches.iter() {
                crate::view::release_native_view_host(&self.reference, view, token, label);
            }
        }
    }
}
struct Server {
    origin: String,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    connections: Arc<Semaphore>,
}
fn expire_sessions(server: &Server) {
    let expired = {
        let mut sessions = server.sessions.lock().unwrap();
        let keys: Vec<_> = sessions
            .iter()
            .filter(|(_, s)| s.touched.lock().unwrap().elapsed() >= IDLE_SESSION)
            .map(|(key, _)| key.clone())
            .collect();
        keys.into_iter()
            .filter_map(|key| sessions.remove(&key))
            .collect::<Vec<_>>()
    };
    // Watcher shutdown may join threads which publish workspace events.
    // Never drop a session while holding the server's session map lock.
    drop(expired);
}
static SERVER: OnceLock<tokio::sync::Mutex<Option<Arc<Server>>>> = OnceLock::new();
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NativeViewConnection {
    pub url: String,
    pub instance_id: String,
    pub view_id: String,
    pub title: String,
    pub workspace_ref: WorkspaceRef,
}
fn registry(app: &AppHandle) -> tauri::State<'_, Arc<ProjectRegistry>> {
    app.state::<Arc<ProjectRegistry>>()
}

async fn server(app: &AppHandle) -> Result<Arc<Server>, String> {
    let mut current = SERVER
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await;
    if let Some(s) = current.as_ref() {
        return Ok(s.clone());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| e.to_string())?;
    let server = Arc::new(Server {
        origin: format!(
            "http://{}",
            listener.local_addr().map_err(|e| e.to_string())?
        ),
        sessions: Mutex::new(HashMap::new()),
        connections: Arc::new(Semaphore::new(128)),
    });
    let weak = Arc::downgrade(&server);
    app.listen(
        crate::workspace_service::event::WORKSPACE_EVENT_NAME,
        move |event| {
            let (Some(server), Ok(value)) = (
                weak.upgrade(),
                serde_json::from_str::<Value>(event.payload()),
            ) else {
                return;
            };
            let size = event.payload().len();
            let sessions = server.sessions.lock().unwrap();
            for s in sessions.values() {
                if event_matches(&s.reference, &value) {
                    s.events.lock().unwrap().push(value.clone(), size);
                    s.notify.notify_waiters();
                }
            }
        },
    );
    let state = server.clone();
    // Wry's Windows handle contains a main-thread Rc. Cloning/dropping an
    // AppHandle for every concurrent request races its non-atomic refcount.
    // Retain one handle and clone only the Arc on HTTP worker threads.
    let application = Arc::new(app.clone());
    tauri::async_runtime::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        let mut cleanup = tokio::time::interval(Duration::from_secs(60));
        loop {
            tokio::select! {
                stream=listener.accept()=>{let Ok((stream,_))=stream else{break;};let Ok(permit)=state.connections.clone().try_acquire_owned() else{tracing::warn!("Native View HTTP connection limit reached");continue;};let state=state.clone();let app=application.clone();
                    connections.spawn(async move{let _permit=permit;let service=hyper::service::service_fn(move|request|{let state=state.clone();let app=app.clone();async move{Ok::<_,std::convert::Infallible>(handle(request,app,state).await)}});
                        let _=hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream),service).await;});
                }
                _=connections.join_next(),if !connections.is_empty()=>{}
                _=cleanup.tick()=>{expire_sessions(&state);}
            }
        }
    });
    *current = Some(server.clone());
    Ok(server)
}
fn event_matches(reference: &WorkspaceRef, event: &Value) -> bool {
    event["checkoutId"].as_str() == Some(reference.checkout_id.as_str())
        && event["workspaceGeneration"].as_u64() == reference.expected_generation
        && event["materializationEpoch"].as_u64() == reference.expected_materialization_epoch
}
pub async fn connection(
    app: &AppHandle,
    reference: WorkspaceRef,
    view_id: &str,
) -> Result<NativeViewConnection, String> {
    let scope = registry(app)
        .resolve_workspace_ref(&reference)
        .map_err(|e| e.to_string())?;
    let root = scope.runtime().root().to_string_lossy().to_string();
    let detail = crate::view::read_view_sync(&root, view_id)?;
    let server = server(app).await?;
    expire_sessions(&server);
    let mut sessions = server.sessions.lock().unwrap();
    let existing = sessions
        .values()
        .find(|s| s.reference == reference)
        .cloned();
    let session = if let Some(s) = existing {
        s
    } else {
        if sessions.len() >= 16 {
            return Err("Too many native Unity View connections".into());
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let s = Arc::new(Session {
            id,
            token: token.clone(),
            reference: reference.clone(),
            scope,
            views: Mutex::new(HashSet::new()),
            watches: Mutex::new(HashMap::new()),
            events: Mutex::new(EventQueue::default()),
            notify: Notify::new(),
            touched: Mutex::new(Instant::now()),
        });
        sessions.insert(token, s.clone());
        s
    };
    session.views.lock().unwrap().extend(
        crate::view::list_views_sync(&root)?
            .into_iter()
            .map(|view| view.id),
    );
    *session.touched.lock().unwrap() = Instant::now();
    Ok(NativeViewConnection {
        url: format!("{}/unity-view.html#{}", server.origin, session.token),
        instance_id: session.id.clone(),
        view_id: detail.summary.id,
        title: detail.summary.name,
        workspace_ref: reference,
    })
}
pub async fn open(
    app: &AppHandle,
    reference: WorkspaceRef,
    view_id: &str,
) -> Result<crate::view::ViewRunResult, String> {
    let scope = registry(app)
        .resolve_workspace_ref(&reference)
        .map_err(|e| e.to_string())?;
    let root = scope.runtime().root().to_string_lossy().to_string();
    let detail = crate::view::read_view_sync(&root, view_id)?;
    let connection = connection(app, reference, view_id).await?;
    let response = crate::unity_bridge::send_message(
        &root,
        "native_view_open",
        &serde_json::to_string(&connection).map_err(|e| e.to_string())?,
    )
    .await?;
    if !response.ok {
        return Err(response
            .error
            .unwrap_or_else(|| "Unity could not open the native View".into()));
    }
    Ok(crate::view::ViewRunResult {
        id: connection.view_id,
        window_label: format!("view-native-{}", connection.instance_id),
        host_url: "unity-native-view".into(),
        package_root: detail.summary.package_root,
    })
}
fn response(status: StatusCode, body: impl Into<Bytes>, mime: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(Full::new(body.into()))
        .unwrap()
}
fn result(result: Result<Value, String>) -> Response<Full<Bytes>> {
    response(
        StatusCode::OK,
        match result {
            Ok(v) => json!({"ok":true,"result":v}),
            Err(e) => json!({"ok":false,"error":e}),
        }
        .to_string(),
        "application/json",
    )
}
fn valid_request_host<B>(request: &Request<B>, origin: &str) -> bool {
    request.headers().get("host").and_then(|s| s.to_str().ok()) == origin.strip_prefix("http://")
        && request
            .headers()
            .get("origin")
            .map(|v| v.to_str().ok() == Some(origin))
            .unwrap_or(true)
}
async fn handle(
    mut request: Request<hyper::body::Incoming>,
    app: Arc<AppHandle>,
    server: Arc<Server>,
) -> Response<Full<Bytes>> {
    if !valid_request_host(&request, &server.origin) {
        return response(
            StatusCode::FORBIDDEN,
            "Origin or Host mismatch",
            "text/plain",
        );
    }
    let path = request.uri().path().to_string();
    if !path.starts_with("/native-view/") {
        if request.method() != Method::GET {
            return response(StatusCode::METHOD_NOT_ALLOWED, "GET required", "text/plain");
        }
        return asset(&app, &path, request.uri().query()).await;
    }
    let token = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let session = server.sessions.lock().unwrap().get(token).cloned();
    let Some(session) = session else {
        return response(
            StatusCode::UNAUTHORIZED,
            "Native View connection expired. Reopen from Locus.",
            "text/plain",
        );
    };
    *session.touched.lock().unwrap() = Instant::now();
    if registry(&app)
        .resolve_workspace_ref(&session.reference)
        .is_err()
    {
        return result(Err(
            "Native View workspace binding is stale. Reopen from Locus.".into(),
        ));
    }
    if path == "/native-view/bootstrap" && request.method() == Method::GET {
        return result(Ok(
            json!({"instanceId":session.id,"workspaceRef":session.reference}),
        ));
    }
    if path == "/native-view/events" && request.method() == Method::GET {
        let notified = session.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if session.events.lock().unwrap().entries.is_empty() {
            let _ = tokio::time::timeout(Duration::from_secs(20), notified).await;
        }
        let events = session.events.lock().unwrap().drain();
        return result(Ok(json!(events)));
    }
    if path != "/native-view/invoke" || request.method() != Method::POST {
        return response(StatusCode::NOT_FOUND, "Not found", "text/plain");
    }
    let mut bytes = Vec::new();
    while let Some(frame) = request.body_mut().frame().await {
        match frame {
            Ok(frame) => {
                if let Ok(data) = frame.into_data() {
                    if bytes.len() + data.len() > MAX_BODY {
                        return response(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "Request exceeds limit",
                            "text/plain",
                        );
                    }
                    bytes.extend_from_slice(&data);
                }
            }
            Err(e) => return result(Err(e.to_string())),
        }
    }
    let rpc: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => return result(Err(e.to_string())),
    };
    let Some(command) = rpc["command"].as_str() else {
        return result(Err("Missing command".into()));
    };
    result(dispatch(&app, &session, command, rpc["args"].clone()).await)
}
async fn asset(app: &AppHandle, path: &str, query: Option<&str>) -> Response<Full<Bytes>> {
    if path.contains("..") || path == "/" {
        return response(StatusCode::NOT_FOUND, "Not found", "text/plain");
    }
    if let Some(base) = app.config().build.dev_url.as_ref().filter(|_| tauri::is_dev()) {
        if matches!(path, "/unity-view.html" | "/package.json")
            || [
                "/src/",
                "/assets/",
                "/node_modules/",
                "/@vite/",
                "/@id/",
                "/@fs/",
            ]
            .iter()
            .any(|p| path.starts_with(p))
        {
            let url = format!(
                "{}{}{}",
                base.as_str().trim_end_matches('/'),
                path,
                query.map(|q| format!("?{q}")).unwrap_or_default()
            );
            match reqwest::get(url).await {
                Ok(r) => {
                    let status = StatusCode::from_u16(r.status().as_u16())
                        .unwrap_or(StatusCode::BAD_GATEWAY);
                    let mime = r
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("application/octet-stream")
                        .to_string();
                    return response(status, r.bytes().await.unwrap_or_default(), &mime);
                }
                Err(e) => return response(StatusCode::BAD_GATEWAY, e.to_string(), "text/plain"),
            }
        }
    }
    if let Some(asset) = app
        .asset_resolver()
        .get(path.trim_start_matches('/').to_string())
    {
        return response(StatusCode::OK, asset.bytes, &asset.mime_type);
    }
    response(
        StatusCode::NOT_FOUND,
        "Native View frontend is unavailable. Build the frontend bundle.",
        "text/plain",
    )
}
fn arg<T: serde::de::DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("Invalid {name}: {e}"))
}
fn encode<T: Serialize, E: std::fmt::Display>(value: Result<T, E>) -> Result<Value, String> {
    serde_json::to_value(value.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn validate_scope(s: &Session, args: &Value) -> Result<(), String> {
    if let Some(value) = args.get("workspaceRef") {
        let reference: WorkspaceRef =
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        if reference != s.reference {
            return Err("Cross-workspace native View request rejected".into());
        }
    }
    for view in [
        args.get("viewId"),
        args.get("request").and_then(|v| v.get("viewId")),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(view) = view.as_str() {
            if !s.views.lock().unwrap().contains(view) {
                return Err("View has not been authorized by Locus".into());
            }
        }
    }
    Ok(())
}
async fn dispatch(
    app: &AppHandle,
    s: &Session,
    command: &str,
    args: Value,
) -> Result<Value, String> {
    validate_scope(s, &args)?;
    let reference = s.reference.clone();
    let root = s.scope.runtime().root().to_string_lossy().to_string();
    macro_rules! view_request {
        ($f:ident) => {
            encode(crate::commands::$f(arg(&args, "request")?, reference, registry(app)).await)
        };
    }
    match command {
        "view_read" => encode(
            crate::commands::view_read(arg(&args, "viewId")?, reference, registry(app)).await,
        ),
        "view_reload" => encode(
            crate::commands::view_reload_borrowed(
                arg(&args, "viewId")?,
                reference,
                registry(app),
                app,
            )
            .await,
        ),
        "view_compile_script" => view_request!(view_compile_script),
        "view_call_script" => view_request!(view_call_script),
        "view_storage_get" => view_request!(view_storage_get),
        "view_storage_set" => view_request!(view_storage_set),
        "view_storage_remove" => view_request!(view_storage_remove),
        "view_fs_read_file" => view_request!(view_fs_read_file),
        "view_fs_write_file" => view_request!(view_fs_write_file),
        "view_fs_append_file" => view_request!(view_fs_append_file),
        "view_fs_mkdir" => view_request!(view_fs_mkdir),
        "view_fs_readdir" => view_request!(view_fs_readdir),
        "view_fs_stat" => view_request!(view_fs_stat),
        "view_fs_lstat" => view_request!(view_fs_lstat),
        "view_fs_access" => view_request!(view_fs_access),
        "view_fs_unlink" => view_request!(view_fs_unlink),
        "view_fs_rm" => view_request!(view_fs_rm),
        "view_fs_rename" => view_request!(view_fs_rename),
        "view_fs_copy_file" => view_request!(view_fs_copy_file),
        "view_read_frontend_log" => view_request!(view_read_frontend_log),
        "view_append_frontend_log" => view_request!(view_append_frontend_log),
        "view_append_frontend_logs" => encode(
            crate::commands::view_append_frontend_logs(
                reference,
                arg(&args, "requests")?,
                registry(app),
            )
            .await,
        ),
        "view_open_frontend_log" => encode(
            crate::commands::view_open_frontend_log(
                arg(&args, "viewId")?,
                reference,
                registry(app),
            )
            .await,
        ),
        "unity_serialized_property_read" => view_request!(unity_serialized_property_read),
        "unity_serialized_property_read_many" => view_request!(unity_serialized_property_read_many),
        "unity_property_objects" => view_request!(unity_property_objects),
        "unity_serialized_property_write" => view_request!(unity_serialized_property_write),
        "unity_serialized_property_discover" => view_request!(unity_serialized_property_discover),
        "unity_serialized_property_apply" => view_request!(unity_serialized_property_apply),
        "check_unity_connection_status" => {
            encode(crate::commands::check_unity_connection_status(reference, registry(app)).await)
        }
        "check_unity_connection" => {
            encode(crate::commands::check_unity_connection(reference, registry(app)).await)
        }
        "search_workspace_assets" => encode(
            crate::commands::search_workspace_assets(
                arg(&args, "query")?,
                arg(&args, "roots")?,
                arg(&args, "limit")?,
                reference,
                registry(app),
            )
            .await,
        ),
        "unity_assets_execute" => encode(
            crate::commands::unity_assets_execute_borrowed(
                app,
                reference,
                arg(&args, "request")?,
                registry(app),
            )
            .await,
        ),
        "view_watch" => {
            let token: String = arg(&args, "token")?;
            let view: String = arg(&args, "viewId")?;
            let label: String = arg(&args, "hostLabel")?;
            let mut watches = s.watches.lock().unwrap();
            if label != format!("view-native-{}", s.id)
                || token.len() > 128
                || watches.len() >= 24
                || watches.contains_key(&token)
            {
                return Err("Invalid native watcher lease".into());
            }
            crate::view::register_native_view_host(app, &root, &reference, &view, &token, &label)?;
            watches.insert(token, (view, label));
            Ok(Value::Null)
        }
        "view_unwatch" => {
            let token: String = arg(&args, "token")?;
            if let Some((view, label)) = s.watches.lock().unwrap().remove(&token) {
                crate::view::release_native_view_host(&reference, &view, &token, &label);
            }
            Ok(Value::Null)
        }
        _ => Err(format!(
            "Command '{command}' is not available in a native Unity View"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn events_require_full_workspace_identity() {
        let r = WorkspaceRef::new(
            crate::workspace_service::CheckoutId::new("test").unwrap(),
            Some(2),
        )
        .with_materialization_epoch(Some(3));
        assert!(event_matches(
            &r,
            &json!({"checkoutId":"test","workspaceGeneration":2,"materializationEpoch":3})
        ));
        assert!(!event_matches(
            &r,
            &json!({"checkoutId":"test","workspaceGeneration":2,"materializationEpoch":4})
        ));
    }
    #[test]
    fn rejects_cross_origin_and_dns_rebinding_hosts() {
        let origin = "http://127.0.0.1:12345";
        for (host, request_origin, expected) in [
            ("127.0.0.1:12345", None, true),
            ("127.0.0.1:12345", Some(origin), true),
            ("127.0.0.1:12345", Some("https://example.com"), false),
            ("evil.example:12345", None, false),
            ("127.0.0.1:12346", None, false),
        ] {
            let mut request = Request::builder().header("host", host);
            if let Some(value) = request_origin {
                request = request.header("origin", value);
            }
            assert_eq!(
                valid_request_host(&request.body(()).unwrap(), origin),
                expected
            );
        }
    }
    #[test]
    fn event_backlog_has_count_and_byte_limits() {
        let mut queue = EventQueue::default();
        for n in 0..150 {
            queue.push(json!(n), 1);
        }
        assert_eq!(queue.entries.len(), 128);
        assert_eq!(queue.entries.front().unwrap().1, json!(22));
        queue.push(json!("large"), MAX_BODY);
        assert_eq!(queue.entries.len(), 1);
        assert_eq!(queue.bytes, MAX_BODY);
        queue.push(json!("oversized"), MAX_BODY + 1);
        assert_eq!(queue.entries.len(), 1);
        assert_eq!(queue.drain(), vec![json!("large")]);
        assert_eq!(queue.bytes, 0);
    }
}
