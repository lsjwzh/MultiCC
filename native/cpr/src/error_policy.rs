//! 区分「额度墙」和「瞬时限流」。额度墙在 CLI 自己的秒级重试里不可能成功，
//! 只能靠 `x-should-retry: false` 让它立刻停手；RPM/并发限流必须留给 CLI 退避。
//! `classify` 在布尔判断之上给出结构化归因（瞬时限流/额度窗口/模型权益/账单），
//! 宿主据此向用户解释这次 429 的真实原因以及何时可以重试。
use serde_json::{json, Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

const INSPECT: usize = 64 * 1024;

// 账单/余额耗尽的业务码。
const BILLING_CODES: &[&str] = &[
    "insufficient_quota",
    "insufficient_balance",
    "credit_balance_exhausted",
    "billing_error",
    "1113",
    "1309",
];

// 额度窗口耗尽的业务码；第二列是该码已知的窗口粒度。
const WINDOW_CODES: &[(&str, Option<&str>)] = &[
    ("usage_limit_reached", None),
    ("usage_limit_exceeded", None),
    ("quota_exceeded", None),
    ("1308", Some("5h")),
    ("1310", Some("1wk")),
    ("1304", Some("1d")),
];

// 正文兜底措辞。账单类先判，避免「余额不足」被当成普通额度窗口。
const BILLING_TEXT: &[&str] = &[
    "insufficient balance",
    "insufficient funds",
    "insufficient credit",
    "billing",
    "credit balance",
    "余额不足",
    "已欠费",
    "套餐已到期",
];

// 与 src/chat/api-error-policy.js 的 QUOTA_EXHAUSTION_RES 对齐；去掉裸 `\b402\b`
// （429 正文顺带提到 402 只是噪声），补上供应商的订阅限额原文措辞。
const QUOTA_TEXT: &[&str] = &[
    "insufficient quota",
    "usage limit",
    "waiting for the reset",
    "upgrade your plan",
    "purchase extra usage",
    "hit your limit",
    "reached your limit",
    "exceed your account's rate limit",
    "exceed your account’s rate limit",
    "额度不足",
    "剩余额度",
    "额度已用尽",
    "额度用尽",
    "配额不足",
    "配额已用尽",
    "超出配额",
    "用量上限",
    "使用上限",
    "今日上限",
];

// 模型权益拒绝：账号本身有额度，但这个模型不在当前套餐里。
const ENTITLEMENT_TEXT: &[&str] = &[
    "usage credits are required",
    "extra usage is required",
    "not available on your plan",
    "not included in your plan",
    "暂未开放",
    "套餐不支持",
];

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0)
}

fn header<'a>(headers: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value)
}

fn header_text<'a>(headers: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    header(headers, name).and_then(Value::as_str)
}

fn header_num(headers: &Map<String, Value>, name: &str) -> Option<f64> {
    header(headers, name).and_then(number)
}

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

// 供应商的 reset 字段混用秒和毫秒；小于 1e10 的一律按秒理解。
fn epoch_ms(value: f64) -> f64 {
    if value > 0.0 && value < 1e10 {
        value * 1000.0
    } else {
        value
    }
}

fn unified_rejected(headers: &Map<String, Value>) -> bool {
    headers.iter().any(|(name, value)| {
        let name = name.to_ascii_lowercase();
        let unified = name == "anthropic-ratelimit-unified-status"
            || (name.starts_with("anthropic-ratelimit-unified-") && name.ends_with("-status"));
        unified
            && value
                .as_str()
                .is_some_and(|v| v.eq_ignore_ascii_case("rejected"))
    })
}

// 小写并把换行/多空白压成单个空格，让跨行措辞也能整句匹配。
fn flat(raw: &str) -> String {
    raw.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn head(text: &str, max: usize) -> &str {
    match text.char_indices().find(|(i, c)| i + c.len_utf8() > max) {
        Some((i, _)) => &text[..i],
        None => text,
    }
}

// 对应 JS 的 `trigger[^.\n]{0,max}follower`：不跨句号，窗口按字节截断。
fn near(text: &str, triggers: &[&str], followers: &[&str], max: usize) -> bool {
    triggers.iter().any(|trigger| {
        text.match_indices(trigger).any(|(at, _)| {
            let rest = &text[at + trigger.len()..];
            let sentence = &rest[..rest.find('.').unwrap_or(rest.len())];
            let window = head(sentence, max);
            followers.iter().any(|f| window.contains(f))
        })
    })
}

fn ms(value: f64) -> Value {
    if value.fract() == 0.0 && (0.0..=i64::MAX as f64).contains(&value) {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn reject(
    kind: &str,
    scope: &str,
    window: Option<&str>,
    reset_ms: Option<f64>,
    code: Option<&str>,
    source: &str,
) -> Value {
    json!({
        "kind": kind,
        "scope": scope,
        "window": window,
        "resetMs": reset_ms.map(ms),
        "code": code,
        "model": Value::Null,
        "source": source,
    })
}

fn structured_codes(body: &Value) -> Vec<String> {
    [
        &body["error"]["code"],
        &body["error"]["type"],
        &body["code"],
        &body["type"],
    ]
    .into_iter()
    .filter_map(|value| match value {
        Value::String(s) => Some(s.trim().to_ascii_lowercase()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
    .collect()
}

// 规则 1：模型权益拒绝。Claude Code CLI 自己也不会重试这类 429。
fn entitlement(body: Option<&Value>, text: &str) -> Option<Value> {
    let coded = body.is_some_and(|value| {
        [
            &value["error"]["details"]["error_code"],
            &value["details"]["error_code"],
        ]
        .iter()
        .any(|code| {
            code.as_str()
                .is_some_and(|s| s.trim().eq_ignore_ascii_case("credits_required"))
        })
    });
    if coded {
        return Some(reject(
            "entitlement",
            "model",
            None,
            None,
            Some("credits_required"),
            "code",
        ));
    }
    ENTITLEMENT_TEXT
        .iter()
        .any(|phrase| text.contains(phrase))
        .then(|| reject("entitlement", "model", None, None, None, "text"))
}

// 规则 2：Anthropic 订阅限额响应头。
fn unified(headers: &Map<String, Value>) -> Option<Value> {
    if !unified_rejected(headers) {
        return None;
    }
    let claim = header_text(headers, "anthropic-ratelimit-unified-representative-claim")
        .map(|claim| claim.trim().to_ascii_lowercase());
    let claim = claim.as_deref().unwrap_or("");
    let (kind, scope, window, resets) = match claim {
        "five_hour" => (
            "window",
            "account",
            Some("5h"),
            &[
                "anthropic-ratelimit-unified-5h-reset",
                "anthropic-ratelimit-unified-reset",
            ][..],
        ),
        "seven_day" => (
            "window",
            "account",
            Some("1wk"),
            &[
                "anthropic-ratelimit-unified-7d-reset",
                "anthropic-ratelimit-unified-reset",
            ][..],
        ),
        "seven_day_opus" | "seven_day_sonnet" | "seven_day_overage_included" => (
            "window",
            "model",
            Some("1wk"),
            &[
                "anthropic-ratelimit-unified-7d-reset",
                "anthropic-ratelimit-unified-reset",
            ][..],
        ),
        "overage" => (
            "billing",
            "account",
            None,
            &[
                "anthropic-ratelimit-unified-overage-reset",
                "anthropic-ratelimit-unified-reset",
            ][..],
        ),
        _ => (
            "window",
            "account",
            None,
            &["anthropic-ratelimit-unified-reset"][..],
        ),
    };
    let reset = resets
        .iter()
        .find_map(|name| header_num(headers, name))
        .map(epoch_ms);
    let code = (!claim.is_empty()).then_some(claim);
    Some(reject(kind, scope, window, reset, code, "headers"))
}

// 规则 3：正文里的结构化业务码。
fn by_code(body: &Value, now: f64) -> Option<Value> {
    for code in structured_codes(body) {
        if BILLING_CODES.contains(&code.as_str()) {
            return Some(reject(
                "billing",
                "account",
                None,
                None,
                Some(&code),
                "code",
            ));
        }
        if let Some((name, window)) = WINDOW_CODES.iter().find(|(name, _)| code == *name) {
            // OpenAI/Codex 用相对或绝对 reset 字段携带窗口结束时间。
            let reset = (code == "usage_limit_reached")
                .then(|| limit_reset(body, now))
                .flatten();
            return Some(reject(
                "window",
                "account",
                *window,
                reset,
                Some(*name),
                "code",
            ));
        }
    }
    None
}

fn limit_reset(body: &Value, now: f64) -> Option<f64> {
    number(&body["error"]["resets_in_seconds"])
        .map(|seconds| now + seconds * 1000.0)
        .or_else(|| number(&body["error"]["resets_at"]).map(epoch_ms))
}

fn infer_window(text: &str) -> Option<&'static str> {
    [
        (&["5-hour", "five-hour", "5 小时", "5小时"][..], "5h"),
        (&["weekly", "7-day", "每周", "本周"][..], "1wk"),
        (&["daily", "24-hour", "今日", "每日"][..], "1d"),
        (&["monthly", "每月"][..], "1m"),
    ]
    .into_iter()
    .find(|(marks, _)| marks.iter().any(|mark| text.contains(mark)))
    .map(|(_, window)| window)
}

// 规则 4：正文措辞兜底。
fn wording(text: &str) -> Option<Value> {
    if BILLING_TEXT.iter().any(|phrase| text.contains(phrase)) {
        return Some(reject("billing", "account", None, None, None, "text"));
    }
    let quota = QUOTA_TEXT.iter().any(|phrase| text.contains(phrase))
        || near(text, &["exceed"], &["quota"], 60)
        || near(
            text,
            &["quota"],
            &[
                "exceeded",
                "exhausted",
                "reached",
                "depleted",
                "used up",
                "reset",
            ],
            40,
        )
        || near(
            text,
            &[
                "weekly",
                "daily",
                "monthly",
                "hourly",
                "5-hour",
                "five-hour",
                "7-day",
                "24-hour",
            ],
            &["quota", "limit"],
            40,
        );
    quota.then(|| reject("window", "account", infer_window(text), None, None, "text"))
}

// 规则 5：真正的瞬时限流，保留任何结构化业务码便于宿主排查。
fn transient(body: Option<&Value>) -> Value {
    let code = body.and_then(|value| structured_codes(value).into_iter().next());
    reject(
        "transient",
        "request",
        None,
        None,
        code.as_deref(),
        "status",
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

// Retry-After 允许 IMF-fixdate（`Sun, 06 Nov 1994 08:49:37 GMT`），只解析这一种常见格式。
fn http_date_ms(raw: &str) -> Option<f64> {
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let rest = raw.split_once(", ").map_or(raw, |(_, rest)| rest);
    let parts: Vec<&str> = rest.split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    let day: i64 = parts[0].parse().ok()?;
    let month = 1 + MONTHS
        .iter()
        .position(|month| month.eq_ignore_ascii_case(parts[1]))? as i64;
    let year: i64 = parts[2].parse().ok()?;
    let clock: Vec<i64> = parts[3]
        .split(':')
        .filter_map(|value| value.parse().ok())
        .collect();
    if clock.len() != 3 {
        return None;
    }
    let seconds =
        days_from_civil(year, month, day) * 86400 + clock[0] * 3600 + clock[1] * 60 + clock[2];
    Some((seconds * 1000) as f64)
}

fn retry_after(headers: &Map<String, Value>, now: f64) -> Option<f64> {
    if let Some(delay) = header_num(headers, "retry-after-ms").filter(|value| *value > 0.0) {
        return Some(now + delay);
    }
    let raw = header_text(headers, "retry-after")?.trim();
    if let Ok(seconds) = raw.parse::<f64>() {
        return (seconds > 0.0).then_some(now + seconds * 1000.0);
    }
    http_date_ms(raw).filter(|value| *value > 0.0)
}

/// 结构化归因：只有 429 需要归因，其余状态是普通上游错误（None）。
/// 返回值固定包含 kind/scope/window/resetMs/code/model/source 七个字段。
pub fn classify(
    status: u16,
    headers: &Map<String, Value>,
    body: &[u8],
    model: Option<&str>,
) -> Option<Value> {
    classify_at(status, headers, body, model, now_ms())
}

/// 与 `classify` 相同，但把当前时间注入进来，便于确定性测试。
pub fn classify_at(
    status: u16,
    headers: &Map<String, Value>,
    body: &[u8],
    model: Option<&str>,
    now: f64,
) -> Option<Value> {
    if status != 429 {
        return None;
    }
    let raw = String::from_utf8_lossy(&body[..body.len().min(INSPECT)]);
    let text = flat(&raw);
    let parsed: Option<Value> = serde_json::from_str(&raw).ok();
    let parsed = parsed.as_ref();
    let mut result = entitlement(parsed, &text)
        .or_else(|| unified(headers))
        .or_else(|| parsed.and_then(|body| by_code(body, now)))
        .or_else(|| wording(&text))
        .unwrap_or_else(|| transient(parsed));
    result["model"] = model.map_or(Value::Null, Value::from);
    if result["resetMs"].is_null() {
        if let Some(reset) = retry_after(headers, now) {
            result["resetMs"] = ms(reset);
        }
    }
    Some(result)
}

/// 只有 429 可能是额度墙；其余状态一律按普通上游错误处理。
/// 等价于「不是瞬时限流」，保持旧的布尔语义。
pub fn quota_wall(status: u16, headers: &Map<String, Value>, body: &[u8]) -> bool {
    classify(status, headers, body, None)
        .is_some_and(|result| result["kind"].as_str() != Some("transient"))
}
