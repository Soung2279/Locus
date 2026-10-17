//! Only the SSH handshake can consume this secret. It is never part of config,
//! session metadata, debug output, argv, or the frontend's saved settings.
use super::SshConfig;
use zeroize::Zeroizing;

pub enum UnlockPassword {
    Saved,
    Supplied(Zeroizing<String>),
}

impl UnlockPassword {
    pub fn supplied(value: String) -> Result<Self, String> {
        let value = Zeroizing::new(value);
        if value.is_empty() || value.len() > 4096 || value.contains('\0') {
            return Err("Enter a keychain password of 1–4096 bytes without NUL characters".into());
        }
        Ok(Self::Supplied(value))
    }

    pub fn resolve(&self, key: &str) -> Result<Option<Zeroizing<String>>, String> {
        match self {
            Self::Saved => crate::keychain::get_secret(key).map(|v| v.map(Zeroizing::new)),
            Self::Supplied(value) => Ok(Some(value.clone())),
        }
    }
}

pub fn key(config: &SshConfig) -> Result<String, String> {
    config.validate()?;
    // Isolated app profiles must not consume or overwrite the real app's password.
    let scope = crate::commands::persistent_config_dir()?;
    Ok(scoped_key(config, &scope.to_string_lossy()))
}

fn scoped_key(config: &SshConfig, scope: &str) -> String {
    let id = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("{scope}\0{}", config.fingerprint()).as_bytes(),
    );
    format!("claude-ssh-unlock/{id}")
}

pub fn has_saved(config: &SshConfig) -> Result<bool, String> {
    Ok(UnlockPassword::Saved.resolve(&key(config)?)?.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn passwords_are_bound_to_the_exact_server_and_app_profile() {
        let mut config: SshConfig =
            serde_json::from_value(serde_json::json!({"target":"user@mac"})).unwrap();
        let first = scoped_key(&config, "test-profile");
        assert_ne!(first, scoped_key(&config, "real-profile"));
        config.target = "user@linux".into();
        assert_ne!(first, scoped_key(&config, "test-profile"));
        assert!(UnlockPassword::supplied(String::new()).is_err());
        assert!(UnlockPassword::supplied("a\0b".into()).is_err());
        let password = UnlockPassword::supplied("  whitespace is significant  ".into()).unwrap();
        assert_eq!(
            password.resolve("unused").unwrap().unwrap().as_str(),
            "  whitespace is significant  "
        );
    }

    #[test]
    #[ignore = "Writes and removes a disposable synthetic credential in the OS vault"]
    fn os_vault_roundtrip_uses_only_a_disposable_secret() {
        let key = format!("claude-ssh-unlock/test-{}", uuid::Uuid::new_v4());
        let result = (|| -> Result<(), String> {
            crate::keychain::set_secret(&key, "synthetic-test-password")?;
            let value = UnlockPassword::Saved.resolve(&key)?;
            assert_eq!(
                value.as_deref().map(String::as_str),
                Some("synthetic-test-password")
            );
            crate::keychain::set_secret(&key, "replacement-test-password")?;
            let value = UnlockPassword::Saved.resolve(&key)?;
            assert_eq!(
                value.as_deref().map(String::as_str),
                Some("replacement-test-password")
            );
            Ok(())
        })();
        let cleanup = crate::keychain::delete_secret(&key);
        result.unwrap();
        cleanup.unwrap();
        assert!(UnlockPassword::Saved.resolve(&key).unwrap().is_none());
    }
}
