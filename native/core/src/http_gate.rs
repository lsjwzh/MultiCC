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

use crate::js::serde::js_json_stringify;
use crate::js::string::js_trim;

pub const COOKIE_NAME: &str = "multicc_auth";
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

pub use crate::auth_security::{
    create_cookie, sign, timing_safe_equal_text, verify_access_token, verify_cookie, COOKIE_TTL_MS,
    COOKIE_VERSION,
};

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

pub const LOOPBACK_ADDRESSES: &[&str] = &["127.0.0.1", "::1", "::ffff:127.0.0.1"];

pub const FORWARDING_HEADERS: &[&str] = &[
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
    request_host_utf16(&crate::js::JsString::from_rust_str(host.unwrap_or(""))).to_string_lossy()
}

/// Host adapters may contain isolated UTF-16 surrogates; preserve them just as
/// String.trim().toLowerCase() does, while wire headers use the same rules.
pub fn request_host_utf16(host: &crate::js::JsString) -> crate::js::JsString {
    let raw = host.trim().to_lowercase();
    let units = raw.as_units();
    let (start, end) = if units.first() == Some(&91) {
        match units.iter().position(|u| *u == 93) {
            Some(end) if end > 0 => (1, end),
            _ => (0, units.len()),
        }
    } else {
        (
            0,
            units.iter().position(|u| *u == 58).unwrap_or(units.len()),
        )
    };
    crate::js::JsString::from_units(units[start..end].to_vec())
}

pub fn local_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

pub fn has_forwarding_metadata<'a>(names: impl IntoIterator<Item = &'a str>) -> bool {
    names.into_iter().any(|raw| {
        let name = raw.to_lowercase();
        FORWARDING_HEADERS.contains(&name.as_str()) || name.starts_with("x-forwarded-")
    })
}

pub fn is_external_proxy_request(headers: &NodeHeaders) -> bool {
    let host = request_host(headers.get("host"));
    let local_host = local_host(&host);
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

/// qs's decoder: `+` is a space, then `decodeURIComponent`, and when that
/// throws (a `%` without two hex digits, or bytes that are not UTF-8) the
/// whole string with only the `+` replaced.
pub fn percent_decode_plus(text: &str) -> String {
    let replaced = text.replace('+', " ");
    let bytes = replaced.as_bytes();
    let nibble = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = (
                bytes.get(index + 1).copied().and_then(nibble),
                bytes.get(index + 2).copied().and_then(nibble),
            );
            let (Some(high), Some(low)) = pair else {
                return replaced;
            };
            out.push(high << 4 | low);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    match String::from_utf8(out) {
        Ok(text) => text,
        Err(_) => replaced,
    }
}

/// `req.query[name]` under Express's `qs` parser, as far as a route that
/// wants a string needs to know.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryParam {
    Missing,
    /// Exactly one plain `name=` pair.
    Text(String),
    /// An array or object (`name=a&name=b`, `name[]=a`, `name[k]=a`).
    Other,
}

/// qs only reads the first `parameterLimit` (1000) `&`-separated parts.
const QS_PARAMETER_LIMIT: usize = 1000;

pub fn query_param(original_url: &str, name: &str) -> QueryParam {
    let Some((_, query)) = original_url.split_once('?') else {
        return QueryParam::Missing;
    };
    let query = query.split('#').next().unwrap_or("");
    let nested = format!("{name}[");
    let mut found: Option<String> = None;
    let mut count = 0;
    for pair in query
        .split('&')
        .take(QS_PARAMETER_LIMIT)
        .filter(|pair| !pair.is_empty())
    {
        let (raw_key, raw_value) = match pair.find("]=") {
            Some(bracket) => (&pair[..bracket + 1], &pair[bracket + 2..]),
            None => pair.split_once('=').unwrap_or((pair, "")),
        };
        let key = percent_decode_plus(raw_key);
        if key == name {
            count += 1;
            found = Some(percent_decode_plus(raw_value));
        } else if key.starts_with(&nested) {
            count += 2;
        }
    }
    match (count, found) {
        (0, _) => QueryParam::Missing,
        (1, Some(value)) => QueryParam::Text(value),
        _ => QueryParam::Other,
    }
}

/// `req.query[name]` keeping the value shapes `qs` produces, for routes that
/// pass the value through `Number()` / `typeof === 'string'`. Express parses
/// with `qs.parse(str, { allowPrototypes: true, arrayLimit: 1000 })`, so a
/// single `a[0]=5` is an array (and `Number()` is 5), while `a[1000]=5` and
/// `a[k]=5` are objects (NaN).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryValue {
    Missing,
    Text(String),
    /// A qs array. Elements stay nested because `Number([['5']])` is 5.
    List(Vec<QueryValue>),
    /// Any object: `Number()` is NaN and it is never a string.
    Object,
}

/// `String(req.query.x || '')`: falsy scalars become `''`, arrays join
/// recursively with commas, objects become `[object Object]`.
pub fn query_string(value: &QueryValue) -> String {
    match value {
        QueryValue::Missing => String::new(),
        QueryValue::Text(text) => text.clone(),
        QueryValue::List(items) => items.iter().map(query_string).collect::<Vec<_>>().join(","),
        QueryValue::Object => "[object Object]".to_string(),
    }
}

/// Express's qs options (`node_modules/express/lib/utils.js`).
const QS_ARRAY_LIMIT: usize = 1000;
/// qs' default `depth`; express does not override it.
const QS_DEPTH: usize = 5;

/// The value tree qs builds before compaction. `None` is a hole: JS arrays keep
/// their length while compacting drops the holes at the end.
#[derive(Debug, Clone, PartialEq, Eq)]
enum QsValue {
    Text(String),
    List(Vec<Option<QsValue>>),
    Object,
    /// qs' `markOverflow` object: an index past `arrayLimit` (or an array that
    /// grew past it) becomes an object that later scalars append to, so it can
    /// never turn back into an array.
    Overflow,
}

/// `parseValues` runs this over the whole query before splitting: literal
/// brackets arrive percent-encoded and must open a key group.
fn qs_unescape_brackets(query: &str) -> String {
    let bytes = query.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() && bytes[index + 1] == b'5' {
            match bytes[index + 2] {
                b'B' | b'b' => {
                    out.push(b'[');
                    index += 3;
                    continue;
                }
                b'D' | b'd' => {
                    out.push(b']');
                    index += 3;
                    continue;
                }
                _ => {}
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| query.to_string())
}

pub fn query_value(original_url: &str, name: &str) -> QueryValue {
    let Some((_, query)) = original_url.split_once('?') else {
        return QueryValue::Missing;
    };
    let query = query.split('#').next().unwrap_or("");
    let query = qs_unescape_brackets(query);
    let query = query.as_str();
    // qs first groups equal (decoded) keys, combining repeats into an array,
    // and then parses each distinct key into the nested accumulator.
    let mut flat: Vec<(String, QsValue)> = Vec::new();
    for pair in query.split('&').take(QS_PARAMETER_LIMIT) {
        if pair.is_empty() {
            continue;
        }
        let (raw_key, raw_value) = match pair.find("]=") {
            Some(bracket) => (&pair[..bracket + 1], &pair[bracket + 2..]),
            None => pair.split_once('=').unwrap_or((pair, "")),
        };
        let key = percent_decode_plus(raw_key);
        if key.is_empty() {
            continue;
        }
        let value = QsValue::Text(percent_decode_plus(raw_value));
        match flat.iter_mut().find(|(other, _)| *other == key) {
            Some((_, existing)) => *existing = qs_combine(existing.clone(), value),
            None => flat.push((key, value)),
        }
    }
    let mut accumulator: Option<QsValue> = None;
    for (key, value) in flat {
        if let Some(contribution) = qs_contribution(&key, value, name) {
            accumulator = Some(qs_merge(accumulator, contribution));
        }
    }
    match accumulator {
        Some(value) => qs_classify(&value),
        None => QueryValue::Missing,
    }
}

/// `utils.combine`, which is `[].concat(a, b)` for two flat values.
fn qs_combine(left: QsValue, right: QsValue) -> QsValue {
    let mut items = match left {
        QsValue::List(items) => items,
        other => vec![Some(other)],
    };
    match right {
        QsValue::List(items) => items,
        other => vec![Some(other)],
    }
    .into_iter()
    .for_each(|item| items.push(item));
    if items.len() > QS_ARRAY_LIMIT {
        QsValue::Overflow
    } else {
        QsValue::List(items)
    }
}

/// One decoded key → the value it contributes to the top-level `name`.
fn qs_contribution(key: &str, value: QsValue, name: &str) -> Option<QsValue> {
    let segments = qs_segments(key);
    if segments.first().map(String::as_str) != Some(name) {
        return None;
    }
    let mut leaf = value;
    for segment in segments[1..].iter().rev() {
        leaf = qs_segment(segment, leaf);
    }
    Some(leaf)
}

/// `splitKeyIntoSegments` with `allowDots: false` and qs' default depth.
fn qs_segments(key: &str) -> Vec<String> {
    let bytes = key.as_bytes();
    let mut segments = Vec::new();
    let Some(first) = key.find('[') else {
        return vec![key.to_string()];
    };
    if first > 0 {
        segments.push(key[..first].to_string());
    }
    let mut open = Some(first);
    let mut collected = 0;
    while let Some(start) = open {
        if collected >= QS_DEPTH {
            break;
        }
        let mut level = 1;
        let mut index = start + 1;
        let mut close = None;
        while index < bytes.len() {
            match bytes[index] {
                b'[' => level += 1,
                b']' => {
                    level -= 1;
                    if level == 0 {
                        close = Some(index);
                        break;
                    }
                }
                _ => {}
            }
            index += 1;
        }
        let Some(end) = close else {
            // Unterminated group: qs wraps the remainder in one literal segment.
            segments.push(format!("[{}]", &key[start..]));
            return segments;
        };
        segments.push(key[start..=end].to_string());
        collected += 1;
        open = key[end + 1..].find('[').map(|hit| end + 1 + hit);
    }
    if let Some(start) = open {
        // `strictDepth` is off, so the tail becomes one literal segment.
        segments.push(format!("[{}]", &key[start..]));
    }
    segments
}

/// One bracket segment, folded from the leaf backwards (`parseObject`).
fn qs_segment(segment: &str, leaf: QsValue) -> QsValue {
    if segment == "[]" {
        let items = match leaf {
            QsValue::List(items) => items,
            other => vec![Some(other)],
        };
        return qs_limit(items);
    }
    let inner = &segment[1..segment.len() - 1];
    match qs_index(inner) {
        Some(index) if index < QS_ARRAY_LIMIT => {
            let mut items = vec![None; index + 1];
            items[index] = Some(leaf);
            QsValue::List(items)
        }
        // An index past `arrayLimit` is an object marked overflow.
        Some(_) => QsValue::Overflow,
        // Named keys are plain properties on an object.
        None => QsValue::Object,
    }
}

/// qs' `isValidArrayIndex`: canonical non-negative decimal digits only.
fn qs_index(text: &str) -> Option<usize> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if text.len() > 1 && text.starts_with('0') {
        return None;
    }
    text.parse().ok()
}

fn qs_is_object(value: &QsValue) -> bool {
    matches!(
        value,
        QsValue::List(_) | QsValue::Object | QsValue::Overflow
    )
}

/// `utils.merge(target, source, { arrayLimit: 1000, strictMerge: true })` for
/// one root property, with objects collapsed (their contents never affect
/// `Number()` or `typeof`).
fn qs_merge(target: Option<QsValue>, source: QsValue) -> QsValue {
    // The first line of `merge` is `if (!source) return target;`, so an empty
    // string never replaces an existing value.
    if matches!(&source, QsValue::Text(text) if text.is_empty()) {
        return target.unwrap_or_else(|| QsValue::Text(String::new()));
    }
    match source {
        QsValue::Text(text) => match target {
            None => QsValue::Text(text),
            Some(QsValue::Overflow) => QsValue::Overflow,
            Some(QsValue::List(mut items)) => {
                if items.len() >= QS_ARRAY_LIMIT {
                    return QsValue::Overflow;
                }
                items.push(Some(QsValue::Text(text)));
                QsValue::List(items)
            }
            Some(QsValue::Text(previous)) => QsValue::List(vec![
                Some(QsValue::Text(previous)),
                Some(QsValue::Text(text)),
            ]),
            // `strictMerge` (the qs 6.15 default): a scalar merged into a plain
            // object becomes `[object, scalar]` instead of a property.
            Some(QsValue::Object) => {
                QsValue::List(vec![Some(QsValue::Object), Some(QsValue::Text(text))])
            }
        },
        QsValue::List(items) => match target {
            None => qs_limit(items),
            Some(QsValue::Overflow) => QsValue::Overflow,
            Some(QsValue::Text(previous)) => {
                let mut merged = vec![Some(QsValue::Text(previous))];
                merged.extend(items);
                qs_limit(merged)
            }
            Some(QsValue::List(mut previous)) => {
                qs_merge_lists(&mut previous, items);
                qs_limit(previous)
            }
            // `arrayToObject`: an array merged into an object stays an object.
            Some(QsValue::Object) => QsValue::Object,
        },
        QsValue::Object => match target {
            None | Some(QsValue::Object) => QsValue::Object,
            Some(QsValue::Overflow) => QsValue::Overflow,
            Some(QsValue::Text(previous)) => {
                QsValue::List(vec![Some(QsValue::Text(previous)), Some(QsValue::Object)])
            }
            Some(QsValue::List(_)) => QsValue::Object,
        },
        // An overflow object only ever grows by numeric index, so every later
        // contribution leaves it an object.
        QsValue::Overflow => QsValue::Overflow,
    }
}

/// The array branch of `utils.merge`: holes are skipped, an occupied slot with
/// a non-object on either side appends, and two objects merge in place.
fn qs_merge_lists(target: &mut Vec<Option<QsValue>>, source: Vec<Option<QsValue>>) {
    for (index, item) in source.into_iter().enumerate() {
        let Some(item) = item else {
            continue;
        };
        if index < target.len() {
            if let Some(previous) = target[index].as_ref() {
                if qs_is_object(previous) && qs_is_object(&item) {
                    let previous = target[index].take();
                    target[index] = Some(qs_merge(previous, item));
                } else {
                    target.push(Some(item));
                }
            } else {
                target[index] = Some(item);
            }
        } else {
            target.resize(index + 1, None);
            target[index] = Some(item);
        }
    }
}

fn qs_limit(items: Vec<Option<QsValue>>) -> QsValue {
    if items.len() > QS_ARRAY_LIMIT {
        QsValue::Overflow
    } else {
        QsValue::List(items)
    }
}

/// `utils.compact` (holes disappear recursively) and the QueryValue shape.
fn qs_classify(value: &QsValue) -> QueryValue {
    match value {
        QsValue::Text(text) => QueryValue::Text(text.clone()),
        QsValue::Object | QsValue::Overflow => QueryValue::Object,
        QsValue::List(items) => QueryValue::List(
            items
                .iter()
                .flatten()
                .map(qs_classify)
                .collect::<Vec<QueryValue>>(),
        ),
    }
}

/// `req.query.token` as Express's `qs` parser yields it, when it is a plain
/// string: exactly one `token=` pair and no `token[...]` forms.
pub fn query_token(original_url: &str) -> Option<String> {
    match query_param(original_url, "token") {
        QueryParam::Text(value) => Some(value),
        _ => None,
    }
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
/// allowlist, a download ticket (`GET /api/download` only;
/// `verify_download_ticket` gets the `download_ticket` query value), the
/// machine-grant scope (`authorize_machine_grant` is `machines.authorize`),
/// then `isAuthenticated`, then the refusal shape.
///
/// Callers own the shutdown gate and must not route a path the Node gate
/// treats as public or as fleet/relay scoped through here.
pub fn authorize(
    policy: &GatePolicy,
    request: &GateRequest,
    authorize_machine_grant: impl FnOnce(&str) -> bool,
    verify_download_ticket: impl FnOnce(&str) -> bool,
) -> GateDecision {
    if policy.lan_only && !is_private_network_address(request.peer) {
        return GateDecision::PeerRejected;
    }
    // src/routes/auth.js: `req.method === 'GET' && req.path === '/api/download'`
    // (case-sensitive; HEAD does not qualify) and a string ticket.
    if request.method == "GET" && request.path == "/api/download" {
        if let QueryParam::Text(ticket) = query_param(request.original_url, "download_ticket") {
            if !ticket.is_empty() && verify_download_ticket(&ticket) {
                return GateDecision::Allow;
            }
        }
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
        authorize(
            policy,
            &request,
            |credential| credential == "mcg_ok",
            |ticket| ticket == "tk_ok",
        )
    }

    #[test]
    fn query_string_coerces_like_js_string() {
        let s = |url: &str| query_string(&query_value(url, "appType"));
        assert_eq!(s("/x"), "");
        assert_eq!(s("/x?appType=claude"), "claude");
        assert_eq!(s("/x?appType=claude&appType=codex"), "claude,codex");
        // `String(['claude'])` keeps the single element.
        assert_eq!(s("/x?appType[]=claude"), "claude");
        assert_eq!(s("/x?appType[x]=1"), "[object Object]");
    }

    #[test]
    fn query_param_follows_qs() {
        let p = |url: &str| query_param(url, "path");
        assert_eq!(p("/d?path=%2Fa%20b+c"), QueryParam::Text("/a b c".into()));
        assert_eq!(p("/d?path="), QueryParam::Text(String::new()));
        assert_eq!(p("/d?path"), QueryParam::Text(String::new()));
        assert_eq!(p("/d?x=1"), QueryParam::Missing);
        assert_eq!(p("/d"), QueryParam::Missing);
        assert_eq!(p("/d?path=a&path=b"), QueryParam::Other);
        assert_eq!(p("/d?path[]=a"), QueryParam::Other);
        assert_eq!(p("/d?path%5Bk%5D=a"), QueryParam::Other);
        assert_eq!(p("/d?path[=a"), QueryParam::Other);
        // decodeURIComponent throws on any stray `%`: qs keeps the whole text.
        assert_eq!(p("/d?path=a%zz%41"), QueryParam::Text("a%zz%41".into()));
        assert_eq!(p("/d?path=100%"), QueryParam::Text("100%".into()));
        assert_eq!(p("/d?path=%E4%B8%AD"), QueryParam::Text("中".into()));
        assert_eq!(p("/d?path=%E4%B8"), QueryParam::Text("%E4%B8".into()));
    }

    #[test]
    fn a_download_ticket_opens_only_get_api_download() {
        let policy = GatePolicy {
            access_token: "secret-token".into(),
            lan_only: true,
            allow_legacy_token_query: false,
        };
        let remote = headers(&[("Host", "192.168.1.5:3000")]);
        let lan = "192.168.1.9";
        let url = "/api/download?path=%2Fa&download_ticket=tk_ok";
        assert_eq!(gate(&policy, "GET", url, lan, &remote), GateDecision::Allow);
        assert_eq!(
            gate(&policy, "HEAD", url, lan, &remote),
            GateDecision::AuthRequired
        );
        let upper = "/api/Download?path=%2Fa&download_ticket=tk_ok";
        assert_eq!(
            gate(&policy, "GET", upper, lan, &remote),
            GateDecision::AuthRequired
        );
        let wrong = "/api/download?path=%2Fa&download_ticket=tk_no";
        assert_eq!(
            gate(&policy, "GET", wrong, lan, &remote),
            GateDecision::AuthRequired
        );
        let twice = "/api/download?download_ticket=tk_ok&download_ticket=tk_ok";
        assert_eq!(
            gate(&policy, "GET", twice, lan, &remote),
            GateDecision::AuthRequired
        );
        // The peer allowlist still comes first.
        assert_eq!(
            gate(&policy, "GET", url, "8.8.8.8", &remote),
            GateDecision::PeerRejected
        );
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
        // The download-ticket exemption is implemented by `authorize` itself.
        assert!(!node_gate_special_path("GET", "/api/download"));
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

    /// The fixture's shape, one level of `query_value`.
    fn query_shape(value: &QueryValue) -> serde_json::Value {
        match value {
            QueryValue::Missing => serde_json::json!({ "kind": "missing" }),
            QueryValue::Text(text) => serde_json::json!({ "kind": "text", "value": text }),
            QueryValue::Object => serde_json::json!({ "kind": "object" }),
            QueryValue::List(items) => serde_json::json!({
                "kind": "array",
                "items": items.iter().map(query_shape).collect::<Vec<_>>(),
            }),
        }
    }

    #[test]
    fn query_value_matches_the_real_express_query_parser() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/qs-query-cases.json"))
                .expect("qs query fixture");
        for case in fixture["cases"].as_array().unwrap() {
            let key = case["key"].as_str().unwrap();
            let query = case["query"].as_str().unwrap();
            let url = format!("/probe/{key}?{query}");
            assert_eq!(
                query_shape(&query_value(&url, key)),
                case["expected"],
                "{}: ?{}",
                case["name"],
                query
            );
        }
    }

    #[test]
    fn query_value_keeps_string_routes_on_the_plain_pairs() {
        // query_param/query_token back auth and download links; they only care
        // that a repeated or bracketed key is not a plain string.
        assert_eq!(query_param("/x?a=1", "a"), QueryParam::Text("1".into()));
        assert_eq!(query_param("/x?a=1&a=2", "a"), QueryParam::Other);
        assert_eq!(query_param("/x?a[0]=1", "a"), QueryParam::Other);
        assert_eq!(query_param("/x?b=1", "a"), QueryParam::Missing);
        assert_eq!(query_token("/x?token=a%2Bb"), Some("a+b".into()));
    }
}
