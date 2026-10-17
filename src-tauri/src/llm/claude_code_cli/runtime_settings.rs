//! Per-process preferences shared by local terminals, probes and SSH hosts.
use std::collections::HashMap;
use std::ffi::OsString;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettings {
    #[serde(default)]
    pub idle_compaction: bool,
    #[serde(default)]
    pub telemetry: bool,
}

impl RuntimeSettings {
    pub fn cli_settings(self, bypass_permissions: bool) -> serde_json::Value {
        let mut settings = serde_json::json!({"idleCompaction": self.idle_compaction});
        if bypass_permissions {
            settings["skipDangerousModePermissionPrompt"] = serde_json::json!(true);
        }
        settings
    }

    pub fn apply_env(self, env: &mut HashMap<OsString, OsString>) {
        // The unprefixed name is not recognized by supported Claude builds.
        env.remove(std::ffi::OsStr::new("DISABLE_NONESSENTIAL_TRAFFIC"));
        for key in ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING"] {
            if self.telemetry {
                // These variables test presence: "0" still disables traffic.
                env.remove(std::ffi::OsStr::new(key));
            } else {
                env.insert(key.into(), "1".into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_disable_idle_compaction_without_disabling_normal_compaction() {
        let settings = RuntimeSettings::default();
        assert_eq!(settings.cli_settings(false), serde_json::json!({"idleCompaction": false}));
        assert_eq!(settings.cli_settings(true), serde_json::json!({"idleCompaction": false, "skipDangerousModePermissionPrompt": true}));
    }

    #[test]
    fn telemetry_preferences_use_supported_names_and_preserve_provider_and_gzip() {
        let mut env = HashMap::from([
            ("DISABLE_NONESSENTIAL_TRAFFIC".into(), "1".into()),
            ("ANTHROPIC_BASE_URL".into(), "https://example.test".into()),
            ("CLAUDE_CODE_GZIP_REQUEST_BODIES".into(), "1".into()),
        ]);
        RuntimeSettings::default().apply_env(&mut env);
        assert!(!env.contains_key(std::ffi::OsStr::new("DISABLE_NONESSENTIAL_TRAFFIC")));
        for key in ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING"] {
            assert_eq!(env.get(std::ffi::OsStr::new(key)), Some(&OsString::from("1")));
        }
        RuntimeSettings { telemetry: true, idle_compaction: true }.apply_env(&mut env);
        assert_eq!(env.len(), 2);
        assert_eq!(env.get(std::ffi::OsStr::new("CLAUDE_CODE_GZIP_REQUEST_BODIES")), Some(&OsString::from("1")));
    }
}
