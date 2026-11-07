//! The Node HTTP auth gate, for routes the Rust front door answers itself.
//!
//! Byte-for-byte port of the pieces of `src/auth-security.js`,
//! `src/request-locality.js`, `src/routes/auth.js` (the gate middleware),
//! `src/http-errors.js` (request ids) and `src/api-contract.js`
//! (`createErrorDto` for fixed messages) that decide whether a request may
//! reach a route and what a refusal looks like.
//!
//! Inputs are what Node sees, not what the wire carries: header values are the
//! latin1 strings Node's HTTP parser produces ([`latin1`]), duplicate headers
//! are folded the way `IncomingMessage.headers` folds them ([`NodeHeaders`]),
//! and the peer is `req.socket.remoteAddress` text. Everything that needs Node
//! process state (shutdown flag, metrics counters, download tickets, the
//! provider-relay and fleet authorizers) stays with the caller.

use std::collections::HashMap;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::js::serde::js_json_stringify;
use crate::js::string::js_trim;

pub const COOKIE_NAME: &str = "multicc_auth";
pub const COOKIE_VERSION: i64 = 1;
pub const COOKIE_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const API_VERSION: &str = "v1";

// ── header text as Node exposes it ─────────────────────────────────────────

/// Node decodes header bytes as latin1: every byte becomes the code point of
/// the same value. Comparisons that later re-encode the string as UTF-8 (as
/// `Buffer.from(text)` does) therefore see a non-ASCII byte as two bytes.
pub fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&byte| byte as char).collect()
}

/// `IncomingMessage.headers`: lower-cased names; duplicates of the
/// single-valued headers below keep the first value, `cookie` joins with
/// `"; "`, everything else joins with `", "`.
#[derive(Debug, Default, Clone)]
pub struct NodeHeaders {
    entries: Vec<(String, String)>,
}

const FIRST_WINS: &[&str] = &[
    "age",
    "authorization",
    "content-length",
    "content-type",
    "etag",
    "expires",
    "from",
    "host",
    "if-modified-since",
    "if-unmodified-since",
    "last-modified",
    "location",
    "max-forwards",
    "proxy-authorization",
    "referer",
    "retry-after",
    "server",
    "user-agent",
];

impl NodeHeaders {
    /// Fold raw `(name, value)` pairs in wire order.
    pub fn from_raw<'a>(raw: impl IntoIterator<Item = (&'a str, &'a [u8])>) -> Self {
        let mut entries: Vec<(String, String)> = Vec::new();
        for (name, value) in raw {
            let name = name.to_ascii_lowercase();
            let value = latin1(value);
            match entries.iter_mut().find(|(existing, _)| *existing == name) {
                None => entries.push((name, value)),
                Some((_, existing)) => {
                    if FIRST_WINS.contains(&name.as_str()) || name == "set-cookie" {
                        continue;
                    }
                    let separator = if name == "cookie" { "; " } else { ", " };
                    existing.push_str(separator);
                    existing.push_str(&value);
                }
            }
        }
        Self { entries }
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(existing, _)| existing == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(name, _)| name.as_str())
    }
}

// ── crypto helpers (auth-security.js) ──────────────────────────────────────

/// `timingSafeEqualText`: UTF-8 bytes, length first, then constant time.
pub fn timing_safe_equal_text(left: &str, right: &str) -> bool {
    let (a, b) = (left.as_bytes(), right.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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

fn base64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `Buffer.from(text, 'base64url')`: both alphabets, padding and anything
/// outside the alphabet ignored, a dangling sextet dropped.
fn base64url_decode_lenient(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for byte in text.bytes() {
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
    let iat = now_ms.div_euclid(1000);
    let exp = (now_ms + COOKIE_TTL_MS).div_euclid(1000);
    let claims = format!(
        "{{\"v\":{COOKIE_VERSION},\"iat\":{iat},\"exp\":{exp},\"n\":\"{}\"}}",
        base64url(&nonce)
    );
    let body = base64url(claims.as_bytes());
    let signature = sign(secret, &body);
    format!("{body}.{signature}")
}

fn js_integer(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number.fract() == 0.0).then_some(number)
}

/// `verifyCookie(cookie)`.
pub fn verify_cookie(secret: &str, cookie: &str, now_ms: i64) -> bool {
    if secret.is_empty() {
        return false;
    }
    let parts: Vec<&str> = cookie.split('.').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return false;
    }
    if !timing_safe_equal_text(parts[1], &sign(secret, parts[0])) {
        return false;
    }
    let decoded = String::from_utf8_lossy(&base64url_decode_lenient(parts[0])).into_owned();
    let Ok(claims) = crate::json_lenient::from_str::<Value>(&decoded) else {
        return false;
    };
    let current = now_ms.div_euclid(1000) as f64;
    let version_ok = claims
        .get("v")
        .and_then(Value::as_f64)
        .is_some_and(|v| v == COOKIE_VERSION as f64);
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
    (exp - iat) * 1000.0 <= (COOKIE_TTL_MS + 1000) as f64
}

/// `verifyAccessToken(candidate)`; `None` is any non-string value.
pub fn verify_access_token(secret: &str, candidate: Option<&str>) -> bool {
    !secret.is_empty() && candidate.is_some_and(|text| timing_safe_equal_text(text, secret))
}

/// The local `parseCookies` in server.js: split on `;`, first `=` separates,
/// both sides trimmed, later duplicates win, a pair with an empty name skipped.
pub fn parse_cookies(header: Option<&str>) -> HashMap<String, String> {
    let mut cookies = HashMap::new();
    let Some(header) = header.filter(|text| !text.is_empty()) else {
        return cookies;
    };
    for pair in header.split(';') {
        let mut pieces = js_trim(pair).split('=');
        let key = pieces.next().unwrap_or("");
        if key.is_empty() {
            continue;
        }
        let value = pieces.collect::<Vec<_>>().join("=");
        cookies.insert(js_trim(key).to_string(), js_trim(&value).to_string());
    }
    cookies
}

// ── request-locality.js ────────────────────────────────────────────────────

const LOOPBACK_ADDRESSES: &[&str] = &["127.0.0.1", "::1", "::ffff:127.0.0.1"];

const FORWARDING_HEADERS: &[&str] = &[
    "forwarded",
    "x-real-ip",
    "via",
    "cf-connecting-ip",
    "true-client-ip",
    "client-ip",
    "x-client-ip",
    "x-cluster-client-ip",
    "x-original-forwarded-for",
    "x-envoy-external-address",
    "fastly-client-ip",
    "fly-client-ip",
    "cdn-loop",
];

pub fn request_host(host: Option<&str>) -> String {
    let raw = js_trim(host.unwrap_or("")).to_lowercase();
    if raw.starts_with('[') {
        return match raw.find(']') {
            Some(closing) if closing > 0 => raw[1..closing].to_string(),
            _ => raw,
        };
    }
    raw.split(':').next().unwrap_or("").to_string()
}

pub fn has_forwarding_metadata<'a>(names: impl IntoIterator<Item = &'a str>) -> bool {
    names.into_iter().any(|raw| {
        let name = raw.to_lowercase();
        FORWARDING_HEADERS.contains(&name.as_str()) || name.starts_with("x-forwarded-")
    })
}

pub fn is_external_proxy_request(headers: &NodeHeaders) -> bool {
    let host = request_host(headers.get("host"));
    let local_host = host == "localhost" || host == "127.0.0.1" || host == "::1";
    has_forwarding_metadata(headers.names())
        || !local_host
        || host.ends_with(".ts.net")
        || host.ends_with(".ngrok.io")
        || host.ends_with(".ngrok-free.app")
}

pub fn is_local_request(peer: &str, headers: &NodeHeaders) -> bool {
    LOOPBACK_ADDRESSES.contains(&peer) && !is_external_proxy_request(headers)
}

pub fn is_private_network_address(raw: &str) -> bool {
    let lowered = js_trim(raw).to_lowercase();
    let mut address = lowered.split('%').next().unwrap_or("");
    if let Some(rest) = address.strip_prefix("::ffff:") {
        address = rest;
    }
    if address == "::1" {
        return true;
    }
    let bytes = address.as_bytes();
    let hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
    if bytes.len() >= 5
        && bytes[0] == b'f'
        && (bytes[1] == b'c' || bytes[1] == b'd')
        && hex(bytes[2])
        && hex(bytes[3])
        && bytes[4] == b':'
    {
        return true;
    }
    if bytes.len() >= 5
        && bytes[0] == b'f'
        && bytes[1] == b'e'
        && matches!(bytes[2], b'8' | b'9' | b'a' | b'b')
        && hex(bytes[3])
        && bytes[4] == b':'
    {
        return true;
    }
    let parts: Vec<f64> = address
        .split('.')
        .map(crate::js::number::js_string_to_number)
        .collect();
    if parts.len() != 4
        || parts
            .iter()
            .any(|part| part.fract() != 0.0 || !part.is_finite() || *part < 0.0 || *part > 255.0)
    {
        return false;
    }
    let (a, b) = (parts[0], parts[1]);
    a == 127.0
        || a == 10.0
        || (a == 172.0 && (16.0..=31.0).contains(&b))
        || (a == 192.0 && b == 168.0)
        || (a == 100.0 && (64.0..=127.0).contains(&b))
        || (a == 169.0 && b == 254.0)
}

// ── request ids (http-errors.js) ───────────────────────────────────────────

/// `cleanIncomingId`: `^[A-Za-z0-9._:-]{1,128}$`.
pub fn clean_incoming_id(value: Option<&str>) -> Option<&str> {
    let value = value?;
    let ok = (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'));
    ok.then_some(value)
}

pub fn make_request_id() -> String {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).expect("the OS random source is available");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `(req.id, req.correlationId)` as `requestIdMiddleware` assigns them.
pub fn request_ids(headers: &NodeHeaders) -> (String, String) {
    let id = clean_incoming_id(headers.get("x-request-id"))
        .map(str::to_string)
        .unwrap_or_else(make_request_id);
    let correlation = clean_incoming_id(headers.get("x-correlation-id"))
        .map(str::to_string)
        .unwrap_or_else(|| id.clone());
    (id, correlation)
}

// ── refusals (routes/auth.js + api-contract.js) ────────────────────────────

/// `createErrorDto` for the gate's fixed, already-safe messages.
pub fn error_dto(
    code: &str,
    message: &str,
    extra: &[(&str, Value)],
    ids: &(String, String),
) -> Value {
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(false));
    body.insert("error".into(), Value::String(message.into()));
    body.insert("code".into(), Value::String(code.into()));
    for (key, value) in extra {
        body.insert((*key).into(), value.clone());
    }
    body.insert("apiVersion".into(), Value::String(API_VERSION.into()));
    body.insert("requestId".into(), Value::String(ids.0.clone()));
    body.insert("correlationId".into(), Value::String(ids.1.clone()));
    Value::Object(body)
}

pub fn auth_required_dto(ids: &(String, String)) -> Value {
    let message = "Forbidden: not authenticated";
    error_dto(
        "AUTH_REQUIRED",
        message,
        &[
            ("category", json!("authentication_permission")),
            ("detail", json!(message)),
            ("retryable", json!(false)),
            ("action", json!("login")),
            ("scope", json!("request")),
        ],
        ids,
    )
}

pub fn public_peer_rejected_dto(ids: &(String, String)) -> Value {
    let message =
        "Forbidden: direct public access is disabled; use Tailscale or an explicit remote bind";
    error_dto(
        "DIRECT_PUBLIC_ACCESS_DISABLED",
        message,
        &[
            ("category", json!("authentication_permission")),
            ("detail", json!(message)),
            ("retryable", json!(false)),
            ("action", json!("open_settings")),
            ("scope", json!("host")),
        ],
        ids,
    )
}

/// `encodeURIComponent` over a latin1 string (no lone surrogates possible).
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || "-_.!~*'()".contains(ch) {
            out.push(ch);
        } else {
            let mut buffer = [0u8; 4];
            for byte in ch.encode_utf8(&mut buffer).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

fn percent_decode_plus(text: &str) -> String {
    let replaced = text.replace('+', " ");
    let bytes = replaced.as_bytes();
    let nibble = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (nibble(bytes[index + 1]), nibble(bytes[index + 2])) {
                out.push(high << 4 | low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    match String::from_utf8(out) {
        Ok(text) => text,
        Err(_) => replaced,
    }
}

/// `req.query.token` as Express's `qs` parser yields it, when it is a plain
/// string: exactly one `token=` pair and no `token[...]` forms.
pub fn query_token(original_url: &str) -> Option<String> {
    let query = original_url.split_once('?')?.1;
    let query = query.split('#').next().unwrap_or("");
    let mut found: Option<String> = None;
    let mut count = 0;
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (raw_key, raw_value) = match pair.find("]=") {
            Some(bracket) => (&pair[..bracket + 1], &pair[bracket + 2..]),
            None => pair.split_once('=').unwrap_or((pair, "")),
        };
        let key = percent_decode_plus(raw_key);
        if key == "token" {
            count += 1;
            found = Some(percent_decode_plus(raw_value));
        } else if key.starts_with("token[") {
            count += 2;
        }
    }
    (count == 1).then_some(found).flatten()
}

// ── the gate ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct GatePolicy {
    pub access_token: String,
    pub lan_only: bool,
    pub allow_legacy_token_query: bool,
}

pub struct GateRequest<'a> {
    pub method: &'a str,
    /// `req.path`: the raw pathname, not percent-decoded.
    pub path: &'a str,
    /// `req.originalUrl`: the raw request target.
    pub original_url: &'a str,
    /// `req.socket.remoteAddress`.
    pub peer: &'a str,
    pub headers: &'a NodeHeaders,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision {
    Allow,
    /// 403 `DIRECT_PUBLIC_ACCESS_DISABLED`.
    PeerRejected,
    /// 302 to this location.
    LoginRedirect(String),
    /// 403 `AUTH_REQUIRED`.
    AuthRequired,
}

/// `isAuthenticated(req)`.
pub fn is_authenticated(policy: &GatePolicy, request: &GateRequest) -> bool {
    let secret = policy.access_token.as_str();
    let local = is_local_request(request.peer, request.headers);
    if secret.is_empty() {
        return local;
    }
    if local {
        return true;
    }
    let cookies = parse_cookies(request.headers.get("cookie"));
    if let Some(cookie) = cookies.get(COOKIE_NAME).filter(|value| !value.is_empty()) {
        if verify_cookie(secret, cookie, request.now_ms) {
            return true;
        }
    }
    if verify_access_token(secret, request.headers.get("x-access-token")) {
        return true;
    }
    policy.allow_legacy_token_query
        && verify_access_token(secret, query_token(request.original_url).as_deref())
}

/// The gate a non-public, non-relay, non-fleet route sits behind: the peer
/// allowlist, the machine-grant scope (`authorize_machine_grant` is
/// `machines.authorize`), then `isAuthenticated`, then the refusal shape.
///
/// Callers own the shutdown gate and must not route a path the Node gate
/// treats as public or as fleet/relay scoped through here.
pub fn authorize(
    policy: &GatePolicy,
    request: &GateRequest,
    authorize_machine_grant: impl FnOnce(&str) -> bool,
) -> GateDecision {
    if policy.lan_only && !is_private_network_address(request.peer) {
        return GateDecision::PeerRejected;
    }
    let grant = request.headers.get("x-multicc-machine-grant");
    if let Some(credential) = grant.filter(|value| !value.is_empty()) {
        if authorize_machine_grant(credential) {
            return GateDecision::Allow;
        }
    }
    if grant.filter(|value| !value.is_empty()).is_none() && is_authenticated(policy, request) {
        return GateDecision::Allow;
    }
    let html = request
        .headers
        .get("accept")
        .is_some_and(|accept| accept.contains("text/html"));
    if html || (!request.path.starts_with("/api/") && request.method == "GET") {
        return GateDecision::LoginRedirect(format!(
            "/login?redirect={}",
            encode_uri_component(request.original_url)
        ));
    }
    GateDecision::AuthRequired
}

/// Paths the Node gate lets through without `isAuthenticated`, or where a
/// fleet grant may authorize. A native route on one of these would need the
/// matching Node capability check, so the front door refuses to mount it.
pub fn node_gate_special_path(method: &str, path: &str) -> bool {
    let api = path.starts_with("/api/");
    let lower = path.to_ascii_lowercase();
    let static_ext = [
        ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf",
        ".json", ".apk", ".ipa",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext));
    path == "/login"
        || path == "/logout"
        || path == "/healthz"
        || path == "/readyz"
        || (!api && static_ext)
        || path.starts_with("/ios-ota/")
        || path.starts_with("/share/")
        || path.starts_with("/api/share/")
        || path.starts_with("/fleet-share/")
        || path.starts_with("/api/fleet-shares/")
        || path.starts_with("/artifacts/")
        || path == "/api/download"
        || (method == "POST" && path.starts_with("/api/wait/"))
        || path.starts_with("/claude-proxy")
        || path.starts_with("/codex-proxy")
        || path.starts_with("/api/directories/")
        || path.starts_with("/api/sessions/")
        || path.starts_with("/api/fleet-shares/")
        || matches!(
            path,
            "/api/git/log"
                | "/api/git/commit-files"
                | "/api/git/commit-diff"
                | "/api/providers"
                | "/api/v1/providers"
                | "/api/provider-defaults"
                | "/api/claude/models"
                | "/api/qoder/models"
                | "/api/opencode/models"
        )
        || path == "/api/agent-presets"
        || path.starts_with("/api/agent-presets/")
        || path.starts_with("/services/")
        || !api
}

/// `JSON.stringify` for a response body.
pub fn stringify(value: &Value) -> String {
    js_json_stringify(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> NodeHeaders {
        NodeHeaders::from_raw(pairs.iter().map(|(n, v)| (*n, v.as_bytes())))
    }

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
        let claims = String::from_utf8(base64url_decode_lenient(body)).unwrap();
        assert_eq!(
            claims,
            "{\"v\":1,\"iat\":1700000000,\"exp\":1702592000,\"n\":\"AQIDBAUGBwg\"}"
        );
    }

    #[test]
    fn non_ascii_token_header_never_matches_like_node() {
        // Node reads header bytes as latin1, then Buffer.from() re-encodes UTF-8.
        let raw = "密码".as_bytes();
        let seen = latin1(raw);
        assert!(!verify_access_token("密码", Some(&seen)));
        assert!(verify_access_token("abc123", Some("abc123")));
        assert!(!verify_access_token("", Some("")));
    }

    #[test]
    fn cookies_parse_like_server_js() {
        let parsed = parse_cookies(Some(" a=1; multicc_auth=x.y=z ; =skip; a=2"));
        assert_eq!(parsed.get("a").map(String::as_str), Some("2"));
        assert_eq!(
            parsed.get("multicc_auth").map(String::as_str),
            Some("x.y=z")
        );
        assert!(!parsed.contains_key(""));
    }

    #[test]
    fn locality_needs_loopback_peer_local_host_and_no_forwarding() {
        let local = headers(&[("Host", "localhost:3000")]);
        assert!(is_local_request("127.0.0.1", &local));
        assert!(is_local_request("::ffff:127.0.0.1", &local));
        assert!(!is_local_request("192.168.1.2", &local));
        let forwarded = headers(&[("Host", "localhost"), ("X-Forwarded-For", "")]);
        assert!(!is_local_request("127.0.0.1", &forwarded));
        let public = headers(&[("Host", "box.tail1.ts.net")]);
        assert!(!is_local_request("127.0.0.1", &public));
        let v6 = headers(&[("Host", "[::1]:3000")]);
        assert!(is_local_request("::1", &v6));
    }

    #[test]
    fn private_addresses_follow_number_coercion() {
        for ok in [
            "10.0.0.1",
            "172.16.0.1",
            "192.168.0.9",
            "100.64.1.1",
            "169.254.1.1",
            "::ffff:10.1.2.3",
            "fd12:3456::1",
            "fe80::1%en0",
            "::1",
            "127.0.0.1",
            "10..0.1",
        ] {
            assert!(is_private_network_address(ok), "{ok}");
        }
        for bad in ["8.8.8.8", "172.32.0.1", "2001:db8::1", "", "1.2.3"] {
            assert!(!is_private_network_address(bad), "{bad}");
        }
    }

    #[test]
    fn duplicate_headers_fold_like_node() {
        let folded = headers(&[
            ("Host", "a"),
            ("host", "b"),
            ("X-Access-Token", "t1"),
            ("x-access-token", "t2"),
            ("Cookie", "a=1"),
            ("cookie", "b=2"),
        ]);
        assert_eq!(folded.get("host"), Some("a"));
        assert_eq!(folded.get("x-access-token"), Some("t1, t2"));
        assert_eq!(folded.get("cookie"), Some("a=1; b=2"));
    }

    #[test]
    fn query_token_is_only_a_single_plain_value() {
        assert_eq!(query_token("/x?token=abc").as_deref(), Some("abc"));
        assert_eq!(
            query_token("/x?a=1&token=a%20b+c").as_deref(),
            Some("a b c")
        );
        assert_eq!(query_token("/x?token=a&token=b"), None);
        assert_eq!(query_token("/x?token[]=a"), None);
        assert_eq!(query_token("/x"), None);
    }

    fn gate(
        policy: &GatePolicy,
        method: &str,
        url: &str,
        peer: &str,
        h: &NodeHeaders,
    ) -> GateDecision {
        let path = url.split('?').next().unwrap();
        let request = GateRequest {
            method,
            path,
            original_url: url,
            peer,
            headers: h,
            now_ms: 1_700_000_000_000,
        };
        authorize(policy, &request, |credential| credential == "mcg_ok")
    }

    #[test]
    fn gate_follows_the_node_order() {
        let policy = GatePolicy {
            access_token: "secret-token".into(),
            lan_only: true,
            allow_legacy_token_query: false,
        };
        let remote = headers(&[("Host", "192.168.1.5:3000")]);
        assert_eq!(
            gate(&policy, "GET", "/api/x", "8.8.8.8", &remote),
            GateDecision::PeerRejected
        );
        assert_eq!(
            gate(&policy, "GET", "/api/x", "192.168.1.9", &remote),
            GateDecision::AuthRequired
        );
        let token = headers(&[("Host", "h"), ("X-Access-Token", "secret-token")]);
        assert_eq!(
            gate(&policy, "GET", "/api/x", "192.168.1.9", &token),
            GateDecision::Allow
        );
        let cookie = create_cookie("secret-token", 1_700_000_000_000, [0; 8]);
        let with_cookie = headers(&[("Host", "h"), ("Cookie", &format!("multicc_auth={cookie}"))]);
        assert_eq!(
            gate(&policy, "GET", "/api/x", "192.168.1.9", &with_cookie),
            GateDecision::Allow
        );
        // A machine-grant header disables cookie auth even when the grant fails.
        let grant_and_cookie = headers(&[
            ("Host", "h"),
            ("Cookie", &format!("multicc_auth={cookie}")),
            ("X-Multicc-Machine-Grant", "mcg_bad"),
        ]);
        assert_eq!(
            gate(&policy, "GET", "/api/x", "192.168.1.9", &grant_and_cookie),
            GateDecision::AuthRequired
        );
        let good_grant = headers(&[("Host", "h"), ("X-Multicc-Machine-Grant", "mcg_ok")]);
        assert_eq!(
            gate(&policy, "POST", "/api/x", "192.168.1.9", &good_grant),
            GateDecision::Allow
        );
        let html = headers(&[("Host", "h"), ("Accept", "text/html,*/*")]);
        assert_eq!(
            gate(&policy, "GET", "/api/x?a=1&b=/c", "192.168.1.9", &html),
            GateDecision::LoginRedirect("/login?redirect=%2Fapi%2Fx%3Fa%3D1%26b%3D%2Fc".into())
        );
        let local = headers(&[("Host", "localhost:3000")]);
        assert_eq!(
            gate(&policy, "GET", "/api/x", "127.0.0.1", &local),
            GateDecision::Allow
        );
    }

    #[test]
    fn no_token_admits_only_local() {
        let policy = GatePolicy::default();
        let local = headers(&[("Host", "127.0.0.1:3000")]);
        assert_eq!(
            gate(&policy, "GET", "/api/x", "127.0.0.1", &local),
            GateDecision::Allow
        );
        let lan = headers(&[("Host", "192.168.1.5"), ("X-Access-Token", "")]);
        assert_eq!(
            gate(&policy, "GET", "/api/x", "192.168.1.9", &lan),
            GateDecision::AuthRequired
        );
    }

    #[test]
    fn dto_shape_matches_create_error_dto() {
        let ids = ("abcd1234".to_string(), "abcd1234".to_string());
        assert_eq!(
            stringify(&auth_required_dto(&ids)),
            "{\"ok\":false,\"error\":\"Forbidden: not authenticated\",\"code\":\"AUTH_REQUIRED\",\"category\":\"authentication_permission\",\"detail\":\"Forbidden: not authenticated\",\"retryable\":false,\"action\":\"login\",\"scope\":\"request\",\"apiVersion\":\"v1\",\"requestId\":\"abcd1234\",\"correlationId\":\"abcd1234\"}"
        );
    }

    #[test]
    fn request_ids_accept_clean_incoming_values() {
        let h = headers(&[
            ("X-Request-Id", "req.1:a-b"),
            ("X-Correlation-Id", "bad id"),
        ]);
        assert_eq!(
            request_ids(&h),
            ("req.1:a-b".to_string(), "req.1:a-b".to_string())
        );
        let fresh = request_ids(&NodeHeaders::default());
        assert_eq!(fresh.0.len(), 8);
        assert_eq!(fresh.0, fresh.1);
    }

    #[test]
    fn special_paths_cover_the_node_exemptions() {
        for (method, path) in [
            ("GET", "/login"),
            ("GET", "/app.js"),
            ("POST", "/api/wait/x/resolve"),
            ("GET", "/api/share/t/session"),
            ("GET", "/api/download"),
            ("GET", "/api/claude/models"),
            ("GET", "/api/sessions/s1"),
            ("GET", "/claude-proxy/x"),
            ("GET", "/"),
        ] {
            assert!(node_gate_special_path(method, path), "{method} {path}");
        }
        assert!(!node_gate_special_path(
            "GET",
            "/api/providers/limit-history"
        ));
        assert!(!node_gate_special_path("PUT", "/api/run-config-presets"));
    }
}

#[cfg(test)]
mod node_golden {
    //! Fixture produced by running src/auth-security.js and
    //! src/request-locality.js themselves (see the test names).
    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/http_gate_golden.json")).unwrap()
    }

    #[test]
    fn cookie_bytes_match_node_create_cookie() {
        let fixture = golden();
        let cookie = create_cookie("secret-token", 1_700_000_000_123, [1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(cookie, fixture["cookie"].as_str().unwrap());
        assert!(verify_cookie(
            "secret-token",
            fixture["cookie"].as_str().unwrap(),
            1_700_000_000_123
        ));
    }

    #[test]
    fn private_address_corpus_matches_node() {
        for row in golden()["priv"].as_array().unwrap() {
            let address = row[0].as_str().unwrap();
            assert_eq!(
                is_private_network_address(address),
                row[1].as_bool().unwrap(),
                "{address:?}"
            );
        }
    }

    #[test]
    fn locality_corpus_matches_node() {
        for row in golden()["local"].as_array().unwrap() {
            let peer = row[0].as_str().unwrap();
            let host = row[1].as_str().unwrap();
            let mut raw: Vec<(&str, &[u8])> = vec![("host", host.as_bytes())];
            if let Some(name) = row[2].as_str() {
                raw.push((name, b""));
            }
            let headers = NodeHeaders::from_raw(raw);
            assert_eq!(
                is_local_request(peer, &headers),
                row[3].as_bool().unwrap(),
                "{peer} {host:?} {:?}",
                row[2]
            );
        }
    }
}
