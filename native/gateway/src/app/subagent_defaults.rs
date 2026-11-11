//! `GET/HEAD /api/subagent-defaults` and `POST /api/subagent-defaults/sync`,
//! retired from `src/routes/subagent-defaults.js`.
//!
//! Routing, request parsing, validation, planning, response assembly and error
//! mapping are all here; `multicc_core::subagent_defaults` owns the rules. The
//! only Node side left is the host port ([`crate::host_port`]): the in-process
//! session table projection, provider-store facts, the atomic write of
//! `provider-defaults.json` (plus the live object Node keeps), and per-session
//! `applySessionPatch` / `previewSessionPatch`. See
//! `src/routes/subagent-defaults-host.js` for that side.
//!
//! Node used to answer each request to completion on one thread; the handler
//! body had no await, so two concurrent syncs never interleaved. The process
//! mutex keeps that property across the host round trips.

use std::sync::Arc;

use axum::body::Body;
use axum::http::Response;
use multicc_core::js::serde::js_string_or_empty;
use multicc_core::js::string::js_trim;
use multicc_core::subagent_defaults;
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// Response is a UI payload, not an export: a 400-session fleet must not turn
/// one dialog into a multi-megabyte frame.
pub const MAX_RESULTS: usize = 200;

/// The host port the Node child serves (`src/routes/subagent-defaults-host.js`).
const HOST_PATH: &str = "/api/__host/subagent-defaults";

fn family_for_cli(cli: &str) -> Option<&'static str> {
    match cli {
        "claude" | "claude-exp" => Some("claude"),
        "codex" | "codex-exp" => Some("codex"),
        _ => None,
    }
}

/// `value && typeof value === 'object' && !Array.isArray(value)`.
fn route_or_null(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "子任务默认线路接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

/// `GET /api/subagent-defaults`: the stored defaults, normalized by Rust.
pub async fn get(app: &Arc<App>, ctx: &RequestCtx, host: u16) -> Response<Body> {
    let _serialized = app.subagent_defaults.lock().await;
    let state = match host_port::call(host, HOST_PATH, &json!({ "op": "state" })).await {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    let stored = state.get("subagent").cloned().unwrap_or(Value::Null);
    let normalized = match subagent_defaults::normalize(&json!({ "stored": stored }).to_string()) {
        Ok(text) => text,
        Err(_) => return unavailable(ctx),
    };
    let defaults: Value = match serde_json::from_str(&normalized) {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    express::json(
        ctx,
        200,
        &json!({
            "ok": true,
            "defaults": {
                "claude": default_state(&defaults["claude"]),
                "codex": default_state(&defaults["codex"]),
            },
        }),
        &[],
    )
}

/// A normalized default, or `null`.
fn default_state(value: &Value) -> Value {
    if value.is_null() {
        Value::Null
    } else {
        value.clone()
    }
}

fn object_or_empty(body: &Value) -> Option<&Map<String, Value>> {
    body.as_object()
}

/// `body.dryRun === true || body.dryRun === '1' || body.dryRun === 'true'`.
fn dry_run(body: Option<&Map<String, Value>>) -> bool {
    match body.and_then(|object| object.get("dryRun")) {
        Some(Value::Bool(true)) => true,
        Some(Value::String(text)) => text == "1" || text == "true",
        _ => false,
    }
}

/// `POST /api/subagent-defaults/sync`.
pub async fn sync(app: &Arc<App>, ctx: &RequestCtx, body: &Value, host: u16) -> Response<Body> {
    let _serialized = app.subagent_defaults.lock().await;
    let object = object_or_empty(body);
    let cli = match object.and_then(|object| object.get("cli")) {
        Some(Value::String(text)) => js_trim(text).to_owned(),
        _ => String::new(),
    };
    let dry = dry_run(object);
    let family = family_for_cli(&cli);
    let raw_target = object.and_then(|object| object.get("subagent"));
    let raw_provider = route_or_null(raw_target)
        .and_then(|target| target.get("providerId"))
        .map(|value| js_trim(&js_string_or_empty(Some(value))).to_owned())
        .unwrap_or_default();

    let state = match host_port::call(host, HOST_PATH, &json!({ "op": "state" })).await {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    let stored_defaults = state.get("subagent").cloned().unwrap_or(Value::Null);
    let sessions = state
        .get("sessions")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));

    // Host facts only: the provider store and the Codex HTTP-proxy capability
    // are answers only Node holds; Rust applies every rule to them.
    let mut provider_valid = false;
    let mut provider_proxyable = false;
    let mut provider_official = false;
    if let (Some(family), false) = (family, raw_provider.is_empty()) {
        let facts = match host_port::call(
            host,
            HOST_PATH,
            &json!({ "op": "facts", "family": family, "providerId": raw_provider }),
        )
        .await
        {
            Ok(value) => value,
            Err(_) => return unavailable(ctx),
        };
        provider_valid = facts.get("valid").and_then(Value::as_bool) == Some(true);
        provider_proxyable = facts.get("proxyable").and_then(Value::as_bool) == Some(true);
        provider_official = facts.get("official").and_then(Value::as_bool) == Some(true);
    }

    let plan_input = json!({
        "cli": cli,
        "subagent": raw_target.cloned().unwrap_or(Value::Null),
        "providerValid": provider_valid,
        "providerProxyable": provider_proxyable,
        "providerOfficial": provider_official,
        "defaults": stored_defaults,
        "sessions": sessions,
    });
    let plan: Value = match subagent_defaults::plan_sync(&plan_input.to_string()) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(_) => return unavailable(ctx),
        },
        Err(_) => return unavailable(ctx),
    };
    let status = plan.get("status").and_then(Value::as_u64).unwrap_or(400);
    if status != 200 {
        return express::json(
            ctx,
            u16::try_from(status).unwrap_or(400),
            &json!({
                "error": plan
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("invalid subagent sync request"),
                "code": plan
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("invalid_subagent"),
            }),
            &[],
        );
    }

    let target_route = plan
        .get("subagent")
        .filter(|value| value.is_object())
        .cloned();
    let plan_defaults = plan.get("defaults").cloned().unwrap_or(Value::Null);
    let planned_defaults = json!({
        "claude": default_state(&plan_defaults["claude"]),
        "codex": default_state(&plan_defaults["codex"]),
    });

    // Persist first: a failed write must leave the file and every session
    // exactly as they were, so the defaults land before the first PATCH.
    if !dry {
        let saved = host_port::call(
            host,
            HOST_PATH,
            &json!({ "op": "persist", "defaults": planned_defaults.clone() }),
        )
        .await;
        if !matches!(saved, Ok(ref value) if value.get("ok").and_then(Value::as_bool) == Some(true))
        {
            return express::json(
                ctx,
                500,
                &json!({ "error": "无法保存子任务默认线路", "code": "save_failed" }),
                &[],
            );
        }
    }

    let mut applied: Vec<Value> = Vec::new();
    let mut deferred: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut unchanged: Vec<Value> = Vec::new();
    let mut kept: Vec<Value> = Vec::new();

    // One session failing (rejected, or its patch throwing) must not hide what
    // already happened to the others: by now the defaults are saved and earlier
    // sessions are patched, so every failure is reported per session instead.
    for entry in plan
        .get("targets")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let session_id = entry.get("sessionId").and_then(Value::as_str).unwrap_or("");
        if session_id.is_empty() {
            continue;
        }
        let base = base_entry(entry, session_id);
        let outcome = host_port::call(
            host,
            HOST_PATH,
            &json!({
                "op": "patch",
                "sessionId": session_id,
                "subagent": target_route.clone().unwrap_or(Value::Null),
                "dryRun": dry,
            }),
        )
        .await;
        let pending = entry.get("pending").and_then(Value::as_bool) == Some(true);
        match outcome {
            // The host has no preview runtime: the one deferral a dry run can
            // know without it is an already staged configuration.
            Ok(value) if value.get("compat").and_then(Value::as_bool) == Some(true) => {
                if dry && pending {
                    deferred.push(session_entry(&base, "deferred", None, None));
                } else {
                    applied.push(session_entry(&base, "applied", None, None));
                }
            }
            Ok(value) if value.get("status").and_then(Value::as_u64) != Some(200) => {
                let detail = value
                    .get("detail")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .unwrap_or("session patch rejected");
                skipped.push(session_entry(
                    &base,
                    "skipped",
                    Some("patch_rejected"),
                    Some(detail),
                ));
            }
            Ok(value)
                if (dry && pending)
                    || (!dry && value.get("deferred").and_then(Value::as_bool) == Some(true)) =>
            {
                deferred.push(session_entry(&base, "deferred", None, None));
            }
            // A transport failure is an error from the patcher's point of view;
            // it reads exactly like a patch that threw.
            Err(_) => skipped.push(session_entry(
                &base,
                "skipped",
                Some("patch_rejected"),
                Some("session patch rejected"),
            )),
            Ok(_) => applied.push(session_entry(&base, "applied", None, None)),
        }
    }
    for entry in plan
        .get("skipped")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let session_id = entry.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let base = base_entry(entry, session_id);
        let reason = entry
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("patch_rejected");
        skipped.push(session_entry(&base, "skipped", Some(reason), None));
    }
    for (list, bucket, outcome) in [
        (plan.get("unchanged"), &mut unchanged, "unchanged"),
        (plan.get("kept"), &mut kept, "kept"),
    ] {
        for entry in list
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            let session_id = entry.get("sessionId").and_then(Value::as_str).unwrap_or("");
            bucket.push(session_entry(
                &base_entry(entry, session_id),
                outcome,
                None,
                None,
            ));
        }
    }

    let listed = applied
        .iter()
        .chain(deferred.iter())
        .chain(skipped.iter())
        .chain(unchanged.iter())
        .chain(kept.iter())
        .count();
    let mut sessions: Vec<Value> = Vec::with_capacity(listed.min(MAX_RESULTS));
    for entry in applied
        .iter()
        .chain(deferred.iter())
        .chain(skipped.iter())
        .chain(unchanged.iter())
        .chain(kept.iter())
    {
        if sessions.len() == MAX_RESULTS {
            break;
        }
        sessions.push(entry.clone());
    }

    express::json(
        ctx,
        200,
        &json!({
            "ok": true,
            "dryRun": dry,
            "family": plan.get("family").cloned().unwrap_or(Value::Null),
            "subagent": target_route.unwrap_or(Value::Null),
            "defaults": planned_defaults,
            "counts": {
                "applied": applied.len(),
                "deferred": deferred.len(),
                "unchanged": unchanged.len(),
                "skipped": skipped.len(),
                "kept": kept.len(),
            },
            "sessions": sessions,
            "truncated": listed > MAX_RESULTS,
        }),
        &[],
    )
}

/// `{ sessionId, sessionName, cli }` from a plan entry.
fn base_entry(entry: &Value, session_id: &str) -> Value {
    json!({
        "sessionId": session_id,
        "sessionName": entry.get("sessionName").cloned().unwrap_or(Value::Null),
        "cli": entry.get("cli").cloned().unwrap_or(Value::Null),
    })
}

/// `{ ...base, outcome, ...(reason ? {reason} : {}), ...(detail ? {detail} : {}) }`.
fn session_entry(base: &Value, outcome: &str, reason: Option<&str>, detail: Option<&str>) -> Value {
    let mut object = Map::new();
    for (key, value) in base.as_object().into_iter().flatten() {
        object.insert(key.clone(), value.clone());
    }
    object.insert("outcome".to_owned(), Value::String(outcome.to_owned()));
    if let Some(reason) = reason {
        object.insert("reason".to_owned(), Value::String(reason.to_owned()));
    }
    if let Some(detail) = detail {
        object.insert("detail".to_owned(), Value::String(detail.to_owned()));
    }
    Value::Object(object)
}
