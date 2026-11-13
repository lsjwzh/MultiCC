//! Provider limit cache mutation semantics.  The caller supplies the current
//! committed row and applies the resulting row within its storage transaction.
//! Values stay in the shared JavaScript representation so summaries and error
//! messages retain their UTF-16 contents across the native boundary.
use crate::js::{js_to_number, js_to_string, truthy, JsValue};
use crate::quota_guard::{object, prop, set};

fn updated_at(previous: &JsValue, now: &JsValue) -> JsValue {
    let previous = prop(previous, "updatedAt");
    let previous = if truthy(previous) {
        previous
    } else {
        &JsValue::Number(0.0)
    };
    // The previous value comes from SQLite and is numeric; preserve JS's NaN
    // propagation for an injected clock rather than using f64::max.
    let old = js_to_number(previous) + 1.0;
    let current = js_to_number(now);
    JsValue::Number(if current.is_nan() || old.is_nan() {
        f64::NAN
    } else {
        current.max(old)
    })
}

fn from_previous(previous: &JsValue, key: &str, fallback: JsValue) -> JsValue {
    if previous.is_nullish() {
        fallback
    } else {
        prop(previous, key).clone()
    }
}

/// Plan a successful cache write. A late observation returns the existing row
/// unchanged and must not notify listeners or invoke the history callback.
pub fn success(input: &JsValue) -> JsValue {
    let previous = prop(input, "previous");
    let entry = prop(input, "entry");
    let now = prop(input, "now");
    // The host evaluates Math.trunc only when an explicit timestamp exists;
    // the injected clock is passed verbatim, including a fractional value.
    let fetched_at = prop(input, "fetchedAt").clone();
    if !previous.is_nullish()
        && js_to_number(prop(previous, "fetchedAt")) > js_to_number(&fetched_at)
    {
        return object(vec![("write", false.into()), ("entry", previous.clone())]);
    }
    let kind = prop(entry, "kind");
    let summary = prop(entry, "summary");
    let text = prop(entry, "summaryText");
    let bar = prop(entry, "barText");
    let row = object(vec![
        ("appType", prop(input, "appType").clone()),
        ("providerId", prop(input, "providerId").clone()),
        (
            "kind",
            if truthy(kind) {
                kind.clone()
            } else {
                from_previous(previous, "kind", "quota".into())
            },
        ),
        ("status", "ok".into()),
        (
            "summary",
            if summary.is_nullish() {
                from_previous(previous, "summary", JsValue::Null)
            } else {
                summary.clone()
            },
        ),
        (
            "summaryText",
            if matches!(text, JsValue::String(_)) {
                text.clone()
            } else {
                from_previous(previous, "summaryText", "".into())
            },
        ),
        (
            "barText",
            if matches!(bar, JsValue::String(_)) {
                bar.clone()
            } else {
                from_previous(previous, "barText", JsValue::Null)
            },
        ),
        ("fetchedAt", fetched_at),
        ("updatedAt", updated_at(previous, now)),
        ("lastError", JsValue::Null),
        ("lastErrorCode", JsValue::Null),
        ("lastErrorAt", JsValue::Null),
        ("lastAttemptAt", now.clone()),
    ]);
    object(vec![("write", true.into()), ("entry", row)])
}

pub fn is_late(input: &JsValue) -> bool {
    let previous = prop(input, "previous");
    !previous.is_nullish()
        && js_to_number(prop(previous, "fetchedAt")) > js_to_number(prop(input, "fetchedAt"))
}

/// Failure only updates diagnostic fields and never discards a successful
/// summary, preserving the existing cache contract across restarts.
pub fn failure(input: &JsValue) -> JsValue {
    let previous = prop(input, "previous");
    let now = prop(input, "now");
    let meta = prop(input, "meta");
    let mut row = if previous.is_nullish() {
        object(vec![
            ("appType", prop(input, "appType").clone()),
            ("providerId", prop(input, "providerId").clone()),
            ("kind", "unknown".into()),
            ("status", "error".into()),
            ("summary", JsValue::Null),
            ("summaryText", "".into()),
            ("barText", JsValue::Null),
            ("fetchedAt", JsValue::Null),
            ("updatedAt", now.clone()),
        ])
    } else {
        previous.clone()
    };
    for (field, source) in [("lastError", "error"), ("lastErrorCode", "code")] {
        let value = prop(meta, source);
        set(
            &mut row,
            field,
            if truthy(value) {
                JsValue::String(js_to_string(value))
            } else {
                JsValue::Null
            },
        );
    }
    set(&mut row, "lastErrorAt", now.clone());
    set(&mut row, "lastAttemptAt", now.clone());
    set(&mut row, "updatedAt", updated_at(previous, now));
    row
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_success_keeps_the_previous_observation() {
        let previous = object(vec![
            ("fetchedAt", 100.0.into()),
            ("summaryText", "old".into()),
        ]);
        let input = object(vec![
            ("previous", previous.clone()),
            ("fetchedAt", 99.0.into()),
        ]);
        assert!(is_late(&input));
        let input = object(vec![
            ("previous", previous.clone()),
            ("entry", object(vec![])),
            ("fetchedAt", 99.0.into()),
            ("now", 200.0.into()),
        ]);
        assert_eq!(prop(&success(&input), "entry"), &previous);
        assert_eq!(prop(&success(&input), "write"), &JsValue::Bool(false));
    }

    #[test]
    fn failure_preserves_last_good_summary_and_monotonic_update() {
        let previous = object(vec![
            ("status", "ok".into()),
            ("summaryText", "old".into()),
            ("updatedAt", 200.0.into()),
            ("fetchedAt", 190.0.into()),
        ]);
        let result = failure(&object(vec![
            ("previous", previous),
            ("now", 150.0.into()),
            ("meta", object(vec![("error", "offline".into())])),
        ]));
        assert_eq!(prop(&result, "status"), &JsValue::from("ok"));
        assert_eq!(prop(&result, "summaryText"), &JsValue::from("old"));
        assert_eq!(prop(&result, "lastError"), &JsValue::from("offline"));
        assert_eq!(prop(&result, "updatedAt"), &JsValue::Number(201.0));
    }
}
