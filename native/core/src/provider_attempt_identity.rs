//! Provider attempt identities and capability wire format.
use crate::js::{node_base64_decode, JsString, JsValue};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};

pub fn valid_identity(value: &JsString) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value
            .as_units()
            .iter()
            .any(|unit| *unit < 32 || *unit == 127)
}

pub fn positive_integer(value: Option<f64>) -> bool {
    value.is_some_and(|number| {
        number.is_finite()
            && number >= 1.0
            && number <= 9_007_199_254_740_991.0
            && number.fract() == 0.0
    })
}

pub fn provider_revision(serialized: &JsString) -> String {
    let hash = Sha256::digest(serialized.utf8_lossy_bytes());
    format!("prv_{hash:x}")[..28].to_owned()
}

pub fn encode_proxy_session(session: &JsString, token: &JsString) -> String {
    format!(
        "pr1.{}.{}",
        URL_SAFE_NO_PAD.encode(session.utf8_lossy_bytes()),
        URL_SAFE_NO_PAD.encode(token.utf8_lossy_bytes())
    )
}

fn decoded(session: JsString, token: Option<JsString>, encoded: bool) -> JsValue {
    JsValue::object(vec![
        ("sessionId", JsValue::String(session)),
        ("token", token.map(JsValue::String).unwrap_or(JsValue::Null)),
        ("encoded", encoded.into()),
    ])
}

pub fn decode_proxy_session(raw: JsString) -> JsValue {
    if !raw.as_units().starts_with(&[112, 114, 49, 46]) {
        return decoded(raw, None, false);
    }
    let invalid = || decoded(JsString::new(), None, true);
    let parts: Vec<_> = raw.as_units().split(|unit| *unit == 46).collect();
    if parts.len() != 3 || parts[1].is_empty() || parts[2].is_empty() {
        return invalid();
    }
    let decode = |units: &[u16]| {
        JsString::from_rust_str(&String::from_utf8_lossy(&node_base64_decode(
            &JsString::from_units(units.to_vec()),
        )))
    };
    let session = decode(parts[1]);
    let token = decode(parts[2]);
    if !valid_identity(&session) || !valid_identity(&token) {
        return invalid();
    }
    decoded(session, Some(token), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_bounds_count_utf16_units() {
        assert!(valid_identity(&"😀".repeat(128).into()));
        assert!(!valid_identity(&"😀".repeat(129).into()));
        assert!(!valid_identity(&"with\u{7f}control".into()));
        assert!(valid_identity(&JsString::from_units(vec![0xd800])));
    }
    #[test]
    fn capability_round_trip_keeps_valid_routes_and_rejects_decoded_controls() {
        let session = JsString::from_rust_str("会话");
        let token = JsString::from_rust_str("token_1");
        assert_eq!(
            decode_proxy_session(encode_proxy_session(&session, &token).into()),
            decoded(session, Some(token), true)
        );
        assert_eq!(
            decode_proxy_session("pr1.AA.AA".into()),
            decoded(JsString::new(), None, true)
        );
        assert_eq!(
            decode_proxy_session("plain".into()),
            decoded("plain".into(), None, false)
        );
    }
}
