//! P3 checks only run inside the parent suite's marked, isolated project.
use super::*;

async fn retry(app: &AppHandle, surface: &Surface) -> Result<Surface, String> {
    let label = surface.label.clone();
    let app2 = Arc::new(app.clone());
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(host::retry(&app2, &label));
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())??;
    wait_surface(&surface.window_id).await
}

pub(super) async fn run(
    app: &AppHandle,
    project: &str,
    reference: &WorkspaceRef,
    session: &str,
    cases: &mut Vec<Value>,
) -> Result<(), String> {
    let first = open(app, reference, "p3-first", session).await?;
    for id in ["p3-second", "p3-third", "p3-fourth"] {
        open(app, reference, id, session).await?;
    }
    crate::commands::unity_embed_open_frontend_window(
        app.clone(),
        reference.clone(),
        crate::commands::UnityEmbedOpenFrontendWindowRequest {
            window_id: Some("p3-waiting".into()),
            target_kind: "session".into(),
            target_id: Some(session.into()),
            title: Some("P3 waiting".into()),
        },
        app.state(),
        app.state(),
    )
    .await
    .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    check(
        cases,
        "p3-capacity-bounded",
        host::snapshot().len() == 4 && host::status("unallocated")["state"] == "capacity",
        host::diagnostics(app).await?,
    )?;
    let waiting = crate::unity_bridge::unity_execute_code(project, r#"var w=System.Linq.Enumerable.First(UnityEngine.Resources.FindObjectsOfTypeAll<Locus.LocusEditorWindow>(),w=>w.titleContent.text=="P3 waiting"); return typeof(Locus.LocusEditorWindow).GetField("_webViewState",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance).GetValue(w);"#).await?;
    check(
        cases,
        "p3-capacity-visible-in-unity",
        waiting.contains("capacity"),
        json!(waiting),
    )?;
    crate::unity_bridge::unity_execute_code(project, r#"foreach(var w in UnityEngine.Resources.FindObjectsOfTypeAll<Locus.LocusEditorWindow>()) if(w.titleContent.text=="Locus p3-fourth")w.Close();return "closed";"#).await?;
    let resumed = wait_surface("p3-waiting").await?;
    check(
        cases,
        "p3-capacity-auto-resumes",
        resumed.ready && host::snapshot().len() == 4,
        json!(resumed.generation),
    )?;
    let failed_app = Arc::new(app.clone());
    let failed = first.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        host::unity_native_embed_failed(
            (*failed_app).clone(),
            failed.label,
            failed.generation,
            "P3 injected component failure".into(),
        );
        let _ = tx.send(());
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?;
    check(
        cases,
        "p3-error-status",
        host::status(&first.label)["state"] == "error",
        host::status(&first.label),
    )?;
    let restored = retry(app, &first).await?;
    check(
        cases,
        "p3-retry-new-scope",
        restored.generation != first.generation && restored.error.is_none(),
        json!(restored.generation),
    )?;
    let stale_app = Arc::new(app.clone());
    let stale = first.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        host::unity_native_embed_failed(
            (*stale_app).clone(),
            stale.label,
            stale.generation,
            "stale failure".into(),
        );
        let _ = tx.send(());
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?;
    check(
        cases,
        "p3-stale-failure-ignored",
        host::status(&first.label)["state"] == "ready",
        host::status(&first.label),
    )?;
    for (i, width, height) in [(0, 400, 480), (1, 820, 620), (2, 560, 500)] {
        crate::unity_bridge::unity_execute_code(project, &format!(r#"foreach(var w in UnityEngine.Resources.FindObjectsOfTypeAll<Locus.LocusEditorWindow>())if(w.titleContent.text=="Locus p3-first"){{w.position=new UnityEngine.Rect(80,100,{width},{height});w.Focus();w.Repaint();}}return "moved";"#)).await?;
        tokio::time::sleep(Duration::from_millis(700)).await;
        let s = wait_surface("p3-first").await?;
        let d = host::diagnostics(app).await?;
        let c = d["controllers"]
            .as_array()
            .and_then(|v| v.iter().find(|c| c["label"] == s.label))
            .ok_or("missing controller")?;
        check(
            cases,
            &format!("p3-resize-{i}"),
            c["bounds"]["width"] == s.width
                && c["bounds"]["height"] == s.height
                && c["visible"] == true,
            c.clone(),
        )?;
    }
    close_all(app, project).await?;
    // Page.crash terminates the real associated renderer, including the shared Vue owner.
    let crash = open(app, reference, "p3-crash", session).await?;
    let drop_path = Path::new(project).join("P3-drop.txt");
    std::fs::write(&drop_path, "native file drop fixture").map_err(|e| e.to_string())?;
    evaluate(app, &crash.label, "window.__dropTrace=[];for(const type of ['dragenter','dragover','drop'])document.addEventListener(type,e=>window.__dropTrace.push({type,files:[...e.dataTransfer.files].map(f=>f.name),types:[...e.dataTransfer.types],x:e.clientX,y:e.clientY}),true);true").await?;
    let point = evaluate(app, &crash.label, "(()=>{const r=document.querySelector('.workbench-editor-instance:not([inert]) .chat-composer-input').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()").await?;
    for kind in ["dragEnter", "dragOver", "drop"] {
        host::devtools(app, &crash.label, "Input.dispatchDragEvent", json!({"type":kind,"x":point["x"],"y":point["y"],"data":{"items":[],"files":[drop_path],"dragOperationsMask":1}})).await?;
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    let dropped = evaluate(
        app,
        &crash.label,
        "({attached:[...document.querySelectorAll('.local-file-chip[title]')].some(e=>e.title.replaceAll('\\\\','/').endsWith('/P3-drop.txt')),bridge:typeof chrome?.webview?.postMessageWithAdditionalObjects,trace:window.__dropTrace,titles:[...document.querySelectorAll('.local-file-chip[title]')].map(e=>e.title)})",
    )
    .await?;
    let drop_diagnostics = host::diagnostics(app).await?;
    check(cases, "p3-native-file-drop", dropped["attached"] == true, json!({"dom":dropped,"native":drop_diagnostics}))?;
    crate::unity_bridge::unity_execute_code(project, "new UnityEngine.GameObject(\"P3 Scene Object\"); UnityEditor.SceneManagement.EditorSceneManager.SaveScene(UnityEngine.SceneManagement.SceneManager.GetActiveScene(),\"Assets/P3.unity\");return \"created\";").await?;
    let scene_point = evaluate(app, &crash.label, "(()=>{const r=document.querySelector('.workbench-editor-instance:not([inert]) .chat-composer-input').getBoundingClientRect();return {x:Math.round((r.x+20)*devicePixelRatio),y:Math.round((r.y+14)*devicePixelRatio)};})()").await?;
    let refs = serde_json::from_value(json!([{"path":"Assets/P3.unity/P3 Scene Object","kind":"sceneObject","name":"P3 Scene Object","source":"unity"}])).map_err(|e|e.to_string())?;
    crate::commands::emit_native_unity_asset_drop(app, &crash.label, &crash.generation, reference, refs, scene_point["x"].as_i64().unwrap_or(0) as i32, scene_point["y"].as_i64().unwrap_or(0) as i32)?;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let scene_drop = evaluate(app, &crash.label, "document.body.innerText.includes('P3 Scene Object')").await?;
    check(cases, "p3-unity-reference-release-route", scene_drop == true, scene_drop)?;
    evaluate(app, &crash.label, "document.querySelector('.workbench-editor-instance:not([inert]) .chat-composer-input')?.focus();true").await?;
    host::devtools(
        app,
        &crash.label,
        "Input.insertText",
        json!({"text":"P3 recovery draft"}),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(600)).await;
    let old = crash.generation.clone();
    let _ = host::devtools(app, &crash.label, "Page.crash", json!({})).await;
    let recovered = wait_surface("p3-crash").await?;
    check(
        cases,
        "p3-renderer-crash-recovery",
        recovered.generation != old && recovered.ready,
        json!(recovered.generation),
    )?;
    let draft = evaluate(app, &recovered.label, "document.querySelector('.workbench-editor-instance:not([inert]) .chat-composer-input')?.value??document.querySelector('.workbench-editor-instance:not([inert]) .chat-composer-input')?.textContent??''").await?;
    check(
        cases,
        "p3-renderer-crash-draft",
        draft
            .as_str()
            .is_some_and(|v| v.contains("P3 recovery draft")),
        draft,
    )?;
    close_all(app, project).await
}

pub(super) async fn soak(
    app: &AppHandle,
    project: &str,
    reference: &WorkspaceRef,
    session: &str,
    minutes: u64,
    sink: &DriverEventSink,
    cases: &mut Vec<Value>,
) -> Result<(), String> {
    let surface = open(app, reference, "p3-soak", session).await?;
    crate::view::request_frontend_execution(app, project, r#"const v=await locus.views.create({id:'p3-soak',fileName:'p3-soak.vue',name:'P3 endurance',component:`<script setup>import {ref,onMounted,onUnmounted} from 'vue';const rows=ref(Array.from({length:200},(_,i)=>({id:i,text:'Row '+i})));const pulse=ref(0);let timer;onMounted(()=>{timer=setInterval(()=>{pulse.value++;const r=rows.value[pulse.value%rows.value.length];r.text=('Stream '+pulse.value+' '+r.text).slice(0,2048);},250);});onUnmounted(()=>clearInterval(timer));</script><template><div style="overflow:auto;height:100%"><input aria-label="Endurance input"/><output class="p3-pulse">{{pulse}}</output><div v-for="row in rows" :key="row.id">{{row.text}}</div></div></template>`});await locus.views.open(v.summary.id);return true;"#, Some(&surface.label), 30000).await?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let mut samples = Vec::new();
    let mut previous_pulse = -1i64;
    for minute in 0..=minutes {
        let begin = Instant::now();
        let response = evaluate(app, &surface.label, "new Promise(resolve=>requestAnimationFrame(()=>resolve({ready:!!document.querySelector('.development-workbench'),pulse:Number(document.querySelector('.p3-pulse')?.textContent??-1),visible:document.visibilityState})))").await?;
        let latency = begin.elapsed().as_millis();
        let resources = metrics::capture(app).await?;
        let gpu = metrics::gpu(&resources).await;
        let sample = json!({"minute":minute,"roundTripMs":latency,"response":response,"resources":resources,"gpu":gpu});
        samples.push(sample);
        std::fs::write(
            Path::new(project).join("native-embed-soak.json"),
            serde_json::to_vec_pretty(&samples).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        let pulse = response["pulse"].as_i64().unwrap_or(-1);
        check(
            cases,
            &format!("p3-soak-minute-{minute}"),
            response["ready"] == true && pulse > previous_pulse && latency < 1000,
            json!({"latency":latency,"pulse":pulse}),
        )?;
        previous_pulse = pulse;
        sink.emit(
            "suite_progress",
            json!({"suite":"native-embed", "soakMinute":minute, "soakMinutes":minutes}),
        );
        if minute < minutes {
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    }
    if minutes >= 10 {
        let before = &samples[5]["resources"];
        let after = &samples.last().ok_or("Missing endurance samples")?["resources"];
        let delta =
            |key: &str| after[key].as_i64().unwrap_or(0) - before[key].as_i64().unwrap_or(0);
        check(
            cases,
            "p3-soak-resource-plateau",
            delta("browserBytes") < 128 * 1024 * 1024 && delta("browserHandles") < 100,
            json!({"bytes":delta("browserBytes"),"handles":delta("browserHandles"),"fromMinute":5,"toMinute":minutes}),
        )?;
    }
    close_all(app, project).await
}
