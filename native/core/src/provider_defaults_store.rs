//! Native owner for the live provider defaults and their legacy JSON file.
//!
//! This owner is not wired into the production host yet. Callers must share a
//! single instance and must not maintain a second writable copy of its state.
use std::{fs, path::PathBuf};

use crate::js::{self, JsValue};

pub struct ProviderDefaultsStore {
    file: PathBuf,
    current: JsValue,
    read_failed: bool,
}

impl ProviderDefaultsStore {
    pub fn open(file: PathBuf) -> Self {
        let (stored, read_failed) = match fs::read(&file) {
            Ok(bytes) => (js::json_parse(&String::from_utf8_lossy(&bytes)).ok(), false),
            Err(error) => (None, error.kind() != std::io::ErrorKind::NotFound),
        };
        let mut entries = Vec::new();
        for key in ["claude", "codex"] {
            let value = stored
                .as_ref()
                .and_then(|value| value.get(key))
                .filter(|value| js::truthy(value))
                .cloned()
                .unwrap_or(JsValue::Null);
            entries.push((key.into(), value));
        }
        if let Some(subagent) = stored.as_ref().and_then(|value| value.get("subagent")) {
            let input = JsValue::object(vec![("stored", subagent.clone())]);
            let normalized = js::json_stringify(&input)
                .and_then(|input| crate::subagent_defaults::normalize(&input).ok())
                .and_then(|output| js::json_parse(&output).ok())
                .unwrap_or_else(|| subagent.clone());
            entries.push(("subagent".into(), normalized));
        }
        Self {
            file,
            current: JsValue::Object(entries),
            read_failed,
        }
    }

    pub fn assert_readable(&self) -> Result<(), &'static str> {
        if self.read_failed {
            Err("PROVIDER_DEFAULTS_READ_FAILED")
        } else {
            Ok(())
        }
    }

    pub fn snapshot(&self) -> JsValue {
        self.current.clone()
    }

    pub fn get(&self, key: &str) -> JsValue {
        self.current.get(key).cloned().unwrap_or(JsValue::Undefined)
    }

    pub fn set(&mut self, key: &str, value: JsValue) {
        let JsValue::Object(entries) = &mut self.current else {
            unreachable!("defaults state is always an object")
        };
        if let Some((_, existing)) = entries.iter_mut().find(|(name, _)| name == key) {
            *existing = value;
        } else {
            entries.push((key.into(), value));
        }
    }

    pub fn delete(&mut self, key: &str) {
        let JsValue::Object(entries) = &mut self.current else {
            unreachable!("defaults state is always an object")
        };
        entries.retain(|(name, _)| name != key);
    }

    pub fn patch(&mut self, value: JsValue) {
        if let JsValue::Object(entries) = value {
            for (key, value) in entries {
                let JsValue::Object(current) = &mut self.current else {
                    unreachable!("defaults state is always an object")
                };
                if let Some((_, existing)) = current.iter_mut().find(|(name, _)| *name == key) {
                    *existing = value;
                } else {
                    current.push((key, value));
                }
            }
        }
    }

    /// Publish immediately; `persist` may then fail without undoing memory.
    /// This matches the legacy default-provider PUT's best-effort save.
    pub fn replace(&mut self, next: JsValue) -> Result<(), &'static str> {
        if !matches!(next, JsValue::Object(_)) {
            return Err("PROVIDER_DEFAULTS_INVALID_STATE");
        }
        self.current = next;
        Ok(())
    }

    pub fn persist(&self) -> Result<(), &'static str> {
        self.write(&self.current)
    }

    /// Subagent updates publish only after the file write succeeds.
    pub fn commit(&mut self, next: JsValue) -> Result<(), &'static str> {
        if !matches!(next, JsValue::Object(_)) {
            return Err("PROVIDER_DEFAULTS_INVALID_STATE");
        }
        self.write(&next)?;
        self.current = next;
        Ok(())
    }

    fn write(&self, value: &JsValue) -> Result<(), &'static str> {
        let json = js::json_stringify(value).ok_or("PROVIDER_DEFAULTS_INVALID_STATE")?;
        let pretty = crate::durable_state::pretty_compact(&json);
        crate::state_file::write_text_atomic(&self.file, &pretty, 0o600, 0o700)
            .map_err(|_| "PROVIDER_DEFAULTS_WRITE_FAILED")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SERIAL: AtomicU64 = AtomicU64::new(0);

    fn path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "multicc-provider-defaults-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn loads_legacy_shape_normalizes_subagent_and_reloads_durable_state() {
        let dir = path();
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("defaults.json");
        fs::write(&file, r#"{"claude":"route","codex":"","extra":1,"subagent":{"claude":{"providerId":" p ","model":" m "}}}"#).unwrap();
        let mut owner = ProviderDefaultsStore::open(file.clone());
        assert_eq!(
            js::json_stringify(&owner.snapshot()).unwrap(),
            r#"{"claude":"route","codex":null,"subagent":{"claude":{"providerId":"p","model":"m"},"codex":null}}"#
        );
        let next = js::json_parse(r#"{"claude":"\ud800","codex":null}"#).unwrap();
        owner.commit(next.clone()).unwrap();
        assert_eq!(ProviderDefaultsStore::open(file).snapshot(), next);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_commit_keeps_memory_but_best_effort_replace_does_not_roll_back() {
        let dir = path();
        fs::write(&dir, "parent is not a directory").unwrap();
        let mut owner = ProviderDefaultsStore::open(dir.join("defaults.json"));
        let before = owner.snapshot();
        let next = js::json_parse(r#"{"claude":"new","codex":null}"#).unwrap();
        assert_eq!(
            owner.commit(next.clone()),
            Err("PROVIDER_DEFAULTS_WRITE_FAILED")
        );
        assert_eq!(owner.snapshot(), before);
        owner.replace(next.clone()).unwrap();
        assert_eq!(owner.persist(), Err("PROVIDER_DEFAULTS_WRITE_FAILED"));
        assert_eq!(owner.snapshot(), next);
        fs::remove_file(dir).unwrap();
    }
}
