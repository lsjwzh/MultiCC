//! Rule kernel for the voice-gateway routes retired from
//! `src/routes/voice-gateway.js`:
//!
//! * `GET|HEAD /api/voice-gateways` and `/api/v1/voice-gateways`
//! * `GET|HEAD|PUT|DELETE /api/directories/:id/voice-gateway` and the v1 twin
//!
//! What moved here is pure: the service-failure status table, the legacy and
//! v1 failure bodies, the `autoInstall` pre-check, the `PUT` options projection
//! and the `withLaunch` DTO that appends the ACP launch block. The service
//! itself (records, directories, commander binding, session persistence), the
//! configured Node binary and the ACP agent path stay in Node behind
//! `POST /api/__host/voice-gateway`; the front door only validates and shapes.
//!
//! Key order is part of the HTTP contract here: the legacy list/gateway bodies
//! are compared byte for byte with the retired Node route.

use serde_json::{Map, Value};

use crate::api_contract;
use crate::js::serde::{from_serde, to_serde, truthy};
use crate::js::JsValue as V;

/// Express's automatic `OPTIONS` answer for `.../voice-gateways` (one GET route,
/// whose HEAD is implicit).
pub const LIST_ALLOW: &str = "GET,HEAD";
/// Express's automatic `OPTIONS` answer for `.../directories/:id/voice-gateway`
/// (GET, PUT and DELETE registered on the same path).
pub const DIRECTORY_ALLOW: &str = "GET,HEAD,PUT,DELETE";

/// The note the retired `withLaunch` attached to every non-v1 gateway DTO.
pub const ACP_NOTE: &str =
    "Qwen generic ACP 的第三层会话工具会被忽略；任务只由 MultiCC Commander 路由。";

/// `resultStatus(code)` from the retired route.
pub fn result_status(code: &str) -> u16 {
    match code {
        "directory_not_found" | "voice_gateway_not_found" => 404,
        "directory_required"
        | "commander_binding_is_host_owned"
        | "voice_gateway_provider_invalid"
        | "voice_gateway_enabled_invalid"
        | "voice_gateway_auto_install_invalid" => 400,
        _ => 409,
    }
}

/// `req.body || {}`: only a JSON object carries the fields the route reads.
/// Arrays and every other JSON value behave like `undefined` properties.
fn body_object(body: &Value) -> Option<&Map<String, Value>> {
    body.as_object()
}

/// `body.autoInstall !== undefined && typeof body.autoInstall !== 'boolean'`.
/// JSON cannot carry `undefined`, so any present non-boolean is invalid.
pub fn auto_install_invalid(body: &Value) -> bool {
    body_object(body).is_some_and(|object| {
        object
            .get("autoInstall")
            .is_some_and(|value| !value.is_boolean())
    })
}

/// `body.autoInstall === true`.
pub fn auto_install_flag(body: &Value) -> bool {
    body_object(body)
        .and_then(|object| object.get("autoInstall"))
        .is_some_and(|value| matches!(value, Value::Bool(true)))
}

/// `{ enabled: body.enabled, provider: body.provider,
///    commanderSessionId: body.commanderSessionId }` — only the keys the body
/// carries (`null` included) in the Node handler's literal order, because the
/// host distinguishes `undefined` from `null`.
pub fn put_options(body: &Value) -> Value {
    let mut options = Map::new();
    if let Some(object) = body_object(body) {
        for key in ["enabled", "provider", "commanderSessionId"] {
            if let Some(value) = object.get(key) {
                options.insert(key.to_string(), value.clone());
            }
        }
    }
    Value::Object(options)
}

/// The retired `sendFailure` legacy body: `{ ok:false, error:code,
/// ...(gatewayIds ? {gatewayIds} : {}) }`. The spread keeps the host's array
/// (an empty array is truthy in JS, so it is kept too).
pub fn legacy_failure(code: &str, gateway_ids: Option<&Value>) -> Value {
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(false));
    body.insert("error".into(), Value::String(code.to_string()));
    if let Some(ids) = gateway_ids.filter(|value| truthy(value)) {
        body.insert("gatewayIds".into(), ids.clone());
    }
    Value::Object(body)
}

/// The retired `sendFailure` v1 body: `createErrorDto({ message: code, code })`
/// plus the request ids. v1 never carries `gatewayIds`.
pub fn versioned_failure(code: &str, ids: &(String, String)) -> Value {
    let input = V::object(vec![
        ("message", V::string(code)),
        ("code", V::string(code)),
    ]);
    to_serde(&api_contract::error_dto(&input, ids))
}

/// The host's `launch`: `{ command, script, baseUrl }`, all strings. A stale
/// host that answers anything else is treated as unavailable.
pub fn launch_valid(launch: &Value) -> bool {
    let Some(object) = launch.as_object() else {
        return false;
    };
    ["command", "script", "baseUrl"]
        .iter()
        .all(|key| object.get(*key).is_some_and(Value::is_string))
}

/// `withLaunch(gateway)` from the retired route: the gateway DTO as received
/// (key order included), then `acp` appended last.
pub fn with_launch(gateway: &Value, launch: &Value) -> Option<Value> {
    let object = gateway.as_object()?;
    if !launch_valid(launch) {
        return None;
    }
    let command = launch.get("command")?.as_str()?;
    let script = launch.get("script")?.as_str()?;
    let base_url = launch.get("baseUrl")?.as_str()?;
    // The host DTO always has directoryId; a missing one stringifies as null in
    // the args array, exactly like a JS `undefined` element.
    let directory_id = object.get("directoryId").cloned().unwrap_or(Value::Null);

    let mut env = Map::new();
    env.insert(
        "MULTICC_BASE_URL".into(),
        Value::String(base_url.to_string()),
    );
    let mut acp = Map::new();
    acp.insert("protocol".into(), Value::String("acp-v1-stdio".to_string()));
    acp.insert("command".into(), Value::String(command.to_string()));
    acp.insert(
        "args".into(),
        Value::Array(vec![
            Value::String(script.to_string()),
            Value::String("--directory-id".to_string()),
            directory_id,
        ]),
    );
    acp.insert("env".into(), Value::Object(env));
    acp.insert("note".into(), Value::String(ACP_NOTE.to_string()));

    let mut out = object.clone();
    out.insert("acp".into(), Value::Object(acp));
    Some(Value::Object(out))
}

/// `safeErrorHandler` for a host throw (any other `code` is a failure code and
/// is answered by the route itself): status 500, client message
/// `internal_error`, and the thrown `code` when it looks like an identifier
/// (api-contract's `createErrorDto` rule).
pub fn thrown_failure(thrown: &Value, ids: &(String, String)) -> (u16, Value) {
    let code = match thrown.get("code") {
        Some(value) if truthy(value) => from_serde(value),
        _ => V::string("internal_error"),
    };
    let input = V::object(vec![
        ("message", V::string("internal_error")),
        ("code", code),
    ]);
    (500, to_serde(&api_contract::error_dto(&input, ids)))
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
        for (code, status) in [
            ("directory_not_found", 404),
            ("voice_gateway_not_found", 404),
            ("directory_required", 400),
            ("commander_binding_is_host_owned", 400),
            ("voice_gateway_provider_invalid", 400),
            ("voice_gateway_enabled_invalid", 400),
            ("voice_gateway_auto_install_invalid", 400),
            ("voice_gateway_ambiguous", 409),
            ("voice_gateway_id_conflict", 409),
            ("something_else", 409),
        ] {
            assert_eq!(result_status(code), status, "{code}");
        }
    }

    #[test]
    fn legacy_failure_keeps_gateway_ids_only_when_the_host_supplied_them() {
        assert_eq!(
            text(&legacy_failure("voice_gateway_not_found", None)),
            r#"{"ok":false,"error":"voice_gateway_not_found"}"#
        );
        assert_eq!(
            text(&legacy_failure(
                "voice_gateway_ambiguous",
                Some(&json!(["a", "b"]))
            )),
            r#"{"ok":false,"error":"voice_gateway_ambiguous","gatewayIds":["a","b"]}"#
        );
        // JS truthiness: an empty array is still a value and is kept; null is not.
        assert_eq!(
            text(&legacy_failure("voice_gateway_ambiguous", Some(&json!([])))),
            r#"{"ok":false,"error":"voice_gateway_ambiguous","gatewayIds":[]}"#
        );
        assert_eq!(
            text(&legacy_failure(
                "voice_gateway_ambiguous",
                Some(&Value::Null)
            )),
            r#"{"ok":false,"error":"voice_gateway_ambiguous"}"#
        );
    }

    #[test]
    fn versioned_failure_is_create_error_dto_without_gateway_ids() {
        let body = versioned_failure("voice_gateway_not_found", &ids());
        assert_eq!(
            text(&body),
            r#"{"ok":false,"error":"voice_gateway_not_found","code":"voice_gateway_not_found","apiVersion":"v1","requestId":"req1","correlationId":"corr1"}"#
        );
        // Codes that are not identifiers fall back to request_error.
        let body = versioned_failure("not a code!", &ids());
        assert_eq!(
            text(&body),
            r#"{"ok":false,"error":"not a code!","code":"request_error","apiVersion":"v1","requestId":"req1","correlationId":"corr1"}"#
        );
    }

    #[test]
    fn auto_install_precheck_matches_typeof() {
        for body in [
            json!({}),
            json!({ "autoInstall": true }),
            json!({ "autoInstall": false }),
        ] {
            assert!(!auto_install_invalid(&body), "{body}");
        }
        for body in [
            json!({ "autoInstall": "true" }),
            json!({ "autoInstall": 1 }),
            json!({ "autoInstall": null }),
            json!({ "autoInstall": [] }),
            json!({ "autoInstall": {} }),
        ] {
            assert!(auto_install_invalid(&body), "{body}");
        }
        // Non-object bodies behave like `{}` and every field is undefined.
        for body in [json!(null), json!([]), json!([1]), json!("x"), json!(3)] {
            assert!(!auto_install_invalid(&body), "{body}");
        }
    }

    #[test]
    fn auto_install_flag_is_strict_true() {
        assert!(auto_install_flag(&json!({ "autoInstall": true })));
        for body in [
            json!({ "autoInstall": false }),
            json!({ "autoInstall": "true" }),
            json!({ "autoInstall": 1 }),
            json!({}),
            json!(null),
            json!([true]),
        ] {
            assert!(!auto_install_flag(&body), "{body}");
        }
    }

    #[test]
    fn put_options_carry_present_keys_in_literal_order() {
        assert_eq!(
            text(&put_options(&json!({
                "commanderSessionId": null,
                "provider": "qwen-audio-agent",
                "extra": 1,
                "enabled": false
            }))),
            r#"{"enabled":false,"provider":"qwen-audio-agent","commanderSessionId":null}"#
        );
        assert_eq!(text(&put_options(&json!({}))), "{}");
        assert_eq!(text(&put_options(&json!([]))), "{}");
        assert_eq!(text(&put_options(&Value::Null)), "{}");
        assert_eq!(
            text(&put_options(&json!({ "provider": null }))),
            r#"{"provider":null}"#
        );
    }

    #[test]
    fn launch_requires_three_strings() {
        let launch = json!({
            "command": "node",
            "script": "/pkg/acp.mjs",
            "baseUrl": "http://127.0.0.1:3000"
        });
        assert!(launch_valid(&launch));
        for key in ["command", "script", "baseUrl"] {
            let mut broken = launch.clone();
            broken.as_object_mut().unwrap().remove(key);
            assert!(!launch_valid(&broken), "{key}");
            let mut broken = launch.clone();
            broken[key] = json!(42);
            assert!(!launch_valid(&broken), "{key}");
        }
        assert!(!launch_valid(&json!([])));
        assert!(!launch_valid(&Value::Null));
    }

    #[test]
    fn with_launch_appends_acp_last_and_keeps_the_dto_order() {
        let gateway = json!({
            "id": "__voice_gateway__abc",
            "directoryId": "dir-1",
            "type": "voice_gateway",
            "provider": "qwen-audio-agent",
            "enabled": true,
            "commanderSessionId": "sess-1",
            "commanderLabel": "main",
            "binding": {
                "ready": true,
                "code": "ok",
                "canonicalCommanderSessionId": "sess-1"
            },
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        });
        let launch = json!({
            "command": "/usr/local/bin/node",
            "script": "/pkg/src/voice/multicc-acp-agent.mjs",
            "baseUrl": "http://127.0.0.1:3000"
        });
        let body = with_launch(&gateway, &launch).expect("launch");
        assert_eq!(
            text(&body),
            concat!(
                r#"{"id":"__voice_gateway__abc","directoryId":"dir-1","type":"voice_gateway","#,
                r#""provider":"qwen-audio-agent","enabled":true,"commanderSessionId":"sess-1","#,
                r#""commanderLabel":"main","binding":{"ready":true,"code":"ok","#,
                r#""canonicalCommanderSessionId":"sess-1"},"#,
                r#""createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","#,
                r#""acp":{"protocol":"acp-v1-stdio","command":"/usr/local/bin/node","#,
                r#""args":["/pkg/src/voice/multicc-acp-agent.mjs","--directory-id","dir-1"],"#,
                r#""env":{"MULTICC_BASE_URL":"http://127.0.0.1:3000"},"#,
                r#""note":"Qwen generic ACP 的第三层会话工具会被忽略；任务只由 MultiCC Commander 路由。"}}"#
            )
        );
        // A missing directoryId becomes a null array element (JS `undefined`).
        let body = with_launch(&json!({ "id": "x" }), &launch).expect("launch");
        assert_eq!(
            text(&body["acp"]["args"]),
            r#"["/pkg/src/voice/multicc-acp-agent.mjs","--directory-id",null]"#
        );
        assert!(with_launch(&json!([]), &launch).is_none());
        assert!(with_launch(&gateway, &json!({ "command": "node" })).is_none());
    }

    #[test]
    fn thrown_failure_uses_safe_error_handler() {
        let (status, body) = thrown_failure(
            &json!({ "code": "disk_full", "message": "no space" }),
            &ids(),
        );
        assert_eq!(status, 500);
        assert_eq!(
            text(&body),
            r#"{"ok":false,"error":"internal_error","code":"disk_full","apiVersion":"v1","requestId":"req1","correlationId":"corr1"}"#
        );
        let (status, body) = thrown_failure(&json!({}), &ids());
        assert_eq!(status, 500);
        assert_eq!(
            text(&body),
            r#"{"ok":false,"error":"internal_error","code":"internal_error","apiVersion":"v1","requestId":"req1","correlationId":"corr1"}"#
        );
        // A non-string code cannot be echoed; createErrorDto falls back.
        let (_, body) = thrown_failure(&json!({ "code": 7 }), &ids());
        assert_eq!(body["code"], json!("request_error"));
        let (_, body) = thrown_failure(&json!({ "code": "" }), &ids());
        assert_eq!(body["code"], json!("internal_error"));
    }
}
