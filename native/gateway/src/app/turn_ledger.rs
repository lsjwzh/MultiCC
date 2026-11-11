//! Terminal turn-ledger diagnostics retired from `src/turn-ledger/runtime.js`:
//!
//! * `GET/HEAD /api/sessions/:id/turn-ledger`
//! * `GET/HEAD /api/sessions/:id/turn-hooks/codex-trust`
//! * `POST     /api/sessions/:id/turn-hooks/codex-trust`
//!
//! Path matching (including the decoded `:id`), the `Allow` lists, the 409 for a
//! session that is not a launched Codex terminal, the snapshot DTO (field
//! order, the `liveness` projection and the `reason` fallback) and the error
//! mapping are decided here. What stays in Node is exactly what the front door
//! cannot see: the in-process `launches` table, the TurnLedger's per-session
//! record, and the `codex app-server` JSON-RPC calls behind the trust pair.
//! They are reached through one host port, [`crate::host_port`], served by
//! `src/routes/turn-ledger-host.js`.
//!
//! The trust routes ask the host for the launch first, decide the 409 here, and
//! then pass the validated `codexHome`/`cwd` back with the trust call, so the
//! validation that used to be inline in `launchFor` has one owner.

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate;
use multicc_core::js::serde::truthy;
use serde_json::{json, Value};

use crate::app::express::{self, RequestCtx};
use crate::host_port;

/// The host port the Node child serves (`src/routes/turn-ledger-host.js`).
const HOST_PATH: &str = "/api/__host/turn-ledger";

/// The retired `launchFor` 409 body.
const NOT_LAUNCHED: &str = "not a launched codex terminal";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    Ledger,
    TrustGet,
    TrustPost,
}

impl Route {
    /// Express's `Allow` for the path this route is registered on.
    pub fn allow(self) -> &'static str {
        match self {
            Route::Ledger => "GET,HEAD",
            Route::TrustGet | Route::TrustPost => "GET,HEAD,POST",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Claim {
    Handle(Route),
    Options(Route),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Ledger,
    Trust,
}

/// `decodeURIComponent`, falling back to the literal text on a malformed
/// escape (the same convention as `agent_resources`).
fn decode(raw: &str) -> String {
    super::download::decode_uri_component(raw).unwrap_or_else(|| raw.to_string())
}

/// `sessions/<id>/<tail>`, where `<id>` is exactly one non-empty segment and
/// `<tail>` is one of the two literals. `rest` is the path after `/api/` with
/// one optional trailing slash removed.
fn parse(rest: &str) -> Option<(String, Kind)> {
    const HEAD: &str = "sessions/";
    if rest.len() <= HEAD.len()
        || !rest.as_bytes()[..HEAD.len()].eq_ignore_ascii_case(HEAD.as_bytes())
    {
        return None;
    }
    let (raw_id, tail) = rest[HEAD.len()..].split_once('/')?;
    if raw_id.is_empty() {
        return None;
    }
    let kind = if tail.eq_ignore_ascii_case("turn-ledger") {
        Kind::Ledger
    } else if tail.eq_ignore_ascii_case("turn-hooks/codex-trust") {
        Kind::Trust
    } else {
        return None;
    };
    Some((decode(raw_id), kind))
}

/// The decoded `:id` of the two turn-ledger routes for a raw request path.
pub fn session_id_from_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    parse(rest).map(|(id, _)| id)
}

pub fn claim(method: &Method, path: &str) -> Option<Claim> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let (_, kind) = parse(rest)?;
    let route = match (kind, method.as_str()) {
        (Kind::Ledger, "GET" | "HEAD") => Route::Ledger,
        (Kind::Trust, "GET" | "HEAD") => Route::TrustGet,
        (Kind::Trust, "POST") => Route::TrustPost,
        (Kind::Ledger, "OPTIONS") => return Some(Claim::Options(Route::Ledger)),
        (Kind::Trust, "OPTIONS") => return Some(Claim::Options(Route::TrustGet)),
        _ => return None,
    };
    Some(Claim::Handle(route))
}

/// `^[A-Za-z0-9_.-]{1,128}$` from the retired `SID_RE`.
fn is_session_id(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= 128
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// `projectLiveness` from `src/turn-ledger/contract.js`.
fn liveness(ownership: &Value) -> Value {
    match ownership.as_str() {
        Some("running") => json!({ "state": "active", "reason": "turn_ledger_running" }),
        Some("yielding") => json!({ "state": "inactive", "reason": "turn_ledger_yielding" }),
        Some("ended") => json!({ "state": "inactive", "reason": "turn_ledger_ended" }),
        _ => json!({ "state": "unknown", "reason": "turn_ledger_no_evidence" }),
    }
}

/// `isAbnormalLetter(state) ? (boundary || 'unknown-interruption') : null`.
fn reason(state: &Value, boundary: &Value) -> Value {
    if state.as_str() != Some("E") {
        return Value::Null;
    }
    if truthy(boundary) {
        boundary.clone()
    } else {
        Value::String("unknown-interruption".to_string())
    }
}

/// `TurnLedger#snapshot`, in `JSON.stringify` key order, rebuilt from the raw
/// record the host port answers with.
fn snapshot(record: Option<&Value>) -> Value {
    let Some(record) = record.filter(|value| value.is_object()) else {
        return Value::Null;
    };
    let field = |name: &str| record.get(name).cloned().unwrap_or(Value::Null);
    let ownership = field("ownership");
    let state = field("state");
    let boundary = field("boundary");
    let last_event_at = field("lastEventAt");
    json!({
        "sessionId": field("sessionId"),
        "epoch": field("epoch"),
        "cli": field("cli"),
        "cliSessionId": field("cliSessionId"),
        "cliPid": field("cliPid"),
        "ownership": ownership.clone(),
        "liveness": liveness(&ownership),
        "turnId": field("turnId"),
        "state": state.clone(),
        "evidence": field("evidence"),
        "reason": reason(&state, &boundary),
        "boundary": boundary,
        "pendingUserInput": field("pendingUserInput"),
        "backgroundPending": field("backgroundPending"),
        "stopPending": field("stopPending"),
        "promptHead": field("promptHead"),
        "needsReview": field("needsReview"),
        // `rec.lastEventAt || null`
        "lastEventAt": if truthy(&last_event_at) { last_event_at } else { Value::Null },
        "lastTransitionId": field("lastTransitionId"),
    })
}

/// `safeErrorHandler` for a failure that has no client-safe message.
fn internal(ctx: &RequestCtx, detail: &str) -> Response<Body> {
    let body = http_gate::error_dto("internal_error", "internal_error", &[], &ctx.ids);
    express::log_http_error(ctx, 500, detail);
    express::json(ctx, 500, &body, &[])
}

/// `launchFor`'s refusal: `res.status(409).json({ error: NOT_LAUNCHED })`.
fn not_launched(ctx: &RequestCtx) -> Response<Body> {
    express::json(ctx, 409, &json!({ "error": NOT_LAUNCHED }), &[])
}

async fn host(host_port_num: u16, payload: Value) -> Option<Value> {
    host_port::call(host_port_num, HOST_PATH, &payload)
        .await
        .ok()
}

fn host_ok(answer: &Value) -> bool {
    answer.get("ok") == Some(&Value::Bool(true))
}

/// `GET|HEAD /api/sessions/:id/turn-ledger`.
async fn ledger(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(session_id) = session_id_from_path(&ctx.path) else {
        return internal(ctx, "turn ledger: no session id");
    };
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "ledger", "sessionId": session_id }),
    )
    .await
    else {
        return internal(ctx, "turn ledger: host port unavailable");
    };
    if !host_ok(&answer) {
        return internal(ctx, "turn ledger: host port refused");
    }
    let body = json!({
        "shadow": true,
        "launch": answer.get("launch").cloned().unwrap_or(Value::Null),
        "snapshot": snapshot(answer.get("record")),
    });
    express::json(ctx, 200, &body, &[])
}

/// `GET|HEAD|POST /api/sessions/:id/turn-hooks/codex-trust`.
async fn trust(ctx: &RequestCtx, host_port_num: u16, write: bool) -> Response<Body> {
    let Some(session_id) = session_id_from_path(&ctx.path) else {
        return not_launched(ctx);
    };
    let launch = if is_session_id(&session_id) {
        let Some(answer) = host(
            host_port_num,
            json!({ "op": "launch", "sessionId": session_id }),
        )
        .await
        else {
            return internal(ctx, "turn hooks: host port unavailable");
        };
        if !host_ok(&answer) {
            return internal(ctx, "turn hooks: host port refused");
        }
        answer.get("launch").cloned().unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    if launch.get("cli").and_then(Value::as_str) != Some("codex") {
        return not_launched(ctx);
    }
    let answer = match host(
        host_port_num,
        json!({
            "op": "trust",
            "write": write,
            "codexHome": launch.get("codexHome").cloned().unwrap_or(Value::Null),
            "cwd": launch.get("cwd").cloned().unwrap_or(Value::Null),
        }),
    )
    .await
    {
        Some(answer) => answer,
        None => return internal(ctx, "turn hooks: host port unavailable"),
    };
    if host_ok(&answer) {
        return express::json(
            ctx,
            200,
            &answer.get("value").cloned().unwrap_or(Value::Null),
            &[],
        );
    }
    // The retired handler caught the installer's error and answered 502 with
    // its message.
    let message = answer
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("codex app-server failed");
    express::json(ctx, 502, &json!({ "error": message }), &[])
}

/// Answers one claimed turn-ledger route.
pub async fn handle(ctx: &RequestCtx, route: Route, host_port_num: u16) -> Response<Body> {
    match route {
        Route::Ledger => ledger(ctx, host_port_num).await,
        Route::TrustGet => trust(ctx, host_port_num, false).await,
        Route::TrustPost => trust(ctx, host_port_num, true).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_follow_express_matching() {
        assert_eq!(
            claim(&Method::GET, "/api/sessions/s1/turn-ledger"),
            Some(Claim::Handle(Route::Ledger))
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/Sessions/S1/Turn-Ledger/"),
            Some(Claim::Handle(Route::Ledger))
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/sessions/s1/turn-ledger"),
            Some(Claim::Options(Route::Ledger))
        );
        assert_eq!(
            claim(&Method::GET, "/api/sessions/s1/turn-hooks/codex-trust"),
            Some(Claim::Handle(Route::TrustGet))
        );
        assert_eq!(
            claim(&Method::POST, "/api/sessions/s1/turn-hooks/codex-trust"),
            Some(Claim::Handle(Route::TrustPost))
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/sessions/s1/turn-hooks/codex-trust"),
            Some(Claim::Options(Route::TrustGet))
        );
        // Methods the retired module never registered, and shapes `:id` cannot
        // match, stay with Node.
        // Express answers HEAD from the GET route it registered.
        assert_eq!(
            claim(&Method::HEAD, "/api/sessions/s1/turn-hooks/codex-trust"),
            Some(Claim::Handle(Route::TrustGet))
        );
        assert_eq!(claim(&Method::POST, "/api/sessions/s1/turn-ledger"), None);
        assert_eq!(claim(&Method::GET, "/api/sessions//turn-ledger"), None);
        assert_eq!(claim(&Method::GET, "/api/sessions/s1/turn-ledger//"), None);
        assert_eq!(claim(&Method::GET, "/api/sessions/s1/turn-ledger/x"), None);
        assert_eq!(
            claim(&Method::GET, "/api/sessions/s1/turn-hooks/other"),
            None
        );
        assert_eq!(claim(&Method::GET, "/API/sessions/s1/turn-ledger"), None);
        assert_eq!(claim(&Method::GET, "/api/turn-ledger"), None);
    }

    #[test]
    fn session_ids_are_decoded_like_express_params() {
        assert_eq!(
            session_id_from_path("/api/sessions/a%2Fb/turn-ledger").as_deref(),
            Some("a/b")
        );
        assert_eq!(
            session_id_from_path("/api/sessions/My%20Session/turn-hooks/codex-trust").as_deref(),
            Some("My Session")
        );
        // A malformed escape stays literal, as `decodeURIComponent` throws and
        // the retired module compared the raw text.
        assert_eq!(
            session_id_from_path("/api/sessions/%E0%A4%A/turn-ledger").as_deref(),
            Some("%E0%A4%A")
        );
    }

    #[test]
    fn session_id_pattern_matches_the_retired_regex() {
        assert!(is_session_id("abc"));
        assert!(is_session_id("a.b_c-D9"));
        assert!(is_session_id(&"a".repeat(128)));
        assert!(!is_session_id(""));
        assert!(!is_session_id(&"a".repeat(129)));
        assert!(!is_session_id("a/b"));
        assert!(!is_session_id("a b"));
        assert!(!is_session_id("../x"));
        assert!(!is_session_id("é"));
    }

    #[test]
    fn snapshots_project_liveness_and_reason() {
        let record = json!({
            "sessionId": "s1", "epoch": 2, "cli": "codex", "cliSessionId": "c1",
            "cliPid": 42, "ownership": "running", "turnId": "t1", "state": "E",
            "evidence": "ledger", "boundary": null, "pendingUserInput": false,
            "backgroundPending": false, "stopPending": true, "promptHead": "hi",
            "needsReview": false, "lastEventAt": 0, "lastTransitionId": "s1:2:t1:1:E",
        });
        assert_eq!(
            snapshot(Some(&record)),
            json!({
                "sessionId": "s1", "epoch": 2, "cli": "codex", "cliSessionId": "c1",
                "cliPid": 42, "ownership": "running",
                "liveness": { "state": "active", "reason": "turn_ledger_running" },
                "turnId": "t1", "state": "E", "evidence": "ledger",
                "reason": "unknown-interruption", "boundary": null,
                "pendingUserInput": false, "backgroundPending": false,
                "stopPending": true, "promptHead": "hi", "needsReview": false,
                "lastEventAt": null, "lastTransitionId": "s1:2:t1:1:E",
            })
        );
        let mut yielded = record.clone();
        yielded["ownership"] = json!("yielding");
        yielded["state"] = json!("W");
        yielded["boundary"] = json!("api-error");
        yielded["lastEventAt"] = json!(1700000000000_i64);
        let value = snapshot(Some(&yielded));
        assert_eq!(
            value["liveness"],
            json!({ "state": "inactive", "reason": "turn_ledger_yielding" })
        );
        assert_eq!(value["reason"], Value::Null);
        assert_eq!(value["lastEventAt"], json!(1700000000000_i64));
        let mut abnormal = record.clone();
        abnormal["ownership"] = json!("ended");
        abnormal["boundary"] = json!("interrupted");
        let value = snapshot(Some(&abnormal));
        assert_eq!(
            value["liveness"],
            json!({ "state": "inactive", "reason": "turn_ledger_ended" })
        );
        assert_eq!(value["reason"], json!("interrupted"));
        // No record at all: `ledger.snapshot` answered null.
        assert_eq!(snapshot(None), Value::Null);
        assert_eq!(snapshot(Some(&Value::Null)), Value::Null);
        // A record with nothing set keeps the unknown liveness and null state.
        let bare = snapshot(Some(&json!({})));
        assert_eq!(
            bare["liveness"],
            json!({ "state": "unknown", "reason": "turn_ledger_no_evidence" })
        );
        assert_eq!(bare["state"], Value::Null);
        assert_eq!(bare["reason"], Value::Null);
    }
}
