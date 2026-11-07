//! ECMAScript number semantics: `Number.prototype.toString` and
//! `StringNumericLiteral` → number.
//!
//! `number_to_string` must produce the shortest round-tripping decimal form
//! with the ECMAScript choice between fixed and exponential notation. `ryu-js`
//! implements exactly that algorithm; the special values and both zeros are
//! handled before it runs (JS prints `-0` as `"0"`).
use crate::js::string::{js_trim, JsString};

/// ECMAScript `String(number)` / `Number.prototype.toString()`.
pub fn number_to_string(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_string();
    }
    if number == f64::INFINITY {
        return "Infinity".to_string();
    }
    if number == f64::NEG_INFINITY {
        return "-Infinity".to_string();
    }
    // JS prints both zeros as "0".
    if number == 0.0 {
        return "0".to_string();
    }
    let mut buffer = ryu_js::Buffer::new();
    buffer.format_finite(number).to_string()
}

/// Historic alias used by kernels migrated earlier.
pub fn format_f64(number: f64) -> String {
    number_to_string(number)
}

fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut at = 0usize;
    if bytes
        .first()
        .is_some_and(|byte| *byte == b'+' || *byte == b'-')
    {
        at += 1;
    }
    let mut digits = 0usize;
    while bytes.get(at).is_some_and(u8::is_ascii_digit) {
        at += 1;
        digits += 1;
    }
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if bytes
        .get(at)
        .is_some_and(|byte| *byte == b'e' || *byte == b'E')
    {
        at += 1;
        if bytes
            .get(at)
            .is_some_and(|byte| *byte == b'+' || *byte == b'-')
        {
            at += 1;
        }
        let mut exponent_digits = 0usize;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
            exponent_digits += 1;
        }
        if exponent_digits == 0 {
            return false;
        }
    }
    at == bytes.len()
}

fn radix_number(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut value = 0.0f64;
    for character in digits.chars() {
        match character.to_digit(radix) {
            Some(digit) => value = value * f64::from(radix) + f64::from(digit),
            None => return f64::NAN,
        }
    }
    value
}

/// ECMAScript `Number(string)` — StringNumericLiteral. The empty (after trim)
/// string is 0; `0x`/`0o`/`0b` prefixes are accepted; `Infinity` is signed;
/// anything else follows the decimal grammar.
pub fn js_string_to_number(text: &str) -> f64 {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = trimmed.strip_prefix(prefix) {
            return radix_number(digits, radix);
        }
    }
    if !is_decimal_literal(trimmed) {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(string)` for a JS string. Only ASCII can form a numeric literal, so
/// the lossy view cannot change the outcome for a lone surrogate (it fails).
pub fn string_to_number(value: &JsString) -> f64 {
    js_string_to_number(&value.as_str_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(number_to_string(15.0), "15");
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(number_to_string(1e-7), "1e-7");
        assert_eq!(number_to_string(0.000001), "0.000001");
        assert_eq!(number_to_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(number_to_string(f64::NAN), "NaN");
        assert_eq!(number_to_string(f64::NEG_INFINITY), "-Infinity");
    }

    #[test]
    fn string_numeric_literals_match_javascript() {
        assert_eq!(js_string_to_number(" 12 "), 12.0);
        assert_eq!(js_string_to_number("0x10"), 16.0);
        assert_eq!(js_string_to_number("0o17"), 15.0);
        assert_eq!(js_string_to_number("0b101"), 5.0);
        assert!(js_string_to_number("-0x10").is_nan());
        assert!(js_string_to_number("1_000").is_nan());
        assert!(js_string_to_number("0x").is_nan());
        assert_eq!(js_string_to_number("1e3"), 1000.0);
        assert_eq!(js_string_to_number(""), 0.0);
        assert_eq!(js_string_to_number("\u{feff}\u{3000}"), 0.0);
        assert_eq!(js_string_to_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(js_string_to_number("Infinity"), f64::INFINITY);
        assert!(js_string_to_number("\u{0085}1").is_nan());
    }
}
