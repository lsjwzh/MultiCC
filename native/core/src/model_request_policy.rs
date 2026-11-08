//! Timeout budgets for model requests, independent of the host timers.
use crate::js::{js_to_number, js_to_string, truthy, JsValue};
use crate::quota_guard::{object, prop};

fn bounded(value: &JsValue, fallback: f64, min: f64, max: f64) -> f64 {
    if value.is_nullish() || js_to_string(value).trim().is_empty() {
        return fallback;
    }
    let number = js_to_number(value);
    if number.is_finite() {
        number.trunc().max(min).min(max)
    } else {
        fallback
    }
}

pub fn resolve(input: &JsValue) -> JsValue {
    let effort = prop(input, "effort");
    let effort = if truthy(effort) {
        js_to_string(effort).to_lowercase().to_string_lossy()
    } else {
        String::new()
    };
    let deep = matches!(
        effort.as_str(),
        "high" | "xhigh" | "max" | "ultra" | "ultracode"
    );
    let idle = prop(input, "idle");
    let legacy = if prop(input, "mode") == &JsValue::from("auto") {
        prop(input, "legacy")
    } else {
        &JsValue::Undefined
    };
    let idle = if idle.is_nullish() { legacy } else { idle };
    let stall = bounded(
        idle,
        if deep { 600_000.0 } else { 300_000.0 },
        0.0,
        600_000.0,
    );
    object(vec![
        (
            "stallTimeoutMs",
            if stall > 0.0 {
                stall.max(15_000.0)
            } else {
                0.0
            }
            .into(),
        ),
        (
            "requestTimeoutMs",
            bounded(
                prop(input, "request"),
                if deep { 1_800_000.0 } else { 900_000.0 },
                30_000.0,
                3_600_000.0,
            )
            .into(),
        ),
        (
            "connectTimeoutMs",
            bounded(prop(input, "connect"), 600_000.0, 1_000.0, 600_000.0).into(),
        ),
    ])
}
