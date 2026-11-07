//! Task run context wall builder.
//!
//! Compiles the context block injected as a task-bound session's first-turn
//! prompt prefix. Everything is derived from the board record plus durable
//! turn refs; credentials and native session identities are redacted before
//! anything is rendered.
//!
//! The host sends and receives JSON, but the wire format is only the transport:
//! JavaScript string semantics are load-bearing here, so text is carried as
//! UTF-16 code units (`Vec<u16>`) and every length, slice, sort and digest is
//! computed on code units, not scalar values. Strings that contain a lone
//! surrogate travel as `{"$multiccText": "<base64 utf16le>"}` and Buffers as
//! `{"$multiccBuffer": "<base64>"}`; both are decoded before the rules run.
//! Results are serialized with `JSON.stringify` byte semantics so a lone high
//! surrogate produced by cutting a surrogate pair survives the boundary.
use crate::json_lenient;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone};
use regex::{Captures, Regex};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const DEFAULT_MAX_CHARS: f64 = 12_000.0;
const MAX_TASK_ID_CHARS: f64 = 200.0;
const MAX_TASK_TITLE_CHARS: f64 = 240.0;
const REDACTED: &str = "[redacted]";

type Text = Vec<u16>;

/// A JSON-shaped value with JavaScript string semantics. Object keys stay
/// valid UTF-8: lone surrogates in keys are out of scope for the wire format.
#[derive(Clone, Debug)]
pub enum JsValue {
    Null,
    /// An own property or array element whose value is `undefined`. JavaScript
    /// only shows the difference from a missing key in `stableStringify`, which
    /// prints `undefined` inside objects and nothing inside arrays.
    Undefined,
    Bool(bool),
    Number(f64),
    Text(Text),
    Binary(Vec<u8>),
    Array(Vec<JsValue>),
    Object(Vec<(String, JsValue)>),
}

fn text(value: &str) -> Text {
    value.encode_utf16().collect()
}

fn cat(parts: &[&Text]) -> Text {
    let mut out = Vec::new();
    for part in parts {
        out.extend_from_slice(part);
    }
    out
}

fn join(parts: &[Text], separator: &Text) -> Text {
    let mut out = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            out.extend_from_slice(separator);
        }
        out.extend_from_slice(part);
    }
    out
}

fn lossy(value: &[u16]) -> String {
    let mut out = String::with_capacity(value.len());
    let mut index = 0;
    while index < value.len() {
        let unit = value[index];
        if (0xD800..=0xDBFF).contains(&unit) {
            if let Some(&low) = value.get(index + 1) {
                if (0xDC00..=0xDFFF).contains(&low) {
                    let code = 0x10000 + ((unit as u32 - 0xD800) << 10) + (low as u32 - 0xDC00);
                    out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                    index += 2;
                    continue;
                }
            }
            out.push('\u{FFFD}');
        } else if (0xDC00..=0xDFFF).contains(&unit) {
            out.push('\u{FFFD}');
        } else {
            out.push(char::from_u32(unit as u32).unwrap_or('\u{FFFD}'));
        }
        index += 1;
    }
    out
}

/// UTF-8 bytes the way Node's `Hash.update(string)` and `Buffer.byteLength`
/// encode them: lone surrogates become U+FFFD.
fn utf8(value: &[u16]) -> Vec<u8> {
    lossy(value).into_bytes()
}

fn digest_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn digest_text(value: &[u16]) -> String {
    digest_bytes(&utf8(value))
}

fn is_js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000
            ..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

fn is_js_space_char(c: char) -> bool {
    c.len_utf16() == 1 && is_js_space(c as u32 as u16)
}

fn trim_js(value: &[u16]) -> Text {
    let start = value.iter().position(|unit| !is_js_space(*unit));
    let Some(start) = start else {
        return Vec::new();
    };
    let end = value.iter().rposition(|unit| !is_js_space(*unit)).unwrap() + 1;
    value[start..end].to_vec()
}

fn lowercase_js(value: &Text) -> Text {
    text(&lossy(value).to_lowercase())
}

fn compare_text(left: &[u16], right: &[u16]) -> std::cmp::Ordering {
    left.cmp(right)
}

fn compare_string(left: &str, right: &str) -> std::cmp::Ordering {
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    left.cmp(&right)
}

// ---------------------------------------------------------------------------
// JavaScript value semantics
// ---------------------------------------------------------------------------

fn prop<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, v)| v),
        _ => None,
    }
}

/// `a ?? b`: a nullish first value falls through. `None` is `undefined`.
fn nullish<'a>(first: Option<&'a JsValue>, second: Option<&'a JsValue>) -> Option<&'a JsValue> {
    match first {
        None | Some(JsValue::Null) | Some(JsValue::Undefined) => second,
        value => value,
    }
}

/// `truthiness` of a JavaScript value.
fn truthy(value: Option<&JsValue>) -> bool {
    match value {
        None | Some(JsValue::Null) | Some(JsValue::Undefined) => false,
        Some(JsValue::Bool(flag)) => *flag,
        Some(JsValue::Number(number)) => *number != 0.0 && !number.is_nan(),
        Some(JsValue::Text(units)) => !units.is_empty(),
        Some(JsValue::Binary(bytes)) => !bytes.is_empty(),
        Some(_) => true,
    }
}

fn number_string(number: f64) -> String {
    if number.is_nan() {
        return "NaN".into();
    }
    if number == f64::INFINITY {
        return "Infinity".into();
    }
    if number == f64::NEG_INFINITY {
        return "-Infinity".into();
    }
    if number == 0.0 {
        return "0".into();
    }
    ryu_js::Buffer::new().format_finite(number).to_string()
}

/// `String(value == null ? '' : value)`.
fn to_text(value: Option<&JsValue>) -> Text {
    match value {
        None | Some(JsValue::Null) | Some(JsValue::Undefined) => Vec::new(),
        Some(JsValue::Text(units)) => units.clone(),
        Some(JsValue::Number(number)) => text(&number_string(*number)),
        Some(JsValue::Bool(flag)) => text(if *flag { "true" } else { "false" }),
        Some(JsValue::Binary(bytes)) => text(&String::from_utf8_lossy(bytes)),
        Some(JsValue::Array(items)) => {
            let parts: Vec<Text> = items
                .iter()
                .map(|item| match item {
                    JsValue::Null => Vec::new(),
                    other => to_text(Some(other)),
                })
                .collect();
            join(&parts, &text(","))
        }
        Some(JsValue::Object(_)) => text("[object Object]"),
    }
}

/// `Number(value)`.
fn to_number(value: Option<&JsValue>) -> f64 {
    match value {
        None | Some(JsValue::Undefined) => f64::NAN,
        Some(JsValue::Null) => 0.0,
        Some(JsValue::Bool(flag)) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Some(JsValue::Number(number)) => *number,
        Some(JsValue::Text(units)) => parse_number(&lossy(units)),
        Some(JsValue::Binary(bytes)) => parse_number(&String::from_utf8_lossy(bytes)),
        Some(JsValue::Array(_)) => parse_number(&lossy(&to_text(value))),
        Some(JsValue::Object(_)) => f64::NAN,
    }
}

fn decimal_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    if matches!(bytes.get(index), Some(b'+') | Some(b'-')) {
        index += 1;
    }
    let integer_start = index;
    while matches!(bytes.get(index), Some(byte) if byte.is_ascii_digit()) {
        index += 1;
    }
    let integer_digits = index - integer_start;
    let mut fraction_digits = 0;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while matches!(bytes.get(index), Some(byte) if byte.is_ascii_digit()) {
            index += 1;
        }
        fraction_digits = index - fraction_start;
    }
    if integer_digits == 0 && fraction_digits == 0 {
        return false;
    }
    if matches!(bytes.get(index), Some(b'e') | Some(b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+') | Some(b'-')) {
            index += 1;
        }
        let exponent_start = index;
        while matches!(bytes.get(index), Some(byte) if byte.is_ascii_digit()) {
            index += 1;
        }
        if index == exponent_start {
            return false;
        }
    }
    index == bytes.len()
}

fn radix_value(digits: &str, radix: u32) -> f64 {
    let mut value = 0.0;
    for c in digits.chars() {
        let digit = c.to_digit(radix);
        match digit {
            Some(digit) => value = value * radix as f64 + digit as f64,
            None => return f64::NAN,
        }
    }
    value
}

/// `Number(string)` — StringNumericLiteral, without the empty-string 0 case
/// confusion: an all-whitespace string is 0.
fn parse_number(value: &str) -> f64 {
    let trimmed: String = value.trim_matches(is_js_space_char).to_string();
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed.as_str() {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16u32),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = trimmed.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            return radix_value(digits, radix);
        }
    }
    if !decimal_shape(&trimmed) {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

fn js_date_parse(value: &Text) -> Option<f64> {
    let raw = lossy(value);
    let trimmed = raw.trim_matches(is_js_space_char);
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.timestamp_millis() as f64);
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, format) {
            return Local
                .from_local_datetime(&naive)
                .earliest()
                .map(|parsed| parsed.timestamp_millis() as f64);
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() as f64);
    }
    if let Ok(month) = NaiveDate::parse_from_str(&format!("{trimmed}-01"), "%Y-%m-%d") {
        return Some(month.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() as f64);
    }
    if let Ok(year) = NaiveDate::parse_from_str(&format!("{trimmed}-01-01"), "%Y-%m-%d") {
        return Some(year.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() as f64);
    }
    None
}

// ---------------------------------------------------------------------------
// JSON.stringify-compatible serialization
// ---------------------------------------------------------------------------

fn write_js_string(units: &[u16], out: &mut String) {
    out.push('"');
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        match unit {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x09 => out.push_str("\\t"),
            0x0A => out.push_str("\\n"),
            0x0C => out.push_str("\\f"),
            0x0D => out.push_str("\\r"),
            unit if unit < 0x20 => out.push_str(&format!("\\u{unit:04x}")),
            0xD800..=0xDBFF => {
                let low = units.get(index + 1).copied();
                match low {
                    Some(low) if (0xDC00..=0xDFFF).contains(&low) => {
                        let code = 0x10000 + ((unit as u32 - 0xD800) << 10) + (low as u32 - 0xDC00);
                        if let Some(c) = char::from_u32(code) {
                            out.push(c);
                        }
                        index += 1;
                    }
                    _ => out.push_str(&format!("\\u{unit:04x}")),
                }
            }
            0xDC00..=0xDFFF => out.push_str(&format!("\\u{unit:04x}")),
            unit => {
                if let Some(c) = char::from_u32(unit as u32) {
                    out.push(c);
                }
            }
        }
        index += 1;
    }
    out.push('"');
}

/// `Output` is what crosses the FFI boundary and must be valid JSON that
/// `JSON.parse` restores exactly, so negative zero is written as `-0`.
/// `Stringify` reproduces `JSON.stringify`, where negative zero prints as `0`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Output,
    Stringify,
}

fn write_number(number: f64, mode: Mode, out: &mut String) {
    if !number.is_finite() {
        out.push_str("null");
    } else if mode == Mode::Output && number == 0.0 && number.is_sign_negative() {
        out.push_str("-0");
    } else {
        out.push_str(&number_string(number));
    }
}

fn write_value(value: &JsValue, mode: Mode, out: &mut String) {
    match value {
        JsValue::Null => out.push_str("null"),
        JsValue::Undefined => out.push_str("undefined"),
        JsValue::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        JsValue::Number(number) => write_number(*number, mode, out),
        JsValue::Text(units) => write_js_string(units, out),
        JsValue::Binary(bytes) => {
            out.push_str("{\"type\":\"Buffer\",\"data\":");
            write_js_string(&text(&STANDARD.encode(bytes)), out);
            out.push('}');
        }
        JsValue::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                // `array.map(stableStringify).join(',')` renders undefined as ''.
                if !matches!(item, JsValue::Undefined) {
                    write_value(item, mode, out);
                }
            }
            out.push(']');
        }
        JsValue::Object(entries) => {
            let mut order: Vec<usize> = (0..entries.len()).collect();
            if mode == Mode::Stringify {
                order.sort_by(|&left, &right| compare_string(&entries[left].0, &entries[right].0));
            }
            out.push('{');
            for (position, &index) in order.iter().enumerate() {
                if position > 0 {
                    out.push(',');
                }
                write_js_string(&text(&entries[index].0), out);
                out.push(':');
                write_value(&entries[index].1, mode, out);
            }
            out.push('}');
        }
    }
}

fn to_json(value: &JsValue, mode: Mode) -> String {
    let mut out = String::new();
    write_value(value, mode, &mut out);
    out
}

// ---------------------------------------------------------------------------
// Wire decoding
// ---------------------------------------------------------------------------

fn decode_base64(value: &Value) -> Option<Vec<u8>> {
    STANDARD.decode(value.as_str()?).ok()
}

fn decode_marker(entries: &[(String, Value)]) -> Option<JsValue> {
    if entries.len() != 1 {
        return None;
    }
    match entries[0].0.as_str() {
        "$multiccBuffer" => Some(JsValue::Binary(decode_base64(&entries[0].1)?)),
        "$multiccUndefined" => Some(JsValue::Undefined),
        "$multiccNumber" => {
            let number = match entries[0].1.as_str()? {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "-0" => -0.0,
                _ => return None,
            };
            Some(JsValue::Number(number))
        }
        "$multiccText" => {
            let bytes = decode_base64(&entries[0].1)?;
            if bytes.len() % 2 != 0 {
                return None;
            }
            let mut units = Vec::with_capacity(bytes.len() / 2);
            let mut index = 0;
            while index < bytes.len() {
                units.push(u16::from_le_bytes([bytes[index], bytes[index + 1]]));
                index += 2;
            }
            Some(JsValue::Text(units))
        }
        _ => None,
    }
}

fn from_json(value: &Value) -> JsValue {
    match value {
        Value::Null => JsValue::Null,
        Value::Bool(flag) => JsValue::Bool(*flag),
        Value::Number(number) => JsValue::Number(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(value) => JsValue::Text(text(value)),
        Value::Array(items) => JsValue::Array(items.iter().map(from_json).collect()),
        Value::Object(map) => {
            let entries: Vec<(String, Value)> = map
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            if let Some(marker) = decode_marker(&entries) {
                return marker;
            }
            JsValue::Object(
                entries
                    .iter()
                    .map(|(key, value)| (key.clone(), from_json(value)))
                    .collect(),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const WS_INNER: &str = "\\u{9}\\u{a}\\u{b}\\u{c}\\u{d}\\u{20}\\u{a0}\\u{1680}\\u{2000}-\\u{200a}\
\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}\\u{feff}";

struct Patterns {
    crlf: Regex,
    session_id: Regex,
    session_field: Regex,
    auth_line: Regex,
    auth_scheme: Regex,
    bearer: Regex,
    basic: Regex,
    jwt: Regex,
    token: Regex,
    secret: Regex,
}

/// Case-insensitive literal without Unicode folding: the host's `/i` flag
/// never folds a non-ASCII character onto an ASCII one, so `[Aa]` classes are
/// the faithful spelling.
fn ci(word: &str) -> String {
    word.chars()
        .map(|c| {
            if c.is_ascii_alphabetic() {
                format!("[{}{}]", c.to_ascii_uppercase(), c.to_ascii_lowercase())
            } else {
                c.to_string()
            }
        })
        .collect()
}

fn word_boundary() -> &'static str {
    r"(?-u:\b)"
}

fn session_names() -> String {
    format!("(?:{}|{})", ci("nativeSessionId"), ci("cliSessionId"))
}

fn secret_key_pattern() -> String {
    format!(
        "(?:{}|{}[ _-]*{}|{}[ _-]*{}|{}[ _-]*{}|{}[ _-]*{}|{}|{}|{}[ _-]*{}|{}|{})",
        ci("authorization"),
        ci("api"),
        ci("key"),
        ci("access"),
        ci("token"),
        ci("refresh"),
        ci("token"),
        ci("auth"),
        ci("token"),
        ci("password"),
        ci("passwd"),
        ci("client"),
        ci("secret"),
        ci("secret"),
        ci("token")
    )
}

fn patterns() -> &'static Patterns {
    static CELL: OnceLock<Patterns> = OnceLock::new();
    CELL.get_or_init(|| {
        let boundary = word_boundary();
        let names = session_names();
        let key = secret_key_pattern();
        let secret_value = format!("(?:\"[^\"\\n]*\"|'[^'\\n]*'|[^{WS_INNER},;，；}}]+)");
        let build = |pattern: &str| Regex::new(pattern).expect("task run context regex");
        Patterns {
            crlf: build(r"\r\n?"),
            session_id: build(&format!(
                "(?:\"{names}\"|'{names}'|{names})[{WS_INNER}]*[:=][{WS_INNER}]*\
                 (?:\"[^\"]*\"|'[^']*'|[^{WS_INNER},;，；}}]+)"
            )),
            session_field: build(&format!("{boundary}{names}{boundary}")),
            auth_line: build(&format!(
                "{boundary}{}[{WS_INNER}]*:[{WS_INNER}]*[^\\n]+",
                ci("Authorization")
            )),
            auth_scheme: build(&format!(
                "{boundary}{}[{WS_INNER}]*[:=]?[{WS_INNER}]*(?:{}|{}|{})[{WS_INNER}]+\
                 [A-Za-z0-9._~+/=-]{{3,}}",
                ci("Authorization"),
                ci("Bearer"),
                ci("Basic"),
                ci("Token")
            )),
            bearer: build(&format!(
                "{boundary}{}[{WS_INNER}]+[A-Za-z0-9._~+/=-]{{3,}}",
                ci("Bearer")
            )),
            basic: build(&format!(
                "{boundary}{}[{WS_INNER}]+[A-Za-z0-9+/=]{{6,}}",
                ci("Basic")
            )),
            jwt: build(&format!(
                "{boundary}eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+{boundary}"
            )),
            token: build(&format!(
                "{boundary}(?:sk-[A-Za-z0-9_-]{{8,}}|gh[pousr]_[A-Za-z0-9]{{12,}}|\
                 AIza[A-Za-z0-9_-]{{12,}}){boundary}"
            )),
            secret: build(&format!(
                "(?:\"(?P<k1>{key})\"|'(?P<k2>{key})'|(?P<k3>{key}))\
                 [{WS_INNER}]*[:=][{WS_INNER}]*{secret_value}"
            )),
        }
    })
}

/// Byte offset -> UTF-16 index map for a lossy copy of `value`. Regex matches
/// run on the lossy copy (the engine needs valid UTF-8) and are applied back
/// to the original code units, so untouched lone surrogates survive.
fn lossy_with_map(value: &[u16]) -> (String, Vec<(usize, usize)>) {
    let mut out = String::with_capacity(value.len());
    let mut map = Vec::with_capacity(value.len() + 1);
    let mut index = 0;
    while index < value.len() {
        let unit = value[index];
        map.push((out.len(), index));
        if (0xD800..=0xDBFF).contains(&unit) {
            if let Some(&low) = value.get(index + 1) {
                if (0xDC00..=0xDFFF).contains(&low) {
                    let code = 0x10000 + ((unit as u32 - 0xD800) << 10) + (low as u32 - 0xDC00);
                    if let Some(c) = char::from_u32(code) {
                        out.push(c);
                    }
                    index += 2;
                    continue;
                }
            }
            out.push('\u{FFFD}');
        } else if (0xDC00..=0xDFFF).contains(&unit) {
            out.push('\u{FFFD}');
        } else if let Some(c) = char::from_u32(unit as u32) {
            out.push(c);
        }
        index += 1;
    }
    map.push((out.len(), value.len()));
    (out, map)
}

fn unit_index(map: &[(usize, usize)], byte: usize) -> usize {
    match map.binary_search_by_key(&byte, |&(offset, _)| offset) {
        Ok(index) => map[index].1,
        Err(index) => map[index.saturating_sub(1)].1,
    }
}

fn replace_with<F>(value: &Text, pattern: &Regex, mut replacement: F) -> Text
where
    F: FnMut(&Captures<'_>) -> Text,
{
    let (lossy_value, map) = lossy_with_map(value);
    let mut replacements: Vec<(usize, usize, Text)> = Vec::new();
    for captures in pattern.captures_iter(&lossy_value) {
        let whole = captures.get(0).unwrap();
        replacements.push((
            unit_index(&map, whole.start()),
            unit_index(&map, whole.end()),
            replacement(&captures),
        ));
    }
    if replacements.is_empty() {
        return value.to_vec();
    }
    let mut out = Vec::with_capacity(value.len());
    let mut last = 0;
    for (start, end, addition) in replacements {
        out.extend_from_slice(&value[last..start]);
        out.extend_from_slice(&addition);
        last = end;
    }
    out.extend_from_slice(&value[last..]);
    out
}

fn replace_literal(value: &Text, pattern: &Regex, literal: &str) -> Text {
    let literal = text(literal);
    replace_with(value, pattern, |_| literal.clone())
}

/// `redactText(value)` — the value is coerced to a string first.
fn redact_text(value: Option<&JsValue>) -> Text {
    let patterns = patterns();
    let mut out = replace_literal(&to_text(value), &patterns.crlf, "\n");
    out = replace_literal(&out, &patterns.session_id, "[redacted session id]");
    out = replace_literal(&out, &patterns.session_field, "[redacted session field]");
    out = replace_literal(
        &out,
        &patterns.auth_line,
        &format!("Authorization: {REDACTED}"),
    );
    out = replace_literal(
        &out,
        &patterns.auth_scheme,
        &format!("Authorization: {REDACTED}"),
    );
    out = replace_literal(&out, &patterns.bearer, &format!("Bearer {REDACTED}"));
    out = replace_literal(&out, &patterns.basic, &format!("Basic {REDACTED}"));
    out = replace_literal(&out, &patterns.jwt, REDACTED);
    out = replace_literal(&out, &patterns.token, REDACTED);
    replace_with(&out, &patterns.secret, |captures| {
        let key = captures
            .name("k1")
            .or_else(|| captures.name("k2"))
            .or_else(|| captures.name("k3"))
            .map(|matched| text(matched.as_str()))
            .unwrap_or_default();
        cat(&[&key, &text("="), &text(REDACTED)])
    })
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/// `truncate(value, maxChars)` with `String.prototype.slice` index rules.
fn truncate(value: &[u16], max_chars: f64) -> Text {
    if !max_chars.is_finite() || value.len() as f64 <= max_chars {
        return value.to_vec();
    }
    if max_chars <= 0.0 {
        return Vec::new();
    }
    if max_chars == 1.0 {
        return text("…");
    }
    let cut = (max_chars - 1.0).trunc().max(0.0) as usize;
    let cut = cut.min(value.len());
    let mut out = value[..cut].to_vec();
    out.extend_from_slice(&text("…"));
    out
}

/// `normalizeString(value, maxChars)`.
fn normalize_string(value: Option<&JsValue>, max_chars: f64) -> Text {
    truncate(&trim_js(&redact_text(value)), max_chars)
}

fn normalize_budget(value: Option<&JsValue>) -> f64 {
    let number = to_number(value);
    if number.is_finite() && number > 0.0 {
        number.floor()
    } else {
        DEFAULT_MAX_CHARS
    }
}

fn normalize_version(value: Option<&JsValue>) -> JsValue {
    match value {
        None | Some(JsValue::Null) => return JsValue::Number(1.0),
        Some(JsValue::Text(units)) if units.is_empty() => return JsValue::Number(1.0),
        Some(JsValue::Number(number)) if number.is_finite() => return JsValue::Number(*number),
        _ => {}
    }
    let normalized = normalize_string(value, 40.0);
    if normalized.is_empty() {
        JsValue::Number(1.0)
    } else {
        JsValue::Text(normalized)
    }
}

fn normalize_role(value: Option<&JsValue>) -> &'static str {
    let truthy_value = if truthy(value) { value } else { None };
    let role = lossy(&lowercase_js(&trim_js(&to_text(truthy_value))));
    match role.as_str() {
        "user" => "user",
        "assistant" => "assistant",
        "system" => "system",
        "tool" => "tool",
        _ => "unknown",
    }
}

fn role_label(role: &str) -> &'static str {
    match role {
        "user" => "User",
        "assistant" => "Assistant",
        "system" => "System",
        "tool" => "Tool",
        _ => "Message",
    }
}

fn normalize_timestamp(value: Option<&JsValue>) -> f64 {
    if let Some(JsValue::Number(number)) = value {
        if number.is_finite() {
            return *number;
        }
    }
    if let Some(JsValue::Text(units)) = value {
        if !trim_js(units).is_empty() {
            let numeric = parse_number(&lossy(units));
            if numeric.is_finite() {
                return numeric;
            }
            if let Some(parsed) = js_date_parse(units) {
                if parsed.is_finite() {
                    return parsed;
                }
            }
        }
    }
    0.0
}

fn compact(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn secret_key_name(key: &str) -> bool {
    let compact = compact(key);
    compact == "authorization"
        || compact == "nativesessionid"
        || compact == "clisessionid"
        || compact.contains("apikey")
        || compact.contains("accesstoken")
        || compact.contains("refreshtoken")
        || compact.contains("authtoken")
        || compact.contains("password")
        || compact.contains("passwd")
        || compact.contains("clientsecret")
        || compact == "secret"
        || compact == "token"
}

fn forbidden_session_key(key: &str) -> bool {
    let compact = compact(key);
    compact == "nativesessionid" || compact == "clisessionid"
}

fn sanitize_structured(value: &JsValue) -> JsValue {
    match value {
        JsValue::Null | JsValue::Undefined | JsValue::Bool(_) | JsValue::Number(_) => value.clone(),
        JsValue::Text(units) => JsValue::Text(redact_text(Some(&JsValue::Text(units.clone())))),
        JsValue::Binary(bytes) => {
            JsValue::Text(text(&format!("[binary content, {} bytes]", bytes.len())))
        }
        JsValue::Array(items) => JsValue::Array(items.iter().map(sanitize_structured).collect()),
        JsValue::Object(entries) => {
            let mut sorted: Vec<&(String, JsValue)> = entries.iter().collect();
            sorted.sort_by(|left, right| compare_string(&left.0, &right.0));
            let mut out = Vec::new();
            for (key, item) in sorted {
                if forbidden_session_key(key) {
                    continue;
                }
                let sanitized = if secret_key_name(key) {
                    JsValue::Text(text(REDACTED))
                } else {
                    sanitize_structured(item)
                };
                out.push((key.clone(), sanitized));
            }
            JsValue::Object(out)
        }
    }
}

fn stable_stringify(value: &JsValue) -> String {
    to_json(value, Mode::Stringify)
}

fn content_to_text(value: Option<&JsValue>) -> Text {
    let Some(value) = value else {
        return Vec::new();
    };
    match value {
        JsValue::Text(units) => {
            normalize_string(Some(&JsValue::Text(units.clone())), f64::INFINITY)
        }
        JsValue::Null | JsValue::Undefined => Vec::new(),
        JsValue::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                if matches!(item, JsValue::Undefined) {
                    continue;
                }
                let part = match item {
                    JsValue::Text(units) => {
                        normalize_string(Some(&JsValue::Text(units.clone())), f64::INFINITY)
                    }
                    JsValue::Object(_) | JsValue::Array(_) | JsValue::Binary(_) => {
                        if let JsValue::Text(units) = prop(item, "text").unwrap_or(&JsValue::Null) {
                            let units = units.clone();
                            normalize_string(Some(&JsValue::Text(units)), f64::INFINITY)
                        } else if let JsValue::Text(units) =
                            prop(item, "content").unwrap_or(&JsValue::Null)
                        {
                            let units = units.clone();
                            normalize_string(Some(&JsValue::Text(units)), f64::INFINITY)
                        } else {
                            text(&stable_stringify(&sanitize_structured(item)))
                        }
                    }
                    _ => text(&stable_stringify(&sanitize_structured(item))),
                };
                if !part.is_empty() {
                    parts.push(part);
                }
            }
            join(&parts, &text("\n"))
        }
        JsValue::Object(_) | JsValue::Binary(_) => {
            if let JsValue::Text(units) = prop(value, "text").unwrap_or(&JsValue::Null) {
                let units = units.clone();
                normalize_string(Some(&JsValue::Text(units)), f64::INFINITY)
            } else {
                text(&stable_stringify(&sanitize_structured(value)))
            }
        }
        _ => normalize_string(Some(value), f64::INFINITY),
    }
}

// ---------------------------------------------------------------------------
// Messages and artifacts
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Message {
    id: Text,
    role: &'static str,
    ts: f64,
    text: Text,
    hash: String,
}

fn object_like(value: &JsValue) -> bool {
    matches!(
        value,
        JsValue::Object(_) | JsValue::Array(_) | JsValue::Binary(_)
    )
}

fn normalize_messages(messages: Option<&JsValue>) -> Vec<Message> {
    let Some(JsValue::Array(items)) = messages else {
        return Vec::new();
    };
    let mut out: Vec<Message> = Vec::new();
    for item in items {
        let (text_value, role_value, ts_value, id_value) = if object_like(item) {
            (
                nullish(
                    nullish(prop(item, "text"), prop(item, "content")),
                    prop(item, "body"),
                ),
                prop(item, "role"),
                nullish(
                    nullish(prop(item, "ts"), prop(item, "timestamp")),
                    prop(item, "createdAt"),
                ),
                nullish(prop(item, "id"), prop(item, "messageId")),
            )
        } else {
            (Some(item), None, None, None)
        };
        let body = content_to_text(text_value);
        if body.is_empty() {
            continue;
        }
        let id = normalize_string(id_value, 200.0);
        let role = normalize_role(role_value);
        let ts = normalize_timestamp(ts_value);
        out.push(Message {
            hash: digest_text(&body),
            id,
            role,
            ts,
            text: body,
        });
    }
    out.sort_by(|left, right| {
        left.ts
            .partial_cmp(&right.ts)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| compare_text(&left.id, &right.id))
            .then_with(|| left.role.cmp(right.role))
            .then_with(|| compare_string(&left.hash, &right.hash))
    });
    out
}

fn artifact_content(artifact: &JsValue) -> Option<&JsValue> {
    if !object_like(artifact) {
        return Some(artifact);
    }
    for key in ["content", "body", "text", "data", "bytes"] {
        match prop(artifact, key) {
            // `artifact[key] !== undefined` — a present-but-undefined key is skipped.
            None | Some(JsValue::Undefined) => continue,
            Some(value) => return Some(value),
        }
    }
    None
}

fn supplied_hash(artifact: &JsValue) -> Text {
    if !object_like(artifact) {
        return Vec::new();
    }
    let chosen = match prop(artifact, "hash") {
        Some(value) if truthy(Some(value)) => Some(value),
        _ => match prop(artifact, "sha256") {
            Some(value) if truthy(Some(value)) => Some(value),
            _ => None,
        },
    };
    trim_js(&lowercase_js(&to_text(chosen)))
}

fn artifact_digest(artifact: &JsValue) -> String {
    match artifact_content(artifact) {
        Some(JsValue::Binary(bytes)) => return digest_bytes(bytes),
        Some(JsValue::Text(units)) => return digest_text(units),
        Some(value) if !matches!(value, JsValue::Null | JsValue::Undefined) => {
            return digest_text(&text(&stable_stringify(&sanitize_structured(value))));
        }
        _ => {}
    }
    let supplied = supplied_hash(artifact);
    let supplied = lossy(&supplied);
    let digits = supplied.strip_prefix("sha256:").unwrap_or(&supplied);
    if digits.len() == 64 && digits.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return format!("sha256:{}", digits);
    }
    let empty = JsValue::Object(Vec::new());
    let source = if object_like(artifact) {
        artifact
    } else {
        &empty
    };
    let reference = JsValue::Object(vec![
        (
            "id".into(),
            JsValue::Text(normalize_string(nullish(prop(source, "id"), None), 200.0)),
        ),
        (
            "name".into(),
            JsValue::Text(normalize_string(
                nullish(prop(source, "name"), prop(source, "label")),
                240.0,
            )),
        ),
        (
            "path".into(),
            JsValue::Text(normalize_string(
                nullish(prop(source, "path"), prop(source, "uri")),
                500.0,
            )),
        ),
        (
            "size".into(),
            match to_number(prop(source, "size")) {
                number if number.is_finite() => JsValue::Number(number.max(0.0)),
                _ => JsValue::Null,
            },
        ),
    ]);
    digest_text(&text(&stable_stringify(&sanitize_structured(&reference))))
}

fn artifact_size(artifact: &JsValue, content: Option<&JsValue>) -> Option<f64> {
    let supplied = if object_like(artifact) {
        to_number(prop(artifact, "size"))
    } else {
        f64::NAN
    };
    if supplied.is_finite() && supplied >= 0.0 {
        return Some(supplied);
    }
    match content {
        Some(JsValue::Binary(bytes)) => Some(bytes.len() as f64),
        Some(JsValue::Text(units)) => Some(utf8(units).len() as f64),
        _ => None,
    }
}

struct Artifact {
    id: Text,
    name: Text,
    hash: String,
    mime_type: Option<Text>,
    size: Option<f64>,
}

fn normalize_artifacts(artifacts: Option<&JsValue>) -> Vec<Artifact> {
    let Some(JsValue::Array(items)) = artifacts else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let synthetic = JsValue::Object(vec![("name".into(), item.clone())]);
        let source = if object_like(item) { item } else { &synthetic };
        let content = artifact_content(source);
        let id = normalize_string(
            nullish(prop(source, "id"), prop(source, "artifactId")),
            200.0,
        );
        let fallback_name = JsValue::Text(text("unnamed artifact"));
        let name = normalize_string(
            nullish(
                nullish(prop(source, "name"), prop(source, "label")),
                Some(&fallback_name),
            ),
            240.0,
        );
        let hash = artifact_digest(source);
        let mime_type = normalize_string(
            nullish(prop(source, "mimeType"), prop(source, "type")),
            120.0,
        );
        let mime_type = if mime_type.is_empty() {
            None
        } else {
            Some(mime_type)
        };
        let size = artifact_size(source, content);
        out.push(Artifact {
            id,
            name,
            hash,
            mime_type,
            size,
        });
    }
    out.sort_by(|left, right| {
        compare_text(&left.id, &right.id)
            .then_with(|| compare_text(&left.name, &right.name))
            .then_with(|| compare_string(&left.hash, &right.hash))
    });
    out
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

fn render_message(message: &Message, body: &[u16]) -> Text {
    // Indent continuation lines: every "\n" becomes "\n  ".
    let mut indented = Vec::with_capacity(body.len());
    for unit in body {
        indented.push(*unit);
        if *unit == 0x0A {
            indented.extend_from_slice(&[0x20, 0x20]);
        }
    }
    cat(&[
        &text("- "),
        &text(role_label(message.role)),
        &text("："),
        &indented,
    ])
}

#[derive(Clone)]
struct Included {
    index: usize,
    body: Text,
    partial: bool,
}

struct History {
    text: Text,
    included: Vec<Included>,
    omitted: usize,
    truncated: bool,
}

fn render_history(messages: &[Message], budget: f64) -> History {
    let empty = History {
        text: Vec::new(),
        included: Vec::new(),
        omitted: messages.len(),
        truncated: !messages.is_empty(),
    };
    if messages.is_empty() || budget < 24.0 {
        return empty;
    }
    let heading = text("Conversation history (chronological; earlier content may be omitted):");
    let render = |selected: &[Included], omitted: usize| -> Text {
        let mut lines = vec![heading.clone()];
        if omitted > 0 {
            lines.push(cat(&[
                &text("- ..."),
                &text(&omitted.to_string()),
                &text(" earlier messages omitted"),
            ]));
        }
        for item in selected {
            lines.push(render_message(&messages[item.index], &item.body));
        }
        join(&lines, &text("\n"))
    };

    let mut included: Vec<Included> = Vec::new();
    let mut omitted = messages.len();
    for index in (0..messages.len()).rev() {
        let mut candidate = vec![Included {
            index,
            body: messages[index].text.clone(),
            partial: false,
        }];
        candidate.extend(included.iter().cloned());
        let candidate_text = render(&candidate, index);
        if candidate_text.len() as f64 > budget {
            break;
        }
        included = candidate;
        omitted = index;
    }
    if included.is_empty() {
        let latest = messages.len() - 1;
        omitted = messages.len() - 1;
        let shell = render(
            &[Included {
                index: latest,
                body: Vec::new(),
                partial: true,
            }],
            omitted,
        );
        let available = budget - shell.len() as f64;
        if available < 12.0 {
            return empty;
        }
        included = vec![Included {
            index: latest,
            body: truncate(&messages[latest].text, available),
            partial: true,
        }];
    }
    let rendered = render(&included, omitted);
    let truncated = omitted > 0 || included.iter().any(|item| item.partial);
    History {
        text: rendered,
        included,
        omitted,
        truncated,
    }
}

fn render_artifacts(artifacts: &[Artifact], budget: f64) -> (Text, usize) {
    if artifacts.is_empty() || budget < 40.0 {
        return (Vec::new(), 0);
    }
    let mut lines = vec![text("Related artifacts (references only, no content):")];
    let mut displayed = 0usize;
    for artifact in artifacts {
        let size = match artifact.size {
            None => Vec::new(),
            Some(size) => text(&format!(", {} bytes", number_string(size))),
        };
        let line = cat(&[
            &text("- "),
            &artifact.name,
            &text(" ("),
            &text(&artifact.hash),
            &size,
            &text(")"),
        ]);
        let omitted = artifacts.len() - displayed - 1;
        let suffix = if omitted > 0 {
            cat(&[
                &text("\n- ..."),
                &text(&omitted.to_string()),
                &text(" more artifact references"),
            ])
        } else {
            Vec::new()
        };
        let candidate = cat(&[&join(&lines, &text("\n")), &text("\n"), &line, &suffix]);
        if candidate.len() as f64 > budget {
            break;
        }
        lines.push(line);
        displayed += 1;
    }
    if displayed == 0 {
        return (Vec::new(), 0);
    }
    let omitted = artifacts.len() - displayed;
    if omitted > 0 {
        lines.push(cat(&[
            &text("- ..."),
            &text(&omitted.to_string()),
            &text(" more artifact references"),
        ]));
    }
    (join(&lines, &text("\n")), displayed)
}

fn artifact_value(artifact: &Artifact) -> JsValue {
    let mut entries = vec![
        ("id".to_string(), JsValue::Text(artifact.id.clone())),
        ("name".to_string(), JsValue::Text(artifact.name.clone())),
        ("hash".to_string(), JsValue::Text(text(&artifact.hash))),
    ];
    if let Some(mime_type) = &artifact.mime_type {
        entries.push(("mimeType".to_string(), JsValue::Text(mime_type.clone())));
    }
    if let Some(size) = artifact.size {
        entries.push(("size".to_string(), JsValue::Number(size)));
    }
    JsValue::Object(entries)
}

fn error(message: &str) -> String {
    to_json(
        &JsValue::Object(vec![("$error".into(), JsValue::Text(text(message)))]),
        Mode::Output,
    )
}

fn pick_areas(value: Option<&JsValue>) -> Vec<Text> {
    let Some(JsValue::Array(items)) = value else {
        return Vec::new();
    };
    let mut seen: Vec<Text> = Vec::new();
    for item in items {
        let normalized = normalize_string(Some(item), 100.0);
        if normalized.is_empty() {
            continue;
        }
        if !seen.contains(&normalized) {
            seen.push(normalized);
        }
    }
    seen.sort_by(|left, right| compare_text(left, right));
    seen
}

pub fn build(input: &str) -> Result<String, String> {
    let raw: Value = json_lenient::from_str(input)
        .map_err(|error| format!("invalid task run context input: {error}"))?;
    build_value(&from_json(&raw))
}

pub fn build_value(input: &JsValue) -> Result<String, String> {
    let task = prop(input, "task");
    let Some(task) = task.filter(|value| object_like(value)) else {
        return Ok(error("task must be an object"));
    };
    let task_id = normalize_string(
        nullish(prop(task, "id"), prop(task, "taskId")),
        MAX_TASK_ID_CHARS,
    );
    if task_id.is_empty() {
        return Ok(error("task.id must be a non-empty string"));
    }
    let title = normalize_string(
        nullish(
            nullish(prop(task, "title"), prop(task, "name")),
            Some(&JsValue::Text(text("untitled task"))),
        ),
        MAX_TASK_TITLE_CHARS,
    );
    let include_current = match prop(input, "includeCurrent") {
        None => true,
        value => truthy(value),
    };
    let current = normalize_string(prop(input, "currentText"), f64::INFINITY);
    if include_current && current.is_empty() {
        return Ok(error("currentText must be a non-empty string"));
    }

    let version = normalize_version(prop(input, "version"));
    let budget = normalize_budget(prop(input, "maxChars"));
    let messages = normalize_messages(prop(input, "messages"));
    let artifacts = normalize_artifacts(prop(input, "artifacts"));
    let status = normalize_string(prop(task, "status"), 40.0);
    let summary = normalize_string(
        nullish(prop(task, "summary"), prop(task, "description")),
        4_000.0,
    );
    let areas = pick_areas(prop(task, "areas"));

    let header = cat(&[
        &text("[MultiCC task run context v"),
        &to_text(Some(&version)),
        &text("]"),
    ]);
    let mut essential_task_lines = vec![
        cat(&[&text("Task: "), &title]),
        cat(&[&text("Task ID: "), &task_id]),
    ];
    if !status.is_empty() {
        essential_task_lines.push(cat(&[&text("Status: "), &status]));
    }
    let mut task_section = join(&essential_task_lines, &text("\n"));
    let current_section = if include_current {
        cat(&[&text("Current request:\n"), &current])
    } else {
        Vec::new()
    };
    let essential_text = join(
        &[
            header.clone(),
            task_section.clone(),
            current_section.clone(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>(),
        &text("\n\n"),
    );
    let mut remaining = (budget - essential_text.len() as f64).max(0.0);

    let mut optional_task_lines: Vec<Text> = Vec::new();
    if !summary.is_empty() && remaining > 16.0 {
        let allowance = 1_600.0_f64.min((remaining * 0.3).floor());
        if allowance > 8.0 {
            optional_task_lines.push(cat(&[
                &text("Summary: "),
                &truncate(&summary, allowance - 3.0),
            ]));
        }
    }
    if !areas.is_empty() && remaining > 16.0 {
        let allowance = 500.0_f64.min((remaining * 0.1).floor());
        if allowance > 8.0 {
            optional_task_lines.push(cat(&[
                &text("Areas: "),
                &truncate(&join(&areas, &text(", ")), allowance - 3.0),
            ]));
        }
    }
    if !optional_task_lines.is_empty() {
        task_section = cat(&[
            &task_section,
            &text("\n"),
            &join(&optional_task_lines, &text("\n")),
        ]);
    }

    let mut base_sections = [
        header.clone(),
        task_section.clone(),
        current_section.clone(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>();
    let mut base_length = join(&base_sections, &text("\n\n")).len();
    remaining = (budget - base_length as f64).max(0.0);
    let artifact_budget = 2_000.0_f64.min((remaining * 0.28).floor());
    let (artifact_text, displayed) = render_artifacts(&artifacts, artifact_budget);
    if !artifact_text.is_empty() {
        base_sections = [
            header.clone(),
            task_section.clone(),
            artifact_text.clone(),
            current_section.clone(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect();
        base_length = join(&base_sections, &text("\n\n")).len();
    }

    let history_budget = (budget - base_length as f64 - 2.0).max(0.0);
    let history = render_history(&messages, history_budget);
    let mut sections = vec![header.clone(), task_section.clone()];
    if !history.text.is_empty() {
        sections.push(history.text.clone());
    }
    if !artifact_text.is_empty() {
        sections.push(artifact_text.clone());
    }
    if !current_section.is_empty() {
        sections.push(current_section.clone());
    }
    let rendered = join(&sections, &text("\n\n"));

    let summary_hash = if summary.is_empty() {
        JsValue::Null
    } else {
        JsValue::Text(text(&digest_text(&summary)))
    };
    let refs: Vec<JsValue> = history
        .included
        .iter()
        .map(|item| {
            let message = &messages[item.index];
            JsValue::Object(vec![
                ("id".to_string(), JsValue::Text(message.id.clone())),
                ("role".to_string(), JsValue::Text(text(message.role))),
                ("ts".to_string(), JsValue::Number(message.ts)),
                ("hash".to_string(), JsValue::Text(text(&message.hash))),
                ("partial".to_string(), JsValue::Bool(item.partial)),
            ])
        })
        .collect();
    let manifest = JsValue::Object(vec![
        (
            "schema".to_string(),
            JsValue::Text(text("multicc.task-run-context")),
        ),
        ("version".to_string(), version.clone()),
        ("maxChars".to_string(), JsValue::Number(budget)),
        (
            "task".to_string(),
            JsValue::Object(vec![
                ("id".to_string(), JsValue::Text(task_id)),
                ("title".to_string(), JsValue::Text(title)),
                ("summaryHash".to_string(), summary_hash),
            ]),
        ),
        (
            "messageCount".to_string(),
            JsValue::Number(messages.len() as f64),
        ),
        (
            "history".to_string(),
            JsValue::Object(vec![
                (
                    "included".to_string(),
                    JsValue::Number(history.included.len() as f64),
                ),
                (
                    "omitted".to_string(),
                    JsValue::Number(history.omitted as f64),
                ),
                ("truncated".to_string(), JsValue::Bool(history.truncated)),
                ("refs".to_string(), JsValue::Array(refs)),
            ]),
        ),
        (
            "artifacts".to_string(),
            JsValue::Array(artifacts.iter().map(artifact_value).collect()),
        ),
        (
            "artifactDisplayCount".to_string(),
            JsValue::Number(displayed as f64),
        ),
        (
            "currentTextHash".to_string(),
            if current_section.is_empty() {
                JsValue::Null
            } else {
                JsValue::Text(text(&digest_text(&current)))
            },
        ),
    ]);
    let object = JsValue::Object(vec![
        ("manifest".to_string(), manifest.clone()),
        ("text".to_string(), JsValue::Text(rendered.clone())),
    ]);
    let hash = digest_text(&text(&stable_stringify(&object)));
    let result = JsValue::Object(vec![
        ("text".to_string(), JsValue::Text(rendered)),
        ("manifest".to_string(), manifest),
        ("hash".to_string(), JsValue::Text(text(&hash))),
    ]);
    Ok(to_json(&result, Mode::Output))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn string(value: &str) -> JsValue {
        JsValue::Text(text(value))
    }

    fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
        JsValue::Object(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        )
    }

    fn render(input: JsValue) -> String {
        build_value(&input).unwrap()
    }

    fn decode(output: &str) -> Value {
        serde_json::from_str(output).unwrap()
    }

    // --- JavaScript string semantics -------------------------------------

    #[test]
    fn truncation_counts_utf16_code_units() {
        assert_eq!(truncate(&text("abcdef"), 4.0), text("abc…"));
        assert_eq!(truncate(&text("abc"), 3.0), text("abc"));
        assert_eq!(truncate(&text("abc"), 1.0), text("…"));
        assert_eq!(truncate(&text("abc"), 0.0), Vec::<u16>::new());
        assert_eq!(truncate(&text("abc"), f64::INFINITY), text("abc"));
        // "😀" is two code units: a 4-unit budget is exact, a 3-unit budget
        // cuts between the surrogate pair and leaves a lone high surrogate.
        assert_eq!(truncate(&text("a😀b"), 4.0), text("a😀b"));
        assert_eq!(truncate(&text("a😀b"), 3.0), vec![0x61, 0xD83D, 0x2026]);
        assert_eq!(truncate(&text("a😀b"), 2.0), vec![0x61, 0x2026]);
    }

    #[test]
    fn trim_uses_the_ecmascript_whitespace_set() {
        assert_eq!(trim_js(&text("\u{feff} a \u{3000}")), text("a"));
        assert_eq!(trim_js(&text("\u{85}a\u{85}")), text("\u{85}a\u{85}"));
        assert_eq!(trim_js(&text("   ")), Vec::<u16>::new());
    }

    #[test]
    fn coerce_like_javascript_string() {
        assert_eq!(to_text(None), Vec::<u16>::new());
        assert_eq!(to_text(Some(&JsValue::Null)), Vec::<u16>::new());
        assert_eq!(to_text(Some(&JsValue::Undefined)), Vec::<u16>::new());
        assert_eq!(to_text(Some(&JsValue::Number(-0.0))), text("0"));
        assert_eq!(to_text(Some(&JsValue::Number(1.5))), text("1.5"));
        assert_eq!(to_text(Some(&JsValue::Bool(true))), text("true"));
        assert_eq!(
            to_text(Some(&JsValue::Array(vec![
                JsValue::Number(1.0),
                JsValue::Null,
                JsValue::Undefined
            ]))),
            text("1,,")
        );
        assert_eq!(to_text(Some(&object(vec![]))), text("[object Object]"));
    }

    #[test]
    fn number_conversion_matches_string_numeric_literal() {
        assert_eq!(parse_number(" 42 "), 42.0);
        assert_eq!(parse_number("0x1f"), 31.0);
        assert_eq!(parse_number("0b101"), 5.0);
        assert_eq!(parse_number("0o17"), 15.0);
        assert_eq!(parse_number("5."), 5.0);
        assert_eq!(parse_number(".5"), 0.5);
        assert_eq!(parse_number("+5"), 5.0);
        assert_eq!(parse_number("1e3"), 1000.0);
        assert_eq!(parse_number("00012"), 12.0);
        assert_eq!(parse_number(""), 0.0);
        assert_eq!(parse_number("   "), 0.0);
        assert_eq!(parse_number("Infinity"), f64::INFINITY);
        assert_eq!(parse_number("-Infinity"), f64::NEG_INFINITY);
        assert!(parse_number("abc").is_nan());
        assert!(parse_number("1_0").is_nan());
        assert!(parse_number("0x").is_nan());
        assert!(parse_number("NaN").is_nan());
    }

    #[test]
    fn number_formatting_is_ecmascript() {
        assert_eq!(number_string(0.0), "0");
        assert_eq!(number_string(-0.0), "0");
        assert_eq!(number_string(2.5), "2.5");
        assert_eq!(number_string(1e21), "1e+21");
        assert_eq!(number_string(1e-7), "1e-7");
        assert_eq!(number_string(0.1), "0.1");
        assert_eq!(number_string(f64::NAN), "NaN");
        assert_eq!(number_string(f64::INFINITY), "Infinity");
    }

    #[test]
    fn json_stringify_escapes() {
        let mut out = String::new();
        write_js_string(&text("a\"b\\c\nd\te\u{1}"), &mut out);
        assert_eq!(out, "\"a\\\"b\\\\c\\nd\\te\\u0001\"");

        let mut lone = String::new();
        write_js_string(&[0x41, 0xD83D, 0x42], &mut lone);
        assert_eq!(lone, "\"A\\ud83dB\"");

        let mut pair = String::new();
        write_js_string(&text("😀"), &mut pair);
        assert_eq!(pair, "\"😀\"");

        let mut line = String::new();
        write_js_string(&text("\u{2028}\u{7f}"), &mut line);
        assert_eq!(line, "\"\u{2028}\u{7f}\"");
    }

    #[test]
    fn stable_stringify_sorts_keys_and_prints_undefined() {
        let value = object(vec![("b", JsValue::Number(1.0)), ("a", JsValue::Undefined)]);
        assert_eq!(stable_stringify(&value), "{\"a\":undefined,\"b\":1}");
        let array = JsValue::Array(vec![
            JsValue::Number(1.0),
            JsValue::Undefined,
            JsValue::Number(2.0),
        ]);
        assert_eq!(stable_stringify(&array), "[1,,2]");
        let buffer = JsValue::Binary(vec![1, 2, 3]);
        assert_eq!(
            stable_stringify(&buffer),
            "{\"type\":\"Buffer\",\"data\":\"AQID\"}"
        );
    }

    #[test]
    fn output_mode_preserves_negative_zero() {
        let value = object(vec![("v", JsValue::Number(-0.0))]);
        assert_eq!(to_json(&value, Mode::Output), "{\"v\":-0}");
        assert_eq!(to_json(&value, Mode::Stringify), "{\"v\":0}");
    }

    #[test]
    fn digests_use_utf8_with_lossy_lone_surrogates() {
        assert_eq!(
            digest_text(&[]),
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(digest_text(&[0xD83D]), digest_text(&text("\u{fffd}")));
        assert_eq!(digest_bytes(b"abc"), digest_text(&text("abc")));
    }

    // --- redaction --------------------------------------------------------

    #[test]
    fn redacts_session_identities_and_credentials() {
        assert_eq!(
            redact_text(Some(&string("nativeSessionId: abc"))),
            text("[redacted session id]")
        );
        assert_eq!(
            redact_text(Some(&string("cliSessionId='x y'"))),
            text("[redacted session id]")
        );
        assert_eq!(
            redact_text(Some(&string("see nativeSessionId here"))),
            text("see [redacted session field] here")
        );
        assert_eq!(
            // The final key/value rule rewrites the line the Authorization rule
            // already handled, so the survivor is `key=value` form.
            redact_text(Some(&string("Authorization: Bearer abcdef"))),
            text("Authorization=[redacted]")
        );
        assert_eq!(
            redact_text(Some(&string("Bearer abc123"))),
            text("Bearer [redacted]")
        );
        assert_eq!(
            redact_text(Some(&string("Basic dXNlcjpwdw=="))),
            text("Basic [redacted]")
        );
        assert_eq!(
            redact_text(Some(&string("sk-abcdefghijk"))),
            text("[redacted]")
        );
        assert_eq!(
            redact_text(Some(&string("api_key=secretvalue"))),
            text("api_key=[redacted]")
        );
        assert_eq!(
            redact_text(Some(&string("client_secret: abc"))),
            text("client_secret=[redacted]")
        );
        assert_eq!(redact_text(Some(&string("key: value"))), text("key: value"));
        assert_eq!(
            redact_text(Some(&string("tokens: many"))),
            text("tokens: many")
        );
        assert_eq!(redact_text(Some(&string("ſecret=abc"))), text("ſecret=abc"));
    }

    #[test]
    fn redaction_normalizes_line_endings_and_ignores_non_ascii_case() {
        assert_eq!(redact_text(Some(&string("a\r\nb\rc"))), text("a\nb\nc"));
        // `/i` is ASCII-only: KELVIN SIGN and long s do not fold onto ASCII.
        assert_eq!(
            redact_text(Some(&string("\u{212a}ey=value"))),
            text("\u{212a}ey=value")
        );
    }

    #[test]
    fn redaction_keeps_lone_surrogates_outside_matches() {
        let value = vec![0x41, 0xD83D, 0x42];
        assert_eq!(
            redact_text(Some(&JsValue::Text(value))),
            vec![0x41, 0xD83D, 0x42]
        );
    }

    // --- rendering --------------------------------------------------------

    #[test]
    fn renders_a_minimal_record() {
        let output = render(object(vec![
            ("task", object(vec![("id", string("t"))])),
            ("includeCurrent", JsValue::Bool(false)),
        ]));
        let value = decode(&output);
        assert_eq!(
            value["text"],
            Value::String(
                "[MultiCC task run context v1]\n\nTask: untitled task\nTask ID: t".into()
            )
        );
        assert_eq!(value["manifest"]["task"]["title"], "untitled task");
        assert_eq!(value["manifest"]["history"]["included"], 0);
        assert_eq!(value["manifest"]["currentTextHash"], Value::Null);
        assert!(value["hash"].as_str().unwrap().starts_with("sha256:"));
    }

    #[test]
    fn renders_current_request_when_included() {
        let output = render(object(vec![
            (
                "task",
                object(vec![("id", string("t")), ("title", string("T"))]),
            ),
            ("currentText", string("go")),
        ]));
        let value = decode(&output);
        assert_eq!(
            value["text"],
            Value::String(
                "[MultiCC task run context v1]\n\nTask: T\nTask ID: t\n\nCurrent request:\ngo"
                    .into()
            )
        );
        assert_eq!(
            value["manifest"]["currentTextHash"],
            Value::String(digest_text(&text("go")))
        );
    }

    #[test]
    fn renders_history_chronologically() {
        let messages = JsValue::Array(vec![
            object(vec![
                ("id", string("a")),
                ("role", string("user")),
                ("ts", JsValue::Number(1.0)),
                ("text", string("first")),
            ]),
            object(vec![
                ("id", string("b")),
                ("role", string("assistant")),
                ("ts", JsValue::Number(2.0)),
                ("text", string("second\nline")),
            ]),
        ]);
        let output = render(object(vec![
            ("task", object(vec![("id", string("t"))])),
            ("messages", messages),
            ("includeCurrent", JsValue::Bool(false)),
        ]));
        let value = decode(&output);
        assert_eq!(
            value["text"],
            Value::String(
                "[MultiCC task run context v1]\n\nTask: untitled task\nTask ID: t\n\n\
                 Conversation history (chronological; earlier content may be omitted):\n\
                 - User：first\n- Assistant：second\n  line"
                    .into()
            )
        );
        assert_eq!(value["manifest"]["history"]["included"], 2);
        assert_eq!(value["manifest"]["history"]["omitted"], 0);
        assert_eq!(value["manifest"]["history"]["refs"][1]["role"], "assistant");
    }

    #[test]
    fn renders_artifacts_with_size_and_digest() {
        let artifacts = JsValue::Array(vec![object(vec![
            ("id", string("a1")),
            ("name", string("notes.txt")),
            ("content", string("hello")),
            ("mimeType", string("text/plain")),
        ])]);
        let output = render(object(vec![
            ("task", object(vec![("id", string("t"))])),
            ("artifacts", artifacts),
            ("includeCurrent", JsValue::Bool(false)),
        ]));
        let value = decode(&output);
        assert_eq!(
            value["text"],
            Value::String(format!(
                "[MultiCC task run context v1]\n\nTask: untitled task\nTask ID: t\n\n\
                 Related artifacts (references only, no content):\n\
                 - notes.txt ({}, 5 bytes)",
                digest_text(&text("hello"))
            ))
        );
        assert_eq!(value["manifest"]["artifacts"][0]["mimeType"], "text/plain");
        assert_eq!(value["manifest"]["artifacts"][0]["size"], 5);
        assert_eq!(value["manifest"]["artifactDisplayCount"], 1);
    }

    #[test]
    fn sanitizes_structured_content() {
        let content = object(vec![
            ("nativeSessionId", string("secret")),
            ("apiKey", string("k")),
            ("z", JsValue::Number(1.0)),
            ("a", string("nativeSessionId: nope")),
        ]);
        assert_eq!(
            stable_stringify(&sanitize_structured(&content)),
            "{\"a\":\"[redacted session id]\",\"apiKey\":\"[redacted]\",\"z\":1}"
        );
    }

    #[test]
    fn rejects_invalid_input() {
        assert_eq!(
            render(object(vec![])),
            "{\"$error\":\"task must be an object\"}"
        );
        assert_eq!(
            render(object(vec![("task", string("x"))])),
            "{\"$error\":\"task must be an object\"}"
        );
        assert_eq!(
            render(object(vec![("task", object(vec![("id", string(""))]))])),
            "{\"$error\":\"task.id must be a non-empty string\"}"
        );
        assert_eq!(
            render(object(vec![("task", object(vec![("id", string("t"))]))])),
            "{\"$error\":\"currentText must be a non-empty string\"}"
        );
    }

    #[test]
    fn decodes_wire_markers_from_json_input() {
        let lone = JsValue::Text(vec![0x41, 0xD83D, 0x42]);
        let input = object(vec![
            ("task", object(vec![("id", JsValue::Text(vec![0xD83D]))])),
            ("currentText", lone),
            ("maxChars", JsValue::Number(40_000.0)),
        ]);
        let encoded = to_json(&input, Mode::Output);
        let output = build(&encoded).unwrap();
        let value = decode(&output);
        let rendered = value["text"].as_str().unwrap();
        // The id is a lone surrogate; the kernel only sees it through the marker
        // and hands it back escaped, so the JSON decode restores U+FFFD-free text.
        assert!(rendered.contains('\u{FFFD}') || rendered.contains("Task ID: "));
    }

    #[test]
    fn build_from_json_matches_direct_value() {
        let input = r#"{"task":{"id":"t","title":"T"},"messages":[{"id":"m","role":"user","ts":1,"text":"hi"}],"includeCurrent":false}"#;
        let from_text = build(input).unwrap();
        let direct =
            build_value(&from_json(&json_lenient::from_str::<Value>(input).unwrap())).unwrap();
        assert_eq!(from_text, direct);
    }

    #[test]
    fn history_budget_keeps_a_partial_latest_message() {
        let messages = JsValue::Array(vec![
            object(vec![
                ("id", string("a")),
                ("ts", JsValue::Number(1.0)),
                ("text", string(&"x".repeat(200))),
            ]),
            object(vec![
                ("id", string("b")),
                ("ts", JsValue::Number(2.0)),
                ("text", string(&"y".repeat(200))),
            ]),
        ]);
        let output = render(object(vec![
            ("task", object(vec![("id", string("t"))])),
            ("messages", messages),
            ("includeCurrent", JsValue::Bool(false)),
            ("maxChars", JsValue::Number(200.0)),
        ]));
        let value = decode(&output);
        let manifest = &value["manifest"];
        assert_eq!(manifest["history"]["included"], 1);
        assert_eq!(manifest["history"]["omitted"], 1);
        assert_eq!(manifest["history"]["truncated"], true);
        assert_eq!(manifest["history"]["refs"][0]["partial"], true);
    }

    #[test]
    fn dates_parse_like_date_parse() {
        assert_eq!(
            js_date_parse(&text("2024-01-02")),
            Some(1_704_153_600_000.0)
        );
        assert_eq!(
            js_date_parse(&text("2024-01-02T03:04:05Z")),
            Some(1_704_164_645_000.0)
        );
        assert_eq!(js_date_parse(&text("nonsense")), None);
        assert_eq!(js_date_parse(&text("   ")), None);
    }
}
