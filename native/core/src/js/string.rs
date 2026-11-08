//! The one JavaScript string implementation.
//!
//! A JS string is a sequence of UTF-16 code units. In particular it may hold a
//! lone surrogate, which a Rust `String` (valid UTF-8) cannot represent. Every
//! kernel that counts, slices, compares, trims or serializes text goes through
//! [`JsString`] so the rules exist once.
//!
//! Ordering is code-unit ordering, which is what `<` on JS strings does. Note
//! that it is *not* the same as UTF-8 byte ordering and not the same as
//! `String.prototype.localeCompare`, which stays in the JS engine.
use std::borrow::Cow;
use std::cmp::Ordering;
use std::fmt;
use std::hash::{Hash, Hasher};

/// A JavaScript string: UTF-16 code units, lone surrogates allowed.
#[derive(Clone, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct JsString {
    units: Vec<u16>,
}

impl JsString {
    pub fn new() -> Self {
        Self { units: Vec::new() }
    }

    /// From a well-formed Rust string (surrogate pairs are re-encoded as two
    /// code units).
    pub fn from_rust_str(value: &str) -> Self {
        Self {
            units: value.encode_utf16().collect(),
        }
    }

    /// From raw UTF-16 code units, including lone surrogates.
    pub fn from_units(units: Vec<u16>) -> Self {
        Self { units }
    }

    pub fn as_units(&self) -> &[u16] {
        &self.units
    }

    pub fn into_units(self) -> Vec<u16> {
        self.units
    }

    /// `String.prototype.length` — UTF-16 code units, not scalar values.
    pub fn len(&self) -> usize {
        self.units.len()
    }

    pub fn is_empty(&self) -> bool {
        self.units.is_empty()
    }

    pub fn code_unit_at(&self, index: usize) -> Option<u16> {
        self.units.get(index).copied()
    }

    /// True when every code unit is part of a well-formed surrogate pair or a
    /// single BMP scalar.
    pub fn is_well_formed(&self) -> bool {
        String::from_utf16(&self.units).is_ok()
    }

    /// A UTF-8 view with lone surrogates replaced by U+FFFD, the same loss the
    /// napi string boundary used to impose. Rules that must see the original
    /// code units (length, slicing, JSON quoting) never call this.
    pub fn as_str_lossy(&self) -> Cow<'_, str> {
        // A &str cannot borrow from UTF-16 storage, so this is always owned.
        Cow::Owned(String::from_utf16_lossy(&self.units))
    }

    pub fn to_string_lossy(&self) -> String {
        String::from_utf16_lossy(&self.units)
    }

    /// The bytes Node uses for `Buffer.byteLength(string, 'utf8')`,
    /// `Hash.update(string)` and `Buffer.from(string)`: lone surrogates become
    /// the three bytes of U+FFFD.
    pub fn utf8_lossy_bytes(&self) -> Vec<u8> {
        self.to_string_lossy().into_bytes()
    }

    pub fn push(&mut self, other: &JsString) {
        self.units.extend_from_slice(&other.units);
    }

    pub fn push_str(&mut self, other: &str) {
        self.units.extend(other.encode_utf16());
    }

    pub fn push_unit(&mut self, unit: u16) {
        self.units.push(unit);
    }

    pub fn concat(parts: &[&JsString]) -> JsString {
        let total: usize = parts.iter().map(|part| part.units.len()).sum();
        let mut out = Vec::with_capacity(total);
        for part in parts {
            out.extend_from_slice(&part.units);
        }
        JsString { units: out }
    }

    pub fn join(parts: &[JsString], separator: &JsString) -> JsString {
        let mut out = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            if index > 0 {
                out.extend_from_slice(&separator.units);
            }
            out.extend_from_slice(&part.units);
        }
        JsString { units: out }
    }

    /// First `count` code units. A cut through a surrogate pair keeps the lone
    /// high surrogate, exactly like `String.prototype.slice(0, count)`.
    pub fn truncate_units(&self, count: usize) -> JsString {
        JsString {
            units: self.units[..count.min(self.units.len())].to_vec(),
        }
    }

    /// `text.slice(start, end)` for already normalized non-negative indices.
    pub fn slice_units(&self, start: usize, end: usize) -> JsString {
        let start = start.min(self.units.len());
        let end = end.min(self.units.len()).max(start);
        JsString {
            units: self.units[start..end].to_vec(),
        }
    }

    /// `String.prototype.trim.*` — ECMAScript WhiteSpace plus LineTerminator.
    pub fn trim(&self) -> JsString {
        let start = self
            .units
            .iter()
            .position(|unit| !is_js_whitespace(*unit))
            .unwrap_or(self.units.len());
        let end = self
            .units
            .iter()
            .rposition(|unit| !is_js_whitespace(*unit))
            .map_or(start, |index| index + 1);
        JsString {
            units: self.units[start..end].to_vec(),
        }
    }

    pub fn trim_start(&self) -> JsString {
        let start = self
            .units
            .iter()
            .position(|unit| !is_js_whitespace(*unit))
            .unwrap_or(self.units.len());
        JsString {
            units: self.units[start..].to_vec(),
        }
    }

    pub fn trim_end(&self) -> JsString {
        let end = self
            .units
            .iter()
            .rposition(|unit| !is_js_whitespace(*unit))
            .map_or(0, |index| index + 1);
        JsString {
            units: self.units[..end].to_vec(),
        }
    }

    /// `String.prototype.toLowerCase` through the lossy view. Both languages
    /// use Unicode Default Case Conversion (including the contextual final
    /// sigma); lone surrogates are unaffected by JS and become U+FFFD here,
    /// which only ever matters for text that is compared against ASCII.
    pub fn to_lowercase(&self) -> JsString {
        JsString::from_rust_str(&self.as_str_lossy().to_lowercase())
    }

    /// `String.prototype.toUpperCase`; same lossy caveat as [`Self::to_lowercase`].
    pub fn to_uppercase(&self) -> JsString {
        JsString::from_rust_str(&self.as_str_lossy().to_uppercase())
    }
}

impl fmt::Debug for JsString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}", self.to_string_lossy())
    }
}

impl fmt::Display for JsString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.to_string_lossy())
    }
}

impl Hash for JsString {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.units.hash(state);
    }
}

impl From<&str> for JsString {
    fn from(value: &str) -> Self {
        JsString::from_rust_str(value)
    }
}

impl From<String> for JsString {
    fn from(value: String) -> Self {
        JsString::from_rust_str(&value)
    }
}

impl From<&String> for JsString {
    fn from(value: &String) -> Self {
        JsString::from_rust_str(value)
    }
}

impl From<Vec<u16>> for JsString {
    fn from(value: Vec<u16>) -> Self {
        JsString::from_units(value)
    }
}

impl PartialEq<str> for JsString {
    fn eq(&self, other: &str) -> bool {
        self.units.len() == other.encode_utf16().count()
            && self.units.iter().copied().eq(other.encode_utf16())
    }
}

impl PartialEq<JsString> for str {
    fn eq(&self, other: &JsString) -> bool {
        other == self
    }
}

impl PartialEq<&str> for JsString {
    fn eq(&self, other: &&str) -> bool {
        self == *other
    }
}

impl PartialEq<JsString> for &str {
    fn eq(&self, other: &JsString) -> bool {
        other == *self
    }
}

impl PartialEq<String> for JsString {
    fn eq(&self, other: &String) -> bool {
        self == other.as_str()
    }
}

impl std::str::FromStr for JsString {
    type Err = std::convert::Infallible;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Ok(JsString::from_rust_str(value))
    }
}

/// ECMAScript WhiteSpace (`\t`, `\v`, `\f`, space, NBSP, ZWNBSP and the
/// Unicode space separators) plus LineTerminator (`\n`, `\r`, U+2028, U+2029).
/// U+0085 is *not* whitespace in JS; Rust's `char::is_whitespace` says it is,
/// which is why no kernel may use the std predicate.
pub fn is_js_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x0009..=0x000D
            | 0x0020
            | 0x00A0
            | 0x1680
            | 0x2000..=0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    )
}

pub fn is_js_whitespace_char(character: char) -> bool {
    character.len_utf16() == 1 && is_js_whitespace(character as u32 as u16)
}

/// `String.prototype.trim` for already valid UTF-8.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace_char)
}

/// `String.prototype.length` for already valid UTF-8.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// First `end` UTF-16 code units. A boundary that splits a surrogate pair
/// leaves a lone code unit for the caller to handle (the serde-era helper).
pub fn utf16_prefix_units(text: &str, end: usize) -> Vec<u16> {
    text.encode_utf16().take(end).collect()
}

/// `text.slice(0, end)` for a non-negative end. A cut through a surrogate pair
/// becomes U+FFFD — the old JS→Rust boundary convention that the remaining
/// JSON-transported kernels still rely on.
pub fn utf16_prefix(text: &str, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= end {
        return text.to_string();
    }
    String::from_utf16_lossy(&units[..end])
}

/// `text.slice(0, end)` that never splits a surrogate pair: the last character
/// that does not fit is dropped instead. This is the rule `classify_vocab` was
/// migrated with, kept identical.
pub fn utf16_truncate(text: &str, end: usize) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for character in text.chars() {
        let width = character.len_utf16();
        if units + width > end {
            break;
        }
        out.push(character);
        units += width;
    }
    out
}

/// `text.slice(-n)` for `n >= 0`. `n == 0` means `slice(-0)`, i.e. the whole
/// string, matching the spec's relative-start rule.
pub fn utf16_suffix(text: &str, n: f64) -> String {
    if n.is_nan() || n == f64::INFINITY {
        return text.to_string();
    }
    // `slice(-n)` truncates the relative start toward zero first: -0.5 becomes
    // -0, which is not negative, so the whole string is kept.
    let count = n.trunc();
    if count <= 0.0 {
        return text.to_string();
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    if count >= units.len() as f64 {
        return text.to_string();
    }
    let start = units.len() - count as usize;
    String::from_utf16_lossy(&units[start..])
}

/// Code-unit ordering (JS relational comparison on strings).
/// An `indexOf` needle over UTF-16 code units. Short haystacks use a plain
/// scan; the SIMD byte searcher (which only accepts unit-aligned hits) is
/// built the first time a long haystack is searched, since its setup costs
/// more than scanning a few hundred units.
#[derive(Debug)]
pub struct UnitFinder {
    units: Vec<u16>,
    finder: std::sync::OnceLock<memchr::memmem::Finder<'static>>,
}

impl Clone for UnitFinder {
    fn clone(&self) -> Self {
        Self::new(&self.units)
    }
}

const SIMD_SEARCH_MIN_UNITS: usize = 256;

fn unit_bytes(units: &[u16]) -> &[u8] {
    // SAFETY: u16 has no padding and u8 has alignment 1; both slices are only
    // compared with each other, so the byte order is irrelevant.
    unsafe { std::slice::from_raw_parts(units.as_ptr().cast::<u8>(), units.len() * 2) }
}

impl UnitFinder {
    pub fn new(needle: &[u16]) -> Self {
        Self {
            units: needle.to_vec(),
            finder: std::sync::OnceLock::new(),
        }
    }

    pub fn needle(&self) -> &[u16] {
        &self.units
    }

    /// `haystack.indexOf(needle, from)`; `None` for an empty needle.
    pub fn find(&self, haystack: &[u16], from: usize) -> Option<usize> {
        let needle = self.units.as_slice();
        if needle.is_empty() || from > haystack.len() || needle.len() > haystack.len() - from {
            return None;
        }
        if haystack.len() - from < SIMD_SEARCH_MIN_UNITS {
            let first = needle[0];
            return (from..=haystack.len() - needle.len())
                .find(|&at| haystack[at] == first && haystack[at..at + needle.len()] == *needle);
        }
        let finder = self
            .finder
            .get_or_init(|| memchr::memmem::Finder::new(unit_bytes(needle)).into_owned());
        let bytes = unit_bytes(haystack);
        let mut at = from * 2;
        while let Some(found) = finder.find(&bytes[at..]) {
            let byte = at + found;
            if byte.is_multiple_of(2) {
                return Some(byte / 2);
            }
            // An odd hit straddles two units; resume one byte later so an
            // overlapping aligned hit is not skipped.
            at = byte + 1;
        }
        None
    }
}

/// `haystack.includes(needle)` over code units.
pub fn contains_units(haystack: &[u16], needle: &[u16]) -> bool {
    UnitFinder::new(needle).find(haystack, 0).is_some()
}

pub fn compare_units(left: &JsString, right: &JsString) -> Ordering {
    left.as_units().cmp(right.as_units())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_and_slices_count_code_units() {
        let text = JsString::from_rust_str("a😀中");
        assert_eq!(text.len(), 4);
        assert_eq!(text.truncate_units(2).as_units(), &[0x61, 0xD83D]);
        assert!(!text.truncate_units(2).is_well_formed());
        assert_eq!(text.slice_units(1, 3).as_units(), &[0xD83D, 0xDE00]);
        assert_eq!(text.to_string_lossy(), "a😀中");
    }

    #[test]
    fn ordering_is_by_code_unit() {
        // U+FFFD (0xFFFD) sorts after U+1F600's high surrogate (0xD83D).
        let emoji = JsString::from_rust_str("😀");
        let replacement = JsString::from_rust_str("\u{FFFD}");
        assert_eq!(compare_units(&emoji, &replacement), Ordering::Less);
    }

    #[test]
    fn trim_uses_the_ecmascript_set() {
        let text = JsString::from_rust_str("\u{feff}\u{0020}x\u{0085}");
        assert_eq!(text.trim().to_string_lossy(), "x\u{0085}");
        assert_eq!(
            JsString::from_rust_str("\u{0085}x\u{0085}")
                .trim()
                .to_string_lossy(),
            "\u{0085}x\u{0085}"
        );
        assert_eq!(JsString::from_rust_str("\u{00a0}x\u{3000}").trim().len(), 1);
    }

    #[test]
    fn lossy_views_replace_lone_surrogates() {
        let lone = JsString::from_units(vec![0xD83D]);
        assert_eq!(lone.to_string_lossy(), "\u{FFFD}");
        assert_eq!(lone.utf8_lossy_bytes(), "\u{FFFD}".as_bytes());
    }
}
