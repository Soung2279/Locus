use super::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const NEXT_VERSION: &str = "0.999.0";
const PREVIOUS_VERSION: &str = "0.998.0";

fn assert_request_version(request: &str, version: &str) {
    assert!(request.starts_with(&format!("GET /models?client_version={version} ")));
    assert!(request
        .to_ascii_lowercase()
        .contains(&format!("version: {version}\r\n")));
}

#[tokio::test]
async fn changed_version_invalidates_fresh_models_and_etag_but_preserves_context_metadata() {
    let dir = tempfile::tempdir().unwrap();
    persist_cache(
        dir.path(),
        &[cached_model()],
        Some("\"old\"".into()),
        CODEX_CLIENT_VERSION,
    )
    .unwrap();
    let (url, server) = models_server(
        "200 OK",
        r#"{"models":[{"slug":"gpt-new","context_window":200000}]}"#,
    )
    .await;
    let models = list_models_with_version(
        "test-token",
        None,
        Some(&url),
        dir.path(),
        false,
        NEXT_VERSION,
    )
    .await
    .unwrap();
    assert_eq!(models[0].id, "openai/gpt-new");
    let request = server.await.unwrap();
    assert_request_version(&request, NEXT_VERSION);
    assert!(!request.to_ascii_lowercase().contains("if-none-match:"));
    assert!(load_fresh_cache(dir.path(), CODEX_CLIENT_VERSION).is_none());
    assert!(load_fresh_cache(dir.path(), NEXT_VERSION).is_some());
    assert_eq!(
        cached_context_limits(dir.path(), "openai/gpt-new")
            .unwrap()
            .effective_context_window,
        190000
    );
}

#[tokio::test]
async fn rejected_latest_version_retries_last_working_version_and_then_baseline() {
    let dir = tempfile::tempdir().unwrap();
    persist_cache(
        dir.path(),
        &[cached_model()],
        Some("\"old\"".into()),
        PREVIOUS_VERSION,
    )
    .unwrap();
    let (url, server) = models_sequence_server(&[
        ("400 Bad Request", "unsupported version"),
        ("503 Service Unavailable", "unavailable"),
        ("200 OK", r#"{"models":[{"slug":"gpt-fallback"}]}"#),
    ])
    .await;
    let models = list_models_with_version(
        "test-token",
        None,
        Some(&url),
        dir.path(),
        true,
        NEXT_VERSION,
    )
    .await
    .unwrap();
    assert_eq!(models[0].id, "openai/gpt-fallback");
    let requests = server.await.unwrap();
    for (request, version) in
        requests
            .iter()
            .zip([NEXT_VERSION, PREVIOUS_VERSION, CODEX_CLIENT_VERSION])
    {
        assert_request_version(request, version);
    }
    assert!(!requests[0].to_ascii_lowercase().contains("if-none-match:"));
    assert!(requests[1]
        .to_ascii_lowercase()
        .contains("if-none-match: \"old\""));
    assert!(!requests[2].to_ascii_lowercase().contains("if-none-match:"));
    assert_eq!(
        load_cache(dir.path()).unwrap().client_version,
        CODEX_CLIENT_VERSION
    );
    assert_eq!(
        client_version::resolve(dir.path(), false).await,
        CODEX_CLIENT_VERSION
    );
}

#[tokio::test]
async fn fallback_can_revalidate_last_working_catalog_with_304() {
    let dir = tempfile::tempdir().unwrap();
    persist_cache(
        dir.path(),
        &[cached_model()],
        Some("\"old\"".into()),
        PREVIOUS_VERSION,
    )
    .unwrap();
    let (url, server) = models_sequence_server(&[
        ("400 Bad Request", "unsupported version"),
        ("304 Not Modified", ""),
    ])
    .await;
    let models = list_models_with_version(
        "test-token",
        None,
        Some(&url),
        dir.path(),
        true,
        NEXT_VERSION,
    )
    .await
    .unwrap();
    assert_eq!(models[0].id, "openai/gpt-existing");
    assert_eq!(
        load_cache(dir.path()).unwrap().client_version,
        PREVIOUS_VERSION
    );
    assert_eq!(
        client_version::resolve(dir.path(), false).await,
        PREVIOUS_VERSION
    );
    assert_request_version(&server.await.unwrap()[1], PREVIOUS_VERSION);
}

#[tokio::test]
async fn invalid_catalogs_and_cross_version_304_fall_back_without_relabeling_old_cache() {
    for (status, body) in [
        ("200 OK", "{}"),
        ("200 OK", r#"{"models":[]}"#),
        ("304 Not Modified", ""),
    ] {
        let dir = tempfile::tempdir().unwrap();
        persist_cache(
            dir.path(),
            &[cached_model()],
            Some("\"old\"".into()),
            CODEX_CLIENT_VERSION,
        )
        .unwrap();
        let (url, server) =
            models_sequence_server(&[(status, body), ("304 Not Modified", "")]).await;
        let models = list_models_with_version(
            "test-token",
            None,
            Some(&url),
            dir.path(),
            true,
            NEXT_VERSION,
        )
        .await
        .unwrap();
        assert_eq!(models[0].id, "openai/gpt-existing");
        assert_eq!(
            load_cache(dir.path()).unwrap().client_version,
            CODEX_CLIENT_VERSION
        );
        assert!(!server.await.unwrap()[0]
            .to_ascii_lowercase()
            .contains("if-none-match:"));
    }
}

#[tokio::test]
async fn failed_fallbacks_keep_the_last_catalog_and_manual_refresh_reports_failure() {
    for force_refresh in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        persist_cache(dir.path(), &[cached_model()], None, CODEX_CLIENT_VERSION).unwrap();
        let original = std::fs::read(cache_path(dir.path())).unwrap();
        let (url, server) = models_sequence_server(&[
            ("503 Service Unavailable", "failed"),
            ("503 Service Unavailable", "failed"),
        ])
        .await;
        let result = list_models_with_version(
            "test-token",
            None,
            Some(&url),
            dir.path(),
            force_refresh,
            NEXT_VERSION,
        )
        .await;
        if force_refresh {
            assert!(result.unwrap_err().contains("503"));
        } else {
            assert_eq!(result.unwrap()[0].id, "openai/gpt-existing");
        }
        assert_eq!(std::fs::read(cache_path(dir.path())).unwrap(), original);
        server.await.unwrap();
    }
}

#[tokio::test]
async fn disabled_auto_version_ignores_discovered_version_and_its_catalog() {
    let dir = tempfile::tempdir().unwrap();
    client_version::remember_fallback(dir.path(), NEXT_VERSION);
    persist_cache(
        dir.path(),
        &[cached_model()],
        Some("\"old\"".into()),
        NEXT_VERSION,
    )
    .unwrap();
    let (url, server) = models_server("200 OK", r#"{"models":[{"slug":"gpt-baseline"}]}"#).await;
    let models =
        list_codex_available_models("test-token", None, Some(&url), dir.path(), false, false)
            .await
            .unwrap();
    assert_eq!(models[0].id, "openai/gpt-baseline");
    assert_request_version(&server.await.unwrap(), CODEX_CLIENT_VERSION);
}

fn cached_model() -> CodexRemoteModel {
    serde_json::from_value(serde_json::json!({
        "slug": "gpt-existing",
        "visibility": "list"
    }))
    .unwrap()
}

pub(super) async fn models_server(
    status: &str,
    body: &str,
) -> (String, tokio::task::JoinHandle<String>) {
    let (url, server) = models_sequence_server(&[(status, body)]).await;
    (
        url,
        tokio::spawn(async move { server.await.unwrap().remove(0) }),
    )
}

async fn models_sequence_server(
    responses: &[(&str, &str)],
) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let responses: Vec<_> = responses.iter().map(|(status, body)| format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nETag: \"new\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )).collect();
    let server = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(10), async move {
            let mut requests = Vec::new();
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(&mut socket);
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
                    let done = line == "\r\n";
                    request.push_str(&line);
                    if done {
                        break;
                    }
                }
                socket.write_all(response.as_bytes()).await.unwrap();
                requests.push(request);
            }
            requests
        })
        .await
        .expect("models request timed out")
    });
    (base_url, server)
}

#[tokio::test]
async fn explicit_refresh_fetches_and_replaces_a_fresh_cache() {
    let dir = tempfile::tempdir().unwrap();
    persist_cache(
        dir.path(),
        &[cached_model()],
        Some("\"old\"".into()),
        CODEX_CLIENT_VERSION,
    )
    .unwrap();
    let (base_url, server) = models_server(
        "200 OK",
        r#"{"models":[{"slug":"gpt-new","visibility":"list"}]}"#,
    )
    .await;

    let cached = list_codex_available_models(
        "test-token",
        None,
        Some(&base_url),
        dir.path(),
        false,
        false,
    )
    .await
    .unwrap();
    assert_eq!(cached[0].id, "openai/gpt-existing");

    let refreshed = list_codex_available_models(
        "test-token",
        Some("test-account"),
        Some(&base_url),
        dir.path(),
        true,
        false,
    )
    .await
    .unwrap();
    assert_eq!(refreshed[0].id, "openai/gpt-new");
    assert_eq!(
        load_fresh_cache(dir.path(), CODEX_CLIENT_VERSION)
            .unwrap()
            .models[0]
            .slug,
        "gpt-new"
    );

    let request = server.await.unwrap().to_ascii_lowercase();
    assert!(request.starts_with(&format!(
        "get /models?client_version={} ",
        CODEX_CLIENT_VERSION
    )));
    assert!(request.contains("authorization: bearer test-token\r\n"));
    assert!(request.contains("chatgpt-account-id: test-account\r\n"));
    assert!(request.contains("if-none-match: \"old\"\r\n"));
}

#[tokio::test]
async fn explicit_refresh_accepts_a_not_modified_response() {
    let dir = tempfile::tempdir().unwrap();
    persist_cache(
        dir.path(),
        &[cached_model()],
        Some("\"old\"".into()),
        CODEX_CLIENT_VERSION,
    )
    .unwrap();
    let (base_url, server) = models_server("304 Not Modified", "").await;

    let models =
        list_codex_available_models("test-token", None, Some(&base_url), dir.path(), true, false)
            .await
            .unwrap();

    assert_eq!(models[0].id, "openai/gpt-existing");
    assert!(load_fresh_cache(dir.path(), CODEX_CLIENT_VERSION).is_some());
    assert!(server
        .await
        .unwrap()
        .to_ascii_lowercase()
        .contains("if-none-match: \"old\"\r\n"));
}

#[tokio::test]
async fn explicit_refresh_reports_errors_and_preserves_the_cache() {
    let dir = tempfile::tempdir().unwrap();
    persist_cache(
        dir.path(),
        &[cached_model()],
        Some("\"old\"".into()),
        CODEX_CLIENT_VERSION,
    )
    .unwrap();
    let original = std::fs::read(cache_path(dir.path())).unwrap();
    let (base_url, server) = models_server("503 Service Unavailable", "unavailable").await;

    let result =
        list_codex_available_models("test-token", None, Some(&base_url), dir.path(), true, false)
            .await;

    assert!(result.unwrap_err().contains("503"));
    assert_eq!(std::fs::read(cache_path(dir.path())).unwrap(), original);
    server.await.unwrap();
}
