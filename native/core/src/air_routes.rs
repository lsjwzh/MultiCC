//! Rules kernel for the Air task-board route cluster (`src/workspace/air-routes.js`).
//!
//! Everything that is a *rule* over the Node runtime's answers lives here: the
//! `if-none-match` → 304 decision, the `{ ok: false, code, message }` error
//! envelope (three flavours: the generic route, the pin/todo collection and the
//! pin/todo toggle), the `{ ok: true, … }` wrappers, the reclaim spread and the
//! `/api/air/resolve` redirect URL. Path matching, parameter decoding and
//! body-field extraction live in the front-door handler
//! (`native/gateway/src/app/air_routes.rs`), which owns the Express surface.
//!
//! Everything that needs the process-local world stays in Node behind the host
//! port (`src/workspace/air-routes-host.js`): the task board and records Maps,
//! the card cache and snapshot assembly, the task-shell runtime, worktree
//! reclaim subprocesses, the pins/todos/ignore state files and the live-sync
//! WebSocket broadcaster. The front door only ever sends `{ op, … }` and gets
//! the runtime value back.
//!
//! Byte-for-byte parity is the contract: the front door serializes host values
//! through the V8-compatible `js_json_stringify`, and the snapshot body is
//! produced (and its ETag derived) in Node so it can be forwarded verbatim.

use serde_json::{Map, Value};
use url::form_urlencoded;

use crate::js::serde::{js_string, truthy};
use crate::js::string::js_trim;

/// `conditionalBody`: `if-none-match` is a comma-separated token list; a token
/// that trims to the exact ETag or to `*` answers 304. An absent or empty
/// header never matches (the retired code tested the raw header for truthiness).
pub fn conditional_matches(if_none_match: Option<&str>, etag: &str) -> bool {
    let Some(header) = if_none_match.filter(|value| !value.is_empty()) else {
        return false;
    };
    header
        .split(',')
        .any(|token| js_trim(token) == etag || js_trim(token) == "*")
}

/// The facts the retired `route()` catch arm projected onto the error body.
#[derive(Default, Clone, Debug)]
pub struct ErrorFacts {
    pub code: Option<String>,
    pub status: Option<i64>,
    pub message: Option<String>,
}

/// `res.status(error.status || 500).json({ ok: false, code: error.code ||
/// default, message: … })`.
///
/// `always_generic_message` is the pin/todo collection arm, which never leaks
/// the thrown message. Everything else keeps it when `error.status` is truthy
/// (an absent message then drops the key, exactly like `undefined` in
/// `JSON.stringify`).
pub fn error_body(
    default_code: &str,
    always_generic_message: bool,
    facts: &ErrorFacts,
) -> (u16, Value) {
    let truthy_status = facts.status.filter(|status| *status != 0);
    let status = truthy_status.unwrap_or(500);
    // Express only accepts 100..=999; anything else raises inside `res.status`
    // and the safe error handler turns that into a 500.
    let status = u16::try_from(status)
        .ok()
        .filter(|code| (100..=999).contains(code))
        .unwrap_or(500);
    let code = facts
        .code
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(default_code);
    let mut object = Map::new();
    object.insert("ok".into(), Value::Bool(false));
    object.insert("code".into(), Value::String(code.to_string()));
    if always_generic_message || truthy_status.is_none() {
        object.insert("message".into(), Value::String("Request failed".into()));
    } else if let Some(message) = &facts.message {
        object.insert("message".into(), Value::String(message.clone()));
    }
    (status, Value::Object(object))
}

/// `{ ok: true, [key]: value }` in that key order (`taskIds`, `publications`,
/// `roleBindings`, `taskId`/`url`).
pub fn ok_field(key: &str, value: Value) -> Value {
    let mut object = Map::new();
    object.insert("ok".into(), Value::Bool(true));
    object.insert(key.into(), value);
    Value::Object(object)
}

/// `{ ok: true, ...value }` — `/api/air/todos/ignore` forwards the toggle
/// result (`ignored, kind, taskIds, todos`) after its own `ok`.
pub fn spread_ok(value: &Value) -> Value {
    let mut object = Map::new();
    object.insert("ok".into(), Value::Bool(true));
    if let Value::Object(fields) = value {
        for (key, field) in fields {
            object.insert(key.clone(), field.clone());
        }
    }
    Value::Object(object)
}

/// `POST /api/air/pins` / `POST /api/air/todos` without an array body.
pub fn task_ids_required() -> (u16, Value) {
    let mut object = Map::new();
    object.insert("ok".into(), Value::Bool(false));
    object.insert("code".into(), Value::String("task_ids_required".into()));
    object.insert("message".into(), Value::String("taskIds 必须是数组".into()));
    (400, Value::Object(object))
}

/// `POST /api/air/worktrees/reclaim` with no hibernation runtime installed.
pub fn hibernation_unavailable() -> Value {
    let mut object = Map::new();
    object.insert("ok".into(), Value::Bool(false));
    object.insert(
        "code".into(),
        Value::String("hibernation_unavailable".into()),
    );
    object.insert("considered".into(), Value::from(0));
    object.insert("hibernated".into(), Value::from(0));
    Value::Object(object)
}

/// `{ ok: result.ok !== false, dirId, ...result }`. Later spread keys keep
/// their original position and take the result's value, like an object spread.
pub fn reclaim_body(result: &Value, dir_id: Option<&str>) -> Value {
    let mut object = Map::new();
    let ok = result.get("ok") != Some(&Value::Bool(false));
    object.insert("ok".into(), Value::Bool(ok));
    object.insert(
        "dirId".into(),
        dir_id
            .map(|value| Value::String(value.to_string()))
            .unwrap_or(Value::Null),
    );
    if let Value::Object(fields) = result {
        for (key, field) in fields {
            object.insert(key.clone(), field.clone());
        }
    }
    Value::Object(object)
}

/// `new URLSearchParams({ task: String(taskId), ...(dirId ? { dir: String(dirId) }
/// : {}) }).toString()` — the WHATWG form-urlencoded serializer (`url` uses the
/// same byte set, and turns a space into `+`).
pub fn resolve_url(task_id: &Value, dir_id: &Value) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("task", &js_string(task_id));
    if truthy(dir_id) {
        serializer.append_pair("dir", &js_string(dir_id));
    }
    format!("/air?{}", serializer.finish())
}

/// `GET /api/air/resolve`: `{ ok: true, url: '/air' }` when nothing resolved,
/// otherwise `{ ok: true, taskId, url }` with the raw task id.
pub fn resolve_body(task_id: &Value, dir_id: &Value) -> Value {
    if !truthy(task_id) {
        return ok_field("url", Value::String("/air".into()));
    }
    let mut object = Map::new();
    object.insert("ok".into(), Value::Bool(true));
    object.insert("taskId".into(), task_id.clone());
    object.insert("url".into(), Value::String(resolve_url(task_id, dir_id)));
    Value::Object(object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn body(facts: &ErrorFacts, default: &str, generic: bool) -> (u16, String) {
        let (status, value) = error_body(default, generic, facts);
        (status, value.to_string())
    }

    #[test]
    fn conditional_matches_follows_the_split_and_trim_rule() {
        let etag = "W/\"abc\"";
        assert!(!conditional_matches(None, etag));
        assert!(!conditional_matches(Some(""), etag));
        assert!(conditional_matches(Some(etag), etag));
        assert!(conditional_matches(Some("*"), etag));
        assert!(conditional_matches(
            Some(&format!(" \"other\" , {etag} ")),
            etag
        ));
        assert!(
            !conditional_matches(Some("W/\"abcd\""), etag),
            "no prefix matching"
        );
        assert!(
            !conditional_matches(Some("\"abc\""), etag),
            "the weak prefix is part of the tag"
        );
        assert!(conditional_matches(Some("*, W/\"other\""), etag));
    }

    #[test]
    fn generic_error_keeps_the_message_only_with_a_truthy_status() {
        let facts = ErrorFacts {
            code: Some("pin_limit_reached".into()),
            status: Some(409),
            message: Some("最多只能钉 100 个任务".into()),
        };
        assert_eq!(
            body(&facts, "pin_failed", false),
            (
                409,
                json!({"ok":false,"code":"pin_limit_reached","message":"最多只能钉 100 个任务"})
                    .to_string()
            )
        );
        let no_status = ErrorFacts {
            code: Some("boom".into()),
            message: Some("secret".into()),
            ..Default::default()
        };
        assert_eq!(
            body(&no_status, "air_request_failed", false),
            (
                500,
                json!({"ok":false,"code":"boom","message":"Request failed"}).to_string()
            )
        );
    }

    #[test]
    fn collection_errors_never_leak_the_message_and_default_the_code() {
        let facts = ErrorFacts {
            code: None,
            status: Some(500),
            message: Some("disk full at /secret".into()),
        };
        assert_eq!(
            body(&facts, "pin_failed", true),
            (
                500,
                json!({"ok":false,"code":"pin_failed","message":"Request failed"}).to_string()
            )
        );
        let failed_save = ErrorFacts {
            code: Some("todo_save_failed".into()),
            status: Some(500),
            message: Some("[multicc] save failed".into()),
        };
        assert_eq!(
            body(&failed_save, "todo_failed", true),
            (
                500,
                json!({"ok":false,"code":"todo_save_failed","message":"Request failed"})
                    .to_string()
            )
        );
    }

    #[test]
    fn error_status_zero_falls_back_and_invalid_statuses_become_500() {
        let zero = ErrorFacts {
            status: Some(0),
            message: Some("nope".into()),
            ..Default::default()
        };
        assert_eq!(
            body(&zero, "air_request_failed", false),
            (
                500,
                json!({"ok":false,"code":"air_request_failed","message":"Request failed"})
                    .to_string()
            )
        );
        let out_of_range = ErrorFacts {
            status: Some(1000),
            message: Some("nope".into()),
            code: Some("x".into()),
        };
        assert_eq!(
            body(&out_of_range, "air_request_failed", false),
            (
                500,
                json!({"ok":false,"code":"x","message":"nope"}).to_string()
            )
        );
        let missing_message = ErrorFacts {
            status: Some(422),
            code: Some("x".into()),
            message: None,
        };
        assert_eq!(
            body(&missing_message, "air_request_failed", false),
            (422, json!({"ok":false,"code":"x"}).to_string())
        );
    }

    #[test]
    fn task_ids_required_is_the_retired_400() {
        let (status, value) = task_ids_required();
        assert_eq!(status, 400);
        assert_eq!(
            value.to_string(),
            json!({"ok":false,"code":"task_ids_required","message":"taskIds 必须是数组"})
                .to_string()
        );
    }

    #[test]
    fn hibernation_unavailable_keeps_its_key_order() {
        assert_eq!(
            hibernation_unavailable().to_string(),
            json!({"ok":false,"code":"hibernation_unavailable","considered":0,"hibernated":0})
                .to_string()
        );
    }

    #[test]
    fn reclaim_spreads_after_ok_and_dir_id_without_moving_existing_keys() {
        let result = json!({"ok":true,"dirId":"other","considered":2,"hibernated":1});
        assert_eq!(
            reclaim_body(&result, Some("d1")).to_string(),
            json!({"ok":true,"dirId":"other","considered":2,"hibernated":1}).to_string()
        );
        let failed = json!({"ok":false,"considered":0});
        assert_eq!(
            reclaim_body(&failed, None).to_string(),
            json!({"ok":false,"dirId":null,"considered":0}).to_string()
        );
        assert_eq!(
            reclaim_body(&json!({}), Some("d9")).to_string(),
            json!({"ok":true,"dirId":"d9"}).to_string()
        );
    }

    #[test]
    fn resolve_builds_the_form_urlencoded_redirect() {
        assert_eq!(
            resolve_body(&Value::Null, &Value::Null).to_string(),
            json!({"ok":true,"url":"/air"}).to_string()
        );
        let with_dir = resolve_body(&json!("tsk_1"), &json!("d 1/ä"));
        assert_eq!(
            with_dir.to_string(),
            json!({"ok":true,"taskId":"tsk_1","url":"/air?task=tsk_1&dir=d+1%2F%C3%A4"})
                .to_string()
        );
        let without_dir = resolve_body(&json!("tsk_1"), &json!(""));
        assert_eq!(
            without_dir.to_string(),
            json!({"ok":true,"taskId":"tsk_1","url":"/air?task=tsk_1"}).to_string()
        );
        // A repeated `?task=a&task=b` parses to an array; `URLSearchParams`
        // stringifies it with commas, and the echoed field stays an array.
        let repeated = resolve_body(&json!(["a", "b"]), &Value::Null);
        assert_eq!(
            repeated.to_string(),
            json!({"ok":true,"taskId":["a","b"],"url":"/air?task=a%2Cb"}).to_string()
        );
    }

    #[test]
    fn spread_ok_puts_ok_first_and_keeps_the_toggle_order() {
        let toggled = json!({"ignored":true,"kind":"error","taskIds":["t1"],"todos":[]});
        assert_eq!(
            spread_ok(&toggled).to_string(),
            json!({"ok":true,"ignored":true,"kind":"error","taskIds":["t1"],"todos":[]})
                .to_string()
        );
        assert_eq!(
            spread_ok(&Value::Null).to_string(),
            json!({"ok":true}).to_string()
        );
    }

    #[test]
    fn ok_field_wraps_in_declared_order() {
        assert_eq!(
            ok_field("taskIds", json!(["a"])).to_string(),
            json!({"ok":true,"taskIds":["a"]}).to_string()
        );
        assert_eq!(
            ok_field("publications", json!([])).to_string(),
            json!({"ok":true,"publications":[]}).to_string()
        );
    }
}
