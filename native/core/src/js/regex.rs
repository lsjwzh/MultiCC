//! JavaScript regular expressions without the `u` flag, on the `regex` crate.
//!
//! A JS string is UTF-16 and a non-`u` regex matches code units, so text is
//! matched through a *unit view*: every code unit becomes one `char`, with
//! surrogate units mapped onto plane-15 private-use placeholders. Quantifiers
//! then count code units and a lone surrogate survives the round trip.
//!
//! Patterns must spell JS classes out instead of using the crate's Unicode
//! ones: [`SPACE`] for `\s`, [`WORD`] for `\w`, [`BOUNDARY`] for `\b`, and
//! [`ascii_ci`] for a literal under `/i` (without `u`, case folding never maps
//! a non-ASCII character onto an ASCII one, so `ſ` is not `s` and `K` (Kelvin)
//! is not `k`). With no backreferences or lookaround, the crate's leftmost-first
//! semantics give the same matches as JS backtracking, and `replace_all`
//! visits the same non-overlapping matches as `String.prototype.replace` with
//! the `g` flag.

use super::JsString;

/// JS `\s` (WhiteSpace + LineTerminator): includes U+FEFF, excludes U+0085.
/// For use inside a character class.
pub const SPACE: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// JS `\w`, for use inside a character class.
pub const WORD: &str = "A-Za-z0-9_";

/// JS `\b`: between a [`WORD`] unit and a non-word unit (or an end).
pub const BOUNDARY: &str = r"(?-u:\b)";

/// An ASCII literal under JS `/i` without `u`: letters fold to ASCII only.
pub fn ascii_ci(literal: &str) -> String {
    literal
        .chars()
        .map(|character| {
            if character.is_ascii_alphabetic() {
                format!(
                    "[{}{}]",
                    character.to_ascii_lowercase(),
                    character.to_ascii_uppercase()
                )
            } else {
                regex::escape(&character.to_string())
            }
        })
        .collect()
}

// Surrogate units map onto plane-15 private-use placeholders so a regex
// quantifier counts UTF-16 code units, as a non-`u` JS regex does.
const UNIT_BASE: u32 = 0xF0000;

fn is_unit_placeholder(character: char) -> bool {
    (UNIT_BASE..UNIT_BASE + 0x800).contains(&u32::from(character))
}

/// One `char` per UTF-16 code unit.
pub fn to_unit_view(text: &JsString) -> String {
    let mut view = String::with_capacity(text.len());
    for unit in text.as_units() {
        match *unit {
            0xD800..=0xDFFF => view.push(
                char::from_u32(UNIT_BASE + (u32::from(*unit) - 0xD800))
                    .expect("plane-15 placeholder"),
            ),
            unit => view.push(char::from_u32(u32::from(unit)).expect("bmp character")),
        }
    }
    view
}

/// The inverse of [`to_unit_view`]. Characters introduced by a replacement
/// are encoded normally.
pub fn from_unit_view(view: &str) -> JsString {
    let mut units: Vec<u16> = Vec::with_capacity(view.len());
    let mut buffer = [0_u16; 2];
    for character in view.chars() {
        if is_unit_placeholder(character) {
            units.push((u32::from(character) - UNIT_BASE + 0xD800) as u16);
        } else {
            units.extend_from_slice(character.encode_utf16(&mut buffer));
        }
    }
    JsString::from_units(units)
}

#[cfg(test)]
mod tests {
    use super::*;
    use regex::Regex;

    #[test]
    fn the_unit_view_round_trips_lone_surrogates_and_counts_units() {
        let text = JsString::from_units(vec![0x61, 0xD83D, 0xDE00, 0xDC00, 0x62]);
        let view = to_unit_view(&text);
        assert_eq!(view.chars().count(), 5);
        assert_eq!(from_unit_view(&view), text);
        // `.{3}` over units: the emoji pair counts as two.
        let three = Regex::new(r"^.{3}").unwrap();
        assert_eq!(three.find(&view).unwrap().as_str().chars().count(), 3);
    }

    #[test]
    fn classes_follow_js_not_unicode() {
        let space = Regex::new(&format!("^[{SPACE}]+$")).unwrap();
        assert!(space.is_match("\u{FEFF}\u{3000}\t "));
        assert!(!space.is_match("\u{85}"));
        let word = Regex::new(&format!("^[{WORD}]+$")).unwrap();
        assert!(!word.is_match("é"));
        let bounded = Regex::new(&format!("{BOUNDARY}ab{BOUNDARY}")).unwrap();
        assert!(bounded.is_match("é ab"));
        assert!(
            bounded.is_match("éabé"),
            "a non-ASCII letter is not a word unit"
        );
        assert!(!bounded.is_match("xab"));
        let ci = Regex::new(&format!("^{}$", ascii_ci("sk"))).unwrap();
        assert!(ci.is_match("SK") && ci.is_match("sK"));
        assert!(!ci.is_match("ſk"), "U+017F does not fold to s without u");
        let k = Regex::new(&format!("^{}$", ascii_ci("k"))).unwrap();
        assert!(
            !k.is_match("\u{212A}"),
            "Kelvin sign does not fold to k without u"
        );
    }
}
