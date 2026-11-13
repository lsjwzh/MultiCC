//! Rule kernel for the two voice-runtime route families retired from
//! `src/routes/voice-gateway-global.js` (the global control plane) and
//! `src/routes/qwen-audio-runtime.js` (the runtime installer / Fleet
//! projections):
//!
//! * `GET|HEAD|PUT|DELETE /api/voice-gateway` and the v1 twin
//! * `GET|HEAD /api/voice-gateway/runtime`
//! * `POST /api/voice-gateway/restart`
//! * `POST /api/voice-gateway/launch`
//! * `GET|HEAD /api/voice-gateway/launch/:launchId`
//! * `GET|HEAD /api/voice-runtime`
//! * `POST /api/voice-runtime/install`
//! * `GET|HEAD /api/directories/:id/voice-gateway/runtime`
//! * `POST /api/directories/:id/voice-gateway/restart`
//!
//! Everything here is pure: the failure-code status table, the legacy and v1
//! failure bodies, the `autoInstall` pre-check, the PUT options projection,
//! `{ ...status, url: undefined }`, the `{ ...status, projectedFrom,
//! requestedDirectoryId }` Fleet projection, the launch URL, the loopback
//! check and the launch DTO shapes. The gateway/installer/supervisor state and
//! every side effect stay in Node behind `POST /api/__host/voice-runtime`; the
//! front door only validates and shapes.
//!
//! Key order is part of the HTTP contract: the launch response, the
//! projection and every pass-through object are compared byte for byte with
//! the retired Node handlers.

use serde_json::{json, Map, Value};

use crate::js::serde::truthy;
use crate::js::{from_serde, js_to_string};
use crate::voice_gateway_routes as shared;

/// Express's automatic `OPTIONS` answer for `/api/voice-gateway`, which
/// registers GET (implicit HEAD), PUT and DELETE.
pub const GLOBAL_ALLOW: &str = "GET,HEAD,PUT,DELETE";
/// `/api/voice-gateway/runtime` registers one GET (implicit HEAD).
pub const RUNTIME_ALLOW: &str = "GET,HEAD";
/// `/api/voice-gateway/restart` registers one POST.
pub const RESTART_ALLOW: &str = "POST";
/// `/api/voice-gateway/launch` registers one POST.
pub const LAUNCH_ALLOW: &str = "POST";
/// `/api/voice-gateway/launch/:launchId` registers one GET (implicit HEAD).
pub const LAUNCH_RESOLVE_ALLOW: &str = "GET,HEAD";
/// `/api/voice-runtime` registers one GET (implicit HEAD).
pub const VOICE_RUNTIME_ALLOW: &str = "GET,HEAD";
/// `/api/voice-runtime/install` registers one POST.
pub const INSTALL_ALLOW: &str = "POST";
/// `/api/directories/:id/voice-gateway/runtime` registers one GET.
pub const FLEET_RUNTIME_ALLOW: &str = "GET,HEAD";
/// `/api/directories/:id/voice-gateway/restart` registers one POST.
pub const FLEET_RESTART_ALLOW: &str = "POST";

/// `PROXY_PREFIX` from `src/routes/voice-gateway-proxy.js`.
pub const PROXY_PREFIX: &str = "/voice-gateway/web";

/// `statusForCode` from the retired global route: the three "missing" codes
/// are 404, the client mistakes are 400, an expired launch is 410, and every
/// other service refusal (`voice_router_not_provisioned`,
/// `voice_router_id_conflict`, …) is a 409.
pub fn result_status(code: &str) -> u16 {
    match code {
        "voice_gateway_not_found" | "voice_launch_source_not_found" | "voice_launch_unknown" => 404,
        "commander_binding_is_host_owned"
        | "voice_gateway_provider_invalid"
        | "voice_gateway_enabled_invalid"
        | "voice_gateway_auto_install_invalid"
        | "voice_launch_required"
        | "voice_launch_scope_invalid"
        | "voice_launch_source_required"
        | "voice_launch_source_not_addressable"
        | "voice_launch_source_not_chat" => 400,
        "voice_launch_expired" => 410,
        _ => 409,
    }
}

/// The front door's stale-host answer for this host port.
pub fn unavailable_body() -> Value {
    let mut body = Map::new();
    body.insert(
        "error".into(),
        Value::String("语音运行时接口尚未就绪，请更新原生模块".into()),
    );
    body.insert(
        "code".into(),
        Value::String("rust_backend_unavailable".into()),
    );
    Value::Object(body)
}

/// `res.status(status).json({ ok: false, error: code })` — these routes never
/// carry `gatewayIds`.
pub fn legacy_failure(code: &str) -> Value {
    shared::legacy_failure(code, None)
}

/// `createErrorDto({ message: code, code })` plus the request ids.
pub fn versioned_failure(code: &str, ids: &(String, String)) -> Value {
    shared::versioned_failure(code, ids)
}

/// `next(error)` for a host throw: `safeErrorHandler`'s opaque 500.
pub fn thrown_failure(thrown: &Value, ids: &(String, String)) -> (u16, Value) {
    shared::thrown_failure(thrown, ids)
}

/// `body.autoInstall !== undefined && typeof body.autoInstall !== 'boolean'`.
pub fn auto_install_invalid(body: &Value) -> bool {
    shared::auto_install_invalid(body)
}

/// `body.autoInstall === true`.
pub fn auto_install_flag(body: &Value) -> bool {
    shared::auto_install_flag(body)
}

/// `{ enabled: body.enabled, provider: body.provider,
///    commanderSessionId: body.commanderSessionId }`, present keys only.
pub fn put_options(body: &Value) -> Value {
    shared::put_options(body)
}

/// The host payload for `PUT /api/voice-gateway`.
pub fn global_put_payload(body: &Value) -> Value {
    let mut out = Map::new();
    out.insert("op".into(), Value::String("globalPut".into()));
    out.insert("options".into(), put_options(body));
    out.insert("autoInstall".into(), Value::Bool(auto_install_flag(body)));
    Value::Object(out)
}

/// The host payload for `POST /api/voice-gateway/launch`: `sourceSessionId`
/// only when the body carried the key (its value is passed through verbatim,
/// `null` included), like the retired `{ sourceSessionId: body.sourceSessionId }`.
pub fn launch_begin_payload(body: &Value) -> Value {
    let mut out = Map::new();
    out.insert("op".into(), Value::String("launchBegin".into()));
    if let Some(object) = body.as_object() {
        if let Some(source) = object.get("sourceSessionId") {
            out.insert("sourceSessionId".into(), source.clone());
        }
    }
    Value::Object(out)
}

/// `{ ...status, url: undefined }`: the spread keeps the host's key order and
/// plain `JSON.stringify` omits the undefined `url`. A non-object status is a
/// stale host and makes the route answer 503.
pub fn without_url(status: &Value) -> Option<Value> {
    let mut object = status.as_object()?.clone();
    object.remove("url");
    Some(Value::Object(object))
}

/// `{ ...status, projectedFrom: 'global', requestedDirectoryId: id }`. The
/// spread's keys come first; a status that already has one of the appended
/// names keeps its original position and takes the new value (JS object
/// assignment semantics).
pub fn projection(status: &Value, directory_id: &str) -> Option<Value> {
    let mut object = status.as_object()?.clone();
    object.insert("projectedFrom".into(), Value::String("global".to_string()));
    object.insert(
        "requestedDirectoryId".into(),
        Value::String(directory_id.to_string()),
    );
    Some(Value::Object(object))
}

/// `String(runtimeUrl || '').replace(/\/$/, '')`: the falsy values become the
/// empty string, then exactly one trailing slash is removed.
fn runtime_url_text(runtime_url: Option<&Value>) -> String {
    let Some(value) = runtime_url.filter(|value| truthy(value)) else {
        return String::new();
    };
    js_to_string(&from_serde(value)).to_string_lossy()
}

/// `launchUrl(runtimeUrl, launchId)`: the browser-facing URL is a
/// root-relative path through the web proxy, so the same answer works for a
/// local browser, LAN and Funnel. No usable runtime URL means no launch.
pub fn launch_url(runtime_url: Option<&Value>, launch_id: &str) -> Option<String> {
    let raw = runtime_url_text(runtime_url);
    let base = raw.strip_suffix('/').unwrap_or(&raw);
    if base.is_empty() {
        return None;
    }
    Some(format!(
        "{PROXY_PREFIX}/?session={}",
        crate::http_gate::encode_uri_component(launch_id)
    ))
}

/// `status?.lastError?.code || 'voice_gateway_not_running'`: only a non-empty
/// string counts (the route needs a code it can also put in a failure body).
pub fn launch_failure_code(status: Option<&Value>) -> String {
    status
        .and_then(|status| status.get("lastError"))
        .and_then(|last_error| last_error.get("code"))
        .and_then(Value::as_str)
        .filter(|code| !code.is_empty())
        .unwrap_or("voice_gateway_not_running")
        .to_string()
}

/// `requestIsLoopback(req)`: the raw `Host` header, lowercased, with the port
/// removed (an IPv6 literal keeps its brackets). A phone configured with a
/// LAN/Funnel address reports `false`.
pub fn loopback_only(host: Option<&str>) -> bool {
    let host = host.unwrap_or("").to_lowercase();
    let hostname = if host.starts_with('[') {
        match host.find(']') {
            Some(end) => &host[..end + 1],
            None => "",
        }
    } else {
        host.split(':').next().unwrap_or("")
    };
    matches!(hostname, "127.0.0.1" | "localhost" | "[::1]" | "::1")
}

/// The `launchBegin` success payload the route needs.
pub struct Issued {
    /// `issued.launch` as received: `{ id, scope, expiresAt, display, ... }`.
    pub launch: Map<String, Value>,
    /// `issued.context.targetSessionId`, passed back on `launchEnd`.
    pub target_session_id: Value,
    /// `statusGlobal()` at issue time: an object, or `null`.
    pub status: Option<Value>,
}

/// `{ ok: true, launch: {...}, targetSessionId, status: {...}|null }`. A host
/// that answers anything else is stale.
pub fn launch_issued(answer: &Value) -> Option<Issued> {
    let launch = answer.get("launch")?.as_object()?;
    if !launch.get("id").is_some_and(Value::is_string) {
        return None;
    }
    for key in ["scope", "expiresAt", "display"] {
        if !launch.contains_key(key) {
            return None;
        }
    }
    let status = match answer.get("status") {
        Some(Value::Null) => None,
        Some(value @ Value::Object(_)) => Some(value.clone()),
        _ => return None,
    };
    Some(Issued {
        launch: launch.clone(),
        target_session_id: answer
            .get("targetSessionId")
            .cloned()
            .unwrap_or(Value::Null),
        status,
    })
}

/// `launchRegistry.revoke(issued.launch.id)` after a launch that never got a
/// URL: the host records the revoked id.
pub fn launch_revoke_payload(launch_id: &Value) -> Value {
    let mut out = Map::new();
    out.insert("op".into(), Value::String("launchEnd".into()));
    out.insert("id".into(), launch_id.clone());
    out.insert("revoke".into(), Value::Bool(true));
    Value::Object(out)
}

/// `launchRegistry.ack({ id, revoke: false, scope, source, target })`: the
/// host writes one log line. `source` is `launch.sourceSessionId` and only
/// appears when the host supplied it.
pub fn launch_end_payload(launch: &Map<String, Value>, target: &Value) -> Value {
    let mut out = Map::new();
    out.insert("op".into(), Value::String("launchEnd".into()));
    out.insert(
        "id".into(),
        launch.get("id").cloned().unwrap_or(Value::Null),
    );
    out.insert("revoke".into(), Value::Bool(false));
    out.insert(
        "scope".into(),
        launch.get("scope").cloned().unwrap_or(Value::Null),
    );
    if let Some(source) = launch.get("sourceSessionId") {
        out.insert("source".into(), source.clone());
    }
    out.insert("target".into(), target.clone());
    Value::Object(out)
}

/// `{ ok: true, launch: { url, scope, expiresAt, display, transport:
/// { loopbackOnly } } }` — the key order is the retired handler's literal.
pub fn launch_response(launch: &Map<String, Value>, url: &str, loopback: bool) -> Value {
    let mut inner = Map::new();
    inner.insert("url".into(), Value::String(url.to_string()));
    for key in ["scope", "expiresAt", "display"] {
        inner.insert(key.into(), launch.get(key).cloned().unwrap_or(Value::Null));
    }
    inner.insert("transport".into(), json!({ "loopbackOnly": loopback }));
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(true));
    out.insert("launch".into(), Value::Object(inner));
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::serde::js_json_stringify;
    use serde_json::json;

    fn ids() -> (String, String) {
        ("req1".to_string(), "corr1".to_string())
    }

    fn text(value: &Value) -> String {
        js_json_stringify(value)
    }

    #[test]
    fn statuses_follow_the_retired_table() {
        for code in [
            "voice_gateway_not_found",
            "voice_launch_source_not_found",
            "voice_launch_unknown",
        ] {
            assert_eq!(result_status(code), 404, "{code}");
        }
        for code in [
            "commander_binding_is_host_owned",
            "voice_gateway_provider_invalid",
            "voice_gateway_enabled_invalid",
            "voice_gateway_auto_install_invalid",
            "voice_launch_required",
            "voice_launch_scope_invalid",
            "voice_launch_source_required",
            "voice_launch_source_not_addressable",
            "voice_launch_source_not_chat",
        ] {
            assert_eq!(result_status(code), 400, "{code}");
        }
        assert_eq!(result_status("voice_launch_expired"), 410);
        for code in [
            "voice_router_not_provisioned",
            "voice_router_id_conflict",
            "voice_gateway_not_running",
            "something_else",
        ] {
            assert_eq!(result_status(code), 409, "{code}");
        }
    }

    #[test]
    fn allow_lists_match_the_express_routes() {
        assert_eq!(GLOBAL_ALLOW, "GET,HEAD,PUT,DELETE");
        assert_eq!(RUNTIME_ALLOW, "GET,HEAD");
        assert_eq!(RESTART_ALLOW, "POST");
        assert_eq!(LAUNCH_ALLOW, "POST");
        assert_eq!(LAUNCH_RESOLVE_ALLOW, "GET,HEAD");
        assert_eq!(VOICE_RUNTIME_ALLOW, "GET,HEAD");
        assert_eq!(INSTALL_ALLOW, "POST");
        assert_eq!(FLEET_RUNTIME_ALLOW, "GET,HEAD");
        assert_eq!(FLEET_RESTART_ALLOW, "POST");
    }

    #[test]
    fn failure_bodies_carry_no_gateway_ids() {
        assert_eq!(
            text(&legacy_failure("voice_launch_unknown")),
            r#"{"ok":false,"error":"voice_launch_unknown"}"#
        );
        assert_eq!(
            text(&versioned_failure("voice_launch_unknown", &ids())),
            r#"{"ok":false,"error":"voice_launch_unknown","code":"voice_launch_unknown","apiVersion":"v1","requestId":"req1","correlationId":"corr1"}"#
        );
        let (status, body) =
            thrown_failure(&json!({ "code": "disk_full", "message": "x" }), &ids());
        assert_eq!(status, 500);
        assert_eq!(body["code"], json!("disk_full"));
        assert_eq!(body["error"], json!("internal_error"));
    }

    #[test]
    fn unavailable_body_is_the_runtime_one() {
        assert_eq!(
            text(&unavailable_body()),
            r#"{"error":"语音运行时接口尚未就绪，请更新原生模块","code":"rust_backend_unavailable"}"#
        );
    }

    #[test]
    fn global_put_payload_projects_the_body() {
        assert_eq!(
            text(&global_put_payload(&json!({
                "enabled": false,
                "provider": null,
                "commanderSessionId": null,
                "autoInstall": true,
                "extra": 1
            }))),
            r#"{"op":"globalPut","options":{"enabled":false,"provider":null,"commanderSessionId":null},"autoInstall":true}"#
        );
        // Non-object bodies behave like `{}` (everything undefined).
        assert_eq!(
            text(&global_put_payload(&json!([1, 2]))),
            r#"{"op":"globalPut","options":{},"autoInstall":false}"#
        );
        assert!(auto_install_invalid(&json!({ "autoInstall": "yes" })));
        assert!(!auto_install_invalid(&json!({ "autoInstall": false })));
    }

    #[test]
    fn launch_begin_payload_only_carries_a_present_source() {
        assert_eq!(
            text(&launch_begin_payload(
                &json!({ "sourceSessionId": "sess-1", "x": 1 })
            )),
            r#"{"op":"launchBegin","sourceSessionId":"sess-1"}"#
        );
        assert_eq!(
            text(&launch_begin_payload(&json!({ "sourceSessionId": null }))),
            r#"{"op":"launchBegin","sourceSessionId":null}"#
        );
        assert_eq!(
            text(&launch_begin_payload(&json!({}))),
            r#"{"op":"launchBegin"}"#
        );
        assert_eq!(
            text(&launch_begin_payload(&json!(["sess-1"]))),
            r#"{"op":"launchBegin"}"#
        );
    }

    #[test]
    fn without_url_drops_the_key_and_keeps_the_order() {
        assert_eq!(
            text(
                &without_url(&json!({
                    "scope": "global",
                    "state": "running",
                    "url": "http://127.0.0.1:4123",
                    "desired": true
                }))
                .unwrap()
            ),
            r#"{"scope":"global","state":"running","desired":true}"#
        );
        // Already absent: nothing changes.
        assert_eq!(
            text(&without_url(&json!({ "state": "stopped" })).unwrap()),
            r#"{"state":"stopped"}"#
        );
        assert_eq!(text(&without_url(&json!({})).unwrap()), "{}");
        // A stale host answered a non-object.
        assert!(without_url(&json!("running")).is_none());
        assert!(without_url(&Value::Null).is_none());
    }

    #[test]
    fn projection_appends_after_the_status_keys() {
        assert_eq!(
            text(
                &projection(
                    &json!({ "state": "running", "url": "x", "desired": true }),
                    "dir-1"
                )
                .unwrap()
            ),
            r#"{"state":"running","url":"x","desired":true,"projectedFrom":"global","requestedDirectoryId":"dir-1"}"#
        );
        // A status that already has one of the names keeps its position and
        // takes the new value — exactly what object assignment does.
        assert_eq!(
            text(
                &projection(
                    &json!({
                        "projectedFrom": "stale",
                        "state": "running",
                        "requestedDirectoryId": "old"
                    }),
                    "dir-9"
                )
                .unwrap()
            ),
            r#"{"projectedFrom":"global","state":"running","requestedDirectoryId":"dir-9"}"#
        );
        assert!(projection(&json!([]), "dir-1").is_none());
    }

    #[test]
    fn launch_url_requires_a_usable_runtime_url() {
        let url = |value: Value| launch_url(Some(&value), "launch-1");
        assert_eq!(
            url(json!("http://127.0.0.1:4123")).as_deref(),
            Some("/voice-gateway/web/?session=launch-1")
        );
        // One trailing slash is stripped; two leave one, like the regex.
        assert_eq!(
            url(json!("http://127.0.0.1:4123/")).as_deref(),
            Some("/voice-gateway/web/?session=launch-1")
        );
        assert_eq!(
            url(json!("//")).as_deref(),
            Some("/voice-gateway/web/?session=launch-1")
        );
        for empty in [json!(""), json!("/"), json!(null), json!(false), json!(0)] {
            assert_eq!(url(empty.clone()), None, "{empty}");
        }
        assert_eq!(launch_url(None, "launch-1"), None);
        // encodeURIComponent's reserved set.
        assert_eq!(
            launch_url(
                Some(&json!("http://x")),
                "a b/c?d&e=f+g%h#i'j(k)l!m~n*o.p-q_r"
            )
            .as_deref(),
            Some("/voice-gateway/web/?session=a%20b%2Fc%3Fd%26e%3Df%2Bg%25h%23i'j(k)l!m~n*o.p-q_r")
        );
        assert_eq!(
            launch_url(Some(&json!("x")), "语音🙂").as_deref(),
            Some("/voice-gateway/web/?session=%E8%AF%AD%E9%9F%B3%F0%9F%99%82")
        );
    }

    #[test]
    fn launch_failure_code_falls_back_to_not_running() {
        assert_eq!(
            launch_failure_code(Some(&json!({ "lastError": { "code": "spawn_failed" } }))),
            "spawn_failed"
        );
        for status in [
            json!({}),
            json!({ "lastError": {} }),
            json!({ "lastError": { "code": "" } }),
            json!({ "lastError": { "code": 7 } }),
            json!({ "lastError": null }),
            json!("nope"),
        ] {
            assert_eq!(
                launch_failure_code(Some(&status)),
                "voice_gateway_not_running",
                "{status}"
            );
        }
        assert_eq!(launch_failure_code(None), "voice_gateway_not_running");
    }

    #[test]
    fn loopback_only_follows_the_host_header() {
        for host in [
            "127.0.0.1",
            "127.0.0.1:3000",
            "localhost",
            "LOCALHOST:3000",
            "[::1]",
            "[::1]:3000",
        ] {
            assert!(loopback_only(Some(host)), "{host}");
        }
        for host in [
            "192.168.1.5:3000",
            "example.com",
            "127.0.0.2",
            "[",
            "[::2]:3000",
            // A bare `::1` splits to the empty string, exactly like the
            // retired handler (the `'::1'` set member is unreachable there).
            "::1",
            "",
        ] {
            assert!(!loopback_only(Some(host)), "{host}");
        }
        assert!(!loopback_only(None));
    }

    #[test]
    fn launch_issued_validates_the_host_answer() {
        let answer = json!({
            "ok": true,
            "launch": {
                "id": "launch-1",
                "scope": "global",
                "expiresAt": "2026-01-01T00:01:00.000Z",
                "display": { "label": "main" },
                "sourceSessionId": "sess-1"
            },
            "targetSessionId": "sess-target",
            "status": { "state": "running", "url": "http://127.0.0.1:1" }
        });
        let issued = launch_issued(&answer).expect("valid");
        assert_eq!(issued.launch["id"], json!("launch-1"));
        assert_eq!(issued.target_session_id, json!("sess-target"));
        assert_eq!(issued.status.as_ref().unwrap()["state"], json!("running"));

        // `status: null` is the "not running yet" answer.
        let mut stopped = answer.clone();
        stopped["status"] = Value::Null;
        assert!(launch_issued(&stopped).unwrap().status.is_none());

        for broken in [
            json!({ "ok": true }),
            json!({ "ok": true, "launch": [], "status": {} }),
            json!({ "ok": true, "launch": { "id": 1, "scope": "g", "expiresAt": "x", "display": {} }, "status": {} }),
            json!({ "ok": true, "launch": { "id": "l", "expiresAt": "x", "display": {} }, "status": {} }),
            json!({ "ok": true, "launch": { "id": "l", "scope": "g", "display": {} }, "status": {} }),
            json!({ "ok": true, "launch": { "id": "l", "scope": "g", "expiresAt": "x" }, "status": {} }),
            json!({ "ok": true, "launch": { "id": "l", "scope": "g", "expiresAt": "x", "display": {} } }),
            json!({ "ok": true, "launch": { "id": "l", "scope": "g", "expiresAt": "x", "display": {} }, "status": "running" }),
        ] {
            assert!(launch_issued(&broken).is_none(), "{broken}");
        }
    }

    #[test]
    fn launch_end_payload_matches_the_host_contract() {
        let mut issued = launch_issued(&json!({
            "ok": true,
            "launch": {
                "id": "launch-1",
                "scope": "session",
                "expiresAt": "2026-01-01T00:01:00.000Z",
                "display": { "label": "main" },
                "sourceSessionId": "sess-1"
            },
            "targetSessionId": "sess-target",
            "status": null
        }))
        .unwrap();
        assert_eq!(
            text(&launch_end_payload(
                &issued.launch,
                &issued.target_session_id
            )),
            r#"{"op":"launchEnd","id":"launch-1","revoke":false,"scope":"session","source":"sess-1","target":"sess-target"}"#
        );
        // Without a source the key is absent (JS `undefined`).
        issued.launch.remove("sourceSessionId");
        assert_eq!(
            text(&launch_end_payload(&issued.launch, &Value::Null)),
            r#"{"op":"launchEnd","id":"launch-1","revoke":false,"scope":"session","target":null}"#
        );
        assert_eq!(
            text(&launch_revoke_payload(&json!("launch-1"))),
            r#"{"op":"launchEnd","id":"launch-1","revoke":true}"#
        );
    }

    #[test]
    fn launch_response_keeps_the_handler_literal_order() {
        let issue = launch_issued(&json!({
            "ok": true,
            "launch": {
                "id": "launch-1",
                "scope": "global",
                "expiresAt": "2026-01-01T00:01:00.000Z",
                "display": null
            },
            "status": null
        }))
        .unwrap();
        assert_eq!(
            text(&launch_response(
                &issue.launch,
                "/voice-gateway/web/?session=launch-1",
                true
            )),
            concat!(
                r#"{"ok":true,"launch":{"url":"/voice-gateway/web/?session=launch-1","#,
                r#""scope":"global","expiresAt":"2026-01-01T00:01:00.000Z","display":null,"#,
                r#""transport":{"loopbackOnly":true}}}"#
            )
        );
    }
}
