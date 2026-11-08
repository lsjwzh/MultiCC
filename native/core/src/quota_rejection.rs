//! Provider rejection normalization and park decisions. Values cross the shared
//! JS bridge so UTF-16 labels and numeric coercion match the host runtime.
use crate::js::{js_to_number, js_to_string, truthy, JsValue};
use crate::quota_guard::{object, prop};

const COOLDOWN: f64 = 300_000.0;
const ENTITLEMENT: f64 = 3_600_000.0;
const MAX_BLOCK: f64 = 8.0 * 24.0 * 3_600_000.0;

fn token(value: &JsValue) -> String {
    match value {
        JsValue::String(s) => s.trim().to_lowercase().to_string_lossy(),
        _ => String::new(),
    }
}
fn label(value: &JsValue, max: usize) -> JsValue {
    match value {
        JsValue::String(s) if !s.trim().is_empty() => JsValue::String(s.trim().truncate_units(max)),
        _ => JsValue::Null,
    }
}
fn reset(value: &JsValue) -> JsValue {
    let n = js_to_number(value);
    if value.is_nullish() || !n.is_finite() || n <= 0.0 {
        return JsValue::Null;
    }
    (if n < 10_000_000_000.0 { n * 1000.0 } else { n })
        .trunc()
        .into()
}
fn normalized(raw: &JsValue) -> JsValue {
    if !matches!(raw, JsValue::Object(_)) {
        return JsValue::Null;
    }
    let kind = token(prop(raw, "kind"));
    if !["transient", "window", "entitlement", "billing"].contains(&kind.as_str()) {
        return JsValue::Null;
    }
    let scope = token(prop(raw, "scope"));
    let scope = if ["request", "model", "account"].contains(&scope.as_str()) {
        scope.as_str()
    } else {
        "account"
    };
    let window = token(prop(raw, "window"));
    let source = token(prop(raw, "source"));
    object(vec![
        ("kind", kind.into()),
        ("scope", scope.into()),
        (
            "window",
            if ["5h", "1d", "1wk", "1m"].contains(&window.as_str()) {
                window.into()
            } else {
                JsValue::Null
            },
        ),
        ("resetMs", reset(prop(raw, "resetMs"))),
        ("code", label(prop(raw, "code"), 80)),
        ("model", label(prop(raw, "model"), 120)),
        (
            "source",
            if ["headers", "code", "text", "status"].contains(&source.as_str()) {
                source.into()
            } else {
                JsValue::Null
            },
        ),
    ])
}
fn park(raw: &JsValue, now: f64) -> JsValue {
    let rejection = normalized(raw);
    if rejection.is_nullish()
        || token(prop(&rejection, "kind")) == "transient"
        || token(prop(&rejection, "scope")) == "request"
    {
        return JsValue::Null;
    }
    let kind = prop(&rejection, "kind");
    let reset = prop(&rejection, "resetMs");
    let until = match reset {
        JsValue::Number(n) if n.is_finite() && *n > now => Some(n.trunc().min(now + MAX_BLOCK)),
        _ => None,
    };
    let model = prop(&rejection, "model");
    let model_scoped = token(prop(&rejection, "scope")) == "model" && truthy(model);
    let mut result = vec![
        (
            "scope",
            if model_scoped { "model" } else { "account" }.into(),
        ),
        (
            "model",
            if model_scoped {
                model.clone()
            } else {
                JsValue::Null
            },
        ),
        ("kind", kind.clone()),
        ("window", prop(&rejection, "window").clone()),
        ("code", prop(&rejection, "code").clone()),
        (
            "blockedUntilMs",
            if model_scoped {
                let fallback = now
                    + if token(kind) == "window" {
                        COOLDOWN
                    } else {
                        ENTITLEMENT
                    };
                until
                    .filter(|n| *n != 0.0 && !n.is_nan())
                    .unwrap_or(fallback)
                    .into()
            } else {
                until.map(JsValue::from).unwrap_or(JsValue::Null)
            },
        ),
    ];
    if !model_scoped {
        result.push((
            "billable",
            matches!(token(kind).as_str(), "window" | "billing").into(),
        ));
    }
    object(result)
}
fn compact(park: &JsValue) -> JsValue {
    let mut result = vec![
        ("kind", prop(park, "kind").clone()),
        ("scope", prop(park, "scope").clone()),
    ];
    for key in ["window", "code"] {
        if truthy(prop(park, key)) {
            result.push((key, prop(park, key).clone()));
        }
    }
    object(result)
}
fn keeps(previous: &JsValue, now: f64, model_until: f64) -> bool {
    let summary = prop(previous, "summary");
    if prop(summary, "kind") != &JsValue::from("availability") {
        return false;
    }
    let lower = |v: &JsValue| {
        if truthy(v) {
            js_to_string(v).to_lowercase().to_string_lossy()
        } else {
            String::new()
        }
    };
    if lower(prop(summary, "status")) != "rejected" || lower(prop(summary, "scope")) == "model" {
        return false;
    }
    let until = js_to_number(prop(summary, "blockedUntilMs"));
    until.is_finite() && until > now && until >= model_until
}
pub fn request(op: &str, input: &JsValue) -> Result<JsValue, String> {
    Ok(match op {
        "park" => park(prop(input, "rejection"), js_to_number(prop(input, "now"))),
        "compact" => compact(input),
        "keeps" => keeps(
            prop(input, "previous"),
            js_to_number(prop(input, "now")),
            js_to_number(prop(input, "modelUntil")),
        )
        .into(),
        _ => return Err(format!("QUOTA_REJECTION_INVALID_OPERATION: {op}")),
    })
}
