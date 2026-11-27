//! Antigravity account quota from the official agy CLI, plus transparent
//! pass-through to the lending Host for relay-shared accounts. Subprocesses are
//! asynchronous, bounded, per-account single-flight and never expose raw output.
use super::{
    agy_catalog::executable,
    express::{self, RequestCtx},
};
use crate::agy_relay_client::{fetch_relay_quota, RelayQuotaError};
use crate::agy_remote_bridge::run_ssh_script;
use axum::{body::Body, http::Response};
use multicc_core::agy_accounts::{self as agy_store, ResolvedAgyAccount};
use multicc_core::agy_remote::{
    build_remote_agy_command_script, RemoteAgyTarget, DEFAULT_REMOTE_AGY_BIN,
};
use multicc_core::egress_plugin::{EgressBinding, LOOPBACK_NO_PROXY};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncReadExt, process::Command, sync::Mutex};

const TTL: Duration = Duration::from_secs(60);
const FAIL_TTL: Duration = Duration::from_secs(30);
const MAX_OUTPUT: u64 = 1024 * 1024;
/// `(when, payload, ok)` — failures are cached for `FAIL_TTL` so a signed-out,
/// offline or revoked account is not probed on every page load.
type CacheSlot = Option<(Instant, Value, bool)>;
type CacheMap = HashMap<String, Arc<Mutex<CacheSlot>>>;
static CACHE: OnceLock<Mutex<CacheMap>> = OnceLock::new();

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
            let Some(meta) = window_meta(window, bucket.get("name").and_then(Value::as_str)) else {
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
            parsed.push((
                meta.rank,
                idx,
                meta.token,
                meta.period,
                meta.name_key,
                rem_pct,
                used_pct,
                at,
            ));
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

fn accounts_home_dir() -> Option<PathBuf> {
    std::env::var_os("MULTICC_AGY_ACCOUNTS_HOME")
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()))
        .or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()))
        .map(PathBuf::from)
}

fn agy_executable() -> OsString {
    std::env::var_os("MULTICC_AGY_BIN")
        .filter(|v| !v.is_empty())
        .unwrap_or_else(executable)
}

async fn fetch_local_with_env(
    home_override: Option<&Path>,
    proxy_url: Option<&str>,
) -> Option<Value> {
    let mut command = Command::new(agy_executable());
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
        .kill_on_drop(true)
        .env_remove("MULTICC_AGY_REMOTE_ACCOUNT_JSON")
        .env_remove("MULTICC_AGY_EGRESS_JSON");
    // The quota belongs to the signed-in account, and agy reads its login from
    // `$HOME/.gemini`, so a pinned account is served by pointing HOME at its
    // mini-home. No pin leaves the real home untouched.
    if let Some(home) = home_override {
        command.env("HOME", home);
    }
    if let Some(url) = proxy_url {
        command
            .env("HTTP_PROXY", url)
            .env("HTTPS_PROXY", url)
            .env("ALL_PROXY", url)
            .env("http_proxy", url)
            .env("https_proxy", url)
            .env("all_proxy", url)
            .env("NO_PROXY", LOOPBACK_NO_PROXY)
            .env("no_proxy", LOOPBACK_NO_PROXY);
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

fn parse_usage_json(stdout: &str) -> Option<Value> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Some(v);
    }
    if let Some(start) = trimmed.find('{') {
        if let Ok(v) = serde_json::from_str::<Value>(&trimmed[start..]) {
            return Some(v);
        }
    }
    None
}

/// 通过 SSH 桥接向远端 Host 拉取反重力账号用量（复用与本地一致的 `agy -p /usage` 与渲染逻辑）。
async fn fetch_ssh_quota(remote: &RemoteAgyTarget) -> Result<Value, String> {
    let agy_bin = remote
        .remote_agy_bin
        .as_deref()
        .unwrap_or(DEFAULT_REMOTE_AGY_BIN);
    let script = build_remote_agy_command_script(
        agy_bin,
        remote.remote_home.as_deref(),
        remote.host_account_id.as_deref(),
        &["-p", "/usage", "--output-format", "json", "--print-timeout", "30s"],
    );
    let (code, stdout, stderr) = run_ssh_script(remote, &script, Duration::from_secs(35)).await?;
    if code != 0 {
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(if detail.is_empty() {
            format!("远端 agy /usage 执行失败（exit {code}）")
        } else {
            format!("远端 agy /usage 执行失败（exit {code}）：{detail}")
        });
    }
    if stdout.len() as u64 > MAX_OUTPUT {
        return Err("远端 agy /usage 输出超出大小限制".to_string());
    }
    let data = parse_usage_json(&stdout)
        .ok_or_else(|| "无法解析远端 agy /usage 返回的 JSON 数据".to_string())?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间异常".to_string())?
        .as_millis() as u64;
    render(&data, now_ms).ok_or_else(|| "远端反重力用量数据不完整，请确认远端已登录 agy".to_string())
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

fn unavailable_bar_with(text: &str, title: &str, error: Option<&str>) -> Value {
    let mut out = json!({
        "status": "unavailable",
        "bar": {
            "text": text,
            "title": title,
            "color": YELLOW,
            "action": Value::Null,
            "textParts": [{"s": text}],
            "titleParts": [{"s": title}],
            "states": agy_states(),
        }
    });
    if let Some(err) = error {
        if let Some(obj) = out.as_object_mut() {
            obj.insert("error".to_string(), json!(err));
        }
    }
    out
}

async fn slot_for(cache_key: &str) -> Arc<Mutex<CacheSlot>> {
    let mut map = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .await;
    map.entry(cache_key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone()
}

async fn cached_query<F, Fut>(cache_key: &str, force: bool, producer: F) -> Value
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = (Value, bool)>,
{
    let slot = slot_for(cache_key).await;
    let mut guard = slot.lock().await;
    if !force {
        if let Some((when, value, ok)) = guard.as_ref() {
            let ttl = if *ok { TTL } else { FAIL_TTL };
            if when.elapsed() < ttl {
                return value.clone();
            }
        }
    }
    let (value, ok) = producer().await;
    *guard = Some((Instant::now(), value.clone(), ok));
    value
}

/// 查询 Host 本机某个隔离反重力账号的额度（供本机 `/api/agy/quota` 与借道 Host `/agy-proxy/<id>/quota` 复用）。
///
/// 绑定了 `chrome-proxy-launcher` 专用出口时采用 fail-closed：实时解析出口并注入代理环境，
/// 出口不可用时直接返回不可用提示，绝不静默走 Host 默认出口 IP。
pub(crate) async fn query_local_account(
    account_id: &str,
    account_home: &Path,
    egress_binding: Option<&EgressBinding>,
    force: bool,
) -> Value {
    let cache_key = format!("local:{account_id}");
    cached_query(&cache_key, force, || async {
        let proxy_url = if let Some(binding) = egress_binding {
            match crate::egress_runtime::resolve_egress_proxy_url(binding).await {
                Ok(url) => Some(url),
                Err(err) => {
                    let msg = format!("Host 账号专用出口不可用：{err}");
                    return (
                        unavailable_bar_with("反重力：专用出口不可用 · ⟳ 重试", &msg, Some(&msg)),
                        false,
                    );
                }
            }
        } else {
            None
        };
        let result = tokio::time::timeout(
            Duration::from_secs(35),
            fetch_local_with_env(Some(account_home), proxy_url.as_deref()),
        )
        .await
        .ok()
        .flatten();
        match result {
            Some(v) => (v, true),
            None => (unavailable_bar(), false),
        }
    })
    .await
}

fn parse_query_flag<'a>(original_url: &'a str, name: &str) -> Option<&'a str> {
    let qs = original_url.split('?').nth(1)?;
    for part in qs.split('&') {
        if let Some((k, v)) = part.split_once('=') {
            if k == name {
                return Some(v);
            }
        }
    }
    None
}

/// The cached bar is the previous account's quota, so an account switch must
/// drop it instead of waiting out the TTL.
pub(super) async fn invalidate() {
    if let Some(cache) = CACHE.get() {
        cache.lock().await.clear();
    }
}

pub async fn handle(ctx: &RequestCtx) -> Response<Body> {
    let force = parse_query_flag(&ctx.original_url, "force") == Some("1");
    let explicit_id = parse_query_flag(&ctx.original_url, "accountId")
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let Some(home) = accounts_home_dir() else {
        let body = unavailable_bar_with(
            "反重力：用量暂不可用 · ⟳ 重试",
            "无法定位 HOME 目录，未能读取反重力账号额度。",
            Some("无法定位 HOME 目录"),
        );
        return express::json(ctx, 200, &body, &[("Cache-Control", "no-store")]);
    };

    let body = match agy_store::resolve_account(&home, explicit_id) {
        Ok(None) => {
            cached_query("__default__", force, || async {
                let result =
                    tokio::time::timeout(Duration::from_secs(35), fetch_local_with_env(None, None))
                        .await
                        .ok()
                        .flatten();
                match result {
                    Some(v) => (v, true),
                    None => (unavailable_bar(), false),
                }
            })
            .await
        }
        Ok(Some(ResolvedAgyAccount::Local {
            home: account_home,
            egress_binding,
        })) => {
            let acct_id = explicit_id
                .map(str::to_owned)
                .or_else(|| agy_store::active_id(&home))
                .unwrap_or_else(|| "local".to_string());
            query_local_account(&acct_id, &account_home, egress_binding.as_ref(), force).await
        }
        Ok(Some(ResolvedAgyAccount::Remote { id, remote, .. })) if remote.is_relay() => {
            let cache_key = format!("relay:{id}");
            cached_query(&cache_key, force, || async {
                match fetch_relay_quota(&remote, force).await {
                    Ok(v) => (v, true),
                    Err(RelayQuotaError::Revoked) => {
                        let msg = "反重力借道分享码已被撤销或无效，请向出借方重新获取";
                        (
                            unavailable_bar_with("反重力：分享码已失效 · ⟳ 重试", msg, Some(msg)),
                            false,
                        )
                    }
                    Err(RelayQuotaError::NotFound) => {
                        let msg =
                            "远端 Host 上对应的反重力账号已不存在，或 Host 尚未升级支持反重力借道用量查询";
                        (
                            unavailable_bar_with("反重力：借道用量不可用 · ⟳ 重试", msg, Some(msg)),
                            false,
                        )
                    }
                    Err(RelayQuotaError::Unavailable(detail)) => (
                        unavailable_bar_with(
                            "反重力：借道用量暂不可用 · ⟳ 重试",
                            &detail,
                            Some(&detail),
                        ),
                        false,
                    ),
                }
            })
            .await
        }
        Ok(Some(ResolvedAgyAccount::Remote { id, remote, .. })) => {
            let cache_key = format!("ssh:{id}");
            cached_query(&cache_key, force, || async {
                match fetch_ssh_quota(&remote).await {
                    Ok(v) => (v, true),
                    Err(detail) => (
                        unavailable_bar_with(
                            "反重力：SSH 远端用量暂不可用 · ⟳ 重试",
                            &detail,
                            Some(&detail),
                        ),
                        false,
                    ),
                }
            })
            .await
        }
        Err(err) => unavailable_bar_with("反重力：账号不可用 · ⟳ 重试", &err, Some(&err)),
    };

    express::json(ctx, 200, &body, &[("Cache-Control", "no-store")])
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
        assert!(title.contains(&format!(
            "5小时: 余量 91% · 已用 9% · {{cd:{gemini_5h}|5h}} 后重置"
        )));
        assert!(title.contains(&format!(
            "周: 余量 97% · 已用 3% · {{cd:{gemini_wk}|1wk}} 后重置"
        )));
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
        assert_eq!(warn["bar"]["text"], "反重力 · Gemini: 5h 25% · 1wk 90% ⟳");
        let crit = render(
            &json!({"command":{"data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"5h","remaining_fraction":0.08}]}]}}}),
            0,
        )
        .unwrap();
        assert_eq!(crit["bar"]["color"], RED);
        let unavail = unavailable_bar();
        assert_eq!(unavail["bar"]["text"], "反重力：用量暂不可用 · ⟳ 重试");
        assert_eq!(unavail["bar"]["color"], YELLOW);
        assert_eq!(
            unavail["bar"]["states"]["loading"]["text"],
            "反重力：加载中…"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn query_local_account_injects_egress_proxy_and_client_relays_quota() {
        use axum::http::Request;
        use http_body_util::BodyExt;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let _guard = crate::egress_runtime::TEST_ENV_LOCK.lock().await;
        invalidate().await;

        let root = std::env::temp_dir().join(format!(
            "multicc-agy-quota-relay-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let host_home = root.join("host-home");
        let client_home = root.join("client-home");
        let bin_dir = root.join("bin");
        std::fs::create_dir_all(&host_home).unwrap();
        std::fs::create_dir_all(&client_home).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();

        let fake_agy = bin_dir.join("agy");
        std::fs::write(
            &fake_agy,
            r#"#!/bin/sh
if [ "$HTTPS_PROXY" != "http://127.0.0.1:49999" ]; then
  echo "missing proxy: $HTTPS_PROXY" >&2
  exit 2
fi
printf '{"command":{"data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"5h","remaining_fraction":0.88}]}]}}}'
"#,
        )
        .unwrap();
        std::fs::set_permissions(&fake_agy, std::fs::Permissions::from_mode(0o755)).unwrap();

        std::env::set_var("MULTICC_AGY_BIN", &fake_agy);
        std::env::set_var("MULTICC_EGRESS_PROXY_OVERRIDE", "http://127.0.0.1:49999");

        // 1) Host local account with bound egress injects HTTPS_PROXY and renders quota.
        let created = agy_store::create_account_with_egress(
            &host_home,
            "Host 代理账号",
            "created",
            Some(&json!({ "pluginId": "chrome-proxy-launcher", "profileId": "us-1" })),
        )
        .unwrap();
        let host_id = created["id"].as_str().unwrap().to_string();
        let acct_home = agy_store::account_home(&host_home, &host_id).unwrap();
        let egress = agy_store::get_account_egress(&host_home, &host_id);
        let host_quota = query_local_account(&host_id, &acct_home, egress.as_ref(), true).await;
        assert_eq!(host_quota["status"], "ok");
        assert!(host_quota["bar"]["text"]
            .as_str()
            .unwrap()
            .contains("Gemini: 5h 88%"));

        // 2) Client active relay account transparently forwards /api/agy/quota to Host /agy-proxy/<id>/quota
        //    with caching and ?force=1 passthrough.
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_srv = hits.clone();
        let quota_payload = host_quota.to_string();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let srv = tokio::spawn(async move {
            for expected_force in [false, true] {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 2048];
                let n = sock.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..n]);
                if expected_force {
                    assert!(req.contains("/quota?force=1 "));
                } else {
                    assert!(req.contains("/quota "));
                }
                hits_srv.fetch_add(1, Ordering::SeqCst);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    quota_payload.len(),
                    quota_payload
                );
                sock.write_all(resp.as_bytes()).await.unwrap();
            }
        });

        let relay_acct = agy_store::create_remote_account(
            &client_home,
            "借道反重力",
            &json!({
                "transport": "relay",
                "relayBaseUrl": format!("http://127.0.0.1:{port}/agy-proxy/{host_id}"),
                "relayAuthToken": "mcr1.0123456789abcdef.secret8888",
            }),
        )
        .unwrap();
        let client_acct_id = relay_acct["id"].as_str().unwrap();
        agy_store::set_active(&client_home, Some(client_acct_id)).unwrap();
        std::env::set_var("MULTICC_AGY_ACCOUNTS_HOME", &client_home);
        invalidate().await;

        async fn call_handle(uri: &str) -> Value {
            let (parts, _) = Request::builder().uri(uri).body(()).unwrap().into_parts();
            let ctx = RequestCtx::new(&parts);
            let resp = handle(&ctx).await;
            let bytes = resp.into_body().collect().await.unwrap().to_bytes();
            serde_json::from_slice::<Value>(&bytes).unwrap()
        }

        let r1 = call_handle("/api/agy/quota").await;
        assert_eq!(r1["status"], "ok");
        assert_eq!(r1["transport"], "relay");
        assert!(r1["bar"]["text"]
            .as_str()
            .unwrap()
            .contains("Gemini: 5h 88%"));
        assert_eq!(hits.load(Ordering::SeqCst), 1);

        // Second non-forced call hits cache.
        let r2 = call_handle("/api/agy/quota").await;
        assert_eq!(r2["status"], "ok");
        assert_eq!(hits.load(Ordering::SeqCst), 1);

        // Forced call bypasses cache and forwards ?force=1 to Host.
        let r3 = call_handle("/api/agy/quota?force=1").await;
        assert_eq!(r3["status"], "ok");
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        let _ = srv.await;

        assert!(crate::ws_agy_relay::claims_quota(&format!(
            "/agy-proxy/{host_id}/quota"
        )));
        assert!(!crate::ws_agy_relay::claims_quota(
            "/agy-proxy/bad-id/quota"
        ));

        std::env::remove_var("MULTICC_AGY_ACCOUNTS_HOME");
        std::env::remove_var("MULTICC_AGY_BIN");
        std::env::remove_var("MULTICC_EGRESS_PROXY_OVERRIDE");
        invalidate().await;
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ssh_remote_account_bridges_quota_over_ssh() {
        use axum::http::Request;
        use http_body_util::BodyExt;
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "multicc-agy-ssh-quota-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let client_home = root.join("client");
        std::fs::create_dir_all(&client_home).unwrap();

        let fake_agy = root.join("fake-agy");
        std::fs::write(
            &fake_agy,
            r#"#!/bin/sh
printf '%s\n' '{"command":{"data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"5h","remaining_fraction":0.82,"reset_time":"2026-11-30T06:41:45Z"}]}]}}}'
"#,
        )
        .unwrap();
        std::fs::set_permissions(&fake_agy, std::fs::Permissions::from_mode(0o755)).unwrap();

        let fake_ssh = root.join("fake-ssh");
        std::fs::write(&fake_ssh, "#!/bin/sh\nexec /bin/sh -s\n").unwrap();
        std::fs::set_permissions(&fake_ssh, std::fs::Permissions::from_mode(0o755)).unwrap();

        let ssh_acct = agy_store::create_remote_account(
            &client_home,
            "SSH 借用反重力",
            &json!({
                "transport": "ssh",
                "sshTarget": "user@host.test",
                "sshPort": 32303,
                "remoteAgyBin": fake_agy.to_string_lossy(),
                "fileMode": "mutagen",
            }),
        )
        .unwrap();
        let acct_id = ssh_acct["id"].as_str().unwrap();
        agy_store::set_active(&client_home, Some(acct_id)).unwrap();
        std::env::set_var("MULTICC_AGY_ACCOUNTS_HOME", &client_home);
        std::env::set_var("MULTICC_SSH_BIN", &fake_ssh);
        invalidate().await;

        let (parts, _) = Request::builder()
            .uri("/api/agy/quota")
            .body(())
            .unwrap()
            .into_parts();
        let ctx = RequestCtx::new(&parts);
        let resp = handle(&ctx).await;
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(body["status"], "ok");
        assert!(body["bar"]["text"]
            .as_str()
            .unwrap()
            .contains("Gemini: 5h 82%"));

        std::env::remove_var("MULTICC_AGY_ACCOUNTS_HOME");
        std::env::remove_var("MULTICC_SSH_BIN");
        invalidate().await;
        let _ = std::fs::remove_dir_all(&root);
    }
}
