//! Public API error presentation, matching src/api-contract.js. Host-independent
//! UTF-16 text policy for migrated endpoints; do not use provider-log redaction
//! here because that contract has different replacement tokens and limits.
use crate::js::regex::{ascii_ci, from_unit_view, to_unit_view, BOUNDARY, SPACE};
use crate::js::{JsString, JsValue as V};
use regex::Regex;
use std::sync::OnceLock;

pub const WS_API_VERSION: &str = "v1";

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
    if valid(get(input, "category"), 64, false) {
        fields.push(("category".into(), get(input, "category").clone()));
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

/// `createWsEnvelope` for JSON-representable values crossing the gateway
/// boundary. `None` corresponds to the host throwing for an invalid payload or
/// a null context. The original key positions are retained when overwritten.
pub fn ws_envelope(payload: &V, context: &V) -> Option<V> {
    if !matches!(payload, V::Object(_))
        || !matches!(get(payload, "type"), V::String(_))
        || matches!(context, V::Null)
    {
        return None;
    }
    let mut envelope = payload.clone();
    crate::quota_guard::set(&mut envelope, "apiVersion", V::string(WS_API_VERSION));
    let request = get(context, "requestId");
    if crate::js::truthy(request) {
        crate::quota_guard::set(
            &mut envelope,
            "requestId",
            if valid(request, 128, true) {
                request.clone()
            } else {
                V::string("unknown")
            },
        );
    }
    let correlation = get(context, "correlationId");
    if crate::js::truthy(correlation) {
        let current_request = get(&envelope, "requestId");
        let fallback = if crate::js::truthy(current_request) {
            current_request.clone()
        } else {
            V::string("unknown")
        };
        crate::quota_guard::set(
            &mut envelope,
            "correlationId",
            if valid(correlation, 128, true) {
                correlation.clone()
            } else {
                fallback
            },
        );
    }
    Some(envelope)
}

#[cfg(test)]
mod ws_envelope_tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};

    #[test]
    fn matches_frozen_node_envelope_bytes() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../docs/rust-migration/differential/ws-envelope-golden.json"
        ))
        .unwrap();
        assert!(cases.len() >= 20);
        for (index, case) in cases.iter().enumerate() {
            let payload = crate::js::json_parse(case["payload"].as_str().unwrap()).unwrap();
            let context = crate::js::json_parse(case["context"].as_str().unwrap()).unwrap();
            let actual =
                ws_envelope(&payload, &context).and_then(|value| crate::js::json_stringify(&value));
            let expected = case["response"]
                .as_str()
                .map(|encoded| String::from_utf8(STANDARD.decode(encoded).unwrap()).unwrap());
            assert_eq!(actual, expected, "oracle case {index}");
        }
    }
}
