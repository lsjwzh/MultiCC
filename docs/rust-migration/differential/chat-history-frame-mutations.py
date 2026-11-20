#!/usr/bin/env python3
"""Mutate the connect-time chat_history budget kernel; every variant must go red.

Each variant breaks exactly one rule the retired fitHistoryFrame enforced. The
baseline must pass first; a variant that does not compile aborts the batch
(see mutation_runner.py), so a typo can never be counted as a detection.

Variants deliberately NOT listed, because the corpus cannot tell them apart and
claiming them would be false coverage:

* Dropping the `!items.is_empty()` guard in clip_message_tools. An empty
  `tools` array is rewritten to an empty `tools` array at the same key
  position, so the output bytes are identical either way.
* The negative / non-finite branches of size_option. JSON carries neither
  Infinity nor NaN, and the production caller passes a finite number or
  nothing (the JavaScript face maps Infinity before it crosses).
* The `_ => 0` arm for a non-numeric size in plan_json. The production caller
  only ever sends the numbers `jsonBytes` returns.
"""
from mutation_runner import ROOT, Mutator, run_suite

KERNEL = "native/core/src/chat_history_frame.rs"
source = (ROOT / KERNEL).read_text()
m = Mutator(source)

variants = [
    ("baseline", source, True),

    # ---- the size measurement ----------------------------------------------
    ("counts-characters-not-bytes",
     m.apply("json_stringify(value).map_or(0, |text| text.len())",
             "json_stringify(value).map_or(0, |text| text.chars().count())",
             "counts-characters-not-bytes"), False),
    ("counts-utf16-units-not-bytes",
     m.apply("json_stringify(value).map_or(0, |text| text.len())",
             "json_stringify(value).map_or(0, |text| text.encode_utf16().count())",
             "counts-utf16-units-not-bytes"), False),
    ("unencodable-message-costs-a-byte",
     m.apply("json_stringify(value).map_or(0, |text| text.len())",
             "json_stringify(value).map_or(1, |text| text.len())",
             "unencodable-message-costs-a-byte"), False),

    # ---- the drop-oldest loop ------------------------------------------------
    ("subtracts-the-newest-size-not-the-oldest",
     m.apply("total -= sizes[start];", "total -= sizes[sizes.len() - 1 - start];",
             "subtracts-the-newest-size-not-the-oldest"), False),
    ("no-keep-at-least-one-floor",
     m.apply("sizes.len() - start > 1", "sizes.len() - start > 0",
             "no-keep-at-least-one-floor"), False),
    ("drops-a-page-that-exactly-fits",
     m.apply("while total > max_bytes &&", "while total >= max_bytes &&",
             "drops-a-page-that-exactly-fits"), False),

    # ---- hasMore ---------------------------------------------------------------
    ("has-more-ignores-what-was-dropped",
     m.apply("has_more: has_more || start > 0,", "has_more: has_more,",
             "has-more-ignores-what-was-dropped"), False),
    ("has-more-ignores-the-callers-flag",
     m.apply("has_more: has_more || start > 0,", "has_more: start > 0,",
             "has-more-ignores-the-callers-flag"), False),

    # ---- the clip decision -------------------------------------------------------
    ("clips-a-page-that-exactly-fits",
     m.apply("clipped: total > max_bytes,", "clipped: total >= max_bytes,",
             "clips-a-page-that-exactly-fits"), False),
    ("clip-decided-on-the-page-before-dropping",
     m.apply("clipped: total > max_bytes,",
             "clipped: sizes.iter().sum::<usize>() > max_bytes,",
             "clip-decided-on-the-page-before-dropping"), False),

    # ---- the clip itself -----------------------------------------------------------
    ("clips-a-string-exactly-at-the-limit",
     m.apply("if text.len() <= max_chars {", "if text.len() < max_chars {",
             "clips-a-string-exactly-at-the-limit"), False),
    ("cuts-in-characters-not-utf16-units",
     m.apply("let mut out = text.truncate_units(max_chars);",
             "let mut out = JsString::from_rust_str(\n"
             "        &text\n            .to_string_lossy()\n            .chars()\n"
             "            .take(max_chars)\n            .collect::<String>(),\n    );",
             "cuts-in-characters-not-utf16-units"), False),
    ("marker-reports-the-whole-length",
     m.apply("        text.len() - max_chars\n    ));", "        text.len()\n    ));",
             "marker-reports-the-whole-length"), False),
    ("clip-skips-arrays",
     m.apply("""        JsValue::Array(items) => JsValue::Array(
            items
                .iter()
                .map(|item| clip_value(item, max_chars))
                .collect(),
        ),""", "        JsValue::Array(items) => JsValue::Array(items.clone()),",
             "clip-skips-arrays"), False),
    ("clip-skips-objects",
     m.apply(".map(|(key, child)| (key.clone(), clip_value(child, max_chars)))",
             ".map(|(key, child)| (key.clone(), child.clone()))",
             "clip-skips-objects"), False),
    ("clip-retains-prototype-setter-property",
     m.apply('                .filter(|(key, _)| key != "__proto__")\n', "",
             "clip-retains-prototype-setter-property"), False),
    ("clip-leaves-tool-input-alone",
     m.apply("""            let input = property(tool, "input")
                .map_or(JsValue::Undefined, |value| clip_value(value, max_chars));""",
             """            let input = property(tool, "input")
                .map_or(JsValue::Undefined, |value| value.clone());""",
             "clip-leaves-tool-input-alone"), False),
    ("clip-leaves-tool-result-alone",
     m.apply("""            let result = property(tool, "result")
                .map_or(JsValue::Undefined, |value| clip_value(value, max_chars));""",
             """            let result = property(tool, "result")
                .map_or(JsValue::Undefined, |value| value.clone());""",
             "clip-leaves-tool-result-alone"), False),
    ("array-tool-is-left-opaque",
     m.apply("""                JsValue::Array(items) => items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| {
                        (JsString::from_rust_str(&index.to_string()), item.clone())
                    })
                    .collect(),""", "                JsValue::Array(_) => return tool.clone(),",
             "array-tool-is-left-opaque"), False),
    ("primitive-tool-is-wrapped-in-an-object",
     m.apply("other => return other.clone(),", "_ => Vec::new(),",
             "primitive-tool-is-wrapped-in-an-object"), False),

    # ---- the defaults ------------------------------------------------------------------
    ("default-budget-halved",
     m.apply("pub const DEFAULT_MAX_BYTES: usize = 4 * 1024 * 1024;",
             "pub const DEFAULT_MAX_BYTES: usize = 2 * 1024 * 1024;",
             "default-budget-halved"), False),
    ("default-budget-doubled",
     m.apply("pub const DEFAULT_MAX_BYTES: usize = 4 * 1024 * 1024;",
             "pub const DEFAULT_MAX_BYTES: usize = 8 * 1024 * 1024;",
             "default-budget-doubled"), False),
    ("default-clip-limit-halved",
     m.apply("pub const DEFAULT_TOOL_STRING_CHARS: usize = 16 * 1024;",
             "pub const DEFAULT_TOOL_STRING_CHARS: usize = 8 * 1024;",
             "default-clip-limit-halved"), False),
    ("a-zero-budget-means-the-default",
     m.apply("None | Some(JsValue::Undefined) => fallback,",
             "None | Some(JsValue::Undefined) => fallback,\n"
             "        Some(JsValue::Number(number)) if *number == 0.0 => fallback,",
             "a-zero-budget-means-the-default"), False),

    # ---- the production bridge -------------------------------------------------------------
    ("plan-bridge-ignores-the-callers-budget",
     m.apply('\n        size_option(property(&value, "maxBytes"), DEFAULT_MAX_BYTES),\n    );',
             "\n        DEFAULT_MAX_BYTES,\n    );",
             "plan-bridge-ignores-the-callers-budget"), False),
    ("clip-bridge-ignores-the-callers-limit",
     m.apply("""    let chars = size_option(
        property(&value, "toolStringChars"),
        DEFAULT_TOOL_STRING_CHARS,
    );""", "    let chars = DEFAULT_TOOL_STRING_CHARS;",
             "clip-bridge-ignores-the-callers-limit"), False),
]

run_suite(KERNEL, "chat-history-frame-corpus.json", "chat_history_frame", variants,
          min_tests=8, tag="chat-history-frame")
