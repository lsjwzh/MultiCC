//! Notification settings and device summaries owned by the standalone gateway.
use std::collections::HashSet;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};

use axum::{body::Body, http::Response};
use multicc_core::js::serde::truthy;
use multicc_core::js::string::{js_trim, utf16_len};
use serde_json::{json, Value};
use url::Url;

use super::{express, host_read, App};
use express::RequestCtx;
use multicc_core::{dotenv, notify_settings, provider_store, state_file};

#[derive(Clone)]
pub(super) struct Destinations {
    pub(super) bark: String,
    pub(super) webhook: String,
}

pub(super) struct Config {
    current: RwLock<Destinations>,
    writes: Mutex<()>,
}

impl Config {
    pub(super) fn from_env() -> Self {
        Self {
            writes: Mutex::new(()),
            current: RwLock::new(Destinations {
                bark: std::env::var("BARK_URL").unwrap_or_default(),
                webhook: std::env::var("WEBHOOK_URL").unwrap_or_default(),
            }),
        }
    }

    pub(super) fn snapshot(&self) -> Destinations {
        self.current.read().unwrap().clone()
    }
}

fn canonical_bark_url(raw: &str) -> Option<Url> {
    let mut url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || utf16_len(raw) > 2048
        || raw
            .chars()
            .any(|c| c == '•' || c == '\u{feff}' || c.is_whitespace())
    {
        return None;
    }
    let mut parts = url.path_segments()?.filter(|part| !part.is_empty());
    let first = parts.next()?;
    if first.eq_ignore_ascii_case("YOUR_KEY") || first.eq_ignore_ascii_case("yourkey") {
        return None;
    }
    let path = if url.host_str() == Some("api.day.app") {
        first.to_owned()
    } else {
        std::iter::once(first)
            .chain(parts)
            .collect::<Vec<_>>()
            .join("/")
    };
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    (url.as_str() == raw).then_some(url)
}

fn public_devices(state: &Value, legacy_url: &str) -> Option<Vec<Value>> {
    let devices = state.get("devices")?.as_array()?;
    let legacy = state.get("legacy")?;
    if state["version"].as_f64() != Some(1.0)
        || devices.len() > 20
        || !(legacy.is_object() || legacy.is_array())
    {
        return None;
    }
    let mut rows = Vec::new();
    if !legacy_url.is_empty() && !truthy(&legacy["removed"]) {
        let name = if truthy(&legacy["name"]) {
            legacy["name"].clone()
        } else {
            json!("原有手机")
        };
        let origin = Url::parse(legacy_url)
            .ok()
            .map(|u| u.origin().ascii_serialization())
            .unwrap_or_default();
        rows.push(
            json!({"id":"legacy", "name": name, "enabled": legacy["enabled"] != false,
            "legacy":true, "origin":origin}),
        );
    }
    let mut seen = HashSet::new();
    for device in devices {
        let id = device["id"].as_str()?;
        let name = device["name"].as_str()?;
        if id == "legacy"
            || !seen.insert(id)
            || name.is_empty()
            || js_trim(name) != name
            || utf16_len(name) > 60
        {
            return None;
        }
        let url = canonical_bark_url(device["url"].as_str()?)?;
        rows.push(
            json!({"id":id, "name":name, "enabled":device["enabled"].as_bool()?,
            "legacy":truthy(&device["legacy"]), "origin":url.origin().ascii_serialization()}),
        );
    }
    Some(rows)
}

pub(super) async fn devices(root: &Path, legacy_url: &str) -> Option<Vec<Value>> {
    let state = match tokio::fs::read(root.join("bark-devices.json")).await {
        Ok(bytes) => serde_json::from_slice(&bytes).ok()?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            json!({"version":1,"devices":[],"legacy":{}})
        }
        Err(_) => return None,
    };
    public_devices(&state, legacy_url)
}

pub async fn bark_list(app: &App, ctx: &RequestCtx) -> Response<Body> {
    match devices(&app.data_root, &app.notifications.snapshot().bark).await {
        Some(rows) => express::json(
            ctx,
            200,
            &multicc_core::push_routes::bark_devices_body(&Value::Array(rows)),
            &[],
        ),
        None => express::json(ctx, 503, &json!({"error":"bark_storage_unavailable"}), &[]),
    }
}

pub async fn settings(app: &App, ctx: &RequestCtx) -> Response<Body> {
    let Destinations { bark, webhook } = app.notifications.snapshot();
    match devices(&app.data_root, &bark).await {
        Some(rows) => {
            let enabled = rows.iter().any(|v| v["enabled"] == true);
            host_read::notify(
                ctx,
                Some(
                    &json!({"barkUrl":bark,"hasBark":enabled,"barkDevices":rows,"webhookUrl":webhook}),
                ),
            )
        }
        None => host_read::internal_from_answer(
            ctx,
            &json!({"status":503, "code":"bark_storage_unavailable"}),
        ),
    }
}

fn valid_url(value: &str) -> bool {
    value.is_empty()
        || (utf16_len(value) <= 2048
            && !value.contains(['\r', '\n', '\0'])
            && Url::parse(value)
                .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.has_host()))
}

fn persist(file: &Path, entries: &[(&str, &str)]) -> io::Result<()> {
    // VAPID provisioning writes this file under the same cross-process lock.
    let _guard = provider_store::lock(file).map_err(io::Error::other)?;
    let current = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let mut lines = Vec::new();
    let mut written = HashSet::new();
    for line in current.lines().filter(|l| !js_trim(l).is_empty()) {
        if let Some((key, value)) = dotenv::parse_line(line)
            .and_then(|(name, _)| entries.iter().find(|(key, _)| *key == name))
        {
            lines.push(format!("{key}={value}"));
            written.insert(*key);
        } else {
            lines.push(line.to_owned());
        }
    }
    for (key, value) in entries {
        if !written.contains(key) {
            lines.push(format!("{key}={value}"));
        }
    }
    state_file::write_text_atomic(
        file,
        &(lines.join("\n") + "\n"),
        state_file::FILE_MODE,
        state_file::DIR_MODE,
    )
}

pub(super) async fn save(app: &Arc<App>, ctx: &RequestCtx, body: Value) -> Response<Body> {
    let app = Arc::clone(app);
    let result = tokio::task::spawn_blocking(move || -> io::Result<bool> {
        // The write and in-memory publication complete even if the client disconnects.
        let _write = app.notifications.writes.lock().unwrap();
        let mut next = app.notifications.snapshot();
        let mut entries = Vec::new();
        for (name, key, target) in [
            ("barkUrl", "BARK_URL", &mut next.bark),
            ("webhookUrl", "WEBHOOK_URL", &mut next.webhook),
        ] {
            let Some(value) = body[name].as_str() else {
                continue;
            };
            if notify_settings::is_current_placeholder(value, Some(target), !target.is_empty()) {
                continue;
            }
            if !valid_url(value) {
                return Ok(false);
            }
            entries.push((key, value));
            *target = value.to_owned();
        }
        if !entries.is_empty() {
            persist(&dotenv::config_path(&app.package_root), &entries)?;
            *app.notifications.current.write().unwrap() = next;
        }
        Ok(true)
    })
    .await;
    match result {
        Ok(Ok(true)) => express::json(ctx, 200, &json!({"ok":true}), &[]),
        Ok(Ok(false)) => express::json(
            ctx,
            400,
            &json!({"error":"notification URL must be http(s) and at most 2048 characters"}),
            &[],
        ),
        _ => express::error(ctx, 500, "notification settings persistence failed"),
    }
}
