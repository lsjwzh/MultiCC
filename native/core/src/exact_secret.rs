//! Exact-secret redaction for a provider route capability.
//!
//! Was `redactExactSecretFragments` and `createExactSecretStreamRedactor` in
//! src/observability.js. Both look for known secret strings (not patterns), so
//! a capability split across several stored strings or across stream deltas
//! is still found. All positions and lengths are UTF-16 code units, as in JS.

use crate::js::{JsString, UnitFinder};
use crate::redaction::{redact_route_capability, PROVIDER_ROUTE_REDACTION};

/// Distinct non-empty secrets, longest first, each with a precompiled search.
#[derive(Clone, Debug, Default)]
pub struct Secrets(Vec<UnitFinder>);

impl Secrets {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// `[...new Set(values.filter(Boolean))].sort((l, r) => r.length - l.length)`:
/// distinct non-empty secrets, longest first, ties in first-seen order.
pub fn normalize_secrets(values: impl IntoIterator<Item = JsString>) -> Secrets {
    let mut secrets: Vec<JsString> = Vec::new();
    for value in values {
        if !value.is_empty() && !secrets.contains(&value) {
            secrets.push(value);
        }
    }
    // Stable, like Array.prototype.sort.
    secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    Secrets(
        secrets
            .iter()
            .map(|secret| UnitFinder::new(secret.as_units()))
            .collect(),
    )
}

/// The earliest occurrence of any secret at or after `from`, the longer one
/// on a tie: `(index, length)`.
fn earliest(secrets: &Secrets, haystack: &[u16], from: usize) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    for finder in &secrets.0 {
        let needle = finder.needle();
        if let Some(index) = finder.find(haystack, from) {
            let better = match best {
                None => true,
                Some((at, length)) => index < at || (index == at && needle.len() > length),
            };
            if better {
                best = Some((index, needle.len()));
            }
        }
    }
    best
}

fn marker() -> JsString {
    JsString::from_rust_str(PROVIDER_ROUTE_REDACTION)
}

/// `redactExactSecretFragments(parts, secrets)` with already normalized
/// secrets: the parts are read as one concatenated text, and every part that
/// holds a piece of a match gets its own marker for that piece, so no subset
/// of the returned parts can be joined back into a secret.
pub fn redact_fragments(parts: Vec<JsString>, secrets: &Secrets) -> Vec<JsString> {
    if parts.is_empty() || secrets.is_empty() {
        return parts;
    }
    let mut offsets = Vec::with_capacity(parts.len());
    let mut joined: Vec<u16> = Vec::new();
    for part in &parts {
        offsets.push(joined.len());
        joined.extend_from_slice(part.as_units());
    }
    let mut matches: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0;
    while cursor < joined.len() {
        match earliest(secrets, &joined, cursor) {
            Some((index, length)) => {
                matches.push((index, index + length));
                cursor = index + length;
            }
            None => break,
        }
    }
    if matches.is_empty() {
        return parts;
    }
    let marker = marker();
    parts
        .iter()
        .zip(offsets)
        .map(|(part, part_start)| {
            let part_end = part_start + part.len();
            // Matches are ascending and disjoint; edit from the right so the
            // earlier offsets stay valid.
            let mut units = part.as_units().to_vec();
            for &(start, end) in matches.iter().rev() {
                let start = start.max(part_start);
                let end = end.min(part_end);
                if start < end {
                    units.splice(
                        start - part_start..end - part_start,
                        marker.as_units().iter().copied(),
                    );
                }
            }
            JsString::from_units(units)
        })
        .collect()
}

/// `createExactSecretStreamRedactor(secrets)`: a transducer over one stream
/// that withholds only a suffix that could still become a secret, so a
/// complete secret is never released whatever the chunk boundaries.
#[derive(Debug, Default, Clone)]
pub struct StreamRedactor {
    secrets: Secrets,
    pending: Vec<u16>,
}

impl StreamRedactor {
    pub fn new(secrets: impl IntoIterator<Item = JsString>) -> Self {
        Self {
            secrets: normalize_secrets(secrets),
            pending: Vec::new(),
        }
    }

    pub fn set_secrets(&mut self, secrets: impl IntoIterator<Item = JsString>) {
        self.secrets = normalize_secrets(secrets);
    }

    /// The longest suffix of `value` that is a proper prefix of a secret.
    fn longest_pending_suffix(&self, value: &[u16]) -> usize {
        let mut best = 0;
        for finder in &self.secrets.0 {
            let secret = finder.needle();
            let mut length = (secret.len() - 1).min(value.len());
            while length > best {
                if secret.starts_with(&value[value.len() - length..]) {
                    best = length;
                    break;
                }
                length -= 1;
            }
        }
        best
    }

    pub fn push(&mut self, chunk: &JsString) -> JsString {
        let mut input = std::mem::take(&mut self.pending);
        input.extend_from_slice(chunk.as_units());
        let marker = marker();
        let mut output: Vec<u16> = Vec::with_capacity(input.len());
        let mut start = 0;
        while start < input.len() {
            let rest = &input[start..];
            if let Some((index, length)) = earliest(&self.secrets, rest, 0) {
                output.extend_from_slice(&rest[..index]);
                output.extend_from_slice(marker.as_units());
                start += index + length;
                continue;
            }
            let keep = self.longest_pending_suffix(rest);
            output.extend_from_slice(&rest[..rest.len() - keep]);
            self.pending = rest[rest.len() - keep..].to_vec();
            break;
        }
        redact_route_capability(&JsString::from_units(output))
    }

    /// Releases the withheld suffix at an explicit stream boundary.
    pub fn flush(&mut self) -> JsString {
        redact_route_capability(&JsString::from_units(std::mem::take(&mut self.pending)))
    }

    pub fn discard(&mut self) {
        self.pending.clear();
    }

    /// Withheld UTF-16 units.
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(text: &str) -> JsString {
        JsString::from_rust_str(text)
    }
    fn list(items: &[&str]) -> Vec<JsString> {
        items.iter().map(|item| s(item)).collect()
    }
    const M: &str = PROVIDER_ROUTE_REDACTION;

    #[test]
    fn the_long_and_short_searches_agree() {
        let needle: Vec<u16> = "abab".encode_utf16().collect();
        let finder = UnitFinder::new(&needle);
        for length in [3usize, 255, 256, 257, 1000] {
            for at in [
                0usize,
                1,
                length.saturating_sub(4),
                length.saturating_sub(3),
            ] {
                let mut haystack = vec![0x61u16; length];
                // An odd-offset byte image of the needle, then the real one.
                haystack.iter_mut().for_each(|unit| *unit = 0x6261);
                if at + 4 <= length {
                    haystack[at..at + 4].copy_from_slice(&needle);
                }
                let expected = (0..=length.saturating_sub(4))
                    .find(|&i| i + 4 <= length && haystack[i..i + 4] == needle[..]);
                for from in [0usize, 1, at] {
                    let want = expected.filter(|&i| i >= from).or_else(|| {
                        (from..=length.saturating_sub(4))
                            .find(|&i| i + 4 <= length && haystack[i..i + 4] == needle[..])
                    });
                    assert_eq!(
                        finder.find(&haystack, from),
                        want,
                        "len {length} at {at} from {from}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_unit_search_matches_index_of_and_rejects_straddling_hits() {
        // Bytes of [0x4142, 0x4344] contain the bytes of 0x4243 at an odd
        // offset only (little or big endian alike).
        let finder = UnitFinder::new(&[0x4243]);
        assert_eq!(finder.find(&[0x4142, 0x4344], 0), None);
        let mut long = [0x4142u16, 0x4344].repeat(200);
        assert_eq!(
            finder.find(&long, 0),
            None,
            "the SIMD path rejects straddling hits too"
        );
        long.push(0x4243);
        assert_eq!(finder.find(&long, 0), Some(400));
        let finder = UnitFinder::new(&[0x61, 0x61]);
        assert_eq!(finder.find(&[0x61, 0x61, 0x61], 1), Some(1));
        assert_eq!(finder.find(&[0x61, 0x61, 0x61], 2), None);
        assert_eq!(finder.find(&[0x61], 5), None);
        let lone = UnitFinder::new(&[0xD800]);
        assert_eq!(lone.find(&[0x20, 0xD83D, 0xDE00, 0xD800], 0), Some(3));
    }

    #[test]
    fn secrets_are_distinct_non_empty_and_longest_first() {
        let secrets = normalize_secrets(list(&["ab", "", "abcd", "ab", "xy"]));
        let needles: Vec<JsString> = secrets
            .0
            .iter()
            .map(|finder| JsString::from_units(finder.needle().to_vec()))
            .collect();
        assert_eq!(needles, list(&["abcd", "ab", "xy"]));
    }

    #[test]
    fn a_secret_split_over_parts_marks_every_part() {
        let out = redact_fragments(
            list(&["say SEC", "RET now", "and SECRET"]),
            &normalize_secrets(list(&["SECRET"])),
        );
        assert_eq!(
            out,
            vec![
                s(&format!("say {M}")),
                s(&format!("{M} now")),
                s(&format!("and {M}"))
            ]
        );
        assert_eq!(
            redact_fragments(list(&["a", "b"]), &normalize_secrets(list(&["zz"]))),
            list(&["a", "b"])
        );
        assert_eq!(
            redact_fragments(vec![], &normalize_secrets(list(&["zz"]))),
            Vec::<JsString>::new()
        );
    }

    #[test]
    fn the_stream_never_releases_a_secret_at_any_boundary() {
        let secret = "pr1.c2Vzc2lvbi0x.cHJveHktcm91dGUtc2VjcmV0";
        let units: Vec<u16> = secret.encode_utf16().collect();
        for split in 0..=units.len() {
            let mut redactor = StreamRedactor::new(list(&[secret]));
            let mut out = redactor
                .push(&JsString::from_units(units[..split].to_vec()))
                .to_string_lossy();
            out += &redactor
                .push(&JsString::from_units(units[split..].to_vec()))
                .to_string_lossy();
            assert_eq!(out, M);
        }
        let mut ordinary = StreamRedactor::new(list(&[secret]));
        assert_eq!(ordinary.push(&s("answer ends in p")), s("answer ends in "));
        assert_eq!(ordinary.pending_len(), 1);
        assert_eq!(ordinary.flush(), s("p"));
        assert_eq!(ordinary.pending_len(), 0);
    }
}
