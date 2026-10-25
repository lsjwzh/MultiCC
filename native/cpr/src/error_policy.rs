//! 区分「额度墙」和「瞬时限流」。额度墙在 CLI 自己的秒级重试里不可能成功，
//! 只能靠 `x-should-retry: false` 让它立刻停手；RPM/并发限流必须留给 CLI 退避。
use serde_json::{Map, Value};

const INSPECT: usize = 64 * 1024;

// 额度/账单类业务码。智谱 1302/1303/1305 是并发和频率限流，必须留在可重试一侧。
const CODES: &[&str] = &[
    "insufficient_quota",
    "billing_error",
    "usage_limit_exceeded",
    "quota_exceeded",
    "insufficient_balance",
    "credit_balance_exhausted",
    "1113",
    "1304",
    "1308",
    "1309",
    "1310",
];

// 与 src/chat/api-error-policy.js 的 QUOTA_EXHAUSTION_RES 对齐；去掉裸 `\b402\b`
// （429 正文顺带提到 402 只是噪声），补上供应商的订阅限额原文措辞。
const PHRASES: &[&str] = &[
    "insufficient balance",
    "insufficient quota",
    "insufficient credit",
    "insufficient funds",
    "billing",
    "usage limit",
    "credit balance",
    "waiting for the reset",
    "upgrade your plan",
    "purchase extra usage",
    "hit your limit",
    "reached your limit",
    "exceed your account's rate limit",
    "exceed your account’s rate limit",
    "额度不足",
    "余额不足",
    "剩余额度",
    "额度已用尽",
    "额度用尽",
    "配额不足",
    "配额已用尽",
    "超出配额",
    "用量上限",
    "使用上限",
    "今日上限",
    "已欠费",
    "套餐已到期",
];

fn unified_rejected(headers: &Map<String, Value>) -> bool {
    headers.iter().any(|(name, value)| {
        let name = name.to_ascii_lowercase();
        let unified = name == "anthropic-ratelimit-unified-status"
            || (name.starts_with("anthropic-ratelimit-unified-") && name.ends_with("-status"));
        unified && value.as_str().is_some_and(|v| v.eq_ignore_ascii_case("rejected"))
    })
}

// 小写并把换行/多空白压成单个空格，让跨行措辞也能整句匹配。
fn flat(raw: &str) -> String {
    raw.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
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

fn wording(text: &str) -> bool {
    PHRASES.iter().any(|p| text.contains(p))
        || near(text, &["exceed"], &["quota"], 60)
        || near(
            text,
            &["quota"],
            &["exceeded", "exhausted", "reached", "depleted", "used up", "reset"],
            40,
        )
        || near(
            text,
            &[
                "weekly", "daily", "monthly", "hourly", "5-hour", "five-hour", "7-day", "24-hour",
            ],
            &["quota", "limit"],
            40,
        )
}

fn code(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    [&value["error"]["code"], &value["error"]["type"], &value["code"], &value["type"]]
        .iter()
        .any(|v| match v {
            Value::String(s) => CODES.contains(&s.trim().to_lowercase().as_str()),
            Value::Number(n) => CODES.contains(&n.to_string().as_str()),
            _ => false,
        })
}

/// 只有 429 可能是额度墙；其余状态一律按普通上游错误处理。
pub fn quota_wall(status: u16, headers: &Map<String, Value>, body: &[u8]) -> bool {
    if status != 429 {
        return false;
    }
    if unified_rejected(headers) {
        return true;
    }
    let raw = String::from_utf8_lossy(&body[..body.len().min(INSPECT)]);
    wording(&flat(&raw)) || code(&raw)
}
