//! Public API error presentation, matching src/api-contract.js. Host-independent
//! UTF-16 text policy for migrated endpoints; do not use provider-log redaction
//! here because that contract has different replacement tokens and limits.
use crate::js::regex::{ascii_ci, from_unit_view, to_unit_view, BOUNDARY, SPACE};
use crate::js::{JsString, JsValue as V};
use regex::Regex;
use std::sync::OnceLock;
fn get<'a>(v: &'a V, key: &str) -> &'a V {
    v.get(key).unwrap_or(&V::Undefined)
}
fn valid(value: &V, max: usize, colon: bool) -> bool {
    let V::String(s) = value else {
        return false;
    };
    (1..=max).contains(&s.len())
        && s.as_units().iter().all(|v| {
            *v < 128
                && ((*v as u8).is_ascii_alphanumeric()
                    || b"_.-".contains(&(*v as u8))
                    || colon && *v == 58)
        })
}
pub fn sanitize(value: &V, fallback: &JsString) -> JsString {
    let raw = if let V::String(s) = value {
        s.trim()
    } else {
        JsString::new()
    };
    let raw = if raw.is_empty() {
        fallback.clone()
    } else {
        raw
    };
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        let words = |items: &[&str]| {
            items
                .iter()
                .map(|v| ascii_ci(v))
                .collect::<Vec<_>>()
                .join("|")
        };
        vec![
            (
                format!(
                    "{BOUNDARY}{}[{SPACE}]+[A-Za-z0-9._~+/\\-]+=*",
                    ascii_ci("Bearer")
                ),
                "Bearer [redacted]",
            ),
            (
                format!(r"{BOUNDARY}(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{{12,}}{BOUNDARY}"),
                "[redacted]",
            ),
            (
                format!(r"{BOUNDARY}fleet_share_[A-Za-z0-9_-]{{24,96}}{BOUNDARY}"),
                "fleet_share_[redacted]",
            ),
            (
                format!(
                    "{BOUNDARY}({}|{}[_ -]?{})[{SPACE}]*[:=][{SPACE}]*([^{SPACE},;]+)",
                    words(&[
                        "token",
                        "secret",
                        "password",
                        "passwd",
                        "authorization",
                        "credential"
                    ]),
                    ascii_ci("api"),
                    ascii_ci("key")
                ),
                "$1=[redacted]",
            ),
            (
                format!(
                    "([?&](?:{})=)[^&#{SPACE}]*",
                    words(&[
                        "token",
                        "access_token",
                        "auth_token",
                        "api_key",
                        "apikey",
                        "authorization"
                    ])
                ),
                "$1[redacted]",
            ),
            (
                format!(r"[A-Za-z]:\\(?:[^\\{SPACE}]+\\){{1,}}[^{SPACE}]*"),
                "[path]",
            ),
            (r"(?:/[A-Za-z0-9._-]+){2,}".into(), "[path]"),
        ]
        .into_iter()
        .map(|(p, r)| (Regex::new(&p).expect("API error regex"), r))
        .collect()
    });
    let mut view = to_unit_view(&raw);
    for (re, replacement) in patterns {
        view = re.replace_all(&view, *replacement).into_owned();
    }
    from_unit_view(&view).truncate_units(240)
}
pub fn error_dto(input: &V, ids: &(String, String)) -> V {
    let message = sanitize(
        get(input, "message"),
        &JsString::from_rust_str("request_error"),
    );
    let mut fields = vec![
        ("ok".into(), false.into()),
        ("error".into(), V::String(message.clone())),
        (
            "code".into(),
            if valid(get(input, "code"), 96, false) {
                get(input, "code").clone()
            } else {
                V::string("request_error")
            },
        ),
    ];
    for key in ["category"] {
        if valid(get(input, key), 64, false) {
            fields.push((key.into(), get(input, key).clone()));
        }
    }
    if let V::String(s) = get(input, "detail") {
        if !s.trim().is_empty() {
            fields.push((
                "detail".into(),
                V::String(sanitize(get(input, "detail"), &message)),
            ));
        }
    }
    if matches!(get(input, "retryable"), V::Bool(_)) {
        fields.push(("retryable".into(), get(input, "retryable").clone()));
    }
    for key in ["action", "scope", "cause"] {
        if valid(get(input, key), 64, false) {
            fields.push((key.into(), get(input, key).clone()));
        }
    }
    if valid(get(input, "upstreamRequestId"), 128, true) {
        fields.push((
            "upstreamRequestId".into(),
            get(input, "upstreamRequestId").clone(),
        ));
    }
    if let V::Number(n) = get(input, "httpStatus") {
        if (400.0..=599.0).contains(n) && n.fract() == 0.0 {
            fields.push(("httpStatus".into(), V::Number(*n)));
        }
    }
    for (key, value) in [
        ("apiVersion", "v1"),
        ("requestId", ids.0.as_str()),
        ("correlationId", ids.1.as_str()),
    ] {
        fields.push((key.into(), V::string(value)));
    }
    V::Object(fields)
}
