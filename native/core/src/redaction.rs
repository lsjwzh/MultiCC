//! Text redaction for logs and provider error messages.
//!
//! Was the string rules of src/observability.js (`redact`,
//! `redactProviderRouteCapability`, the `SECRET_KEY` field test) and
//! `sanitizeMessage` in src/chat/api-error-policy.js. The JS regexes have no
//! `u` flag, so every pattern runs on the UTF-16 unit view of
//! [`crate::js::regex`] with JS's `\s`, `\w`, `\b` and ASCII-only `/i`.
//!
//! Object walking, collision-safe keys and the exact-secret stream redactor
//! stay with their JS callers; only text is rewritten here.

use crate::js::regex::{ascii_ci, from_unit_view, to_unit_view, BOUNDARY, SPACE, WORD};
use crate::js::JsString;
use regex::Regex;
use std::sync::OnceLock;

/// What a provider route capability or token is replaced with.
pub const PROVIDER_ROUTE_REDACTION: &str = "[REDACTED_PROVIDER_ROUTE]";

/// Every text [`redact_route_capability`] changes contains one of these
/// (case-sensitive). Callers that walk many small strings test for them
/// first and skip the call otherwise.
pub const ROUTE_ANCHORS: [&str; 2] = ["pr1.", "proxy-route"];

/// Every text [`redact_text`] changes, and every key [`is_secret_key`]
/// accepts, contains a [`ROUTE_ANCHORS`] entry or one of these under ASCII
/// case folding (the bearer, query and `key=value` rules all start with one).
pub const TEXT_ANCHORS: [&str; 7] = [
    "bearer",
    "token",
    "secret",
    "password",
    "authorization",
    "cookie",
    "api",
];

fn compile(cell: &'static OnceLock<Regex>, pattern: impl FnOnce() -> String) -> &'static Regex {
    cell.get_or_init(|| Regex::new(&pattern()).expect("redaction regex"))
}

fn alternatives(words: &[&str]) -> String {
    words
        .iter()
        .map(|word| ascii_ci(word))
        .collect::<Vec<_>>()
        .join("|")
}

/// `token|secret|password|authorization|cookie|api[-_]?key` under `/i`.
fn secret_words() -> String {
    format!(
        "{}|{}[-_]?{}",
        alternatives(&["token", "secret", "password", "authorization", "cookie"]),
        ascii_ci("api"),
        ascii_ci("key")
    )
}

/// `/pr1\.[A-Za-z0-9_-]{1,344}\.[A-Za-z0-9_-]{1,344}/g`
fn route_capability() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, || {
        r"pr1\.[A-Za-z0-9_-]{1,344}\.[A-Za-z0-9_-]{1,344}".to_string()
    })
}

/// `/proxy-route[-_][A-Za-z0-9_-]{1,344}/g`
fn route_token() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, || r"proxy-route[-_][A-Za-z0-9_-]{1,344}".to_string())
}

/// `/(\bBearer\s+)([A-Za-z0-9._~+\/-]+=*)/ig`
fn bearer() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, || {
        format!(
            r"({BOUNDARY}{}[{SPACE}]+)([A-Za-z0-9._~+/-]+=*)",
            ascii_ci("Bearer")
        )
    })
}

/// `/([?&](?:token|access_token|api_key)=)([^&#\s]+)/ig`
fn query_secret() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, || {
        format!(
            r"([?&](?:{})=)([^&#{SPACE}]+)",
            alternatives(&["token", "access_token", "api_key"])
        )
    })
}

/// `/((?:token|…|api[-_]?key)["']?\s*[=:]\s*["']?)([^"'\s,;}&]+)/ig`
fn secret_text() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, || {
        format!(
            r#"((?:{})["']?[{SPACE}]*[=:][{SPACE}]*["']?)([^"'{SPACE},;}}&]+)"#,
            secret_words()
        )
    })
}

/// `/(?:token|…|api[-_]?key)/i` (the `SECRET_KEY` field-name test).
fn secret_key() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, || format!("(?:{})", secret_words()))
}

fn route_capability_view(view: &str) -> String {
    let once = route_capability().replace_all(view, PROVIDER_ROUTE_REDACTION);
    route_token()
        .replace_all(&once, PROVIDER_ROUTE_REDACTION)
        .into_owned()
}

fn redact_view(view: &str) -> String {
    let text = route_capability_view(view);
    let text = bearer().replace_all(&text, "${1}[REDACTED]");
    let text = query_secret().replace_all(&text, "${1}[REDACTED]");
    secret_text()
        .replace_all(&text, "${1}[REDACTED]")
        .into_owned()
}

/// `redactProviderRouteCapability(text)` for a string.
pub fn redact_route_capability(text: &JsString) -> JsString {
    from_unit_view(&route_capability_view(&to_unit_view(text)))
}

/// `redact(text)` for a string: route capabilities, then bearer tokens, query
/// secrets and `key=value` secrets keep their prefix and lose the value.
pub fn redact_text(text: &JsString) -> JsString {
    from_unit_view(&redact_view(&to_unit_view(text)))
}

/// `SECRET_KEY.test(key)`: a field whose whole value `redact` replaces.
pub fn is_secret_key(key: &JsString) -> bool {
    secret_key().is_match(&to_unit_view(key))
}

/// `/(?:sk|sess|key|token|cookie|auth)[-_A-Za-z0-9.]{8,}/ig`
fn credential_like() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, || {
        format!(
            "(?:{})[-_A-Za-z0-9.]{{8,}}",
            alternatives(&["sk", "sess", "key", "token", "cookie", "auth"])
        )
    })
}

/// `/\b[A-Fa-f0-9]{24,}\b/g`
fn hex_id() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, || format!("{BOUNDARY}[A-Fa-f0-9]{{24,}}{BOUNDARY}"))
}

/// `/\b[A-Za-z0-9_-]{32,}\b/g`
fn opaque_id() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, || format!("{BOUNDARY}[A-Za-z0-9_-]{{32,}}{BOUNDARY}"))
}

/// `/[A-Z]:\\[^\s]+|\/(?:Users|home|var|tmp)\/[^\s]+/g`
fn local_path() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, || {
        format!(r"[A-Z]:\\[^{SPACE}]+|/(?:Users|home|var|tmp)/[^{SPACE}]+")
    })
}

/// `/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g`
fn account() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, || {
        format!(r"{BOUNDARY}[{WORD}.+-]+@[{WORD}.-]+\.[A-Za-z]{{2,}}{BOUNDARY}")
    })
}

/// `/\s+/g`
fn spaces() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, || format!("[{SPACE}]+"))
}

/// `sanitizeMessage(text)` before its fallback and length cap, which the
/// caller applies: whitespace collapsed and trimmed, [`redact_text`], then
/// credential-like words, long hex and opaque ids, local paths and e-mail
/// addresses replaced. The JS first turned `[\r\n\t]+` into a space and then
/// collapsed `\s+`; the first pass only maps whitespace onto whitespace inside
/// the runs the second collapses, so one pass gives the same text.
pub fn sanitize_message(text: &JsString) -> JsString {
    let view = to_unit_view(text);
    let collapsed = spaces().replace_all(&view, " ");
    let trimmed = collapsed.trim_matches(crate::js::is_js_whitespace_char);
    let text = redact_view(trimmed);
    let text = credential_like().replace_all(&text, "[REDACTED]");
    let text = hex_id().replace_all(&text, "[ID]");
    let text = opaque_id().replace_all(&text, "[ID]");
    let text = local_path().replace_all(&text, "[PATH]");
    let text = account().replace_all(&text, "[ACCOUNT]");
    from_unit_view(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(text: &str) -> JsString {
        JsString::from_rust_str(text)
    }

    // Expected values were produced by the Node implementation
    // (src/observability.js and src/chat/api-error-policy.js before the move).
    #[test]
    fn redact_matches_node() {
        let cases = [
            (
                "Authorization: Bearer abc.def-123==",
                "Authorization: [REDACTED] [REDACTED]",
            ),
            (
                "GET /x?token=abc&b=1&api_key=zz#f",
                "GET /x?token=[REDACTED]&b=1&api_key=[REDACTED]",
            ),
            (
                r#"{"password": "hunter2", "Api-Key":'k1'}"#,
                r#"{"password": "[REDACTED]", "Api-Key":'[REDACTED]'}"#,
            ),
            (
                "cap pr1.AAAA.BBBB and proxy-route_xyz",
                "cap [REDACTED_PROVIDER_ROUTE] and [REDACTED_PROVIDER_ROUTE]",
            ),
            ("xBearer abc", "xBearer abc"),
            ("éBearer abc", "éBearer [REDACTED]"),
        ];
        for (input, expected) in cases {
            assert_eq!(redact_text(&s(input)), s(expected), "{input}");
        }
        assert!(is_secret_key(&s("X-Api_Key")));
        assert!(is_secret_key(&s("myCookieJar")));
        assert!(!is_secret_key(&s("pass")));
    }

    /// The anchors are necessary conditions: any text a rule changes contains
    /// one. Checked on every string the generator below can build, which
    /// covers each rule's keywords, separators and boundaries.
    #[test]
    fn every_change_contains_an_anchor() {
        let parts = [
            "token",
            "TOKEN",
            "Bearer ",
            "bearer\t",
            "api_key",
            "API-KEY",
            "access_token",
            "cookie",
            "secret",
            "password",
            "Authorization",
            "pr1.",
            "proxy-route",
            "proxy_route",
            "AAAA",
            ".",
            "=",
            ": ",
            "?",
            "&",
            "\"",
            "x",
            "ſ",
            "\u{212A}",
            "é",
            " ",
        ];
        let lower = |text: &str| text.to_ascii_lowercase();
        let mut n: u32 = 7;
        for _ in 0..20_000 {
            let mut text = String::new();
            for _ in 0..6 {
                n = n.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                text.push_str(parts[(n >> 16) as usize % parts.len()]);
            }
            let js = s(&text);
            let routed = ROUTE_ANCHORS.iter().any(|anchor| text.contains(anchor));
            let anchored = routed
                || TEXT_ANCHORS
                    .iter()
                    .any(|anchor| lower(&text).contains(anchor));
            if redact_route_capability(&js) != js {
                assert!(routed, "{text:?}");
            }
            if redact_text(&js) != js || is_secret_key(&js) {
                assert!(anchored, "{text:?}");
            }
        }
    }

    #[test]
    fn sanitize_matches_node() {
        let cases = [
            ("  a\r\n\tb   c  ", "a b c"),
            ("key=sk-ant-abcdefgh1234", "key=[REDACTED]"),
            ("id 0123456789abcdef01234567 end", "id [ID] end"),
            (
                "at /Users/me/project/x.js:3 and C:\\Temp\\a b",
                "at [PATH] and [PATH] b",
            ),
            ("mail me@example.com now", "mail [ACCOUNT] now"),
            ("sessionABCDEFGH ok", "[REDACTED] ok"),
        ];
        for (input, expected) in cases {
            assert_eq!(sanitize_message(&s(input)), s(expected), "{input}");
        }
        let lone = JsString::from_units(vec![0x20, 0xD800, 0x20]);
        assert_eq!(sanitize_message(&lone), JsString::from_units(vec![0xD800]));
    }
}
