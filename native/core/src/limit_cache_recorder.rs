//! Quota observation policy. The host only owns dynamic callbacks and applies
//! the returned writes; all normalization, identity and cooldown rules live here.
use crate::js::{from_serde, js_to_number, js_to_string, to_serde, truthy, JsString, JsValue};
use crate::quota_guard::{object, prop, set};
use crate::{quota_bar_view, quota_rejection};
use std::collections::HashSet;

pub const PROVIDER_FAILURE_COOLDOWN_MS: f64 = 300_000.0;
pub const AUTH_REVOKED_BLOCKED_UNTIL_MS: f64 = 9_007_199_254_740_991.0;
fn s(v: &JsValue) -> String {
    js_to_string(v).to_string_lossy()
}
fn eq(v: &JsValue, text: &str) -> bool {
    v == &JsValue::from(text)
}
fn or(v: &JsValue, fallback: JsValue) -> JsValue {
    if truthy(v) {
        v.clone()
    } else {
        fallback
    }
}
fn arr(v: &JsValue) -> &[JsValue] {
    if let JsValue::Array(a) = v {
        a
    } else {
        &[]
    }
}
fn obj(v: &JsValue) -> bool {
    matches!(
        v,
        JsValue::Object(_) | JsValue::Array(_) | JsValue::Bytes(_) | JsValue::Date(_)
    )
}
fn slice(v: &JsValue, n: usize) -> JsValue {
    JsValue::String(js_to_string(v).truncate_units(n))
}
fn view(op: &str, fields: Vec<(&str, JsValue)>) -> JsValue {
    quota_bar_view::request(op, &object(fields))
}
fn compact(v: &JsValue) -> JsValue {
    view("compactBarText", vec![("text", v.clone())])
}
fn claude(op: &str, fields: Vec<(&str, JsValue)>) -> JsValue {
    let mut input = object(fields);
    set(&mut input, "op", op.into());
    from_serde(&crate::claude_quota::run(&to_serde(&input)))
}
fn reject(op: &str, input: &JsValue) -> JsValue {
    quota_rejection::request(op, input).unwrap_or(JsValue::Undefined)
}
fn revoked(v: &JsValue) -> bool {
    js_to_string(&or(v, "".into())).to_lowercase() == "authentication_permission"
}
fn nullish(v: &JsValue) -> JsValue {
    if v.is_nullish() {
        JsValue::Null
    } else {
        v.clone()
    }
}
fn reset(v: &JsValue) -> JsValue {
    let n = js_to_number(v);
    if v.is_nullish() || !n.is_finite() || n <= 0.0 {
        JsValue::Null
    } else {
        (if n < 10_000_000_000.0 { n * 1000.0 } else { n })
            .trunc()
            .into()
    }
}
fn window_percent(v: &JsValue) -> JsValue {
    let n = js_to_number(v);
    if v.is_nullish() || !n.is_finite() {
        JsValue::Null
    } else {
        (((n * 100.0).clamp(0.0, 100.0) * 1000.0 + 0.5).floor() / 1000.0).into()
    }
}
fn row(window: &JsValue, label: &JsValue, used: &JsValue, at: &JsValue) -> JsValue {
    let n = js_to_number(used);
    if used.is_nullish() || !n.is_finite() {
        return JsValue::Null;
    }
    object(vec![
        ("window", or(window, JsValue::Null)),
        ("label", or(label, or(window, JsValue::Null))),
        ("usedPercent", n.clamp(0.0, 100.0).into()),
        ("resetMs", reset(at)),
    ])
}
fn cycle(v: &JsValue) -> JsString {
    let w = js_to_string(&or(v, "".into())).trim().to_lowercase();
    match w.to_string_lossy().as_str() {
        "5h" | "five_hour" | "session" => "5h".into(),
        "7d" | "1wk" | "weekly" | "week" | "seven_day" => "1wk".into(),
        "1m" | "30d" | "monthly" | "month" => "1m".into(),
        _ => w,
    }
}
fn merge_windows(next: &JsValue, previous: &JsValue, now: f64) -> JsValue {
    let mut rows: Vec<JsValue> = arr(next).iter().filter(|v| truthy(v)).cloned().collect();
    let key = |v: &JsValue| cycle(&or(prop(v, "window"), prop(v, "label").clone()));
    let mut seen: HashSet<JsString> = rows.iter().map(key).collect();
    for r in arr(previous) {
        if !truthy(r) || seen.contains(&key(r)) {
            continue;
        }
        let reset = js_to_number(prop(r, "resetMs"));
        if !reset.is_finite() || reset <= now {
            continue;
        }
        rows.push(r.clone());
        seen.insert(key(r));
    }
    JsValue::Array(rows)
}
fn previous_windows(input: &JsValue) -> &JsValue {
    prop(prop(prop(input, "previous"), "summary"), "windows")
}
fn rows(input: &JsValue) -> JsValue {
    JsValue::Array(
        arr(input)
            .iter()
            .filter(|v| truthy(v))
            .map(|v| {
                row(
                    prop(v, "window"),
                    prop(v, "label"),
                    prop(v, "usedPercent"),
                    prop(v, "resetMs"),
                )
            })
            .filter(truthy)
            .collect(),
    )
}
fn record(
    kind: JsValue,
    summary: JsValue,
    bar: &JsValue,
    at: JsValue,
    absent_bar_empty: bool,
) -> JsValue {
    let text = if absent_bar_empty {
        or(prop(bar, "text"), "".into())
    } else if truthy(bar) {
        prop(bar, "text").clone()
    } else {
        "".into()
    };
    let bar_text = if absent_bar_empty {
        or(prop(bar, "text"), JsValue::Null)
    } else if truthy(bar) {
        prop(bar, "text").clone()
    } else {
        JsValue::Null
    };
    object(vec![
        ("kind", kind),
        ("summary", summary),
        ("summaryText", compact(&text)),
        ("barText", bar_text),
        ("fetchedAt", at),
    ])
}
fn dto_prepare(input: &JsValue) -> JsValue {
    let dto = prop(input, "dto");
    let at = prop(input, "now");
    if eq(prop(dto, "kind"), "window") {
        if eq(prop(dto, "provider"), "claude") && eq(prop(dto, "source"), "response_headers") {
            return object(vec![
                ("mode", "headers".into()),
                ("previous", "strict".into()),
            ]);
        }
        if eq(prop(dto, "provider"), "claude") && matches!(prop(dto, "windows"), JsValue::Array(_))
        {
            let rows = rows(prop(dto, "windows"));
            if arr(&rows).is_empty() {
                return JsValue::Null;
            }
            return object(vec![
                ("mode", "claude".into()),
                ("previous", "strict".into()),
                ("rows", rows),
            ]);
        }
        let normalized = view(
            "normalizeWindowEvent",
            vec![
                ("info", dto.clone()),
                ("nowMs", or(prop(dto, "fetchedAt"), at.clone())),
            ],
        );
        if !truthy(&normalized) {
            return JsValue::Null;
        }
        return object(vec![
            ("mode", "window".into()),
            ("previous", "optional".into()),
            ("normalized", normalized),
        ]);
    }
    if eq(prop(dto, "kind"), "balance") {
        let normalized = view("normalizeBalance", vec![("info", dto.clone())]);
        if !truthy(&normalized) {
            return JsValue::Null;
        }
        return object(vec![("mode", "balance".into()), ("normalized", normalized)]);
    }
    JsValue::Null
}
fn dto_finish(input: &JsValue) -> JsValue {
    let dto = prop(input, "dto");
    let at = prop(input, "now");
    let stage = prop(input, "stage");
    let normalized = prop(stage, "normalized");
    match s(prop(stage, "mode")).as_str() {
        "headers" => {
            let summary = claude(
                "cache",
                vec![
                    ("dto", dto.clone()),
                    ("previous", prop(prop(input, "previous"), "summary").clone()),
                    ("nowMs", at.clone()),
                ],
            );
            if !truthy(&summary) {
                return JsValue::Null;
            }
            let bar = view(
                "providerLimitBar",
                vec![
                    (
                        "entry",
                        object(vec![
                            ("kind", "window".into()),
                            ("summary", summary.clone()),
                            ("fetchedAt", at.clone()),
                        ]),
                    ),
                    ("nowMs", at.clone()),
                ],
            );
            record("window".into(), summary, &bar, at.clone(), true)
        }
        "claude" => {
            let rows = prop(stage, "rows");
            let main = arr(rows)
                .iter()
                .find(|v| eq(prop(v, "window"), "5h"))
                .unwrap_or(&arr(rows)[0]);
            let fetched = or(prop(dto, "fetchedAt"), at.clone());
            let summary = object(vec![
                ("kind", "window".into()),
                ("provider", "claude".into()),
                ("status", prop(dto, "status").clone()),
                ("window", prop(main, "window").clone()),
                ("usedPercentage", prop(main, "usedPercent").clone()),
                ("resetsAtMs", prop(main, "resetMs").clone()),
                ("observedAtMs", fetched.clone()),
                (
                    "windows",
                    merge_windows(rows, previous_windows(input), js_to_number(at)),
                ),
            ]);
            let bar = view(
                "providerLimitBar",
                vec![
                    (
                        "entry",
                        object(vec![
                            ("kind", "window".into()),
                            ("summary", summary.clone()),
                            ("fetchedAt", fetched.clone()),
                        ]),
                    ),
                    ("nowMs", at.clone()),
                ],
            );
            record("window".into(), summary, &bar, fetched, true)
        }
        "window" => {
            let bar = view(
                "windowEventBar",
                vec![("info", normalized.clone()), ("nowMs", at.clone())],
            );
            let mut summary = object(vec![
                ("kind", "window".into()),
                ("provider", prop(normalized, "provider").clone()),
                ("status", prop(normalized, "status").clone()),
                ("usedPercentage", prop(normalized, "usedPercentage").clone()),
                ("resetsAtMs", prop(normalized, "resetsAtMs").clone()),
                ("observedAtMs", prop(normalized, "observedAtMs").clone()),
            ]);
            let main = if eq(prop(normalized, "kind"), "weekly") {
                "1wk"
            } else {
                "5h"
            };
            set(&mut summary, "window", main.into());
            let reported = if matches!(prop(dto, "windows"), JsValue::Array(_)) {
                rows(prop(dto, "windows"))
            } else {
                JsValue::Array(vec![
                    row(
                        &main.into(),
                        &main.into(),
                        prop(normalized, "usedPercentage"),
                        prop(normalized, "resetsAtMs"),
                    ),
                    row(
                        &"1wk".into(),
                        &"1wk".into(),
                        &window_percent(prop(dto, "weeklyUtilization")),
                        prop(dto, "weeklyResetsAt"),
                    ),
                ])
            };
            let windows = merge_windows(&reported, previous_windows(input), js_to_number(at));
            if arr(&windows).len() > 1 {
                set(&mut summary, "windows", windows);
            }
            record(
                "window".into(),
                summary,
                &bar,
                prop(normalized, "observedAtMs").clone(),
                false,
            )
        }
        "balance" => {
            let bar = view("balanceBar", vec![("value", normalized.clone())]);
            let summary = object(vec![
                ("kind", "balance".into()),
                ("provider", prop(normalized, "provider").clone()),
                ("available", prop(normalized, "available").clone()),
                ("total", prop(normalized, "total").clone()),
                ("currency", prop(normalized, "currency").clone()),
            ]);
            record(
                "balance".into(),
                summary,
                &bar,
                or(prop(dto, "fetchedAt"), at.clone()),
                false,
            )
        }
        _ => JsValue::Null,
    }
}
fn provider_plan(input: &JsValue) -> JsValue {
    if !truthy(prop(input, "providerId")) {
        return JsValue::Null;
    }
    let r = prop(input, "result");
    if !truthy(r) || prop(r, "ok") == &JsValue::Bool(false) {
        let error = or(
            prop(r, "detail"),
            or(prop(r, "reason"), prop(r, "error").clone()),
        );
        return object(vec![
            ("action", "failure".into()),
            (
                "value",
                object(vec![
                    (
                        "error",
                        if truthy(&error) {
                            slice(&error, 200)
                        } else {
                            JsValue::Null
                        },
                    ),
                    (
                        "code",
                        if truthy(prop(r, "code")) {
                            JsValue::String(js_to_string(prop(r, "code")))
                        } else {
                            JsValue::Null
                        },
                    ),
                ]),
            ),
        ]);
    }
    if truthy(prop(r, "dto")) {
        return object(vec![("action", "dto".into())]);
    }
    if truthy(prop(r, "summaryText")) {
        return object(vec![
            ("action", "record".into()),
            ("needsNow", (!truthy(prop(r, "fetchedAt"))).into()),
        ]);
    }
    JsValue::Null
}
fn failure_check(input: &JsValue) -> JsValue {
    let previous = prop(input, "previous");
    let summary = prop(previous, "summary");
    let park = prop(input, "park");
    let policy = prop(input, "policy");
    if truthy(prop(policy, "preserve")) && (!truthy(park) || !truthy(prop(park, "blockedUntilMs")))
    {
        return "preserve".into();
    }
    if !revoked(prop(input, "category")) && eq(prop(summary, "status"), "rejected") {
        if prop(summary, "revoked") == &JsValue::Bool(true) {
            return "preserve".into();
        }
        if !truthy(prop(input, "rejection"))
            && prop(input, "blockedUntilMs").is_nullish()
            && s(&or(prop(summary, "scope"), "".into())) != "model"
            && js_to_number(prop(summary, "blockedUntilMs")).is_finite()
        {
            return "checkLong".into();
        }
    }
    "record".into()
}
fn cooldown(input: &JsValue) -> JsValue {
    let park = prop(input, "park");
    let now = js_to_number(prop(input, "now"));
    let revoked = revoked(prop(input, "category"));
    let until = prop(park, "blockedUntilMs");
    let requested = js_to_number(prop(input, "blockedUntilMs"));
    let finite = matches!(until, JsValue::Number(n) if n.is_finite() && *n>now);
    let model = truthy(park) && eq(prop(park, "scope"), "model") && !revoked;
    let until = if revoked {
        AUTH_REVOKED_BLOCKED_UNTIL_MS
    } else if finite {
        js_to_number(until).trunc()
    } else if !model && requested.is_finite() && requested > now {
        requested.trunc()
    } else {
        now + PROVIDER_FAILURE_COOLDOWN_MS
    };
    let status = js_to_number(prop(input, "httpStatus"));
    let http = if status.is_finite() && status.fract() == 0.0 {
        status.into()
    } else {
        JsValue::Null
    };
    let category = slice(
        &or(prop(input, "category"), "provider_transient".into()),
        80,
    );
    let mut summary = object(vec![
        ("kind", "availability".into()),
        ("status", "rejected".into()),
    ]);
    if model {
        set(&mut summary, "scope", "model".into());
        set(&mut summary, "model", prop(park, "model").clone());
    }
    set(
        &mut summary,
        "category",
        if !model && truthy(prop(park, "billable")) {
            "billing_quota".into()
        } else {
            category
        },
    );
    set(&mut summary, "httpStatus", http);
    set(&mut summary, "blockedUntilMs", until.into());
    if revoked {
        set(&mut summary, "revoked", true.into());
    }
    if truthy(park) {
        set(&mut summary, "rejection", reject("compact", park));
    }
    set(&mut summary, "observedAtMs", now.into());
    object(vec![
        ("needsPrevious", model.into()),
        ("until", until.into()),
        (
            "value",
            object(vec![
                ("kind", "availability".into()),
                ("summary", summary),
                ("summaryText", "".into()),
                ("barText", JsValue::Null),
                ("fetchedAt", now.into()),
            ]),
        ),
    ])
}
fn vendor_windows(kind: &JsValue, result: &JsValue, base: &JsValue) -> JsValue {
    if !truthy(result) || !obj(result) {
        return JsValue::Array(vec![]);
    }
    let list = match s(kind).as_str() {
        "kimi" => arr(prop(result, "summary"))
            .iter()
            .filter(|v| truthy(v))
            .map(|v| {
                row(
                    prop(v, "window"),
                    prop(v, "label"),
                    if prop(v, "usedPercent").is_nullish() {
                        prop(v, "percent")
                    } else {
                        prop(v, "usedPercent")
                    },
                    prop(v, "resetMs"),
                )
            })
            .collect(),
        "zhipu" => {
            if let Some(site) = arr(prop(result, "sites")).iter().find(|v| {
                truthy(v)
                    && truthy(prop(v, "ok"))
                    && js_to_number(prop(v, "usedPercent")).is_finite()
            }) {
                vec![
                    row(
                        &"5h".into(),
                        &"5h".into(),
                        prop(site, "usedPercent"),
                        prop(site, "resetsAt"),
                    ),
                    row(
                        &"1wk".into(),
                        &"1wk".into(),
                        prop(site, "weeklyUsedPercent"),
                        prop(site, "weeklyResetsAt"),
                    ),
                ]
            } else {
                vec![]
            }
        }
        "codex" => arr(prop(result, "windows"))
            .iter()
            .filter(|v| truthy(v))
            .map(|v| {
                let raw = prop(v, "resetsAt");
                let reset = if raw != &JsValue::Null && js_to_number(raw).is_finite() {
                    (js_to_number(raw) * 1000.0).into()
                } else {
                    JsValue::Null
                };
                row(
                    prop(v, "window"),
                    prop(v, "window"),
                    prop(v, "usedPercent"),
                    &reset,
                )
            })
            .collect(),
        "ark" => {
            let subscribed: Vec<_> = arr(prop(result, "items"))
                .iter()
                .filter(|v| {
                    truthy(v)
                        && truthy(prop(v, "subscribed"))
                        && !truthy(prop(v, "error"))
                        && !arr(prop(v, "periods")).is_empty()
                })
                .collect();
            let active = view("arkPlanFromBaseUrl", vec![("baseUrl", base.clone())]);
            let plan = subscribed
                .iter()
                .find(|v| prop(v, "product") == &active)
                .or_else(|| subscribed.first());
            plan.map(|v| {
                arr(prop(v, "periods"))
                    .iter()
                    .filter(|v| truthy(v))
                    .map(|p| {
                        row(
                            &view("arkWindowLabel", vec![("label", prop(p, "label").clone())]),
                            prop(p, "label"),
                            prop(p, "percent"),
                            prop(p, "resetAt"),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
        }
        _ => vec![],
    };
    JsValue::Array(list.into_iter().filter(truthy).collect())
}
fn url_parts(v: &JsValue) -> Option<(String, String)> {
    let u = url::Url::parse(&s(v)).ok()?;
    let mut host = u.host_str().unwrap_or("").to_lowercase();
    if let Some(p) = u.port() {
        host.push_str(&format!(":{p}"));
    }
    Some((host, u.path().to_lowercase().trim_end_matches('/').into()))
}
/// Operations are split at host effects so invalid inputs do not accidentally
/// read a provider store, cache or clock that the previous implementation skipped.
pub fn request(op: &str, input: &JsValue) -> JsValue {
    match op {
        "isRevokedCategory" => revoked(prop(input, "category")).into(),
        "constants" => object(vec![
            (
                "PROVIDER_FAILURE_COOLDOWN_MS",
                PROVIDER_FAILURE_COOLDOWN_MS.into(),
            ),
            (
                "AUTH_REVOKED_BLOCKED_UNTIL_MS",
                AUTH_REVOKED_BLOCKED_UNTIL_MS.into(),
            ),
        ]),
        "identityKey" => {
            if truthy(prop(input, "value")) {
                JsValue::String(js_to_string(prop(input, "value")))
            } else {
                JsValue::Null
            }
        }
        "sessionCli" => {
            if truthy(prop(input, "provider")) {
                or(prop(input, "cli"), "claude".into())
            } else {
                JsValue::Null
            }
        }
        "sessionIdentity" => {
            if truthy(prop(input, "appType")) {
                object(vec![
                    ("appType", prop(input, "appType").clone()),
                    ("providerId", prop(input, "provider").clone()),
                ])
            } else {
                JsValue::Null
            }
        }
        "providerIdentity" => {
            let id = prop(input, "id");
            let app = prop(input, "appType");
            if !truthy(id) || !truthy(app) {
                return JsValue::Null;
            }
            let app = js_to_string(app);
            let id = js_to_string(id);
            let account = prop(input, "activeAccountId");
            let mut prefix = app.clone();
            prefix.push_str("-official-");
            let concrete = id
                .as_units()
                .strip_prefix(prefix.as_units())
                .is_some_and(|v| {
                    v.len() == 16
                        && v.iter()
                            .all(|c| (48..=57).contains(c) || (97..=102).contains(c))
                });
            let id = if truthy(account) && !eq(account, "global") && !concrete {
                prefix.push(&js_to_string(account));
                prefix
            } else {
                id
            };
            object(vec![
                ("appType", JsValue::String(app)),
                ("providerId", JsValue::String(id)),
            ])
        }
        "validDto" => (truthy(prop(input, "dto")) && obj(prop(input, "dto"))).into(),
        "dtoPrepare" => dto_prepare(input),
        "dtoFinish" => dto_finish(input),
        "providerPlan" => provider_plan(input),
        "providerRecord" => {
            let r = prop(input, "result");
            object(vec![
                ("kind", or(prop(r, "kind"), "quota".into())),
                ("summary", or(prop(r, "summary"), JsValue::Null)),
                ("summaryText", prop(r, "summaryText").clone()),
                ("barText", or(prop(r, "barText"), JsValue::Null)),
                (
                    "fetchedAt",
                    or(prop(r, "fetchedAt"), prop(input, "now").clone()),
                ),
            ])
        }
        "failurePolicy" => claude(
            "failure",
            vec![
                ("httpStatus", prop(input, "httpStatus").clone()),
                ("targetKind", prop(input, "targetKind").clone()),
                ("previous", prop(prop(input, "previous"), "summary").clone()),
                ("nowMs", js_to_number(prop(input, "now")).into()),
            ],
        ),
        "rejectionPark" => reject("park", input),
        "failureCheck" => failure_check(input),
        "longPark" => (js_to_number(prop(
            prop(prop(input, "previous"), "summary"),
            "blockedUntilMs",
        )) > js_to_number(prop(input, "now")) + PROVIDER_FAILURE_COOLDOWN_MS)
            .into(),
        "cooldown" => cooldown(input),
        "keepsAccountPark" => reject("keeps", input),
        "releaseEligible" => {
            (prop(prop(prop(input, "entry"), "summary"), "revoked") == &JsValue::Bool(true)).into()
        }
        "releaseRecord" => {
            let at = js_to_number(prop(input, "now"));
            object(vec![
                ("kind", "availability".into()),
                (
                    "summary",
                    object(vec![
                        ("kind", "availability".into()),
                        ("status", "available".into()),
                        ("releasedAtMs", at.into()),
                    ]),
                ),
                ("summaryText", "".into()),
                ("barText", JsValue::Null),
                ("fetchedAt", at.into()),
            ])
        }
        "resolveQuery" => {
            let value = prop(input, "value");
            if !matches!(value, JsValue::String(_)) || !truthy(value) {
                return JsValue::Null;
            }
            if eq(prop(input, "kind"), "host") {
                JsValue::String(js_to_string(value).to_lowercase())
            } else {
                url_parts(value)
                    .map(|(host, path)| object(vec![("host", host.into()), ("path", path.into())]))
                    .unwrap_or(JsValue::Null)
            }
        }
        "hostMatches" => {
            let host = prop(input, "host");
            (truthy(host)
                && js_to_string(host).to_lowercase() == js_to_string(prop(input, "query")))
            .into()
        }
        "baseMatches" => {
            let query = prop(input, "query");
            url_parts(prop(input, "baseUrl"))
                .is_some_and(|(h, p)| {
                    h == s(prop(query, "host")) && {
                        let w = s(prop(query, "path"));
                        w.is_empty()
                            || p.is_empty()
                            || w == p
                            || w.starts_with(&p)
                            || p.starts_with(&w)
                    }
                })
                .into()
        }
        "mergeIdentities" => {
            let mut out = vec![];
            for id in arr(prop(input, "ids")) {
                if !out.iter().any(|v| {
                    prop(v, "appType") == prop(id, "appType")
                        && prop(v, "providerId") == prop(id, "providerId")
                }) {
                    out.push(id.clone());
                }
            }
            JsValue::Array(out)
        }
        "vendorPlan" => {
            let r = prop(input, "result");
            if !truthy(r) {
                return JsValue::Null;
            }
            if !eq(prop(r, "status"), "ok") || prop(r, "ok") == &JsValue::Bool(false) {
                object(vec![
                    ("action", "failure".into()),
                    (
                        "value",
                        object(vec![(
                            "error",
                            slice(
                                &or(
                                    prop(r, "reason"),
                                    or(prop(r, "error"), "fetch failed".into()),
                                ),
                                200,
                            ),
                        )]),
                    ),
                ])
            } else {
                object(vec![("action", "record".into())])
            }
        }
        "vendorRender" => {
            let mut opts = object(vec![("baseUrl", prop(input, "baseUrl").clone())]);
            if let JsValue::Object(fields) = prop(input, "opts") {
                for (k, v) in fields {
                    set(&mut opts, &k.to_string_lossy(), v.clone());
                }
            }
            set(&mut opts, "nowMs", js_to_number(prop(input, "now")).into());
            view(
                "renderQuotaBar",
                vec![
                    ("kind", prop(input, "kind").clone()),
                    ("value", prop(input, "result").clone()),
                    ("opts", opts),
                ],
            )
        }
        "vendorWindows" => vendor_windows(
            prop(input, "kind"),
            prop(input, "result"),
            prop(input, "baseUrl"),
        ),
        "vendorRecord" => {
            let kind = prop(input, "kind");
            let r = prop(input, "result");
            let reported = prop(input, "reported");
            let windows = if arr(reported).is_empty() {
                JsValue::Array(vec![])
            } else {
                merge_windows(
                    reported,
                    previous_windows(input),
                    js_to_number(prop(input, "mergeNow")),
                )
            };
            let mut summary = object(vec![
                ("kind", kind.clone()),
                ("status", "ok".into()),
                ("fetchedAt", or(prop(r, "fetchedAt"), JsValue::Null)),
            ]);
            if !arr(&windows).is_empty() {
                set(&mut summary, "windows", windows);
            }
            record(
                kind.clone(),
                summary,
                prop(input, "bar"),
                or(prop(r, "fetchedAt"), prop(input, "now").clone()),
                false,
            )
        }
        "claudePlan" => {
            let r = prop(input, "result");
            if !truthy(r) || !eq(prop(r, "status"), "ok") {
                object(vec![
                    ("action", "failure".into()),
                    (
                        "value",
                        object(vec![(
                            "error",
                            slice(
                                &or(prop(r, "error"), "claude usage unavailable".into()),
                                200,
                            ),
                        )]),
                    ),
                ])
            } else {
                object(vec![
                    ("action", "record".into()),
                    ("needsNow", (!truthy(prop(r, "fetchedAt"))).into()),
                ])
            }
        }
        "claudeRecord" => {
            let r = prop(input, "result");
            let windows = JsValue::Array(
                arr(prop(r, "summary"))
                    .iter()
                    .map(|w| {
                        object(vec![
                            ("window", or(prop(w, "window"), JsValue::Null)),
                            ("label", or(prop(w, "label"), JsValue::Null)),
                            ("usedPercent", nullish(prop(w, "usedPercent"))),
                            ("resetMs", nullish(prop(w, "resetMs"))),
                        ])
                    })
                    .collect(),
            );
            object(vec![
                ("kind", "claude".into()),
                (
                    "summary",
                    object(vec![
                        ("kind", "claude".into()),
                        ("status", "ok".into()),
                        (
                            "fetchedAt",
                            or(prop(r, "fetchedAt"), prop(input, "summaryNow").clone()),
                        ),
                        ("windows", windows),
                    ]),
                ),
                ("summaryText", compact(prop(input, "barText"))),
                ("barText", or(prop(input, "barText"), JsValue::Null)),
                (
                    "fetchedAt",
                    or(prop(r, "fetchedAt"), prop(input, "now").clone()),
                ),
            ])
        }
        "officialValid" => (truthy(prop(input, "providerId"))
            && matches!(prop(input, "windows"), JsValue::Array(_)))
        .into(),
        "officialRecord" => {
            let at = prop(input, "at");
            let app = prop(input, "appType");
            let rows = JsValue::Array(
                arr(prop(input, "windows"))
                    .iter()
                    .filter(|w| truthy(w) && js_to_number(prop(w, "usedPercent")).is_finite())
                    .cloned()
                    .collect(),
            );
            let rows = merge_windows(&rows, previous_windows(input), js_to_number(at));
            let summary = object(vec![
                ("kind", app.clone()),
                ("status", "ok".into()),
                ("fetchedAt", at.clone()),
                ("windows", rows),
            ]);
            let bar = view(
                "providerLimitBar",
                vec![
                    (
                        "entry",
                        object(vec![("kind", app.clone()), ("summary", summary.clone())]),
                    ),
                    ("nowMs", at.clone()),
                ],
            );
            record(app.clone(), summary, &bar, at.clone(), true)
        }
        _ => JsValue::Undefined,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_merge_keeps_distinct_utf16_cycles_and_drops_expired_rows() {
        let make = |window: JsValue, reset: f64| {
            object(vec![
                ("window", window),
                ("usedPercent", 50.0.into()),
                ("resetMs", reset.into()),
            ])
        };
        let next = make(JsValue::String(JsString::from_units(vec![0xd800])), 200.0);
        let live = make(JsValue::String(JsString::from_units(vec![0xd801])), 200.0);
        let expired = make("1wk".into(), 100.0);
        assert_eq!(
            merge_windows(
                &JsValue::Array(vec![next.clone()]),
                &JsValue::Array(vec![live.clone(), expired]),
                100.0
            ),
            JsValue::Array(vec![next, live])
        );
    }

    #[test]
    fn concrete_account_identity_does_not_follow_changed_default() {
        let got = request(
            "providerIdentity",
            &object(vec![
                ("id", "claude-official-0123456789abcdef".into()),
                ("appType", "claude".into()),
                ("activeAccountId", "fedcba9876543210".into()),
            ]),
        );
        assert_eq!(
            prop(&got, "providerId"),
            &JsValue::from("claude-official-0123456789abcdef")
        );
        let alias = request(
            "providerIdentity",
            &object(vec![
                ("id", "claude-official".into()),
                ("appType", "claude".into()),
                ("activeAccountId", "fedcba9876543210".into()),
            ]),
        );
        assert_eq!(
            prop(&alias, "providerId"),
            &JsValue::from("claude-official-fedcba9876543210")
        );
    }

    #[test]
    fn revoked_credential_ignores_short_deadline_and_model_scope() {
        let value = cooldown(&object(vec![
            ("category", "AUTHENTICATION_PERMISSION".into()),
            ("now", 1000.0.into()),
            ("blockedUntilMs", 2000.0.into()),
            ("httpStatus", "401".into()),
            (
                "park",
                object(vec![
                    ("scope", "model".into()),
                    ("blockedUntilMs", 3000.0.into()),
                ]),
            ),
        ]));
        assert_eq!(prop(&value, "needsPrevious"), &JsValue::Bool(false));
        assert_eq!(
            prop(prop(prop(&value, "value"), "summary"), "revoked"),
            &JsValue::Bool(true)
        );
        assert_eq!(
            prop(&value, "until"),
            &JsValue::Number(AUTH_REVOKED_BLOCKED_UNTIL_MS)
        );
    }
}
