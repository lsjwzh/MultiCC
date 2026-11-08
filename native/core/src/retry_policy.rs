//! Deterministic retry decisions; the host owns clocks, timers and API-error classification.
use crate::js::{js_to_number, js_to_string, truthy, JsValue};
use crate::quota_guard::{object, prop};

fn text_or(value: &JsValue, fallback: &str) -> String {
    if truthy(value) {
        js_to_string(value).to_string_lossy()
    } else {
        fallback.into()
    }
}
fn terminal(classification: &str, reason: &str, extra: Option<(&str, bool)>) -> JsValue {
    let mut fields = vec![
        ("action", "fail".into()),
        ("classification", classification.into()),
        ("reason", reason.into()),
        ("cleanup", true.into()),
    ];
    if let Some((key, value)) = extra {
        fields.push((key, value.into()));
    }
    object(fields)
}
fn current(value: &JsValue) -> f64 {
    let value = if truthy(value) {
        js_to_number(value)
    } else {
        0.0
    };
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 {
        value
    } else {
        0.0
    }
}
fn schedule(
    action: &str,
    classification: &str,
    current: f64,
    cap: &JsValue,
    delay: &str,
) -> JsValue {
    object(vec![
        ("action", action.into()),
        ("classification", classification.into()),
        ("attempt", (current + 1.0).into()),
        ("cap", cap.clone()),
        ("delayKey", delay.into()),
    ])
}
pub fn decide(input: &JsValue) -> JsValue {
    let event = text_or(prop(input, "event"), "completed");
    let cli = text_or(prop(input, "cli"), "claude").to_lowercase();
    let attempts = prop(input, "attempts");
    let limits = prop(input, "limits");
    match event.as_str() {
        "provider-route-failed" => terminal(
            "provider-route",
            "route-failed",
            Some(("leaveRunning", false)),
        ),
        "handoff-resume-failed" => terminal(
            "handoff-resume",
            "fail-closed-no-fresh-retry",
            Some(("preserveHandoff", true)),
        ),
        "interrupted" => {
            if truthy(prop(input, "killReason")) {
                return terminal("interrupted", "explicit-lifecycle-stop", None);
            }
            if prop(input, "userStopped") == &JsValue::Bool(true) {
                return terminal("interrupted", "user-stopped", None);
            }
            if prop(input, "hasExplicitWait") == &JsValue::Bool(true) {
                return object(vec![
                    ("action", "wait".into()),
                    ("classification", "interrupted".into()),
                    ("reason", "explicit-wait".into()),
                    ("cleanup", true.into()),
                ]);
            }
            let n = current(prop(attempts, "interruptedResume"));
            let cap = prop(limits, "interruptedResume");
            if n >= js_to_number(cap) {
                terminal("interrupted", "resume-cap-reached", None)
            } else {
                schedule("resume", "interrupted", n, cap, "interruptedResume")
            }
        }
        "codex-stream-disconnect" => {
            if cli != "codex" {
                return terminal("transport", "codex-continuation-not-applicable", None);
            }
            if !truthy(prop(input, "hasOutput"))
                || truthy(prop(input, "resultSaved"))
                || truthy(prop(input, "killReason"))
                || !truthy(prop(input, "hasNativeSession"))
            {
                return terminal("transport", "continuation-preconditions-failed", None);
            }
            let n = current(prop(attempts, "codexDisconnect"));
            let cap = prop(limits, "codexDisconnect");
            if n >= js_to_number(cap) {
                terminal("transport", "codex-continuation-cap-reached", None)
            } else {
                schedule(
                    "resume",
                    "codex-stream-disconnect",
                    n,
                    cap,
                    "codexDisconnect",
                )
            }
        }
        "empty-exit" => {
            if cli == "claude" || cli == "claude-exp" {
                return terminal("empty-exit", "claude-stream-does-not-fresh-retry", None);
            }
            if truthy(prop(input, "adapterError")) {
                return terminal("empty-exit", "provider-error", None);
            }
            if truthy(prop(input, "killReason")) {
                return terminal("empty-exit", "turn-killed", None);
            }
            if truthy(prop(input, "guardedHandoff")) {
                return terminal(
                    "handoff-resume",
                    "fail-closed-no-fresh-retry",
                    Some(("preserveHandoff", true)),
                );
            }
            let n = current(prop(attempts, "freshStart"));
            let cap = prop(limits, "freshStart");
            if n >= js_to_number(cap) || prop(input, "isRetry") == &JsValue::Bool(true) {
                terminal("empty-exit", "fresh-retry-exhausted", None)
            } else {
                schedule("retry-fresh", "empty-exit", n, cap, "freshStart")
            }
        }
        _ => object(vec![
            ("action", "finalize".into()),
            (
                "classification",
                if truthy(prop(input, "event")) {
                    JsValue::String(js_to_string(prop(input, "event")))
                } else {
                    "completed".into()
                },
            ),
            ("cleanup", true.into()),
        ]),
    }
}
