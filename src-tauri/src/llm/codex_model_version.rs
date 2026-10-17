//! /models uses the CLI/app-server version, not the desktop app's 26.x build.
//! The official npm `latest` tag tracks stable CLI releases on every platform.
use super::{now_ms, CODEX_CLIENT_VERSION};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

const STABLE_RELEASE_URL: &str = "https://registry.npmjs.org/@openai/codex/latest";
const VERSION_CACHE_FILE: &str = "codex_client_version_cache.json";
const VERSION_CHECK_TTL_MS: i64 = 6 * 60 * 60 * 1_000;
const VERSION_RETRY_TTL_MS: i64 = 5 * 60 * 1_000;
const VERSION_CHECK_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Serialize, Deserialize)]
struct VersionCache {
    version: String,
    check_after_ms: i64,
}

pub(super) fn supported_version(raw: &str) -> Option<String> {
    let version = semver::Version::parse(raw).ok()?;
    let baseline = semver::Version::parse(CODEX_CLIENT_VERSION).ok()?;
    (version.pre.is_empty() && version.build.is_empty() && version >= baseline)
        .then(|| version.to_string())
}

pub(super) async fn resolve(cache_dir: &Path, force_refresh: bool) -> String {
    resolve_from(cache_dir, force_refresh, STABLE_RELEASE_URL).await
}

async fn resolve_from(cache_dir: &Path, force_refresh: bool, source: &str) -> String {
    let cached = std::fs::read(cache_dir.join(VERSION_CACHE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<VersionCache>(&bytes).ok())
        .filter(|cache| supported_version(&cache.version).is_some());
    if !force_refresh {
        if let Some(cache) = &cached {
            let remaining = cache.check_after_ms.saturating_sub(now_ms());
            if (1..=VERSION_CHECK_TTL_MS).contains(&remaining) {
                return cache.version.clone();
            }
        }
    }
    match fetch_stable_version(source).await {
        Ok(version) => {
            save(cache_dir, &version, VERSION_CHECK_TTL_MS);
            version
        }
        Err(error) => {
            eprintln!("[OpenAI Codex] client version check failed; using fallback: {error}");
            let version = cached
                .map(|c| c.version)
                .or_else(|| {
                    super::load_cache(cache_dir)
                        .and_then(|cache| supported_version(&cache.client_version))
                })
                .unwrap_or_else(|| CODEX_CLIENT_VERSION.to_string());
            save(cache_dir, &version, VERSION_RETRY_TTL_MS);
            version
        }
    }
}

async fn fetch_stable_version(source: &str) -> Result<String, String> {
    let client = crate::network::rustls_reqwest_client(
        crate::network::ReqwestClientOptions::new()
            .connect_timeout(VERSION_CHECK_TIMEOUT)
            .timeout(VERSION_CHECK_TIMEOUT),
    )
    .map_err(|error| error.to_string())?;
    // No subscription token or account headers are sent to the registry.
    let mut response = client
        .get(source)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| error.to_string())?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if body.len() + chunk.len() > 256 * 1024 {
            return Err("Codex version response exceeded 256 KiB".into());
        }
        body.extend_from_slice(&chunk);
    }
    #[derive(Deserialize)]
    struct Release {
        name: String,
        version: String,
    }
    let release: Release = serde_json::from_slice(&body).map_err(|error| error.to_string())?;
    if release.name != "@openai/codex" {
        return Err("Unexpected Codex package name".into());
    }
    supported_version(&release.version)
        .ok_or_else(|| "Invalid or outdated Codex stable version".into())
}

// A failed catalog attempt must not repeatedly select the same rejected version.
pub(super) fn remember_fallback(cache_dir: &Path, version: &str) {
    save(cache_dir, version, VERSION_RETRY_TTL_MS);
}

fn save(cache_dir: &Path, version: &str, ttl_ms: i64) {
    let cache = VersionCache {
        version: version.to_string(),
        check_after_ms: now_ms() + ttl_ms,
    };
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        std::fs::create_dir_all(cache_dir)?;
        std::fs::write(
            cache_dir.join(VERSION_CACHE_FILE),
            serde_json::to_vec(&cache)?,
        )?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("[OpenAI Codex] could not save client version cache: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::super::refresh_tests::models_server;
    use super::*;

    #[test]
    fn accepts_only_stable_semver_at_or_above_baseline() {
        assert_eq!(
            supported_version(CODEX_CLIENT_VERSION).as_deref(),
            Some(CODEX_CLIENT_VERSION)
        );
        assert!(supported_version("0.999.0").is_some());
        for invalid in [
            "",
            "0.1.0",
            "v0.999.0",
            "0.999.0-alpha.1",
            "0.999.0+build",
            "1.2.3.4",
            "../version",
            "0.999.0\r\n",
        ] {
            assert!(supported_version(invalid).is_none(), "{invalid:?}");
        }
    }

    #[tokio::test]
    async fn discovers_stable_version_caches_it_and_forced_refresh_checks_again() {
        let dir = tempfile::tempdir().unwrap();
        let (url, server) =
            models_server("200 OK", r#"{"name":"@openai/codex","version":"0.998.0"}"#).await;
        assert_eq!(resolve_from(dir.path(), false, &url).await, "0.998.0");
        let request = server.await.unwrap().to_ascii_lowercase();
        assert!(!request.contains("authorization:"));
        assert!(!request.contains("chatgpt-account-id:"));
        // The first server is now gone: a cache hit must avoid the network.
        assert_eq!(resolve_from(dir.path(), false, &url).await, "0.998.0");
        let (next_url, next_server) =
            models_server("200 OK", r#"{"name":"@openai/codex","version":"0.999.0"}"#).await;
        assert_eq!(resolve_from(dir.path(), true, &next_url).await, "0.999.0");
        next_server.await.unwrap();
    }

    #[tokio::test]
    async fn failed_or_invalid_discovery_uses_cached_version_then_baseline() {
        for (status, body) in [
            ("503 Service Unavailable", "unavailable"),
            ("200 OK", "not json"),
            (
                "200 OK",
                r#"{"name":"another/package","version":"0.999.0"}"#,
            ),
            (
                "200 OK",
                r#"{"name":"@openai/codex","version":"0.999.0-alpha.1"}"#,
            ),
            ("200 OK", r#"{"name":"@openai/codex","version":"0.1.0"}"#),
        ] {
            for cached in [None, Some("0.998.0")] {
                let dir = tempfile::tempdir().unwrap();
                if let Some(version) = cached {
                    save(dir.path(), version, -1);
                }
                let (url, server) = models_server(status, body).await;
                assert_eq!(
                    resolve_from(dir.path(), false, &url).await,
                    cached.unwrap_or(CODEX_CLIENT_VERSION)
                );
                server.await.unwrap();
                // A failed check also has a short TTL, preventing retry storms.
                assert_eq!(
                    resolve_from(dir.path(), false, &url).await,
                    cached.unwrap_or(CODEX_CLIENT_VERSION)
                );
            }
        }
    }

    #[tokio::test]
    async fn failed_discovery_can_recover_version_from_last_successful_model_catalog() {
        let dir = tempfile::tempdir().unwrap();
        super::super::persist_cache(dir.path(), &[], None, "0.999.0").unwrap();
        std::fs::write(dir.path().join(VERSION_CACHE_FILE), "broken cache").unwrap();
        let (url, server) = models_server("503 Service Unavailable", "unavailable").await;
        assert_eq!(resolve_from(dir.path(), false, &url).await, "0.999.0");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn slow_discovery_times_out_and_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let version = tokio::time::timeout(
            Duration::from_secs(6),
            resolve_from(dir.path(), false, &url),
        )
        .await;
        server.abort();
        assert_eq!(version.unwrap(), CODEX_CLIENT_VERSION);
    }
}
