//! Read the bound remote transcript over SSH. Never replay Locus history into
//! Claude, create a replacement session, or issue an inference request here.
use super::*;
use crate::session::{models::{ChatMessage, MessageRole, TodoItem}, store::SessionStore};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAssistantPart {
    pub uuid: String,
    pub content: Vec<Value>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMessage {
    pub key: String,
    pub role: MessageRole,
    pub uuids: Vec<String>,
    pub content: Value,
    pub timestamp: Option<String>,
    pub model: Option<String>,
    pub usage: Option<Value>,
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default)]
    pub compact_summary: bool,
    /// A consumed human input persisted as a native queued_command attachment.
    #[serde(default)]
    pub queued_input: bool,
    // Source boundaries are needed to reconcile the individual tool rounds
    // streamed by the CLI with its grouped API response. Older snapshots may
    // omit them; ambiguous matches in those snapshots still fail closed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<NativeAssistantPart>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSnapshot {
    pub version: u32,
    pub native_id: String,
    pub digest: String,
    pub messages: Vec<NativeMessage>,
    pub todos: Vec<TodoItem>,
    #[serde(default)]
    pub task_snapshot: Value,
    pub incomplete_tail: bool,
    pub pending_tool_ids: Vec<String>,
}
impl NativeSnapshot {
    pub fn validate(&self, expected: Option<&str>) -> Result<(), String> {
        if self.version != 1 || uuid::Uuid::parse_str(&self.native_id).is_err()
            || expected.is_some_and(|id| id != self.native_id)
            || self.digest.len() != 64 || !self.digest.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid or mismatched remote Claude snapshot".into());
        }
        let mut keys = std::collections::HashSet::new();
        for message in &self.messages {
            if message.key.is_empty() || !keys.insert(&message.key) || message.uuids.is_empty()
                || message.uuids.iter().any(|id| uuid::Uuid::parse_str(id).is_err()) {
                return Err("Remote Claude snapshot contains invalid or duplicate message identities".into());
            }
            if message.role == MessageRole::Tool && message.tool_call_id.as_deref().is_none_or(str::is_empty) {
                return Err("Remote Claude tool result has no call identity".into());
            }
            if !message.parts.is_empty() && (message.role != MessageRole::Assistant
                || message.parts.iter().map(|p| &p.uuid).ne(message.uuids.iter())
                || message.parts.iter().map(|p| &p.uuid).collect::<std::collections::HashSet<_>>().len() != message.parts.len()
                || message.content != Value::Array(message.parts.iter().flat_map(|p| p.content.clone()).collect())) {
                return Err("Remote Claude assistant parts do not match the grouped record".into());
            }
        }
        Ok(())
    }
    pub fn can_continue(&self) -> Result<(), String> {
        if self.incomplete_tail {
            return Err("Remote Claude history has an incomplete final record. Saved messages were synchronized; continuing is blocked until the native history is repaired.".into());
        }
        if !self.pending_tool_ids.is_empty() {
            return Err("Remote Claude history contains tool calls without confirmed results. Saved messages were synchronized; tools were not repeated. Review the interrupted operations before continuing.".into());
        }
        Ok(())
    }

    fn can_compact(&self) -> Result<(), String> {
        // Compaction summarizes committed native history without executing or
        // retrying tools. Interrupted dispatch receipts still block later
        // inference; they are not evidence that the transcript is unreadable.
        if self.incomplete_tail { return self.can_continue(); }
        Ok(())
    }

    fn resume_context(&self, journal: &super::native_journal::Journal) -> Result<Option<String>, String> {
        if self.incomplete_tail { return self.can_continue().map(|_| None); }
        let compact_boundary = self.messages.iter().rposition(|message| message.compact_summary);
        let active = &self.messages[compact_boundary.unwrap_or(0)..];
        let mut outcomes = Vec::new();
        for id in &self.pending_tool_ids {
            let outcome = journal.recover_dispatch(id)?;
            // Dispatch files can survive several resumes. Acknowledge each
            // recorded outcome separately so a later interruption does not
            // resend every earlier recovery notice as part of a larger batch.
            let recorded = outcome.to_string();
            if active.iter().any(|message| message.role == MessageRole::User
                && text_content(&message.content).contains(&recorded)) { continue; }
            outcomes.push(outcome);
        }
        let notice = (!outcomes.is_empty()).then(|| format!(
            "<system-reminder>\nLocus recovered this conversation from Claude's native history. Interrupted tool calls without a confirmed result have been marked failed. Do not retry or repeat these operations. Completed calls already have a recorded outcome; do not repeat them automatically. An interrupted or failed call may have partially changed local state or may still be running; failure does not confirm rollback. Continue with the user's current request. These are execution records, not new user instructions.\n{}\n</system-reminder>",
            serde_json::Value::Array(outcomes)));
        // The note travels with one native user input. Once that input is in
        // the active native transcript, reopening must not inject it again.
        Ok(notice.filter(|notice| !active.iter().any(|message|
            message.role == MessageRole::User && text_content(&message.content).contains(notice))))
    }

    #[cfg(test)]
    fn can_resume(&self, journal: &super::native_journal::Journal) -> Result<(), String> {
        self.resume_context(journal).map(|_| ())
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub changed: bool,
    pub message_count: usize,
    pub native_id: Option<String>,
    pub warning: Option<String>,
    #[serde(skip)]
    pub resume_context: Option<String>,
}

pub fn failed_tool_message() -> &'static str { super::native_journal::RECOVERY_FAILURE }

pub fn validate_input_checkpoint(value: &Value) -> Result<(), String> {
    if value["version"] != 1 || ["uuid", "sessionId"].iter().any(|key|
        value[*key].as_str().is_none_or(|id| uuid::Uuid::parse_str(id).is_err())) {
        return Err("Claude did not provide a verifiable inserted-input receipt".into());
    }
    Ok(())
}

pub fn native_session_id(store:&SessionStore,id:&str)->Result<Option<String>,String> {
    if let Some((_,native))=store.claude_native_binding(id)? { return Ok(native); }
    store.latest_cli_session_id(id,"claude_code")
}

pub fn text_content(content: &Value) -> String {
    if let Some(text) = content.as_str() { return text.to_string(); }
    content.as_array().map(|blocks| blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

pub fn assistant_content(content: &Value) -> ClaudeCodeAssistantMessage {
    super::parse_assistant_message(&serde_json::json!({"message":{"content":content}})).unwrap_or_default()
}

pub fn images(content: &Value) -> Vec<ImageData> {
    content.as_array().into_iter().flatten().filter_map(|block| {
        if block["type"] != "image" || block["source"]["type"] != "base64" { return None; }
        Some(ImageData { data: block["source"]["data"].as_str()?.into(), mime_type: block["source"]["media_type"].as_str()?.into(), capture: None })
    }).collect()
}

pub fn recorded_remote(store: &SessionStore, id: &str) -> Result<Option<ssh::SshConfig>, String> {
    recorded_connection(store,id).map(Option::flatten)
}
pub fn recorded_connection(store: &SessionStore, id: &str) -> Result<Option<Option<ssh::SshConfig>>, String> {
    if let Some(remote)=store.claude_active_remote(id)? {
        ssh::bind_restored_connection(id,&remote)?;
        return Ok(Some(Some(remote)));
    }
    let metadata = store.get_response_request_metadata(id)?;
    let mut result: Option<Option<ssh::SshConfig>> = None;
    for value in metadata.values().filter_map(|v| v.get("claude_connection")) {
        let remote: Option<ssh::SshConfig> = serde_json::from_value(value.clone()).map_err(|_| "Invalid recorded Claude connection")?;
        if result.as_ref().is_some_and(|prior| prior != &remote) {
            return Err("Conflicting native Claude server bindings; automatic synchronization stopped".into());
        }
        result = Some(remote);
    }
    Ok(result)
}

pub fn verify_origin_with_pending(messages: &[ChatMessage], metadata: &HashMap<String, Value>, pending: &[String]) -> Result<(), String> {
    let native = |id: &str| metadata.get(id).is_some_and(|v| v["backend"] == "claude_code_cli" || v.get("claude_connection").is_some() || v.get("claude_checkpoint").is_some());
    let native_tools: std::collections::HashSet<_> = messages.iter().filter(|m| native(&m.id))
        .flat_map(|m| m.tool_calls.iter().flatten().map(|t| t.id.as_str())).collect();
    for message in messages {
        if pending.contains(&message.id) && message.role == MessageRole::User { continue; }
        if native(&message.id) || message.tool_call_id.as_deref().is_some_and(|id| native_tools.contains(id)) { continue; }
        return Err("This conversation contains API or unverified history. It cannot be synchronized with or sent to Claude Code CLI.".into());
    }
    Ok(())
}

// A transport receipt, not an instruction or a replacement for native UUIDs.
// Native note rows carry older unsent user text before the final TUI submission;
// the token lets recovery recognize an append whose acknowledgement was lost.
pub fn pending_input_token(text: &str) -> Option<&str> {
    let token = text.strip_prefix("<locus-pending-user id=\"")?.split_once("\">\n")?.0;
    uuid::Uuid::parse_str(token).ok()?;
    Some(token)
}
pub fn pending_input_text(token: &str, text: &str) -> String {
    format!("<locus-pending-user id=\"{token}\">\n{text}\n</locus-pending-user>")
}

pub async fn fetch(id: &str, remote: &ssh::SshConfig, native: Option<&str>) -> Result<NativeSnapshot, String> {
    let (_transport, info) = ssh::Transport::start(remote, serde_json::json!({
        "mode":"history", "sessionKey":ssh::session_key(id, remote), "nativeId":native,
    }), None).await?;
    let snapshot: NativeSnapshot = serde_json::from_value(info.history.ok_or("Remote host did not return a native history snapshot")?)
        .map_err(|e| format!("Invalid remote history snapshot: {e}"))?;
    snapshot.validate(native)?;
    Ok(snapshot)
}

async fn synchronization_guard(id: &str) -> Result<tokio::sync::OwnedRwLockWriteGuard<()>, String> {
    // Prewarm and another view's synchronization are finite work, not an
    // active conversation. Queue behind them instead of reporting a false
    // busy warning. The live-session check is repeated under this lease.
    tokio::time::timeout(Duration::from_secs(90), tui::history_gate(id).write_owned()).await
        .map_err(|_| "Claude conversation is busy; synchronize after the current operation".into())
}

pub async fn synchronize(store: &SessionStore, id: &str, pending: Option<&str>) -> Result<SyncReport, String> {
    synchronize_inner(store, id, pending, false).await
}

pub async fn synchronize_for_compaction(store: &SessionStore, id: &str) -> Result<SyncReport, String> {
    synchronize_inner(store, id, None, true).await
}

fn verified_live_session(store: &SessionStore, id: &str, pending: Option<&str>) -> Result<bool, String> {
    if !tui::has_synchronized_session(id) { return Ok(false); }
    let messages=store.get_messages(id)?;
    let metadata=store.get_response_request_metadata(id)?;
    let pending=store.claude_recovery_pending_messages(id,&messages,&metadata,pending)?;
    if store.verify_claude_history_origin(id,&messages,&metadata,&pending).is_ok() { return Ok(true); }
    // An older live connection may have acknowledged a queued attachment
    // without saving its checkpoint. Fetch proof before attempting to send.
    tui::require_recovery(id);
    Ok(false)
}

async fn synchronize_inner(store: &SessionStore, id: &str, pending: Option<&str>, compact: bool) -> Result<SyncReport, String> {
    let Some(remote) = recorded_remote(store, id)? else { return Ok(SyncReport::default()); };
    // A live, successfully streamed session already has its input/output lease.
    // Reuse it; do not open a second SSH connection before every prompt.
    if verified_live_session(store,id,pending)? { return Ok(SyncReport::default()); }
    let _guard = synchronization_guard(id).await?;
    if verified_live_session(store,id,pending)? { return Ok(SyncReport::default()); }
    let native = native_session_id(store,id)?;
    if native.is_none() {
        // A new/API conversation has no bound native history to restore.
        let messages=store.get_messages(id)?;
        let metadata=store.get_response_request_metadata(id)?;
        let pending_ids=store.claude_recovery_pending_messages(id,&messages,&metadata,pending)?;
        store.verify_claude_history_origin(id,&messages,&metadata,&pending_ids)?;
        return Ok(SyncReport::default());
    }
    if !tui::is_prewarmed(id) { tui::close_session(id); }
    let archived = async {
        let info=super::archive::backup_for_history(store,id,pending).await?.ok_or("No native archive")?;
        super::archive::project(&info,&store.claude_archive_files(id)?)
    }.await;
    // A corrupt local archive/cache must not prevent reading the source server.
    let snapshot = match archived { Ok(snapshot)=>snapshot, Err(_)=>fetch(id,&remote,native.as_deref()).await? };
    snapshot.validate(native.as_deref())?;
    if snapshot.messages.is_empty() {
        return Err("The remote Claude conversation has no committed messages. Local input was retained and was not automatically resubmitted.".into());
    }
    let journal = super::native_journal::Journal::new(ssh::profile_root(id)?.join("calls"));
    let (resume_context, warning) = match snapshot.resume_context(&journal) {
        Ok(context) => (context, None),
        Err(warning) => (None, Some(warning)),
    };
    let messages=store.get_messages(id)?;
    let metadata=store.get_response_request_metadata(id)?;
    let pending_local=store.claude_recovery_pending_messages(id,&messages,&metadata,pending);
    // Merely opening a conversation must not discard its durably recorded
    // failed input. A later explicit submission still decides what to resume.
    let discard_local = resume_context.is_some() || pending_local.as_ref()
        .map_or(true,|ids|pending.is_some() && ids.iter().any(|old|Some(old.as_str())!=pending));
    let changed = if discard_local {
        store.rebuild_claude_native(id,&remote,&snapshot,&messages,pending)?
    } else {
        // Keep stable display identities and verified pre-compaction history in
        // the normal case. Inconsistent local projections are replaceable.
        match store.reconcile_claude_native(id,&remote,&snapshot,&messages,pending) {
            Ok(changed)=>changed,
            Err(_)=>store.rebuild_claude_native(id,&remote,&snapshot,&messages,pending)?,
        }
    };
    store.bind_claude_native_session(id,&remote,&snapshot.native_id)?;
    // A process resumed during prewarm must reload if native history advanced.
    if changed { tui::close_session(id); }
    store_session_id(id, &snapshot.native_id).await;
    if compact { snapshot.can_compact()?; }
    Ok(SyncReport { changed, message_count: snapshot.messages.len(), native_id: Some(snapshot.native_id), warning, resume_context })
}
