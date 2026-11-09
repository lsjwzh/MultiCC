//! Claude transcript governor.
//!
//! This is the Rust owner of what used to be `src/chat/transcript-prune.js`: the
//! transcript is parsed, planned, trimmed and measured here; the JS facade only
//! forwards JSON and the host's home directory. File IO stays in this module
//! because the trimming rules and the files they touch are the same concern.
//!
//! Two hard invariants, learned from the way `--resume` reconstructs state:
//!
//! 1. Never drop an entry from the middle of the file. Entries form a parentUuid
//!    chain; only head cuts are allowed, and any kept entry whose parent was cut
//!    is re-rooted with `parentUuid: null`.
//! 2. Never break tool_use ↔ tool_result pairing. Orphan tool results are
//!    replaced by a plain text block; the entry itself always survives.
//!
//! `thinking` / `redacted_thinking` blocks are never edited and base64 image
//! data is never truncated (a half image is a 400) — an oversized image block is
//! replaced wholesale by a marker.
//!
//! JSON at the boundary and inside the transcript is parsed with
//! [`crate::js::json_parse`] (the project's one `JSON.parse`) rather than
//! `json_lenient`, because this kernel re-serializes parsed lines back to disk:
//! `json_lenient` maps lone surrogate escapes to U+FFFD, which would silently
//! rewrite transcript bytes. `js::json_parse` keeps them, exactly like Node.

use crate::js::{
    coerce, json_parse, json_quote, json_stringify, number_to_string, utf16_len, JsString, JsValue,
};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const DEFAULT_MAX_BYTES: f64 = 2.0 * 1024.0 * 1024.0;
pub const DEFAULT_TARGET_TOKENS: f64 = 120_000.0;
pub const DEFAULT_HARD_MAX_TOKENS: f64 = 160_000.0;
pub const DEFAULT_KEEP_TURNS_LADDER: [f64; 5] = [20.0, 10.0, 5.0, 3.0, 2.0];
pub const DEFAULT_MAX_ENTRY_BYTES: f64 = 200.0 * 1024.0;
pub const DEFAULT_HARD_ENTRY_BYTES: f64 = 400.0 * 1024.0;
const PROTECT_TAIL_LINES: f64 = 24.0;
const ELIDE_CHARS: f64 = 8000.0;
const ELIDE_CHARS_TIGHT: f64 = 800.0;
const MIN_GAIN_BYTES: f64 = 64.0 * 1024.0;
const PRESERVED_SCAN_LINES: usize = 500;
pub const DEFAULT_SCAN_MIN_BYTES: f64 = 384.0 * 1024.0;
pub const DEFAULT_TOKEN_WATERMARK: f64 = 140_000.0;
const BYTES_PER_TOKEN: f64 = 4.0;
const MEASURE_PARSE_BUDGET: f64 = 128.0 * 1024.0 * 1024.0;
const FILLER_MAX_CHARS: f64 = 12.0;

const USER_TOOL_RESULT_SKIP_UNITS: f64 = 65_536.0;
const MAX_ELIDE_DEPTH: usize = 24;

/// Typed options for `pruneFile`. Values mirror the JS destructuring defaults:
/// an absent or `undefined` key takes the default, every other value is coerced
/// through JS `Number()` (or truthiness for the flags).
#[derive(Clone, Debug)]
pub struct Options {
    pub max_bytes: f64,
    pub target_tokens: f64,
    pub hard_max_tokens: f64,
    pub keep_turns_ladder: Vec<f64>,
    pub max_entry_bytes: f64,
    pub hard_entry_bytes: f64,
    pub scan_min_bytes: f64,
    pub min_gain_bytes: f64,
    pub force: bool,
    pub force_strict: bool,
    pub dry_run: bool,
    pub dry_run_strict: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_MAX_BYTES,
            target_tokens: DEFAULT_TARGET_TOKENS,
            hard_max_tokens: DEFAULT_HARD_MAX_TOKENS,
            keep_turns_ladder: DEFAULT_KEEP_TURNS_LADDER.to_vec(),
            max_entry_bytes: DEFAULT_MAX_ENTRY_BYTES,
            hard_entry_bytes: DEFAULT_HARD_ENTRY_BYTES,
            scan_min_bytes: DEFAULT_SCAN_MIN_BYTES,
            min_gain_bytes: MIN_GAIN_BYTES,
            force: false,
            force_strict: false,
            dry_run: false,
            dry_run_strict: false,
        }
    }
}

/// Typed options for `measureFile`.
#[derive(Clone, Debug)]
pub struct MeasureOptions {
    pub max_bytes: f64,
    pub target_tokens: f64,
    pub hard_max_tokens: f64,
    pub hard_entry_bytes: f64,
    pub scan_min_bytes: f64,
    pub token_watermark: f64,
    pub parse_budget: f64,
}

impl Default for MeasureOptions {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_MAX_BYTES,
            target_tokens: DEFAULT_TARGET_TOKENS,
            hard_max_tokens: DEFAULT_HARD_MAX_TOKENS,
            hard_entry_bytes: DEFAULT_HARD_ENTRY_BYTES,
            scan_min_bytes: DEFAULT_SCAN_MIN_BYTES,
            token_watermark: DEFAULT_TOKEN_WATERMARK,
            parse_budget: MEASURE_PARSE_BUDGET,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Report {
    pub file: String,
    pub strategy: String,
    pub triggers: Vec<&'static str>,
    pub before_bytes: f64,
    pub after_bytes: f64,
    pub after_tokens: f64,
    pub fits_target: bool,
    pub before_lines: usize,
    pub after_lines: usize,
    pub dropped_lines: usize,
    pub kept_summary: bool,
    pub real_user_turns: usize,
    pub substantive_turns: usize,
    pub dropped_turns: usize,
    pub lost_turns: usize,
    pub lost_substantive_turns: usize,
    pub compact_boundary: bool,
    pub elided_entries: usize,
    pub orphan_blocks: usize,
    pub rerooted_entries: usize,
    pub context_affected: bool,
    pub forced: bool,
    pub dry_run: bool,
}

#[derive(Clone, Debug, Default)]
pub struct CompactBoundary {
    pub present: bool,
    pub at_line: Option<f64>,
    pub summary_present: bool,
    pub dropped_by_compaction: usize,
}

#[derive(Clone, Debug)]
pub struct Thresholds {
    pub max_bytes: f64,
    pub hard_entry_bytes: f64,
    pub scan_min_bytes: f64,
    pub target_tokens: f64,
    pub hard_max_tokens: f64,
    pub token_watermark: f64,
}

#[derive(Clone, Debug)]
pub struct Level {
    pub found: bool,
    pub file_bytes: f64,
    pub lines: usize,
    pub live_bytes: f64,
    pub live_lines: usize,
    pub api_bytes: Option<f64>,
    pub estimated_tokens: Option<f64>,
    pub largest_entry_bytes: f64,
    pub real_user_turns: usize,
    pub live_turns: usize,
    pub substantive_turns: usize,
    pub compact_boundary: CompactBoundary,
    pub thresholds: Thresholds,
    pub triggers: Vec<&'static str>,
    pub would_prune: bool,
    pub over_watermark: bool,
    pub status: &'static str,
    pub modified_at: Option<String>,
}

impl Level {
    fn missing() -> Self {
        Self {
            found: false,
            file_bytes: 0.0,
            lines: 0,
            live_bytes: 0.0,
            live_lines: 0,
            api_bytes: None,
            estimated_tokens: None,
            largest_entry_bytes: 0.0,
            real_user_turns: 0,
            live_turns: 0,
            substantive_turns: 0,
            compact_boundary: CompactBoundary::default(),
            thresholds: Thresholds {
                max_bytes: DEFAULT_MAX_BYTES,
                hard_entry_bytes: DEFAULT_HARD_ENTRY_BYTES,
                scan_min_bytes: DEFAULT_SCAN_MIN_BYTES,
                target_tokens: DEFAULT_TARGET_TOKENS,
                hard_max_tokens: DEFAULT_HARD_MAX_TOKENS,
                token_watermark: DEFAULT_TOKEN_WATERMARK,
            },
            triggers: Vec::new(),
            would_prune: false,
            over_watermark: false,
            status: "ok",
            modified_at: None,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Cut {
    pub cut: usize,
    pub boundary_idx: i64,
    pub summary_idx: i64,
}

fn number(value: Option<&JsValue>, default: f64) -> f64 {
    match value {
        None | Some(JsValue::Undefined) => default,
        Some(value) => coerce::js_to_number(value),
    }
}

fn flag(value: Option<&JsValue>) -> bool {
    value.is_some_and(coerce::truthy)
}

fn strict_true(value: Option<&JsValue>) -> bool {
    matches!(value, Some(JsValue::Bool(true)))
}

impl Options {
    /// Read the `pruneFile` options object. As in the JS destructuring defaults,
    /// `undefined` (or a primitive, which boxes to no own keys) takes every
    /// default, while `null` throws.
    pub fn from_js(value: Option<&JsValue>) -> Result<Self, String> {
        let mut options = Options::default();
        let object = match value {
            None | Some(JsValue::Undefined) => return Ok(options),
            Some(JsValue::Null) => return Err("transcript_prune_invalid_options: null".to_string()),
            Some(JsValue::Object(entries)) => entries,
            Some(_) => return Ok(options),
        };
        let get = |name: &str| {
            object
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value)
        };
        options.max_bytes = number(get("maxBytes"), options.max_bytes);
        options.target_tokens = number(get("targetTokens"), options.target_tokens);
        options.hard_max_tokens = number(get("hardMaxTokens"), options.hard_max_tokens);
        options.max_entry_bytes = number(get("maxEntryBytes"), options.max_entry_bytes);
        options.hard_entry_bytes = number(get("hardEntryBytes"), options.hard_entry_bytes);
        options.scan_min_bytes = number(get("scanMinBytes"), options.scan_min_bytes);
        options.min_gain_bytes = number(get("minGainBytes"), options.min_gain_bytes);
        match get("keepTurnsLadder") {
            None | Some(JsValue::Undefined) => {}
            Some(JsValue::Array(items)) => {
                options.keep_turns_ladder =
                    items.iter().map(coerce::js_to_number).collect::<Vec<_>>();
            }
            Some(value @ JsValue::String(_)) => {
                // `for...of` iterates a string by code point; each element is then
                // coerced by the `keep >= pool.length` comparison.
                options.keep_turns_ladder = coerce::js_to_string(value)
                    .to_string_lossy()
                    .chars()
                    .map(|character| {
                        coerce::js_to_number(&JsValue::String(JsString::from_rust_str(
                            &character.to_string(),
                        )))
                    })
                    .collect();
            }
            Some(_) => return Err("transcript_prune_invalid_options: keepTurnsLadder".to_string()),
        }
        options.force = flag(get("force"));
        options.force_strict = strict_true(get("force"));
        options.dry_run = flag(get("dryRun"));
        options.dry_run_strict = strict_true(get("dryRun"));
        Ok(options)
    }
}

impl MeasureOptions {
    pub fn from_js(value: Option<&JsValue>) -> Result<Self, String> {
        let mut options = MeasureOptions::default();
        let object = match value {
            None | Some(JsValue::Undefined) => return Ok(options),
            Some(JsValue::Null) => return Err("transcript_prune_invalid_options: null".to_string()),
            Some(JsValue::Object(entries)) => entries,
            Some(_) => return Ok(options),
        };
        let get = |name: &str| {
            object
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value)
        };
        options.max_bytes = number(get("maxBytes"), options.max_bytes);
        options.target_tokens = number(get("targetTokens"), options.target_tokens);
        options.hard_max_tokens = number(get("hardMaxTokens"), options.hard_max_tokens);
        options.hard_entry_bytes = number(get("hardEntryBytes"), options.hard_entry_bytes);
        options.scan_min_bytes = number(get("scanMinBytes"), options.scan_min_bytes);
        options.token_watermark = number(get("tokenWatermark"), options.token_watermark);
        options.parse_budget = number(get("parseBudget"), options.parse_budget);
        Ok(options)
    }
}

// ── predicates ───────────────────────────────────────────────────────────────

fn object_like(value: &JsValue) -> bool {
    matches!(value, JsValue::Object(_) | JsValue::Array(_))
}

fn type_is(value: &JsValue, name: &str) -> bool {
    matches!(value.get("type"), Some(JsValue::String(kind)) if kind == name)
}

fn property_is_true(value: &JsValue, name: &str) -> bool {
    matches!(value.get(name), Some(JsValue::Bool(true)))
}

/// `{ ...value }` as own enumerable keys. Arrays spread into index keys and a
/// string into one key per code unit, exactly like the object spread.
fn spread(value: &JsValue) -> Vec<(JsString, JsValue)> {
    match value {
        JsValue::Object(entries) => entries.clone(),
        JsValue::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| (JsString::from_rust_str(&index.to_string()), item.clone()))
            .collect(),
        JsValue::String(text) => text
            .as_units()
            .iter()
            .enumerate()
            .map(|(index, unit)| {
                (
                    JsString::from_rust_str(&index.to_string()),
                    JsValue::String(JsString::from_units(vec![*unit])),
                )
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn set_entry(entries: &mut Vec<(JsString, JsValue)>, key: &str, value: JsValue) {
    if let Some(slot) = entries.iter_mut().find(|(name, _)| name == key) {
        slot.1 = value;
    } else {
        entries.push((JsString::from_rust_str(key), value));
    }
}

fn undef(value: Option<&JsValue>) -> JsValue {
    value.cloned().unwrap_or(JsValue::Undefined)
}

pub fn is_real_user_turn(obj: &JsValue) -> bool {
    if !coerce::truthy(obj) || !object_like(obj) {
        return false;
    }
    if property_is_true(obj, "isSidechain")
        || property_is_true(obj, "isMeta")
        || property_is_true(obj, "isCompactSummary")
    {
        return false;
    }
    let message = obj.get("message").filter(|value| coerce::truthy(value));
    let role_is_user = matches!(
        message.and_then(|message| message.get("role")),
        Some(JsValue::String(role)) if role == "user"
    );
    if !type_is(obj, "user") && !role_is_user {
        return false;
    }
    let Some(content) = message.and_then(|message| message.get("content")) else {
        return false;
    };
    match content {
        JsValue::String(text) => !text.trim().is_empty(),
        JsValue::Array(items) => {
            if items.iter().any(|block| {
                coerce::truthy(block) && object_like(block) && type_is(block, "tool_result")
            }) {
                return false;
            }
            items.iter().any(|block| {
                coerce::truthy(block)
                    && object_like(block)
                    && (type_is(block, "text") || type_is(block, "image"))
            })
        }
        _ => false,
    }
}

// `[... end]` / `[...结束]` lines close each multicc prompt layer. The user's
// own text is whatever follows the last one. This is
// `/^\[[^\]\n]{0,64}(?:end|结束)\]$/gm`: `^`/`$` are multiline anchors over all
// four JS line terminators, and the middle class excludes only `]` and `\n`.
fn harness_end(text: &JsString) -> Option<usize> {
    let units = text.as_units();
    let mut starts = vec![0usize];
    for (index, unit) in units.iter().enumerate() {
        if matches!(*unit, 0x0A | 0x0D | 0x2028 | 0x2029) {
            starts.push(index + 1);
        }
    }
    let mut last_end = None;
    for start in starts {
        if start >= units.len() || units[start] != u16::from(b'[') {
            continue;
        }
        // A match is at most `[` + 64 middle units + `end]`, so only that window
        // can contain an end position. Try the furthest end first: the greedy
        // quantifier backtracks from there.
        let limit = units.len().min(start + 69);
        for end in (start + 1..=limit).rev() {
            let at_line_end = end == units.len() || is_line_terminator(units[end]);
            if !at_line_end {
                continue;
            }
            if harness_line_matches(&units[start..end]) {
                last_end = Some(end);
                break;
            }
        }
    }
    last_end
}

fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0A | 0x0D | 0x2028 | 0x2029)
}

fn harness_line_matches(line: &[u16]) -> bool {
    if line.len() < 2 || line[0] != u16::from(b'[') {
        return false;
    }
    let body = &line[1..];
    let middle = if body.ends_with(&[b'e' as u16, b'n' as u16, b'd' as u16, b']' as u16]) {
        &body[..body.len() - 4]
    } else if body.ends_with(&[0x7ED3_u16, 0x675F, 0x5D]) {
        &body[..body.len() - 3]
    } else {
        return false;
    };
    middle.len() <= 64 && !middle.iter().any(|unit| matches!(*unit, 0x5D | 0x0A))
}

fn find_units(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn strip_system_reminders(text: &JsString) -> JsString {
    let units = text.as_units();
    let start: Vec<u16> = "<system-reminder>".encode_utf16().collect();
    let close: Vec<u16> = "</system-reminder>".encode_utf16().collect();
    let mut out = Vec::with_capacity(units.len());
    let mut at = 0usize;
    while at < units.len() {
        let Some(relative) = find_units(&units[at..], &start) else {
            out.extend_from_slice(&units[at..]);
            break;
        };
        let begin = at + relative;
        out.extend_from_slice(&units[at..begin]);
        let after_open = begin + start.len();
        let Some(relative_close) = find_units(&units[after_open..], &close) else {
            // No closing tag after this start means no later start can match
            // either, so the remaining text is plain output.
            out.extend_from_slice(&units[begin..]);
            break;
        };
        at = after_open + relative_close + close.len();
    }
    JsString::from_units(out)
}

pub fn user_visible_text(value: &JsValue) -> JsString {
    let JsValue::String(input) = value else {
        return JsString::new();
    };
    if input.is_empty() {
        return JsString::new();
    }
    let mut text = strip_system_reminders(input);
    if let Some(end) = harness_end(&text) {
        if end > 0 {
            let tail = JsString::from_units(text.as_units()[end..].to_vec());
            if !tail.trim().is_empty() {
                text = tail;
            }
        }
    }
    let directive: Vec<u16> = "\n[Dispatch]".encode_utf16().collect();
    if let Some(position) = find_units(text.as_units(), &directive) {
        text = JsString::from_units(text.as_units()[..position].to_vec());
    }
    text.trim()
}

pub fn is_substantive_turn(obj: &JsValue) -> bool {
    if !is_real_user_turn(obj) {
        return false;
    }
    let Some(content) = obj
        .get("message")
        .and_then(|message| message.get("content"))
    else {
        return false;
    };
    match content {
        JsValue::String(text) => {
            (user_visible_text(&JsValue::String(text.clone())).len() as f64) > FILLER_MAX_CHARS
        }
        JsValue::Array(items) => {
            let mut chars = 0usize;
            for block in items {
                if !coerce::truthy(block) || !object_like(block) {
                    continue;
                }
                if type_is(block, "image") {
                    return true;
                }
                if type_is(block, "text") {
                    chars += user_visible_text(&undef(block.get("text"))).len();
                }
            }
            (chars as f64) > FILLER_MAX_CHARS
        }
        _ => false,
    }
}

// ── elision ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
struct Stats {
    strings: usize,
    images: usize,
}

fn elide_marker(kind: &str, chars: f64) -> JsString {
    JsString::from_rust_str(&format!(
        "\n\n[multicc pruned {} chars of {} to keep this session inside the model context window]",
        number_to_string(chars),
        kind
    ))
}

fn truncate_string(value: &JsValue, max_chars: f64, stats: &mut Stats) -> JsValue {
    let JsValue::String(text) = value else {
        return value.clone();
    };
    if (text.len() as f64) <= max_chars {
        return value.clone();
    }
    let room = max_chars - 160.0;
    let keep = if room.is_nan() || room <= 0.0 {
        0
    } else {
        room.trunc() as usize
    };
    let head = text.truncate_units(keep);
    stats.strings += 1;
    let mut out = head;
    out.push(&elide_marker(
        "older output",
        (text.len() - out.len()) as f64,
    ));
    JsValue::String(out)
}

fn elide_deep(value: &JsValue, max_chars: f64, stats: &mut Stats, depth: usize) -> JsValue {
    if depth > MAX_ELIDE_DEPTH {
        return value.clone();
    }
    match value {
        JsValue::String(_) => truncate_string(value, max_chars, stats),
        JsValue::Array(items) => JsValue::Array(
            items
                .iter()
                .map(|item| elide_deep(item, max_chars, stats, depth + 1))
                .collect(),
        ),
        JsValue::Object(entries) => JsValue::Object(
            entries
                .iter()
                .map(|(key, item)| {
                    if key == "signature" || key == "thinking" {
                        (key.clone(), item.clone())
                    } else {
                        (key.clone(), elide_deep(item, max_chars, stats, depth + 1))
                    }
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn image_bytes(block: &JsValue) -> f64 {
    let Some(source) = block.get("source").filter(|value| coerce::truthy(value)) else {
        return 0.0;
    };
    match source.get("data") {
        Some(JsValue::String(data)) => data.len() as f64,
        _ => 0.0,
    }
}

fn elide_content_block(block: &JsValue, max_chars: f64, stats: &mut Stats) -> JsValue {
    if !coerce::truthy(block) || !object_like(block) {
        return block.clone();
    }
    if type_is(block, "thinking") || type_is(block, "redacted_thinking") {
        return block.clone();
    }
    if type_is(block, "image") {
        let bytes = image_bytes(block);
        if bytes <= max_chars {
            return block.clone();
        }
        stats.images += 1;
        return JsValue::object(vec![
            ("type", JsValue::string("text")),
            (
                "text",
                JsValue::String(elide_marker("an inline image", bytes).trim()),
            ),
        ]);
    }
    if type_is(block, "text") {
        let mut entries = spread(block);
        let text = truncate_string(&undef(block.get("text")), max_chars, stats);
        set_entry(&mut entries, "text", text);
        return JsValue::Object(entries);
    }
    if type_is(block, "tool_result") {
        let mut entries = spread(block);
        match block.get("content") {
            Some(JsValue::String(_)) => {
                let content = truncate_string(&undef(block.get("content")), max_chars, stats);
                set_entry(&mut entries, "content", content);
            }
            Some(JsValue::Array(items)) => {
                let blocks = items
                    .iter()
                    .map(|item| elide_content_block(item, max_chars, stats))
                    .collect::<Vec<_>>();
                let content = if blocks.is_empty() {
                    JsValue::Array(vec![JsValue::object(vec![
                        ("type", JsValue::string("text")),
                        (
                            "text",
                            JsValue::String(elide_marker("tool output", 0.0).trim()),
                        ),
                    ])])
                } else {
                    JsValue::Array(blocks)
                };
                set_entry(&mut entries, "content", content);
            }
            _ => {}
        }
        return JsValue::Object(entries);
    }
    if type_is(block, "tool_use") {
        let mut entries = spread(block);
        let input = elide_deep(&undef(block.get("input")), max_chars, stats, 0);
        set_entry(&mut entries, "input", input);
        return JsValue::Object(entries);
    }
    block.clone()
}

fn elide_entry(obj: &JsValue, max_chars: f64) -> (JsValue, Stats) {
    let mut stats = Stats::default();
    if !type_is(obj, "user") && !type_is(obj, "assistant") {
        return (elide_deep(obj, max_chars, &mut stats, 0), stats);
    }
    let mut next = spread(obj);
    if let Some(message) = obj.get("message").filter(|value| coerce::truthy(value)) {
        if object_like(message) {
            let mut fields = spread(message);
            match message.get("content") {
                Some(JsValue::String(_)) => {
                    let content =
                        truncate_string(&undef(message.get("content")), max_chars, &mut stats);
                    set_entry(&mut fields, "content", content);
                }
                Some(JsValue::Array(items)) => {
                    let content = JsValue::Array(
                        items
                            .iter()
                            .map(|block| elide_content_block(block, max_chars, &mut stats))
                            .collect(),
                    );
                    set_entry(&mut fields, "content", content);
                }
                _ => {}
            }
            set_entry(&mut next, "message", JsValue::Object(fields));
        }
    }
    if let Some(result) = obj.get("toolUseResult") {
        let elided = elide_deep(result, max_chars, &mut stats, 0);
        set_entry(&mut next, "toolUseResult", elided);
    }
    (JsValue::Object(next), stats)
}

fn collect_pair_ids(obj: &JsValue) -> (Vec<JsString>, Vec<JsString>) {
    let mut uses = Vec::new();
    let mut results = Vec::new();
    let content = obj
        .get("message")
        .filter(|value| coerce::truthy(value))
        .and_then(|message| message.get("content"));
    let Some(JsValue::Array(items)) = content else {
        return (uses, results);
    };
    for block in items {
        if !coerce::truthy(block) || !object_like(block) {
            continue;
        }
        if type_is(block, "tool_use") {
            if let Some(id) = block.get("id").filter(|value| coerce::truthy(value)) {
                uses.push(coerce::js_to_string(id));
            }
        }
        if type_is(block, "tool_result") {
            if let Some(id) = block
                .get("tool_use_id")
                .filter(|value| coerce::truthy(value))
            {
                results.push(coerce::js_to_string(id));
            }
        }
    }
    (uses, results)
}

// ── line parsing helpers ─────────────────────────────────────────────────────

/// `parseLine`: `JSON.parse` where a failure and any falsy result collapse to
/// `None`, which is what every caller's truthiness check does.
fn parse_truthy(text: &str) -> Option<JsValue> {
    json_parse(text).ok().filter(coerce::truthy)
}

/// Extract the first `"<name>":"..."` value preceded by the start of the string,
/// `{` or `,` — the exact contract of the old single-regex probes.
fn extract_field(text: &str, name: &str) -> Option<String> {
    let needle = format!("\"{name}\":\"");
    let bytes = text.as_bytes();
    let mut from = 0usize;
    while let Some(relative) = text[from..].find(&needle) {
        let at = from + relative;
        let preceded = at == 0 || matches!(bytes.get(at - 1), Some(b'{') | Some(b','));
        if preceded {
            let rest = &text[at + needle.len()..];
            if let Some(end) = rest.find('"') {
                if end > 0 {
                    return Some(rest[..end].to_string());
                }
            }
        }
        from = at + 1;
    }
    None
}

fn extract_uuid(line: &str) -> Option<String> {
    extract_field(line, "uuid")
}

fn extract_parent(line: &str) -> Option<String> {
    extract_field(line, "parentUuid")
}

fn stringify(value: &JsValue) -> String {
    json_stringify(value).unwrap_or_else(|| "null".to_string())
}

fn bytes_of(text: &str) -> f64 {
    text.len() as f64
}

fn line_units(text: &str) -> usize {
    utf16_len(text)
}

// ── compaction cut ───────────────────────────────────────────────────────────

fn collect_preserved(boundary: &JsValue) -> HashSet<String> {
    let mut out = HashSet::new();
    let Some(meta) = boundary
        .get("compactMetadata")
        .filter(|value| coerce::truthy(value) && object_like(value))
    else {
        return out;
    };
    {
        let mut add = |value: Option<&JsValue>| {
            if let Some(JsValue::String(text)) = value {
                if !text.is_empty() {
                    out.insert(text.to_string_lossy());
                }
            }
        };
        if let Some(segment) = meta.get("preservedSegment") {
            add(segment.get("headUuid"));
            add(segment.get("anchorUuid"));
            add(segment.get("tailUuid"));
        }
        if let Some(messages) = meta.get("preservedMessages") {
            add(messages.get("anchorUuid"));
            for key in ["uuids", "allUuids"] {
                if let Some(JsValue::Array(items)) = messages.get(key) {
                    for item in items {
                        add(Some(item));
                    }
                }
            }
        }
    }
    out
}

pub fn compact_cut_index(lines: &[String]) -> Cut {
    let mut boundary_idx: i64 = -1;
    let mut preserved: Option<HashSet<String>> = None;
    for index in (0..lines.len()).rev() {
        if !lines[index].contains("compact_boundary") {
            continue;
        }
        let Some(obj) = parse_truthy(&lines[index]) else {
            continue;
        };
        if !matches!(obj.get("subtype"), Some(JsValue::String(subtype)) if subtype == "compact_boundary")
        {
            continue;
        }
        boundary_idx = index as i64;
        preserved = Some(collect_preserved(&obj));
        break;
    }
    if boundary_idx <= 0 {
        return Cut {
            cut: 0,
            boundary_idx: -1,
            summary_idx: -1,
        };
    }
    let boundary = boundary_idx as usize;
    let mut cut = boundary;
    if let Some(preserved) = preserved.filter(|set| !set.is_empty()) {
        let from = boundary.saturating_sub(PRESERVED_SCAN_LINES);
        for index in (from..boundary).rev() {
            if let Some(uuid) = extract_uuid(&lines[index]) {
                if preserved.contains(&uuid) && index < cut {
                    cut = index;
                }
            }
        }
    }
    let mut summary_idx: i64 = -1;
    let scan_end = lines.len().min(boundary + 6);
    for (index, line) in lines.iter().enumerate().take(scan_end).skip(boundary + 1) {
        if !line.contains("isCompactSummary") {
            continue;
        }
        let Some(obj) = parse_truthy(line) else {
            continue;
        };
        if matches!(obj.get("isCompactSummary"), Some(JsValue::Bool(true))) {
            summary_idx = index as i64;
            break;
        }
    }
    Cut {
        cut,
        boundary_idx,
        summary_idx,
    }
}

fn live_extent(lines: &[String], units: &[usize], cut: usize) -> (f64, f64) {
    let mut live_bytes = 0f64;
    let mut largest_entry_bytes = 0f64;
    for index in cut..lines.len() {
        live_bytes += bytes_of(&lines[index]) + 1.0;
        if (units[index] as f64) > largest_entry_bytes {
            largest_entry_bytes = units[index] as f64;
        }
    }
    (live_bytes, largest_entry_bytes)
}

struct MeasureThresholds {
    max_bytes: f64,
    hard_entry_bytes: f64,
    scan_min_bytes: f64,
}

fn triggers_for(
    file_bytes: f64,
    largest_entry_bytes: f64,
    options: &MeasureThresholds,
) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if file_bytes > options.max_bytes {
        reasons.push("file-bytes");
    }
    if file_bytes > options.scan_min_bytes && largest_entry_bytes >= options.hard_entry_bytes {
        reasons.push("oversized-entry");
    }
    reasons
}

fn api_bytes_of_line(text: &str) -> f64 {
    let Some(obj) = parse_truthy(text) else {
        return bytes_of(text);
    };
    if let Some(message) = obj.get("message").filter(|value| coerce::truthy(value)) {
        return bytes_of(&stringify(message));
    }
    bytes_of(text).min(4096.0)
}

fn live_api_bytes(lines: &[String], cut: usize, live_bytes: f64, parse_budget: f64) -> Option<f64> {
    if live_bytes > parse_budget {
        return None;
    }
    let mut api_bytes = 0f64;
    for line in &lines[cut..] {
        api_bytes += api_bytes_of_line(line);
    }
    Some(api_bytes)
}

fn round_half_up(value: f64) -> f64 {
    // JS Math.round: ties go towards +Infinity. All inputs here are non-negative.
    (value + 0.5).floor()
}

// ── analyzer / candidate ────────────────────────────────────────────────────

struct Memo {
    text: String,
    bytes: f64,
    elided: bool,
    uses: Vec<JsString>,
    results: Vec<JsString>,
    uuid: Option<String>,
}

struct Analyzer<'a> {
    lines: &'a [String],
    units: &'a [usize],
    max_entry_bytes: f64,
    hard_entry_bytes: f64,
    elide_chars: f64,
    protect_from: i64,
    memo: HashMap<usize, Memo>,
}

impl<'a> Analyzer<'a> {
    fn new(
        lines: &'a [String],
        units: &'a [usize],
        max_entry_bytes: f64,
        hard_entry_bytes: f64,
        elide_chars: f64,
        protect_from: i64,
    ) -> Self {
        Self {
            lines,
            units,
            max_entry_bytes,
            hard_entry_bytes,
            elide_chars,
            protect_from,
            memo: HashMap::new(),
        }
    }

    fn analyze(&mut self, index: usize) -> &Memo {
        if !self.memo.contains_key(&index) {
            let memo = self.compute(index);
            self.memo.insert(index, memo);
        }
        &self.memo[&index]
    }

    fn compute(&self, index: usize) -> Memo {
        let raw = &self.lines[index];
        let units = self.units[index] as f64;
        let oversized = units > self.hard_entry_bytes
            || (units > self.max_entry_bytes
                && (self.protect_from < 0 || (index as i64) < self.protect_from));
        let may_pair = raw.contains("tool_use") || raw.contains("tool_result");
        let mut text = raw.clone();
        let mut elided = false;
        let mut uses = Vec::new();
        let mut results = Vec::new();
        if oversized || may_pair {
            if let Some(obj) = parse_truthy(raw) {
                let mut effective = obj.clone();
                if oversized {
                    let (candidate, stats) = elide_entry(&obj, self.elide_chars);
                    if stats.strings > 0 || stats.images > 0 {
                        effective = candidate.clone();
                        text = stringify(&candidate);
                        elided = true;
                    }
                }
                if may_pair {
                    let (found_uses, found_results) = collect_pair_ids(&effective);
                    uses = found_uses;
                    results = found_results;
                }
            }
        }
        Memo {
            bytes: bytes_of(&text) + 1.0,
            text,
            elided,
            uses,
            results,
            uuid: extract_uuid(raw),
        }
    }
}

struct Splice {
    at: usize,
    parent_uuid: JsValue,
}

struct Candidate {
    texts: Vec<String>,
    bytes: f64,
    elided_entries: usize,
    orphan_blocks: usize,
    rerooted: usize,
    tokens: Option<f64>,
}

fn neutralise_orphans(text: &str, orphan_ids: &HashSet<JsString>) -> String {
    let Some(obj) = parse_truthy(text) else {
        return text.to_string();
    };
    let Some(message) = obj.get("message").filter(|value| coerce::truthy(value)) else {
        return text.to_string();
    };
    let Some(JsValue::Array(items)) = message.get("content") else {
        return text.to_string();
    };
    let content = items
        .iter()
        .map(|block| {
            if coerce::truthy(block) && object_like(block) && type_is(block, "tool_result") {
                // `String(b.tool_use_id)` — a missing property stringifies to
                // "undefined", which is exactly what the legacy set lookup did.
                let id = coerce::js_to_string(&undef(block.get("tool_use_id")));
                if orphan_ids.contains(&id) {
                    return JsValue::object(vec![
                        ("type", JsValue::string("text")),
                        (
                            "text",
                            JsValue::string(
                                "[multicc: tool result dropped with its call during context pruning]",
                            ),
                        ),
                    ]);
                }
            }
            block.clone()
        })
        .collect::<Vec<_>>();
    let mut fields = spread(message);
    set_entry(&mut fields, "content", JsValue::Array(content));
    let mut outer = spread(&obj);
    set_entry(&mut outer, "message", JsValue::Object(fields));
    stringify(&JsValue::Object(outer))
}

fn set_parent(text: &str, parent_uuid: &JsValue) -> String {
    let Some(obj) = parse_truthy(text) else {
        return text.to_string();
    };
    match obj.get("parentUuid") {
        None | Some(JsValue::Undefined) => return text.to_string(),
        Some(current) if current == parent_uuid => return text.to_string(),
        _ => {}
    }
    let mut entries = spread(&obj);
    set_entry(&mut entries, "parentUuid", parent_uuid.clone());
    stringify(&JsValue::Object(entries))
}

fn build_candidate(
    indices: &[usize],
    analyzer: &mut Analyzer<'_>,
    splice: Option<&Splice>,
) -> Candidate {
    let mut kept_uuids: HashSet<String> = HashSet::new();
    for index in indices {
        if let Some(uuid) = &analyzer.analyze(*index).uuid {
            kept_uuids.insert(uuid.clone());
        }
    }
    let head_cut = indices.is_empty() || indices[0] != 0;
    let mut texts = Vec::with_capacity(indices.len());
    let mut seen_uses: HashSet<JsString> = HashSet::new();
    let mut bytes = 0f64;
    let mut elided_entries = 0usize;
    let mut orphan_blocks = 0usize;
    let mut rerooted = 0usize;
    for (position, index) in indices.iter().enumerate() {
        let memo = analyzer.analyze(*index);
        let mut text = memo.text.clone();
        let mut bytes_of_entry = memo.bytes;
        let mut rewritten = false;
        if !memo.results.is_empty() {
            let orphans = memo
                .results
                .iter()
                .filter(|id| !seen_uses.contains(*id))
                .cloned()
                .collect::<HashSet<_>>();
            if !orphans.is_empty() {
                text = neutralise_orphans(&text, &orphans);
                orphan_blocks += orphans.len();
                rewritten = true;
            }
        }
        for id in &memo.uses {
            seen_uses.insert(id.clone());
        }
        let elided = memo.elided;
        if let Some(splice) = splice.filter(|splice| position == splice.at) {
            text = set_parent(&text, &splice.parent_uuid);
            rewritten = true;
        } else if head_cut {
            if let Some(parent) = extract_parent(&text) {
                if !kept_uuids.contains(&parent) {
                    text = set_parent(&text, &JsValue::Null);
                    rerooted += 1;
                    rewritten = true;
                }
            }
        }
        if rewritten {
            bytes_of_entry = bytes_of(&text) + 1.0;
        }
        if elided {
            elided_entries += 1;
        }
        texts.push(text);
        bytes += bytes_of_entry;
    }
    Candidate {
        texts,
        bytes,
        elided_entries,
        orphan_blocks,
        rerooted,
        tokens: None,
    }
}

fn candidate_tokens(candidate: &mut Candidate) -> f64 {
    if let Some(tokens) = candidate.tokens {
        return tokens;
    }
    let mut bytes = 0f64;
    for text in &candidate.texts {
        bytes += api_bytes_of_line(text);
    }
    let tokens = round_half_up(bytes / BYTES_PER_TOKEN);
    candidate.tokens = Some(tokens);
    tokens
}

fn indices_for(
    lines: &[String],
    compact_cut: usize,
    summary_idx: i64,
    cut: Option<usize>,
) -> (Vec<usize>, Option<Splice>) {
    let Some(cut) = cut else {
        // `indicesFor(undefined)`: NaN fails every comparison, so no row is kept.
        return (Vec::new(), None);
    };
    if summary_idx >= 0 && cut > summary_idx as usize {
        let summary = summary_idx as usize;
        let mut indices = (compact_cut..=summary).collect::<Vec<_>>();
        let prologue = indices.len();
        indices.extend(cut..lines.len());
        let parent_uuid = extract_uuid(&lines[summary])
            .map(|uuid| JsValue::string(&uuid))
            .unwrap_or(JsValue::Null);
        return (
            indices,
            Some(Splice {
                at: prologue,
                parent_uuid,
            }),
        );
    }
    ((cut..lines.len()).collect(), None)
}

fn split_lines(text: &str) -> Vec<String> {
    let mut lines = text.split('\n').map(str::to_string).collect::<Vec<_>>();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines
}

fn read_text(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn sidecar_path(file: &str) -> String {
    if let Some(stem) = file.strip_suffix(".jsonl") {
        format!("{stem}.pruned.jsonl")
    } else {
        file.to_string()
    }
}

fn append_ignoring_errors(path: &str, text: &str) {
    let result = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(text.as_bytes()));
    let _ = result;
}

pub fn prune_file(file: Option<&str>, options: &Options) -> Result<Option<Report>, String> {
    let Some(file) = file.filter(|file| !file.is_empty()) else {
        return Ok(None);
    };
    let path = Path::new(file);
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(None);
    };
    let file_bytes = metadata.len() as f64;
    if file_bytes <= options.min_gain_bytes {
        return Ok(None);
    }
    if !options.force && file_bytes <= coerce::math_min(options.max_bytes, options.scan_min_bytes) {
        return Ok(None);
    }
    let Some(raw) = read_text(path) else {
        return Ok(None);
    };
    let lines = split_lines(&raw);
    if lines.is_empty() {
        return Ok(None);
    }
    let units = lines
        .iter()
        .map(|line| line_units(line))
        .collect::<Vec<_>>();
    let cut = compact_cut_index(&lines);
    let compact_cut = cut.cut;
    let boundary_idx = cut.boundary_idx;
    let summary_idx = cut.summary_idx;
    let triggers = if options.force {
        vec!["forced"]
    } else {
        let (_, largest) = live_extent(&lines, &units, compact_cut);
        let reasons = triggers_for(
            file_bytes,
            largest,
            &MeasureThresholds {
                max_bytes: options.max_bytes,
                hard_entry_bytes: options.hard_entry_bytes,
                scan_min_bytes: options.scan_min_bytes,
            },
        );
        if reasons.is_empty() {
            return Ok(None);
        }
        reasons
    };

    let mut starts = Vec::new();
    let mut substantive_starts = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if !line.contains("\"user\"") {
            continue;
        }
        if (units[index] as f64) > USER_TOOL_RESULT_SKIP_UNITS && line.contains("\"tool_result\"") {
            continue;
        }
        let Some(obj) = parse_truthy(line) else {
            continue;
        };
        if !is_real_user_turn(&obj) {
            continue;
        }
        starts.push(index);
        if is_substantive_turn(&obj) {
            substantive_starts.push(index);
        }
    }
    let protect_from = (starts.last().copied().unwrap_or(0) as f64)
        .max(lines.len() as f64 - PROTECT_TAIL_LINES) as i64;

    let mut best: Option<(Option<usize>, Candidate)> = None;
    let mut strategy: Option<String> = None;
    let levels = [
        (options.max_entry_bytes, ELIDE_CHARS, protect_from, "elide"),
        (
            coerce::math_min(options.max_entry_bytes, 64.0 * 1024.0),
            4000.0,
            protect_from,
            "elide-hard",
        ),
        (
            coerce::math_min(options.max_entry_bytes, 24.0 * 1024.0),
            ELIDE_CHARS_TIGHT,
            protect_from,
            "elide-max",
        ),
        (
            coerce::math_min(options.max_entry_bytes, 24.0 * 1024.0),
            ELIDE_CHARS_TIGHT,
            -1,
            "elide-max-unprotected",
        ),
    ];
    let mut analyzer_holder: Option<Analyzer<'_>> = None;
    for (max_entry, elide_chars, protect, name) in levels {
        let mut analyzer = Analyzer::new(
            &lines,
            &units,
            max_entry,
            options.hard_entry_bytes,
            elide_chars,
            protect,
        );
        let (indices, splice) = indices_for(&lines, compact_cut, summary_idx, Some(compact_cut));
        let mut base = build_candidate(&indices, &mut analyzer, splice.as_ref());
        let tokens = candidate_tokens(&mut base);
        let label = if compact_cut > 0 {
            format!("compact-cut+{name}")
        } else {
            name.to_string()
        };
        let better = best
            .as_ref()
            .is_none_or(|(_, current)| tokens < current.tokens.unwrap_or(f64::INFINITY));
        if better {
            best = Some((Some(compact_cut), base));
            strategy = Some(label);
        }
        analyzer_holder = Some(analyzer);
        if tokens <= options.hard_max_tokens {
            break;
        }
    }
    let mut analyzer = analyzer_holder.expect("at least one elision level");

    let best_tokens = best
        .as_ref()
        .and_then(|(_, candidate)| candidate.tokens)
        .unwrap_or(f64::INFINITY);
    if best_tokens > options.hard_max_tokens {
        for keep in &options.keep_turns_ladder {
            let pool = if (substantive_starts.len() as f64) >= *keep {
                &substantive_starts
            } else {
                &starts
            };
            if *keep >= pool.len() as f64 {
                continue;
            }
            // `pool[pool.length - keep]`: only a canonical array index resolves;
            // anything else (a fraction, NaN, out of range) is `undefined`, which
            // the legacy loop then treated as "keep no rows at all".
            let position = pool.len() as f64 - *keep;
            let cut_at = if position.is_finite() && position >= 0.0 && position.fract() == 0.0 {
                pool.get(position as usize).copied()
            } else {
                None
            };
            if let Some(cut_at) = cut_at {
                if cut_at <= compact_cut {
                    continue;
                }
            }
            let (indices, splice) = indices_for(&lines, compact_cut, summary_idx, cut_at);
            let mut candidate = build_candidate(&indices, &mut analyzer, splice.as_ref());
            let tokens = candidate_tokens(&mut candidate);
            let better = best
                .as_ref()
                .is_none_or(|(_, current)| tokens < current.tokens.unwrap_or(f64::INFINITY));
            if better {
                best = Some((cut_at, candidate));
                strategy = Some(format!("keep-{}-turns", number_to_string(*keep)));
            }
            if tokens <= options.target_tokens {
                break;
            }
        }
    }

    let Some((best_cut, best_candidate)) = best else {
        return Ok(None);
    };
    if best_candidate.bytes >= file_bytes - options.min_gain_bytes {
        return Ok(None);
    }
    let (kept_indices, _) = indices_for(&lines, compact_cut, summary_idx, best_cut);
    let kept = kept_indices.into_iter().collect::<HashSet<_>>();
    let removed = (0..lines.len())
        .filter(|index| !kept.contains(index))
        .collect::<Vec<_>>();
    let dropped_turns = starts.iter().filter(|index| !kept.contains(index)).count();
    let lost_turns = starts
        .iter()
        .filter(|index| **index >= compact_cut && !kept.contains(index))
        .count();
    let lost_substantive_turns = substantive_starts
        .iter()
        .filter(|index| **index >= compact_cut && !kept.contains(index))
        .count();
    let kept_summary = summary_idx >= 0 && kept.contains(&(summary_idx as usize));
    let after_tokens = best_candidate.tokens.unwrap_or(f64::NAN);
    if !options.dry_run {
        if !removed.is_empty() {
            let sidecar = sidecar_path(file);
            let mut payload = removed
                .iter()
                .map(|index| lines[*index].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            payload.push('\n');
            append_ignoring_errors(&sidecar, &payload);
        }
        let mut output = best_candidate.texts.join("\n");
        output.push('\n');
        // The legacy final write was not wrapped in try/catch: a permissions or
        // disk error propagates to the caller.
        fs::write(file, output.as_bytes()).map_err(|error| error.to_string())?;
    }
    Ok(Some(Report {
        file: file.to_string(),
        strategy: strategy.unwrap_or_default(),
        triggers,
        before_bytes: file_bytes,
        after_bytes: best_candidate.bytes,
        after_tokens,
        fits_target: after_tokens <= options.target_tokens,
        before_lines: lines.len(),
        after_lines: best_candidate.texts.len(),
        dropped_lines: removed.len(),
        kept_summary,
        real_user_turns: starts.len(),
        substantive_turns: substantive_starts.len(),
        dropped_turns,
        lost_turns,
        lost_substantive_turns,
        compact_boundary: boundary_idx >= 0,
        elided_entries: best_candidate.elided_entries,
        orphan_blocks: best_candidate.orphan_blocks,
        rerooted_entries: best_candidate.rerooted,
        context_affected: best_candidate.elided_entries > 0 || lost_turns > 0,
        forced: options.force_strict,
        dry_run: options.dry_run_strict,
    }))
}

pub fn measure_file(file: Option<&str>, options: &MeasureOptions) -> Level {
    let Some(file) = file.filter(|file| !file.is_empty()) else {
        return Level::missing();
    };
    let path = Path::new(file);
    let Ok(metadata) = fs::metadata(path) else {
        return Level::missing();
    };
    let Some(raw) = read_text(path) else {
        return Level::missing();
    };
    let lines = split_lines(&raw);
    let units = lines
        .iter()
        .map(|line| line_units(line))
        .collect::<Vec<_>>();
    let cut = compact_cut_index(&lines);
    let (live_bytes, largest_entry_bytes) = live_extent(&lines, &units, cut.cut);
    let mut real_user_turns = 0usize;
    let mut live_turns = 0usize;
    let mut substantive_turns = 0usize;
    for (index, line) in lines.iter().enumerate() {
        if !line.contains("\"user\"") {
            continue;
        }
        if (units[index] as f64) > USER_TOOL_RESULT_SKIP_UNITS && line.contains("\"tool_result\"") {
            continue;
        }
        let Some(obj) = parse_truthy(line) else {
            continue;
        };
        if !is_real_user_turn(&obj) {
            continue;
        }
        real_user_turns += 1;
        if index >= cut.cut {
            live_turns += 1;
        }
        if is_substantive_turn(&obj) {
            substantive_turns += 1;
        }
    }
    let api_bytes = live_api_bytes(&lines, cut.cut, live_bytes, options.parse_budget);
    let estimated_tokens = api_bytes.map(|bytes| round_half_up(bytes / BYTES_PER_TOKEN));
    let triggers = triggers_for(
        metadata.len() as f64,
        largest_entry_bytes,
        &MeasureThresholds {
            max_bytes: options.max_bytes,
            hard_entry_bytes: options.hard_entry_bytes,
            scan_min_bytes: options.scan_min_bytes,
        },
    );
    let over_watermark = estimated_tokens.is_some_and(|tokens| tokens >= options.token_watermark);
    let would_prune = !triggers.is_empty();
    let status = if over_watermark
        || (estimated_tokens.is_none() && live_bytes > options.hard_max_tokens * BYTES_PER_TOKEN)
    {
        "over"
    } else if would_prune {
        "watch"
    } else {
        "ok"
    };
    Level {
        found: true,
        file_bytes: metadata.len() as f64,
        lines: lines.len(),
        live_bytes,
        live_lines: lines.len() - cut.cut,
        api_bytes,
        estimated_tokens,
        largest_entry_bytes,
        real_user_turns,
        live_turns,
        substantive_turns,
        compact_boundary: CompactBoundary {
            present: cut.boundary_idx >= 0,
            at_line: if cut.boundary_idx >= 0 {
                Some((cut.boundary_idx + 1) as f64)
            } else {
                None
            },
            summary_present: cut.summary_idx >= 0,
            dropped_by_compaction: cut.cut,
        },
        thresholds: Thresholds {
            max_bytes: options.max_bytes,
            hard_entry_bytes: options.hard_entry_bytes,
            scan_min_bytes: options.scan_min_bytes,
            target_tokens: options.target_tokens,
            hard_max_tokens: options.hard_max_tokens,
            token_watermark: options.token_watermark,
        },
        triggers,
        would_prune,
        over_watermark,
        status,
        modified_at: metadata.modified().ok().and_then(system_time_iso),
    }
}

fn system_time_iso(time: SystemTime) -> Option<String> {
    let datetime: chrono::DateTime<chrono::Utc> = time.into();
    Some(datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

// ── project directory / file lookup ─────────────────────────────────────────

pub fn claude_project_dir(cwd: &str, home: &str) -> String {
    let units = JsString::from_rust_str(cwd).into_units();
    let slug = units
        .iter()
        .map(|unit| {
            let ascii = u32::from(*unit);
            if matches!(ascii, 0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A) {
                char::from_u32(ascii).unwrap_or('-')
            } else {
                '-'
            }
        })
        .collect::<String>();
    let mut path = PathBuf::from(home);
    path.push(".claude");
    path.push("projects");
    // `path.join` drops an empty segment; `PathBuf::push("")` would leave a
    // trailing separator instead.
    if !slug.is_empty() {
        path.push(slug);
    }
    path.to_string_lossy().into_owned()
}

pub fn find_transcript_file(cwd: &str, session: Option<&str>, home: &str) -> Option<String> {
    let dir = claude_project_dir(cwd, home);
    if fs::metadata(&dir).is_err() {
        return None;
    }
    if let Some(session) = session.filter(|session| !session.is_empty()) {
        let exact = Path::new(&dir).join(format!("{session}.jsonl"));
        if fs::metadata(&exact).is_ok() {
            return Some(exact.to_string_lossy().into_owned());
        }
    }
    let mut names = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return None;
    };
    for entry in entries {
        let Ok(entry) = entry else { break };
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    // Node's readdirSync goes through libuv's scandir, which sorts names.
    names.sort();
    let mut best: Option<(String, u64)> = None;
    for name in names {
        if !name.ends_with(".jsonl") || name.ends_with(".pruned.jsonl") {
            continue;
        }
        let path = Path::new(&dir).join(&name);
        let Ok(metadata) = fs::metadata(&path) else {
            // The legacy loop let a stat error escape into the outer catch,
            // which returns whatever had been selected before it.
            break;
        };
        let size = metadata.len();
        if best.as_ref().is_none_or(|(_, current)| size > *current) {
            best = Some((path.to_string_lossy().into_owned(), size));
        }
    }
    best.map(|(path, _)| path)
}

pub fn prune_maybe(
    cwd: &str,
    session: Option<&str>,
    home: &str,
    options: &Options,
) -> Result<Option<Report>, String> {
    let file = find_transcript_file(cwd, session, home);
    prune_file(file.as_deref(), options)
}

pub fn measure_maybe(
    cwd: &str,
    session: Option<&str>,
    home: &str,
    options: &MeasureOptions,
) -> Level {
    let file = find_transcript_file(cwd, session, home);
    measure_file(file.as_deref(), options)
}

// ── boundary encoding ───────────────────────────────────────────────────────

fn num(value: f64) -> JsValue {
    JsValue::Number(value)
}

fn bool_value(value: bool) -> JsValue {
    JsValue::Bool(value)
}

pub fn report_value(report: &Report) -> JsValue {
    JsValue::object(vec![
        ("file", JsValue::string(&report.file)),
        ("strategy", JsValue::string(&report.strategy)),
        (
            "triggers",
            JsValue::Array(
                report
                    .triggers
                    .iter()
                    .map(|reason| JsValue::string(reason))
                    .collect(),
            ),
        ),
        ("beforeBytes", num(report.before_bytes)),
        ("afterBytes", num(report.after_bytes)),
        ("afterTokens", num(report.after_tokens)),
        ("fitsTarget", bool_value(report.fits_target)),
        ("beforeLines", num(report.before_lines as f64)),
        ("afterLines", num(report.after_lines as f64)),
        ("droppedLines", num(report.dropped_lines as f64)),
        ("keptSummary", bool_value(report.kept_summary)),
        ("realUserTurns", num(report.real_user_turns as f64)),
        ("substantiveTurns", num(report.substantive_turns as f64)),
        ("droppedTurns", num(report.dropped_turns as f64)),
        ("lostTurns", num(report.lost_turns as f64)),
        (
            "lostSubstantiveTurns",
            num(report.lost_substantive_turns as f64),
        ),
        ("compactBoundary", bool_value(report.compact_boundary)),
        ("elidedEntries", num(report.elided_entries as f64)),
        ("orphanBlocks", num(report.orphan_blocks as f64)),
        ("rerootedEntries", num(report.rerooted_entries as f64)),
        ("contextAffected", bool_value(report.context_affected)),
        ("forced", bool_value(report.forced)),
        ("dryRun", bool_value(report.dry_run)),
    ])
}

pub fn report_json(report: &Report) -> String {
    stringify(&report_value(report))
}

pub fn level_value(level: &Level) -> JsValue {
    if !level.found {
        return JsValue::object(vec![("found", bool_value(false))]);
    }
    JsValue::object(vec![
        ("found", bool_value(true)),
        ("fileBytes", num(level.file_bytes)),
        ("lines", num(level.lines as f64)),
        ("liveBytes", num(level.live_bytes)),
        ("liveLines", num(level.live_lines as f64)),
        (
            "apiBytes",
            level.api_bytes.map(num).unwrap_or(JsValue::Null),
        ),
        (
            "estimatedTokens",
            level.estimated_tokens.map(num).unwrap_or(JsValue::Null),
        ),
        ("largestEntryBytes", num(level.largest_entry_bytes)),
        ("realUserTurns", num(level.real_user_turns as f64)),
        ("liveTurns", num(level.live_turns as f64)),
        ("substantiveTurns", num(level.substantive_turns as f64)),
        (
            "compactBoundary",
            JsValue::object(vec![
                ("present", bool_value(level.compact_boundary.present)),
                (
                    "atLine",
                    level
                        .compact_boundary
                        .at_line
                        .map(num)
                        .unwrap_or(JsValue::Null),
                ),
                (
                    "summaryPresent",
                    bool_value(level.compact_boundary.summary_present),
                ),
                (
                    "droppedByCompaction",
                    num(level.compact_boundary.dropped_by_compaction as f64),
                ),
            ]),
        ),
        (
            "thresholds",
            JsValue::object(vec![
                ("maxBytes", num(level.thresholds.max_bytes)),
                ("hardEntryBytes", num(level.thresholds.hard_entry_bytes)),
                ("scanMinBytes", num(level.thresholds.scan_min_bytes)),
                ("targetTokens", num(level.thresholds.target_tokens)),
                ("hardMaxTokens", num(level.thresholds.hard_max_tokens)),
                ("tokenWatermark", num(level.thresholds.token_watermark)),
            ]),
        ),
        (
            "triggers",
            JsValue::Array(
                level
                    .triggers
                    .iter()
                    .map(|reason| JsValue::string(reason))
                    .collect(),
            ),
        ),
        ("wouldPrune", bool_value(level.would_prune)),
        ("overWatermark", bool_value(level.over_watermark)),
        ("status", JsValue::string(level.status)),
        (
            "modifiedAt",
            level
                .modified_at
                .as_ref()
                .map(|text| JsValue::string(text))
                .unwrap_or(JsValue::Null),
        ),
    ])
}

pub fn level_json(level: &Level) -> String {
    stringify(&level_value(level))
}

pub fn cut_value(cut: &Cut) -> JsValue {
    JsValue::object(vec![
        ("cut", num(cut.cut as f64)),
        ("boundaryIdx", num(cut.boundary_idx as f64)),
        ("summaryIdx", num(cut.summary_idx as f64)),
    ])
}

pub fn defaults_value() -> JsValue {
    JsValue::object(vec![
        ("maxBytes", num(DEFAULT_MAX_BYTES)),
        ("targetTokens", num(DEFAULT_TARGET_TOKENS)),
        ("hardMaxTokens", num(DEFAULT_HARD_MAX_TOKENS)),
        ("maxEntryBytes", num(DEFAULT_MAX_ENTRY_BYTES)),
        ("hardEntryBytes", num(DEFAULT_HARD_ENTRY_BYTES)),
        (
            "keepTurnsLadder",
            JsValue::Array(DEFAULT_KEEP_TURNS_LADDER.iter().copied().map(num).collect()),
        ),
        ("scanMinBytes", num(DEFAULT_SCAN_MIN_BYTES)),
        ("tokenWatermark", num(DEFAULT_TOKEN_WATERMARK)),
    ])
}

pub fn defaults_json() -> String {
    stringify(&defaults_value())
}

pub fn user_visible_text_json(value: &JsValue) -> String {
    json_quote(&user_visible_text(value))
}

pub fn triggers_for_js(
    metrics: &JsValue,
    thresholds: &JsValue,
) -> Result<Vec<&'static str>, String> {
    if !matches!(metrics, JsValue::Object(_)) || !matches!(thresholds, JsValue::Object(_)) {
        return Err("transcript_prune_invalid_triggers".to_string());
    }
    let file_bytes = number(metrics.get("fileBytes"), 0.0);
    let largest = number(metrics.get("largestEntryBytes"), 0.0);
    let options = MeasureThresholds {
        max_bytes: number(thresholds.get("maxBytes"), 0.0),
        hard_entry_bytes: number(thresholds.get("hardEntryBytes"), 0.0),
        scan_min_bytes: number(thresholds.get("scanMinBytes"), 0.0),
    };
    Ok(triggers_for(file_bytes, largest, &options))
}

#[cfg(test)]
mod tests;
