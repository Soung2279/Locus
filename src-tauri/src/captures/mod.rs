pub mod data;
#[cfg(windows)]
mod native;
use crate::session::{
    models::{CaptureReference, ImageData},
    store::SessionStore,
};
use crate::workspace_service::{ProjectRegistry, WorkspaceRef};
use base64::Engine;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::Manager;

#[derive(Default)]
pub struct CaptureState {
    busy: AtomicBool,
}
pub fn init(app: &tauri::AppHandle) {
    app.manage(CaptureState::default());
}
struct CaptureGuard<'a>(&'a AtomicBool);
impl Drop for CaptureGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotAttachment {
    image: ImageData,
    clipboard_error: Option<String>,
    spatial_error: Option<String>,
}

/// Capture only the originating composer's checkout. The caller keeps its draft
/// identity while awaiting this response; no global focus registration is needed.
#[tauri::command]
pub async fn capture_unity_attachment(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    workspace_ref: WorkspaceRef,
    target: String,
) -> Result<ScreenshotAttachment, String> {
    if !matches!(target.as_str(), "scene" | "game") {
        return Err("Invalid screenshot target".into());
    }
    let runtime = app
        .state::<Arc<ProjectRegistry>>()
        .resolve_workspace_ref(&workspace_ref)
        .map_err(|e| e.to_string())?;
    let root = runtime.runtime().root().to_string_lossy().to_string();
    let state = app.state::<CaptureState>();
    if state.busy.swap(true, Ordering::Acquire) {
        return Err("Another screenshot is in progress".into());
    }
    let _guard = CaptureGuard(&state.busy);
    let started = std::time::Instant::now();
    let id = uuid::Uuid::new_v4().to_string();
    let request = serde_json::json!({"id":id,"target":target}).to_string();
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        crate::unity_bridge::send_message(&root, "capture_attachment", &request),
    )
    .await
    .map_err(|_| "Unity screenshot timed out".to_string())??;
    if !response.ok {
        return Err(response
            .error
            .or(response.message)
            .unwrap_or_else(|| "Unity screenshot failed".into()));
    }
    let message = response.message.ok_or("Unity returned no screenshot")?;
    let capture_app = app.clone();
    let label = window.label().to_owned();
    let checkout = workspace_ref.checkout_id.to_string();
    let result = tokio::task::spawn_blocking(move || {
        deliver(&capture_app, &label, &checkout, &id, &message)
    })
    .await
    .map_err(|e| e.to_string())?;
    tracing::info!(
        log_module = "LocusCapture",
        elapsed_ms = started.elapsed().as_millis(),
        "screenshot command finished"
    );
    result
}
fn inflate(payload: &str, expected: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| e.to_string())?;
    let mut raw = Vec::with_capacity(expected);
    flate2::read::DeflateDecoder::new(compressed.as_slice())
        .take((expected + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|e| e.to_string())?;
    if raw.len() != expected {
        return Err("Invalid screenshot payload length".into());
    }
    Ok(raw)
}
fn deliver(
    app: &tauri::AppHandle,
    window_label: &str,
    checkout: &str,
    id: &str,
    message: &str,
) -> Result<ScreenshotAttachment, String> {
    let started = std::time::Instant::now();
    let wire: serde_json::Value = serde_json::from_str(message).map_err(|e| e.to_string())?;
    let width = wire["width"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 8192)
        .ok_or("Invalid screenshot width")? as u32;
    let height = wire["height"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 8192)
        .ok_or("Invalid screenshot height")? as u32;
    let count = width as usize * height as usize;
    if count > data::MAX_PIXELS {
        return Err("Screenshot too large".into());
    }
    let rgba = inflate(
        wire["pixels"].as_str().ok_or("Missing screenshot pixels")?,
        count * 4,
    )?;
    let spatial = parse_spatial(&wire)?.into_iter().next();
    let context = wire
        .get("context")
        .filter(|value| !value.is_null())
        .map(|value| serde_json::from_value::<data::CaptureViewContext>(value.clone()))
        .transpose()
        .map_err(|e| e.to_string())?;
    if let Some(context) = &context {
        context.validate()?;
    }
    let spatial_error = if spatial.is_none() {
        Some(
            context
                .as_ref()
                .and_then(|c| c.spatial_error.clone())
                .unwrap_or_else(|| "Object/depth data unavailable".into()),
        )
    } else {
        None
    };
    let decode_ms = started.elapsed().as_millis();
    let window = app
        .get_webview_window(window_label)
        .ok_or("Screenshot input was closed")?;
    #[cfg(windows)]
    let clipboard_error = native::clipboard(
        width,
        height,
        &rgba,
        window.hwnd().map_err(|e| e.to_string())?.0 as isize,
    )
    .err();
    #[cfg(not(windows))]
    let clipboard_error = Some("Clipboard capture requires Windows".to_string());
    let clipboard_ms = started.elapsed().as_millis() - decode_ms;
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fastest);
        encoder
            .write_header()
            .map_err(|e| e.to_string())?
            .write_image_data(&rgba)
            .map_err(|e| e.to_string())?;
    }
    let png_ms = started.elapsed().as_millis() - decode_ms - clipboard_ms;
    app.state::<Arc<SessionStore>>().save_capture(
        id,
        checkout,
        &bytes,
        spatial.as_ref(),
        context.as_ref(),
    )?;
    let image = ImageData {
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type: "image/png".into(),
        capture: Some(CaptureReference { id: id.into() }),
    };
    tracing::info!(
        log_module = "LocusCapture",
        decode_ms,
        clipboard_ms,
        png_ms,
        total_ms = started.elapsed().as_millis(),
        unity_ms = wire["captureMs"].as_f64().unwrap_or(0.),
        "attachment delivered"
    );
    Ok(ScreenshotAttachment {
        image,
        clipboard_error,
        spatial_error,
    })
}
fn parse_spatial(batch: &serde_json::Value) -> Result<Vec<data::SpatialSnapshot>, String> {
    let mut result = Vec::new();
    for wire in batch["snapshots"]
        .as_array()
        .ok_or("No spatial snapshots")?
        .iter()
        .take(1)
    {
        let mut snapshot: data::SpatialSnapshot =
            serde_json::from_value(wire.clone()).map_err(|e| e.to_string())?;
        let count = snapshot.width as usize * snapshot.height as usize;
        if count == 0 || count > data::MAX_PIXELS {
            return Err("Spatial snapshot is too large".into());
        }
        let raw = inflate(
            wire["payload"].as_str().ok_or("No spatial payload")?,
            count * 8,
        )?;
        snapshot.load_planes(&raw)?;
        snapshot.validate()?;
        result.push(snapshot);
    }
    Ok(result)
}
