//! Antigravity account quota from the official agy CLI. The subprocess is
//! asynchronous, bounded, single-flight and never exposes its raw output.
use super::{
    agy_catalog::executable,
    express::{self, RequestCtx},
};
use axum::{body::Body, http::Response};
use serde_json::{json, Value};
use std::{
    process::Stdio,
    sync::OnceLock,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncReadExt, process::Command, sync::Mutex};

const TTL: Duration = Duration::from_secs(60);
const FAIL_TTL: Duration = Duration::from_secs(30);
const MAX_OUTPUT: u64 = 1024 * 1024;
/// `None` records a failed probe, so a signed-out or offline CLI is not spawned
/// on every page load.
type CacheEntry = Option<(Instant, Option<Value>)>;
static CACHE: OnceLock<Mutex<CacheEntry>> = OnceLock::new();

const GRAY: &str = "#8b949e";
const RED: &str = "#f85149";
const YELLOW: &str = "#d29922";
const BLUE: &str = "#58a6ff";

struct WindowMeta {
    rank: usize,
    token: String,
    period: Option<&'static str>,
    name_key: Option<&'static str>,
}

fn window_meta(window: &str, fallback_name: Option<&str>) -> Option<WindowMeta> {
    match window {
        "5h" => Some(WindowMeta {
            rank: 0,
            token: "5h".to_string(),
            period: Some("5h"),
            name_key: Some("quotaWindowName5h"),
        }),
        "weekly" | "1wk" => Some(WindowMeta {
            rank: 1,
            token: "1wk".to_string(),
            period: Some("1wk"),
            name_key: Some("quotaWindowNameWeekly"),
        }),
        "monthly" | "1m" => Some(WindowMeta {
            rank: 2,
            token: "1m".to_string(),
            period: Some("1m"),
            name_key: Some("quotaWindowNameMonthly"),
        }),
        _ => {
            let label = fallback_name.filter(|s| !s.is_empty()).unwrap_or("?");
            if label.len() > 120 || label.chars().any(char::is_control) {
                return None;
            }
            Some(WindowMeta {
                rank: 3,
                token: label.to_string(),
                period: None,
                name_key: None,
            })
        }
    }
}

fn window_zh<'a>(key: Option<&str>, fallback: &'a str) -> &'a str {
    match key {
        Some("quotaWindowName5h") => "5小时",
        Some("quotaWindowNameWeekly") => "周",
        Some("quotaWindowNameMonthly") => "月",
        _ => fallback,
    }
}

fn cd_token(at_ms: i64, period: Option<&str>) -> String {
    match period {
        Some(win) => format!("{{cd:{at_ms}|{win}}}"),
        None => format!("{{cd:{at_ms}}}"),
    }
}

fn format_local_reset(at_ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(at_ms).map(|dt| {
        dt.with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    })
}

fn agy_vendor_part() -> Value {
    json!({"k": "quotaVendorAgy", "s": "反重力"})
}

fn agy_states() -> Value {
    json!({
        "loading": {
            "text": "反重力：加载中…",
            "title": "正在通过 agy /usage 拉取反重力账号额度...",
            "color": GRAY,
            "action": Value::Null,
            "textParts": [{"k": "quotaLoading", "s": "反重力：加载中…", "p": {"label": agy_vendor_part()}}],
            "titleParts": [{"k": "quotaLoadingTitleAgy", "s": "正在通过 agy /usage 拉取反重力账号额度..."}]
        },
        "unreachable": {
            "text": "反重力 · 请求失败 ⟳ 重试",
            "title": "无法连接 MultiCC 服务，未能取到反重力用量。点击重试。",
            "color": GRAY,
            "action": Value::Null,
            "textParts": [{"k": "quotaUnreachableText", "s": "反重力 · 请求失败 ⟳ 重试", "p": {"label": agy_vendor_part()}}],
            "titleParts": [{"k": "quotaUnreachableTitle", "s": "无法连接 MultiCC 服务，未能取到反重力用量。点击重试。", "p": {"label": agy_vendor_part()}}]
        }
    })
}

fn render(data: &Value, now_ms: u64) -> Option<Value> {
    let groups = data.pointer("/command/data/groups")?.as_array()?;
    let mut group_cells = Vec::new();
    let mut title_lines = vec!["反重力账号额度（agy /usage）".to_string()];
    let mut title_parts = vec![json!({"k": "quotaAgyTitle", "s": "反重力账号额度（agy /usage）"})];
    let mut lowest: u8 = 100;

    for group in groups {
        // One malformed group or bucket must not blank the whole bar: skip what
        // cannot be rendered and keep the rest.
        let Some(name) = group.get("name").and_then(Value::as_str) else {
            continue;
        };
        if name.is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
            continue;
        }
        let group_name = match name {
            "Gemini Models" => "Gemini",
            "Claude and GPT models" => "Claude/GPT",
            other => other,
        };
        let Some(buckets) = group.get("buckets").and_then(Value::as_array) else {
            continue;
        };
        let mut parsed = Vec::new();
        for (idx, bucket) in buckets.iter().enumerate() {
            let Some(remaining) = bucket.get("remaining_fraction").and_then(Value::as_f64) else {
                continue;
            };
            if !(0.0..=1.0).contains(&remaining) {
                continue;
            }
            let window = bucket.get("window").and_then(Value::as_str).unwrap_or("");
            let Some(meta) =
                window_meta(window, bucket.get("name").and_then(Value::as_str))
            else {
                continue;
            };
            let rem_pct = (remaining * 100.0).round().clamp(0.0, 100.0) as u8;
            let used_pct = 100u8.saturating_sub(rem_pct);
            let at = bucket
                .get("reset_time")
                .and_then(Value::as_str)
                .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                .map(|v| v.timestamp_millis())
                .filter(|&v| v > 0);
            parsed.push((meta.rank, idx, meta.token, meta.period, meta.name_key, rem_pct, used_pct, at));
        }
        if parsed.is_empty() {
            continue;
        }
        // Align window order with all other quota bars: 5h -> 1wk -> 1m -> other.
        parsed.sort_by_key(|(rank, idx, ..)| (*rank, *idx));

        let mut segments = Vec::with_capacity(parsed.len());
        title_lines.push(group_name.to_string());
        title_parts.push(json!({"s": group_name}));

        for (_, _, token, period, name_key, rem_pct, used_pct, at) in parsed {
            lowest = lowest.min(rem_pct);
            let cd = at.map(|ms| cd_token(ms, period));
            match &cd {
                Some(cd_str) => segments.push(format!("{token} {rem_pct}% {cd_str}")),
                None => segments.push(format!("{token} {rem_pct}%")),
            }

            let win_zh = window_zh(name_key, &token);
            let win_part = match name_key {
                Some(k) => json!({"k": k, "s": win_zh}),
                None => json!({"s": win_zh}),
            };
            let rem_str = format!("余量 {rem_pct}%");
            let used_str = format!("已用 {used_pct}%");
            let (reset_str, reset_part, exact_str) = match (at, cd) {
                (Some(ms), Some(cd_str)) => {
                    let suffix = format!(" · {cd_str} 后重置");
                    let exact = format_local_reset(ms)
                        .map(|t| format!(" ({t})"))
                        .unwrap_or_default();
                    (
                        suffix.clone(),
                        json!({"k": "quotaResetSuffix", "s": suffix, "p": {"at": cd_str}}),
                        exact,
                    )
                }
                _ => (String::new(), json!(""), String::new()),
            };
            let line = format!("  {win_zh}: {rem_str} · {used_str}{reset_str}{exact_str}");
            title_lines.push(line.clone());
            title_parts.push(json!({
                "k": "quotaAgyBucketLine",
                "s": line,
                "p": {
                    "window": win_part,
                    "remaining": {"k": "quotaRemainingPct", "s": rem_str, "p": {"pct": rem_pct.to_string()}},
                    "used": {"k": "quotaUsedPct", "s": used_str, "p": {"pct": used_pct.to_string()}},
                    "reset": reset_part,
                    "exact": exact_str,
                }
            }));
        }
        group_cells.push(format!("{group_name}: {}", segments.join(" · ")));
    }

    if group_cells.is_empty() {
        return None;
    }

    let color = if lowest <= 10 {
        RED
    } else if lowest <= 30 {
        YELLOW
    } else {
        BLUE
    };

    let body = group_cells.join(" · ");
    let mut text = format!("反重力 · {body}");
    let mut text_parts = vec![agy_vendor_part(), json!({"s": body})];
    if now_ms > 0 {
        let ago = format!("{{ago:{now_ms}}}");
        text.push_str(&format!(" · {ago}"));
        text_parts.push(json!({"s": ago, "j": " · "}));
        let sync_line = format!("同步于 {ago}");
        title_lines.push(sync_line.clone());
        title_parts.push(json!({"k": "quotaSyncAt", "s": sync_line, "p": {"ago": ago}}));
    }
    text.push_str(" ⟳");
    text_parts.push(json!({"s": "⟳", "j": " "}));
    title_lines.push("点击 bar 刷新".to_string());
    title_parts.push(json!({"k": "quotaClickBarRefresh", "s": "点击 bar 刷新"}));

    Some(json!({
        "status": "ok",
        "fetchedAt": now_ms,
        "bar": {
            "text": text,
            "title": title_lines.join("\n"),
            "color": color,
            "action": Value::Null,
            "textParts": text_parts,
            "titleParts": title_parts,
            "states": agy_states(),
        }
    }))
}

async fn fetch() -> Option<Value> {
    let mut command = Command::new(executable());
    command
        .args([
            "-p",
            "/usage",
            "--output-format",
            "json",
            "--print-timeout",
            "30s",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // The quota belongs to the signed-in account, and agy reads its login from
    // `$HOME/.gemini`, so a pinned account is served by pointing HOME at its
    // mini-home. No pin leaves the real home untouched.
    if let Some(home) = super::agy_accounts::home_override() {
        command.env("HOME", home);
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?.take(MAX_OUTPUT + 1);
    let mut bytes = Vec::new();
    stdout.read_to_end(&mut bytes).await.ok()?;
    if bytes.len() as u64 > MAX_OUTPUT || !child.wait().await.ok()?.success() {
        return None;
    }
    let data: Value = serde_json::from_slice(&bytes).ok()?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    render(&data, now_ms)
}

fn unavailable_bar() -> Value {
    json!({
        "status": "unavailable",
        "bar": {
            "text": "反重力：用量暂不可用 · ⟳ 重试",
            "title": "无法读取 agy 账号额度，请确认已登录并检查网络。",
            "color": YELLOW,
            "action": Value::Null,
            "textParts": [{"k": "quotaAgyUnavailableText", "s": "反重力：用量暂不可用 · ⟳ 重试"}],
            "titleParts": [{"k": "quotaAgyUnavailableTitle", "s": "无法读取 agy 账号额度，请确认已登录并检查网络。"}],
            "states": agy_states(),
        }
    })
}

/// The cached bar is the previous account's quota, so an account switch must
/// drop it instead of waiting out the TTL.
pub(super) async fn invalidate() {
    if let Some(cache) = CACHE.get() {
        *cache.lock().await = None;
    }
}

pub async fn handle(ctx: &RequestCtx) -> Response<Body> {
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().await;
    let force = ctx
        .original_url
        .split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .any(|part| part == "force=1");
    if !force {
        if let Some((when, value)) = cache.as_ref() {
            let ttl = if value.is_some() { TTL } else { FAIL_TTL };
            if when.elapsed() < ttl {
                let body = value.clone().unwrap_or_else(unavailable_bar);
                return express::json(ctx, 200, &body, &[("Cache-Control", "no-store")]);
            }
        }
    }
    let result = tokio::time::timeout(Duration::from_secs(35), fetch())
        .await
        .ok()
        .flatten();
    *cache = Some((Instant::now(), result.clone()));
    let value = result.unwrap_or_else(unavailable_bar);
    express::json(ctx, 200, &value, &[("Cache-Control", "no-store")])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_canonical_windows_with_reset_countdown_and_ordering() {
        let now_ms: u64 = 1_795_425_813_000;
        let data = json!({"command":{"data":{"groups":[
            {"name":"Gemini Models","buckets":[
                {"window":"weekly","remaining_fraction":0.9708,"reset_time":"2026-11-30T06:41:45Z"},
                {"window":"5h","remaining_fraction":0.9078,"reset_time":"2026-11-23T11:41:45Z"}
            ]},
            {"name":"Claude and GPT models","buckets":[
                {"window":"weekly","remaining_fraction":1.0,"reset_time":"2026-11-29T11:36:10Z"},
                {"window":"5h","remaining_fraction":1.0,"reset_time":"1970-01-01T00:00:00Z"}
            ]}
        ]}}});
        let v = render(&data, now_ms).unwrap();
        let text = v["bar"]["text"].as_str().unwrap();
        let title = v["bar"]["title"].as_str().unwrap();

        // 5h is sorted before 1wk inside each group, with {cd:<ms>|<window>} and {ago:<now_ms>} ⟳.
        let gemini_5h = chrono::DateTime::parse_from_rfc3339("2026-11-23T11:41:45Z")
            .unwrap()
            .timestamp_millis();
        let gemini_wk = chrono::DateTime::parse_from_rfc3339("2026-11-30T06:41:45Z")
            .unwrap()
            .timestamp_millis();
        let claude_wk = chrono::DateTime::parse_from_rfc3339("2026-11-29T11:36:10Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            text,
            format!(
                "反重力 · Gemini: 5h 91% {{cd:{gemini_5h}|5h}} · 1wk 97% {{cd:{gemini_wk}|1wk}} · Claude/GPT: 5h 100% · 1wk 100% {{cd:{claude_wk}|1wk}} · {{ago:{now_ms}}} ⟳"
            )
        );
        assert_eq!(v["bar"]["color"], BLUE);
        assert!(title.contains("反重力账号额度（agy /usage）"));
        assert!(title.contains(&format!("5小时: 余量 91% · 已用 9% · {{cd:{gemini_5h}|5h}} 后重置")));
        assert!(title.contains(&format!("周: 余量 97% · 已用 3% · {{cd:{gemini_wk}|1wk}} 后重置")));
        assert!(title.contains("5小时: 余量 100% · 已用 0%\n"));
        assert!(title.contains(&format!("同步于 {{ago:{now_ms}}}")));
        assert!(title.contains("点击 bar 刷新"));
        assert!(!title.contains("1970"));
        assert_eq!(v["bar"]["states"]["loading"]["text"], "反重力：加载中…");
        assert_eq!(
            v["bar"]["states"]["unreachable"]["text"],
            "反重力 · 请求失败 ⟳ 重试"
        );
        assert!(v["bar"]["textParts"].is_array());
        assert!(v["bar"]["titleParts"].is_array());
    }

    #[test]
    fn rejects_bad_percentages_and_colors_by_tightest_window() {
        assert!(render(
            &json!({"command":{"data":{"groups":[{"name":"x","buckets":[{"remaining_fraction":1.2}]}]}}}),
            0
        )
        .is_none());
        let warn = render(
            &json!({"command":{"data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"5h","remaining_fraction":0.25},{"window":"weekly","remaining_fraction":0.9}]}]}}}),
            0,
        )
        .unwrap();
        assert_eq!(warn["bar"]["color"], YELLOW);
        assert_eq!(
            warn["bar"]["text"],
            "反重力 · Gemini: 5h 25% · 1wk 90% ⟳"
        );
        let crit = render(
            &json!({"command":{"data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"5h","remaining_fraction":0.08}]}]}}}),
            0,
        )
        .unwrap();
        assert_eq!(crit["bar"]["color"], RED);
        let unavail = unavailable_bar();
        assert_eq!(unavail["bar"]["text"], "反重力：用量暂不可用 · ⟳ 重试");
        assert_eq!(unavail["bar"]["color"], YELLOW);
        assert_eq!(unavail["bar"]["states"]["loading"]["text"], "反重力：加载中…");
    }
}
