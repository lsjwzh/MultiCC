//! Secrets vault routes retired from `src/secrets-vault.js` `mount()`:
//!
//! * `GET/HEAD /api/secrets`
//! * `POST /api/secrets`
//! * `POST /api/secrets/:name/rename`
//! * `DELETE /api/secrets/:name`
//! * `GET/HEAD /api/secrets/:name/value`
//!
//! Path matching (two decoded parameters), request validation, status codes,
//! response field order and error mapping live here. What stays in Node is the
//! store itself: the entries with their values, `createdAt`/`updatedAt`, the
//! 500-entry capacity, the `localeCompare` ordering and the audit rows. It is
//! reached through one host port, [`crate::host_port`], served by the Node shim
//! on `/api/__host/secrets-vault`; that side owns the projection to
//! `{name,description,source,createdAt,updatedAt,updatedBy?}` (values never
//! leave it except through `reveal`).
//!
//! Node answered each request to completion on one thread. Every route here
//! awaits the host once, so [`App::secrets_vault`] serializes requests: the
//! rename's old/new pair and the capacity check both read store state before
//! writing it, and a request must not see another's half-finished round trip.

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::js::string::{js_trim, utf16_len};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::{App, Route};
use crate::host_port;

/// The host port the Node child serves (the vault shim).
const HOST_PATH: &str = "/api/__host/secrets-vault";

/// `NAME_RULE` in src/secrets-vault.js: the one 400 message a bad new name
/// gets, on create and on rename.
const NAME_RULE: &str = "name must be a valid env var identifier ([A-Za-z_][A-Za-z0-9_]*, 1-64 chars) so it can be injected as $NAME";

/// `MAX_VALUE_LENGTH`: compared with JS `value.length`, i.e. UTF-16 code units.
pub const MAX_VALUE_LENGTH: usize = 64 * 1024;

/// The store's entry cap (`MAX_ENTRIES` in src/secrets-vault.js). The store
/// lives in Node, so it is the host that reports `reason:"full"`; the number is
/// documented here, not enforced.
pub const MAX_ENTRIES: usize = 500;

/// `MAX_DESCRIPTION`: the store trims and cuts a description to this many
/// UTF-16 units. The cut is a store rule, so the host applies it.
pub const MAX_DESCRIPTION: usize = 500;

/// Express matched route literals case-insensitively and parameters exactly as
/// written; the two shapes after `/api/secrets`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// `/api/secrets`
    Collection,
    /// `/api/secrets/:name`
    Item,
    /// `/api/secrets/:name/rename`
    Rename,
    /// `/api/secrets/:name/value`
    Value,
}

/// `decodeURIComponent`, falling back to the literal text on a malformed
/// escape (the same convention as the other native routes).
fn decode(raw: &str) -> String {
    super::download::decode_uri_component(raw).unwrap_or_else(|| raw.to_string())
}

/// The shape Express matched for `path`: exact lowercase `/api/` prefix, one
/// optional trailing slash (strict routing off), case-insensitive literals and
/// a parameter that keeps its raw case.
fn shape(path: &str) -> Option<Shape> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let mut segments = rest.split('/');
    if !segments.next()?.eq_ignore_ascii_case("secrets") {
        return None;
    }
    let Some(name) = segments.next() else {
        return Some(Shape::Collection);
    };
    if name.is_empty() {
        return None;
    }
    let Some(suffix) = segments.next() else {
        return Some(Shape::Item);
    };
    if segments.next().is_some() {
        return None;
    }
    if suffix.eq_ignore_ascii_case("rename") {
        Some(Shape::Rename)
    } else if suffix.eq_ignore_ascii_case("value") {
        Some(Shape::Value)
    } else {
        None
    }
}

/// The `:name` of a `/:name…` path, percent-decoded and trimmed. `None` when
/// the path does not carry one (the caller only reaches here with a claimed
/// shape).
pub fn path_name(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let raw = rest.split('/').nth(1)?;
    if raw.is_empty() {
        return None;
    }
    Some(js_trim(&decode(raw)).to_string())
}

/// `NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/` (ASCII, so bytes are units).
fn is_name(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let first = bytes[0];
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

/// `LEGACY_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/`: lookup names may still be the
/// pre-tightening entries, which is what keeps them readable and deletable.
fn is_legacy_name(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    match (shape(path)?, method.as_str()) {
        (Shape::Collection, "GET" | "HEAD") => Some(Route::SecretsList),
        (Shape::Collection, "POST") => Some(Route::SecretsCreate),
        // Express collects every method registered on the path: GET,HEAD from
        // the list route, then POST.
        (Shape::Collection, "OPTIONS") => Some(Route::SecretsOptionsCollection),
        (Shape::Item, "DELETE") => Some(Route::SecretsDelete),
        (Shape::Item, "OPTIONS") => Some(Route::SecretsOptionsItem),
        (Shape::Rename, "POST") => Some(Route::SecretsRename),
        (Shape::Rename, "OPTIONS") => Some(Route::SecretsOptionsRename),
        (Shape::Value, "GET" | "HEAD") => Some(Route::SecretsReveal),
        (Shape::Value, "OPTIONS") => Some(Route::SecretsOptionsValue),
        _ => None,
    }
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "secrets vault interface is not ready",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

fn not_found(ctx: &RequestCtx) -> Response<Body> {
    express::json(ctx, 404, &json!({ "error": "entry not found" }), &[])
}

/// `typeof value !== 'string' || !value || value.length > MAX_VALUE_LENGTH`.
fn value_error(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        400,
        &json!({
            "error": format!(
                "value is required and cannot exceed {MAX_VALUE_LENGTH} characters"
            ),
        }),
        &[],
    )
}

async fn host(host_port_num: u16, payload: Value) -> Option<Value> {
    host_port::call(host_port_num, HOST_PATH, &payload)
        .await
        .ok()
}

fn host_ok(answer: &Value) -> bool {
    answer.get("ok") == Some(&Value::Bool(true))
}

/// The trimmed, legacy-valid `:name` of a claimed `/:name…` path.
fn lookup_name(ctx: &RequestCtx) -> Option<String> {
    let name = path_name(&ctx.path)?;
    is_legacy_name(&name).then_some(name)
}

/// `GET|HEAD /api/secrets`: the metadata-only projection, already sorted by
/// the store, re-emitted as received.
pub async fn list(app: &App, ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let _serialized = app.secrets_vault.lock().await;
    let Some(answer) = host(host_port_num, json!({ "op": "list" })).await else {
        return unavailable(ctx);
    };
    if !host_ok(&answer) {
        return unavailable(ctx);
    }
    let entries = match answer.get("entries") {
        Some(value @ Value::Array(_)) => value.clone(),
        _ => Value::Array(Vec::new()),
    };
    express::json(ctx, 200, &entries, &[])
}

/// `POST /api/secrets`: 201 when the name is new, 200 when it updated an
/// existing entry. Everything the retired handler validated is validated here
/// before the host is called.
pub async fn create(
    app: &App,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    let _serialized = app.secrets_vault.lock().await;
    // `req.body || {}`: a JSON array or scalar body has no fields either.
    let object = body.as_object();
    let name = match object.and_then(|object| object.get("name")) {
        Some(Value::String(text)) => js_trim(text).to_string(),
        _ => String::new(),
    };
    if !is_name(&name) {
        return express::json(ctx, 400, &json!({ "error": NAME_RULE }), &[]);
    }
    let value = match object.and_then(|object| object.get("value")) {
        Some(Value::String(text)) => text,
        _ => return value_error(ctx),
    };
    if value.is_empty() || utf16_len(value) > MAX_VALUE_LENGTH {
        return value_error(ctx);
    }
    let mut payload = Map::new();
    payload.insert("op".to_string(), Value::String("upsert".to_string()));
    payload.insert("name".to_string(), Value::String(name));
    payload.insert("value".to_string(), Value::String(value.clone()));
    // `body.source === 'agent' ? 'agent' : 'user'`: strict string equality.
    let source = match object.and_then(|object| object.get("source")) {
        Some(Value::String(text)) if text == "agent" => "agent",
        _ => "user",
    };
    payload.insert("source".to_string(), Value::String(source.to_string()));
    // Passed through only when the body field was a string / present; the host
    // applies trim, the description cut, and keep-existing for a missing one.
    if let Some(description) = object
        .and_then(|object| object.get("description"))
        .filter(|value| value.is_string())
    {
        payload.insert("description".to_string(), description.clone());
    }
    if let Some(session) = object.and_then(|object| object.get("sessionId")) {
        payload.insert("sessionId".to_string(), session.clone());
    }
    let Some(answer) = host(host_port_num, Value::Object(payload)).await else {
        return unavailable(ctx);
    };
    if !host_ok(&answer) {
        return match answer.get("reason").and_then(Value::as_str) {
            Some("full") => express::json(ctx, 409, &json!({ "error": "vault is full" }), &[]),
            _ => unavailable(ctx),
        };
    }
    let created = answer.get("created").and_then(Value::as_bool) == Some(true);
    let entry = answer.get("entry").cloned().unwrap_or(Value::Null);
    let status = if created { 201 } else { 200 };
    express::json(ctx, status, &json!({ "ok": true, "entry": entry }), &[])
}

/// `POST /api/secrets/:name/rename`: the old name only has to exist (legacy
/// names included), the new one has to be a legal env var identifier.
pub async fn rename(
    app: &App,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    let _serialized = app.secrets_vault.lock().await;
    let Some(name) = lookup_name(ctx) else {
        return not_found(ctx);
    };
    let to = match body.as_object().and_then(|object| object.get("to")) {
        Some(Value::String(text)) => js_trim(text).to_string(),
        _ => String::new(),
    };
    if !is_name(&to) {
        return express::json(ctx, 400, &json!({ "error": NAME_RULE }), &[]);
    }
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "rename", "name": name, "to": to }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if host_ok(&answer) {
        let entry = answer.get("entry").cloned().unwrap_or(Value::Null);
        return express::json(ctx, 200, &json!({ "ok": true, "entry": entry }), &[]);
    }
    match answer.get("reason").and_then(Value::as_str) {
        Some("missing") => not_found(ctx),
        Some("exists") => express::json(
            ctx,
            409,
            &json!({ "error": "target name already exists" }),
            &[],
        ),
        _ => unavailable(ctx),
    }
}

/// `DELETE /api/secrets/:name`.
pub async fn remove(app: &App, ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let _serialized = app.secrets_vault.lock().await;
    let Some(name) = lookup_name(ctx) else {
        return not_found(ctx);
    };
    let Some(answer) = host(host_port_num, json!({ "op": "remove", "name": name })).await else {
        return unavailable(ctx);
    };
    if host_ok(&answer) {
        return express::json(ctx, 200, &json!({ "ok": true }), &[]);
    }
    if answer.get("reason").and_then(Value::as_str) == Some("missing") {
        return not_found(ctx);
    }
    unavailable(ctx)
}

/// `GET|HEAD /api/secrets/:name/value`: the panel's reveal action. The value
/// is re-emitted from the host answer and never logged or put in an error.
pub async fn reveal(app: &App, ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let _serialized = app.secrets_vault.lock().await;
    let Some(name) = lookup_name(ctx) else {
        return not_found(ctx);
    };
    let Some(answer) = host(host_port_num, json!({ "op": "reveal", "name": name })).await else {
        return unavailable(ctx);
    };
    if !host_ok(&answer) {
        if answer.get("reason").and_then(Value::as_str) == Some("missing") {
            return not_found(ctx);
        }
        return unavailable(ctx);
    }
    let name = answer.get("name").cloned().unwrap_or(Value::Null);
    let value = answer.get("value").cloned().unwrap_or(Value::Null);
    express::json(
        ctx,
        200,
        &json!({ "ok": true, "name": name, "value": value }),
        &[],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_two_node_patterns() {
        assert!(is_name("A"));
        assert!(is_name("_x9"));
        assert!(!is_name(""));
        assert!(!is_name("9x"));
        assert!(!is_name("has-dash"));
        assert!(!is_name(&"a".repeat(65)));
        assert!(is_name(&"a".repeat(64)));
        assert!(!is_name("naïve"));

        assert!(is_legacy_name("a.b-c_d"));
        assert!(is_legacy_name(".hidden"));
        assert!(!is_legacy_name("has space"));
        assert!(!is_legacy_name(&"a".repeat(65)));
    }

    #[test]
    fn path_names_decode_and_trim() {
        assert_eq!(
            path_name("/api/secrets/%20API_KEY%20"),
            Some("API_KEY".to_string())
        );
        assert_eq!(
            path_name("/api/Secrets/MiXeD/value"),
            Some("MiXeD".to_string())
        );
        assert_eq!(path_name("/api/secrets"), None);
        assert_eq!(path_name("/api/secrets/"), None);
    }
}
