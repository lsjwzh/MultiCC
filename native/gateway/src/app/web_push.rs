//! Persistent state used by the web push routes in a standalone gateway.
use std::{collections::HashMap, fs, io, path::Path};

use axum::{body::Body, http::Response};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use multicc_core::{dotenv, provider_store, push_routes as dto, state_file};
use p256::{elliptic_curve::sec1::ToEncodedPoint, SecretKey};
use rand_core::OsRng;
use serde_json::{json, Value};

use super::{express, host_read, notification_reads, push_routes::Route};
use express::RequestCtx;

const PUBLIC: &str = "VAPID_PUBLIC_KEY";
const PRIVATE: &str = "VAPID_PRIVATE_KEY";

fn configured(public: &str, private: &str) -> io::Result<String> {
    let invalid = || io::Error::other("invalid VAPID configuration");
    let bytes = URL_SAFE_NO_PAD.decode(private).map_err(|_| invalid())?;
    let key = SecretKey::from_slice(&bytes).map_err(|_| invalid())?;
    if bytes.len() != 32
        || URL_SAFE_NO_PAD.encode(key.public_key().to_encoded_point(false).as_bytes()) != public
    {
        return Err(invalid());
    }
    Ok(public.to_owned())
}

// The environment wins over the writable configuration. Serialize first use and
// replace both assignments in one atomic write so a restart reuses the same key.
fn public_key() -> io::Result<String> {
    let public = std::env::var(PUBLIC).unwrap_or_default();
    let private = std::env::var(PRIVATE).unwrap_or_default();
    if !public.is_empty() && !private.is_empty() {
        return configured(&public, &private);
    }
    let file = dotenv::config_path(&std::env::current_dir()?);
    let read = || match fs::read_to_string(&file) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        other => other,
    };
    let existing = |text: &str| -> Option<io::Result<String>> {
        let value = |name: &str| {
            text.lines()
                .filter_map(dotenv::parse_line)
                .find(|(key, v)| *key == name && !v.is_empty())
                .map(|(_, v)| v)
        };
        Some(configured(value(PUBLIC)?, value(PRIVATE)?))
    };
    if let Some(key) = existing(&read()?) {
        return key;
    }
    let _guard = provider_store::lock(&file).map_err(io::Error::other)?;
    let text = read()?;
    if let Some(key) = existing(&text) {
        return key;
    }
    let key = SecretKey::random(&mut OsRng);
    let public = URL_SAFE_NO_PAD.encode(key.public_key().to_encoded_point(false).as_bytes());
    let private = URL_SAFE_NO_PAD.encode(key.to_bytes());
    let mut out = String::new();
    for line in text.lines() {
        if !matches!(dotenv::parse_line(line), Some((PUBLIC | PRIVATE, _))) {
            out.push_str(line);
            out.push('\n');
        }
    }
    out.push_str(&format!("{PUBLIC}={public}\n{PRIVATE}={private}\n"));
    state_file::write_text_atomic(&file, &out, state_file::FILE_MODE, state_file::DIR_MODE)?;
    Ok(public)
}

pub async fn vapid(ctx: &RequestCtx, key: &tokio::sync::OnceCell<String>) -> Response<Body> {
    let value = key
        .get_or_try_init(|| async {
            tokio::task::spawn_blocking(public_key)
                .await
                .map_err(io::Error::other)?
        })
        .await;
    match value {
        Ok(value) => express::json(ctx, 200, &json!({"publicKey": value}), &[]),
        Err(_) => host_read::internal_from_answer(
            ctx,
            &json!({"detail":"VAPID configuration unavailable"}),
        ),
    }
}

// Map compares primitive JS keys by value and object keys by identity. Object
// endpoints accepted by the old API can never match a separately decoded request.
fn endpoint_key(row: &Value) -> Option<String> {
    match row.get("endpoint") {
        None => Some("undefined".into()),
        Some(Value::Object(_) | Value::Array(_)) => None,
        Some(Value::Number(n)) => Some(multicc_core::js::serde::number_to_js_string(n)),
        Some(v) => Some(v.to_string()),
    }
}

fn subscriptions(file: &Path) -> io::Result<Vec<Value>> {
    let data = match fs::read(file) {
        Ok(data) => data,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let rows: Vec<Value> = serde_json::from_slice(&data)?;
    let mut unique = Vec::new();
    let mut positions = HashMap::new();
    for row in rows {
        if let Some(key) = endpoint_key(&row) {
            let pos = *positions.entry(key).or_insert(unique.len());
            if pos < unique.len() {
                unique[pos] = row;
                continue;
            }
        }
        unique.push(row);
    }
    Ok(unique)
}

fn update(file: &Path, route: Route, body: Value) -> io::Result<Value> {
    let _lock = if route == Route::ValidatePost {
        None
    } else {
        Some(provider_store::lock(file).map_err(io::Error::other)?)
    };
    let mut rows = subscriptions(file)?;
    let index = endpoint_key(&body).and_then(|key| {
        rows.iter()
            .position(|row| endpoint_key(row).as_ref() == Some(&key))
    });
    match route {
        Route::ValidatePost => return Ok(dto::known_body(index.is_some())),
        Route::SubscribePost => match index {
            Some(i) => rows[i] = body,
            None => rows.push(body),
        },
        Route::SubscribeDelete => match index {
            Some(i) if !dto::missing_endpoint(&body) => {
                rows.remove(i);
            }
            _ => return Ok(dto::ok_body()),
        },
        _ => unreachable!("only subscription routes are dispatched here"),
    }
    state_file::write_json_atomic(file, &Value::Array(rows))?;
    Ok(dto::ok_body())
}

pub async fn subscription(
    root: &Path,
    ctx: &RequestCtx,
    route: Route,
    body: &Value,
) -> Response<Body> {
    if route == Route::SubscribePost && dto::invalid_subscription(body) {
        return express::json(ctx, 400, &dto::invalid_subscription_body(), &[]);
    }
    if route == Route::ValidatePost && dto::missing_endpoint(body) {
        return express::json(ctx, 400, &dto::missing_endpoint_body(), &[]);
    }
    let file = root.join("push_subscriptions.json");
    let body = body.clone();
    match tokio::task::spawn_blocking(move || update(&file, route, body)).await {
        Ok(Ok(reply)) => express::json(ctx, 200, &reply, &[]),
        _ => express::json(ctx, 500, &json!({"error":"push request failed"}), &[]),
    }
}

pub async fn health(app: &super::App, ctx: &RequestCtx) -> Response<Body> {
    let root = &app.data_root;
    let file = root.join("push_subscriptions.json");
    let rows = tokio::task::spawn_blocking(move || subscriptions(&file)).await;
    let cfg = app.notifications.snapshot();
    let devices = notification_reads::devices(root, &cfg.bark).await;
    let (Ok(Ok(rows)), Some(devices)) = (rows, devices) else {
        return host_read::internal_from_answer(ctx, &json!({"detail":"push storage unavailable"}));
    };
    let endpoints: Vec<_> = rows.iter().map(|row| &row["endpoint"]).collect();
    // Delivery statistics in the legacy runtime are process-local. Standalone
    // currently has no sender, so no sends have been recorded in this process.
    host_read::push_health(
        ctx,
        Some(&json!({
            "endpoints": endpoints, "barkConfigured": devices.iter().any(|row| row["enabled"] == true),
            "webhookConfigured": !cfg.webhook.is_empty(),
            "barkHealth":{"lastSuccess":true}, "webhookHealth":{"lastSuccess":true}
        })),
    )
}
