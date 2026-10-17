use super::*;
use crate::captures::data::{CaptureViewContext, SpatialSnapshot};

impl SessionStore {
    pub(super) fn create_capture_schema(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS capture_attachments (
            id TEXT PRIMARY KEY, checkout_id TEXT NOT NULL, metadata TEXT, spatial BLOB,
            summary TEXT NOT NULL, image_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS capture_session_links (
            capture_id TEXT NOT NULL REFERENCES capture_attachments(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            PRIMARY KEY(capture_id,session_id));
            CREATE TRIGGER IF NOT EXISTS capture_message_link AFTER INSERT ON messages
            WHEN NEW.role='user' AND NEW.images IS NOT NULL BEGIN
              INSERT OR IGNORE INTO capture_session_links(capture_id,session_id)
              SELECT c.id,NEW.session_id FROM json_each(NEW.images) image
              JOIN capture_attachments c ON c.id=json_extract(image.value,'$.capture.id')
              ;
            END;",
        )
    }

    pub(super) fn migrate_capture_attachments(conn: &Connection) -> rusqlite::Result<()> {
        Self::create_capture_schema(conn)?;
        let mut statement =
            conn.prepare("SELECT id,images FROM messages WHERE images IS NOT NULL")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let text: String = row.get(1)?;
            let mut value: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            let mut changed = false;
            if let Some(images) = value.as_array_mut() {
                for image in images {
                    if let Some(image) = image.as_object_mut() {
                        if !image.contains_key("capture") {
                            image.insert("capture".into(), serde_json::Value::Null);
                            changed = true;
                        }
                    }
                }
            }
            if changed {
                conn.execute(
                    "UPDATE messages SET images=?2 WHERE id=?1",
                    params![id, value.to_string()],
                )?;
            }
        }
        Ok(())
    }

    pub fn export_captures(
        &self,
        ids: &std::collections::BTreeSet<String>,
    ) -> Result<serde_json::Value, String> {
        use base64::Engine;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut captures = Vec::new();
        for id in ids {
            let row:Option<(String,Option<String>,Option<Vec<u8>>,String)>=conn.query_row("SELECT checkout_id,metadata,spatial,summary FROM capture_attachments WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|e|e.to_string())?;
            let Some((checkout, metadata, spatial, summary)) = row else {
                captures.push(serde_json::json!({"id":id,"spatial":"empty"}));
                continue;
            };
            captures.push(serde_json::json!({"id":id,"checkoutId":checkout,"summary":summary,
                "metadata":metadata.map(|s|serde_json::from_str::<serde_json::Value>(&s)).transpose().map_err(|e|e.to_string())?.unwrap_or(serde_json::json!("empty")),
                "spatial":spatial.map(|bytes|serde_json::json!({"encoding":"zstd-id-u32le-depth-f32le","data":base64::engine::general_purpose::STANDARD.encode(bytes)})).unwrap_or(serde_json::json!("empty"))}));
        }
        Ok(if captures.is_empty() {
            serde_json::json!("empty")
        } else {
            serde_json::json!(captures)
        })
    }

    pub fn save_capture(
        &self,
        id: &str,
        checkout: &str,
        image: &[u8],
        spatial: Option<&SpatialSnapshot>,
        context: Option<&CaptureViewContext>,
    ) -> Result<String, String> {
        let metadata = spatial
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| e.to_string())?;
        let bytes = spatial.map(SpatialSnapshot::encode).transpose()?;
        let summary = spatial
            .map(|s| s.summary(id))
            .or_else(|| context.map(|c| c.summary(id)))
            .unwrap_or_else(|| format!("capture={id} spatial=unavailable"));
        self.conn.lock().map_err(|e|e.to_string())?.execute("INSERT INTO capture_attachments(id,checkout_id,metadata,spatial,summary,image_hash,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,checkout,metadata,bytes,summary,blake3::hash(image).to_hex().to_string(),chrono::Utc::now().timestamp_millis()]).map_err(|e|e.to_string())?;
        Ok(summary)
    }

    pub fn capture_query(
        &self,
        id: &str,
        checkout: &str,
        session: &str,
        action: &str,
        request: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        use serde_json::json;
        let row:Option<(Option<String>,Option<Vec<u8>>)>=self.conn.lock().map_err(|e|e.to_string())?.query_row(
            "SELECT metadata,spatial FROM capture_attachments c JOIN capture_session_links l ON l.capture_id=c.id WHERE c.id=?1 AND c.checkout_id=?2 AND l.session_id=?3",params![id,checkout,session],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        let (metadata, bytes) = row.ok_or("Capture not available in this session and checkout")?;
        if action == "get" {
            return Ok(json!({"id":id,"spatial":metadata.is_some()}));
        }
        let (Some(metadata), Some(bytes)) = (metadata, bytes) else {
            return Err("This screenshot has no spatial data".into());
        };
        let snapshot: SpatialSnapshot =
            serde_json::from_str(&metadata).map_err(|e| e.to_string())?;
        let snapshot = snapshot.decode(&bytes)?;
        let fields: Vec<String> =
            serde_json::from_value(request.get("fields").cloned().unwrap_or_else(|| {
                if action == "pick" {
                    json!(["object", "world"])
                } else {
                    json!(["ref", "name"])
                }
            }))
            .map_err(|e| e.to_string())?;
        match action {
            "pick" => snapshot.pick(
                serde_json::from_value(request["uv"].clone()).map_err(|e| e.to_string())?,
                &fields,
            ),
            "objects" => snapshot.objects_in(
                serde_json::from_value(
                    request
                        .get("rect")
                        .cloned()
                        .unwrap_or(json!([0., 0., 1., 1.])),
                )
                .map_err(|e| e.to_string())?,
                &fields,
                request
                    .get("offset")
                    .map(|v| v.as_u64().ok_or("offset must be an integer"))
                    .transpose()?
                    .unwrap_or(0) as usize,
                request
                    .get("limit")
                    .map(|v| v.as_u64().ok_or("limit must be an integer"))
                    .transpose()?
                    .unwrap_or(8) as usize,
            ),
            _ => Err("Unknown capture operation".into()),
        }
    }

    /// Steering sends before it persists the message. Apply the same validated
    /// attachment context as ordinary sends, without granting SDK session access
    /// until the message is actually committed.
    pub fn prepare_capture_prompt_suffix(
        &self,
        session: &str,
        images: Option<&[super::super::models::ImageData]>,
        suffix: Option<&str>,
    ) -> Result<Option<String>, String> {
        let images = images
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| e.to_string())?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::capture_message_suffix(&conn, session, images.as_deref(), suffix)
    }

    /// Called inside the message transaction/connection lock, for every user
    /// entry path (normal send, queued input and SDK). Never trust client text.
    pub(super) fn capture_message_suffix(
        conn: &Connection,
        session: &str,
        images: Option<&str>,
        suffix: Option<&str>,
    ) -> Result<Option<String>, String> {
        let Some(images) = images else {
            return Ok(suffix.map(str::to_owned));
        };
        let images: Vec<super::super::models::ImageData> =
            serde_json::from_str(images).map_err(|e| e.to_string())?;
        let mut summaries = Vec::new();
        let mut seen = HashSet::new();
        let mut first_capture = None;
        for (index, image) in images.into_iter().enumerate() {
            let Some(capture) = image.capture else {
                continue;
            };
            if image.mime_type != "image/png" {
                return Err("Screenshot must retain its original PNG image".into());
            }
            if !seen.insert(capture.id.clone()) {
                continue;
            }
            use base64::Engine;
            let png = base64::engine::general_purpose::STANDARD
                .decode(&image.data)
                .map_err(|_| "Invalid screenshot image")?;
            let summary:Option<String>=conn.query_row("SELECT c.summary FROM capture_attachments c JOIN sessions s ON s.id=?2 WHERE c.id=?1 AND c.checkout_id=COALESCE(s.default_checkout_id,'') AND c.image_hash=?3",params![capture.id,session,blake3::hash(&png).to_hex().to_string()],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
            let summary = summary
                .ok_or("Screenshot belongs to a different checkout or is no longer available")?;
            first_capture.get_or_insert(capture.id);
            summaries.push(format!("image={} {summary}", index + 1));
        }
        if summaries.is_empty() {
            return Ok(suffix.map(str::to_owned));
        }
        // One small, executable guide per message, including image-only fallback.
        // Do not rely on the model first discovering the SDK documentation.
        let capture_id =
            serde_json::to_string(&first_capture.unwrap()).map_err(|e| e.to_string())?;
        let block = format!(
            "<screenshot_context>\n{}\n\nPython tool (readonly=true; locus is preloaded). Use the capture ID for the relevant image:\n\
c = await locus.captures.get({capture_id})\n\
if c.spatial: print(await c.pick(uv=(0.5, 0.5), fields=[\"object\", \"world\"]))\n\
Region query: await c.objects(rect=(0.2, 0.2, 0.8, 0.8), limit=8).\n\
Coordinates are normalized 0..1, origin=image top-left. Query this saved snapshot; print only needed results.\n\
spatial=false means object/depth queries are unavailable; camera/view facts above remain usable.\n</screenshot_context>",
            summaries.join("\n")
        );
        // The steering path prepares before sending and persists after ACK.
        if suffix.is_some_and(|s| s.ends_with(&block)) {
            return Ok(suffix.map(str::to_owned));
        }
        let prefix = suffix
            .filter(|s| !s.is_empty())
            .map(|s| format!("{s}\n\n"))
            .unwrap_or_else(|| "\n\n".into());
        Ok(Some(format!("{prefix}{block}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::models::{CaptureReference, ImageData, MessageRole};
    use serde_json::json;
    #[test]
    fn capture_requires_attached_image_matching_session_checkout_and_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path()).unwrap();
        let session = store
            .create_session("capture", None, None, "chat", None)
            .unwrap();
        let other = store
            .create_session("other", None, None, "chat", None)
            .unwrap();
        let data = crate::captures::data::tests::fixture();
        store
            .save_capture("c42", "", b"image", Some(&data), None)
            .unwrap();
        assert!(store
            .capture_query("c42", "", &session, "get", &json!({}))
            .is_err());
        let image = ImageData {
            data: "aW1hZ2U=".into(),
            mime_type: "image/png".into(),
            capture: Some(CaptureReference { id: "c42".into() }),
        };
        store
            .add_message_with_images(&session, MessageRole::User, "look", Some(&[image.clone()]))
            .unwrap();
        assert_eq!(
            store
                .capture_query("c42", "", &session, "get", &json!({}))
                .unwrap(),
            json!({"id":"c42","spatial":true})
        );
        assert!(store
            .capture_query("c42", "different", &session, "get", &json!({}))
            .is_err());
        assert!(store
            .capture_query("c42", "", &other, "get", &json!({}))
            .is_err());
        let mut changed = image;
        changed.data = "Y2hhbmdlZA==".into();
        assert!(store
            .add_message_with_images(&other, MessageRole::User, "wrong image", Some(&[changed]))
            .is_err());
        let messages = store.get_messages(&session).unwrap();
        let suffix = messages[0].prompt_suffix.as_deref().unwrap();
        assert!(suffix.contains("capture=c42"));
        assert!(!suffix.contains("depths"));
        assert!(suffix.contains("await locus.captures.get(\"c42\")"));
        assert!(suffix.contains("readonly=true"));
        assert!(suffix.contains("c.pick(uv="));
        assert!(suffix.contains("c.objects(rect="));
        assert!(suffix.len() < 1500);
        let outbound = crate::compact::prepare_messages_for_llm(&messages);
        assert!(outbound[0].content.contains("camera="));
        assert!(outbound[0].content.contains("anchor_uv="));
        assert!(outbound[0]
            .content
            .contains("await locus.captures.get(\"c42\")"));
        assert_eq!(
            outbound[0].images.as_ref().unwrap()[0]
                .capture
                .as_ref()
                .unwrap()
                .id,
            "c42"
        );
        let output = dir.path().join("capture.yaml");
        crate::session::context_export::export_session_context_yaml(
            &store, &session, "", None, None, &output,
        )
        .unwrap();
        let exported: serde_json::Value =
            serde_yaml::from_str(&std::fs::read_to_string(output).unwrap()).unwrap();
        assert_eq!(exported["sessions"][0]["captures"][0]["id"], "c42");
        assert!(exported["sessions"][0]["captures"][0]["spatial"]["data"].is_string());
    }
    #[test]
    fn capture_fallback_keeps_view_context_and_guide_without_claiming_spatial_data() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path()).unwrap();
        let session = store
            .create_session("capture", None, None, "chat", None)
            .unwrap();
        let context = CaptureViewContext {
            target: "scene".into(),
            scene: "Assets/Scenes/Test.unity".into(),
            projection: "perspective".into(),
            has_camera: true,
            camera_position: [12., 4., -8.],
            camera_forward: [0., 0., 1.],
            spatial_error: Some("Depth copy shader unavailable".into()),
        };
        store
            .save_capture("fallback", "", b"image", None, Some(&context))
            .unwrap();
        let images = [ImageData {
            data: "aW1hZ2U=".into(),
            mime_type: "image/png".into(),
            capture: Some(CaptureReference {
                id: "fallback".into(),
            }),
        }];
        store
            .add_message_with_images(&session, MessageRole::User, "where?", Some(&images))
            .unwrap();
        let messages =
            crate::compact::prepare_messages_for_llm(&store.get_messages(&session).unwrap());
        let text = &messages[0].content;
        assert!(text.contains("Assets/Scenes/Test.unity"));
        assert!(text.contains("camera=[12.0,4.0,-8.0]"));
        assert!(text.contains("spatial=unavailable"));
        assert!(text.contains("Depth copy shader unavailable"));
        assert!(text.contains("if c.spatial:"));
        assert!(!text.contains("anchor_uv="));
        assert_eq!(
            store
                .capture_query("fallback", "", &session, "get", &json!({}))
                .unwrap()["spatial"],
            false
        );
        assert!(store
            .capture_query("fallback", "", &session, "pick", &json!({"uv":[0.5,0.5]}))
            .is_err());
    }

    #[test]
    fn capture_steering_includes_guide_before_commit_and_does_not_duplicate_it_on_persist() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path()).unwrap();
        let session = store
            .create_session("capture", None, None, "chat", None)
            .unwrap();
        store
            .save_capture(
                "c42",
                "",
                b"image",
                Some(&crate::captures::data::tests::fixture()),
                None,
            )
            .unwrap();
        let image = ImageData {
            data: "aW1hZ2U=".into(),
            mime_type: "image/png".into(),
            capture: Some(CaptureReference { id: "c42".into() }),
        };
        let images = [image.clone(), image];
        let suffix = store
            .prepare_capture_prompt_suffix(&session, Some(&images), Some("skill context"))
            .unwrap()
            .unwrap();
        let prompt = crate::session::history::render_prompt_content("look", None, Some(&suffix));
        let wire = crate::llm::codex::steering::user_input(&prompt, Some(&images));
        assert!(wire.to_string().contains("locus.captures.get"));
        assert!(wire.to_string().contains("camera="));
        assert!(wire.to_string().contains("input_image"));
        assert!(store
            .capture_query("c42", "", &session, "get", &json!({}))
            .is_err());
        let repeated = store
            .prepare_capture_prompt_suffix(&session, Some(&images), Some(&suffix))
            .unwrap()
            .unwrap();
        assert_eq!(suffix, repeated);
        assert_eq!(suffix.matches("<screenshot_context>").count(), 1);
        assert_eq!(suffix.matches("image=1 ").count(), 1);
        assert!(!suffix.contains("image=2 "));
        assert_eq!(suffix.matches("await locus.captures.get").count(), 1);
        store
            .add_message_with_images_asset_refs_and_signature(
                &session,
                MessageRole::User,
                "look",
                Some(&images),
                None,
                None,
                None,
                Some(&suffix),
            )
            .unwrap();
        assert_eq!(
            store.get_messages(&session).unwrap()[0]
                .prompt_suffix
                .as_deref(),
            Some(suffix.as_str())
        );
        assert!(store
            .capture_query("c42", "", &session, "get", &json!({}))
            .is_ok());
    }
    #[test]
    fn capture_v48_migration_is_repeatable_and_old_images_export_empty() {
        let dir = tempfile::tempdir().unwrap();
        let conn = Connection::open(dir.path().join("locus.db")).unwrap();
        SessionStore::create_latest_schema(&conn).unwrap();
        conn.execute_batch("DROP TRIGGER capture_message_link; DROP TABLE capture_session_links; DROP TABLE capture_attachments;
            INSERT INTO sessions(id,title,session_type,created_at,updated_at) VALUES('old','Old','chat',1,1);
            INSERT INTO messages(id,session_id,role,content,created_at,images) VALUES('m','old','user','image',1,'[{\"data\":\"aW1hZ2U=\",\"mimeType\":\"image/png\"}]');
            PRAGMA user_version=48;").unwrap();
        drop(conn);
        let store = SessionStore::new(dir.path()).unwrap();
        {
            let conn = store.conn.lock().unwrap();
            SessionStore::migrate_capture_attachments(&conn).unwrap();
        }
        let images = store.get_messages("old").unwrap().remove(0).images.unwrap();
        assert_eq!(images[0].capture, None);
        let output = dir.path().join("legacy.yaml");
        crate::session::context_export::export_session_context_yaml(
            &store, "old", "", None, None, &output,
        )
        .unwrap();
        let exported: serde_json::Value =
            serde_yaml::from_str(&std::fs::read_to_string(output).unwrap()).unwrap();
        assert_eq!(
            exported["sessions"][0]["messages"][0]["images"][0]["capture"],
            "empty"
        );
        assert_eq!(exported["sessions"][0]["captures"], "empty");
    }
}
