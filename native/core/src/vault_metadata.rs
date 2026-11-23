//! The metadata visible in the management panel. The standalone gateway keeps
//! only this projection after loading the legacy vault during startup.
use crate::{js, js::JsValue as V, secret_audit};
use icu_collator::{options::CollatorOptions, Collator};
use icu_locale_core::Locale;
use serde_json::{json, Value};
use std::{fs, path::Path, time::Instant};

pub fn legacy_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

fn text(entry: &V, key: &str, limit: usize, default: &str) -> V {
    match entry.get(key) {
        Some(V::String(s)) if !s.is_empty() => V::String(s.truncate_units(limit)),
        _ => V::from(default),
    }
}

fn locale() -> Locale {
    let tag = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    tag.split(['.', '@'])
        .next()
        .unwrap_or("")
        .replace('_', "-")
        .parse()
        .unwrap_or(icu_locale_core::locale!("en-US"))
}

pub struct Catalog(Vec<u8>);

impl Catalog {
    pub fn load(file: &Path) -> Self {
        let data = fs::read(file)
            .ok()
            .and_then(|bytes| js::json_parse(&String::from_utf8_lossy(&bytes)).ok());
        let mut items = indexmap::IndexMap::new();
        if let Some(V::Array(entries)) = data {
            for entry in entries {
                let Some(id) = entry.get("name").filter(|v| js::truthy(v)) else {
                    continue;
                };
                let name = js::js_to_string(id).to_string_lossy();
                if !legacy_name(&name) || !matches!(entry.get("value"), Some(V::String(_))) {
                    continue;
                }
                let timestamp = |key| {
                    entry
                        .get(key)
                        .filter(|v| js::truthy(v))
                        .cloned()
                        .unwrap_or(V::Null)
                };
                let mut fields = vec![
                    ("name", V::from(name.as_str())),
                    ("description", text(&entry, "description", 500, "")),
                    ("source", text(&entry, "source", 64, "user")),
                    ("createdAt", timestamp("createdAt")),
                    ("updatedAt", timestamp("updatedAt")),
                ];
                if matches!(entry.get("updatedBy"), Some(V::String(s)) if !s.is_empty()) {
                    fields.push(("updatedBy", text(&entry, "updatedBy", 128, "")));
                }
                items.insert(name, V::object(fields));
            }
        }
        let mut rows: Vec<_> = items.into_iter().collect();
        let collator = Collator::try_new(locale().into(), CollatorOptions::default())
            .expect("compiled ICU collation data");
        rows.sort_by(|a, b| collator.compare(&a.0, &b.0));
        let rows = V::Array(rows.into_iter().map(|(_, row)| row).collect());
        Self(
            js::json_stringify(&rows)
                .expect("metadata array")
                .into_bytes(),
        )
    }

    /// Match the old store's two durable audit events, including on HEAD and
    /// conditional requests. An audit failure suppresses the entire response.
    pub fn list(&self, audit_file: &Path) -> Result<Vec<u8>, &'static str> {
        let file = audit_file.to_str().ok_or("invalid audit path")?;
        let start = secret_audit::record(
            file,
            r#"{"operation":"list","source":"http","phase":"started"}"#,
        )
        .map_err(|_| "audit unavailable")?;
        let started = Instant::now();
        let id: Value = serde_json::from_str(&start).map_err(|_| "invalid audit receipt")?;
        let body = self.0.clone();
        let end = json!({"operation":"list","source":"http","phase":"completed","callId":id["callId"],"durationMs":started.elapsed().as_millis()});
        secret_audit::record(file, &end.to_string()).map_err(|_| "audit unavailable")?;
        Ok(body)
    }
}
