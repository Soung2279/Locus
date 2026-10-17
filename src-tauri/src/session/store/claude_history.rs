use super::*;

impl SessionStore {
    pub(crate) fn record_claude_todos(
        &self,
        session_id: &str,
        message_id: &str,
        run_id: &str,
        snapshot: &serde_json::Value,
    ) -> Result<(), String> {
        if snapshot["version"] != 1 {
            return Err("Unsupported Claude todo snapshot".into());
        }
        let items: Vec<TodoItem> =
            serde_json::from_value(snapshot["items"].clone()).map_err(|e| e.to_string())?;
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let existing:Option<String>=tx.query_row("SELECT r.payload_json FROM messages m LEFT JOIN response_request_payloads r ON r.id=m.response_request_id WHERE m.id=?1 AND m.session_id=?2",params![message_id,session_id],|row|row.get(0)).map_err(|e|e.to_string())?;
        let mut payload: serde_json::Value = existing
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| serde_json::json!({}));
        payload["claude_todos"] = snapshot.clone();
        payload["claude_todos"]["runId"] = serde_json::json!(run_id);
        payload["claude_run_id"] = serde_json::json!(run_id);
        let payload_id = Self::persist_response_request_with_conn(&tx, Some(&payload))?;
        tx.execute(
            "UPDATE messages SET response_request_id=?1 WHERE id=?2 AND session_id=?3",
            params![payload_id, message_id, session_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM todos WHERE session_id=?1", [session_id])
            .map_err(|e| e.to_string())?;
        for (position, todo) in items.iter().enumerate() {
            tx.execute("INSERT INTO todos(session_id,position,content,status,priority) VALUES(?1,?2,?3,?4,?5)",params![session_id,position as i64,todo.content,todo.status,todo.priority]).map_err(|e|e.to_string())?;
        }
        tx.execute(
            "UPDATE sessions SET latest_todo_run_id=?1,updated_at=?2 WHERE id=?3",
            params![run_id, Self::now_ts(), session_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    /// Commit a prepared, independent native transcript and the visible cut in
    /// one transaction. The caller must not mutate the old native transcript.
    pub(crate) fn commit_claude_rewind(
        &self,
        session_id: &str,
        expected_ids: &[String],
        keep: usize,
        native_id: Option<&str>,
    ) -> Result<u64, String> {
        if keep > expected_ids.len() || (keep > 0 && native_id.is_none()) {
            return Err("Invalid Claude rewind boundary".into());
        }
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_runs WHERE session_id=?1 AND status IN ('queued','starting','running','waiting_input','finishing','cancelling'))",
            [session_id], |row| row.get(0),
        ).map_err(|e|e.to_string())?;
        if active {
            return Err("Stop the active conversation before rewinding history".into());
        }
        let rows = {
            let mut stmt = tx.prepare("SELECT m.id,m.metadata_json,r.payload_json,m.role FROM messages m LEFT JOIN response_request_payloads r ON r.id=m.response_request_id WHERE m.session_id=?1 ORDER BY m.created_at,m.rowid").map_err(|e|e.to_string())?;
            let rows = stmt
                .query_map([session_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        if rows.iter().map(|row| &row.0).ne(expected_ids.iter()) {
            return Err("Conversation changed while preparing the rewind; retry".into());
        }
        let mut todos = Vec::<TodoItem>::new();
        let mut plan_active = false;
        let mut todo_run = None::<String>;
        let mut completed_run = None::<String>;
        for (index, (id, metadata_json, payload, role)) in rows.iter().enumerate() {
            if index >= keep {
                tx.execute(
                    "DELETE FROM messages WHERE session_id=?1 AND id=?2",
                    params![session_id, id],
                )
                .map_err(|e| e.to_string())?;
                continue;
            }
            let mut metadata: MessageMetadata = metadata_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|e| e.to_string())?
                .unwrap_or_default();
            let mut response: serde_json::Value = payload
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|e| e.to_string())?
                .or(metadata.response_request.take())
                .unwrap_or_else(|| serde_json::json!({}));
            if let Some(snapshot) = response.get("claude_todos") {
                if snapshot["version"] != 1 {
                    return Err("Unsupported Claude todo snapshot".into());
                }
                todos =
                    serde_json::from_value(snapshot["items"].clone()).map_err(|e| e.to_string())?;
                todo_run = snapshot["runId"].as_str().map(str::to_string);
            }
            if role == "assistant" {
                if let Some(run) = response["claude_run_id"].as_str() {
                    completed_run = Some(run.into());
                }
            }
            if let Some(active) = response["claude_plan_active"].as_bool() {
                plan_active = active;
            }
            let native_id = native_id.unwrap();
            metadata
                .cli_session_ids
                .get_or_insert_with(HashMap::new)
                .insert("claude_code".into(), native_id.into());
            if let Some(point) = response.get_mut("claude_checkpoint") {
                point["sessionId"] = serde_json::json!(native_id);
            }
            if let Some(point) = response
                .get_mut("claude_compaction")
                .and_then(|value| value.get_mut("checkpoint"))
            {
                point["sessionId"] = serde_json::json!(native_id);
            }
            let payload_id = Self::persist_response_request_with_conn(&tx, Some(&response))?;
            tx.execute("UPDATE messages SET metadata_json=?1,response_request_id=?2 WHERE session_id=?3 AND id=?4",params![serialize_message_metadata(&metadata)?,payload_id,session_id,id]).map_err(|e|e.to_string())?;
        }
        tx.execute("DELETE FROM todos WHERE session_id=?1", [session_id])
            .map_err(|e| e.to_string())?;
        for (position, todo) in todos.iter().enumerate() {
            tx.execute("INSERT INTO todos(session_id,position,content,status,priority) VALUES(?1,?2,?3,?4,?5)",params![session_id,position as i64,todo.content,todo.status,todo.priority]).map_err(|e|e.to_string())?;
        }
        tx.execute("UPDATE sessions SET latest_completed_run_id=?1,latest_todo_run_id=?2,plan_mode_active=?3,plan_exited_pending_notice=0,updated_at=?4 WHERE id=?5",params![completed_run,todo_run,plan_active,Self::now_ts(),session_id]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE claude_native_bindings SET native_id=?1 WHERE session_id=?2",params![native_id,session_id]).map_err(|e|e.to_string())?;
        tx.execute(
            "UPDATE token_usage SET last_context_tokens=0 WHERE session_id=?1",
            [session_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok((rows.len() - keep) as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewind_atomically_restores_messages_native_identity_and_todos() {
        let root = tempfile::tempdir().unwrap();
        let store = SessionStore::new(root.path()).unwrap();
        let session = store
            .create_session("rewind", None, None, "chat", None)
            .unwrap();
        let first = store
            .add_message(&session, MessageRole::Assistant, "keep")
            .unwrap();
        let later = store
            .add_message(&session, MessageRole::User, "discard")
            .unwrap();
        let snapshot = |status: &str| serde_json::json!({"version":1,"kind":"todos","items":[{"content":"task","status":status,"priority":"medium"}]});
        store
            .record_claude_todos(&session, &first, "r1", &snapshot("pending"))
            .unwrap();
        store
            .record_claude_todos(&session, &later, "r2", &snapshot("completed"))
            .unwrap();
        let expected = vec![first.clone(), later.clone()];
        assert!(store
            .commit_claude_rewind(&session, &[first.clone()], 1, Some("new-id"))
            .is_err());
        assert_eq!(store.get_messages(&session).unwrap().len(), 2);
        assert_eq!(
            store.get_todos(&session).unwrap().items[0].status,
            "completed"
        );
        assert_eq!(
            store
                .commit_claude_rewind(&session, &expected, 1, Some("new-id"))
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .latest_cli_session_id(&session, "claude_code")
                .unwrap()
                .as_deref(),
            Some("new-id")
        );
        assert_eq!(
            store.get_todos(&session).unwrap().items[0].status,
            "pending"
        );
        let export = store.create_export_snapshot().unwrap();
        assert_eq!(export.get_messages(&session).unwrap()[0].id, first);
        assert_eq!(
            export.get_response_request_metadata(&session).unwrap()[&first]["claude_todos"]
                ["items"][0]["status"],
            "pending"
        );
        store
            .commit_claude_rewind(&session, &[first], 0, None)
            .unwrap();
        assert!(store.get_messages(&session).unwrap().is_empty());
        assert!(store.get_todos(&session).unwrap().items.is_empty());
        assert!(store
            .latest_cli_session_id(&session, "claude_code")
            .unwrap()
            .is_none());
    }
    #[test]
    fn active_run_prevents_history_commit() {
        let root = tempfile::tempdir().unwrap();
        let store = SessionStore::new(root.path()).unwrap();
        let session = store
            .create_session("busy", None, None, "chat", None)
            .unwrap();
        let id = store
            .add_message(&session, MessageRole::User, "keep")
            .unwrap();
        store
            .try_start_run_scoped(&session, "active", None)
            .unwrap();
        assert!(store
            .commit_claude_rewind(&session, &[id], 0, None)
            .unwrap_err()
            .contains("active"));
        assert_eq!(store.get_messages(&session).unwrap().len(), 1);
    }
}
