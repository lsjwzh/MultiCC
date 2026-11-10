//! Pure native-context rotation planner.
//!
//! This is the former `rotateNativeContextUnsafe` business logic from
//! `src/routes/chat-history.js`: the host reads facts (session record, pending
//! handoff, run state, background task count, port availability), awaits the git
//! snapshot and builds the checkpoint, then this module decides. It performs no
//! I/O: the host executes the returned effect list in order.
//!
//! Two entries enforce the two-phase contract:
//! * `decision` runs before the git snapshot (cheap rejection / reuse);
//! * `commit` re-validates the same facts after the snapshot and only then
//!   assembles the handoff record. A turn that started, a session that vanished
//!   or a competing handoff that appeared during the await must never be
//!   rotated over.
use crate::js::JsValue;
use crate::quota_guard::{object, prop, set};

fn flag(input: &JsValue, key: &str) -> bool {
    matches!(prop(input, key), JsValue::Bool(true))
}

fn text(input: &JsValue, key: &str) -> String {
    match prop(input, key) {
        JsValue::String(value) => value.to_string_lossy(),
        _ => String::new(),
    }
}

fn count(input: &JsValue, key: &str) -> f64 {
    match prop(input, key) {
        JsValue::Number(value) if value.is_finite() => *value,
        _ => 0.0,
    }
}

fn is_chat(input: &JsValue) -> bool {
    match prop(input, "kind") {
        JsValue::String(kind) => kind.is_empty() || kind.as_str_lossy() == "chat",
        // `!persisted.kind` means "chat" for a record without a kind.
        value => value.is_nullish(),
    }
}

struct Pending {
    id: JsValue,
    manual: bool,
}

/// `pendingCliHandoff.status === 'pending'`.
fn pending(input: &JsValue) -> Option<Pending> {
    let entry = prop(input, "pending");
    if !matches!(entry, JsValue::Object(_)) {
        return None;
    }
    if text(entry, "status") != "pending" {
        return None;
    }
    let manual = matches!(prop(entry, "reason"), JsValue::String(reason)
        if reason.as_str_lossy() == "manual_native_context_rotate");
    Some(Pending {
        id: prop(entry, "id").clone(),
        manual,
    })
}

fn rotation_ready(input: &JsValue) -> bool {
    flag(input, "rotationReady")
}

/// `!rotationReady || ['queued','running','assessing'].includes(runState)`.
fn busy(input: &JsValue) -> bool {
    if !rotation_ready(input) {
        return true;
    }
    matches!(
        text(input, "runState").as_str(),
        "queued" | "running" | "assessing"
    )
}

fn blocked(input: &JsValue) -> Option<&'static str> {
    if busy(input) {
        return Some("session_busy");
    }
    if count(input, "backgroundCount") > 0.0 {
        return Some("background_tasks_running");
    }
    None
}

fn broadcast(event: JsValue) -> JsValue {
    object(vec![
        ("type", JsValue::string("broadcast")),
        ("event", event),
    ])
}

fn rejected(code: &str) -> JsValue {
    let event = object(vec![
        ("type", JsValue::string("native_context_rotation_rejected")),
        ("code", JsValue::string(code)),
    ]);
    object(vec![
        ("ok", JsValue::Bool(false)),
        ("code", JsValue::string(code)),
        ("effects", JsValue::Array(vec![broadcast(event)])),
    ])
}

fn reused(checkpoint_id: JsValue) -> JsValue {
    let event = object(vec![
        ("type", JsValue::string("native_context_rotated")),
        ("checkpointId", checkpoint_id.clone()),
        ("clearedNativeSessions", JsValue::Number(0.0)),
        ("historyPreserved", JsValue::Bool(true)),
        ("reused", JsValue::Bool(true)),
    ]);
    object(vec![
        ("ok", JsValue::Bool(true)),
        ("reused", JsValue::Bool(true)),
        ("checkpointId", checkpoint_id),
        ("clearedNativeSessions", JsValue::Number(0.0)),
        ("effects", JsValue::Array(vec![broadcast(event)])),
    ])
}

fn proceed() -> JsValue {
    object(vec![
        ("ok", JsValue::Bool(true)),
        ("action", JsValue::string("proceed")),
        ("effects", JsValue::Array(vec![])),
    ])
}

/// Cheap decision over a facts snapshot. Called twice: before the git snapshot
/// and again (by [`commit`]) after it. Order is observable and frozen:
/// existence, session kind, an existing pending handoff (reject or reuse), then
/// the busy gates.
pub fn decision(input: &JsValue) -> JsValue {
    if !flag(input, "exists") {
        return object(vec![
            ("ok", JsValue::Bool(false)),
            ("code", JsValue::string("session_not_found")),
            ("effects", JsValue::Array(vec![])),
        ]);
    }
    if !is_chat(input) {
        return object(vec![
            ("ok", JsValue::Bool(false)),
            ("code", JsValue::string("not_chat_session")),
            ("effects", JsValue::Array(vec![])),
        ]);
    }
    if let Some(existing) = pending(input) {
        if !existing.manual {
            return rejected("handoff_pending");
        }
        return reused(existing.id);
    }
    match blocked(input) {
        Some(code) => rejected(code),
        None => proceed(),
    }
}

fn effect(kind: &str) -> JsValue {
    object(vec![("type", JsValue::string(kind))])
}

fn mutate_effect() -> JsValue {
    object(vec![
        ("type", JsValue::string("mutate")),
        (
            "operation",
            JsValue::string("websocket.rotate-native-context"),
        ),
        (
            "steps",
            JsValue::Array(vec![
                JsValue::string("clearNativeCliStates"),
                JsValue::string("assignPendingCliHandoff"),
                JsValue::string("rememberActiveCliState"),
            ]),
        ),
    ])
}

fn handoff(input: &JsValue) -> JsValue {
    let cli = text(input, "cli");
    let random_hex = text(input, "randomHex");
    let id = format!("checkpoint_{random_hex}");
    let mut checkpoint = match prop(input, "checkpoint") {
        value @ JsValue::Object(_) => value.clone(),
        _ => object(vec![]),
    };
    set(
        &mut checkpoint,
        "reason",
        JsValue::string("manual_native_context_rotate"),
    );
    let created_at = prop(&checkpoint, "createdAt").clone();
    object(vec![
        ("id", JsValue::string(&id)),
        ("fromCli", JsValue::string(&cli)),
        ("toCli", JsValue::string(&cli)),
        ("createdAt", created_at),
        ("status", JsValue::string("pending")),
        ("reason", JsValue::string("manual_native_context_rotate")),
        ("reusedTarget", JsValue::Bool(false)),
        ("checkpoint", checkpoint),
    ])
}

/// Post-snapshot commit. Re-runs the same validation over the facts re-read
/// after the await (a session that vanished, turned into a non-chat record,
/// gained a pending handoff or started a turn is rejected instead of continuing
/// on stale facts), then assembles the handoff record and the ordered effect
/// list. The host resolves `clearedNativeSessions: null` with the value its
/// mutate wrapper returned.
pub fn commit(input: &JsValue) -> JsValue {
    let verdict = decision(input);
    if !flag(&verdict, "ok") || flag(&verdict, "reused") {
        return verdict;
    }
    let record = handoff(input);
    let checkpoint_id = text(&record, "id");
    let event = object(vec![
        ("type", JsValue::string("native_context_rotated")),
        ("checkpointId", JsValue::string(&checkpoint_id)),
        ("clearedNativeSessions", JsValue::Null),
        ("historyPreserved", JsValue::Bool(true)),
        ("reused", JsValue::Bool(false)),
    ]);
    object(vec![
        ("ok", JsValue::Bool(true)),
        ("reused", JsValue::Bool(false)),
        ("checkpointId", JsValue::string(&checkpoint_id)),
        ("handoff", record),
        (
            "effects",
            JsValue::Array(vec![
                mutate_effect(),
                effect("closeStream"),
                effect("zeroChatTurnCount"),
                broadcast(event),
            ]),
        ),
    ])
}

/// JSON-in/JSON-out entry used by the addon bridge.
pub fn request(op: &str, input: &str) -> Result<String, String> {
    let value =
        crate::js::json_parse(input).map_err(|error| format!("invalid rotation input: {error}"))?;
    let output = match op {
        "decision" => decision(&value),
        "commit" => commit(&value),
        _ => return Err(format!("unknown rotation operation: {op}")),
    };
    Ok(crate::js::json_stringify_or_undefined(&output))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::serde::{from_serde, to_serde};
    use serde_json::{json, Value};

    fn js(value: Value) -> JsValue {
        from_serde(&value)
    }

    fn facts(overrides: Value) -> JsValue {
        let mut base = json!({
            "exists": true,
            "kind": "chat",
            "pending": null,
            "rotationReady": true,
            "runState": "idle",
            "backgroundCount": 0,
        });
        if let (Some(target), Value::Object(source)) = (base.as_object_mut(), overrides) {
            for (key, value) in source {
                target.insert(key, value);
            }
        }
        js(base)
    }

    fn out(value: JsValue) -> Value {
        to_serde(&value)
    }

    #[test]
    fn decision_is_ordered_from_existence_to_the_busy_gates() {
        let missing = out(decision(&facts(json!({ "exists": false }))));
        assert_eq!(missing["code"], "session_not_found");
        assert_eq!(missing["effects"].as_array().unwrap().len(), 0);

        let other = out(decision(&facts(json!({ "kind": "task" }))));
        assert_eq!(other["code"], "not_chat_session");

        let pending = out(decision(&facts(json!({
            "pending": { "id": "cp-1", "status": "pending", "reason": "other" },
        }))));
        assert_eq!(pending["code"], "handoff_pending");
        assert_eq!(
            pending["effects"][0]["event"]["type"],
            "native_context_rotation_rejected"
        );

        let manual = out(decision(&facts(json!({
            "pending": { "id": "cp-2", "status": "pending", "reason": "manual_native_context_rotate" },
        }))));
        assert_eq!(manual["checkpointId"], "cp-2");
        assert_eq!(manual["reused"], true);
        assert_eq!(manual["effects"][0]["event"]["reused"], true);

        for state in ["queued", "running", "assessing"] {
            let busy = out(decision(&facts(json!({ "runState": state }))));
            assert_eq!(busy["code"], "session_busy", "{state}");
        }
        let background = out(decision(&facts(json!({ "backgroundCount": 2 }))));
        assert_eq!(background["code"], "background_tasks_running");
        let ready = out(decision(&facts(json!({ "rotationReady": false }))));
        assert_eq!(ready["code"], "session_busy");
        assert_eq!(out(decision(&facts(json!({})))), out(proceed()));
    }

    #[test]
    fn commit_revalidates_and_assembles_the_handoff() {
        let input = |overrides: Value| {
            let mut base = json!({
                "exists": true,
                "kind": "chat",
                "pending": null,
                "rotationReady": true,
                "runState": "idle",
                "backgroundCount": 0,
                "cli": "claude",
                "randomHex": "0707070707070707",
                "checkpoint": { "version": 1, "createdAt": "2026-11-11T00:00:00.000Z", "transcript": [] },
            });
            if let (Some(target), Value::Object(source)) = (base.as_object_mut(), overrides) {
                for (key, value) in source {
                    target.insert(key, value);
                }
            }
            js(base)
        };

        let ok = out(commit(&input(json!({}))));
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["handoff"]["id"], "checkpoint_0707070707070707");
        assert_eq!(ok["handoff"]["reason"], "manual_native_context_rotate");
        assert_eq!(
            ok["handoff"]["checkpoint"]["reason"],
            "manual_native_context_rotate"
        );
        assert_eq!(
            ok["handoff"]["checkpoint"]["createdAt"],
            "2026-11-11T00:00:00.000Z"
        );
        assert_eq!(ok["effects"][0]["type"], "mutate");
        assert_eq!(
            ok["effects"][0]["operation"],
            "websocket.rotate-native-context"
        );
        assert_eq!(ok["effects"][0]["steps"].as_array().unwrap().len(), 3);
        assert_eq!(ok["effects"][1]["type"], "closeStream");
        assert_eq!(ok["effects"][2]["type"], "zeroChatTurnCount");
        assert_eq!(
            ok["effects"][3]["event"]["clearedNativeSessions"],
            Value::Null
        );

        for (overrides, code, broadcasts) in [
            (json!({ "exists": false }), "session_not_found", false),
            (json!({ "kind": "task" }), "not_chat_session", false),
            (
                json!({ "pending": { "id": "x", "status": "pending", "reason": "other" } }),
                "handoff_pending",
                true,
            ),
            (json!({ "runState": "running" }), "session_busy", true),
            (
                json!({ "backgroundCount": 1 }),
                "background_tasks_running",
                true,
            ),
        ] {
            let rejected_out = out(commit(&input(overrides)));
            assert_eq!(rejected_out["ok"], false);
            assert_eq!(rejected_out["code"], code);
            let effects = rejected_out["effects"].as_array().unwrap();
            if broadcasts {
                assert_eq!(
                    effects[0]["event"]["type"], "native_context_rotation_rejected",
                    "{code}"
                );
            } else {
                assert_eq!(effects.len(), 0, "{code}");
            }
        }

        // A competing manual handoff that appeared during the snapshot reuses
        // the existing checkpoint instead of clearing native state twice.
        let raced = out(commit(&input(json!({
            "pending": { "id": "cp-race", "status": "pending", "reason": "manual_native_context_rotate" },
        }))));
        assert_eq!(raced["reused"], true);
        assert_eq!(raced["checkpointId"], "cp-race");
    }

    #[test]
    fn request_round_trips_json() {
        let input = json!({
            "exists": true, "kind": "chat", "pending": null,
            "rotationReady": true, "runState": "idle", "backgroundCount": 0,
        })
        .to_string();
        let parsed: Value = serde_json::from_str(&request("decision", &input).unwrap()).unwrap();
        assert_eq!(parsed["action"], "proceed");
        assert!(request("nope", &input).is_err());
        assert!(request("decision", "{").is_err());
    }
}
