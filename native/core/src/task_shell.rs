//! Rules kernel for the task-shell route cluster (`src/task-shell/routes.js`).
//!
//! Everything that is a *rule* over the Node runtime's answers lives here: the
//! error envelope (`ok:false` + `cleanError` + the conflict/detail/receipt
//! projections), the history pager (`pageTaskHistory`), the static discovery
//! and artifacts DTOs, and the `{ ok: true, … }` wrappers. Path matching,
//! parameter decoding and body-field extraction live in the front-door handler
//! (`native/gateway/src/app/task_shell.rs`), which owns the Express surface.
//!
//! Everything that needs the process-local world stays in Node behind the host
//! port (`src/routes/task-shell-host.js`): the SQLite task store, the
//! records Map, WebSocket clients, chat history and the runtime that turns a
//! request into those DTOs. The front door only ever sends `{ op, … }` and gets
//! the runtime value back; it never touches the store, a subprocess or a socket.
//!
//! Byte-for-byte parity is the contract: `express::json` serializes through the
//! V8-compatible `js_json_stringify`, so a value that round-trips through this
//! kernel keeps the exact key order and number spelling Node produced.

pub mod chat;
pub mod reference;

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::js::regex::{ascii_ci, SPACE};
use crate::js::serde::{js_string, truthy};
use crate::js::string::utf16_prefix;
use crate::session_git::parse_int10;

/// `cleanError` caps the code at 100 code units and the message at 4000.
pub const CODE_CAP: usize = 100;
pub const MESSAGE_CAP: usize = 4000;
/// `pageTaskHistory` clamps the page to 1..=100 with a default of 50.
pub const HISTORY_DEFAULT_LIMIT: i64 = 50;
pub const HISTORY_MAX_LIMIT: i64 = 100;

fn bearer_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(&format!(
            "((?:{})[{SPACE}]+)[^{SPACE}]+",
            ascii_ci("Bearer")
        ))
        .expect("bearer redaction regex")
    })
}

fn secret_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        let api_key = format!("{}[_-]?{}", ascii_ci("api"), ascii_ci("key"));
        Regex::new(&format!(
            "((?:{}|{}|{}|{})[{SPACE}]*[=:][{SPACE}]*)[^{SPACE},;]+",
            ascii_ci("token"),
            api_key,
            ascii_ci("password"),
            ascii_ci("secret"),
        ))
        .expect("secret redaction regex")
    })
}

/// `message.replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')` then the
/// `token|api[_-]?key|password|secret` rule, both over the same text.
pub fn redact_message(text: &str) -> String {
    let first = bearer_regex().replace_all(text, "${1}[redacted]");
    secret_regex()
        .replace_all(&first, "${1}[redacted]")
        .into_owned()
}

/// `cleanError(error)`: `{ code: String(error?.code || 'task_shell_failed')
/// .slice(0,100), message: String(error?.message || error).replace(…)
/// .slice(0,4000) }`. The caller resolves `String(error?.message || error)`
/// because only Node still holds the thrown object.
pub fn clean_error(code: Option<&str>, message_text: &str) -> (String, String) {
    let code = match code {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => "task_shell_failed".to_string(),
    };
    (
        utf16_prefix(&code, CODE_CAP),
        utf16_prefix(&redact_message(message_text), MESSAGE_CAP),
    )
}

/// `GET /api/task-shells/config`: discovery stays stable for cached clients.
pub fn config_body() -> Value {
    json!({ "enabled": true })
}

/// The empty artifacts answer for a shell that owns no task.
pub fn shell_artifacts_fallback() -> Value {
    json!({ "taskId": null, "title": "", "items": [] })
}

/// `{ ok: true, [key]: value }` in that key order (`task-operations`,
/// `attribution-decisions`, `task-continuations`, `relations`, separation).
pub fn ok_wrap(key: &str, value: Value) -> Value {
    let mut object = Map::new();
    object.insert("ok".into(), Value::Bool(true));
    object.insert(key.into(), value);
    Value::Object(object)
}

/// The query shapes `pageTaskHistory` reads (`req.query`).
#[derive(Default, Clone)]
pub struct PageOptions {
    pub limit: Option<Value>,
    pub around: Option<Value>,
    pub before: Option<Value>,
}

fn present(value: &Option<Value>) -> bool {
    value.as_ref().is_some_and(truthy)
}

fn page_limit(value: &Option<Value>) -> i64 {
    let parsed = value
        .as_ref()
        .and_then(|value| parse_int10(&js_string(value)));
    parsed
        .filter(|number| *number != 0)
        .unwrap_or(HISTORY_DEFAULT_LIMIT)
        .clamp(1, HISTORY_MAX_LIMIT)
}

fn matches_target(message: &Value, target: &Value) -> bool {
    let Value::String(text) = target else {
        return false;
    };
    message.get("id").and_then(Value::as_str) == Some(text.as_str())
        || message.get("sourceMessageId").and_then(Value::as_str) == Some(text.as_str())
}

/// `pageTaskHistory(rawMessages, options)`.
pub fn page_task_history(raw_messages: &Value, options: &PageOptions) -> Value {
    let empty: Vec<Value> = Vec::new();
    let messages = raw_messages.as_array().unwrap_or(&empty);
    let length = messages.len() as i64;
    let limit = page_limit(&options.limit);
    let around = present(&options.around);
    let before = present(&options.before);
    let target = if around {
        options.around.as_ref()
    } else if before {
        options.before.as_ref()
    } else {
        None
    };
    let cursor = match target {
        Some(target) => messages
            .iter()
            .position(|message| matches_target(message, target))
            .map_or(-1, |index| index as i64),
        None => -1,
    };
    if target.is_some() && cursor < 0 {
        return json!({ "messages": [], "hasMore": false, "found": false });
    }
    let end = if around {
        length.min(cursor + (limit + 1) / 2)
    } else if before {
        cursor
    } else {
        length
    };
    let start = 0.max(end - limit);
    let start_index = start as usize;
    let end_index = end.max(0) as usize;
    let page: Vec<Value> = messages
        .iter()
        .take(end_index)
        .skip(start_index)
        .cloned()
        .collect();
    let mut object = Map::new();
    object.insert("messages".into(), Value::Array(page));
    object.insert("hasMore".into(), Value::Bool(start > 0));
    if around {
        object.insert("found".into(), Value::Bool(true));
        object.insert("hasNewer".into(), Value::Bool(end < length));
    }
    Value::Object(object)
}

/// The thrown-error facts the host port hands back. `message` is already
/// `String(error?.message || error)`; `receiptId` is present only when truthy.
#[derive(Default, Clone)]
pub struct ErrorFacts {
    pub code: Option<String>,
    pub message: String,
    pub status: Option<i64>,
    pub conflicts: Option<Value>,
    pub detail: Option<Value>,
    pub receipt_id: Option<Value>,
    pub task_id: Option<Value>,
    pub not_delivered: bool,
}

/// The retired `route()` catch arm: status `error.status || 500`, then
/// `{ ok:false, ...cleanError(error), conflicts?, detail?, receiptId?, taskId?,
/// notDelivered? }` in that order.
pub fn error_body(facts: &ErrorFacts) -> (u16, Value) {
    let (code, message) = clean_error(facts.code.as_deref(), &facts.message);
    let mut object = Map::new();
    object.insert("ok".into(), Value::Bool(false));
    object.insert("code".into(), Value::String(code));
    object.insert("message".into(), Value::String(message));
    if let Some(conflicts) = &facts.conflicts {
        object.insert("conflicts".into(), conflicts.clone());
    }
    if let Some(detail) = &facts.detail {
        object.insert("detail".into(), detail.clone());
    }
    if let Some(receipt) = &facts.receipt_id {
        object.insert("receiptId".into(), receipt.clone());
        if let Some(task) = &facts.task_id {
            object.insert("taskId".into(), task.clone());
        }
        object.insert("notDelivered".into(), Value::Bool(facts.not_delivered));
    }
    let status = facts.status.filter(|value| *value > 0).unwrap_or(500);
    (status.clamp(100, 999) as u16, Value::Object(object))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn messages() -> Value {
        json!([
            {"id": "m0", "sourceMessageId": "s0", "text": "zero"},
            {"id": "m1", "sourceMessageId": "s1", "text": "one"},
            {"id": "m2", "sourceMessageId": "s2", "text": "two"},
            {"id": "m3", "sourceMessageId": "s3", "text": "three"},
            {"id": "m4", "sourceMessageId": "s4", "text": "four"},
        ])
    }

    #[test]
    fn latest_page_defaults_to_the_tail() {
        let page = page_task_history(&messages(), &PageOptions::default());
        assert_eq!(page["messages"].as_array().unwrap().len(), 5);
        assert_eq!(page["hasMore"], json!(false));
        assert_eq!(page.to_string(), "{\"messages\":[{\"id\":\"m0\",\"sourceMessageId\":\"s0\",\"text\":\"zero\"},{\"id\":\"m1\",\"sourceMessageId\":\"s1\",\"text\":\"one\"},{\"id\":\"m2\",\"sourceMessageId\":\"s2\",\"text\":\"two\"},{\"id\":\"m3\",\"sourceMessageId\":\"s3\",\"text\":\"three\"},{\"id\":\"m4\",\"sourceMessageId\":\"s4\",\"text\":\"four\"}],\"hasMore\":false}");
    }

    #[test]
    fn limit_is_clamped_and_zero_falls_back() {
        let options = PageOptions {
            limit: Some(json!("3")),
            ..Default::default()
        };
        let page = page_task_history(&messages(), &options);
        assert_eq!(page["messages"][0]["id"], json!("m2"));
        assert_eq!(page["hasMore"], json!(true));
        for limit in ["0", "abc"] {
            let options = PageOptions {
                limit: Some(json!(limit)),
                ..Default::default()
            };
            assert_eq!(
                page_task_history(&messages(), &options)["messages"]
                    .as_array()
                    .unwrap()
                    .len(),
                5
            );
        }
        // A negative limit is truthy, then clamped up to 1.
        let options = PageOptions {
            limit: Some(json!("-2")),
            ..Default::default()
        };
        assert_eq!(
            page_task_history(&messages(), &options)["messages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let options = PageOptions {
            limit: Some(json!("500")),
            ..Default::default()
        };
        assert_eq!(
            page_task_history(&messages(), &options)["messages"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
    }

    #[test]
    fn before_uses_the_cursor_and_adds_no_found_key() {
        let options = PageOptions {
            limit: Some(json!("2")),
            before: Some(json!("s3")),
            ..Default::default()
        };
        let page = page_task_history(&messages(), &options);
        assert_eq!(
            page.to_string(),
            "{\"messages\":[{\"id\":\"m1\",\"sourceMessageId\":\"s1\",\"text\":\"one\"},{\"id\":\"m2\",\"sourceMessageId\":\"s2\",\"text\":\"two\"}],\"hasMore\":true}"
        );
    }

    #[test]
    fn around_centers_and_reports_both_edges() {
        let options = PageOptions {
            limit: Some(json!("2")),
            around: Some(json!("m1")),
            ..Default::default()
        };
        let page = page_task_history(&messages(), &options);
        // cursor 1, end = min(5, 1 + ceil(2/2)) = 2, start = 0.
        assert_eq!(page["messages"][0]["id"], json!("m0"));
        assert_eq!(page["messages"][1]["id"], json!("m1"));
        assert_eq!(page["found"], json!(true));
        assert_eq!(page["hasNewer"], json!(true));
        assert_eq!(page["hasMore"], json!(false));
        // Key order: messages, hasMore, found, hasNewer.
        assert_eq!(
            page.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["messages", "hasMore", "found", "hasNewer"]
        );
    }

    #[test]
    fn a_missing_target_is_an_empty_not_found_page() {
        for options in [
            PageOptions {
                before: Some(json!("nope")),
                ..Default::default()
            },
            PageOptions {
                around: Some(json!("nope")),
                ..Default::default()
            },
        ] {
            assert_eq!(
                page_task_history(&messages(), &options).to_string(),
                "{\"messages\":[],\"hasMore\":false,\"found\":false}"
            );
        }
    }

    #[test]
    fn a_non_string_target_matches_nothing() {
        let options = PageOptions {
            before: Some(json!(["m1"])),
            ..Default::default()
        };
        assert_eq!(
            page_task_history(&messages(), &options)["messages"],
            json!([])
        );
    }

    #[test]
    fn non_array_input_is_an_empty_page() {
        let page = page_task_history(&json!({"nope": true}), &PageOptions::default());
        assert_eq!(page.to_string(), "{\"messages\":[],\"hasMore\":false}");
    }

    #[test]
    fn clean_error_defaults_and_slices() {
        assert_eq!(
            clean_error(None, "boom"),
            ("task_shell_failed".to_string(), "boom".to_string())
        );
        assert_eq!(clean_error(Some(""), "boom").0, "task_shell_failed");
        assert_eq!(clean_error(Some("invalid_input"), "x").0, "invalid_input");
        let long = "y".repeat(5000);
        assert_eq!(clean_error(Some("c"), &long).1.chars().count(), 4000);
        assert_eq!(clean_error(Some(&"z".repeat(200)), "m").0.len(), 100);
    }

    #[test]
    fn clean_error_redacts_bearer_and_secret_assignments() {
        let (_, message) = clean_error(
            None,
            "send Bearer abc.def now token=supersecret password: hunter2 api-key = k123; done",
        );
        assert_eq!(
            message,
            "send Bearer [redacted] now token=[redacted] password: [redacted] api-key = [redacted]; done"
        );
    }

    #[test]
    fn error_body_keeps_the_retired_order_and_status_tree() {
        let (status, body) = error_body(&ErrorFacts {
            code: Some("conflict".into()),
            message: "Conflict".into(),
            status: Some(409),
            conflicts: Some(json!(["a", "b"])),
            detail: Some(json!({"turns": 2})),
            receipt_id: Some(json!("r1")),
            task_id: Some(json!("t1")),
            not_delivered: true,
        });
        assert_eq!(status, 409);
        assert_eq!(
            body.to_string(),
            "{\"ok\":false,\"code\":\"conflict\",\"message\":\"Conflict\",\"conflicts\":[\"a\",\"b\"],\"detail\":{\"turns\":2},\"receiptId\":\"r1\",\"taskId\":\"t1\",\"notDelivered\":true}"
        );
        let (status, body) = error_body(&ErrorFacts::default());
        assert_eq!(status, 500);
        assert_eq!(
            body.to_string(),
            "{\"ok\":false,\"code\":\"task_shell_failed\",\"message\":\"\"}"
        );
        // A receipt without a taskId omits the key (JS `undefined`).
        let (_, body) = error_body(&ErrorFacts {
            receipt_id: Some(json!("r1")),
            not_delivered: false,
            message: "m".into(),
            ..Default::default()
        });
        assert_eq!(
            body.to_string(),
            "{\"ok\":false,\"code\":\"task_shell_failed\",\"message\":\"m\",\"receiptId\":\"r1\",\"notDelivered\":false}"
        );
        // A zero/absent status is the 500 fallback.
        assert_eq!(
            error_body(&ErrorFacts {
                status: Some(0),
                ..Default::default()
            })
            .0,
            500
        );
    }

    #[test]
    fn static_and_wrapped_dtos_keep_their_keys() {
        assert_eq!(config_body().to_string(), "{\"enabled\":true}");
        assert_eq!(
            shell_artifacts_fallback().to_string(),
            "{\"taskId\":null,\"title\":\"\",\"items\":[]}"
        );
        assert_eq!(
            ok_wrap("operations", json!([])).to_string(),
            "{\"ok\":true,\"operations\":[]}"
        );
    }
}
