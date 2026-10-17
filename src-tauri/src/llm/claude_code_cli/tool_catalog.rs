//! Session-pinned CLI schemas. Discovery only appends deferred definitions;
//! it never promotes a loaded tool or replaces an earlier cache-prefix schema.
use super::ClaudeCodeToolDefinition;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct ToolCatalog {
    version: u32,
    pub native_tool_search: bool,
    initialized: bool,
    pub tools: Vec<ClaudeCodeToolDefinition>,
}

impl ToolCatalog {
    pub fn load(path: &Path, native_tool_search: bool) -> Result<Self, String> {
        match std::fs::read(path) {
            Ok(bytes) => {
                let catalog: Self = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("Cannot restore Claude tool catalog: {error}"))?;
                if catalog.version != 1 || catalog.native_tool_search != native_tool_search {
                    return Err("Claude tool loading is pinned for this conversation to preserve its prompt cache. Restore the original loading mode or start a new conversation.".into());
                }
                Ok(catalog)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self {
                version: 1, native_tool_search, initialized: false, tools: Vec::new(),
            }),
            Err(error) => Err(format!("Cannot read Claude tool catalog: {error}")),
        }
    }

    /// Validate the complete delta before changing anything. Absence is not
    /// removal: old tool_reference blocks must keep their original definitions.
    /// Execution authorization remains the Agent host's responsibility.
    pub fn merge(&mut self, incoming: &[ClaudeCodeToolDefinition]) -> Result<Vec<ClaudeCodeToolDefinition>, String> {
        let mut next = self.tools.clone();
        let mut added = Vec::new();
        for tool in incoming {
            if tool.name == "read" { continue; }
            if let Some(prior) = next.iter().find(|prior| prior.name == tool.name) {
                if prior.description != tool.description || prior.input_schema != tool.input_schema {
                    return Err(format!("Claude tool '{}' changed its definition. No model request was sent with a changed tool prefix. Start a new conversation to use the new schema.", tool.name));
                }
                continue;
            }
            let mut tool = tool.clone();
            // This also covers a Skill that introduces a normally-direct tool.
            // Only the very first catalog may choose the eager prefix.
            tool.defer_loading = self.native_tool_search && (self.initialized || tool.defer_loading);
            next.push(tool.clone());
            added.push(tool);
        }
        self.tools = next;
        self.initialized = true;
        Ok(added)
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        crate::config::atomic_write_config(path, &bytes).map_err(|error| error.to_string())
    }
}

pub(crate) fn path(session_id: &str) -> Result<PathBuf, String> {
    Ok(super::ssh::profile_root(session_id)?.join("tool-catalog.json"))
}

pub(crate) fn native_mode_for_session(session_id: &str, resuming: bool) -> Result<bool, String> {
    native_mode_at(&path(session_id)?, resuming)
}

fn native_mode_at(path: &Path, resuming: bool) -> Result<bool, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let catalog: ToolCatalog = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            if catalog.version != 1 { return Err("Unsupported Claude tool catalog version".into()); }
            Ok(catalog.native_tool_search)
        }
        // Never silently migrate an old conversation's eager prefix. Native
        // loading starts with a new conversation, not its first later search.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(!resuming),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn registered_names(session_id: &str) -> Result<Vec<String>, String> {
    let path = path(session_id)?;
    match std::fs::read(path) {
        Ok(bytes) => {
            let catalog: ToolCatalog = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            if catalog.version != 1 { return Err("Unsupported Claude tool catalog version".into()); }
            Ok(catalog.tools.into_iter().map(|tool| tool.name).collect())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn copy_for_fork(source: &str, target: &str) -> Result<(), String> {
    let source = path(source)?;
    if source.is_file() {
        let bytes = std::fs::read(source).map_err(|error| error.to_string())?;
        crate::config::atomic_write_config(&path(target)?, &bytes).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tool(name: &str, deferred: bool) -> ClaudeCodeToolDefinition {
        ClaudeCodeToolDefinition { name: name.into(), description: name.into(), input_schema: serde_json::json!({"type":"object"}), defer_loading: deferred }
    }
    #[test]
    fn native_catalog_keeps_eager_prefix_and_appends_only_deferred_tools() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("catalog.json");
        let mut catalog = ToolCatalog::load(&path, true).unwrap();
        catalog.merge(&[tool("core", false), tool("first_skill", true)]).unwrap();
        let eager = catalog.tools[0].clone();
        let delta = catalog.merge(&[tool("core", true), tool("new_skill", false)]).unwrap();
        assert_eq!(catalog.tools[0], eager);
        assert!(delta[0].defer_loading);
        assert_eq!(catalog.tools.len(), 3);
        catalog.save(&path).unwrap();
        let mut resumed = ToolCatalog::load(&path, true).unwrap();
        assert!(resumed.merge(&[tool("after_resume", false)]).unwrap()[0].defer_loading);
        assert_eq!(resumed.tools[0], eager);
        assert!(ToolCatalog::load(&path, false).is_err());
    }
    #[test]
    fn existing_conversations_are_not_migrated_on_first_search() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("catalog.json");
        assert!(native_mode_at(&path, false).unwrap());
        assert!(!native_mode_at(&path, true).unwrap());
        let mut catalog = ToolCatalog::load(&path, true).unwrap();
        catalog.merge(&[]).unwrap();
        catalog.save(&path).unwrap();
        assert!(native_mode_at(&path, true).unwrap());
    }
    #[test]
    fn empty_initial_catalog_is_sealed_and_schema_changes_are_atomic() {
        let root = tempfile::tempdir().unwrap();
        let mut catalog = ToolCatalog::load(&root.path().join("catalog.json"), true).unwrap();
        catalog.merge(&[]).unwrap();
        assert!(catalog.merge(&[tool("late", false)]).unwrap()[0].defer_loading);
        let before = catalog.tools.clone();
        let mut changed = tool("late", true);
        changed.description = "changed".into();
        assert!(catalog.merge(&[tool("not_committed", true), changed]).is_err());
        assert_eq!(catalog.tools, before);
    }
}
