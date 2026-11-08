//! `JSON.stringify` and `JSON.parse` with JavaScript value semantics.
//!
//! The output is byte-identical to what V8 produces for the same value:
//! insertion-order keys, lowercase `\u00xx` for control characters, lone
//! surrogates as lowercase `\udxxx`, no escaping of `/`, U+2028 or U+2029,
//! `NaN`/`±Infinity` as `null`, `undefined` omitted in objects and written as
//! `null` in arrays, `Buffer#toJSON` for bytes and `toISOString` (or `null` for
//! an invalid date) for dates.
//!
//! The parser keeps `\udxxx` escapes as lone surrogate code units (a Rust
//! `String` cannot) and applies `JSON.parse`'s duplicate-key rule: the last
//! value wins but the key keeps its first position.
use crate::js::number::number_to_string;
use crate::js::string::JsString;
use crate::js::value::JsValue;
use std::fmt;

/// Quote one JS string the way `JSON.stringify` does.
pub fn json_quote(value: &JsString) -> String {
    let units = value.as_units();
    let mut out = String::with_capacity(units.len() + 2);
    out.push('"');
    let mut index = 0usize;
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
            unit if unit < 0x20 => push_unicode_escape(&mut out, unit),
            0xD800..=0xDBFF => {
                let low = units.get(index + 1).copied();
                match low {
                    Some(low) if (0xDC00..=0xDFFF).contains(&low) => {
                        let code = 0x10000 + ((unit as u32 - 0xD800) << 10) + (low as u32 - 0xDC00);
                        if let Some(character) = char::from_u32(code) {
                            out.push(character);
                        }
                        index += 1;
                    }
                    _ => push_unicode_escape(&mut out, unit),
                }
            }
            0xDC00..=0xDFFF => push_unicode_escape(&mut out, unit),
            unit => {
                if let Some(character) = char::from_u32(unit as u32) {
                    out.push(character);
                }
            }
        }
        index += 1;
    }
    out.push('"');
    out
}

fn push_unicode_escape(out: &mut String, unit: u16) {
    // Lowercase hex, exactly like JSON.stringify ("\u0000", "\ud83d").
    out.push_str("\\u");
    for shift in [12, 8, 4, 0] {
        out.push(HEX[((unit >> shift) & 0xF) as usize]);
    }
}

const HEX: [char; 16] = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
];

/// Quote a UTF-8 string. Kept for kernels that only have `&str`.
pub fn json_quote_str(value: &str) -> String {
    json_quote(&JsString::from_rust_str(value))
}

/// `JSON.stringify(value)`. `None` means the result is the JS value
/// `undefined` (only possible for a top-level `undefined`); callers that need
/// a string should treat it as unrepresentable.
pub fn json_stringify(value: &JsValue) -> Option<String> {
    let mut out = String::new();
    if write_json(value, &mut out, false) {
        Some(out)
    } else {
        None
    }
}

/// Re-encode an already parsed wire JSON value without changing the numbers
/// JS will parse. Unlike JSON.stringify, -0 and an overflowing exponent must
/// survive a string-only edit. This is not a serializer for arbitrary JS values.
pub fn json_encode_wire(value: &JsValue) -> Option<String> {
    let mut out = String::new();
    write_json(value, &mut out, true).then_some(out)
}

/// Same as [`json_stringify`] but replacing a top-level `undefined` with the
/// literal text `undefined` (useful for diagnostics, never for valid JSON).
pub fn json_stringify_or_undefined(value: &JsValue) -> String {
    json_stringify(value).unwrap_or_else(|| "undefined".to_string())
}

fn write_json(value: &JsValue, out: &mut String, wire: bool) -> bool {
    match value {
        JsValue::Undefined => return false,
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        JsValue::Number(number) => {
            if wire && *number == 0.0 && number.is_sign_negative() {
                out.push_str("-0");
            } else if wire && number.is_infinite() {
                out.push_str(if number.is_sign_negative() {
                    "-1e400"
                } else {
                    "1e400"
                });
            } else if number.is_finite() {
                out.push_str(&number_to_string(*number));
            } else {
                out.push_str("null");
            }
        }
        JsValue::String(text) => out.push_str(&json_quote(text)),
        JsValue::Bytes(bytes) => {
            out.push_str("{\"type\":\"Buffer\",\"data\":[");
            for (index, byte) in bytes.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&byte.to_string());
            }
            out.push_str("]}");
        }
        JsValue::Date(milliseconds) => match date_to_iso_string(*milliseconds) {
            Some(text) => out.push_str(&json_quote_str(&text)),
            None => out.push_str("null"),
        },
        JsValue::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                if !write_json(item, out, wire) {
                    out.push_str("null");
                }
            }
            out.push(']');
        }
        JsValue::Object(entries) => {
            out.push('{');
            let mut first = true;
            for (key, item) in entries {
                if matches!(item, JsValue::Undefined) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                out.push_str(&json_quote(key));
                out.push(':');
                // A defined value always writes something.
                write_json(item, out, wire);
            }
            out.push('}');
        }
    }
    true
}

const MAX_DATE_MILLISECONDS: f64 = 8.64e15;

/// `Date.prototype.toISOString` for a time value, or `None` for an invalid
/// date (`JSON.stringify` maps that to `null`).
pub fn date_to_iso_string(milliseconds: f64) -> Option<String> {
    if !milliseconds.is_finite() || milliseconds.abs() > MAX_DATE_MILLISECONDS {
        return None;
    }
    let time = milliseconds.trunc() as i64;
    let days = time.div_euclid(86_400_000);
    let within = time.rem_euclid(86_400_000);
    let hour = within / 3_600_000;
    let minute = (within / 60_000) % 60;
    let second = (within / 1_000) % 60;
    let milli = within % 1_000;
    let (year, month, day) = civil_from_days(days);
    let year = if (0..=9_999).contains(&year) {
        format!("{year:04}")
    } else {
        let sign = if year < 0 { '-' } else { '+' };
        format!("{sign}{:06}", year.abs())
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z"
    ))
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to a proleptic
/// Gregorian date.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64; // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (year + i64::from(month <= 2), month, day)
}

/// A parse failure. `position` is a byte offset into the input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonParseError {
    pub position: usize,
    pub message: &'static str,
}

impl fmt::Display for JsonParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} at position {}", self.message, self.position)
    }
}

/// `JSON.parse`. Numbers become `f64` (the only JS number type); `\udxxx`
/// escapes are preserved as lone surrogates; duplicate object keys keep their
/// first position and the last value.
pub fn json_parse(input: &str) -> Result<JsValue, JsonParseError> {
    let mut parser = Parser {
        bytes: input.as_bytes(),
        text: input,
        position: 0,
    };
    parser.skip_whitespace();
    let value = parser.parse_value(0)?;
    parser.skip_whitespace();
    if parser.position != parser.bytes.len() {
        return Err(parser.error("unexpected trailing characters"));
    }
    Ok(value)
}

const MAX_PARSE_DEPTH: usize = 2_000;

struct Parser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    position: usize,
}

impl Parser<'_> {
    fn error(&self, message: &'static str) -> JsonParseError {
        JsonParseError {
            position: self.position,
            message,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.position += 1;
        }
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn parse_value(&mut self, depth: usize) -> Result<JsValue, JsonParseError> {
        if depth > MAX_PARSE_DEPTH {
            return Err(self.error("nesting too deep"));
        }
        match self.peek() {
            None => Err(self.error("unexpected end of input")),
            Some(b'{') => self.parse_object(depth),
            Some(b'[') => self.parse_array(depth),
            Some(b'"') => Ok(JsValue::String(self.parse_string()?)),
            Some(b't') => self.parse_literal("true", JsValue::Bool(true)),
            Some(b'f') => self.parse_literal("false", JsValue::Bool(false)),
            Some(b'n') => self.parse_literal("null", JsValue::Null),
            Some(b'-' | b'0'..=b'9') => self.parse_number(),
            Some(_) => Err(self.error("unexpected character")),
        }
    }

    fn parse_literal(&mut self, literal: &str, value: JsValue) -> Result<JsValue, JsonParseError> {
        if self.text[self.position..].starts_with(literal) {
            self.position += literal.len();
            Ok(value)
        } else {
            Err(self.error("unexpected literal"))
        }
    }

    fn parse_number(&mut self) -> Result<JsValue, JsonParseError> {
        let start = self.position;
        self.eat(b'-');
        match self.peek() {
            Some(b'0') => {
                self.position += 1;
            }
            Some(b'1'..=b'9') => {
                self.position += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.position += 1;
                }
            }
            _ => return Err(self.error("invalid number")),
        }
        if self.eat(b'.') {
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("invalid number"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("invalid number"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        let literal = &self.text[start..self.position];
        literal
            .parse::<f64>()
            .map(JsValue::Number)
            .map_err(|_| self.error("invalid number"))
    }

    fn parse_string(&mut self) -> Result<JsString, JsonParseError> {
        if !self.eat(b'"') {
            return Err(self.error("expected string"));
        }
        let mut units: Vec<u16> = Vec::new();
        loop {
            let byte = self
                .peek()
                .ok_or_else(|| self.error("unterminated string"))?;
            match byte {
                b'"' => {
                    self.position += 1;
                    return Ok(JsString::from_units(units));
                }
                b'\\' => {
                    self.position += 1;
                    let escape = self
                        .peek()
                        .ok_or_else(|| self.error("unterminated escape"))?;
                    self.position += 1;
                    match escape {
                        b'"' => units.push(0x22),
                        b'\\' => units.push(0x5C),
                        b'/' => units.push(0x2F),
                        b'b' => units.push(0x08),
                        b'f' => units.push(0x0C),
                        b'n' => units.push(0x0A),
                        b'r' => units.push(0x0D),
                        b't' => units.push(0x09),
                        b'u' => units.push(self.parse_hex4()?),
                        _ => return Err(self.error("invalid escape")),
                    }
                }
                0x00..=0x1F => return Err(self.error("control character in string")),
                _ => {
                    // Decode an unescaped run together. CLI text blocks can
                    // be hundreds of kilobytes; rebuilding a chars iterator
                    // and checking the JSON grammar per character is costly.
                    let start = self.position;
                    let end = memchr::memchr2(b'"', b'\\', &self.bytes[start..])
                        .map(|offset| start + offset)
                        .unwrap_or(self.bytes.len());
                    if let Some(offset) =
                        self.bytes[start..end].iter().position(|byte| *byte < 0x20)
                    {
                        self.position = start + offset;
                        return Err(self.error("control character in string"));
                    }
                    units.extend(self.text[start..end].encode_utf16());
                    self.position = end;
                }
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u16, JsonParseError> {
        let mut value = 0u16;
        for _ in 0..4 {
            let byte = self
                .peek()
                .ok_or_else(|| self.error("truncated \\u escape"))?;
            let digit = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => return Err(self.error("invalid \\u escape")),
            };
            value = (value << 4) | u16::from(digit);
            self.position += 1;
        }
        Ok(value)
    }

    fn parse_array(&mut self, depth: usize) -> Result<JsValue, JsonParseError> {
        self.position += 1; // '['
        let mut items = Vec::new();
        self.skip_whitespace();
        if self.eat(b']') {
            return Ok(JsValue::Array(items));
        }
        loop {
            self.skip_whitespace();
            items.push(self.parse_value(depth + 1)?);
            self.skip_whitespace();
            if self.eat(b',') {
                continue;
            }
            if self.eat(b']') {
                return Ok(JsValue::Array(items));
            }
            return Err(self.error("expected ',' or ']'"));
        }
    }

    fn parse_object(&mut self, depth: usize) -> Result<JsValue, JsonParseError> {
        self.position += 1; // '{'
        let mut entries: Vec<(JsString, JsValue)> = Vec::new();
        self.skip_whitespace();
        if self.eat(b'}') {
            return Ok(JsValue::Object(entries));
        }
        loop {
            self.skip_whitespace();
            let key = self.parse_string()?;
            self.skip_whitespace();
            if !self.eat(b':') {
                return Err(self.error("expected ':'"));
            }
            self.skip_whitespace();
            let value = self.parse_value(depth + 1)?;
            // JSON.parse: the last duplicate wins but the key keeps its first
            // position.
            if let Some(existing) = entries.iter_mut().find(|(name, _)| *name == key) {
                existing.1 = value;
            } else {
                entries.push((key, value));
            }
            self.skip_whitespace();
            if self.eat(b',') {
                continue;
            }
            if self.eat(b'}') {
                return Ok(JsValue::Object(reorder_object_keys(entries)));
            }
            return Err(self.error("expected ',' or '}'"));
        }
    }
}

/// `JSON.parse` creates an ordinary JS object, and ordinary objects enumerate
/// integer-index keys first, ascending, before the string keys in insertion
/// order. A vector preserves insertion order, so apply that rule once the
/// object is complete.
fn reorder_object_keys(entries: Vec<(JsString, JsValue)>) -> Vec<(JsString, JsValue)> {
    if !entries.iter().any(|(key, _)| array_index(key).is_some()) {
        return entries;
    }
    let mut indexed: Vec<(u32, JsString, JsValue)> = Vec::new();
    let mut rest: Vec<(JsString, JsValue)> = Vec::new();
    for (key, value) in entries {
        match array_index(&key) {
            Some(index) => indexed.push((index, key, value)),
            None => rest.push((key, value)),
        }
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    let mut ordered = Vec::with_capacity(indexed.len() + rest.len());
    ordered.extend(indexed.into_iter().map(|(_, key, value)| (key, value)));
    ordered.extend(rest);
    ordered
}

/// An ECMAScript array index: the canonical decimal spelling of an integer in
/// `0..=2^32 - 2`.
pub(crate) fn array_index(key: &JsString) -> Option<u32> {
    let bytes = key.as_str_lossy();
    let bytes = bytes.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    let mut value: u64 = 0;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u64::from(byte - b'0');
    }
    (value < u64::from(u32::MAX)).then_some(value as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bulk_string_runs_keep_escapes_controls_and_error_positions() {
        let text = format!(
            "{}\\ud800\\n{}",
            "中文😀".repeat(1000),
            "ascii".repeat(1000)
        );
        let encoded = format!("\"{text}\"");
        let mut expected = "中文😀".repeat(1000).encode_utf16().collect::<Vec<_>>();
        expected.extend([0xd800, 10]);
        expected.extend("ascii".repeat(1000).encode_utf16());
        assert_eq!(
            json_parse(&encoded).unwrap(),
            JsValue::String(JsString::from_units(expected))
        );
        for control in 0..32u8 {
            let invalid = format!("\"中文{}tail\"", control as char);
            let error = json_parse(&invalid).unwrap_err();
            assert_eq!(error.position, 7);
            assert_eq!(error.message, "control character in string");
        }
        let error = json_parse("\"中文😀").unwrap_err();
        assert_eq!(error.position, 11);
        assert_eq!(error.message, "unterminated string");
    }

    #[test]
    fn quoting_matches_json_stringify() {
        let value = JsString::from_rust_str("\"\\\u{8}\u{9}\u{a}\u{c}\u{d}\u{1}/\u{2028}😀");
        assert_eq!(
            json_quote(&value),
            "\"\\\"\\\\\\b\\t\\n\\f\\r\\u0001/\u{2028}😀\""
        );
        assert_eq!(
            json_quote(&JsString::from_units(vec![0xD83D])),
            "\"\\ud83d\""
        );
    }

    #[test]
    fn stringify_matches_javascript_shapes() {
        let value = JsValue::object(vec![
            ("b", JsValue::Number(f64::NAN)),
            ("a", JsValue::Undefined),
            (
                "c",
                JsValue::Array(vec![JsValue::Undefined, JsValue::Number(1.0)]),
            ),
            ("d", JsValue::Bytes(vec![0, 255])),
            ("e", JsValue::Date(0.0)),
            ("f", JsValue::Date(f64::NAN)),
        ]);
        assert_eq!(
            json_stringify(&value).unwrap(),
            "{\"b\":null,\"c\":[null,1],\"d\":{\"type\":\"Buffer\",\"data\":[0,255]},\
             \"e\":\"1970-01-01T00:00:00.000Z\",\"f\":null}"
        );
        assert_eq!(json_stringify(&JsValue::Number(-0.0)).unwrap(), "0");
        assert_eq!(json_stringify(&JsValue::Undefined), None);
    }

    #[test]
    fn dates_use_the_extended_iso_format() {
        assert_eq!(date_to_iso_string(0.0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            date_to_iso_string(-1.0).unwrap(),
            "1969-12-31T23:59:59.999Z"
        );
        assert_eq!(
            date_to_iso_string(253_402_300_799_999.0).unwrap(),
            "9999-12-31T23:59:59.999Z"
        );
        assert_eq!(
            date_to_iso_string(253_402_300_800_000.0).unwrap(),
            "+010000-01-01T00:00:00.000Z"
        );
        assert_eq!(date_to_iso_string(f64::NAN), None);
        assert_eq!(date_to_iso_string(8.64e15 + 1.0), None);
    }

    #[test]
    fn parse_keeps_lone_surrogates_and_duplicate_key_order() {
        let value = json_parse("{\"a\":1,\"b\":\"\\ud83d\",\"a\":2}").unwrap();
        assert_eq!(
            value,
            JsValue::object(vec![
                ("a", JsValue::Number(2.0)),
                ("b", JsValue::String(JsString::from_units(vec![0xD83D]))),
            ])
        );
        let JsValue::Object(entries) = &value else {
            panic!("object");
        };
        assert_eq!(entries[0].0, "a");
    }

    #[test]
    fn parse_numbers_follow_javascript() {
        let JsValue::Number(negative_zero) = json_parse("-0").unwrap() else {
            panic!("number");
        };
        assert!(negative_zero == 0.0 && negative_zero.is_sign_negative());
        let JsValue::Number(huge) = json_parse("1e400").unwrap() else {
            panic!("number");
        };
        assert_eq!(huge, f64::INFINITY);
        assert!(json_parse("01").is_err());
        assert!(json_parse("1.").is_err());
        assert!(json_parse("+1").is_err());
        assert!(json_parse("[1,]").is_err());
        assert!(json_parse("{} x").is_err());
        assert!(json_parse("\"\\ud800\"").is_ok());
        assert!(json_parse("\"\\u12\"").is_err());
    }
}
