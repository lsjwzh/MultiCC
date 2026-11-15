//! Rules kernel for the task-surface route cluster retired from
//! `src/routes/task-planning.js`, `src/routes/task-board.js`,
//! `src/routes/task-search.js`, `src/routes/task-goal.js`,
//! `src/routes/task-graph.js` and `src/task-shell/attribution-settings.js`:
//!
//! * `POST   /api/task-board/tasks`
//! * `POST   /api/task-board/tasks/:taskId/update` (`/planning` is an alias)
//! * `POST   /api/task-board/tasks/:taskId/title`
//! * `POST   /api/task-board/tasks/:taskId/move`
//! * `GET    /api/task-board/directories/:dirId/retention`
//! * `POST   /api/task-board/directories/:dirId/retention`
//! * `POST   /api/task-board/tasks/:taskId/status`
//! * `DELETE /api/task-board/tasks/:taskId`
//! * `POST   /api/task-board/tasks/:taskId/relocate`
//! * `POST   /api/task-board/tasks/:taskId/chat-session`
//! * `GET    /api/task-board/search`
//! * `GET    /api/search/messages`
//! * `POST   /api/air/tasks/mark-achieved`
//! * `GET    /api/task-graph`
//! * `GET    /api/settings/task-attribution`
//!
//! The board, the task-shell store, the chat records, the message index and
//! every mutation pipeline stay behind one host port
//! (`src/routes/task-routes-host.js`). What lives here is every rule that can
//! be decided from values: query parsing and its limits, the planning
//! error→status ladder, the retention ordering (reusing
//! [`crate::task_domain::retention`]), the response envelopes and their key
//! order, the mark-achieved eligibility ladder and the attribution catalog.

use serde_json::{json, Value};

use crate::js::number::js_string_to_number;
use crate::js::serde::{js_trim, utf16_len, value_or_empty};
use crate::task_domain::host::Facts;
use crate::task_domain::retention;
use crate::task_routing::{DEFAULT_MODE, MODES};

/// `src/routes/task-search.js` MAX_QUERY_CHARS.
pub const MAX_QUERY_CHARS: usize = 200;
/// `src/routes/task-search.js` DEFAULT_LIMIT.
pub const DEFAULT_LIMIT: i64 = 20;
/// `src/routes/task-search.js` MAX_LIMIT.
pub const MAX_LIMIT: i64 = 50;
/// `src/routes/task-search.js` MAX_FILTER_CHARS.
pub const MAX_FILTER_CHARS: usize = 200;

/// `GOAL_STATES.interact` (`src/classify/vocab.js`).
pub const GOAL_INTERACT: &str = "interact";
/// `GOAL_STATES.achieved`.
pub const GOAL_ACHIEVED: &str = "achieved";
/// `isTerminalLetter()` is exactly `cls === 'D'`.
pub const TERMINAL_CLASSIFY: &str = "D";

/// `Number.parseInt(text, 10)`: leading JS whitespace, one optional sign, then
/// digits; stops at the first non-digit. `None` is NaN.
pub fn parse_int(text: &str) -> Option<i64> {
    let rest = js_trim(text);
    let (negative, digits) = match rest.as_bytes().first() {
        Some(b'-') => (true, &rest[1..]),
        Some(b'+') => (false, &rest[1..]),
        _ => (false, rest),
    };
    let end = digits
        .bytes()
        .position(|byte| !byte.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let magnitude: f64 = digits[..end].parse().unwrap_or(f64::INFINITY);
    let value = if negative { -magnitude } else { magnitude };
    Some(value as i64)
}

/// `clampLimit()`: a missing/non-positive value is the default, never above the
/// maximum.
pub fn clamp_limit(text: &str) -> i64 {
    match parse_int(text) {
        Some(parsed) if parsed > 0 => parsed.min(MAX_LIMIT),
        _ => DEFAULT_LIMIT,
    }
}

/// `csv()`: split on commas, trim each item, drop empties; `None` when nothing
/// survives.
pub fn csv(value: &str) -> Option<Vec<String>> {
    let list: Vec<String> = value
        .split(',')
        .map(|item| js_trim(item).to_string())
        .filter(|item| !item.is_empty())
        .collect();
    (!list.is_empty()).then_some(list)
}

/// `Number(value) || 0`: `NaN` and `-0`/`0` are falsy and become `0`, while an
/// explicit `?minScore=Infinity` stays infinite (JSON renders it as `null`, the
/// same as `JSON.stringify`).
pub fn min_score(value: &str) -> f64 {
    let number = js_string_to_number(value);
    if number.is_nan() || number == 0.0 {
        0.0
    } else {
        number
    }
}

/// `query.length > MAX_QUERY_CHARS` — JS strings are UTF-16 code units.
pub fn query_too_long(query: &str) -> bool {
    utf16_len(query) > MAX_QUERY_CHARS
}

/// `dirId.length > MAX_FILTER_CHARS || taskId.length > MAX_FILTER_CHARS`.
pub fn filter_too_long(value: &str) -> bool {
    utf16_len(value) > MAX_FILTER_CHARS
}

/// `responseStatus()` from `src/routes/task-planning.js`, plus the one extra
/// planning code the front door now maps instead of passing a rendered body
/// through (there is none today: `directory_not_found` keeps its own 409 body
/// on the host side).
pub fn planning_status(code: &str) -> u16 {
    match code {
        "task_not_found" => 404,
        "persistence_failed" => 500,
        "revision_conflict"
        | "task_not_planned"
        | "task_archived"
        | "task_deleting"
        | "task_exists"
        | "move_anchor_not_found"
        | "invalid_move_anchor_order"
        | "invalid_move_anchor"
        | "record_type_immutable" => 409,
        _ => 400,
    }
}

/// `success(res, task)` from the planning runtime.
pub fn planning_ok(task: &Value, revision: &Value) -> Value {
    json!({ "ok": true, "task": task, "revision": revision })
}

/// `{ error: 'invalid_status' }` — the status route's first gate.
pub fn invalid_status() -> Value {
    json!({ "error": "invalid_status" })
}

/// `['active', 'done', 'archived'].includes(req.body?.status)`.
pub fn status_allowed(body: &Value) -> bool {
    let status = value_or_empty(body.get("status"));
    matches!(status.as_str(), "active" | "done" | "archived")
}

/// `{ ok: true, query: '', count: 0, results: [] }` — answered before the board
/// is read.
pub fn empty_search() -> Value {
    json!({ "ok": true, "query": "", "count": 0, "results": [] })
}

/// `res.json({ ok: true, query, count: results.length, results })`.
pub fn search_ok(query: &str, results: &Value) -> Value {
    let count = results.as_array().map(Vec::len).unwrap_or(0);
    json!({ "ok": true, "query": query, "count": count, "results": results })
}

/// `{ ok: true, query: '', count: 0, results: [], warming }` — the message
/// corpus answers an empty query after the index has been resolved, so unlike
/// [`empty_search`] it carries `warming`.
pub fn empty_message_search(warming: bool) -> Value {
    json!({ "ok": true, "query": "", "count": 0, "results": [], "warming": warming })
}

/// `res.json({ ok: true, query, count, mode: 'message', warming, results })`.
pub fn message_search_ok(query: &str, warming: bool, results: &Value) -> Value {
    let count = results.as_array().map(Vec::len).unwrap_or(0);
    json!({
        "ok": true,
        "query": query,
        "count": count,
        "mode": "message",
        "warming": warming,
        "results": results,
    })
}

/// `{ error: 'query_too_long', maxLength: 200 }`.
pub fn query_too_long_body() -> Value {
    json!({ "error": "query_too_long", "maxLength": MAX_QUERY_CHARS })
}

/// `{ error: 'filter_too_long', maxLength: 200 }`.
pub fn filter_too_long_body() -> Value {
    json!({ "error": "filter_too_long", "maxLength": MAX_FILTER_CHARS })
}

/// `{ error: 'task_not_found' }` as the individual handlers write it.
pub fn task_not_found() -> Value {
    json!({ "error": "task_not_found" })
}

/// The retention ordering rule, reusing [`retention::sort_entries`]: ascending
/// `lastInteractionAt`, ties broken by the host's `localeCompare` order.
pub fn sort_retention(entries: &mut [Value], id_order: &Value) {
    let facts = Facts::of(&json!({ "idOrder": id_order }));
    retention::sort_entries(entries, facts.host());
}

/// `res.json({ ok: true, limit, count, maxBatch, tasks })` from a preview.
/// `entries` are `{ id, title, at }` rows; the front door re-sorts them with the
/// shared retention comparator before projecting `tasks.lastInteractionAt`.
pub fn retention_preview(
    entries: &mut [Value],
    id_order: &Value,
    limit: &Value,
    count: &Value,
    max_batch: &Value,
) -> Value {
    sort_retention(entries, id_order);
    let tasks: Vec<Value> = entries
        .iter()
        .map(|entry| {
            json!({
                "id": entry.get("id").cloned().unwrap_or(Value::Null),
                "title": entry.get("title").cloned().unwrap_or(Value::Null),
                "lastInteractionAt": entry.get("at").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    json!({
        "ok": true,
        "limit": limit,
        "count": count,
        "maxBatch": max_batch,
        "tasks": tasks,
    })
}

/// `res.json({ ok: true, deleted, skipped, count, limit })`.
pub fn retention_delete(deleted: &Value, skipped: &Value, count: &Value, limit: &Value) -> Value {
    json!({
        "ok": true,
        "deleted": deleted,
        "skipped": skipped,
        "count": count,
        "limit": limit,
    })
}

/// `data.meta.durationMs = deps.now() - startedAt` then `res.json(data)`.
pub fn task_graph_body(mut graph: Value, duration_ms: i64) -> Value {
    if let Some(meta) = graph.get_mut("meta").and_then(Value::as_object_mut) {
        meta.insert("durationMs".into(), json!(duration_ms));
    }
    graph
}

/// `res.json({ mode, modes: [...MODES], default: DEFAULT_MODE })`.
pub fn attribution_body(mode: &Value) -> Value {
    json!({
        "mode": mode,
        "modes": MODES,
        "default": DEFAULT_MODE,
    })
}

/// The three facts `resolveExecution()` plus the record state expose to the
/// eligibility ladder.
#[derive(Debug, Default)]
pub struct MarkFacts {
    pub found: bool,
    pub goal_state: String,
    pub classify_state: String,
    pub streaming: bool,
    pub session_id: String,
}

impl MarkFacts {
    pub fn from_value(value: &Value) -> Self {
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        Self {
            found: value.get("found") == Some(&Value::Bool(true)),
            goal_state: text("goalState"),
            classify_state: text("classifyState"),
            streaming: value.get("streaming") == Some(&Value::Bool(true)),
            session_id: text("sessionId"),
        }
    }
}

/// The retired `fail(status, code, message)` for `POST /api/air/tasks/mark-achieved`.
/// The status is the caller's to send; the body never carries it.
pub fn mark_achieved_failure(_status: u16, code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

/// Eligibility ladder, in the order the retired handler checked it:
/// not found → not interact / not D → streaming. `Some` is the refusal to send
/// (status + body); `None` means "write it".
pub fn mark_achieved_refusal(facts: &MarkFacts) -> Option<(u16, Value)> {
    if !facts.found {
        return Some((
            404,
            mark_achieved_failure(404, "task_not_found", "任务不存在"),
        ));
    }
    if facts.goal_state != GOAL_INTERACT || facts.classify_state != TERMINAL_CLASSIFY {
        return Some((
            409,
            mark_achieved_failure(
                409,
                "mark_achieved_not_applicable",
                "只有需要交互的任务才能标记达成目标",
            ),
        ));
    }
    if facts.streaming {
        return Some((
            409,
            mark_achieved_failure(409, "task_streaming", "任务正在执行，无法标记达成目标"),
        ));
    }
    None
}

/// `{ ok: true, taskId, goalState: 'achieved' }`.
pub fn mark_achieved_ok(task_id: &str) -> Value {
    json!({ "ok": true, "taskId": task_id, "goalState": GOAL_ACHIEVED })
}

/// `fail(400, 'task_id_required', 'taskId is required')`.
pub fn task_id_required() -> Value {
    mark_achieved_failure(400, "task_id_required", "taskId is required")
}

/// `fail(501, 'task_state_unavailable', 'task state writes unavailable')`.
pub fn task_state_unavailable() -> Value {
    mark_achieved_failure(
        501,
        "task_state_unavailable",
        "task state writes unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_int_matches_number_parse_int() {
        assert_eq!(parse_int("12"), Some(12));
        assert_eq!(parse_int("  12abc"), Some(12));
        assert_eq!(parse_int("-7"), Some(-7));
        assert_eq!(parse_int("+3"), Some(3));
        assert_eq!(parse_int(""), None);
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int("12.9"), Some(12));
        assert_eq!(parse_int("0x10"), Some(0));
    }

    #[test]
    fn clamp_limit_defaults_and_caps() {
        assert_eq!(clamp_limit(""), DEFAULT_LIMIT);
        assert_eq!(clamp_limit("0"), DEFAULT_LIMIT);
        assert_eq!(clamp_limit("-4"), DEFAULT_LIMIT);
        assert_eq!(clamp_limit("nope"), DEFAULT_LIMIT);
        assert_eq!(clamp_limit("3"), 3);
        assert_eq!(clamp_limit("999"), MAX_LIMIT);
    }

    #[test]
    fn csv_keeps_the_order_and_drops_empties() {
        assert_eq!(
            csv("a, b ,,c"),
            Some(vec!["a".into(), "b".into(), "c".into()])
        );
        assert_eq!(csv(" , "), None);
        assert_eq!(csv(""), None);
        assert_eq!(csv("a"), Some(vec!["a".into()]));
    }

    #[test]
    fn min_score_follows_number_or_zero() {
        assert_eq!(min_score(""), 0.0);
        assert_eq!(min_score("abc"), 0.0);
        assert_eq!(min_score("2.5"), 2.5);
        assert_eq!(min_score("-1"), -1.0);
        assert_eq!(min_score("0"), 0.0);
        assert_eq!(min_score("Infinity"), f64::INFINITY);
        assert_eq!(min_score("-Infinity"), f64::NEG_INFINITY);
    }

    #[test]
    fn query_and_filter_lengths_count_utf16_units() {
        let ok = "a".repeat(MAX_QUERY_CHARS);
        assert!(!query_too_long(&ok));
        assert!(query_too_long(&format!("{ok}b")));
        // An emoji is two UTF-16 code units; 101 of them overflow the limit.
        assert!(query_too_long(&"😀".repeat(101)));
        assert!(!query_too_long(&"😀".repeat(100)));
        let filter = "x".repeat(MAX_FILTER_CHARS + 1);
        assert!(filter_too_long(&filter));
        assert!(!filter_too_long(&"x".repeat(MAX_FILTER_CHARS)));
    }

    #[test]
    fn planning_status_is_the_retired_response_status() {
        assert_eq!(planning_status("task_not_found"), 404);
        assert_eq!(planning_status("persistence_failed"), 500);
        for code in [
            "revision_conflict",
            "task_not_planned",
            "task_archived",
            "task_deleting",
            "task_exists",
            "move_anchor_not_found",
            "invalid_move_anchor_order",
            "invalid_move_anchor",
            "record_type_immutable",
        ] {
            assert_eq!(planning_status(code), 409, "{code}");
        }
        assert_eq!(planning_status("invalid_move_position"), 400);
        assert_eq!(planning_status(""), 400);
    }

    #[test]
    fn planning_success_keeps_the_retired_key_order() {
        let body = planning_ok(&json!({"id": "t1"}), &json!(7));
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["ok", "task", "revision"]);
        assert_eq!(body["revision"], json!(7));
    }

    #[test]
    fn status_allowed_mirrors_the_includes_check() {
        assert!(status_allowed(&json!({"status": "active"})));
        assert!(status_allowed(&json!({"status": "done"})));
        assert!(status_allowed(&json!({"status": "archived"})));
        assert!(!status_allowed(&json!({"status": "ACTIVE"})));
        assert!(!status_allowed(&json!({"status": 1})));
        // `String(['active'])` is 'active', so an array of one still passes.
        assert!(status_allowed(&json!({"status": ["active"]})));
        assert!(!status_allowed(&json!({"status": ["active", "done"]})));
        assert!(!status_allowed(&json!({"status": {"a": "active"}})));
        assert!(!status_allowed(&json!({})));
        assert!(!status_allowed(&Value::Null));
        assert_eq!(invalid_status(), json!({"error": "invalid_status"}));
    }

    #[test]
    fn search_envelopes_match_the_route() {
        assert_eq!(
            empty_search(),
            json!({"ok": true, "query": "", "count": 0, "results": []})
        );
        let results = json!([{"taskId": "t1"}, {"taskId": "t2"}]);
        let body = search_ok("plan", &results);
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["ok", "query", "count", "results"]);
        assert_eq!(body["count"], json!(2));
        assert_eq!(body["query"], json!("plan"));
        assert_eq!(
            query_too_long_body(),
            json!({"error": "query_too_long", "maxLength": 200})
        );
        assert_eq!(
            filter_too_long_body(),
            json!({"error": "filter_too_long", "maxLength": 200})
        );
    }

    #[test]
    fn retention_preview_sorts_and_projects_in_key_order() {
        let mut entries = vec![
            json!({"id": "b", "title": "B", "at": 20.0}),
            json!({"id": "a", "title": "A", "at": 20.0}),
            json!({"id": "c", "title": "C", "at": 10.0}),
        ];
        let body = retention_preview(
            &mut entries,
            &json!(["a", "b", "c"]),
            &json!(500),
            &json!(7),
            &json!(100),
        );
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["ok", "limit", "count", "maxBatch", "tasks"]);
        let ids: Vec<&str> = body["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|task| task["id"].as_str().unwrap())
            .collect();
        // 10 first, then the 20-tie broken by the host's localeCompare order.
        assert_eq!(ids, vec!["c", "a", "b"]);
        let task_keys: Vec<&str> = body["tasks"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(task_keys, vec!["id", "title", "lastInteractionAt"]);
    }

    #[test]
    fn retention_delete_keeps_the_retired_shape() {
        let body = retention_delete(
            &json!(["t1"]),
            &json!([{"id": "t2", "reason": "no_longer_eligible"}]),
            &json!(3),
            &json!(500),
        );
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["ok", "deleted", "skipped", "count", "limit"]);
        assert_eq!(body["deleted"], json!(["t1"]));
    }

    #[test]
    fn graph_body_appends_duration_inside_meta() {
        let graph = json!({
            "nodes": [],
            "edges": [],
            "meta": {"dirId": "all", "projects": [], "maxNodes": 800},
        });
        let body = task_graph_body(graph, 4);
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["nodes", "edges", "meta"]);
        let meta: Vec<&str> = body["meta"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(meta, vec!["dirId", "projects", "maxNodes", "durationMs"]);
        assert_eq!(body["meta"]["durationMs"], json!(4));
    }

    #[test]
    fn attribution_body_uses_the_rust_catalog() {
        let body = attribution_body(&json!("auto"));
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["mode", "modes", "default"]);
        assert_eq!(body["modes"], json!(["off", "shadow", "suggest", "auto"]));
        assert_eq!(body["default"], json!("suggest"));
    }

    #[test]
    fn mark_achieved_ladder_follows_the_retired_order() {
        let missing = MarkFacts::default();
        let (status, refusal) = mark_achieved_refusal(&missing).unwrap();
        assert_eq!(status, 404);
        assert_eq!(refusal["code"], json!("task_not_found"));

        let done = MarkFacts {
            found: true,
            goal_state: "achieved".into(),
            classify_state: "D".into(),
            ..MarkFacts::default()
        };
        assert_eq!(
            mark_achieved_refusal(&done).unwrap().1["code"],
            json!("mark_achieved_not_applicable")
        );

        let not_terminal = MarkFacts {
            found: true,
            goal_state: GOAL_INTERACT.into(),
            classify_state: "W".into(),
            ..MarkFacts::default()
        };
        assert_eq!(
            mark_achieved_refusal(&not_terminal).unwrap().1["code"],
            json!("mark_achieved_not_applicable")
        );

        let streaming = MarkFacts {
            found: true,
            goal_state: GOAL_INTERACT.into(),
            classify_state: "D".into(),
            streaming: true,
            ..MarkFacts::default()
        };
        let (status, refusal) = mark_achieved_refusal(&streaming).unwrap();
        assert_eq!(status, 409);
        assert_eq!(refusal["code"], json!("task_streaming"));

        let ready = MarkFacts {
            found: true,
            goal_state: GOAL_INTERACT.into(),
            classify_state: "D".into(),
            session_id: "s1".into(),
            ..MarkFacts::default()
        };
        assert!(mark_achieved_refusal(&ready).is_none());
        let ok = mark_achieved_ok("t1");
        let keys: Vec<&str> = ok.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["ok", "taskId", "goalState"]);
        assert_eq!(ok["goalState"], json!("achieved"));
    }

    #[test]
    fn mark_achieved_failures_keep_the_envelope_and_messages() {
        assert_eq!(
            task_id_required(),
            json!({"ok": false, "code": "task_id_required", "message": "taskId is required"})
        );
        assert_eq!(
            task_state_unavailable(),
            json!({"ok": false, "code": "task_state_unavailable", "message": "task state writes unavailable"})
        );
        let not_found = task_not_found();
        let keys: Vec<&str> = not_found
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["error"]);
        let refusal =
            mark_achieved_failure(409, "task_streaming", "任务正在执行，无法标记达成目标");
        let keys: Vec<&str> = refusal
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["ok", "code", "message"]);
    }
}
