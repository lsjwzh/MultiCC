//! The byte budget for the connect-time `chat_history` frame.
//!
//! The connect replay sends the newest page of messages as ONE WebSocket
//! frame. Counting messages bounds nothing: a single tool-heavy assistant turn
//! can serialize to several MB, and once the frame passes the backpressure
//! `maxFrameBytes` the socket is closed with 1013 and the page reconnects
//! forever (2026-10-01: a 4-message page of 9.2 MB). Raising the cap only
//! moves the cliff, so the frame is fitted to a byte budget instead: drop the
//! oldest messages first (`hasMore` lets the page fetch them over HTTP, which
//! has no frame cap), keeping at least one; then, if what is left is still
//! over budget, clip oversized tool strings in the replay copy.
//!
//! The persisted transcript is never touched -- callers pass the replay copy.
//!
//! Three details decide the contract and are each easy to get wrong:
//!
//! * The total is NOT recomputed after clipping. `clipped` says the clip ran,
//!   not that the result now fits. A page of one huge message stays over
//!   budget on purpose, because the loop keeps at least one message and
//!   dropping it would send an empty frame.
//! * A message's size is the byte length of its OWN JSON, summed. That is not
//!   the frame's byte length -- no array brackets, no commas, no envelope --
//!   and the budget is deliberately compared against that sum.
//! * A value JSON cannot represent costs 0 bytes (`JSON.stringify` returning
//!   `undefined` made `Buffer.byteLength` throw, and the `catch` returned 0),
//!   so such a message is never the reason anything is dropped.
//!
//! `toolStringChars` is counted in UTF-16 code units, because the retired
//! implementation used `String.prototype.length` and `.slice`. A cut that
//! splits a surrogate pair therefore leaves a lone code unit, exactly as it
//! did in Node; `JSON.stringify` escapes it rather than failing.
use crate::js::{
    json::{json_parse, json_stringify},
    JsString, JsValue,
};

pub const DEFAULT_MAX_BYTES: usize = 4 * 1024 * 1024;
pub const DEFAULT_TOOL_STRING_CHARS: usize = 16 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct Budget {
    pub max_bytes: usize,
    pub tool_string_chars: usize,
}

impl Default for Budget {
    fn default() -> Self {
        Budget {
            max_bytes: DEFAULT_MAX_BYTES,
            tool_string_chars: DEFAULT_TOOL_STRING_CHARS,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Fitted {
    pub messages: Vec<JsValue>,
    pub has_more: bool,
    /// How many of the oldest messages were dropped.
    pub dropped: usize,
    /// Whether the tool-string clip ran. Not a promise that the result fits.
    pub clipped: bool,
}

/// `jsonBytes`: the UTF-8 byte length of the value's JSON, or 0 when JSON
/// cannot represent it.
fn json_bytes(value: &JsValue) -> usize {
    json_stringify(value).map_or(0, |text| text.len())
}

/// `clipString`. The comparison and the cut are both in UTF-16 code units.
fn clip_string(text: &JsString, max_chars: usize) -> JsString {
    if text.len() <= max_chars {
        return text.clone();
    }
    let mut out = text.truncate_units(max_chars);
    out.push_str(&format!(
        "\n\u{2026}[truncated {} chars on reconnect]",
        text.len() - max_chars
    ));
    out
}

/// `clipValue`: strings are clipped, arrays and objects are walked, everything
/// else is returned as it is. `null` is not walked (`value && typeof ...`).
fn clip_value(value: &JsValue, max_chars: usize) -> JsValue {
    match value {
        JsValue::String(text) => JsValue::String(clip_string(text, max_chars)),
        JsValue::Array(items) => JsValue::Array(
            items
                .iter()
                .map(|item| clip_value(item, max_chars))
                .collect(),
        ),
        JsValue::Object(entries) => JsValue::Object(
            entries
                .iter()
                // The original assigns into {}, where the inherited
                // __proto__ setter creates no own property to serialize.
                .filter(|(key, _)| key != "__proto__")
                .map(|(key, child)| (key.clone(), clip_value(child, max_chars)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn property<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(entries) => entries
            .iter()
            .find(|(key, _)| key.to_string_lossy() == name)
            .map(|(_, child)| child),
        _ => None,
    }
}

/// `{ ...source, [name]: value }`: an existing key keeps its position, a new
/// one is appended.
fn with_property(
    source: &[(JsString, JsValue)],
    name: &str,
    value: JsValue,
) -> Vec<(JsString, JsValue)> {
    let mut out: Vec<(JsString, JsValue)> = source.to_vec();
    if let Some(slot) = out
        .iter_mut()
        .find(|(key, _)| key.to_string_lossy() == name)
    {
        slot.1 = value;
        return out;
    }
    out.push((JsString::from_rust_str(name), value));
    out
}

/// `clipMessageTools`. `typeof tool === 'object'` is also true for an array,
/// so an array tool is spread into an object with index keys -- the retired
/// code did that too.
fn clip_message_tools(message: &JsValue, max_chars: usize) -> JsValue {
    let tools = match property(message, "tools") {
        Some(JsValue::Array(items)) if !items.is_empty() => items,
        // `!message`, a non-array `tools` and an empty `tools` all return the
        // message untouched.
        _ => return message.clone(),
    };
    let clipped: Vec<JsValue> = tools
        .iter()
        .map(|tool| {
            let entries: Vec<(JsString, JsValue)> = match tool {
                JsValue::Object(entries) => entries.clone(),
                JsValue::Array(items) => items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| {
                        (JsString::from_rust_str(&index.to_string()), item.clone())
                    })
                    .collect(),
                // `null` and the primitives fail `tool && typeof tool === 'object'`.
                other => return other.clone(),
            };
            // `input` and `result` are assigned even when the tool had
            // neither, so they are appended as `undefined` -- which JSON then
            // drops. Reproduced rather than optimised away so the kernel is
            // literally the retired expression.
            let input = property(tool, "input")
                .map_or(JsValue::Undefined, |value| clip_value(value, max_chars));
            let result = property(tool, "result")
                .map_or(JsValue::Undefined, |value| clip_value(value, max_chars));
            let entries = with_property(&entries, "input", input);
            let entries = with_property(&entries, "result", result);
            JsValue::Object(entries)
        })
        .collect();
    let JsValue::Object(entries) = message else {
        // Unreachable: a value with an array `tools` property is an object.
        return message.clone();
    };
    JsValue::Object(with_property(entries, "tools", JsValue::Array(clipped)))
}

/// What the budget decides, from the per-message sizes alone.
///
/// Separated from `fit` so the hot path never crosses a bridge: a connect page
/// can be megabytes, and copying it into Rust and back was measured at 55x the
/// cost of the retired JavaScript (5.48 ms of blocked main thread on an 896 KB
/// page, against 0.10 ms) -- paid on every reconnect, which arrive at a few
/// per second across a fleet. The caller already computes one JSON per message
/// to measure it, so it hands over the sizes, applies the slice itself, and
/// only ships the surviving messages here when a clip is actually needed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan {
    /// How many of the oldest messages to drop.
    pub dropped: usize,
    pub has_more: bool,
    /// Whether to run the tool-string clip over what is left.
    pub clipped: bool,
}

/// The drop-oldest loop and its keep-at-least-one floor.
pub fn plan(sizes: &[usize], has_more: bool, max_bytes: usize) -> Plan {
    let mut total: usize = sizes.iter().sum();
    let mut start = 0usize;
    while total > max_bytes && sizes.len() - start > 1 {
        total -= sizes[start];
        start += 1;
    }
    Plan {
        dropped: start,
        has_more: has_more || start > 0,
        // `total` is the sum of what remains, and it is NOT recomputed after
        // the clip: this says the clip runs, not that the result then fits.
        clipped: total > max_bytes,
    }
}

/// The clip, over the messages that survived the drop.
pub fn clip_page(messages: &[JsValue], tool_string_chars: usize) -> Vec<JsValue> {
    messages
        .iter()
        .map(|message| clip_message_tools(message, tool_string_chars))
        .collect()
}

/// `fitHistoryFrame` whole, which is `plan` + the slice + `clip_page`. Kept as
/// the reference the corpus is compared against, and as the proof that the
/// three-part decomposition the caller uses cannot drift from it.
pub fn fit(messages: &[JsValue], has_more: bool, budget: &Budget) -> Fitted {
    let sizes: Vec<usize> = messages.iter().map(json_bytes).collect();
    let decision = plan(&sizes, has_more, budget.max_bytes);
    let kept: Vec<JsValue> = messages[decision.dropped..].to_vec();
    let kept = if decision.clipped {
        clip_page(&kept, budget.tool_string_chars)
    } else {
        kept
    };
    Fitted {
        messages: kept,
        has_more: decision.has_more,
        dropped: decision.dropped,
        clipped: decision.clipped,
    }
}

/// The per-message size the plan is computed from, exposed so a caller in
/// another language can be pinned against it.
pub fn message_bytes(message: &JsValue) -> usize {
    json_bytes(message)
}

// ── JSON bridge ────────────────────────────────────────────────────────────

/// `{ sizes, hasMore, maxBytes? }` in, `{ dropped, hasMore, clipped }` out.
/// This is the bridge the connect path uses: only numbers cross it, so a
/// megabyte page is never copied.
pub fn plan_json(input: &str) -> Result<String, String> {
    let value =
        json_parse(input).map_err(|e| format!("chat_history_frame_invalid_input: {e:?}"))?;
    let sizes: Vec<usize> = match property(&value, "sizes") {
        Some(JsValue::Array(items)) => items
            .iter()
            .map(|item| match item {
                JsValue::Number(number) if *number >= 0.0 && number.is_finite() => *number as usize,
                // A size JSON could not produce is 0, which is what the
                // retired `jsonBytes` returned for an unencodable message.
                _ => 0,
            })
            .collect(),
        _ => Vec::new(),
    };
    let decision = plan(
        &sizes,
        truthy(property(&value, "hasMore")),
        size_option(property(&value, "maxBytes"), DEFAULT_MAX_BYTES),
    );
    let out = JsValue::Object(vec![
        (
            JsString::from_rust_str("dropped"),
            JsValue::Number(decision.dropped as f64),
        ),
        (
            JsString::from_rust_str("hasMore"),
            JsValue::Bool(decision.has_more),
        ),
        (
            JsString::from_rust_str("clipped"),
            JsValue::Bool(decision.clipped),
        ),
    ]);
    json_stringify(&out).ok_or_else(|| "chat_history_frame_unencodable".to_string())
}

/// `{ messages, toolStringChars? }` in, the clipped messages out. Only reached
/// when the plan asked for a clip, which means the page was already over
/// budget after dropping everything it could -- a rare path whose whole point
/// is to rewrite bytes.
pub fn clip_page_json(input: &str) -> Result<String, String> {
    let value =
        json_parse(input).map_err(|e| format!("chat_history_frame_invalid_input: {e:?}"))?;
    let messages = match property(&value, "messages") {
        Some(JsValue::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let chars = size_option(
        property(&value, "toolStringChars"),
        DEFAULT_TOOL_STRING_CHARS,
    );
    json_stringify(&JsValue::Array(clip_page(&messages, chars)))
        .ok_or_else(|| "chat_history_frame_unencodable".to_string())
}

/// `{ messages, hasMore, maxBytes?, toolStringChars? }` in, the whole fitted
/// frame out. Not on the connect path -- it exists so a test can drive the
/// reference implementation end to end across the bridge.
pub fn fit_json(input: &str) -> Result<String, String> {
    let value =
        json_parse(input).map_err(|e| format!("chat_history_frame_invalid_input: {e:?}"))?;
    let messages = match property(&value, "messages") {
        Some(JsValue::Array(items)) => items.clone(),
        // `Array.isArray(messages) ? messages : []`.
        _ => Vec::new(),
    };
    let has_more = truthy(property(&value, "hasMore"));
    let budget = Budget {
        max_bytes: size_option(property(&value, "maxBytes"), DEFAULT_MAX_BYTES),
        tool_string_chars: size_option(
            property(&value, "toolStringChars"),
            DEFAULT_TOOL_STRING_CHARS,
        ),
    };
    let fitted = fit(&messages, has_more, &budget);
    let out = JsValue::Object(vec![
        (
            JsString::from_rust_str("messages"),
            JsValue::Array(fitted.messages),
        ),
        (
            JsString::from_rust_str("hasMore"),
            JsValue::Bool(fitted.has_more),
        ),
        (
            JsString::from_rust_str("dropped"),
            JsValue::Number(fitted.dropped as f64),
        ),
        (
            JsString::from_rust_str("clipped"),
            JsValue::Bool(fitted.clipped),
        ),
    ]);
    json_stringify(&out).ok_or_else(|| "chat_history_frame_unencodable".to_string())
}

/// JS truthiness, for `!!hasMore`.
fn truthy(value: Option<&JsValue>) -> bool {
    match value {
        None | Some(JsValue::Undefined) | Some(JsValue::Null) => false,
        Some(JsValue::Bool(flag)) => *flag,
        Some(JsValue::Number(number)) => *number != 0.0 && !number.is_nan(),
        Some(JsValue::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// A destructuring default: only `undefined` (or an absent key) falls back.
/// Anything else is taken as given, which is what the retired options object
/// did -- a `maxBytes` of 0 really meant 0.
fn size_option(value: Option<&JsValue>, fallback: usize) -> usize {
    match value {
        None | Some(JsValue::Undefined) => fallback,
        Some(JsValue::Number(number)) if *number >= 0.0 && number.is_finite() => *number as usize,
        // A negative or non-finite budget can never be satisfied, which in the
        // retired loop meant "drop until one message is left, then clip".
        // `usize::MIN` reproduces that; `Infinity` reproduces "never clip".
        Some(JsValue::Number(number)) if *number > 0.0 => usize::MAX,
        Some(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::json::json_parse;

    /// Overridden by a mutation runner so a mutated copy still reads the
    /// frozen corpus.
    const CORPUS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/rust-migration/differential/chat-history-frame-corpus.json"
    );

    /// JSON cannot carry `undefined`, so the corpus marks those slots and both
    /// sides rehydrate them. Without this the unencodable sweep would be
    /// comparing `null` (4 bytes) against a value that must cost 0.
    fn rehydrate(value: &JsValue) -> JsValue {
        match value {
            JsValue::Array(items) => JsValue::Array(items.iter().map(rehydrate).collect()),
            JsValue::Object(entries) => {
                let marked = entries.iter().any(|(key, child)| {
                    key.to_string_lossy() == "__corpusUndefined"
                        && matches!(child, JsValue::Bool(true))
                });
                if marked {
                    return JsValue::Undefined;
                }
                JsValue::Object(
                    entries
                        .iter()
                        .map(|(key, child)| (key.clone(), rehydrate(child)))
                        .collect(),
                )
            }
            other => other.clone(),
        }
    }

    fn corpus() -> JsValue {
        let text = std::fs::read_to_string(CORPUS).expect("history frame corpus");
        json_parse(&text).expect("corpus json")
    }

    fn field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
        property(value, name)
    }

    /// Every case in the frozen corpus, compared against the frozen Node
    /// implementation (tests/helpers/legacy-chat-history-frame.js) through the
    /// corpus its generator wrote. A drop count, a clip decision or a single
    /// byte of the fitted messages diverging fails here with the exact case.
    #[test]
    fn the_fitted_frame_matches_the_frozen_node_implementation() {
        let corpus = corpus();
        let cases = match field(&corpus, "cases") {
            Some(JsValue::Array(items)) => items.clone(),
            _ => panic!("cases array"),
        };
        assert_eq!(cases.len(), 144, "the corpus must stay exhaustive");
        for case in &cases {
            let label = format!(
                "{} / {}",
                field(case, "sweep")
                    .and_then(json_stringify)
                    .unwrap_or_default(),
                field(case, "name")
                    .and_then(json_stringify)
                    .unwrap_or_default(),
            );
            let input = field(case, "input").expect("input");
            let messages = match field(input, "messages").map(rehydrate) {
                Some(JsValue::Array(items)) => items,
                // `Array.isArray(messages) ? messages : []`.
                _ => Vec::new(),
            };
            let has_more = truthy(field(input, "hasMore"));
            let options = field(input, "options");
            let budget = Budget {
                max_bytes: size_option(
                    options.and_then(|value| property(value, "maxBytes")),
                    DEFAULT_MAX_BYTES,
                ),
                tool_string_chars: size_option(
                    options.and_then(|value| property(value, "toolStringChars")),
                    DEFAULT_TOOL_STRING_CHARS,
                ),
            };
            let fitted = fit(&messages, has_more, &budget);
            let expected = field(case, "expected").expect("expected");
            // The messages are compared as JSON, which is the wire the frame
            // is headed for: an `undefined` the retired code appended is
            // absent on both sides, and nothing else differs silently.
            let actual_messages = json_stringify(&JsValue::Array(fitted.messages.clone()))
                .expect("fitted messages encode");
            let expected_messages = field(expected, "messages")
                .and_then(json_stringify)
                .expect("expected messages encode");
            assert_eq!(actual_messages, expected_messages, "messages: {label}");
            assert_eq!(
                JsValue::Bool(fitted.has_more),
                *field(expected, "hasMore").expect("hasMore"),
                "hasMore: {label}"
            );
            assert_eq!(
                JsValue::Number(fitted.dropped as f64),
                *field(expected, "dropped").expect("dropped"),
                "dropped: {label}"
            );
            assert_eq!(
                JsValue::Bool(fitted.clipped),
                *field(expected, "clipped").expect("clipped"),
                "clipped: {label}"
            );
        }
    }

    #[test]
    fn clipped_tool_values_omit_prototype_setter_properties() {
        let input = r#"{"messages":[{"tools":[{"input":{"__proto__":{"hidden":"long"},"shown":"long"}}]}],"toolStringChars":3}"#;
        let expected =
            r#"[{"tools":[{"input":{"shown":"lon\n…[truncated 1 chars on reconnect]"}}]}]"#;
        assert_eq!(clip_page_json(input).unwrap(), expected);
    }

    /// The production caller never hands the page to Rust: it measures each
    /// message with `JSON.stringify` + `Buffer.byteLength`, sends only those
    /// numbers through `plan_json`, slices in place, and ships the survivors to
    /// `clip_page_json` only when asked. This drives exactly that path from the
    /// sizes the frozen Node implementation measured, and also pins the Rust
    /// `message_bytes` to the same measurement -- so a kernel that counted
    /// characters or UTF-16 units instead of UTF-8 bytes fails here even though
    /// it would pass on ASCII.
    #[test]
    fn the_production_bridge_matches_the_frozen_node_implementation() {
        let corpus = corpus();
        let cases = match field(&corpus, "cases") {
            Some(JsValue::Array(items)) => items.clone(),
            _ => panic!("cases array"),
        };
        for case in &cases {
            let label = field(case, "name")
                .and_then(json_stringify)
                .unwrap_or_default();
            let input = field(case, "input").expect("input");
            let expected = field(case, "expected").expect("expected");
            let messages = match field(input, "messages").map(rehydrate) {
                Some(JsValue::Array(items)) => items,
                _ => Vec::new(),
            };
            let measured: Vec<f64> = match field(input, "sizes") {
                Some(JsValue::Array(items)) => items
                    .iter()
                    .map(|item| match item {
                        JsValue::Number(number) => *number,
                        other => panic!("size must be a number: {other:?}"),
                    })
                    .collect(),
                _ => panic!("sizes array: {label}"),
            };

            // The Rust measurement equals the Node one, message for message.
            let ours: Vec<f64> = messages.iter().map(|m| message_bytes(m) as f64).collect();
            assert_eq!(ours, measured, "message_bytes: {label}");

            let options = field(input, "options");
            let has_more = truthy(field(input, "hasMore"));
            let mut request = format!(
                r#"{{"sizes":{},"hasMore":{}"#,
                json_stringify(&JsValue::Array(
                    measured.iter().map(|n| JsValue::Number(*n)).collect()
                ))
                .unwrap(),
                has_more
            );
            if let Some(max) = options.and_then(|value| property(value, "maxBytes")) {
                request.push_str(&format!(r#","maxBytes":{}"#, json_stringify(max).unwrap()));
            }
            request.push('}');
            let decision = json_parse(&plan_json(&request).expect("plan bridge")).unwrap();
            assert_eq!(
                field(&decision, "dropped"),
                field(expected, "dropped"),
                "bridge dropped: {label}"
            );
            assert_eq!(
                field(&decision, "hasMore"),
                field(expected, "hasMore"),
                "bridge hasMore: {label}"
            );
            assert_eq!(
                field(&decision, "clipped"),
                field(expected, "clipped"),
                "bridge clipped: {label}"
            );

            // Apply it the way the caller does: slice, then clip only on ask.
            let dropped = match field(&decision, "dropped") {
                Some(JsValue::Number(n)) => *n as usize,
                _ => panic!("dropped"),
            };
            let kept: Vec<JsValue> = messages[dropped..].to_vec();
            let wire = if matches!(field(&decision, "clipped"), Some(JsValue::Bool(true))) {
                let mut clip = format!(
                    r#"{{"messages":{}"#,
                    json_stringify(&JsValue::Array(kept)).unwrap()
                );
                if let Some(chars) = options.and_then(|value| property(value, "toolStringChars")) {
                    clip.push_str(&format!(
                        r#","toolStringChars":{}"#,
                        json_stringify(chars).unwrap()
                    ));
                }
                clip.push('}');
                clip_page_json(&clip).expect("clip bridge")
            } else {
                json_stringify(&JsValue::Array(kept)).unwrap()
            };
            assert_eq!(
                wire,
                field(expected, "messages")
                    .and_then(json_stringify)
                    .unwrap(),
                "bridge messages: {label}"
            );
        }
    }

    /// The 4 MiB default is the number the 2026-10-01 reconnect-loop incident was
    /// fixed with. These cases carry sizes only (a 4 MiB page is not something
    /// a corpus should store) and are driven through the production bridge with
    /// NO `maxBytes`, so the default is what decides. A kernel whose default
    /// drifted to 2 MiB or 8 MiB changes at least one boundary here.
    #[test]
    fn the_default_budget_holds_at_its_exact_boundaries() {
        let corpus = corpus();
        let plans = match field(&corpus, "planCases") {
            Some(JsValue::Array(items)) => items.clone(),
            _ => panic!("planCases array"),
        };
        assert_eq!(plans.len(), 8, "the default-budget cases must stay");
        for case in &plans {
            let label = field(case, "name")
                .and_then(json_stringify)
                .unwrap_or_default();
            let input = field(case, "input").expect("input");
            let request = format!(
                r#"{{"sizes":{},"hasMore":{}}}"#,
                json_stringify(field(input, "sizes").expect("sizes")).unwrap(),
                truthy(field(input, "hasMore"))
            );
            let decision = json_parse(&plan_json(&request).expect("plan bridge")).unwrap();
            let expected = field(case, "expected").expect("expected");
            for key in ["dropped", "hasMore", "clipped"] {
                assert_eq!(
                    field(&decision, key),
                    field(expected, key),
                    "{key}: {label}"
                );
            }
        }
        // And the two defaults are the numbers the retired module exported.
        assert_eq!(DEFAULT_MAX_BYTES, 4 * 1024 * 1024);
        assert_eq!(DEFAULT_TOOL_STRING_CHARS, 16 * 1024);
    }

    /// The loop must never return an empty frame while it had something to
    /// send: an empty `chat_history` would make the page think the session has
    /// no transcript at all.
    #[test]
    fn a_non_empty_page_never_fits_to_nothing() {
        let corpus = corpus();
        let cases = match field(&corpus, "cases") {
            Some(JsValue::Array(items)) => items.clone(),
            _ => panic!("cases array"),
        };
        for case in &cases {
            let input = field(case, "input").expect("input");
            let messages = match field(input, "messages").map(rehydrate) {
                Some(JsValue::Array(items)) => items,
                _ => Vec::new(),
            };
            if messages.is_empty() {
                continue;
            }
            let fitted = fit(
                &messages,
                false,
                &Budget {
                    max_bytes: 0,
                    tool_string_chars: 0,
                },
            );
            assert!(
                !fitted.messages.is_empty(),
                "{:?}",
                field(case, "name").and_then(json_stringify)
            );
        }
    }

    /// Dropping anything must set `hasMore`, or the page has no way to fetch
    /// what it was not sent and the transcript silently loses its head.
    #[test]
    fn dropping_always_offers_the_rest_over_http() {
        for max_bytes in [0usize, 1, 50, 100, 150, 200, 1000] {
            let messages: Vec<JsValue> = ["a", "b", "c"]
                .iter()
                .map(|id| {
                    json_parse(&format!(r#"{{"id":"{id}","t":"{}"}}"#, "x".repeat(80)))
                        .expect("probe message")
                })
                .collect();
            let fitted = fit(
                &messages,
                false,
                &Budget {
                    max_bytes,
                    tool_string_chars: 8,
                },
            );
            assert_eq!(
                fitted.dropped > 0,
                fitted.has_more,
                "max_bytes={max_bytes} dropped={} has_more={}",
                fitted.dropped,
                fitted.has_more
            );
            assert_eq!(fitted.messages.len(), messages.len() - fitted.dropped);
        }
    }

    /// The caller does not run `fit`: it takes the decision from `plan_json`,
    /// applies the slice itself (keeping the page's array identity when
    /// nothing is dropped) and calls `clip_page_json` only when asked. That
    /// three-part decomposition must be indistinguishable from the reference
    /// implementation on every case in the corpus, or the split that keeps a
    /// megabyte page off the bridge has changed what the client receives.
    #[test]
    fn the_caller_decomposition_equals_the_reference_implementation() {
        let corpus = corpus();
        let cases = match field(&corpus, "cases") {
            Some(JsValue::Array(items)) => items.clone(),
            _ => panic!("cases array"),
        };
        for case in &cases {
            let input = field(case, "input").expect("input");
            let messages = match field(input, "messages").map(rehydrate) {
                Some(JsValue::Array(items)) => items,
                _ => Vec::new(),
            };
            let has_more = truthy(field(input, "hasMore"));
            let options = field(input, "options");
            let budget = Budget {
                max_bytes: size_option(
                    options.and_then(|value| property(value, "maxBytes")),
                    DEFAULT_MAX_BYTES,
                ),
                tool_string_chars: size_option(
                    options.and_then(|value| property(value, "toolStringChars")),
                    DEFAULT_TOOL_STRING_CHARS,
                ),
            };

            // What the caller does, step for step.
            let sizes: Vec<usize> = messages.iter().map(message_bytes).collect();
            let decision = plan(&sizes, has_more, budget.max_bytes);
            let sliced: Vec<JsValue> = messages[decision.dropped..].to_vec();
            let applied = if decision.clipped {
                clip_page(&sliced, budget.tool_string_chars)
            } else {
                sliced
            };

            let reference = fit(&messages, has_more, &budget);
            let label = field(case, "name")
                .and_then(json_stringify)
                .unwrap_or_default();
            assert_eq!(decision.dropped, reference.dropped, "dropped: {label}");
            assert_eq!(decision.has_more, reference.has_more, "hasMore: {label}");
            assert_eq!(decision.clipped, reference.clipped, "clipped: {label}");
            assert_eq!(
                json_stringify(&JsValue::Array(applied)),
                json_stringify(&JsValue::Array(reference.messages)),
                "messages: {label}"
            );
        }
    }

    #[test]
    fn the_decision_bridge_carries_only_numbers() {
        // Three 100-byte messages against a 150-byte budget: drop two, no clip.
        assert_eq!(
            plan_json(r#"{"sizes":[100,100,100],"hasMore":false,"maxBytes":150}"#).unwrap(),
            r#"{"dropped":2,"hasMore":true,"clipped":false}"#
        );
        // One message left and still over: the floor holds and the clip runs.
        assert_eq!(
            plan_json(r#"{"sizes":[100,100],"hasMore":false,"maxBytes":10}"#).unwrap(),
            r#"{"dropped":1,"hasMore":true,"clipped":true}"#
        );
        // An unencodable message is 0 bytes, so it is never a reason to drop.
        assert_eq!(
            plan_json(r#"{"sizes":[null,null,100],"hasMore":false,"maxBytes":100}"#).unwrap(),
            r#"{"dropped":0,"hasMore":false,"clipped":false}"#
        );
        assert_eq!(
            plan_json(r#"{"sizes":[],"hasMore":false,"maxBytes":0}"#).unwrap(),
            r#"{"dropped":0,"hasMore":false,"clipped":false}"#
        );
        assert_eq!(
            clip_page_json(r#"{"messages":[{"tools":[{"input":"abcdef"}]}],"toolStringChars":3}"#)
                .unwrap(),
            r#"[{"tools":[{"input":"abc\n…[truncated 3 chars on reconnect]"}]}]"#
        );
        assert!(plan_json("not json").is_err());
    }

    #[test]
    fn the_json_bridge_round_trips_a_fit_and_a_clip() {
        let fitted = fit_json(r#"{"messages":[{"id":"a"}],"hasMore":false}"#).unwrap();
        assert_eq!(
            fitted,
            r#"{"messages":[{"id":"a"}],"hasMore":false,"dropped":0,"clipped":false}"#
        );
        let clipped = fit_json(
            r#"{"messages":[{"tools":[{"input":"abcdef"}]}],"hasMore":false,"maxBytes":0,"toolStringChars":3}"#,
        )
        .unwrap();
        assert_eq!(
            clipped,
            r#"{"messages":[{"tools":[{"input":"abc\n…[truncated 3 chars on reconnect]"}]}],"hasMore":false,"dropped":0,"clipped":true}"#
        );
        // A missing `messages` is an empty page, not an error.
        assert_eq!(
            fit_json(r#"{"hasMore":true}"#).unwrap(),
            r#"{"messages":[],"hasMore":true,"dropped":0,"clipped":false}"#
        );
        assert!(fit_json("not json").is_err());
    }
}
