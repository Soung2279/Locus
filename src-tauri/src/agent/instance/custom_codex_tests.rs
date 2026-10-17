use super::*;
use futures::SinkExt;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

fn provider(endpoint: &str, transport: Value) -> crate::commands::CustomProvider {
    serde_json::from_value(json!({
        "id":"cpa", "name":"CPA", "endpoint":endpoint, "apiFormat":"openai_responses",
        "models":[{"id":"luna", "name":"Luna", "apiModel":"gpt-6-luna",
            "contextLength":272000, "codexTransport":transport, "supportsToolLazyLoading":true}]
    }))
    .unwrap()
}

fn message(id: &str, role: &str, content: &str) -> ChatMessage {
    serde_json::from_value(json!({"id":id,"role":role,"content":content,"createdAt":0})).unwrap()
}

async fn read(ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> Value {
    let frame = tokio::time::timeout(Duration::from_secs(10), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(frame.to_text().unwrap()).unwrap()
}

async fn send(ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, value: Value) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

#[test]
fn custom_codex_opt_in_preserves_generic_routes_and_uses_upstream_model_capabilities() {
    let temp = tempfile::tempdir().unwrap();
    let mut instance = super::super::tests::native_plan_test_instance(&temp);
    for (transport, enabled) in [
        (Value::Null, false),
        (json!("websocket"), true),
        (json!("http"), true),
    ] {
        let mut config = provider("http://127.0.0.1:8317/v1", transport);
        let model = config.models.remove(0);
        instance.backend = crate::commands::custom_backend_from_config(config, model, "key".into());
        instance.effective_model = "custom/cpa/luna".into();
        assert_eq!(instance.uses_codex_protocol(), enabled);
        assert_eq!(instance.uses_codex_remote_compaction(), enabled);
        assert_eq!(
            instance
                .resolve_lazy_tool_renderer(crate::config::DynamicToolLoadingMode::Native, false),
            if enabled {
                LazyToolRenderer::CodexNative
            } else {
                LazyToolRenderer::ToolLoadFallback
            }
        );
        if enabled {
            assert_eq!(
                instance.context_limits().codex_auto_compact_token_limit,
                Some(244_800)
            );
        }
    }
}

#[tokio::test]
async fn custom_codex_websocket_reuses_inference_connection_for_compaction_and_replay() {
    tokio::time::timeout(Duration::from_secs(20), websocket_round_trip())
        .await
        .expect("gateway protocol test timed out");
}

async fn websocket_round_trip() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
        config.extensions.permessage_deflate = Some(
            tokio_tungstenite::tungstenite::extensions::compression::deflate::DeflateConfig::default(),
        );
        let mut ws = tokio_tungstenite::accept_hdr_async_with_config(
            tcp,
            |req: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                assert_eq!(req.uri().path(), "/v1/responses");
                assert_eq!(req.headers()["authorization"], "Bearer gateway-test-key");
                assert!(!req.headers().contains_key("chatgpt-account-id"));
                Ok(response)
            },
            Some(config),
        )
        .await
        .unwrap();
        let warm = read(&mut ws).await;
        assert_eq!(warm["generate"], false);
        assert!(warm["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["type"] == "tool_search"));
        send(
            &mut ws,
            json!({"type":"response.completed","headers":{"x-codex-turn-state":"sticky"},
            "response":{"id":"warm","output":[]}}),
        )
        .await;
        let first = read(&mut ws).await;
        assert_eq!(first["previous_response_id"], "warm");
        send(&mut ws, json!({"type":"response.completed","response":{"id":"first","output":[
            {"id":"rs_first","type":"reasoning","encrypted_content":"reasoning-opaque","summary":[]},
            {"id":"msg_first","type":"message","role":"assistant","content":[{"type":"output_text","text":"Ready"}]}]}})).await;
        let compact = read(&mut ws).await;
        assert_eq!(compact["previous_response_id"], "first");
        assert_eq!(compact["input"], json!([{"type":"compaction_trigger"}]));
        assert_eq!(compact["client_metadata"]["x-codex-turn-state"], "sticky");
        send(
            &mut ws,
            json!({"type":"response.completed","response":{"id":"compact","output":[
            {"type":"compaction","encrypted_content":"checkpoint-opaque"}]}}),
        )
        .await;
        let replay = read(&mut ws).await;
        assert!(replay.get("previous_response_id").is_none());
        assert_eq!(replay["tools"], warm["tools"]);
        assert!(replay["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["encrypted_content"] == "checkpoint-opaque"));
        send(
            &mut ws,
            json!({"type":"response.completed","response":{"id":"continued","output":[]}}),
        )
        .await;
    });
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::new(temp.path()).unwrap();
    let mut instance = super::super::tests::native_plan_test_instance(&temp);
    instance.session_id = store
        .create_session("CPA", None, None, "chat", None)
        .unwrap();
    instance.effective_model = "custom/cpa/luna".into();
    let mut config = provider(&endpoint, json!("websocket"));
    let model = config.models.remove(0);
    instance.backend =
        crate::commands::custom_backend_from_config(config, model, "gateway-test-key".into());
    let tools = PreparedRequestTools {
        request_tool_names: vec![],
        deferred_count: 0,
        api_tools: vec![],
        tool_search_description: Some("Load tools".into()),
    };
    let mut turn = codex::TurnState::default();
    let mut history = vec![message("user", "user", "Remember the task.")];
    let response = instance
        .call_llm(
            &store,
            Some(&mut turn),
            None,
            Some(("run", 1)),
            LlmRequestOptions::default(),
            &["Instructions"],
            &history,
            &tools.api_tools,
            tools.tool_search_description.as_deref(),
            |_| {},
            |_| {},
            |_, _| {},
        )
        .await
        .unwrap();
    let metadata = response.continuation_request.unwrap();
    assert!(metadata.to_string().contains("reasoning-opaque"));
    let assistant_id = store
        .add_message(&instance.session_id, MessageRole::Assistant, &response.text)
        .unwrap();
    store
        .set_message_response_request_metadata(&instance.session_id, &assistant_id, &metadata)
        .unwrap();
    let mut assistant = message(&assistant_id, "assistant", &response.text);
    assistant.response_id = response.response_id;
    history.push(assistant);
    let compacted = instance
        .request_codex_compaction(
            "Instructions",
            &history,
            &tools,
            &mut turn,
            &store
                .get_response_request_metadata(&instance.session_id)
                .unwrap(),
            "run",
            2,
        )
        .await
        .unwrap();
    let handoff = store
        .add_message(&instance.session_id, MessageRole::User, "Context handoff")
        .unwrap();
    store
        .set_message_response_request_metadata(
            &instance.session_id,
            &handoff,
            &codex::compaction_metadata(&compacted),
        )
        .unwrap();
    instance
        .call_llm(
            &store,
            Some(&mut turn),
            None,
            Some(("run", 3)),
            LlmRequestOptions::default(),
            &["Instructions"],
            &[message(&handoff, "user", "Context handoff")],
            &tools.api_tools,
            tools.tool_search_description.as_deref(),
            |_| {},
            |_| {},
            |_, _| {},
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), server)
        .await
        .unwrap()
        .unwrap();
    codex::reset_cached_session_window(&instance.session_id).await;
}
