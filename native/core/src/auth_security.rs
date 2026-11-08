//! Authentication primitives shared by the gateway and the N-API runtime.
//! No process-global credentials or ticket tables: each owner holds one store.
use crate::js::{json::json_parse, JsString, JsValue};
use sha2::{Digest, Sha256};
use url::Url;

pub const COOKIE_VERSION: i64 = 1;
pub const COOKIE_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const TICKET_TTL_MS: i64 = 30_000;
pub const MAX_TICKETS: usize = 2048;

// ── crypto helpers (auth-security.js) ──────────────────────────────────────

/// `timingSafeEqualText`: UTF-8 bytes, length first, then constant time.
pub fn timing_safe_equal_text(left: &str, right: &str) -> bool {
    let (a, b) = (left.as_bytes(), right.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    use subtle::ConstantTimeEq;
    a.ct_eq(b).into()
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

pub fn base64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn random_base64url(size: usize) -> Result<String, String> {
    let mut bytes = vec![0; size];
    getrandom::fill(&mut bytes).map_err(|_| "OS random source unavailable".to_owned())?;
    Ok(base64url(&bytes))
}

/// `Buffer.from(text, 'base64url')`: both alphabets, padding and anything
/// outside the alphabet ignored, a dangling sextet dropped.
fn base64url_decode_lenient(units: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(units.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for byte in units.iter().map(|unit| *unit as u8) {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => continue,
        };
        buffer = (buffer << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    out
}

/// `sign(payload)`: empty when there is no secret.
pub fn sign(secret: &str, payload: &str) -> String {
    if secret.is_empty() {
        return String::new();
    }
    base64url(&hmac_sha256(secret.as_bytes(), payload.as_bytes()))
}

/// `createCookie()` with the clock and the 8 nonce bytes supplied.
pub fn create_cookie(secret: &str, now_ms: i64, nonce: [u8; 8]) -> String {
    let body = cookie_body(now_ms as f64, COOKIE_TTL_MS as f64, &base64url(&nonce));
    format!("{body}.{}", sign(secret, &body))
}

pub fn cookie_body(now_ms: f64, ttl_ms: f64, nonce: &str) -> String {
    use crate::js::{json::json_stringify, JsValue};
    let claims = json_stringify(&JsValue::object(vec![
        ("v", JsValue::Number(COOKIE_VERSION as f64)),
        ("iat", JsValue::Number((now_ms / 1000.0).floor())),
        ("exp", JsValue::Number(((now_ms + ttl_ms) / 1000.0).floor())),
        ("n", JsValue::string(nonce)),
    ]))
    .expect("claims object");
    base64url(claims.as_bytes())
}

fn js_integer(value: Option<&JsValue>) -> Option<f64> {
    let JsValue::Number(number) = value? else {
        return None;
    };
    let number = *number;
    (number.is_finite() && number.fract() == 0.0).then_some(number)
}

/// `verifyCookie(cookie)`.
pub fn verify_cookie(secret: &str, cookie: &str, now_ms: i64) -> bool {
    verified_claims(secret, cookie)
        .is_some_and(|claims| valid_claims(&claims, now_ms as f64, COOKIE_TTL_MS as f64))
}

pub fn verified_claims(secret: &str, cookie: &str) -> Option<JsValue> {
    verified_claims_js(secret, &JsString::from_rust_str(cookie))
}

pub fn valid_cookie_shape(cookie: &JsString) -> bool {
    let parts: Vec<_> = cookie.as_units().split(|u| *u == 46).collect();
    parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty()
}

pub fn verified_claims_js(secret: &str, cookie: &JsString) -> Option<JsValue> {
    if secret.is_empty() || !valid_cookie_shape(cookie) {
        return None;
    }
    let parts: Vec<_> = cookie.as_units().split(|u| *u == 46).collect();
    let body = String::from_utf16_lossy(parts[0]);
    let signature = String::from_utf16_lossy(parts[1]);
    if !timing_safe_equal_text(&signature, &sign(secret, &body)) {
        return None;
    }
    // Buffer's base64 decoder reads the low byte of UTF-16 units. Keeping the
    // units here also preserves malformed-but-signed historical cookie inputs.
    let decoded = String::from_utf8_lossy(&base64url_decode_lenient(parts[0])).into_owned();
    json_parse(&decoded).ok()
}

pub fn valid_claims(claims: &JsValue, now_ms: f64, ttl_ms: f64) -> bool {
    let current = (now_ms / 1000.0).floor();
    let version_ok =
        matches!(claims.get("v"), Some(JsValue::Number(v)) if *v == COOKIE_VERSION as f64);
    let (Some(iat), Some(exp)) = (js_integer(claims.get("iat")), js_integer(claims.get("exp")))
    else {
        return false;
    };
    if !version_ok {
        return false;
    }
    if iat > current + 60.0 || exp <= current || exp <= iat {
        return false;
    }
    (exp - iat) * 1000.0 <= (ttl_ms + 1000.0)
}

/// `verifyAccessToken(candidate)`; `None` is any non-string value.
pub fn verify_access_token(secret: &str, candidate: Option<&str>) -> bool {
    !secret.is_empty() && candidate.is_some_and(|text| timing_safe_equal_text(text, secret))
}

const BASE: &str = "http://multicc.local";
fn same_origin_url(value: &str) -> Option<Url> {
    let parsed = Url::parse(BASE).ok()?.join(value).ok()?;
    (parsed.origin().ascii_serialization() == BASE).then_some(parsed)
}

pub fn normalize_ws_path(value: &str) -> Option<String> {
    Some(same_origin_url(value)?.path().to_owned())
}

pub fn normalize_redirect(value: &str) -> Option<String> {
    if !value.starts_with('/')
        || value.starts_with("//")
        || value
            .chars()
            .any(|c| matches!(c, '\\' | '\r' | '\n' | '\0'))
    {
        return None;
    }
    let url = same_origin_url(value)?;
    let mut out = url.path().to_owned();
    if let Some(query) = url.query().filter(|s| !s.is_empty()) {
        out.push('?');
        out.push_str(query);
    }
    if let Some(hash) = url.fragment().filter(|s| !s.is_empty()) {
        out.push('#');
        out.push_str(hash);
    }
    Some(out)
}

pub struct TicketRecord<M> {
    hash: [u8; 32],
    pub path: String,
    pub expires_at: f64,
    pub metadata: M,
}

/// Insertion ordered, including replacement of a repeated random ticket.
/// The host adapter supplies metadata without serializing JS reference values.
pub struct WsTickets<M> {
    records: Vec<TicketRecord<M>>,
}
impl<M> Default for WsTickets<M> {
    fn default() -> Self {
        Self {
            records: Vec::new(),
        }
    }
}
impl<M> WsTickets<M> {
    pub fn len(&self) -> usize {
        self.records.len()
    }
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }
    pub fn prune(&mut self, now: f64, max: usize) -> Vec<M> {
        let mut removed = Vec::new();
        let mut index = 0;
        while index < self.records.len() {
            if self.records[index].expires_at <= now {
                removed.push(self.records.remove(index).metadata);
            } else {
                index += 1;
            }
        }
        while !self.records.is_empty() && self.records.len() >= max {
            removed.push(self.records.remove(0).metadata);
        }
        removed
    }
    pub fn insert(
        &mut self,
        ticket: &str,
        path: String,
        expires_at: f64,
        metadata: M,
    ) -> Option<M> {
        let hash = Sha256::digest(ticket.as_bytes()).into();
        let record = TicketRecord {
            hash,
            path,
            expires_at,
            metadata,
        };
        if let Some(old) = self.records.iter_mut().find(|r| r.hash == hash) {
            Some(std::mem::replace(old, record).metadata)
        } else {
            self.records.push(record);
            None
        }
    }
    /// Remove before calling the host clock: even a clock error consumes it.
    pub fn take(&mut self, ticket: &str) -> Option<TicketRecord<M>> {
        let hash: [u8; 32] = Sha256::digest(ticket.as_bytes()).into();
        let index = self.records.iter().position(|r| r.hash == hash)?;
        Some(self.records.remove(index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hmac_matches_rfc4231_case_2() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        let hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn cookie_round_trips_and_expires() {
        let now = 1_700_000_000_123;
        let cookie = create_cookie("secret-token", now, [1, 2, 3, 4, 5, 6, 7, 8]);
        assert!(verify_cookie("secret-token", &cookie, now));
        assert!(!verify_cookie("other-token", &cookie, now));
        assert!(!verify_cookie("", &cookie, now));
        assert!(!verify_cookie(
            "secret-token",
            &cookie,
            now + COOKIE_TTL_MS + 1000
        ));
        assert!(!verify_cookie("secret-token", &format!("{cookie}.x"), now));
        let (body, _) = cookie.split_once('.').unwrap();
        let claims = String::from_utf8(base64url_decode_lenient(
            JsString::from_rust_str(body).as_units(),
        ))
        .unwrap();
        assert_eq!(
            claims,
            "{\"v\":1,\"iat\":1700000000,\"exp\":1702592000,\"n\":\"AQIDBAUGBwg\"}"
        );
    }
}
