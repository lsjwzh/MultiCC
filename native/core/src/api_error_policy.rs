//! The pure policy of `src/chat/api-error-policy.js`: the category tables, the
//! envelope scanner, text classification and the retry decision.
//!
//! Values arrive through the lossless [`JsValue`] bridge, so `undefined`,
//! `null`, lone surrogates and non-decimal numbers keep their meaning. The few
//! host-defined dependencies (the provider classifier, the upstream extractor,
//! the rejection contract and `Date.parse`) are evaluated by the caller and
//! handed in; nothing here reaches back into the engine.
//!
//! Every regex keeps the JavaScript non-`u` semantics of the original: it runs
//! on the UTF-16 unit view of [`crate::js::regex`], `\s`, `\w`, `\d` are spelled
//! as their ECMAScript classes, `\b` is the ASCII word boundary, `.` excludes
//! all four line terminators, and `/i` folds ASCII letters only (without `u` a
//! JS regex never maps a non-ASCII character onto an ASCII one).

use crate::js::regex::{from_unit_view, to_unit_view, SPACE, WORD};
use crate::js::{
    is_js_whitespace, js_string_to_number, js_to_number, js_to_string, number_to_string, truthy,
    JsString, JsValue,
};
use crate::redaction;
use regex::Regex;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

pub const CATEGORIES: [&str; 12] = [
    "authentication_permission",
    "billing_quota",
    "rate_limit",
    "provider_transient",
    "network",
    "timeout",
    "invalid_request_model",
    "context_token_limit",
    "tool_protocol",
    "cancel_shutdown",
    "adapter_configuration",
    "unknown",
];

pub const API_ERROR_SIGNATURES: [&str; 6] = [
    "API Error",
    "503",
    "Connection closed",
    "Overloaded",
    "Internal server error",
    "The system is busy",
];

const TRUSTED_TEXT_SOURCES: [&str; 19] = [
    "anthropic_event",
    "claude_result",
    "claude-exp_event",
    "codex_event",
    "opencode_event",
    // A provider error the CLI swallowed but wrote to its own log. The text is
    // the provider's own error string, so it classifies exactly like an event:
    // dropping it here left every log-surfaced failure at category=unknown,
    // which is what kept Auto from switching lines on them.
    "opencode_log",
    "qoder_result",
    "zcode_event",
    "kimi_event",
    "codebuddy_result",
    "dsh_event",
    "gemini_event",
    "grok_event",
    "commandcode_event",
    "pi_event",
    "process_stderr",
    "aux_http",
    "host_interruption",
    "classifier_legacy",
];

const NETWORK_CODES: [&str; 14] = [
    "econnreset",
    "econnrefused",
    "econnaborted",
    "enotfound",
    "eai_again",
    "epipe",
    "err_network",
    "fetch_failed",
    "socket_hang_up",
    "stale_connection",
    "network_down",
    "stream_suspended",
    "connection_closed_mid_response",
    "connection_closed_before_response",
];
const TIMEOUT_CODES: [&str; 14] = [
    "etimedout",
    "timeout",
    "connect_timeout",
    "read_timeout",
    "overall_timeout",
    "deadline_exceeded",
    "und_err_connect_timeout",
    "headers_timeout",
    "watchdog",
    "stream_idle_timeout",
    "model_request_deadline",
    "model_connect_timeout",
    "response_stalled_mid_stream",
    "response_stalled_before_response",
];
const CONTEXT_CODES: [&str; 6] = [
    "context_length_exceeded",
    "context_window_exceeded",
    "too_many_tokens",
    "max_tokens_exceeded",
    "max_output_tokens",
    "length_limit",
];
const AUTH_CODES: [&str; 7] = [
    "authentication_error",
    "permission_denied",
    "unauthorized",
    "forbidden",
    "invalid_api_key",
    "invalid_authentication",
    "insufficient_scope",
];
const BILLING_CODES: [&str; 6] = [
    "billing_error",
    "insufficient_balance",
    "insufficient_quota",
    "quota_exceeded",
    "usage_limit_exceeded",
    "credit_balance_exhausted",
];
const RATE_CODES: [&str; 3] = ["rate_limit_error", "rate_limited", "too_many_requests"];
const PROVIDER_TRANSIENT_CODES: [&str; 7] = [
    "server_error",
    "api_error",
    "overloaded",
    "overloaded_error",
    "internal_error",
    "internal_server_error",
    "server_error_mid_response",
];
const CONFIG_CODES: [&str; 14] = [
    "provider_unavailable",
    "provider_config_invalid",
    "missing_provider",
    "missing_base_url",
    "spawn_failed",
    "cli_not_installed",
    "cli_resume_mismatch",
    "eacces",
    "enoent",
    "enoexec",
    "spawn_eacces",
    "spawn_enoent",
    "spawn_enoexec",
    "exit_13",
];
const TOOL_CODES: [&str; 5] = [
    "invalid_tool_arguments",
    "tool_schema_error",
    "tool_protocol_error",
    "mcp_error",
    "function_call_error",
];

const SDK_STARTUP_FAILURE_LABELS: [(&str, &str); 17] = [
    ("org_pin_api_key_conflict", "组织策略要求使用网关登录，但环境里配置了 Anthropic API Key/Token；请改用组织要求的登录方式或移除冲突的密钥"),
    ("provider_not_allowed", "当前 Provider 不在组织 managed settings 的 allowedProviders 允许列表中；请切换到被允许的 Provider，或请管理员调整策略"),
    ("org_verify_failed", "登录所属组织校验未通过（网络问题或令牌已失效）；请重新登录后重试"),
    ("org_pin_mismatch", "当前登录所属组织不受策略允许；请切换到组织允许的账号"),
    ("managed_settings_invalid", "组织 managed settings 策略文件无效；请检查 managed-settings.json 内容"),
    ("remote_settings_required_unavailable", "策略要求远程设置但当前获取失败；请检查网络后重试"),
    ("gateway_signin_required", "需要先登录网关；请完成网关登录后再使用该 Provider"),
    ("gateway_access_denied", "网关拒绝了本次访问；请确认网关账号权限"),
    ("proxy_invalid", "代理配置无效；请检查代理设置"),
    ("temp_dir_unusable", "临时目录不可用；请检查 TMPDIR 权限与磁盘空间"),
    ("cwd_unavailable", "工作目录不可用；请确认会话目录存在且可访问"),
    ("shell_tool_missing", "Windows 缺少 Shell 工具（Git Bash 未安装且 PowerShell 缺失或被关闭）；请安装 Git Bash 或启用 PowerShell"),
    ("session_held_by_background", "要恢复的会话仍在后台运行；请先结束该后台会话或稍后重试"),
    ("worktree_resume_refused", "会话 worktree 安全检查未通过，恢复被拒绝；请在新目录重开会话"),
    ("worktree_unverified", "会话 worktree 暂时无法校验；稍后重试可能成功"),
    ("cli_version_too_old", "Claude Code 版本过旧，低于 Anthropic 要求的最低版本；请升级 CLI"),
    ("bypass_root", "root 用户下不允许使用 bypassPermissions 模式；请改用非 root 用户运行"),
];

const HOST_STOP_LABELS: [(&str, &str); 9] = [
    ("shutdown", "本轮因服务重启或关闭被中断"),
    ("server_shutting_down", "本轮因服务重启或关闭被中断"),
    ("sigint", "本轮因服务重启或关闭被中断"),
    ("sigterm", "本轮因服务重启或关闭被中断"),
    ("user_cancel", "本轮被用户取消"),
    ("new_user_message", "本轮因新消息被打断"),
    ("cli_switch", "本轮因切换 CLI 车道被中断"),
    ("relocate", "本轮因会话迁移被中断"),
    ("session_delete", "本轮因会话被删除而终止"),
];

const NON_PROVIDER_SOURCES: [&str; 2] = ["host_interruption", "classifier_legacy"];

const RETRYABLE: [&str; 5] = [
    "rate_limit",
    "provider_transient",
    "network",
    "timeout",
    "unknown",
];

const RESET_UNIT_MS: [(&str, f64); 7] = [
    ("second", 1000.0),
    ("sec", 1000.0),
    ("minute", 60_000.0),
    ("min", 60_000.0),
    ("hour", 3_600_000.0),
    ("hr", 3_600_000.0),
    ("day", 86_400_000.0),
];
const MAX_PARSED_RESET_MS: f64 = 30.0 * 86_400_000.0;

const TRAILING_ENVELOPE_MAX_CONTENT: usize = 400;
const TRAILING_ENVELOPE_TAIL_WINDOW: usize = 600;
const MAX_TRAILING_ENVELOPE_CHAIN: usize = 8;

// ---------------------------------------------------------------------------
// Canonical JavaScript regex sources. These are exactly the patterns of the
// pre-migration JS module (no `/i` flag); [`pattern`] turns one into the Rust
// engine's equivalent. `ERROR_ONLY_PREFIX_RE` and `TRAILING_ERROR_ENVELOPE_RE`
// are exported to JS from here, so the pattern text exists once.
// ---------------------------------------------------------------------------

pub const ERROR_ONLY_PREFIX_SOURCE: &str = r"^(?:api\s*error|failed to authenticate|error:|codex\s*(?:exec\s*|exp\s*)?(?:error|出错)|claude\s*(?:error|出错)|opencode\s*(?:error|出错)|qoder\s*(?:error|出错)|zcode\s*(?:error|出错)|kimi\s*(?:error|出错)|codebuddy\s*(?:error|出错)|dsh\s*(?:error|出错)|gemini\s*(?:error|出错)|grok\s*(?:error|出错)|pi\s*(?:error|出错)|stream disconnected|connection (?:closed|reset|refused)|request (?:failed|timed out)|request rejected\s*\(\s*[45]\d\d\s*\)|rate limit|overloaded|internal server error|service unavailable|timeout|timed out|\[error\]|exceeded retry limit|response stalled)";

pub const TRAILING_ERROR_ENVELOPE_SOURCE: &str = r#"(?:^|[\n。：:；;.!?()（)）」』”’"])\s*(failed to authenticate\b[^\n]{0,80}?api\s*error\s*:|api\s*error\s*:)[^\n。！？]{0,400}\s*$"#;

const QUOTA_EXHAUSTION: [&str; 13] = [
    r"\b402\b",
    r"insufficient (?:balance|quota|credit|funds)",
    r"\bbilling\b",
    r"usage limit",
    r"credit balance",
    r"exceed(?:ed|s|ing)?\b[^.\n]{0,60}?\bquota\b",
    r"\bquota\b[^\n]{0,40}?\b(?:exceeded|exhausted|reached|depleted|used up|resets?|will be reset|has been reset)\b",
    r"\b(?:weekly|daily|monthly|hourly|5-hour|five-hour|7-day|24-hour)\b[^.\n]{0,40}?\b(?:quota|limit)\b",
    r"waiting for the reset",
    r"upgrade your plan",
    r"purchase extra usage",
    r"\b(?:hit|reached)\s+your\s+limit\b",
    "额度不足|余额不足|剩余额度|额度已用尽|额度用尽|配额不足|配额已用尽|超出配额|用量上限",
];

const MODEL_ENTITLEMENT: [&str; 6] = [
    r"usage credits? (?:are|is) required",
    r"extra usage (?:is|are) required",
    r"not available on (?:your|this) plan",
    r"not included in (?:your|this) plan",
    "暂未开放",
    "套餐不支持",
];

const RESET_IN_TEXT_SOURCE: &str = r"\breset(?:s|ting)?\s+in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b";
const RESET_AT_TEXT_SOURCE: &str = r"\breset(?:s|ting)?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?)";

const QUOTA_GUARD_CODE_SOURCE: &str = r#""code"\s*:\s*"quota[_-]?guard"#;
const QUOTA_GUARD_ERROR_SOURCE: &str = r#""error"\s*:\s*"[^"]{0,200}quota[ _-]?guard"#;

const TRAILING_ENVELOPE_HEAD_SOURCE: &str =
    r"(?:failed to authenticate\b[^\n]{0,80}?api\s*error\s*:|api\s*error\s*:)";

const STRONG_HEAD_SOURCES: [&str; 4] = [
    r"^api\s*error\s*:\s*[45]\d\d\b",
    r"^api\s*error\s*:\s*request rejected\s*\(\s*\d{3}\s*\)",
    r"^api\s*error\s*:\s*(?:the operation timed out|unable to connect to api|connection error|response stalled\b)",
    r"^failed to authenticate\b",
];

const ENVELOPE_STATUS_SOURCE: &str = r"\b([45]\d\d)\b";

const HARMLESS_STDERR_LINE_SOURCES: [&str; 7] = [
    r"failed to load skill \[[^\]]*\] missing ",
    r"codex_core::util: \w+ without active item\b",
    r"codex_core::util: Custom tool call output is missing for call id:",
    r"failed to refresh available models",
    r"failed to renew cache TTL",
    r"state db returned stale rollout path for thread",
    r"^Reading additional input from stdin\.\.\.$",
];

const CLAUDE_ERROR_ENVELOPE_CODES: [(&str, &str); 5] = [
    (
        "response_stalled_mid_stream",
        r"response stalled mid-stream",
    ),
    (
        "response_stalled_before_response",
        r"response stalled while thinking",
    ),
    ("server_error_mid_response", r"server error mid-response"),
    (
        "connection_closed_mid_response",
        r"connection closed mid-response",
    ),
    (
        "connection_closed_before_response",
        r"connection closed while thinking",
    ),
];

const TEXT_FALLBACK_AUTH_SOURCE: &str = r"\b(?:401|403)\b|unauthori[sz]ed|forbidden|authentication (?:failed|required)|failed to authenticate|authorization failed|invalid api key|insufficient scope|please (?:use|run)\s*\/login|please log\s*in again|oauth token revoked|token (?:has been |was )?revoked|credentials? (?:have been |were )?revoked|not logged in|login required|未登录|请先登录|尚未登录";
const TEXT_FALLBACK_RATE_SOURCE: &str = r"\b429\b|rate limit|too many requests";
const TEXT_FALLBACK_CONTEXT_SOURCE: &str = r"context (?:window|length)|too many tokens|maximum context|max(?:imum)? output tokens?|token limit";
const TEXT_FALLBACK_TOOL_SOURCE: &str = r"invalid tool|tool (?:schema|arguments?|protocol)|mcp (?:error|failed)|function (?:arguments?|call) error";
const TEXT_FALLBACK_CANCEL_SOURCE: &str =
    r"cancelled by user|canceled by user|server (?:is )?shutting down|sigterm|sigint";
const TEXT_FALLBACK_INVALID_SESSION_SOURCE: &str = r"invalid session id\. must be a valid uuid\b";
const TEXT_FALLBACK_NO_SESSION_SOURCE: &str = r"no conversation found with session id\b";
const TEXT_FALLBACK_SESSION_BUSY_SOURCE: &str = r"\bsession id\s+\S+\s+is already in use\b";
const TEXT_FALLBACK_CONFIG_SOURCE: &str = r"provider (?:config|configuration).*(?:missing|invalid)|missing (?:provider|base url)|cli not installed|spawn failed|\b(?:eacces|enoent|enoexec)\b|\bexit(?:ed)?(?:\s+(?:code|status))?\s*[:=]?\s*-13\b";
const TEXT_FALLBACK_TIMEOUT_SOURCE: &str =
    r"etimedout|timed? out|timeout|deadline exceeded|response stalled|stream idle";
const TEXT_FALLBACK_NETWORK_SOURCE: &str = r"enotfound|dns|tls|certificate|econnreset|connection reset|connection closed|connection ?refused|unable to connect|socket hang|network error|fetch failed|stream disconnected";
const TEXT_FALLBACK_TRANSIENT_SOURCE: &str = r"\b(?:500|502|503|504|529)\b|overloaded|at capacity|server error|internal server error|service unavailable|bad gateway|system is busy";
const TEXT_FALLBACK_INVALID_SOURCE: &str = r"\b(?:400|404|409|422)\b|invalid request|validation error|unsupported model|model not found|unprocessable";

// ---------------------------------------------------------------------------
// ECMAScript string and number helpers.
// ---------------------------------------------------------------------------

/// One JS regex source turned into the `regex` crate's equivalent over the
/// UTF-16 unit view.
fn pattern(source: &str, ci: bool) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len() + 16);
    let mut in_class = false;
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        if c == '\\' {
            let Some(&next) = chars.get(index + 1) else {
                out.push(c);
                break;
            };
            match next {
                's' => {
                    if in_class {
                        out.push_str(SPACE);
                    } else {
                        out.push('[');
                        out.push_str(SPACE);
                        out.push(']');
                    }
                }
                'w' => {
                    if in_class {
                        out.push_str(WORD);
                    } else {
                        out.push('[');
                        out.push_str(WORD);
                        out.push(']');
                    }
                }
                'd' => {
                    if in_class {
                        out.push_str("0-9");
                    } else {
                        out.push_str("[0-9]");
                    }
                }
                'b' => out.push_str("(?-u:\\b)"),
                '/' => out.push('/'),
                other => {
                    out.push('\\');
                    out.push(other);
                }
            }
            index += 2;
            continue;
        }
        match c {
            '[' => {
                in_class = true;
                out.push(c);
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            '.' if !in_class => out.push_str("[^\\n\\r\u{2028}\u{2029}]"),
            c if ci && c.is_ascii_alphabetic() => {
                // JS `/i` without `u` folds ASCII letters onto ASCII letters
                // only, so an explicit pair is exact. No source uses a letter
                // range inside a class, where duplication would change it.
                let lower = c.to_ascii_lowercase();
                let upper = c.to_ascii_uppercase();
                if in_class {
                    out.push(lower);
                    out.push(upper);
                } else {
                    out.push('[');
                    out.push(lower);
                    out.push(upper);
                    out.push(']');
                }
            }
            _ => out.push(c),
        }
        index += 1;
    }
    out
}

fn compile(source: &str, ci: bool) -> Regex {
    Regex::new(&pattern(source, ci)).expect("api error policy regex")
}

fn compiled(cell: &'static OnceLock<Vec<Regex>>, sources: &[&str], ci: bool) -> &'static [Regex] {
    cell.get_or_init(|| sources.iter().map(|source| compile(source, ci)).collect())
}

fn any_match(regexes: &[Regex], text: &JsString) -> bool {
    let view = to_unit_view(text);
    regexes.iter().any(|regex| regex.is_match(&view))
}

/// The capture groups of the first match of `regex` in `text`.
fn first_captures(regex: &Regex, text: &JsString) -> Option<Vec<Option<JsString>>> {
    let view = to_unit_view(text);
    let found = regex.captures(&view)?;
    Some(
        (1..found.len())
            .map(|index| found.get(index).map(|m| from_unit_view(m.as_str())))
            .collect(),
    )
}

/// Property read; `None` is the JS value `undefined`.
fn get(value: &JsValue, key: &str) -> Option<JsValue> {
    value.get(key).cloned()
}

fn truthy_opt(value: &Option<JsValue>) -> bool {
    value.as_ref().is_some_and(truthy)
}

fn pick_truthy(values: &[Option<JsValue>]) -> Option<JsValue> {
    values
        .iter()
        .find(|value| value.as_ref().is_some_and(truthy))
        .cloned()
        .flatten()
}

/// `a ?? b ?? c`: the first non-nullish operand.
fn pick_nullish(values: &[Option<JsValue>]) -> Option<JsValue> {
    for value in values {
        match value {
            None | Some(JsValue::Null) | Some(JsValue::Undefined) => continue,
            Some(item) => return Some(item.clone()),
        }
    }
    None
}

/// `a || b || c`: the first truthy operand, or the last one (undefined when
/// the list is empty).
fn or_value(values: &[Option<JsValue>]) -> JsValue {
    let mut last = JsValue::Undefined;
    for value in values {
        last = value.clone().unwrap_or(JsValue::Undefined);
        if truthy(&last) {
            return last;
        }
    }
    last
}

/// `String(value || '')`.
fn string_or_empty(value: &Option<JsValue>) -> JsString {
    match value {
        Some(item) if truthy(item) => js_to_string(item),
        _ => JsString::new(),
    }
}

fn strict_string(value: &Option<JsValue>, text: &str) -> bool {
    matches!(value, Some(JsValue::String(item)) if item == text)
}

fn truthy_value(value: &JsValue) -> bool {
    truthy(value)
}

fn is_object(value: &JsValue) -> bool {
    matches!(
        value,
        JsValue::Object(_) | JsValue::Array(_) | JsValue::Bytes(_) | JsValue::Date(_)
    )
}

/// `value.error && typeof value.error === 'object' ? value.error : {}`.
fn nested_error(value: &JsValue) -> JsValue {
    match get(value, "error") {
        Some(error) if is_object(&error) => error,
        _ => JsValue::object(Vec::<(JsString, JsValue)>::new()),
    }
}

fn is_empty_string(value: &JsValue) -> bool {
    matches!(value, JsValue::String(text) if text.is_empty())
}

fn number_or_null(value: &Option<JsValue>) -> Option<f64> {
    let value = value.as_ref()?;
    if matches!(value, JsValue::Null | JsValue::Undefined) || is_empty_string(value) {
        return None;
    }
    let number = js_to_number(value);
    if number.is_finite() {
        Some(number)
    } else {
        None
    }
}

/// `Math.round`.
fn js_round(value: f64) -> f64 {
    if value.is_nan() || value.is_infinite() {
        return value;
    }
    (value + 0.5).floor()
}

/// `Math.max(0, value)`: NaN wins.
fn js_max_zero(value: f64) -> f64 {
    if value.is_nan() {
        f64::NAN
    } else if value > 0.0 {
        value
    } else {
        0.0
    }
}

fn js_min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else if left < right {
        left
    } else {
        right
    }
}

fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else if left > right {
        left
    } else {
        right
    }
}

fn to_primitive(value: &JsValue) -> JsValue {
    match value {
        JsValue::Object(_) | JsValue::Array(_) | JsValue::Bytes(_) | JsValue::Date(_) => {
            JsValue::String(js_to_string(value))
        }
        other => other.clone(),
    }
}

/// `left + right` (ToPrimitive, then concatenate or add).
fn js_add(left: &JsValue, right: &JsValue) -> JsValue {
    let left = to_primitive(left);
    let right = to_primitive(right);
    if matches!(left, JsValue::String(_)) || matches!(right, JsValue::String(_)) {
        let mut out = js_to_string(&left);
        out.push(&js_to_string(&right));
        JsValue::String(out)
    } else {
        JsValue::Number(js_to_number(&left) + js_to_number(&right))
    }
}

fn js_object(entries: Vec<(&str, JsValue)>) -> JsValue {
    JsValue::object(entries)
}

fn optional_number(value: Option<f64>) -> JsValue {
    value.map_or(JsValue::Null, JsValue::Number)
}

fn optional_text(value: Option<JsString>) -> JsValue {
    value.map_or(JsValue::Null, JsValue::String)
}

fn text_value(value: &str) -> JsValue {
    JsValue::String(JsString::from_rust_str(value))
}

fn string_value(value: JsString) -> JsValue {
    JsValue::String(value)
}

fn provider_or_claude(provider: &Option<JsValue>) -> JsString {
    if truthy_opt(provider) {
        js_to_string(provider.as_ref().unwrap())
    } else {
        JsString::from_rust_str("claude")
    }
}

// ---------------------------------------------------------------------------
// Facts shared with JS.
// ---------------------------------------------------------------------------

pub fn facts() -> String {
    serde_json::json!({
        "categories": CATEGORIES,
        "apiErrorSignatures": API_ERROR_SIGNATURES,
        "errorOnlyPrefixSource": ERROR_ONLY_PREFIX_SOURCE,
        "trailingErrorEnvelopeSource": TRAILING_ERROR_ENVELOPE_SOURCE,
        "trustedTextSources": TRUSTED_TEXT_SOURCES,
    })
    .to_string()
}

pub fn is_category(value: &JsValue) -> bool {
    match value {
        JsValue::String(text) => CATEGORIES.iter().any(|category| text == *category),
        _ => false,
    }
}

pub fn signatures_quoted() -> String {
    API_ERROR_SIGNATURES
        .iter()
        .map(|signature| format!("\u{201c}{signature}\u{201d}"))
        .collect::<Vec<_>>()
        .join("\u{3001}")
}

/// `{ ...value }` for the values the decision accepts: an object keeps its own
/// enumerable entries, an array its indices, anything else spreads to `{}`.
pub fn spread_clone(value: &JsValue) -> JsValue {
    match value {
        JsValue::Object(entries) => JsValue::Object(entries.clone()),
        JsValue::Array(items) => JsValue::Object(
            items
                .iter()
                .enumerate()
                .map(|(index, item)| (JsString::from_rust_str(&index.to_string()), item.clone()))
                .collect(),
        ),
        _ => JsValue::object(Vec::<(JsString, JsValue)>::new()),
    }
}

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

fn whitespace_pattern() -> Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(r"[\s.-]+", false)).clone()
}

pub fn normalize_code(value: &Option<JsValue>) -> JsString {
    let text = string_or_empty(value).trim().to_lowercase();
    if text == "-13" {
        return JsString::from_rust_str("exit_13");
    }
    let view = to_unit_view(&text);
    let replaced = whitespace_pattern().replace_all(&view, "_");
    from_unit_view(&replaced).truncate_units(80)
}

pub fn source_message(raw: &JsValue) -> JsValue {
    if matches!(raw, JsValue::String(_)) {
        return raw.clone();
    }
    if !is_object(raw) {
        return text_value("");
    }
    let nested = nested_error(raw);
    let direct = pick_truthy(&[
        get(raw, "message"),
        get(&nested, "message"),
        get(raw, "detail"),
        get(raw, "reason"),
    ]);
    if let Some(value) = direct.as_ref() {
        if truthy(value) && js_to_string(value).trim().to_lowercase() != "error_during_execution" {
            return value.clone();
        }
    }
    if let Some(JsValue::Array(entries)) = get(raw, "errors") {
        let parts: Vec<JsString> = entries
            .iter()
            .map(|entry| string_or_empty(&Some(entry.clone())).trim())
            .filter(|part| !part.is_empty())
            .collect();
        if !parts.is_empty() {
            return JsValue::String(JsString::join(&parts, &JsString::from_rust_str(" | ")));
        }
    }
    match direct {
        Some(value) if truthy_value(&value) => value,
        _ => text_value(""),
    }
}

fn code_in(codes: &[&str], code: &JsString) -> bool {
    codes.iter().any(|entry| code == *entry)
}

// ---------------------------------------------------------------------------
// Time parsing.
// ---------------------------------------------------------------------------

pub fn parse_retry_after(
    value: &Option<JsValue>,
    now: f64,
    date_parse: &dyn Fn(&JsString) -> f64,
) -> Option<f64> {
    let value = value.as_ref()?;
    if matches!(value, JsValue::Null | JsValue::Undefined) || is_empty_string(value) {
        return None;
    }
    let text = js_to_string(value).trim();
    let seconds = js_string_to_number(&text.to_string_lossy());
    if seconds.is_finite() && seconds >= 0.0 {
        return Some(js_round(seconds * 1000.0));
    }
    let at = date_parse(&text);
    if at.is_finite() {
        Some(js_max_zero(at - now))
    } else {
        None
    }
}

pub fn parse_reset(value: &Option<JsValue>, now: f64) -> Option<f64> {
    let number = number_or_null(value)?;
    if number < 0.0 {
        return None;
    }
    let epoch = if number > 1e12 {
        number
    } else if number > 1e9 {
        number * 1000.0
    } else {
        now + number * 1000.0
    };
    Some(js_max_zero(js_round(epoch - now)))
}

pub fn reset_after_from_text(
    value: &Option<JsValue>,
    now: f64,
    date_parse: &dyn Fn(&JsString) -> f64,
) -> Option<f64> {
    let text = string_or_empty(value);
    if text.is_empty() {
        return None;
    }
    static RELATIVE: OnceLock<Regex> = OnceLock::new();
    let relative = RELATIVE.get_or_init(|| compile(RESET_IN_TEXT_SOURCE, true));
    if let Some(captures) = first_captures(relative, &text) {
        let amount = captures
            .first()
            .and_then(|capture| capture.as_ref())
            .map(|capture| js_string_to_number(&capture.to_string_lossy()))
            .unwrap_or(f64::NAN);
        let unit = captures
            .get(1)
            .and_then(|capture| capture.as_ref())
            .map(|capture| {
                let lowered = capture.to_lowercase();
                if lowered.as_units().last() == Some(&(b's' as u16)) {
                    lowered.truncate_units(lowered.len() - 1)
                } else {
                    lowered
                }
            })
            .unwrap_or_default();
        let scale = RESET_UNIT_MS
            .iter()
            .find(|(name, _)| unit == *name)
            .map(|(_, scale)| *scale);
        let scale = scale?;
        if !amount.is_finite() || amount <= 0.0 {
            return None;
        }
        let delay = js_round(amount * scale);
        return if delay > 0.0 && delay <= MAX_PARSED_RESET_MS {
            Some(delay)
        } else {
            None
        };
    }
    static ABSOLUTE: OnceLock<Regex> = OnceLock::new();
    let absolute = ABSOLUTE.get_or_init(|| compile(RESET_AT_TEXT_SOURCE, true));
    let captures = first_captures(absolute, &text)?;
    let captured = captures.first().and_then(|capture| capture.clone())?;
    let at = date_parse(&captured);
    if !at.is_finite() {
        return None;
    }
    let delay = js_round(at - now);
    if delay > 0.0 && delay <= MAX_PARSED_RESET_MS {
        Some(delay)
    } else {
        None
    }
}

pub fn http_status_of(raw: &JsValue) -> Option<JsValue> {
    if !is_object(raw) {
        return None;
    }
    let nested = nested_error(raw);
    let value = pick_nullish(&[
        get(raw, "httpStatus"),
        get(raw, "statusCode"),
        get(raw, "status"),
        get(&nested, "httpStatus"),
        get(&nested, "statusCode"),
        get(&nested, "status"),
    ]);
    let number = number_or_null(&value)?;
    if (100.0..=599.0).contains(&number) {
        Some(JsValue::Number(js_round(number)))
    } else {
        None
    }
}

pub fn header_value(headers: &Option<JsValue>, name: &str) -> Option<JsValue> {
    let headers = headers.as_ref()?;
    if !truthy_value(headers) {
        return None;
    }
    let wanted = name.to_lowercase();
    match headers {
        JsValue::Object(entries) => entries
            .iter()
            .find(|(key, _)| key.to_lowercase() == wanted)
            .map(|(_, value)| value.clone()),
        JsValue::Array(items) => items
            .iter()
            .enumerate()
            .find(|(index, _)| index.to_string() == wanted)
            .map(|(_, value)| value.clone()),
        _ => None,
    }
}

pub fn retry_after_of(
    raw: &JsValue,
    now: f64,
    date_parse: &dyn Fn(&JsString) -> f64,
) -> Option<f64> {
    if !is_object(raw) {
        return None;
    }
    if let Some(number) = number_or_null(&get(raw, "retryAfterMs")) {
        return Some(js_max_zero(js_round(number)));
    }
    let raw_error = get(raw, "error").unwrap_or(JsValue::Undefined);
    let from_error = if truthy_value(&raw_error) {
        get(&raw_error, "headers")
    } else {
        Some(raw_error)
    };
    let headers = pick_truthy(&[get(raw, "headers"), from_error]);
    let retry_after = pick_nullish(&[
        get(raw, "retryAfter"),
        header_value(&headers, "retry-after"),
    ]);
    if let Some(direct) = parse_retry_after(&retry_after, now, date_parse) {
        return Some(direct);
    }
    let reset = pick_nullish(&[
        get(raw, "resetAt"),
        get(raw, "rateLimitReset"),
        header_value(&headers, "x-ratelimit-reset"),
        header_value(&headers, "ratelimit-reset"),
    ]);
    parse_reset(&reset, now)
}

// ---------------------------------------------------------------------------
// Envelope detection.
// ---------------------------------------------------------------------------

fn is_quota_guard_json(text: &JsString) -> bool {
    if text.code_unit_at(0) != Some(b'{' as u16) {
        return false;
    }
    static CODE: OnceLock<Regex> = OnceLock::new();
    static ERROR: OnceLock<Regex> = OnceLock::new();
    let code = CODE.get_or_init(|| compile(QUOTA_GUARD_CODE_SOURCE, true));
    let error = ERROR.get_or_init(|| compile(QUOTA_GUARD_ERROR_SOURCE, true));
    let view = to_unit_view(text);
    code.is_match(&view) || error.is_match(&view)
}

fn is_error_only_text_js(text: &JsString) -> bool {
    if text.is_empty() || text.len() > 600 {
        return false;
    }
    static PREFIX: OnceLock<Regex> = OnceLock::new();
    let prefix = PREFIX.get_or_init(|| compile(ERROR_ONLY_PREFIX_SOURCE, true));
    prefix.is_match(&to_unit_view(text)) || is_quota_guard_json(text)
}

pub fn is_error_only_text(value: &JsValue) -> bool {
    let text = string_or_empty(&Some(value.clone())).trim();
    is_error_only_text_js(&text)
}

fn envelope_source(provider: &Option<JsValue>) -> &'static str {
    let name = provider_or_claude(provider).to_lowercase();
    match name.to_string_lossy().as_str() {
        "qoder" => "qoder_result",
        "codex" => "codex_event",
        "opencode" => "opencode_event",
        "zcode" => "zcode_event",
        "kimi" => "kimi_event",
        "codebuddy" => "codebuddy_result",
        "dsh" => "dsh_event",
        "gemini" => "gemini_event",
        "grok" => "grok_event",
        "commandcode" => "commandcode_event",
        "pi" => "pi_event",
        _ => "claude_result",
    }
}

pub fn envelope_source_for(provider: &JsValue) -> JsString {
    JsString::from_rust_str(envelope_source(&Some(provider.clone())))
}

fn envelope_http_status(message: &JsValue) -> Option<f64> {
    let text = string_or_empty(&Some(message.clone()));
    static RE: OnceLock<Regex> = OnceLock::new();
    let regex = RE.get_or_init(|| compile(ENVELOPE_STATUS_SOURCE, false));
    let captures = first_captures(regex, &text)?;
    let captured = captures.first().and_then(|capture| capture.clone())?;
    let status = js_string_to_number(&captured.to_string_lossy());
    if (400.0..=599.0).contains(&status) {
        Some(status)
    } else {
        None
    }
}

fn boundary_unit(unit: u16) -> bool {
    matches!(
        unit,
        0x000A
            | 0x3002
            | 0xFF1A
            | 0x003A
            | 0xFF1B
            | 0x003B
            | 0x002E
            | 0x0021
            | 0x003F
            | 0x0028
            | 0x0029
            | 0xFF08
            | 0xFF09
            | 0x300D
            | 0x300F
            | 0x201D
            | 0x2019
            | 0x0022
    )
}

fn seam_unit(unit: u16) -> bool {
    matches!(unit, 0x000A | 0x3002 | 0xFF1A | 0x003A | 0xFF1B | 0x003B)
}

fn sentence_punct(unit: u16) -> bool {
    matches!(unit, 0x3002 | 0xFF01 | 0xFF1F)
}

fn envelope_content_allowed(head: &JsString, content: &JsString) -> bool {
    if content.len() > TRAILING_ENVELOPE_MAX_CONTENT {
        return false;
    }
    if content.as_units().contains(&(b'\n' as u16)) {
        return false;
    }
    let mut combined = head.clone();
    combined.push(content);
    let strong = {
        static STRONG: OnceLock<Vec<Regex>> = OnceLock::new();
        compiled(&STRONG, &STRONG_HEAD_SOURCES, true)
            .iter()
            .any(|regex| regex.is_match(&to_unit_view(&combined)))
    };
    let units = content.as_units();
    let trailing_start = units
        .iter()
        .rposition(|unit| !sentence_punct(*unit))
        .map_or(0, |index| index + 1);
    let body = if trailing_start < units.len() {
        let prefix_has_ascii = units[..trailing_start]
            .iter()
            .any(|unit| matches!(*unit, 0x002E | 0x0021 | 0x003F));
        if !strong || prefix_has_ascii {
            return false;
        }
        content.truncate_units(trailing_start)
    } else {
        content.clone()
    };
    let mut depth: i32 = 0;
    for unit in body.as_units() {
        if *unit == b'[' as u16 {
            depth += 1;
        } else if *unit == b']' as u16 {
            if depth > 0 {
                depth -= 1;
            }
        } else if depth == 0 && sentence_punct(*unit) {
            return false;
        }
    }
    depth == 0
}

fn find_trailing_envelope_unit(text: &JsString, end: usize) -> Option<usize> {
    let floor = end.saturating_sub(TRAILING_ENVELOPE_TAIL_WINDOW);
    let slice = text.slice_units(floor, end);
    let units = slice.as_units();
    let mut content_end = units.len();
    while content_end > 0 && is_js_whitespace(units[content_end - 1]) {
        content_end -= 1;
    }
    if content_end == 0 {
        return None;
    }
    static HEAD: OnceLock<Regex> = OnceLock::new();
    let head = HEAD.get_or_init(|| compile(TRAILING_ENVELOPE_HEAD_SOURCE, true));
    let view = to_unit_view(&slice);
    for found in head.find_iter(&view) {
        if found.as_str().is_empty() {
            continue;
        }
        let start = view[..found.start()].chars().count();
        let matched = from_unit_view(found.as_str());
        let content_start = start + matched.len();
        if content_start > content_end {
            return None;
        }
        let content = slice.slice_units(content_start, content_end);
        if envelope_content_allowed(&matched, &content) {
            return Some(floor + start);
        }
    }
    None
}

struct Chain {
    body: JsString,
    envelope: JsString,
    envelope_count: usize,
}

fn peel_trailing_envelope_chain(text: &JsString) -> Option<Chain> {
    let end = text.len();
    let mut cursor = end;
    let mut accepted: Option<Chain> = None;
    for peeled in 0..MAX_TRAILING_ENVELOPE_CHAIN {
        let unit_start = match find_trailing_envelope_unit(text, cursor) {
            Some(start) if start < cursor => start,
            _ => return accepted,
        };
        let mut before = unit_start as isize - 1;
        let mut line_start = false;
        while before >= 0 && is_js_whitespace(text.code_unit_at(before as usize).unwrap()) {
            if text.code_unit_at(before as usize) == Some(b'\n' as u16) {
                line_start = true;
            }
            before -= 1;
        }
        if before < 0 {
            return Some(Chain {
                body: JsString::new(),
                envelope: text.trim(),
                envelope_count: peeled + 1,
            });
        }
        if !line_start && !boundary_unit(text.code_unit_at(before as usize).unwrap()) {
            return accepted;
        }
        accepted = Some(Chain {
            body: text.slice_units(0, unit_start).trim(),
            envelope: text.slice_units(unit_start, end).trim(),
            envelope_count: peeled + 1,
        });
        cursor = before as usize + 1;
    }
    None
}

fn looks_like_json_document(text: &JsString) -> bool {
    let first = text.code_unit_at(0);
    if first != Some(b'{' as u16) && first != Some(b'[' as u16) {
        return false;
    }
    crate::js::json_parse(&text.to_string_lossy()).is_ok()
}

fn split_trailing_envelope_value(text: &JsString) -> Option<JsValue> {
    if text.is_empty() || is_error_only_text_js(text) {
        return None;
    }
    if looks_like_json_document(text) {
        return None;
    }
    let chain = peel_trailing_envelope_chain(text)?;
    if chain.body.is_empty() {
        return None;
    }
    if chain.envelope_count > 1 {
        return Some(js_object(vec![
            ("body", string_value(chain.body)),
            ("envelope", string_value(chain.envelope)),
        ]));
    }
    let last = chain.body.as_units().last().copied();
    let body = match last {
        Some(unit) if seam_unit(unit) => chain.body.truncate_units(chain.body.len() - 1).trim(),
        _ => chain.body,
    };
    Some(js_object(vec![
        ("body", string_value(body)),
        ("envelope", string_value(chain.envelope)),
    ]))
}

pub fn split_trailing_error_envelope(value: &JsValue) -> JsValue {
    let text = string_or_empty(&Some(value.clone())).trim();
    split_trailing_envelope_value(&text).unwrap_or(JsValue::Null)
}

fn envelope_entry(
    provider: &Option<JsValue>,
    message: JsString,
    http_status: Option<f64>,
    body: JsValue,
) -> JsValue {
    let provider_name = provider_or_claude(provider).to_lowercase();
    js_object(vec![
        ("source", text_value(envelope_source(provider))),
        ("provider", string_value(provider_name)),
        ("message", string_value(message)),
        ("httpStatus", optional_number(http_status)),
        ("body", body),
    ])
}

pub fn detect_error_envelope(provider: &JsValue, text: &JsValue) -> JsValue {
    let provider = Some(provider.clone());
    let trimmed = string_or_empty(&Some(text.clone())).trim();
    if trimmed.is_empty() {
        return JsValue::Null;
    }
    if is_error_only_text_js(&trimmed) {
        return envelope_entry(
            &provider,
            trimmed.clone(),
            envelope_http_status(&JsValue::String(trimmed)),
            JsValue::Null,
        );
    }
    match split_trailing_envelope_value(&trimmed) {
        None => match peel_trailing_envelope_chain(&trimmed) {
            Some(chain) if chain.body.is_empty() => envelope_entry(
                &provider,
                trimmed.clone(),
                envelope_http_status(&JsValue::String(trimmed)),
                JsValue::Null,
            ),
            _ => JsValue::Null,
        },
        Some(split) => {
            let envelope = get(&split, "envelope").unwrap_or(JsValue::Undefined);
            let body = get(&split, "body").unwrap_or(JsValue::Undefined);
            let status = envelope_http_status(&envelope);
            envelope_entry(&provider, js_to_string(&envelope), status, body)
        }
    }
}

pub fn claude_error_envelope(provider: &JsValue, text: &JsValue) -> JsValue {
    if !is_error_only_text(text) {
        return JsValue::Null;
    }
    let message = js_to_string(text).trim();
    static COMPILED: OnceLock<Vec<Regex>> = OnceLock::new();
    let sources: [&str; 5] = CLAUDE_ERROR_ENVELOPE_CODES.map(|(_, source)| source);
    let regexes = compiled(&COMPILED, &sources, true);
    for (index, (code, _)) in CLAUDE_ERROR_ENVELOPE_CODES.iter().enumerate() {
        if regexes[index].is_match(&to_unit_view(&message)) {
            let provider_option = Some(provider.clone());
            let provider_name = provider_or_claude(&provider_option).to_lowercase();
            return js_object(vec![
                ("source", text_value(envelope_source(&provider_option))),
                ("provider", string_value(provider_name)),
                ("code", text_value(code)),
                ("message", string_value(message)),
            ]);
        }
    }
    JsValue::Null
}

pub fn is_known_harmless_stderr_line(value: &JsValue) -> bool {
    let text = string_or_empty(&Some(value.clone())).trim();
    if text.is_empty() {
        return true;
    }
    static COMPILED: OnceLock<Vec<Regex>> = OnceLock::new();
    let regexes = compiled(&COMPILED, &HARMLESS_STDERR_LINE_SOURCES, true);
    any_match(regexes, &text)
}

// ---------------------------------------------------------------------------
// Category selection.
// ---------------------------------------------------------------------------

fn code_family(code: &JsString) -> Option<&'static str> {
    for (codes, category) in [
        (&AUTH_CODES[..], "authentication_permission"),
        (&BILLING_CODES[..], "billing_quota"),
        (&RATE_CODES[..], "rate_limit"),
        (&PROVIDER_TRANSIENT_CODES[..], "provider_transient"),
        (&CONTEXT_CODES[..], "context_token_limit"),
        (&TOOL_CODES[..], "tool_protocol"),
        (&CONFIG_CODES[..], "adapter_configuration"),
        (&NETWORK_CODES[..], "network"),
        (&TIMEOUT_CODES[..], "timeout"),
    ] {
        if code_in(codes, code) {
            return Some(category);
        }
    }
    None
}

fn status_number(status: &Option<JsValue>) -> Option<f64> {
    match status {
        Some(JsValue::Number(number)) => Some(*number),
        _ => None,
    }
}

fn status_eq(status: &Option<JsValue>, value: f64) -> bool {
    status_number(status).is_some_and(|number| number == value)
}

fn status_in(status: &Option<JsValue>, values: &[f64]) -> bool {
    status_number(status).is_some_and(|number| values.contains(&number))
}

fn structured_category(
    status: &Option<JsValue>,
    code: &JsString,
    raw_category: &JsValue,
) -> Option<&'static str> {
    if let JsValue::String(text) = raw_category {
        if let Some(found) = CATEGORIES.iter().find(|category| text == **category) {
            return Some(found);
        }
    }
    if crate::provider_error::LOCAL_CANCELLATION_CODES
        .iter()
        .any(|entry| code == *entry)
    {
        return Some("cancel_shutdown");
    }
    if SDK_STARTUP_FAILURE_LABELS
        .iter()
        .any(|(name, _)| code == *name)
    {
        return Some("adapter_configuration");
    }
    if let Some(category) = code_family(code) {
        return Some(category);
    }
    if status_eq(status, 401.0) || status_eq(status, 403.0) {
        return Some("authentication_permission");
    }
    if status_eq(status, 402.0) {
        return Some("billing_quota");
    }
    if status_eq(status, 429.0) {
        return Some("rate_limit");
    }
    if status_in(status, &[500.0, 502.0, 503.0, 504.0, 529.0]) {
        return Some("provider_transient");
    }
    if status_in(status, &[400.0, 404.0, 409.0, 422.0]) {
        return Some("invalid_request_model");
    }
    None
}

fn text_fallback_category(message: &JsValue) -> &'static str {
    let text = string_or_empty(&Some(message.clone())).to_lowercase();
    static MODEL: OnceLock<Vec<Regex>> = OnceLock::new();
    static QUOTA: OnceLock<Vec<Regex>> = OnceLock::new();
    static AUTH: OnceLock<Regex> = OnceLock::new();
    static RATE: OnceLock<Regex> = OnceLock::new();
    static CONTEXT: OnceLock<Regex> = OnceLock::new();
    static TOOL: OnceLock<Regex> = OnceLock::new();
    static CANCEL: OnceLock<Regex> = OnceLock::new();
    static INVALID_SESSION: OnceLock<Regex> = OnceLock::new();
    static NO_SESSION: OnceLock<Regex> = OnceLock::new();
    static SESSION_BUSY: OnceLock<Regex> = OnceLock::new();
    static CONFIG: OnceLock<Regex> = OnceLock::new();
    static TIMEOUT: OnceLock<Regex> = OnceLock::new();
    static NETWORK: OnceLock<Regex> = OnceLock::new();
    static TRANSIENT: OnceLock<Regex> = OnceLock::new();
    static INVALID: OnceLock<Regex> = OnceLock::new();
    let view = to_unit_view(&text);
    if any_match(compiled(&MODEL, &MODEL_ENTITLEMENT, false), &text)
        || any_match(compiled(&QUOTA, &QUOTA_EXHAUSTION, false), &text)
    {
        return "billing_quota";
    }
    let test = |cell: &'static OnceLock<Regex>, source: &str| {
        cell.get_or_init(|| compile(source, false)).is_match(&view)
    };
    if test(&AUTH, TEXT_FALLBACK_AUTH_SOURCE) {
        return "authentication_permission";
    }
    if test(&RATE, TEXT_FALLBACK_RATE_SOURCE) {
        return "rate_limit";
    }
    if test(&CONTEXT, TEXT_FALLBACK_CONTEXT_SOURCE) {
        return "context_token_limit";
    }
    if test(&TOOL, TEXT_FALLBACK_TOOL_SOURCE) {
        return "tool_protocol";
    }
    if test(&CANCEL, TEXT_FALLBACK_CANCEL_SOURCE) {
        return "cancel_shutdown";
    }
    if test(&INVALID_SESSION, TEXT_FALLBACK_INVALID_SESSION_SOURCE)
        || test(&NO_SESSION, TEXT_FALLBACK_NO_SESSION_SOURCE)
        || test(&SESSION_BUSY, TEXT_FALLBACK_SESSION_BUSY_SOURCE)
        || test(&CONFIG, TEXT_FALLBACK_CONFIG_SOURCE)
    {
        return "adapter_configuration";
    }
    if test(&TIMEOUT, TEXT_FALLBACK_TIMEOUT_SOURCE) {
        return "timeout";
    }
    if test(&NETWORK, TEXT_FALLBACK_NETWORK_SOURCE) {
        return "network";
    }
    if test(&TRANSIENT, TEXT_FALLBACK_TRANSIENT_SOURCE) {
        return "provider_transient";
    }
    if test(&INVALID, TEXT_FALLBACK_INVALID_SOURCE) {
        return "invalid_request_model";
    }
    "unknown"
}

fn model_entitlement_text(message: &JsValue) -> bool {
    let text = string_or_empty(&Some(message.clone())).to_lowercase();
    static COMPILED: OnceLock<Vec<Regex>> = OnceLock::new();
    any_match(compiled(&COMPILED, &MODEL_ENTITLEMENT, false), &text)
}

// ---------------------------------------------------------------------------
// User action and route identity.
// ---------------------------------------------------------------------------

fn user_action(category: &str, retry_after_ms: Option<f64>, rejection: &JsValue) -> String {
    if category == "billing_quota" && truthy_value(rejection) {
        let kind = get(rejection, "kind");
        let scope = get(rejection, "scope");
        if strict_string(&kind, "entitlement") {
            return "当前账号的套餐不包含这个模型（需开通 usage credits / extra usage）：请换一个模型，或换用有该模型权限的账号".to_string();
        }
        if strict_string(&kind, "window") && strict_string(&scope, "model") {
            return "该账号这个模型的额度窗口已满：可以先换其他模型继续，或等待重置".to_string();
        }
        if strict_string(&kind, "billing") {
            return "充值、调整花费上限或换用其他线路".to_string();
        }
    }
    match category {
        "authentication_permission" => {
            "重新登录、更新 API 凭据或补足权限后重试（官方账号可在「模型线路」面板点「重新登录」）"
        }
        "billing_quota" => {
            if retry_after_ms.is_some() {
                "等待额度重置后重试"
            } else {
                "检查账单、额度或用量上限"
            }
        }
        "rate_limit" => "等待服务端限流窗口结束",
        "context_token_limit" => "压缩或裁剪上下文，或开启新会话",
        "invalid_request_model" => "修正请求参数、模型名称或 Provider 配置",
        "tool_protocol" => "修正工具参数或协议结构",
        "adapter_configuration" => "检查 CLI、Provider 和适配器配置",
        "cancel_shutdown" => "无需操作；如有需要可重新发起",
        "provider_transient" | "network" | "timeout" => "可稍后手动继续，或切换到其他模型线路",
        _ => "检查错误详情后决定是否手动重试",
    }
    .to_string()
}

fn route_identity_text(
    value: &Option<JsValue>,
    fallback: Option<JsString>,
    max_length: usize,
) -> Option<JsString> {
    let text = match value {
        None | Some(JsValue::Null) | Some(JsValue::Undefined) => JsString::new(),
        Some(item) => js_to_string(item).trim(),
    };
    if !text.is_empty() {
        Some(text.truncate_units(max_length))
    } else {
        fallback
    }
}

fn route_identity_number(value: &Option<JsValue>) -> Option<f64> {
    let number = js_to_number(value.as_ref()?);
    if number.is_finite()
        && number.fract() == 0.0
        && number.abs() <= 9_007_199_254_740_991.0
        && number > 0.0
    {
        Some(number)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Normalization.
// ---------------------------------------------------------------------------

/// The host-side results the normalizer needs: everything the JS bridge
/// computed from the provider classifier, the upstream extractor and the
/// rejection contract, plus the `source`/`provider` plan.
pub struct NormalizeDeps {
    pub source: JsString,
    pub provider: JsString,
    pub upstream: JsValue,
    pub failure: JsValue,
    pub rejection: JsValue,
    pub now: f64,
    /// The JS bridge already saw `rawError.category` in `CATEGORY_SET`; the
    /// decision then spreads `rawError` instead of normalizing it.
    pub known: bool,
}

fn nullish_kind(value: &JsValue) -> &'static str {
    if matches!(value, JsValue::Undefined) {
        "undefined"
    } else {
        "null"
    }
}

/// `context.source || raw.source || 'unknown'` and the provider chain, read
/// with the same short circuits (and the same TypeError) as the original.
pub fn source_and_provider(
    raw: &JsValue,
    context: &JsValue,
) -> Result<(JsString, JsString), String> {
    if context.is_nullish() {
        return Err(format!(
            "Cannot read properties of {} (reading 'source')",
            nullish_kind(context)
        ));
    }
    let mut source = get(context, "source");
    if !truthy_opt(&source) {
        if raw.is_nullish() {
            return Err(format!(
                "Cannot read properties of {} (reading 'source')",
                nullish_kind(raw)
            ));
        }
        source = get(raw, "source");
    }
    if !truthy_opt(&source) {
        source = Some(text_value("unknown"));
    }
    let mut provider = get(context, "provider");
    if !truthy_opt(&provider) {
        provider = get(context, "cli");
    }
    if !truthy_opt(&provider) {
        if raw.is_nullish() {
            return Err(format!(
                "Cannot read properties of {} (reading 'provider')",
                nullish_kind(raw)
            ));
        }
        provider = get(raw, "provider");
        if !truthy_opt(&provider) {
            provider = get(raw, "cli");
        }
    }
    if !truthy_opt(&provider) {
        provider = Some(text_value("unknown"));
    }
    Ok((
        js_to_string(&source.unwrap())
            .to_lowercase()
            .truncate_units(40),
        js_to_string(&provider.unwrap())
            .to_lowercase()
            .truncate_units(40),
    ))
}

/// `context.rejection ?? raw.rejection ?? nested.rejection`: the value the
/// host rejection contract is applied to.
pub fn rejection_input(raw: &JsValue, context: &JsValue) -> JsValue {
    if context.is_nullish() {
        return JsValue::Undefined;
    }
    let from_context = get(context, "rejection").unwrap_or(JsValue::Undefined);
    if !from_context.is_nullish() {
        return from_context;
    }
    let from_raw = if raw.is_nullish() {
        JsValue::Undefined
    } else {
        get(raw, "rejection").unwrap_or(JsValue::Undefined)
    };
    if !from_raw.is_nullish() {
        return from_raw;
    }
    get(&nested_error(raw), "rejection").unwrap_or(JsValue::Undefined)
}

/// Everything `normalizeApiError` reads before the host-owned inputs: the
/// normalized source/provider and the raw rejection candidate.
pub fn prepare(raw: &JsValue, context: &JsValue) -> Result<JsValue, String> {
    let (source, provider) = source_and_provider(raw, context)?;
    Ok(js_object(vec![
        ("source", string_value(source)),
        ("provider", string_value(provider)),
        ("rejection", rejection_input(raw, context)),
    ]))
}

pub fn is_trusted_source(source: &JsString) -> bool {
    TRUSTED_TEXT_SOURCES.iter().any(|name| source == *name)
}

pub fn sanitize_value(value: &Option<JsValue>, fallback: &str, max_length: usize) -> JsString {
    let mut message = redaction::sanitize_message(&string_or_empty(value));
    if message.is_empty() {
        message = JsString::from_rust_str(fallback);
    }
    message.truncate_units(max_length)
}

fn presentation_field(failure: &JsValue, field: &str) -> Option<JsValue> {
    if failure.is_nullish() {
        return None;
    }
    let presentation = get(failure, "presentation")?;
    if presentation.is_nullish() {
        return None;
    }
    get(&presentation, field)
}

fn diagnosis_of(failure: &JsValue) -> JsValue {
    if failure.is_nullish() {
        return JsValue::Undefined;
    }
    get(failure, "diagnosis").unwrap_or(JsValue::Undefined)
}

fn request_digest(value: &JsValue) -> String {
    let text = js_to_string(value);
    let digest = Sha256::digest(text.utf8_lossy_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    hex[..10].to_string()
}

/// A normalized error (or a decision) plus the one fact a caller cannot read
/// back off it: whether `rejection` is the synthesized text entitlement
/// constant. The Node implementation shared one frozen object for that case, so
/// the host bridge has to freeze (and share) it; a structured rejection that
/// merely looks the same stays an ordinary value.
pub struct Outcome {
    pub value: JsValue,
    pub text_entitlement_rejection: bool,
}

pub fn normalize(
    raw: &JsValue,
    context: &JsValue,
    deps: &NormalizeDeps,
    date_parse: &dyn Fn(&JsString) -> f64,
) -> JsValue {
    normalize_outcome(raw, context, deps, date_parse).value
}

pub fn normalize_outcome(
    raw: &JsValue,
    context: &JsValue,
    deps: &NormalizeDeps,
    date_parse: &dyn Fn(&JsString) -> f64,
) -> Outcome {
    let now = deps.now;
    let source = deps.source.clone();
    let provider = deps.provider.clone();
    let nested = nested_error(raw);
    let failure = deps.failure.clone();
    let diagnosis = diagnosis_of(&failure);
    let diag_category = get(&diagnosis, "category");
    let diagnosis_signals = !strict_string(&diag_category, "unknown");
    let trusted = is_trusted_source(&source);

    let provider_id = route_identity_text(
        &pick_nullish(&[
            get(context, "providerId"),
            get(raw, "providerId"),
            get(&nested, "providerId"),
        ]),
        Some(JsString::from_rust_str("_default_")),
        256,
    );
    let provider_id_text = provider_id
        .clone()
        .unwrap_or_else(|| JsString::from_rust_str("_default_"));
    let provider_name_default = if provider_id_text == "_default_" {
        provider.clone()
    } else {
        provider_id_text
    };
    let provider_name = route_identity_text(
        &pick_nullish(&[
            get(context, "providerName"),
            get(raw, "providerName"),
            get(&nested, "providerName"),
        ]),
        Some(provider_name_default),
        256,
    );
    let turn_id = route_identity_text(
        &pick_nullish(&[
            get(context, "turnId"),
            get(raw, "turnId"),
            get(&nested, "turnId"),
        ]),
        None,
        256,
    );
    let decision_id = route_identity_text(
        &pick_nullish(&[
            get(context, "decisionId"),
            get(raw, "decisionId"),
            get(&nested, "decisionId"),
        ]),
        None,
        256,
    );
    let runtime_epoch = route_identity_text(
        &pick_nullish(&[
            get(context, "runtimeEpoch"),
            get(raw, "runtimeEpoch"),
            get(&nested, "runtimeEpoch"),
        ]),
        None,
        256,
    );
    let route_attempt_id = route_identity_text(
        &pick_nullish(&[
            get(context, "routeAttemptId"),
            get(raw, "routeAttemptId"),
            get(&nested, "routeAttemptId"),
        ]),
        None,
        256,
    );
    let route_generation = route_identity_number(&pick_nullish(&[
        get(context, "routeGeneration"),
        get(raw, "routeGeneration"),
        get(&nested, "routeGeneration"),
    ]));
    let attempt_no = route_identity_number(&pick_nullish(&[
        get(context, "attemptNo"),
        get(raw, "attemptNo"),
        get(&nested, "attemptNo"),
    ]));
    let provider_revision = route_identity_text(
        &pick_nullish(&[
            get(context, "providerRevision"),
            get(raw, "providerRevision"),
            get(&nested, "providerRevision"),
        ]),
        None,
        256,
    );
    let provider_route_scope = strict_string(&get(context, "providerRouteScope"), "attempt")
        && runtime_epoch
            .as_ref()
            .is_some_and(|value| !value.is_empty())
        && turn_id.as_ref().is_some_and(|value| !value.is_empty())
        && decision_id.as_ref().is_some_and(|value| !value.is_empty())
        && route_attempt_id
            .as_ref()
            .is_some_and(|value| !value.is_empty())
        && route_generation.is_some()
        && attempt_no.is_some()
        && provider_revision
            .as_ref()
            .is_some_and(|value| !value.is_empty());

    let upstream = deps.upstream.clone();
    let code = normalize_code(&pick_truthy(&[
        get(context, "code"),
        get(&upstream, "code"),
        get(raw, "code"),
        get(&nested, "code"),
        get(&upstream, "type"),
        get(raw, "type"),
        get(&nested, "type"),
    ]));
    let http_status = http_status_of(raw)
        .or_else(|| get(&upstream, "httpStatus").filter(|value| !value.is_nullish()));
    let upstream_message = match get(&upstream, "message") {
        Some(value) => {
            let text = string_or_empty(&Some(value.clone())).trim().to_lowercase();
            if text == "error_during_execution" {
                Some(text_value(""))
            } else {
                Some(value)
            }
        }
        None => None,
    };
    let message = or_value(&[
        presentation_field(&failure, "message"),
        upstream_message,
        Some(source_message(raw)),
    ]);
    let raw_category = match diag_category.as_ref() {
        Some(category) if truthy_value(category) && !strict_string(&diag_category, "unknown") => {
            category.clone()
        }
        _ => JsValue::String(normalize_code(&pick_truthy(&[
            get(context, "category"),
            get(raw, "category"),
            get(&nested, "category"),
        ]))),
    };
    let explicit = structured_category(&http_status, &code, &raw_category);
    let trusted_text_category = if diagnosis_signals && trusted {
        Some(text_fallback_category(&message))
    } else {
        None
    };
    let mut category = explicit
        .or(trusted_text_category)
        .unwrap_or("unknown")
        .to_string();
    let raw_category_allowed = is_category(&raw_category);
    if !raw_category_allowed {
        let code_derived = code_family(&code).is_some();
        if status_eq(&http_status, 403.0)
            && explicit == Some("authentication_permission")
            && !code_in(&AUTH_CODES, &code)
            && trusted_text_category == Some("billing_quota")
        {
            category = "billing_quota".to_string();
        }
        if status_eq(&http_status, 400.0)
            && explicit == Some("invalid_request_model")
            && trusted_text_category == Some("context_token_limit")
        {
            category = "context_token_limit".to_string();
        }
        if status_eq(&http_status, 429.0)
            && explicit == Some("rate_limit")
            && !code_in(&RATE_CODES, &code)
            && trusted_text_category == Some("billing_quota")
        {
            category = "billing_quota".to_string();
        }
        if !code_derived
            && status_in(&http_status, &[500.0, 502.0, 503.0, 504.0, 529.0])
            && matches!(trusted_text_category, Some("network" | "timeout"))
        {
            category = trusted_text_category.unwrap().to_string();
        }
    }
    // A trusted CLI error line such as Codex's "exceeded retry limit, last
    // status: 429 Too Many Requests" must not fall through to `unknown` just
    // because the diagnosis carried no category signal: rate limits are the
    // common cause and heal over time. Only the `unknown` bucket is refined;
    // explicit categories and the replay-safety rules are untouched.
    if category == "unknown" && trusted {
        let fallback = text_fallback_category(&message);
        if fallback != "unknown" {
            category = fallback.to_string();
        }
    }

    let structured_rejection = deps.rejection.clone();
    let http_status_is_429 =
        matches!(&http_status, Some(JsValue::Number(number)) if *number == 429.0);
    let rejection_applies = truthy_value(&structured_rejection)
        && (http_status_is_429
            || (http_status.as_ref().is_none_or(|value| value.is_nullish())
                && source == "proxy_response"));
    let mut rejection = if rejection_applies {
        structured_rejection
    } else {
        JsValue::Null
    };
    if rejection_applies {
        category = if strict_string(&get(&rejection, "kind"), "transient") {
            "rate_limit".to_string()
        } else {
            "billing_quota".to_string()
        };
    }
    let mut synthesized_entitlement = false;
    if !truthy_value(&rejection)
        && category == "billing_quota"
        && trusted_text_category == Some("billing_quota")
        && model_entitlement_text(&message)
    {
        rejection = text_entitlement_rejection();
        synthesized_entitlement = true;
    }

    let partial_output = matches!(get(context, "partialOutput"), Some(JsValue::Bool(true)))
        || matches!(get(raw, "partialOutput"), Some(JsValue::Bool(true)));
    let side_effects = matches!(get(context, "sideEffects"), Some(JsValue::Bool(true)))
        || matches!(get(raw, "sideEffects"), Some(JsValue::Bool(true)));
    let phase = js_to_string(&or_value(&[
        get(context, "phase"),
        get(raw, "phase"),
        Some(text_value(if partial_output {
            "stream"
        } else {
            "before_first_token"
        })),
    ]));

    let mut retry_after_ms = retry_after_of(raw, now, date_parse);
    if retry_after_ms.is_none() && category == "billing_quota" && trusted {
        retry_after_ms = reset_after_from_text(&Some(message.clone()), now, date_parse);
    }
    if !rejection.is_nullish() && strict_string(&get(&rejection, "kind"), "window") {
        if let Some(reset) = get(&rejection, "resetMs").filter(|value| !value.is_nullish()) {
            let reset = js_to_number(&reset);
            if reset > now {
                retry_after_ms = Some(reset - now);
            }
        }
    }
    let retryable = if !diagnosis.is_nullish() && strict_string(&diag_category, &category) {
        get(&diagnosis, "recovery")
            .and_then(|recovery| get(&recovery, "retrySameRequest"))
            .unwrap_or(JsValue::Undefined)
    } else {
        JsValue::Bool(RETRYABLE.iter().any(|entry| *entry == category))
    };
    let replay_safe_phase = matches!(
        phase.to_string_lossy().as_str(),
        "connect" | "before_first_token" | "request"
    );
    let safe_to_retry =
        truthy_value(&retryable) && replay_safe_phase && !partial_output && !side_effects;

    let request_id_raw = pick_truthy(&[
        get(raw, "requestId"),
        get(&nested, "requestId"),
        get(&upstream, "requestId"),
        header_value(&get(raw, "headers"), "x-request-id"),
    ]);
    let request_id = request_id_raw
        .map(|value| JsString::from_rust_str(&format!("req_{}", request_digest(&value))));

    let sanitized_message =
        sanitize_value(&Some(message.clone()), "Upstream API request failed", 240);
    let root_cause = sanitize_value(&Some(message.clone()), "Upstream API request failed", 2048);
    let param = {
        let sanitized = sanitize_value(
            &pick_truthy(&[
                get(&upstream, "param"),
                get(raw, "param"),
                get(&nested, "param"),
            ]),
            "",
            200,
        );
        if sanitized.is_empty() {
            None
        } else {
            Some(sanitized)
        }
    };
    let request_deadline = {
        let number = js_to_number(&get(raw, "requestDeadlineAt").unwrap_or(JsValue::Undefined));
        if number.is_nan() || number == 0.0 {
            None
        } else {
            Some(number)
        }
    };
    let attempt_input = js_to_number(&or_value(&[
        get(context, "attempt"),
        get(raw, "attempt"),
        Some(JsValue::Number(0.0)),
    ]));
    let attempt = js_max_zero(if attempt_input.is_nan() || attempt_input == 0.0 {
        0.0
    } else {
        attempt_input
    });
    let user_action_value = presentation_field(&failure, "userAction")
        .filter(truthy_value)
        .unwrap_or_else(|| {
            JsValue::String(JsString::from_rust_str(&user_action(
                &category,
                retry_after_ms,
                &rejection,
            )))
        });
    let diagnosis_value = if strict_string(&diag_category, &category) {
        diagnosis.clone()
    } else {
        JsValue::Null
    };
    let cause = if !code.is_empty() {
        string_value(code.clone())
    } else if http_status.as_ref().is_some_and(truthy_value) {
        JsValue::String(JsString::from_rust_str(&format!(
            "http_{}",
            js_to_string(http_status.as_ref().unwrap())
        )))
    } else {
        text_value(&category)
    };

    Outcome {
        value: js_object(vec![
            ("category", text_value(&category)),
            ("provider", string_value(provider)),
            ("providerId", optional_text(provider_id)),
            ("providerName", optional_text(provider_name)),
            (
                "providerRouteScope",
                if provider_route_scope {
                    text_value("attempt")
                } else {
                    JsValue::Null
                },
            ),
            ("runtimeEpoch", optional_text(runtime_epoch)),
            ("turnId", optional_text(turn_id)),
            ("decisionId", optional_text(decision_id)),
            ("routeAttemptId", optional_text(route_attempt_id)),
            ("routeGeneration", optional_number(route_generation)),
            ("attemptNo", optional_number(attempt_no)),
            ("providerRevision", optional_text(provider_revision)),
            (
                "code",
                if code.is_empty() {
                    JsValue::Null
                } else {
                    string_value(code.clone())
                },
            ),
            ("httpStatus", http_status.unwrap_or(JsValue::Null)),
            ("retryable", retryable),
            ("requestDeadlineAt", optional_number(request_deadline)),
            (
                "retryBudgetExhausted",
                JsValue::Bool(
                    matches!(get(raw, "retryBudgetExhausted"), Some(JsValue::Bool(true)))
                        || code == "model_request_deadline",
                ),
            ),
            ("retryAfterMs", optional_number(retry_after_ms)),
            ("safeToRetry", JsValue::Bool(safe_to_retry)),
            ("phase", string_value(phase)),
            ("partialOutput", JsValue::Bool(partial_output)),
            ("sideEffects", JsValue::Bool(side_effects)),
            ("attempt", JsValue::Number(attempt)),
            ("maxAttempts", JsValue::Null),
            ("userAction", user_action_value),
            ("diagnosis", diagnosis_value),
            ("rejection", rejection),
            ("sanitizedMessage", string_value(sanitized_message)),
            ("rootCause", string_value(root_cause)),
            ("param", optional_text(param)),
            ("cause", cause),
            ("source", string_value(source)),
            ("requestId", optional_text(request_id)),
        ]),
        text_entitlement_rejection: synthesized_entitlement,
    }
}

fn text_entitlement_rejection() -> JsValue {
    js_object(vec![
        ("kind", text_value("entitlement")),
        ("scope", text_value("model")),
        ("window", JsValue::Null),
        ("resetMs", JsValue::Null),
        ("code", JsValue::Null),
        ("model", JsValue::Null),
        ("source", text_value("text")),
    ])
}

// ---------------------------------------------------------------------------
// The retry decision.
// ---------------------------------------------------------------------------

fn cli_retried_rate_limit(error: &JsValue) -> bool {
    strict_string(&get(error, "category"), "rate_limit")
        && !strict_string(&get(error, "source"), "aux_http")
}

fn max_attempts_for(error: &JsValue) -> f64 {
    let category = get(error, "category");
    if strict_string(&category, "rate_limit") {
        return if cli_retried_rate_limit(error) {
            0.0
        } else {
            2.0
        };
    }
    if strict_string(&category, "provider_transient") || strict_string(&category, "network") {
        return 2.0;
    }
    if strict_string(&category, "timeout") || strict_string(&category, "unknown") {
        return 1.0;
    }
    0.0
}

fn with_max_attempts(error: JsValue, max_attempts: f64) -> JsValue {
    let mut entries = match spread_clone(&error) {
        JsValue::Object(entries) => entries,
        _ => Vec::new(),
    };
    let key = JsString::from_rust_str("maxAttempts");
    let value = JsValue::Number(max_attempts);
    if let Some(entry) = entries.iter_mut().find(|(name, _)| *name == key) {
        entry.1 = value;
    } else {
        entries.push((key, value));
    }
    JsValue::Object(entries)
}

fn fail_fast(reason: &str, budget: Option<&str>, error: &JsValue, attempt: JsValue) -> JsValue {
    let mut fields = vec![
        ("action", text_value("fail_fast")),
        ("reason", text_value(reason)),
    ];
    if let Some(budget) = budget {
        fields.push(("budgetExhaustedBy", text_value(budget)));
    }
    fields.push(("error", error.clone()));
    fields.push(("attempt", attempt));
    fields.push(("delayMs", JsValue::Number(0.0)));
    js_object(fields)
}

fn wait_reset(
    reason: &str,
    error: &JsValue,
    attempt: JsValue,
    delay: JsValue,
    now: f64,
) -> JsValue {
    js_object(vec![
        ("action", text_value("wait_reset")),
        ("reason", text_value(reason)),
        ("error", error.clone()),
        ("attempt", attempt),
        ("delayMs", delay.clone()),
        ("retryAt", js_add(&JsValue::Number(now), &delay)),
    ])
}

pub fn decide(
    raw_error: &JsValue,
    context: &JsValue,
    deps: &NormalizeDeps,
    date_parse: &dyn Fn(&JsString) -> f64,
    random: &mut dyn FnMut() -> f64,
) -> JsValue {
    decide_outcome(raw_error, context, deps, date_parse, random).value
}

pub fn decide_outcome(
    raw_error: &JsValue,
    context: &JsValue,
    deps: &NormalizeDeps,
    date_parse: &dyn Fn(&JsString) -> f64,
    random: &mut dyn FnMut() -> f64,
) -> Outcome {
    let raw_category = get(raw_error, "category").unwrap_or(JsValue::Undefined);
    let (error, text_entitlement_rejection) =
        if deps.known || (truthy_value(raw_error) && is_category(&raw_category)) {
            (spread_clone(raw_error), false)
        } else {
            let normalized = normalize_outcome(raw_error, context, deps, date_parse);
            (normalized.value, normalized.text_entitlement_rejection)
        };
    Outcome {
        value: decide_rest(error, context, deps.now, random),
        text_entitlement_rejection,
    }
}

fn decide_rest(
    mut error: JsValue,
    context: &JsValue,
    now: f64,
    random: &mut dyn FnMut() -> f64,
) -> JsValue {
    let max_attempts = match get(context, "maxAttempts") {
        None | Some(JsValue::Null) | Some(JsValue::Undefined) => max_attempts_for(&error),
        Some(value) => {
            let number = js_to_number(&value);
            js_max_zero(if number.is_nan() || number == 0.0 {
                0.0
            } else {
                number
            })
        }
    };
    error = with_max_attempts(error, max_attempts);
    let attempt_value = get(&error, "attempt").unwrap_or(JsValue::Undefined);
    let next_attempt = js_add(&attempt_value, &JsValue::Number(1.0));
    let next_attempt_number = js_to_number(&next_attempt);
    let category = get(&error, "category").unwrap_or(JsValue::Undefined);
    let category_text = js_to_string(&category);
    let retry_after_value = get(&error, "retryAfterMs").unwrap_or(JsValue::Undefined);
    let retry_after_nullish = retry_after_value.is_nullish();
    let deadline = get(&error, "requestDeadlineAt").unwrap_or(JsValue::Undefined);

    if get(&error, "retryBudgetExhausted").is_some_and(|value| truthy_value(&value))
        || (truthy_value(&deadline) && now >= js_to_number(&deadline))
    {
        return fail_fast(
            "request_budget_exhausted",
            Some("request"),
            &error,
            attempt_value,
        );
    }
    if strict_string(&get(&error, "category"), "cancel_shutdown") {
        return fail_fast("cancelled_or_shutdown", None, &error, attempt_value);
    }
    if strict_string(&get(&error, "category"), "billing_quota") && !retry_after_nullish {
        return wait_reset(
            "quota_reset_required",
            &error,
            attempt_value,
            retry_after_value,
            now,
        );
    }
    let partial = get(&error, "partialOutput").is_some_and(|value| truthy_value(&value));
    let side_effects = get(&error, "sideEffects").is_some_and(|value| truthy_value(&value));
    let safe = get(&error, "safeToRetry").is_some_and(|value| truthy_value(&value));
    if partial || side_effects || !safe {
        let reason = if partial || side_effects {
            "unsafe_replay_boundary".to_string()
        } else {
            format!("{}_not_retryable", category_text)
        };
        return fail_fast(&reason, None, &error, attempt_value);
    }
    if strict_string(&get(&error, "category"), "rate_limit")
        && !retry_after_nullish
        && js_to_number(&retry_after_value) > 5.0 * 60_000.0
    {
        return wait_reset(
            "server_reset_outside_auto_window",
            &error,
            attempt_value,
            retry_after_value,
            now,
        );
    }
    if cli_retried_rate_limit(&error) {
        return fail_fast("rate_limit_retried_by_cli", None, &error, attempt_value);
    }
    if next_attempt_number > max_attempts {
        return fail_fast(
            "retry_budget_exhausted",
            Some("attempts"),
            &error,
            attempt_value,
        );
    }

    let base = match category_text.to_string_lossy().as_str() {
        "rate_limit" => 2_000.0,
        "provider_transient" | "network" | "unknown" => 1_000.0,
        "timeout" => 3_000.0,
        _ => 1_000.0,
    };
    let exponential = js_min(
        30_000.0,
        base * 2f64.powf(js_max_zero(next_attempt_number - 1.0)),
    );
    let jitter = if retry_after_nullish {
        let value = random();
        let value = if value.is_nan() || value == 0.0 {
            0.0
        } else {
            value
        };
        let bounded = js_max_zero(js_min(0.999999, value));
        (bounded * js_min(1_000.0, exponential / 2.0)).floor()
    } else {
        0.0
    };
    let delay = if retry_after_nullish {
        JsValue::Number(exponential + jitter)
    } else {
        retry_after_value
    };
    if truthy_value(&deadline) {
        let after_delay = js_add(&JsValue::Number(now), &delay);
        if js_to_number(&after_delay) >= js_to_number(&deadline) {
            return fail_fast(
                "request_budget_exhausted",
                Some("request"),
                &error,
                attempt_value,
            );
        }
    }
    js_object(vec![
        ("action", text_value("retry")),
        (
            "reason",
            text_value(if retry_after_nullish {
                "bounded_backoff"
            } else {
                "server_retry_after"
            }),
        ),
        ("error", error.clone()),
        ("attempt", next_attempt),
        ("maxAttempts", JsValue::Number(max_attempts)),
        ("delayMs", delay.clone()),
        ("retryAt", js_add(&JsValue::Number(now), &delay)),
    ])
}

// ---------------------------------------------------------------------------
// Notices.
// ---------------------------------------------------------------------------

pub fn metric_token(value: &JsValue) -> JsString {
    let text = string_or_empty(&Some(value.clone())).to_lowercase();
    let token = if text.is_empty() {
        JsString::from_rust_str("unknown")
    } else {
        text
    };
    static RE: OnceLock<Regex> = OnceLock::new();
    let regex = RE.get_or_init(|| Regex::new(r"[^a-z0-9_]+").expect("metric token regex"));
    let view = to_unit_view(&token);
    let replaced = regex.replace_all(&view, "_");
    let trimmed = from_unit_view(replaced.trim_matches('_'));
    if trimmed.is_empty() {
        JsString::from_rust_str("unknown")
    } else {
        trimmed
    }
}

fn reset_wait_label(delay_ms: &JsValue) -> String {
    let ms = js_to_number(delay_ms);
    if !ms.is_finite() || ms <= 0.0 {
        return String::new();
    }
    let minutes = js_max(1.0, js_round(ms / 60_000.0));
    if minutes < 60.0 {
        return format!(
            "\u{ff08}\u{7ea6} {} \u{5206}\u{949f}\u{540e}\u{91cd}\u{7f6e}\u{ff09}",
            number_to_string(minutes)
        );
    }
    let hours = js_max(1.0, js_round(minutes / 60.0));
    if hours < 48.0 {
        return format!(
            "\u{ff08}\u{7ea6} {} \u{5c0f}\u{65f6}\u{540e}\u{91cd}\u{7f6e}\u{ff09}",
            number_to_string(hours)
        );
    }
    format!(
        "\u{ff08}\u{7ea6} {} \u{5929}\u{540e}\u{91cd}\u{7f6e}\u{ff09}",
        number_to_string(js_max(2.0, js_round(hours / 24.0)))
    )
}

fn label_for(
    table: &[(&'static str, &'static str)],
    code: &Option<JsValue>,
) -> Option<&'static str> {
    let code = string_or_empty(code).to_lowercase();
    table
        .iter()
        .find(|(name, _)| code == *name)
        .map(|(_, label)| *label)
}

fn jstr(text: &str) -> JsString {
    JsString::from_rust_str(text)
}

fn cat(parts: &[JsString]) -> JsString {
    let mut out = JsString::new();
    for part in parts {
        out.push(part);
    }
    out
}

fn ends_with_sentence_punct(text: &JsString) -> bool {
    text.as_units()
        .last()
        .is_some_and(|unit| matches!(*unit, 0x3002 | 0x002E | 0x0021 | 0x003F | 0xFF01 | 0xFF1F))
}

pub fn retry_notice(decision: &JsValue) -> JsString {
    if !truthy_value(decision) || !get(decision, "error").is_some_and(|value| truthy_value(&value))
    {
        return jstr("\u{4e0a}\u{6e38} API \u{8bf7}\u{6c42}\u{5931}\u{8d25}\u{ff0c}\u{672a}\u{81ea}\u{52a8}\u{91cd}\u{8bd5}\u{3002}");
    }
    let error = get(decision, "error").unwrap();
    let code = get(&error, "code");
    if let Some(label) = label_for(&SDK_STARTUP_FAILURE_LABELS, &code) {
        return cat(&[
            jstr("Claude \u{542f}\u{52a8}\u{88ab}\u{7b56}\u{7565}\u{6216}\u{73af}\u{5883}\u{62d2}\u{7edd}\u{ff0c}\u{672a}\u{81ea}\u{52a8}\u{91cd}\u{8bd5}\u{3002}"),
            jstr(label),
        ]);
    }
    let cause = js_to_string(&or_value(&[
        get(&error, "rootCause"),
        get(&error, "sanitizedMessage"),
        Some(text_value("")),
    ]))
    .trim();
    let parameter = match get(&error, "param").filter(truthy_value) {
        Some(value) => {
            let text = js_to_string(&value);
            // `cause.includes('')` is always true.
            let found = text.is_empty()
                || cause
                    .as_units()
                    .windows(text.len())
                    .any(|window| window == text.as_units());
            if found {
                JsString::new()
            } else {
                cat(&[
                    jstr("\u{ff08}\u{53c2}\u{6570}\u{ff1a}"),
                    text,
                    jstr("\u{ff09}"),
                ])
            }
        }
        None => JsString::new(),
    };
    let cause_notice = if cause.is_empty() {
        JsString::new()
    } else {
        let full_stop = if ends_with_sentence_punct(&cause) && parameter.is_empty() {
            JsString::new()
        } else {
            jstr("\u{3002}")
        };
        cat(&[
            jstr("\u{6839}\u{56e0}\u{ff1a}"),
            cause.clone(),
            parameter.clone(),
            full_stop,
        ])
    };
    let user_action = js_to_string(&get(&error, "userAction").unwrap_or(JsValue::Undefined));
    let category = get(&error, "category").unwrap_or(JsValue::Undefined);
    if strict_string(&Some(category.clone()), "adapter_configuration") {
        return cat(&[
            jstr("CLI \u{6216}\u{9002}\u{914d}\u{5668}\u{914d}\u{7f6e}\u{9519}\u{8bef}\u{ff0c}\u{672a}\u{81ea}\u{52a8}\u{91cd}\u{8bd5}\u{3002}"),
            cause_notice,
            user_action,
        ]);
    }
    let diagnosis_reason = get(&error, "diagnosis").and_then(|diagnosis| get(&diagnosis, "reason"));
    if strict_string(&diagnosis_reason, "context_overflow") {
        return cat(&[
            jstr("\u{4e0a}\u{4e0b}\u{6587}\u{8d85}\u{9650}\u{ff0c}\u{672a}\u{81ea}\u{52a8}\u{91cd}\u{8bd5}\u{3002}"),
            cause_notice,
            user_action,
        ]);
    }
    if strict_string(&Some(category), "cancel_shutdown") {
        if let Some(label) = label_for(&HOST_STOP_LABELS, &code) {
            return cat(&[
                jstr(label),
                jstr("\u{ff0c}\u{4e0d}\u{662f}\u{4e0a}\u{6e38} API \u{6545}\u{969c}\u{ff1b}\u{672a}\u{81ea}\u{52a8}\u{91cd}\u{653e}\u{3002}"),
                user_action,
            ]);
        }
    }
    let action = get(decision, "action").unwrap_or(JsValue::Undefined);
    let reason = get(decision, "reason").unwrap_or(JsValue::Undefined);
    if strict_string(&Some(action.clone()), "retry") {
        let delay = js_to_number(&get(decision, "delayMs").unwrap_or(JsValue::Undefined));
        let delay = if delay.is_nan() || delay == 0.0 {
            0.0
        } else {
            delay
        };
        let seconds = js_max(1.0, (delay / 1000.0).ceil());
        let attempt = js_to_string(&get(decision, "attempt").unwrap_or(JsValue::Undefined));
        let max_attempts = js_to_string(&get(&error, "maxAttempts").unwrap_or(JsValue::Undefined));
        return cat(&[
            jstr("\u{4e0a}\u{6e38} API \u{6682}\u{65f6}\u{4e0d}\u{53ef}\u{7528}\u{ff0c}\u{5c06}\u{5728} "),
            jstr(&number_to_string(seconds)),
            jstr(" \u{79d2}\u{540e}\u{8fdb}\u{884c}\u{53d7}\u{63a7}\u{91cd}\u{8bd5}\u{ff08}"),
            attempt,
            jstr("/"),
            max_attempts,
            jstr("\u{ff09}\u{3002}"),
            cause_notice,
        ]);
    }
    if strict_string(&Some(action), "wait_reset") {
        let window = jstr(&reset_wait_label(
            &get(decision, "delayMs").unwrap_or(JsValue::Undefined),
        ));
        return cat(&[
            jstr("\u{989d}\u{5ea6}\u{6216}\u{9650}\u{6d41}\u{7a97}\u{53e3}\u{5c1a}\u{672a}\u{6062}\u{590d}"),
            window,
            jstr("\u{ff0c}\u{7cfb}\u{7edf}\u{4e0d}\u{4f1a}\u{77ed}\u{5468}\u{671f}\u{91cd}\u{8bd5}\u{3002}"),
            cause_notice,
            user_action,
        ]);
    }
    if strict_string(&Some(reason.clone()), "unsafe_replay_boundary") {
        let has_code = get(&error, "code").is_some_and(|value| truthy_value(&value));
        let status = js_to_number(&get(&error, "httpStatus").unwrap_or(JsValue::Undefined));
        let source = get(&error, "source").unwrap_or(JsValue::Undefined);
        let from_provider = (has_code || status > 0.0)
            && !NON_PROVIDER_SOURCES
                .iter()
                .any(|name| strict_string(&Some(source.clone()), name));
        let lead = if from_provider {
            "\u{4e0a}\u{6e38} API \u{4e2d}\u{65ad}\u{ff0c}\u{4f46}\u{672c}\u{8f6e}"
        } else {
            "\u{672c}\u{8f6e}\u{672a}\u{6b63}\u{5e38}\u{7ed3}\u{675f}\u{ff08}\u{975e}\u{4e0a}\u{6e38} API \u{6545}\u{969c}\u{ff09}\u{3002}"
        };
        return cat(&[
            jstr(lead),
            jstr("\u{5df2}\u{6709}\u{90e8}\u{5206}\u{8f93}\u{51fa}\u{6216}\u{5de5}\u{5177}\u{6267}\u{884c}\u{ff1b}\u{4e3a}\u{907f}\u{514d}\u{91cd}\u{590d}\u{526f}\u{4f5c}\u{7528}\u{ff0c}\u{672a}\u{81ea}\u{52a8}\u{91cd}\u{653e}\u{3002}"),
            cause_notice,
            user_action,
        ]);
    }
    if strict_string(&Some(reason.clone()), "rate_limit_retried_by_cli") {
        return cat(&[
            jstr("\u{4e0a}\u{6e38}\u{9650}\u{6d41}\u{ff08}HTTP 429\u{ff09}\u{ff1a}CLI \u{8fdb}\u{7a0b}\u{5185}\u{5df2}\u{6309}\u{9000}\u{907f}\u{91cd}\u{8bd5}\u{4ecd}\u{88ab}\u{62d2}\u{7edd}\u{ff0c}\u{7cfb}\u{7edf}\u{4e0d}\u{518d}\u{6574}\u{8f6e}\u{91cd}\u{653e}\u{3002}"),
            cause_notice,
            user_action,
        ]);
    }
    if strict_string(&Some(reason.clone()), "retry_budget_exhausted") {
        let budget = if strict_string(&get(decision, "budgetExhaustedBy"), "attempts") {
            "\u{81ea}\u{52a8}\u{91cd}\u{8bd5}\u{6b21}\u{6570}\u{5df2}\u{7528}\u{5c3d}\u{3002}"
        } else {
            "\u{81ea}\u{52a8}\u{91cd}\u{8bd5}\u{9884}\u{7b97}\u{5df2}\u{7528}\u{5c3d}\u{3002}"
        };
        return cat(&[
            jstr("\u{4e0a}\u{6e38} API \u{8bf7}\u{6c42}\u{4ecd}\u{7136}\u{5931}\u{8d25}\u{ff0c}"),
            jstr(budget),
            cause_notice,
            user_action,
        ]);
    }
    if strict_string(&Some(reason), "request_budget_exhausted") {
        return cat(&[
            jstr("\u{4e0a}\u{6e38}\u{8bf7}\u{6c42}\u{5df2}\u{8d85}\u{51fa}\u{672c}\u{8f6e}\u{7684}\u{7b49}\u{5f85}\u{9884}\u{7b97}\u{ff0c}\u{672a}\u{518d}\u{81ea}\u{52a8}\u{91cd}\u{8bd5}\u{3002}"),
            cause_notice,
            user_action,
        ]);
    }
    cat(&[
        jstr("\u{4e0a}\u{6e38} API \u{8bf7}\u{6c42}\u{5931}\u{8d25}\u{ff0c}\u{672a}\u{81ea}\u{52a8}\u{91cd}\u{8bd5}\u{3002}"),
        cause_notice,
        user_action,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn js(text: &str) -> JsValue {
        JsValue::String(JsString::from_rust_str(text))
    }

    fn no_date(_: &JsString) -> f64 {
        f64::NAN
    }

    #[test]
    fn tables_match_the_javascript_contract() {
        assert_eq!(CONFIG_CODES.len(), 14);
        assert_eq!(SDK_STARTUP_FAILURE_LABELS.len(), 17);
        assert_eq!(HOST_STOP_LABELS.len(), 9);
        assert_eq!(CATEGORIES.len(), 12);
        assert_eq!(API_ERROR_SIGNATURES.len(), 6);
        assert_eq!(signatures_quoted(), "\u{201c}API Error\u{201d}\u{3001}\u{201c}503\u{201d}\u{3001}\u{201c}Connection closed\u{201d}\u{3001}\u{201c}Overloaded\u{201d}\u{3001}\u{201c}Internal server error\u{201d}\u{3001}\u{201c}The system is busy\u{201d}");
    }

    #[test]
    fn normalize_code_matches_the_javascript_rules() {
        assert_eq!(normalize_code(&Some(js("-13"))), "exit_13");
        assert_eq!(
            normalize_code(&Some(js("  Too Many.Requests "))),
            "too_many_requests"
        );
        assert_eq!(normalize_code(&Some(JsValue::Number(-32603.0))), "_32603");
        assert_eq!(normalize_code(&None), "");
    }

    #[test]
    fn source_message_prefers_direct_then_errors() {
        let raw = JsValue::object(vec![
            ("message", JsValue::Null),
            (
                "errors",
                JsValue::Array(vec![js("one"), js(" two "), js("")]),
            ),
        ]);
        assert_eq!(source_message(&raw), js("one | two"));
        let placeholder = JsValue::object(vec![("message", js("error_during_execution"))]);
        assert_eq!(source_message(&placeholder), js("error_during_execution"));
    }

    #[test]
    fn envelope_scanning_finds_the_trailing_unit() {
        let text = js("这是正文。API Error: Request rejected (429) rate limited");
        let envelope = detect_error_envelope(&js("claude"), &text);
        assert_eq!(
            get(&envelope, "message").unwrap(),
            js("API Error: Request rejected (429) rate limited")
        );
        assert_eq!(
            get(&envelope, "httpStatus").unwrap(),
            JsValue::Number(429.0)
        );
        assert_eq!(get(&envelope, "body").unwrap(), js("这是正文"));
        assert_eq!(
            split_trailing_error_envelope(&text),
            JsValue::object(vec![
                ("body", js("这是正文")),
                (
                    "envelope",
                    js("API Error: Request rejected (429) rate limited")
                ),
            ])
        );
    }

    #[test]
    fn harmless_stderr_lines_match_the_measured_noise() {
        assert!(is_known_harmless_stderr_line(&js("  ")));
        assert!(is_known_harmless_stderr_line(&js(
            "failed to refresh available models: timeout"
        )));
        assert!(!is_known_harmless_stderr_line(&js("MCP transport error")));
    }

    #[test]
    fn retry_notice_names_the_host_stop() {
        let error = JsValue::object(vec![
            ("category", js("cancel_shutdown")),
            ("code", js("sigterm")),
            ("userAction", js("无需操作；如有需要可重新发起")),
        ]);
        let decision = JsValue::object(vec![
            ("action", js("fail_fast")),
            ("reason", js("cancelled_or_shutdown")),
            ("error", error),
            ("attempt", JsValue::Number(0.0)),
            ("delayMs", JsValue::Number(0.0)),
        ]);
        assert_eq!(
            retry_notice(&decision),
            "本轮因服务重启或关闭被中断，不是上游 API 故障；未自动重放。无需操作；如有需要可重新发起"
        );
    }

    #[test]
    fn reset_wait_labels_match_the_javascript_rounding() {
        assert_eq!(reset_wait_label(&JsValue::Number(0.0)), "");
        assert_eq!(
            reset_wait_label(&JsValue::Number(15.0 * 60_000.0)),
            "（约 15 分钟后重置）"
        );
        assert_eq!(
            reset_wait_label(&JsValue::Number(3.0 * 3_600_000.0)),
            "（约 3 小时后重置）"
        );
        assert_eq!(
            reset_wait_label(&JsValue::Number(10.0 * 86_400_000.0)),
            "（约 10 天后重置）"
        );
    }

    #[test]
    fn parse_helpers_agree_with_the_javascript_examples() {
        assert_eq!(
            parse_retry_after(&Some(js("7")), 0.0, &no_date),
            Some(7_000.0)
        );
        assert_eq!(parse_reset(&Some(js("120")), 1_000.0), Some(120_000.0));
        assert_eq!(
            reset_after_from_text(&Some(js("It will reset in 12 minutes.")), 0.0, &no_date),
            Some(720_000.0)
        );
        assert_eq!(
            reset_after_from_text(&Some(js("It will reset in 2 days.")), 0.0, &no_date),
            Some(172_800_000.0)
        );
    }
}
