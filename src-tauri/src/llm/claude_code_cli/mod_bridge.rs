//! Per-run loopback transport for Claude's in-process Mod. The listener never
//! executes tools: the owning Agent loop drains calls and applies its policies.
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};

#[derive(Default)]
pub struct ControlSignals {
    events: std::sync::Mutex<std::collections::VecDeque<Value>>,
    changed: tokio::sync::Notify,
    interruptions: std::sync::atomic::AtomicU64,
}
impl ControlSignals {
    pub fn route(&self, payload:&Value, options:&Arc<std::sync::RwLock<Value>>) -> Option<Value> {
        if !matches!(payload["type"].as_str(),Some("input_ready"|"input_images"|"input_staging_error"|"input_queued"|"input_consumed"|"turn_interrupted")) {return None;}
        let options=options.read().unwrap_or_else(|e|e.into_inner());
        if options["active"]!=true || payload["runId"]!=options["inputId"] {return Some(json!({"deny":"Stale Claude input control"}));}
        if matches!(payload["type"].as_str(),Some("input_ready"|"input_images"|"input_staging_error"))
            && (payload["id"].as_str().is_none() || (payload["id"]!=options["inputId"] && payload["id"]!=options["insertion"]["inputId"])) {
            return Some(json!({"deny":"Stale Claude input preparation"}));
        }
        let mut events=self.events.lock().unwrap_or_else(|e|e.into_inner());
        if events.len()>=64 {events.pop_front();}
        events.push_back(payload.clone());
        if payload["type"]=="turn_interrupted" {self.interruptions.fetch_add(1,std::sync::atomic::Ordering::SeqCst);}
        self.changed.notify_waiters();
        Some(json!({"ok":true}))
    }
    pub fn contains(&self,kind:&str,id:&str,count:Option<u64>)->bool {
        self.events.lock().unwrap_or_else(|e|e.into_inner()).iter().any(|event|event["type"]==kind && event["id"]==id && count.is_none_or(|count|event["count"].as_u64()==Some(count)))
    }
    pub async fn wait(&self,kind:&str,id:&str,count:Option<u64>){
        loop{let changed=self.changed.notified();if self.contains(kind,id,count){return;}changed.await;}
    }
    pub async fn input_receipt(&self, id: &str) -> Result<Value, String> {
        loop {
            let changed = self.changed.notified();
            if let Some(receipt) = self.events.lock().unwrap_or_else(|e|e.into_inner()).iter()
                .find(|event|event["type"]=="input_consumed" && event["id"]==id).cloned() {
                super::recovery::validate_input_checkpoint(&receipt["checkpoint"])?;
                return Ok(receipt["checkpoint"].clone());
            }
            changed.await;
        }
    }
    pub async fn wait_input(&self,kind:&str,id:&str,count:Option<u64>)->Result<(),String> {
        loop {
            let changed=self.changed.notified();
            {
                let events=self.events.lock().unwrap_or_else(|e|e.into_inner());
                if let Some(error)=events.iter().find(|event|event["type"]=="input_staging_error" && event["id"]==id) {
                    return Err(error["error"].as_str().unwrap_or("Claude could not prepare image attachments").to_string());
                }
                if events.iter().any(|event|event["type"]==kind && event["id"]==id && count.is_none_or(|count|event["count"].as_u64()==Some(count))) {
                    return Ok(());
                }
            }
            changed.await;
        }
    }
    pub fn interruption_epoch(&self)->u64 {self.interruptions.load(std::sync::atomic::Ordering::SeqCst)}
    pub async fn interrupted_after(&self,epoch:u64){
        loop{let changed=self.changed.notified();if self.interruption_epoch()!=epoch{return;}changed.await;}
    }
}
type Receipts =
    Arc<tokio::sync::Mutex<std::collections::HashMap<String, oneshot::Receiver<Value>>>>;

fn options_view(options: &Value, view: Option<&str>) -> Value {
    match view {
        Some("input") => {
            let mut value = json!({"active":options["active"],"inputId":options["inputId"],"terminalText":options["terminalText"],"imageCount":options["imageCount"]});
            if options["insertion"].is_object() {
                value["insertion"] = json!({"inputId":options["insertion"]["inputId"],"terminalText":options["insertion"]["terminalText"],"imageCount":options["insertion"]["imageCount"]});
            }
            value
        },
        Some("prompt") => json!({"systemPrompt":options["systemPrompt"]}),
        Some("session") => json!({"active":options["active"],"attachmentMappings":options["attachmentMappings"]}),
        _ => options.clone(),
    }
}

pub struct PendingCall {
    pub payload: Value,
    pub reply: oneshot::Sender<Value>,
    pub received_at: tokio::time::Instant,
}

pub struct ModBridge {
    pub url: String,
    pub token: String,
    pub calls: mpsc::Receiver<PendingCall>,
    pub options: Arc<std::sync::RwLock<Value>>,
    pub controls: Arc<ControlSignals>,
    task: Option<JoinHandle<()>>,
}

impl ModBridge {
    /// SSH supplies the same typed calls without opening a local network port.
    pub fn channel() -> (Self, mpsc::Sender<PendingCall>) {
        let (send, calls) = mpsc::channel(16);
        (Self {
            url: String::new(), token: uuid::Uuid::new_v4().to_string(), calls,
            options: Arc::new(std::sync::RwLock::new(json!({"transport":"tui","active":false}))),
            controls: Arc::new(ControlSignals::default()),
            task: None,
        }, send)
    }

    pub async fn start() -> Result<Self, String> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| e.to_string())?;
        let address = listener.local_addr().map_err(|e| e.to_string())?;
        let token = uuid::Uuid::new_v4().to_string();
        let auth = Arc::new(format!("Bearer {token}"));
        let expected_host = Arc::new(address.to_string());
        let (send, calls) = mpsc::channel(16);
        let options = Arc::new(std::sync::RwLock::new(
            json!({"transport":"stream","active":true}),
        ));
        let shared_options = options.clone();
        let controls=Arc::new(ControlSignals::default());
        let shared_controls=controls.clone();
        let receipts: Receipts =
            Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
        let task = tokio::spawn(async move {
            // JoinSet aborts all accepted connections when the run drops.
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{
                        let Ok((stream,_))=accepted else { break; };
                        // Stream callbacks exchange tiny headers/body frames.
                        // Avoid Nagle/delayed-ACK stalls on the loopback bridge.
                        let _ = stream.set_nodelay(true);
                        if connections.len()>=32 { drop(stream); continue; }
                        let auth=auth.clone();
                        let expected_host=expected_host.clone();
                        let send=send.clone();
                        let options=shared_options.clone();
                        let receipts=receipts.clone();
                        let controls=shared_controls.clone();
                        connections.spawn(async move {
                            let service=hyper::service::service_fn(move |req| {
                                handle(req,auth.clone(),expected_host.clone(),send.clone(),options.clone(),receipts.clone(),controls.clone())
                            });
                            let _=hyper::server::conn::http1::Builder::new()
                                .serve_connection(TokioIo::new(stream),service).await;
                        });
                    }
                    _=connections.join_next(),if !connections.is_empty()=>{}
                }
            }
        });
        Ok(Self {
            url: format!("http://{address}"),
            token,
            calls,
            options,
            controls,
            task: Some(task),
        })
    }
}

impl Drop for ModBridge {
    fn drop(&mut self) {
        if let Some(task) = &self.task { task.abort(); }
    }
}

fn response(status: StatusCode, value: Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(Full::new(Bytes::from(value.to_string())))
        .expect("static HTTP response")
}

async fn handle(
    req: Request<Incoming>,
    auth: Arc<String>,
    host: Arc<String>,
    send: mpsc::Sender<PendingCall>,
    options: Arc<std::sync::RwLock<Value>>,
    receipts: Receipts,
    controls: Arc<ControlSignals>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let fail = |status, message| Ok(response(status, json!({"error":message})));
    if req
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        != Some(auth.as_str())
    {
        return fail(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    if req.headers().contains_key("origin")
        || req.headers().get("host").and_then(|h| h.to_str().ok()) != Some(host.as_str())
    {
        return fail(StatusCode::FORBIDDEN, "Invalid origin or host");
    }
    let ready = req.uri().path() == "/ready";
    let event = req.uri().path() == "/event";
    let configuration = req.uri().path() == "/options";
    let polling = req.uri().path() == "/poll";
    if req.method() != Method::POST
        || (!ready && !event && !configuration && !polling && req.uri().path() != "/call")
        || req.uri().query().is_some()
    {
        return fail(StatusCode::NOT_FOUND, "Unknown bridge endpoint");
    }
    let body = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        Limited::new(req.into_body(), 1024 * 1024).collect(),
    )
    .await
    {
        Ok(Ok(body)) => body.to_bytes(),
        _ => {
            return fail(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Invalid or oversized request body",
            )
        }
    };
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return fail(StatusCode::BAD_REQUEST, "Invalid JSON"),
    };
    if payload["protocol"] != 1 {
        return fail(StatusCode::BAD_REQUEST, "Invalid bridge protocol");
    }
    if let Some(reply)=controls.route(&payload,&options) {return Ok(response(StatusCode::OK,reply));}
    if polling {
        let Some(ticket) = payload["ticket"].as_str() else {
            return fail(StatusCode::BAD_REQUEST, "Missing receipt");
        };
        let Some(receiver) = receipts.lock().await.remove(ticket) else {
            return fail(
                StatusCode::GONE,
                "Receipt expired or already consumed; do not resubmit the operation",
            );
        };
        return Ok(receipt_response(
            receipts,
            ticket.to_string(),
            receiver,
            std::time::Duration::from_secs(10),
        )
        .await);
    }
    if configuration {
        return Ok(response(
            StatusCode::OK,
            options_view(&options.read().unwrap_or_else(|e| e.into_inner()), payload["view"].as_str()),
        ));
    }
    if payload["protocol"] != 1
        || (!ready
            && !event
            && (!payload["tool"].is_string()
                || !payload["callId"].as_str().is_some_and(|id| !id.is_empty())
                || !payload["input"].is_object()))
    {
        return fail(StatusCode::BAD_REQUEST, "Invalid tool call envelope");
    }
    let payload = if ready {
        json!({"ready":true,"sessionId":payload["sessionId"],"model":payload["model"]})
    } else {
        payload
    };
    let (reply, receive) = oneshot::channel();
    if receipts.lock().await.len() >= 64 {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Too many unconsumed local results",
        );
    }
    if send
        .try_send(PendingCall {
            payload,
            reply,
            received_at: tokio::time::Instant::now(),
        })
        .is_err()
    {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Locus run is closed or busy; do not automatically retry",
        );
    }
    Ok(receipt_response(
        receipts,
        uuid::Uuid::new_v4().to_string(),
        receive,
        std::time::Duration::from_millis(100),
    )
    .await)
}

async fn receipt_response(
    receipts: Receipts,
    ticket: String,
    mut receiver: oneshot::Receiver<Value>,
    wait: std::time::Duration,
) -> Response<Full<Bytes>> {
    match tokio::time::timeout(wait, &mut receiver).await {
        Ok(Ok(value)) => response(StatusCode::OK, value),
        Ok(Err(_)) => response(
            StatusCode::GONE,
            json!({"error":"Locus run ended; execution outcome may be unknown"}),
        ),
        Err(_) => {
            receipts.lock().await.insert(ticket.clone(), receiver);
            response(StatusCode::ACCEPTED, json!({"pending":ticket}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn claude_input_receipts_require_native_identity_and_interruption_is_execution_scoped() {
        let controls=ControlSignals::default();
        let options=Arc::new(std::sync::RwLock::new(json!({"active":true,"inputId":"run"})));
        controls.route(&json!({"type":"turn_interrupted","runId":"run","id":"execution-1"}),&options);
        controls.wait("turn_interrupted","execution-1",None).await;
        assert!(tokio::time::timeout(std::time::Duration::from_millis(10),controls.wait("turn_interrupted","execution-2",None)).await.is_err());
        controls.route(&json!({"type":"input_consumed","runId":"run","id":"bad"}),&options);
        assert!(controls.input_receipt("bad").await.is_err());
        let checkpoint=json!({"version":1,"uuid":uuid::Uuid::new_v4(),"sessionId":uuid::Uuid::new_v4()});
        controls.route(&json!({"type":"input_consumed","runId":"run","id":"good","checkpoint":checkpoint}),&options);
        assert_eq!(controls.input_receipt("good").await.unwrap(),checkpoint);
    }
    #[test]
    fn input_poll_does_not_copy_the_catalog_or_user_prompt() {
        let options = json!({"active":true,"inputId":"run","terminalText":"input","imageCount":2,"tools":["catalog"],
            "systemPrompt":"system","prompt":"user","attachmentMappings":["paths"],
            "insertion":{"inputId":"insert","terminalText":"new","imageCount":1,"prompt":"draft"}});
        assert_eq!(options_view(&options,Some("input")),json!({"active":true,"inputId":"run","terminalText":"input","imageCount":2,
            "insertion":{"inputId":"insert","terminalText":"new","imageCount":1}}));
        assert_eq!(options_view(&options,Some("session")),json!({"active":true,"attachmentMappings":["paths"]}));
        assert_eq!(options_view(&options,Some("prompt")),json!({"systemPrompt":"system"}));
        assert_eq!(options_view(&options,None),options);
    }
    #[tokio::test]
    async fn image_controls_reject_stale_inputs_and_surface_preparation_errors() {
        let controls = ControlSignals::default();
        let options = Arc::new(std::sync::RwLock::new(json!({"active":true,"inputId":"run","insertion":{"inputId":"insert"}})));
        let event = json!({"type":"input_images","runId":"run","id":"insert","count":1});
        assert_eq!(controls.route(&event, &options), Some(json!({"ok":true})));
        assert!(controls.contains("input_images", "insert", Some(1)));
        assert!(!controls.contains("input_images", "insert", Some(2)));
        for bad in [json!({"runId":"old","id":"insert"}), json!({"runId":"run","id":"old"})] {
            let rejected = json!({"type":"input_images","runId":bad["runId"],"id":bad["id"],"count":2});
            assert!(controls.route(&rejected, &options).unwrap()["deny"].is_string());
        }
        let wait = controls.wait_input("input_ready", "insert", None);
        let fail = async {
            controls.route(&json!({"type":"input_staging_error","runId":"run","id":"insert","error":"Native decode failed"}), &options);
        };
        let (result, ()) = tokio::join!(wait, fail);
        assert_eq!(result, Err("Native decode failed".into()));
    }
    #[tokio::test]
    async fn long_tools_poll_one_submission_without_reexecution() {
        let mut bridge = ModBridge::start().await.unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let pending: Value = client
            .post(format!("{}/call", bridge.url))
            .bearer_auth(&bridge.token)
            .json(&json!({"protocol":1,"tool":"AskUserQuestion","callId":"ask1","input":{}}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(pending["pending"].is_string());
        let call = bridge.calls.recv().await.unwrap();
        let poll = client
            .post(format!("{}/poll", bridge.url))
            .bearer_auth(&bridge.token)
            .json(&json!({"protocol":1,"ticket":pending["pending"]}))
            .send();
        let answer = async {
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            call.reply
                .send(json!({"callId":"ask1","result":"answered"}))
                .unwrap();
        };
        let (result, ()) = tokio::join!(poll, answer);
        assert_eq!(
            result.unwrap().json::<Value>().await.unwrap()["result"],
            "answered"
        );
        assert!(bridge.calls.try_recv().is_err());
    }
    #[tokio::test]
    async fn bridge_authenticates_and_preserves_call_identity() {
        let mut bridge = ModBridge::start().await.unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = format!("{}/call", bridge.url);
        assert_eq!(
            client
                .post(&url)
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        let body = json!({"protocol":1,"callId":"toolu_a","tool":"Read","input":{"file_path":"a"}});
        let request = client
            .post(&url)
            .bearer_auth(&bridge.token)
            .json(&body)
            .send();
        let handler = async {
            let call = bridge.calls.recv().await.unwrap();
            assert_eq!(call.payload, body);
            call.reply
                .send(json!({"callId":"toolu_a","deny":"not approved"}))
                .unwrap();
        };
        let (reply, ()) = tokio::join!(request, handler);
        assert_eq!(
            reply.unwrap().json::<Value>().await.unwrap()["deny"],
            "not approved"
        );
        assert_eq!(
            client
                .post(&url)
                .bearer_auth(&bridge.token)
                .header("Origin", "http://example.com")
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
    }
}
