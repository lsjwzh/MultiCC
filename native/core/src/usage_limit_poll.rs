//! Normalization of public quota responses. Credentials and transport remain
//! in the host until the outbound request lifecycle is migrated separately.
use crate::js::{js_to_number, js_to_string, truthy, JsValue};
use crate::quota_guard::{object, prop};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct PollState {
    cache: HashMap<crate::js::JsString, JsValue>,
    inflight: HashSet<crate::js::JsString>,
}

fn ttl(strategy: &JsValue) -> f64 {
    match js_to_string(strategy).to_string_lossy().as_str() {
        "deepseek-balance" => 300_000.0,
        // The frozen JavaScript TTL dictionary inherits Object.prototype;
        // inherited function/object values coerce to NaN in the age comparison.
        "constructor"
        | "toString"
        | "toLocaleString"
        | "valueOf"
        | "hasOwnProperty"
        | "isPrototypeOf"
        | "propertyIsEnumerable"
        | "__defineGetter__"
        | "__defineSetter__"
        | "__lookupGetter__"
        | "__lookupSetter__"
        | "__proto__" => f64::NAN,
        _ => 60_000.0,
    }
}

impl PollState {
    /// Own cache freshness and admission. The host retains only live promise
    /// handles, because its injected HTTP adapter still runs in Node.
    pub fn request(&mut self, op: &str, input: &JsValue) -> JsValue {
        let key = js_to_string(prop(input, "key"));
        match op {
            "begin" => {
                let strategy = prop(input, "strategy");
                let cached = self.cache.get(&key);
                if let Some(value) = cached {
                    let age = js_to_number(prop(input, "now")) - js_to_number(prop(value, "at"));
                    if age < ttl(strategy) {
                        return object(vec![
                            ("action", "cached".into()),
                            ("dto", prop(value, "dto").clone()),
                        ]);
                    }
                }
                if self.inflight.contains(&key) {
                    return object(vec![("action", "join".into())]);
                }
                if prop(input, "hasAdapter").is_nullish() {
                    return object(vec![("action", "needAdapter".into())]);
                }
                if !truthy(prop(input, "hasAdapter")) {
                    return object(vec![("action", "none".into())]);
                }
                self.inflight.insert(key);
                object(vec![("action", "start".into())])
            }
            "finish" => {
                let mut value = object(vec![
                    ("at", prop(input, "at").clone()),
                    ("dto", prop(input, "dto").clone()),
                ]);
                let error = prop(input, "error");
                if truthy(error) || prop(input, "includeError") == &JsValue::Bool(true) {
                    crate::quota_guard::set(&mut value, "error", error.clone());
                }
                self.cache.insert(key.clone(), value);
                self.inflight.remove(&key);
                JsValue::Null
            }
            "abort" => {
                self.inflight.remove(&key);
                JsValue::Null
            }
            "get" => self.cache.get(&key).cloned().unwrap_or(JsValue::Undefined),
            "has" => self.cache.contains_key(&key).into(),
            "size" => (self.cache.len() as f64).into(),
            "clear" => {
                self.cache.clear();
                JsValue::Null
            }
            _ => JsValue::Undefined,
        }
    }
}

fn finite(value: &JsValue) -> Option<f64> {
    let n = js_to_number(value);
    n.is_finite().then_some(n)
}

fn number_or_null(value: &JsValue) -> JsValue {
    finite(value).map_or(JsValue::Null, JsValue::Number)
}

struct CodexWindow {
    label: &'static str,
    percent: f64,
    seconds: f64,
    resets_at: Option<f64>,
}

impl CodexWindow {
    fn fields(&self) -> Vec<(&'static str, JsValue)> {
        vec![
            ("window", self.label.into()),
            ("label", self.label.into()),
            ("usedPercent", self.percent.into()),
        ]
    }

    fn reset_ms(&self) -> JsValue {
        self.resets_at
            .map_or(JsValue::Null, |value| (value * 1000.0).into())
    }
}

fn codex_windows(limit: &JsValue, now_ms: f64) -> Vec<CodexWindow> {
    let provided = |value: &JsValue| {
        if value.is_nullish() || value == &JsValue::from("") {
            None
        } else {
            finite(value)
        }
    };
    let mut windows: Vec<_> = ["primary_window", "secondary_window"]
        .into_iter()
        .filter_map(|key| {
            let window = prop(limit, key);
            let percent = provided(prop(window, "used_percent"))?;
            let seconds =
                provided(prop(window, "limit_window_seconds")).filter(|seconds| *seconds > 0.0)?;
            let resets_at = provided(prop(window, "reset_at")).or_else(|| {
                provided(prop(window, "reset_after_seconds"))
                    .map(|after| (now_ms / 1000.0).trunc() + after)
            });
            // API slot names vary by plan. The cycle length is authoritative.
            let label = if seconds >= 28.0 * 86_400.0 {
                "1m"
            } else if seconds >= 86_400.0 {
                "1wk"
            } else {
                "5h"
            };
            Some(CodexWindow {
                label,
                percent,
                seconds,
                resets_at,
            })
        })
        .collect();
    windows.sort_by(|a, b| a.seconds.total_cmp(&b.seconds));
    windows
}

pub fn codex_rate_limit_windows(limit: &JsValue, now_ms: f64) -> JsValue {
    JsValue::Array(
        codex_windows(limit, now_ms)
            .iter()
            .map(|window| {
                let mut fields = window.fields();
                fields.extend([
                    ("windowSeconds", window.seconds.into()),
                    (
                        "resetsAt",
                        window.resets_at.map_or(JsValue::Null, JsValue::Number),
                    ),
                    ("resetMs", window.reset_ms()),
                ]);
                object(fields)
            })
            .collect(),
    )
}

pub fn codex(body: &JsValue, now_ms: f64) -> JsValue {
    let limit = prop(body, "rate_limit");
    let windows = codex_windows(limit, now_ms);
    let Some(headline) = windows
        .iter()
        .find(|window| window.label == "1wk")
        .or_else(|| windows.last())
    else {
        return JsValue::Null;
    };
    let worst = windows
        .iter()
        .map(|window| window.percent)
        .fold(f64::NEG_INFINITY, f64::max);
    let status = if prop(limit, "limit_reached") == &JsValue::Bool(true) || worst >= 100.0 {
        "rejected"
    } else if worst >= 80.0 {
        "allowed_warning"
    } else {
        "allowed"
    };
    let tier = match prop(body, "plan_type") {
        JsValue::String(value) => JsValue::String(value.clone()),
        _ => JsValue::Null,
    };
    object(vec![
        ("kind", "window".into()),
        ("provider", "codex".into()),
        (
            "rateLimitType",
            if headline.label == "5h" {
                "five_hour"
            } else {
                "weekly"
            }
            .into(),
        ),
        ("status", status.into()),
        (
            "utilization",
            (headline.percent / 100.0).clamp(0.0, 1.0).into(),
        ),
        (
            "resetsAt",
            headline.resets_at.map_or(JsValue::Null, JsValue::Number),
        ),
        ("tier", tier),
        (
            "windows",
            JsValue::Array(
                windows
                    .iter()
                    .map(|window| {
                        let mut fields = window.fields();
                        fields.push(("resetMs", window.reset_ms()));
                        object(fields)
                    })
                    .collect(),
            ),
        ),
    ])
}

pub fn glm(body: &JsValue) -> JsValue {
    let data = prop(body, "data");
    let JsValue::Array(limits) = prop(data, "limits") else {
        return JsValue::Null;
    };
    let mut rows = limits.iter().filter(|row| {
        truthy(row)
            && prop(row, "type") == &JsValue::from("TOKENS_LIMIT")
            && finite(prop(row, "percentage")).is_some()
    });
    let Some(first) = rows.next() else {
        return JsValue::Null;
    };
    let percent = finite(prop(first, "percentage")).expect("filtered finite percentage");
    let second = rows.next();
    let status = if percent >= 100.0 {
        "rejected"
    } else if percent >= 80.0 {
        "allowed_warning"
    } else {
        "allowed"
    };
    let level = prop(data, "level");
    object(vec![
        ("kind", "window".into()),
        ("provider", "glm".into()),
        ("rateLimitType", "five_hour".into()),
        ("status", status.into()),
        ("utilization", (percent / 100.0).clamp(0.0, 1.0).into()),
        ("resetsAt", number_or_null(prop(first, "nextResetTime"))),
        (
            "weeklyUtilization",
            second
                .and_then(|row| finite(prop(row, "percentage")))
                .map_or(JsValue::Null, |n| (n / 100.0).clamp(0.0, 1.0).into()),
        ),
        (
            "weeklyResetsAt",
            second.map_or(JsValue::Null, |row| {
                number_or_null(prop(row, "nextResetTime"))
            }),
        ),
        (
            "tier",
            if truthy(level) {
                level.clone()
            } else {
                JsValue::Null
            },
        ),
    ])
}

pub fn deepseek(body: &JsValue) -> JsValue {
    let JsValue::Array(infos) = prop(body, "balance_infos") else {
        return JsValue::Null;
    };
    let info = infos.first().filter(|v| truthy(v));
    let member = |name| info.map_or(&JsValue::Undefined, |value| prop(value, name));
    let currency = member("currency");
    object(vec![
        ("kind", "balance".into()),
        (
            "available",
            (prop(body, "is_available") == &JsValue::Bool(true)).into(),
        ),
        (
            "currency",
            if truthy(currency) {
                currency.clone()
            } else {
                JsValue::Null
            },
        ),
        (
            "total",
            if info.is_some() {
                number_or_null(member("total_balance"))
            } else {
                JsValue::Null
            },
        ),
        (
            "granted",
            if info.is_some() {
                number_or_null(member("granted_balance"))
            } else {
                JsValue::Null
            },
        ),
        (
            "toppedUp",
            if info.is_some() {
                number_or_null(member("topped_up_balance"))
            } else {
                JsValue::Null
            },
        ),
    ])
}

/// Keep the host's error class and transport stack while moving response
/// validation and the 100-UTF-16-unit reason limit into the native kernel.
pub fn relay(body: &JsValue) -> JsValue {
    if !truthy(body) {
        return object(vec![("dto", JsValue::Null), ("error", JsValue::Null)]);
    }
    if prop(body, "ok") != &JsValue::Bool(true) {
        let detail = prop(body, "detail");
        let reason = prop(body, "reason");
        let value = if truthy(detail) {
            Some(js_to_string(detail))
        } else if truthy(reason) {
            Some(js_to_string(reason).truncate_units(100))
        } else {
            None
        };
        let error = value.map_or(JsValue::Null, |value| {
            let mut message = crate::js::JsString::from("lender: ");
            message.push(&value);
            JsValue::String(message)
        });
        return object(vec![("dto", JsValue::Null), ("error", error)]);
    }
    let dto = prop(body, "dto");
    let valid = match prop(dto, "kind") {
        kind if kind == &JsValue::from("window") => {
            matches!(prop(dto, "utilization"), JsValue::Number(n) if n.is_finite())
        }
        kind if kind == &JsValue::from("balance") => {
            matches!(
                prop(dto, "available"),
                JsValue::Bool(_) | JsValue::Number(_)
            )
        }
        _ => false,
    };
    object(vec![
        ("dto", if valid { dto.clone() } else { JsValue::Null }),
        ("error", JsValue::Null),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polling_deduplicates_and_caches_success_and_failures_until_ttl() {
        let mut state = PollState::default();
        let input = |now| {
            object(vec![
                ("key", "p:hash".into()),
                ("strategy", "glm-monitor".into()),
                ("now", JsValue::Number(now)),
                ("hasAdapter", true.into()),
            ])
        };
        assert_eq!(
            prop(&state.request("begin", &input(100.0)), "action"),
            &JsValue::from("start")
        );
        assert_eq!(
            prop(&state.request("begin", &input(100.0)), "action"),
            &JsValue::from("join")
        );
        state.request(
            "finish",
            &object(vec![
                ("key", "p:hash".into()),
                ("at", 100.0.into()),
                ("dto", JsValue::Null),
                ("error", "offline".into()),
            ]),
        );
        let cached = state.request("begin", &input(60_099.0));
        assert_eq!(prop(&cached, "action"), &JsValue::from("cached"));
        assert_eq!(prop(&cached, "dto"), &JsValue::Null);
        assert_eq!(
            prop(&state.request("begin", &input(60_100.0)), "action"),
            &JsValue::from("start")
        );
        state.request("abort", &object(vec![("key", "p:hash".into())]));
        assert_eq!(
            prop(&state.request("begin", &input(60_100.0)), "action"),
            &JsValue::from("start")
        );
    }

    #[test]
    fn glm_uses_two_token_windows_and_preserves_null_number_coercion() {
        let body = object(vec![(
            "data",
            object(vec![(
                "limits",
                JsValue::Array(vec![
                    object(vec![
                        ("type", "TIME_LIMIT".into()),
                        ("percentage", 99.0.into()),
                    ]),
                    object(vec![
                        ("type", "TOKENS_LIMIT".into()),
                        ("percentage", "80".into()),
                        ("nextResetTime", JsValue::Null),
                    ]),
                    object(vec![
                        ("type", "TOKENS_LIMIT".into()),
                        ("percentage", 120.0.into()),
                    ]),
                ]),
            )]),
        )]);
        let result = glm(&body);
        assert_eq!(prop(&result, "status"), &JsValue::from("allowed_warning"));
        assert_eq!(prop(&result, "resetsAt"), &JsValue::Number(0.0));
        assert_eq!(prop(&result, "weeklyUtilization"), &JsValue::Number(1.0));
    }

    #[test]
    fn empty_balance_is_distinct_from_present_null_values() {
        let empty = deepseek(&object(vec![("balance_infos", JsValue::Array(vec![]))]));
        assert_eq!(prop(&empty, "total"), &JsValue::Null);
        let present = deepseek(&object(vec![(
            "balance_infos",
            JsValue::Array(vec![object(vec![("total_balance", JsValue::Null)])]),
        )]));
        assert_eq!(prop(&present, "total"), &JsValue::Number(0.0));
    }
}
