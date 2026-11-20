#!/usr/bin/env python3
"""Mutate the connect-time task_state kernel; every variant must go red.

Each variant breaks exactly one rule of the retired seed gate or of the shared
task_state payload. The baseline must pass first; a variant that does not
compile aborts the batch (see mutation_runner.py).

`since-narrowed-to-strings` is the defect the first version of this kernel
actually had: production's `health.sinceAt` is `Date.now()` -- a number -- and
a kernel that only accepted text turned every real unhealthy reading into
null. It stayed hidden while the corpus only used an ISO string, so it is kept
here as a regression variant: the corpus must now catch it.

Variants deliberately NOT listed, because the corpus cannot tell them apart:

* Removing the `!truthy(Some(task))` early return in `seeds`. A task that is
  not an object has no properties, so every term of the gate is false either
  way and the answer cannot change.
* A goalState vocabulary check for non-string values. JS compares with `===`,
  so a non-string can never match; there is no observable difference to pin.
"""
from mutation_runner import ROOT, Mutator, run_suite

KERNEL = "native/core/src/chat_task_state_frame.rs"
source = (ROOT / KERNEL).read_text()
m = Mutator(source)

SEEDS_LINE = ('truthy(property(task, "goal")) || phase_is_a_judgement '
              '|| truthy(property(task, "apiError"))')

variants = [
    ("baseline", source, True),

    # ---- the seed gate -------------------------------------------------------
    ("gate-ignores-a-persisted-api-error",
     m.apply(SEEDS_LINE, 'truthy(property(task, "goal")) || phase_is_a_judgement',
             "gate-ignores-a-persisted-api-error"), False),
    ("gate-ignores-the-goal",
     m.apply(SEEDS_LINE, 'phase_is_a_judgement || truthy(property(task, "apiError"))',
             "gate-ignores-the-goal"), False),
    ("gate-ignores-the-phase",
     m.apply(SEEDS_LINE, 'truthy(property(task, "goal")) || truthy(property(task, "apiError"))',
             "gate-ignores-the-phase"), False),
    ("idle-phase-counts-as-a-judgement",
     m.apply('.is_none_or(|text| text != "idle");', ".is_none_or(|_text| true);",
             "idle-phase-counts-as-a-judgement"), False),
    ("a-non-string-phase-is-not-a-judgement",
     m.apply('.is_none_or(|text| text != "idle");', '.is_some_and(|text| text != "idle");',
             "a-non-string-phase-is-not-a-judgement"), False),
    ("seed-skips-the-gate",
     m.apply("    if !seeds(task) {\n        return None;\n    }\n    Some(payload(task, facts))",
             "    Some(payload(task, facts))", "seed-skips-the-gate"), False),

    # ---- the payload's fields --------------------------------------------------
    ("type-renamed",
     m.apply('JsValue::String(JsString::from_rust_str("task_state"))',
             'JsValue::String(JsString::from_rust_str("task-state"))', "type-renamed"), False),
    ("short-code-key-renamed",
     m.apply('JsString::from_rust_str("taskShortCode"),',
             'JsString::from_rust_str("shortCode"),', "short-code-key-renamed"), False),
    ("short-code-is-never-sent",
     m.apply("JsValue::String(JsString::from_rust_str(&facts.task_short_code)),",
             'JsValue::String(JsString::from_rust_str("")),', "short-code-is-never-sent"), False),
    ("goal-falls-back-to-null-not-empty",
     m.apply('property(next, "goal"),\n                JsValue::String(JsString::from_rust_str("")),',
             'property(next, "goal"),\n                JsValue::Null,',
             "goal-falls-back-to-null-not-empty"), False),
    ("phase-falls-back-to-empty-not-idle",
     m.apply('property(next, "phase"),\n                JsValue::String(JsString::from_rust_str("idle")),',
             'property(next, "phase"),\n                JsValue::String(JsString::from_rust_str("")),',
             "phase-falls-back-to-empty-not-idle"), False),
    ("classify-state-keeps-falsy-values",
     m.apply('or_else(property(next, "classifyState"), JsValue::Null)',
             'property(next, "classifyState").cloned().unwrap_or(JsValue::Null)',
             "classify-state-keeps-falsy-values"), False),
    ("goal-state-echoes-any-value",
     m.apply(".is_some_and(|text| crate::classify_vocab::is_goal_state(&text))",
             ".is_some()", "goal-state-echoes-any-value"), False),
    ("api-error-is-dropped",
     m.apply('or_else(property(next, "apiError"), JsValue::Null)', "JsValue::Null",
             "api-error-is-dropped"), False),
    ("cancelled-at-is-dropped",
     m.apply("or_else(cancelled_at, JsValue::Null),", "JsValue::Null,",
             "cancelled-at-is-dropped"), False),
    ("cancel-reason-outlives-its-timestamp",
     m.apply("""            if truthy(cancelled_at) {
                or_else(property(next, "cancelReason"), JsValue::Null)
            } else {
                JsValue::Null
            },""", '            or_else(property(next, "cancelReason"), JsValue::Null),',
             "cancel-reason-outlives-its-timestamp"), False),

    # ---- the live Aux health reading ---------------------------------------------
    ("aux-unhealthy-is-never-reported",
     m.apply("JsValue::Bool(facts.aux_unhealthy),", "JsValue::Bool(false),",
             "aux-unhealthy-is-never-reported"), False),
    ("record-overrides-the-live-aux-reading",
     m.apply("JsValue::Bool(facts.aux_unhealthy),",
             'or_else(property(next, "auxUnhealthy"), JsValue::Bool(facts.aux_unhealthy)),',
             "record-overrides-the-live-aux-reading"), False),
    ("since-is-sent-while-healthy",
     m.apply("(facts.aux_unhealthy, facts.aux_unhealthy_since.as_ref())",
             "(true, facts.aux_unhealthy_since.as_ref())", "since-is-sent-while-healthy"), False),
    ("since-is-never-sent",
     m.apply("(true, Some(since)) => since.clone(),", "(true, Some(_)) => JsValue::Null,",
             "since-is-never-sent"), False),
    ("since-narrowed-to-strings",
     m.apply("(true, Some(since)) => since.clone(),",
             "(true, Some(JsValue::String(since))) => JsValue::String(since.clone()),",
             "since-narrowed-to-strings"), False),

    # ---- the bridge's reading of its facts -------------------------------------------
    ("bridge-reads-the-short-code-from-the-wrong-key",
     m.apply('task_short_code: property(value, "taskShortCode")',
             'task_short_code: property(value, "shortCode")',
             "bridge-reads-the-short-code-from-the-wrong-key"), False),
    ("bridge-reads-unhealthy-from-the-wrong-key",
     m.apply('aux_unhealthy: truthy(property(value, "auxUnhealthy")),',
             'aux_unhealthy: truthy(property(value, "unhealthy")),',
             "bridge-reads-unhealthy-from-the-wrong-key"), False),
    ("bridge-drops-the-since-reading",
     m.apply('aux_unhealthy_since: property(value, "auxUnhealthySince").cloned(),',
             "aux_unhealthy_since: None,", "bridge-drops-the-since-reading"), False),
    ("seed-bridge-ignores-the-task",
     m.apply('    let task = property(&value, "task");',
             "    let task: Option<&JsValue> = None;", "seed-bridge-ignores-the-task"), False),
]

run_suite(KERNEL, "chat-task-state-frame-corpus.json", "chat_task_state_frame", variants,
          min_tests=6, tag="chat-task-state-frame")
