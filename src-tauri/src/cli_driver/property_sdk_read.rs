//! Read-only, serial Python SDK / HTTP regression for the Release stack limit.
//! LOCUS_PROPERTY_SDK_PATHS is a JSON array of asset-qualified Prefab paths.
use super::*;

pub(super) async fn run(
    app: &AppHandle,
    project: &str,
    config: &CliDriverConfig,
    sink: &DriverEventSink,
) -> Result<(), String> {
    let paths = std::env::var("LOCUS_PROPERTY_SDK_PATHS")
        .map_err(|_| "Set LOCUS_PROPERTY_SDK_PATHS to a JSON array of Prefab paths".to_string())?;
    let parsed: Vec<String> = serde_json::from_str(&paths).map_err(|e| e.to_string())?;
    if parsed.is_empty()
        || parsed
            .iter()
            .any(|p| !p.starts_with("Assets/") || !p.contains(".prefab"))
    {
        return Err("LOCUS_PROPERTY_SDK_PATHS must contain asset-qualified Prefab paths".into());
    }
    let registry = app.state::<Arc<crate::workspace_service::ProjectRegistry>>();
    let runtime = registry.register(project)?;
    let repeats = std::env::var("LOCUS_PROPERTY_SDK_REPEATS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(5)
        .clamp(1, 100);
    sink.emit(
        "suite_start",
        json!({"suite":"property-sdk-read","project":project,"paths":parsed,"repeats":repeats}),
    );
    let output = run_python_sdk_script(
        app,
        project,
        include_str!("property_sdk_read.py.txt"),
        &[
            serde_json::to_string(&crate::workspace_service::WorkspaceRef::for_runtime(
                &runtime,
            ))
            .map_err(|e| e.to_string())?,
            paths,
            repeats.to_string(),
        ],
        config.suite_timeout,
        "Property Tree SDK stack regression",
    )
    .await;
    match output {
        Ok(output) => {
            let details = output
                .lines()
                .find_map(|line| line.strip_prefix("PROPERTY_SDK_RESULT "))
                .ok_or_else(|| format!("SDK regression result missing: {output}"))?;
            let details: Value = serde_json::from_str(details).map_err(|e| e.to_string())?;
            sink.emit("suite_result", json!({"suite":"property-sdk-read","passed":details["requests"],"failed":0,"details":details}));
            Ok(())
        }
        Err(error) => {
            sink.emit(
                "suite_result",
                json!({"suite":"property-sdk-read","passed":0,"failed":1,"error":error}),
            );
            Err(error)
        }
    }
}
