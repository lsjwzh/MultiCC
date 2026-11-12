//! `src/http/public-safety.js`, ported rule for rule.
//!
//! Every pattern runs on the JavaScript UTF-16 unit view ([`crate::js::regex`]):
//! `\s` is JS WhiteSpace + LineTerminator (it includes U+FEFF and excludes
//! U+0085), `\b` is the ASCII word boundary, and `/i` folds ASCII letters only.
//! Lengths and truncation count code units, like `String.prototype.length` and
//! `String.prototype.slice(0, 240)`.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::js::regex::{ascii_ci, from_unit_view, to_unit_view, BOUNDARY, SPACE, WORD};
use crate::js::serde::{truthy, value_or_empty};
use crate::js::{js_trim, utf16_len, utf16_prefix, JsString};

pub const MAX_PUBLIC_TEXT: usize = 240;

fn code_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^[A-Za-z0-9_.-]{1,40}$").expect("code pattern"))
}

fn id_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^[A-Za-z0-9._:-]{1,128}$").expect("id pattern"))
}

/// `/^[A-Za-z0-9_.-]{1,40}$/` for a JS string.
pub fn valid_code(value: &str) -> bool {
    code_pattern().is_match(value)
}

/// `validCode(value) ? value : fallback`.
pub fn safe_code(value: &str, fallback: &str) -> String {
    if valid_code(value) {
        value.to_string()
    } else {
        fallback.to_string()
    }
}

/// `/^[A-Za-z0-9._:-]{1,128}$/` for a JS string.
pub fn valid_id(value: &str) -> bool {
    id_pattern().is_match(value)
}

fn sensitive_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let bearer = format!("{BOUNDARY}{}[{SPACE}]+[^{SPACE}]+", ascii_ci("Bearer"));
        let keyword = format!(
            "(?:{}|{}|{}|{}|{}|{}{}?{}|{}|{}(?:{})?)",
            ascii_ci("token"),
            ascii_ci("secret"),
            ascii_ci("password"),
            ascii_ci("passwd"),
            ascii_ci("authorization"),
            ascii_ci("api"),
            "[-_ ]",
            ascii_ci("key"),
            ascii_ci("stderr"),
            ascii_ci("stack"),
            ascii_ci("trace"),
        );
        let key_value = format!(
            "{BOUNDARY}{keyword}{BOUNDARY}[{SPACE}]*(?:[:=]|{BOUNDARY}{}{BOUNDARY})[{SPACE}]*[^{SPACE}]*",
            ascii_ci("is")
        );
        let upstream = format!("{BOUNDARY}{}{BOUNDARY}", ascii_ci("upstream"));
        let secret_token = format!(
            "{BOUNDARY}(?:{}|{}{})[-_][{WORD}-]{{8,}}{BOUNDARY}",
            ascii_ci("sk"),
            ascii_ci("gh"),
            "[pPoOuUsSrR]"
        );
        let path = format!("(?:^|[{SPACE}(\"'`=])/(?:[^/{SPACE}]+/)+[^/{SPACE}]*");
        let windows_path = format!("[A-Za-z]:\\\\(?:[^\\\\{SPACE}]+\\\\)+[^{SPACE}]*");
        [
            bearer,
            key_value,
            upstream,
            secret_token,
            path,
            windows_path,
        ]
        .into_iter()
        .map(|pattern| Regex::new(&pattern).expect("sensitive text pattern"))
        .collect()
    })
}

fn contains_sensitive_view(view: &str) -> bool {
    sensitive_patterns()
        .iter()
        .any(|pattern| pattern.is_match(view))
}

/// `containsSensitiveText(value)` for [`String(value || '')`](value_or_empty).
pub fn contains_sensitive_text(value: &str) -> bool {
    contains_sensitive_view(&to_unit_view(&JsString::from_rust_str(value)))
}

fn control_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"[\x00-\x1F\x7F]+").expect("control pattern"))
}

fn whitespace_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(&format!("[{SPACE}]+")).expect("js whitespace pattern"))
}

/// `fallback.trim().slice(0, 240)`, or `'request_error'` for a blank fallback.
fn fallback_text(fallback: &str) -> String {
    let trimmed = js_trim(fallback);
    if trimmed.is_empty() {
        "request_error".to_string()
    } else {
        utf16_prefix(trimmed, MAX_PUBLIC_TEXT)
    }
}

/// `sanitizePublicText(value, fallback)`.
///
/// `value` is `None` when the JS value was not a string (the caller only has a
/// string when `typeof value === 'string'`). A truncation that splits a
/// surrogate pair follows [`utf16_prefix`]: the lone unit becomes U+FFFD, the
/// convention every remaining JSON-transported kernel uses.
pub fn sanitize_public_text(value: Option<&str>, fallback: &str) -> String {
    let fallback = fallback_text(fallback);
    let Some(value) = value else {
        return fallback;
    };
    if js_trim(value).is_empty() {
        return fallback;
    }
    let view = to_unit_view(&JsString::from_rust_str(value));
    let without_controls = control_pattern().replace_all(&view, " ");
    let squeezed = whitespace_pattern().replace_all(&without_controls, " ");
    let trimmed = js_trim(&squeezed);
    if trimmed.is_empty() || contains_sensitive_view(trimmed) {
        return fallback;
    }
    // Each character of the unit view is exactly one UTF-16 code unit, so the
    // slice counts units like `String.prototype.slice(0, 240)`.
    let cut: String = trimmed.chars().take(MAX_PUBLIC_TEXT).collect();
    from_unit_view(&cut).to_string_lossy()
}

/// `publicText(value, fallback)`: only a string value is sanitized.
pub fn public_text(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(Value::String(text)) => sanitize_public_text(Some(text), fallback),
        _ => sanitize_public_text(None, fallback),
    }
}

/// `publicError(error, fallback)` where `error.message` is `message`.
pub fn public_error(message: Option<&str>, fallback: &str) -> String {
    sanitize_public_text(message, fallback)
}

/// `safeRelativePath(value)`.
pub fn safe_relative_path(value: Option<&str>) -> Option<String> {
    let value = value?;
    let normalized = js_trim(&value.replace('\\', "/")).to_string();
    if normalized.is_empty() || utf16_len(&normalized) > MAX_PUBLIC_TEXT {
        return None;
    }
    if normalized.starts_with('/') || normalized.starts_with("//") || starts_with_drive(&normalized)
    {
        return None;
    }
    if normalized.split('/').any(|segment| segment == "..") {
        return None;
    }
    if control_pattern().is_match(&normalized) || contains_sensitive_text(&normalized) {
        return None;
    }
    Some(normalized)
}

/// `/^[A-Za-z]:\//`.
fn starts_with_drive(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

/// `safeNumber(value)`: a finite, non-negative JS number, else `null`.
pub fn safe_number(value: Option<&Value>) -> Option<Value> {
    let Value::Number(number) = value? else {
        return None;
    };
    let float = number.as_f64()?;
    (float.is_finite() && float >= 0.0).then(|| Value::Number(number.clone()))
}

/// `safeIdArray(value)`: unique valid ids, at most 100, else `null`.
pub fn safe_id_array(value: Option<&Value>) -> Option<Vec<Value>> {
    let items = value?.as_array()?;
    let mut ids: Vec<Value> = Vec::new();
    for item in items {
        let Value::String(text) = item else {
            continue;
        };
        if !valid_id(text) || ids.iter().any(|seen| seen == item) {
            continue;
        }
        ids.push(item.clone());
        if ids.len() == 100 {
            break;
        }
    }
    Some(ids)
}

/// `sanitizeCompatibility(source)`: the narrow, explicitly allowed projection.
pub fn sanitize_compatibility(source: Option<&Value>) -> Value {
    let Some(Value::Object(source)) = source else {
        return Value::Object(Map::new());
    };
    let mut out = Map::new();
    if let Some(Value::Bool(blocked)) = source.get("blocked") {
        out.insert("blocked".to_string(), Value::Bool(*blocked));
    }
    if let Some(Value::Array(reasons)) = source.get("reasons") {
        let mut kept: Vec<Value> = Vec::new();
        for reason in reasons {
            let Value::String(text) = reason else {
                continue;
            };
            if !valid_code(text) || kept.iter().any(|seen| seen == reason) {
                continue;
            }
            kept.push(reason.clone());
            if kept.len() == 50 {
                break;
            }
        }
        if !kept.is_empty() {
            out.insert("reasons".to_string(), Value::Array(kept));
        }
    }
    if let Some(Value::Array(conflicts)) = source.get("conflicts") {
        let mut kept: Vec<Value> = Vec::new();
        for conflict in conflicts {
            let Some(path) = safe_relative_path(conflict.as_str()) else {
                continue;
            };
            let value = Value::String(path);
            if kept.iter().any(|seen| seen == &value) {
                continue;
            }
            kept.push(value);
            if kept.len() == 100 {
                break;
            }
        }
        if !kept.is_empty() {
            out.insert("conflicts".to_string(), Value::Array(kept));
        }
    }
    for key in ["operationId", "field", "currentStatus"] {
        if let Some(Value::String(text)) = source.get(key) {
            if valid_id(text) {
                out.insert(key.to_string(), Value::String(text.clone()));
            }
        }
    }
    for key in ["queueDepth", "retryAfter", "retryAfterSec", "retryAfterMs"] {
        if let Some(number) = safe_number(source.get(key)) {
            out.insert(key.to_string(), number);
        }
    }
    for key in ["sessions", "sessionIds"] {
        if let Some(ids) = safe_id_array(source.get(key)) {
            if !ids.is_empty() {
                out.insert(key.to_string(), Value::Array(ids));
            }
        }
    }
    Value::Object(out)
}

/// `String(value || '')` for callers that only need the boolean-ish forms;
/// kept here so provider rules do not each re-implement it.
pub fn js_text(value: Option<&Value>) -> String {
    value_or_empty(value)
}

/// JS truthiness of a property.
pub fn js_truthy(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn code_and_id_patterns_are_the_js_ones() {
        assert!(valid_code("A"));
        assert!(valid_code("PROVIDER_IMPORT_FAILED-1.2"));
        assert!(valid_code(&"a".repeat(40)));
        assert!(!valid_code(&"a".repeat(41)));
        assert!(!valid_code(""));
        assert!(!valid_code("bad code"));
        assert!(!valid_code("é"));
        assert!(!valid_code("code\n"));

        assert!(valid_id("a"));
        assert!(valid_id("relay:share-1.2_A"));
        assert!(valid_id(&"a".repeat(128)));
        assert!(!valid_id(&"a".repeat(129)));
        assert!(!valid_id("bad id"));
        assert!(!valid_id("é"));

        assert_eq!(safe_code("OK", "fallback"), "OK");
        assert_eq!(safe_code("bad code", "fallback"), "fallback");
    }

    #[test]
    fn sensitive_text_matches_each_pattern_with_js_semantics() {
        // 1. Bearer + non-space.
        assert!(contains_sensitive_text("Authorization: Bearer abc.def"));
        assert!(contains_sensitive_text("bearer x"));
        assert!(!contains_sensitive_text("Bearer"));
        assert!(!contains_sensitive_text("Bearer "));
        // The word boundary is ASCII: a non-ASCII letter does not glue onto it.
        assert!(contains_sensitive_text("éBearer x"));
        assert!(!contains_sensitive_text("xBearer x"));

        // 2. keyword : / = / is + value.
        assert!(contains_sensitive_text("token: abc"));
        assert!(contains_sensitive_text("API-KEY=abc"));
        assert!(contains_sensitive_text("api key = abc"));
        assert!(contains_sensitive_text("stack is empty"));
        assert!(contains_sensitive_text("stacktrace: boom"));
        assert!(contains_sensitive_text("stderr=oops"));
        assert!(contains_sensitive_text("authorization = x"));
        // `tokenis` has no word boundary before `is`, so JS does not match it.
        assert!(!contains_sensitive_text("tokenis=abc"));
        assert!(!contains_sensitive_text("mytoken: abc"));
        assert!(!contains_sensitive_text("token"));
        // `\s*\S*` both accept zero characters, so a bare `token:` matches.
        assert!(contains_sensitive_text("token:"));

        // 3. upstream.
        assert!(contains_sensitive_text("upstream failed"));
        assert!(contains_sensitive_text("UPSTREAM"));
        assert!(!contains_sensitive_text("upstreams"));
        assert!(!contains_sensitive_text("up stream"));

        // 4. sk/gh tokens.
        assert!(contains_sensitive_text("sk-abcdefghij"));
        assert!(contains_sensitive_text("ghp_ABCDEFGH"));
        assert!(contains_sensitive_text("GHO-12345678"));
        assert!(!contains_sensitive_text("sk-abcdefg"));
        assert!(!contains_sensitive_text("skabcdefghij"));
        assert!(!contains_sensitive_text("xsk-abcdefghij"));

        // 5. POSIX-looking paths (no /i: only a leading space or punctuation).
        assert!(contains_sensitive_text("at /home/user/file"));
        assert!(contains_sensitive_text("(/a/b)"));
        assert!(contains_sensitive_text("x=/a/b"));
        assert!(
            contains_sensitive_text("/a/b"),
            "^ is part of the leading class"
        );
        assert!(
            !contains_sensitive_text("a/b/c"),
            "no leading space or punctuation"
        );
        assert!(!contains_sensitive_text("a // b"));

        // 6. Windows paths.
        assert!(contains_sensitive_text(r"C:\Users\me\file"));
        assert!(!contains_sensitive_text(r"C:\Users"));
        // The drive letter is case-insensitive and needs a trailing separator.
        assert!(contains_sensitive_text(r"c:\a\b"));
        assert!(!contains_sensitive_text(r"c:\a"));
    }

    #[test]
    fn sanitize_public_text_normalizes_and_truncates() {
        assert_eq!(
            sanitize_public_text(Some("  hello\t\nworld  "), "fallback"),
            "hello world"
        );
        assert_eq!(
            sanitize_public_text(Some("a\u{0}\u{1F}b\u{7F}c"), "fallback"),
            "a b c"
        );
        // JS whitespace includes U+FEFF and U+00A0.
        assert_eq!(
            sanitize_public_text(Some("a\u{FEFF}b\u{A0}c"), "fallback"),
            "a b c"
        );
        // U+0085 is not JS whitespace, so it survives.
        assert_eq!(
            sanitize_public_text(Some("a\u{85}b"), "fallback"),
            "a\u{85}b"
        );
        assert_eq!(sanitize_public_text(Some("   "), "fallback"), "fallback");
        assert_eq!(sanitize_public_text(None, "fallback"), "fallback");
        assert_eq!(
            sanitize_public_text(Some("token: super-secret"), "fallback"),
            "fallback"
        );
        assert_eq!(
            sanitize_public_text(Some("upstream exploded"), "fallback"),
            "fallback"
        );
        // 240 UTF-16 units, not bytes or scalar values.
        let long = "a".repeat(300);
        assert_eq!(
            sanitize_public_text(Some(&long), "fallback"),
            "a".repeat(MAX_PUBLIC_TEXT)
        );
        let astral = "😀".repeat(150); // 300 code units
        let kept = sanitize_public_text(Some(&astral), "fallback");
        assert_eq!(utf16_len(&kept), MAX_PUBLIC_TEXT);
        assert_eq!(kept.chars().filter(|c| *c == '😀').count(), 120);

        // A blank/invalid fallback becomes 'request_error'; a valid one is
        // trimmed and truncated too.
        assert_eq!(sanitize_public_text(None, "  "), "request_error");
        assert_eq!(
            sanitize_public_text(None, &format!(" {} ", "f".repeat(300))),
            "f".repeat(MAX_PUBLIC_TEXT)
        );
    }

    #[test]
    fn public_text_only_accepts_strings() {
        assert_eq!(public_text(Some(&json!(" ok ")), "fb"), "ok");
        assert_eq!(public_text(Some(&json!(5)), "fb"), "fb");
        assert_eq!(public_text(None, "fb"), "fb");
    }

    #[test]
    fn safe_relative_path_rejects_escapes_and_sensitive_text() {
        assert_eq!(
            safe_relative_path(Some("a/b\\c")),
            Some("a/b/c".to_string())
        );
        assert_eq!(safe_relative_path(Some("/etc/passwd")), None);
        assert_eq!(safe_relative_path(Some("//host/share")), None);
        assert_eq!(safe_relative_path(Some("C:/x")), None);
        assert_eq!(safe_relative_path(Some("a/../b")), None);
        assert_eq!(safe_relative_path(Some("a/..b")), Some("a/..b".to_string()));
        assert_eq!(safe_relative_path(Some("")), None);
        assert_eq!(safe_relative_path(Some("upstream")), None);
        assert_eq!(safe_relative_path(Some("a\u{1}b")), None);
        assert_eq!(safe_relative_path(None), None);
    }

    #[test]
    fn safe_number_and_id_array_follow_the_js_projection() {
        assert_eq!(safe_number(Some(&json!(0))), Some(json!(0)));
        assert_eq!(safe_number(Some(&json!(1.5))), Some(json!(1.5)));
        assert_eq!(safe_number(Some(&json!(-1))), None);
        assert_eq!(safe_number(Some(&json!("2"))), None);
        assert_eq!(safe_number(None), None);

        assert_eq!(
            safe_id_array(Some(&json!(["a", "b", "a", 1, "bad id"]))),
            Some(vec![json!("a"), json!("b")])
        );
        assert_eq!(safe_id_array(Some(&json!("a"))), None);
        assert_eq!(safe_id_array(None), None);
    }

    #[test]
    fn sanitize_compatibility_keeps_only_the_narrow_fields() {
        assert_eq!(sanitize_compatibility(None), json!({}));
        assert_eq!(sanitize_compatibility(Some(&json!([]))), json!({}));
        let value = json!({
            "blocked": true,
            "reasons": ["A", "bad reason", "A"],
            "conflicts": ["a/b", "/etc/passwd", "a/b"],
            "operationId": "op-1",
            "field": "bad field",
            "currentStatus": "ok",
            "queueDepth": 3,
            "retryAfter": -1,
            "retryAfterSec": "9",
            "sessions": ["s1", "s1", "bad id"],
            "sessionIds": [],
            "extra": "dropped",
        });
        assert_eq!(
            sanitize_compatibility(Some(&value)),
            json!({
                "blocked": true,
                "reasons": ["A"],
                "conflicts": ["a/b"],
                "operationId": "op-1",
                "currentStatus": "ok",
                "queueDepth": 3,
                "sessions": ["s1"],
            })
        );
    }
}
