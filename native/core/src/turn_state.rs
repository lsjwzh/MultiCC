//! Turn state — the deterministic P/D/W/B/E projection of structured runtime
//! facts, migrated verbatim from `src/classify/turn-state.js`. Aux is
//! deliberately absent: naming/grouping may degrade when the model is down,
//! but the scheduler must still receive one verdict per turn.
//!
//! The JS module keeps its export surface (`resolveTurnState`,
//! `ABNORMAL_BOUNDARIES`) and forwards here. Old JS semantics are kept exactly:
//! `liveness` must be a non-null object (arrays included), `reason` is returned
//! as-is when truthy (any type), `boundary` is `String(boundary || default)`,
//! and an unmapped boundary fails closed to E.
use serde_json::{json, Value};

/// Finalization boundaries that always end a turn as E.
pub const ABNORMAL_BOUNDARIES: [&str; 5] = [
    "api-error",
    "interrupted",
    "unknown-interruption",
    "result-not-durable",
    "handoff-resume-failed",
];

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn format_number(number: &serde_json::Number) -> String {
    if let Some(integer) = number.as_i64() {
        return integer.to_string();
    }
    if let Some(integer) = number.as_u64() {
        return integer.to_string();
    }
    let float = number.as_f64().unwrap_or(f64::NAN);
    if float == 0.0 {
        return "0".to_string();
    }
    let mut buffer = ryu_js::Buffer::new();
    buffer.format_finite(float).to_string()
}

/// `String(value)` for JSON values (array holes arrive as null).
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => format_number(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn field<'a>(container: &'a Value, key: &str) -> Option<&'a Value> {
    container.as_object().and_then(|object| object.get(key))
}

fn is_true(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

fn verdict(state: &str, evidence: Value) -> Value {
    json!({ "state": state, "evidence": evidence })
}

/// `liveness.reason || fallback`: a truthy reason of any type wins.
fn reason_or(liveness: &Value, fallback: &str) -> Value {
    match field(liveness, "reason") {
        Some(reason) if truthy(reason) => reason.clone(),
        _ => Value::String(fallback.to_string()),
    }
}

/// `resolveTurnState(input)`. A non-object input reads as `{}`.
pub fn resolve(input: &Value) -> Value {
    let unavailable = json!({ "state": "unknown", "reason": "liveness_unavailable" });
    // `input.liveness && typeof input.liveness === 'object'`
    let liveness = match field(input, "liveness") {
        Some(value @ (Value::Object(_) | Value::Array(_))) => value,
        _ => &unavailable,
    };
    let boundary = match field(input, "boundary") {
        Some(value) if truthy(value) => js_string(value),
        _ => "unknown-interruption".to_string(),
    };

    // A live owned runner is always processing. Close-time candidates are held
    // until ownership is inactive, preventing a stale finalizer from ending a
    // replacement/retry turn.
    match field(liveness, "state").and_then(Value::as_str) {
        Some("active") => return verdict("P", reason_or(liveness, "owned_runner_active")),
        Some("unknown") => return verdict("P", reason_or(liveness, "liveness_unknown")),
        _ => {}
    }

    // Explicit tool evidence beats a clean process close: the turn ended, but
    // it ended by handing control to the user.
    if is_true(field(input, "pendingUserInput")) {
        return verdict("W", json!("request_user_input"));
    }
    if is_true(field(input, "backgroundPending")) || boundary == "background-pending" {
        return verdict("B", json!("background_pending"));
    }
    if boundary == "succeeded" || boundary == "completed" {
        let gateway = field(input, "sessionType").and_then(Value::as_str) == Some("gateway");
        return verdict(
            "D",
            json!(if gateway {
                "gateway_turn_succeeded"
            } else {
                "turn_succeeded"
            }),
        );
    }
    if ABNORMAL_BOUNDARIES.contains(&boundary.as_str()) {
        let evidence = if boundary == "api-error" {
            "api_error_policy".to_string()
        } else {
            boundary.replace('-', "_")
        };
        return verdict("E", json!(evidence));
    }

    // Unknown boundary values are abnormal, never success. A new adapter event
    // fails closed until it is explicitly mapped above.
    verdict("E", json!("unknown_turn_boundary"))
}

/// String-in/string-out entry for the addon. Lenient at the JS boundary.
pub fn resolve_json(input: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|e| format!("turn_state_invalid_input: {e}"))?;
    Ok(resolve(&value).to_string())
}

/// Constant tables; `src/classify/turn-state.js` snapshots this at load.
pub fn catalog() -> Result<String, String> {
    Ok(json!({ "abnormalBoundaries": ABNORMAL_BOUNDARIES }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: Value) -> Value {
        resolve(&input)
    }
    fn inactive() -> Value {
        json!({ "state": "inactive", "reason": "runner_closed" })
    }

    #[test]
    fn complete_vocabulary_without_aux() {
        assert_eq!(
            run(
                json!({ "liveness": { "state": "active", "reason": "owned" }, "boundary": "succeeded" })
            ),
            json!({ "state": "P", "evidence": "owned" })
        );
        assert_eq!(
            run(json!({ "liveness": inactive(), "boundary": "succeeded" }))["state"],
            "D"
        );
        assert_eq!(
            run(
                json!({ "liveness": inactive(), "boundary": "succeeded", "pendingUserInput": true })
            )["state"],
            "W"
        );
        assert_eq!(
            run(
                json!({ "liveness": inactive(), "boundary": "succeeded", "backgroundPending": true })
            )["state"],
            "B"
        );
        assert_eq!(
            run(json!({ "liveness": inactive(), "boundary": "api-error" })),
            json!({ "state": "E", "evidence": "api_error_policy" })
        );
    }

    #[test]
    fn abnormal_boundaries_and_unknown_fail_closed() {
        for boundary in [
            "interrupted",
            "unknown-interruption",
            "result-not-durable",
            "handoff-resume-failed",
        ] {
            let out = run(json!({ "liveness": inactive(), "boundary": boundary }));
            assert_eq!(out["state"], "E");
            assert_eq!(out["evidence"], boundary.replace('-', "_"));
        }
        assert_eq!(
            run(json!({ "liveness": inactive(), "boundary": "future-adapter-ending" })),
            json!({ "state": "E", "evidence": "unknown_turn_boundary" })
        );
    }

    #[test]
    fn gateway_and_legacy_completed() {
        assert_eq!(
            run(
                json!({ "liveness": inactive(), "boundary": "succeeded", "sessionType": "gateway" })
            ),
            json!({ "state": "D", "evidence": "gateway_turn_succeeded" })
        );
        assert_eq!(
            run(json!({ "liveness": inactive(), "boundary": "completed" }))["evidence"],
            "turn_succeeded"
        );
    }

    #[test]
    fn liveness_defaults_and_reason_passthrough() {
        // Missing / null / non-object liveness reads as unknown -> P.
        assert_eq!(
            run(json!({})),
            json!({ "state": "P", "evidence": "liveness_unavailable" })
        );
        assert_eq!(
            run(json!({ "liveness": null }))["evidence"],
            "liveness_unavailable"
        );
        assert_eq!(
            run(json!({ "liveness": "active" }))["evidence"],
            "liveness_unavailable"
        );
        // Unknown state without reason uses the fallback evidence.
        assert_eq!(
            run(json!({ "liveness": { "state": "unknown" } }))["evidence"],
            "liveness_unknown"
        );
        assert_eq!(
            run(json!({ "liveness": { "state": "active", "reason": "" } }))["evidence"],
            "owned_runner_active"
        );
        // A truthy non-string reason is returned as-is (JS `||`).
        assert_eq!(
            run(json!({ "liveness": { "state": "active", "reason": 7 } }))["evidence"],
            7
        );
        // Arrays are objects in JS: accepted, but carry no state.
        assert_eq!(
            run(json!({ "liveness": [], "boundary": "succeeded" }))["state"],
            "D"
        );
        // Non-object input reads as {}.
        assert_eq!(run(Value::Null)["evidence"], "liveness_unavailable");
    }

    #[test]
    fn boundary_coercion_matches_js_string() {
        // Falsy boundary falls back to unknown-interruption.
        for falsy in [json!(""), json!(0), json!(false), Value::Null] {
            assert_eq!(
                run(json!({ "liveness": inactive(), "boundary": falsy }))["evidence"],
                "unknown_interruption"
            );
        }
        // String(['succeeded']) === 'succeeded' in JS.
        assert_eq!(
            run(json!({ "liveness": inactive(), "boundary": ["succeeded"] }))["state"],
            "D"
        );
        assert_eq!(
            run(json!({ "liveness": inactive(), "boundary": 5 }))["evidence"],
            "unknown_turn_boundary"
        );
        assert_eq!(
            run(json!({ "liveness": inactive(), "boundary": "background-pending" })),
            json!({ "state": "B", "evidence": "background_pending" })
        );
        // Only strict `true` counts for the tool-evidence flags.
        assert_eq!(
            run(json!({ "liveness": inactive(), "boundary": "succeeded", "pendingUserInput": 1 }))
                ["state"],
            "D"
        );
    }

    #[test]
    fn lenient_entry_and_catalog() {
        let raw = r#"{"liveness":{"state":"active","reason":"\ud834x"},"boundary":"succeeded"}"#;
        let out: Value = serde_json::from_str(&resolve_json(raw).unwrap()).unwrap();
        assert_eq!(out["state"], "P");
        assert_eq!(out["evidence"], "\u{fffd}x");
        let catalog: Value = serde_json::from_str(&catalog().unwrap()).unwrap();
        assert_eq!(catalog["abnormalBoundaries"].as_array().unwrap().len(), 5);
    }
}
