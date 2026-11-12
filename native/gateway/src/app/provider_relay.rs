//! Read-only relay model surfaces. Provider/account snapshots and the live
//! scoped-authority owner are reached through a private host port; route
//! matching, public catalog normalization, revision and response policy live
//! here. Streaming inference proxy routes remain with their current owner.

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::js::serde::{js_string, truthy};
use multicc_core::js::string::js_trim;
use multicc_core::provider_registry::relay_models_of;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::app::express::{self, RequestCtx};
use crate::host_port;

const HOST_PATH: &str = "/api/__host/provider-relay";
const NO_STORE: &[(&str, &str)] = &[("Cache-Control", "no-store")];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    Models,
    Options,
}

fn path_parts(path: &str) -> Option<(&'static str, &str)> {
    let path = path.strip_suffix('/').unwrap_or(path);
    let parts: Vec<&str> = path.split('/').collect();
    match parts.as_slice() {
        ["", prefix, id, remote, models]
            if prefix.eq_ignore_ascii_case("claude-proxy")
                && !id.is_empty()
                && remote.eq_ignore_ascii_case("remote")
                && models.eq_ignore_ascii_case("models") =>
        {
            Some(("claude", id))
        }
        ["", prefix, id, models]
            if prefix.eq_ignore_ascii_case("codex-proxy")
                && !id.is_empty()
                && models.eq_ignore_ascii_case("models") =>
        {
            Some(("codex", id))
        }
        _ => None,
    }
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    path_parts(path)?;
    match method.as_str() {
        "GET" | "HEAD" => Some(Route::Models),
        "OPTIONS" => Some(Route::Options),
        _ => None,
    }
}

/// Invoke the existing Rust HTTP admission owner with the original peer and
/// headers, never the loopback host-port identity. The bridge preserves relay
/// revocation/accounting, machine/fleet grants, bootstrap cookies and metrics.
/// Both model and quota relay routes must call this before their handlers.
pub async fn admission(
    ctx: &RequestCtx,
    peer: &str,
    host: u16,
) -> Result<Vec<(String, String)>, Box<Response<Body>>> {
    let headers: Map<String, Value> = ctx
        .headers
        .names()
        .map(|name| {
            (
                name.to_string(),
                Value::String(ctx.headers.get(name).unwrap_or_default().to_string()),
            )
        })
        .collect();
    let answer = host_port::call(
        host,
        HOST_PATH,
        &json!({
            "op": "admission",
            "request": {
                "method": ctx.method.as_str(), "path": ctx.path,
                "originalUrl": ctx.original_url, "peer": peer,
                "headers": headers, "id": ctx.ids.0, "correlationId": ctx.ids.1,
            },
        }),
    )
    .await
    .map_err(|_| {
        Box::new(express::error(
            ctx,
            503,
            "authentication runtime unavailable",
        ))
    })?;
    let headers: Vec<(String, String)> = answer
        .get("headers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_string())))
        .collect();
    if answer.get("allowed") == Some(&Value::Bool(true)) {
        return Ok(headers);
    }
    let refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    if let Some(location) = answer.get("location").and_then(Value::as_str) {
        let mut response = express::redirect(ctx, location);
        append_headers(&mut response, &headers);
        return Err(Box::new(response));
    }
    let Some(status) = answer
        .get("status")
        .and_then(Value::as_u64)
        .filter(|status| (400..=599).contains(status))
    else {
        return Err(Box::new(express::error(
            ctx,
            503,
            "authentication runtime unavailable",
        )));
    };
    Err(Box::new(express::json(
        ctx,
        status as u16,
        answer.get("body").unwrap_or(&Value::Null),
        &refs,
    )))
}

pub fn append_headers(response: &mut Response<Body>, headers: &[(String, String)]) {
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            axum::http::HeaderName::try_from(name.as_str()),
            axum::http::HeaderValue::try_from(value.as_str()),
        ) {
            response.headers_mut().append(name, value);
        }
    }
}

fn text(value: Option<&Value>) -> String {
    value
        .filter(|value| truthy(value))
        .map(js_string)
        .unwrap_or_default()
}

fn normalize_models(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut models = Vec::new();
    for raw in values {
        let model = js_trim(&raw);
        let valid = model
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
            && model.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-' | b'[' | b']')
            });
        if model.len() <= 160 && valid && !models.iter().any(|seen| seen == model) {
            models.push(model.to_string());
            if models.len() == 100 {
                break;
            }
        }
    }
    models
}

pub async fn handle(route: Route, ctx: &RequestCtx, host: u16) -> Response<Body> {
    if route == Route::Options {
        return super::options(ctx, "GET,HEAD");
    }
    let Some((app_type, raw_id)) = path_parts(&ctx.path) else {
        return express::error(ctx, 404, "not found");
    };
    let Some(id) = super::download::decode_uri_component(raw_id) else {
        return express::error(ctx, 400, "Failed to decode param");
    };
    let answer = host_port::call(
        host,
        HOST_PATH,
        &json!({ "op": "catalogFacts", "appType": app_type, "id": id }),
    )
    .await;
    let Ok(facts) = answer else {
        return express::json(
            ctx,
            500,
            &json!({"ok": false, "reason": "catalog_unavailable"}),
            NO_STORE,
        );
    };
    let (status, body) = source_catalog(&facts, app_type, &id, super::now_ms());
    express::json(ctx, status, &body, NO_STORE)
}

fn source_catalog(facts: &Value, app_type: &str, id: &str, now: i64) -> (u16, Value) {
    let Some(summary) = facts.get("summary").filter(|value| truthy(value)) else {
        return (
            404,
            json!({"ok": false, "reason": "not_found", "appType": app_type, "providerId": id}),
        );
    };
    let catalog = facts.get("catalog");
    let discovered = catalog
        .and_then(|catalog| catalog.get("models"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| text(item.get("model")));
    let models = normalize_models(relay_models_of(Some(summary)).into_iter().chain(discovered));
    if models.is_empty() {
        return (
            200,
            json!({"ok": false, "reason": "catalog_empty", "appType": app_type, "providerId": id}),
        );
    }
    let preferred = text(summary.get("model"));
    let preferred = js_trim(&preferred);
    let preferred = if models.iter().any(|model| model == preferred) {
        preferred
    } else {
        &models[0]
    };
    let revision_input =
        serde_json::to_vec(&json!({"preferredModel": preferred, "models": models}))
            .expect("model catalog serializes");
    let revision = format!("{:x}", Sha256::digest(revision_input));
    let fetched_at = catalog
        .and_then(|catalog| catalog.get("fetchedAt"))
        .filter(|value| truthy(value))
        .or_else(|| catalog.and_then(|catalog| catalog.get("catalogFetchedAt")))
        .filter(|value| truthy(value))
        .cloned()
        .unwrap_or(Value::Null);
    (
        200,
        json!({
            "ok": true, "version": 1, "appType": app_type, "providerId": id,
            "preferredModel": preferred, "models": models, "revision": &revision[..24],
            "generatedAt": now, "catalogFetchedAt": fetched_at,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_model_paths_keep_express_matching_and_method_boundaries() {
        for path in [
            "/claude-proxy/A%2Fb/remote/models",
            "/codex-proxy/AbC/models",
            "/CODEX-proxy/AbC/Models/",
        ] {
            assert_eq!(claim(&Method::GET, path), Some(Route::Models));
            assert_eq!(claim(&Method::HEAD, path), Some(Route::Models));
            assert_eq!(claim(&Method::OPTIONS, path), Some(Route::Options));
            assert_eq!(claim(&Method::POST, path), None);
        }
        for path in [
            "/codex-proxy//models",
            "/codex-proxy/a/models//",
            "/codex-proxy/a/models/x",
            "/claude-proxy/a/models",
        ] {
            assert_eq!(claim(&Method::GET, path), None);
        }
    }

    #[test]
    fn claude_official_source_uses_the_current_fallback_catalog() {
        let (status, catalog) = source_catalog(
            &json!({"summary": {
                "appType": "claude", "isOfficial": true, "model": "", "modelOptions": []
            }}),
            "claude",
            "official",
            5000,
        );
        assert_eq!(status, 200);
        assert_eq!(catalog["ok"], true);
        let models = catalog["models"].as_array().unwrap();
        assert!(models.contains(&json!("claude-haiku-4-5")));
        assert!(models.contains(&json!("claude-sonnet-5")));
        assert_eq!(catalog["preferredModel"], models[0]);
        assert_eq!(catalog["generatedAt"], 5000);
    }

    #[test]
    fn codex_catalog_combines_account_snapshot_and_preserves_revision_contract() {
        let (status, catalog) = source_catalog(
            &json!({
                "summary": {"model": "gpt-6.1-sol", "modelOptions": ["gpt-6-astra", "bad model"]},
                "catalog": {"models": [{"model": "gpt-6-astra"}, {"model": "vendor/model:v2"}], "catalogFetchedAt": 4900}
            }),
            "codex",
            "official",
            5000,
        );
        assert_eq!(status, 200);
        assert_eq!(
            catalog["models"],
            json!(["gpt-6.1-sol", "gpt-6-astra", "vendor/model:v2"])
        );
        assert_eq!(catalog["preferredModel"], "gpt-6.1-sol");
        assert_eq!(catalog["catalogFetchedAt"], 4900);
        let digest = format!("{:x}", Sha256::digest(br#"{"preferredModel":"gpt-6.1-sol","models":["gpt-6.1-sol","gpt-6-astra","vendor/model:v2"]}"#));
        assert_eq!(catalog["revision"], &digest[..24]);
    }

    #[test]
    fn missing_and_empty_catalogs_keep_distinct_statuses() {
        let (status, body) = source_catalog(&json!({"summary": null}), "codex", "missing", 0);
        assert_eq!(status, 404);
        assert_eq!(body["reason"], "not_found");
        let (status, body) = source_catalog(
            &json!({"summary": {"model": "bad model"}}),
            "codex",
            "empty",
            0,
        );
        assert_eq!(status, 200);
        assert_eq!(body["reason"], "catalog_empty");
        assert_eq!(
            normalize_models((0..120).map(|i| format!("model-{i}"))).len(),
            100
        );
    }
}
