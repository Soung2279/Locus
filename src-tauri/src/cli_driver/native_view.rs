use super::*;

pub(super) async fn run(
    app: &AppHandle,
    project: &str,
    config: &CliDriverConfig,
    sink: &DriverEventSink,
) -> Result<(), String> {
    let root = Path::new(project);
    if !root.join(".locus-native-view-acceptance.json").is_file() {
        return Err("native-view requires the isolated project created by scripts/locus-native-view-p2-test.mjs".into());
    }
    sink.emit(
        "suite_start",
        json!({"suite":"native-view","project":project}),
    );
    let runtime = app
        .state::<Arc<crate::workspace_service::ProjectRegistry>>()
        .register(root)?;
    let reference = crate::workspace_service::WorkspaceRef::for_runtime(&runtime);
    let (request, temporary) = crate::view::parse_view_create_request(
        json!({"id":"native-acceptance","fileName":"native-acceptance.vue","name":"Native View acceptance","component":include_str!("native_view_fixture.vue.txt"),"unity":true}),
    )?;
    let detail = crate::view::create_view_sync_with_scope(project, request, temporary)?;
    let connection = crate::native_view::connection(app, reference, &detail.summary.id).await?;
    let connection =
        serde_json::to_string(&serde_json::to_string(&connection).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let code=format!("UnityEditor.EditorApplication.CallbackFunction run = null; run = async () => {{ UnityEditor.EditorApplication.update -= run; await LocusNativeViewP2.Acceptance.Run({connection}); }}; UnityEditor.EditorApplication.update += run; return \"scheduled\";");
    let operation = crate::unity_bridge::unity_execute_code(project, &code);
    let result = tokio::time::timeout(config.suite_timeout, operation)
        .await
        .map_err(|_| "Native View acceptance timed out")??;
    std::fs::write(root.join("native-view-execute-result.txt"), &result)
        .map_err(|e| e.to_string())?;
    let deadline = tokio::time::Instant::now() + config.suite_timeout;
    while !root.join("native-view-complete").is_file() {
        if tokio::time::Instant::now() > deadline {
            return Err("Native View acceptance did not finish".into());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let report: Value = serde_json::from_slice(
        &std::fs::read(root.join("native-view-results.json"))
            .map_err(|e| format!("Native View report missing: {e}; {}", clip(&result, 1200)))?,
    )
    .map_err(|e| e.to_string())?;
    let cases = report["cases"]
        .as_array()
        .ok_or("Native View report has no cases")?;
    let manual = cases.iter().filter(|c| c["manual"] == true).count();
    let failed = cases.iter().filter(|c| c["passed"] != true && c["manual"] != true).count();
    sink.emit("suite_result",json!({"suite":"native-view","passed":cases.len()-failed-manual,"failed":failed,"manual":manual,"evidence":root.join("native-view-results.json")}));
    if failed > 0 {
        return Err(format!("Native View acceptance failed: {}", report));
    }
    Ok(())
}
