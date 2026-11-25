//! Artifact reference recognition: the former `src/artifact-reference.js`
//! (frozen byte for byte in `tests/helpers/legacy-artifact-reference.js`).
//!
//! The rules are pure -- which strings are artifact ids, which relative paths
//! may sit under an artifact, and which `/artifacts/<id>[/<path>]` tokens of a
//! text count as references -- so they live here. The walk over a host value is
//! not: its order of property reads is observable through getters and Proxy
//! traps, so it stays live in the addon
//! (`native/addon/src/artifact_reference.rs`) and feeds the [`Collector`].
//!
//! Text scans run on `char`s. Every character the rules look at is in the BMP,
//! and an astral character is never whitespace, a boundary or part of a
//! pattern, so a surrogate pair always moves as one unit exactly as its two
//! code units do in the frozen module. A length JS takes in code units
//! (`value.length > 1024`) stays on [`JsString`].

use std::collections::HashSet;

use crate::docs_memory_routes::valid_artifact_id;
use crate::js::{is_js_whitespace_char, JsString};

/// `MAX_REFERENCES`: distinct references kept per call.
pub const MAX_REFERENCES: usize = 256;
/// `MAX_NODES`: values entered per call, counted on entry.
pub const MAX_NODES: usize = 10_000;
/// `MAX_DEPTH`: the root is depth 0; deeper values are not entered.
pub const MAX_DEPTH: usize = 32;

/// Characters that may directly precede a `/artifacts/` token.
const START_BOUNDARIES: [char; 9] = ['"', '\'', '`', '(', '<', '[', '{', '=', '：'];
/// Characters that end a token and also stop the look-behind for a locator.
const END_BOUNDARIES: [char; 14] = [
    '"', '\'', '`', '(', ')', '<', '>', '[', ']', '{', '}', ',', ';', '!',
];
const PREFIX: [char; 11] = ['/', 'a', 'r', 't', 'i', 'f', 'a', 'c', 't', 's', '/'];
const MAX_PATH_UNITS: usize = 1024;
const MAX_SEGMENTS: usize = 32;
const MAX_SEGMENT_UNITS: usize = 255;

/// One recognized reference; `relative_path` is empty for the artifact root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    pub artifact_id: String,
    pub relative_path: String,
}

/// `isArtifactId` for a value already known to be a string:
/// `/^[A-Za-z0-9_-]{1,128}$/`. The docs and memory routes accept the same ids
/// (`$` without the `m` flag only matches the end of the input).
pub fn is_artifact_id(text: &str) -> bool {
    valid_artifact_id(text)
}

/// `normalizeRelativePath(value)` for a value already known to be a string;
/// `None` where JS returned `null`.
pub fn normalize_relative_path(value: &JsString) -> Option<JsString> {
    let units = value.as_units();
    if units.len() > MAX_PATH_UNITS || units.contains(&(b'\\' as u16)) {
        return None;
    }
    // `value.replace(/\/+$/, '')` drops the trailing run of slashes.
    let end = units
        .iter()
        .rposition(|unit| *unit != b'/' as u16)
        .map_or(0, |at| at + 1);
    let trimmed = &units[..end];
    if trimmed.is_empty() {
        return Some(JsString::new());
    }
    if trimmed[0] == b'/' as u16
        || trimmed.contains(&(b'?' as u16))
        || trimmed.contains(&(b'#' as u16))
    {
        return None;
    }
    let mut segments = 0;
    for segment in trimmed.split(|unit| *unit == b'/' as u16) {
        segments += 1;
        if segments > MAX_SEGMENTS || !is_path_segment(segment) {
            return None;
        }
    }
    // `segments.join('/')` rebuilds exactly the trimmed input.
    Some(JsString::from_units(trimmed.to_vec()))
}

/// `/^[A-Za-z0-9_-][A-Za-z0-9._@+-]{0,254}$/`
fn is_path_segment(segment: &[u16]) -> bool {
    let ascii = |unit: u16| u8::try_from(unit).is_ok_and(|byte| byte.is_ascii_alphanumeric());
    let head = |unit: u16| ascii(unit) || unit == b'_' as u16 || unit == b'-' as u16;
    let tail = |unit: u16| head(unit) || matches!(u8::try_from(unit), Ok(b'.' | b'@' | b'+'));
    !segment.is_empty()
        && segment.len() <= MAX_SEGMENT_UNITS
        && head(segment[0])
        && segment.iter().all(|unit| tail(*unit))
}

/// `referencesInText(text)` for a string: every `/artifacts/<id>[/<path>]`
/// token that starts at a boundary and outside an external locator, at most
/// [`MAX_REFERENCES`] of them, in order of appearance. Duplicates stay; the
/// [`Collector`] removes them.
pub fn references_in_text(text: &str) -> Vec<Reference> {
    let text: Vec<char> = text.chars().collect();
    let mut result = Vec::new();
    let mut cursor = 0;
    while cursor < text.len() && result.len() < MAX_REFERENCES {
        // `text.indexOf(ARTIFACT_PREFIX, cursor)`
        let Some(offset) = text[cursor..]
            .windows(PREFIX.len())
            .position(|window| window == PREFIX)
        else {
            break;
        };
        let index = cursor + offset;
        cursor = index + PREFIX.len();
        if !can_start_at(&text, index) {
            continue;
        }
        let mut end = cursor;
        while end < text.len()
            && !is_js_whitespace_char(text[end])
            && !END_BOUNDARIES.contains(&text[end])
        {
            end += 1;
        }
        let raw = &text[cursor..end];
        let query_at = raw.iter().position(|unit| *unit == '?' || *unit == '#');
        let pathname = match query_at {
            Some(at) => &raw[..at],
            None => raw,
        };
        let slash_at = pathname.iter().position(|unit| *unit == '/');
        let (artifact_id, rest) = match slash_at {
            None => (pathname, &[][..]),
            Some(at) => (&pathname[..at], &pathname[at + 1..]),
        };
        let artifact_id: String = artifact_id.iter().collect();
        if !is_artifact_id(&artifact_id) {
            continue;
        }
        let rest: String = rest.iter().collect();
        if let Some(relative_path) = normalize_relative_path(&JsString::from_rust_str(&rest)) {
            result.push(Reference {
                relative_path: relative_path.to_string_lossy(),
                artifact_id,
            });
        }
    }
    result
}

/// `canStartAt(text, index)`.
fn can_start_at(text: &[char], index: usize) -> bool {
    if index == 0 {
        return true;
    }
    let previous = text[index - 1];
    (is_js_whitespace_char(previous) || START_BOUNDARIES.contains(&previous))
        && !is_inside_external_locator(text, index)
}

/// `isInsideExternalLocator(text, index)`: the text back to the last
/// whitespace or closing boundary spells `scheme:` or opens with `//`.
fn is_inside_external_locator(text: &[char], index: usize) -> bool {
    let mut start = index;
    while start > 0
        && !is_js_whitespace_char(text[start - 1])
        && !END_BOUNDARIES.contains(&text[start - 1])
    {
        start -= 1;
    }
    let prefix = &text[start..index];
    let mut has_letter = false;
    for (i, &unit) in prefix.iter().enumerate() {
        if unit == ':' && has_letter {
            return true;
        }
        if unit == '/' && prefix.get(i + 1) == Some(&'/') && (i == 0 || prefix[i - 1] == '=') {
            return true;
        }
        if unit.is_ascii_alphabetic() {
            has_letter = true;
        } else if !(unit.is_ascii_digit() || matches!(unit, '+' | '-' | '.')) {
            has_letter = false;
        }
    }
    false
}

/// The `Map` of the frozen module: insertion-ordered, deduplicated by
/// `artifactId + "\0" + relativePath`, capped at [`MAX_REFERENCES`].
#[derive(Debug, Default)]
pub struct Collector {
    seen: HashSet<(String, String)>,
    entries: Vec<Reference>,
}

impl Collector {
    /// `references.size`
    pub fn size(&self) -> usize {
        self.entries.len()
    }

    /// `references.size >= MAX_REFERENCES`
    pub fn is_full(&self) -> bool {
        self.entries.len() >= MAX_REFERENCES
    }

    /// `add(artifactId, relativePath)` for values already known to be strings:
    /// invalid ids and paths are dropped, a full collector drops everything.
    pub fn add(&mut self, artifact_id: &str, relative_path: &JsString) {
        if self.is_full() || !is_artifact_id(artifact_id) {
            return;
        }
        if let Some(normalized) = normalize_relative_path(relative_path) {
            self.push(artifact_id, &normalized.to_string_lossy());
        }
    }

    /// Insert a reference that is valid by construction (it came out of
    /// [`references_in_text`]).
    pub fn push(&mut self, artifact_id: &str, relative_path: &str) {
        if self.is_full() {
            return;
        }
        let key = (artifact_id.to_owned(), relative_path.to_owned());
        if self.seen.insert(key) {
            self.entries.push(Reference {
                artifact_id: artifact_id.to_owned(),
                relative_path: relative_path.to_owned(),
            });
        }
    }

    /// `[...references.values()].sort(compareReferences)`: by artifact id, then
    /// relative path. Both are ASCII by construction, so byte order is the
    /// code-unit order of `<` on JS strings; keys are unique, so stability
    /// does not matter.
    pub fn finish(mut self) -> Vec<Reference> {
        self.entries.sort_by(|left, right| {
            left.artifact_id
                .cmp(&right.artifact_id)
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        self.entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(text: &str) -> Option<String> {
        normalize_relative_path(&JsString::from_rust_str(text)).map(|value| value.to_string_lossy())
    }

    fn refs(text: &str) -> Vec<(String, String)> {
        references_in_text(text)
            .into_iter()
            .map(|reference| (reference.artifact_id, reference.relative_path))
            .collect()
    }

    fn pair(artifact_id: &str, relative_path: &str) -> (String, String) {
        (artifact_id.to_owned(), relative_path.to_owned())
    }

    #[test]
    fn ids_follow_the_shared_protocol() {
        for (text, expected) in [
            ("a", true),
            ("A_b-9", true),
            ("-_", true),
            ("", false),
            ("a.b", false),
            ("café", false),
            ("\u{feff}a", false),
            ("/artifacts/x", false),
        ] {
            assert_eq!(is_artifact_id(text), expected, "{text:?}");
        }
        assert!(is_artifact_id(&"a".repeat(128)));
        assert!(!is_artifact_id(&"a".repeat(129)));
    }

    #[test]
    fn paths_drop_trailing_slashes_and_refuse_the_rest() {
        let wide = |first: usize| {
            ["a".repeat(first)]
                .into_iter()
                .chain(std::iter::repeat_n("a".repeat(31), 31))
                .collect::<Vec<_>>()
                .join("/")
        };
        for (text, expected) in [
            ("", Some("")),
            ("///", Some("")),
            ("a", Some("a")),
            ("a//", Some("a")),
            ("a/b//", Some("a/b")),
            ("a///b", None),
            ("/a", None),
            ("//a", None),
            ("a?b", None),
            ("a#b", None),
            ("a\\b", None),
            ("./a", None),
            ("a/./b", None),
            ("../a", None),
            ("a/../b", None),
            (".hidden/x", None),
            ("@x", None),
            ("+w", None),
            ("-x/_y/z@/+w/a.b", None),
            ("-x/_y/z@/w+/a.b", Some("-x/_y/z@/w+/a.b")),
            ("~x", None),
            ("x y", None),
            ("a/B", Some("a/B")),
            ("😀/x", None),
            ("a\u{0}b", None),
        ] {
            assert_eq!(path(text).as_deref(), expected, "{text:?}");
        }
        let longest = "a".repeat(255);
        assert_eq!(path(&longest).as_deref(), Some(longest.as_str()));
        assert_eq!(path(&"a".repeat(256)), None);
        assert_eq!(path(&"a/".repeat(32)), Some("a/".repeat(31) + "a"));
        assert_eq!(path(&"a/".repeat(33)), None);
        // Length is counted in UTF-16 code units.
        assert_eq!(path(&wide(31)), Some(wide(31)));
        assert_eq!(path(&wide(32)), Some(wide(32)));
        assert_eq!(path(&wide(33)), None);
    }

    #[test]
    fn tokens_need_a_boundary_and_a_valid_id_and_path() {
        assert_eq!(refs("/artifacts/a"), [pair("a", "")]);
        assert_eq!(refs("/artifacts/a/"), [pair("a", "")]);
        assert_eq!(
            refs("/artifacts/A_b-9/x+y@z.w?view=all#top"),
            [pair("A_b-9", "x+y@z.w")]
        );
        assert_eq!(
            refs("/artifacts/a?x=/artifacts/b"),
            [pair("a", ""), pair("b", "")]
        );
        assert_eq!(refs("(`/artifacts/a)`"), [pair("a", "")]);
        assert_eq!(
            refs("</artifacts/a>[/artifacts/b]{/artifacts/c}"),
            [pair("a", ""), pair("b", ""), pair("c", "")]
        );
        assert_eq!(refs("/artifacts/"), []);
        assert_eq!(refs("/artifacts/../../x"), []);
        assert_eq!(refs("/artifacts/a/./b"), []);
        assert_eq!(refs("/artifacts/a//b"), []);
        assert_eq!(refs("/artifacts/%61"), []);
        assert_eq!(refs("/artifacts/a b"), [pair("a", "")]);
        assert_eq!(refs("/artifacts/a\u{0}b"), []);
        assert_eq!(refs("/Artifacts/a"), []);
        assert_eq!(
            refs(&format!("/artifacts/{}", "a".repeat(128))),
            [pair(&"a".repeat(128), "")]
        );
        assert_eq!(refs(&format!("/artifacts/{}", "a".repeat(129))), []);
        assert_eq!(refs(&format!("/artifacts/a/{}", "b".repeat(300))), []);
        assert_eq!(
            refs("/artifacts/a,\t/artifacts/b;\n/artifacts/c!"),
            [pair("a", ""), pair("b", ""), pair("c", "")]
        );
    }

    #[test]
    fn external_locators_are_not_references() {
        for text in [
            "https://x.test/artifacts/a",
            "http:/artifacts/a",
            "foo:bar/artifacts/a",
            "//artifacts/a",
            "src=\"//host/artifacts/a\"",
            "src=//host/artifacts/a",
            "mailto:=/artifacts/a",
            "1a:=/artifacts/a",
            "x12:=/artifacts/a",
            "a+b.c-d:=/artifacts/a",
            "//=/artifacts/a",
            "a=//=/artifacts/a",
            "😀/artifacts/a",
        ] {
            assert_eq!(refs(text), [], "{text:?}");
        }
        // A scheme starts with a letter: `12:` and `1:` are not schemes, so
        // the token behind them is still a reference.
        assert_eq!(refs("12:=/artifacts/a"), [pair("a", "")]);
        assert_eq!(refs("1:=/artifacts/a"), [pair("a", "")]);
        assert_eq!(refs("src=/artifacts/a"), [pair("a", "")]);
        assert_eq!(refs(" =/artifacts/a"), [pair("a", "")]);
        assert_eq!(refs("ab!=/artifacts/a"), [pair("a", "")]);
        assert_eq!(refs("：/artifacts/a"), [pair("a", "")]);
    }

    #[test]
    fn js_whitespace_starts_a_token_and_other_separators_do_not() {
        assert_eq!(
            refs("\u{a0}/artifacts/a\u{3000}/artifacts/b\u{2028}/artifacts/c﻿/artifacts/d"),
            [pair("a", ""), pair("b", ""), pair("c", ""), pair("d", ""),]
        );
        // U+0085 is whitespace to Rust, not to `/\s/`.
        assert_eq!(refs("\u{85}/artifacts/a"), []);
        assert_eq!(
            refs("😀 /artifacts/a \u{fffd}/artifacts/b"),
            [pair("a", "")]
        );
    }

    #[test]
    fn a_text_yields_at_most_max_references() {
        let text = (0..300)
            .map(|index| format!("/artifacts/id{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        let found = references_in_text(&text);
        assert_eq!(found.len(), MAX_REFERENCES);
        assert_eq!(
            found[0],
            Reference {
                artifact_id: "id0".into(),
                relative_path: String::new()
            }
        );
        let long = format!("{} /artifacts/late", "x".repeat(5000));
        assert_eq!(refs(&long), [pair("late", "")]);
    }

    #[test]
    fn collector_dedupes_in_insertion_order_and_sorts_on_finish() {
        let mut collector = Collector::default();
        for (artifact_id, relative_path) in [
            ("c", "x"),
            ("a", "z"),
            ("a", ""),
            ("a", "z/"),
            ("B", ""),
            ("a-b", ""),
            ("a_b", ""),
            ("bad id", ""),
            ("a", "/absolute"),
            ("a", "b/./c"),
        ] {
            collector.add(artifact_id, &JsString::from_rust_str(relative_path));
        }
        assert_eq!(collector.size(), 6);
        let finished: Vec<(String, String)> = collector
            .finish()
            .into_iter()
            .map(|reference| (reference.artifact_id, reference.relative_path))
            .collect();
        assert_eq!(
            finished,
            [
                pair("B", ""),
                pair("a", ""),
                pair("a", "z"),
                pair("a-b", ""),
                pair("a_b", ""),
                pair("c", "x"),
            ],
        );
    }

    #[test]
    fn a_full_collector_drops_further_references() {
        let mut collector = Collector::default();
        for index in 0..MAX_REFERENCES + 5 {
            collector.push(&format!("id{index}"), "");
        }
        let finished = collector.finish();
        assert_eq!(finished.len(), MAX_REFERENCES);
        // Code-unit order: "id99" sorts after every other "id0".."id255".
        assert_eq!(
            finished
                .last()
                .map(|reference| reference.artifact_id.as_str()),
            Some("id99")
        );
    }
}
