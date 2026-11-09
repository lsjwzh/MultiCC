//! Pure chat turn-finalization planner.
//!
//! This is the former `src/chat/finalize-plan.js`: it decides whether a runner
//! must continue/retry, which durability boundary a real finalization needs, and
//! the ordered host effects for the terminal path. It performs no I/O and never
//! mutates host state. The host keeps only the effect ports (timers, CLI
//! processes, WebSocket broadcasts, history append, provider-attempt and
//! post-turn owners); those run in exactly the order this module returns.
//!
//! Retry branching reuses [`crate::retry_policy::decide`], the same kernel the
//! host wrapper already called. Finality is decided here with the identical
//! evidence rules as the host-facing `decideChatRunnerFinality` export. The
//! only host-owned input is the clock value used to stamp an accepted retry
//! schedule; the wrapper passes it in, so this module stays deterministic.

use crate::js::{js_to_number, js_to_string, truthy, JsString, JsValue};
use crate::quota_guard::{merge, object, prop, set};
use crate::retry_policy;

const UNDEFINED: JsValue = JsValue::Undefined;

const USER_STOP_REASONS: [&str; 2] = ["user_cancel", "new_user_message"];

fn is_true(value: &JsValue) -> bool {
    matches!(value, JsValue::Bool(true))
}

/// `value == null ? '' : String(value)`.
fn string_or_empty(value: &JsValue) -> JsString {
    if value.is_nullish() {
        JsString::new()
    } else {
        js_to_string(value)
    }
}

/// `value !== undefined && value !== null && value !== '' && value !== false`.
fn has_value(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Bool(flag) => *flag,
        JsValue::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `version === 1 && state === 'completed' && settled === true`.
fn completed(outcome: &JsValue) -> bool {
    matches!(outcome.get("version"), Some(JsValue::Number(number)) if *number == 1.0)
        && matches!(outcome.get("state"), Some(JsValue::String(text)) if text.as_str_lossy() == "completed")
        && outcome.get("settled").map(is_true).unwrap_or(false)
}

fn effect(kind: &str, fields: Vec<(&str, JsValue)>) -> JsValue {
    let mut entries = vec![("type", JsValue::string(kind))];
    entries.extend(fields);
    JsValue::object(entries)
}

fn string_field<'a>(key: &'a str, value: &JsString) -> (&'a str, JsValue) {
    (key, JsValue::String(value.clone()))
}

/// `classifyProcessExit`.
pub fn classify_process_exit(input: &JsValue) -> &'static str {
    let signal = string_or_empty(prop(input, "signal"));
    let kill_reason = string_or_empty(prop(input, "killReason"));
    let code_raw = prop(input, "code");
    let code = if code_raw.is_nullish() {
        0.0
    } else {
        js_to_number(code_raw)
    };
    if !signal.is_empty() {
        return if !kill_reason.is_empty() {
            "killed"
        } else {
            "signaled"
        };
    }
    if code != 0.0 && !is_true(prop(input, "recoveredTransport")) {
        return "nonzero_exit";
    }
    if !is_true(prop(input, "resultDurable")) && !is_true(prop(input, "hasOutput")) {
        return "empty_exit";
    }
    "normal"
}

/// `normalizeHandoff(input)`. `input` is the planner input object (with a
/// `handoff` member), matching the frozen Node function that took `input`.
pub fn normalize_handoff(input: &JsValue) -> JsValue {
    let raw = prop(input, "handoff");
    let handoff = if truthy(raw)
        && matches!(
            raw,
            JsValue::Object(_) | JsValue::Array(_) | JsValue::Bytes(_) | JsValue::Date(_)
        ) {
        raw.clone()
    } else {
        JsValue::object(Vec::<(&str, JsValue)>::new())
    };
    let pending = matches!(
        handoff.get("status"),
        Some(JsValue::String(status)) if status.as_str_lossy() == "pending"
    ) || is_true(prop(&handoff, "pending"));
    object(vec![
        ("pending", JsValue::Bool(pending)),
        (
            "reusedTarget",
            JsValue::Bool(is_true(prop(&handoff, "reusedTarget"))),
        ),
        (
            "toCli",
            JsValue::String(string_or_empty(prop(&handoff, "toCli"))),
        ),
    ])
}

fn fact_string(facts: &JsValue, key: &str) -> JsString {
    match facts.get(key) {
        Some(JsValue::String(text)) => text.clone(),
        _ => JsString::new(),
    }
}

fn fact_true(facts: &JsValue, key: &str) -> bool {
    facts.get(key).map(is_true).unwrap_or(false)
}

fn fact_truthy(facts: &JsValue, key: &str) -> bool {
    facts.get(key).map(truthy).unwrap_or(false)
}

/// `isGuardedHandoffFailure(facts, handoff)`.
pub fn is_guarded_handoff_failure(facts: &JsValue, handoff: &JsValue) -> bool {
    if !fact_truthy(handoff, "pending")
        || !fact_truthy(handoff, "reusedTarget")
        || fact_string(handoff, "toCli") != fact_string(facts, "cli")
    {
        return false;
    }
    let kill_reason = fact_string(facts, "killReason");
    if fact_string(facts, "runnerKind").as_str_lossy() == "stream" {
        // Assistant text or a tool call proves the reused native session
        // resumed: a later failure is an ordinary provider error.
        return !fact_truthy(facts, "resultDurable")
            && !fact_truthy(facts, "hasOutput")
            && !USER_STOP_REASONS
                .iter()
                .any(|reason| kill_reason.as_str_lossy().as_ref() == *reason);
    }
    !fact_truthy(facts, "isRetry")
        && !fact_truthy(facts, "hasOutput")
        && !fact_truthy(facts, "killReason")
        && !fact_truthy(facts, "retryBlockedByAdapterError")
}

fn runner_kind(input: &JsValue) -> &'static str {
    if matches!(prop(input, "runnerKind"), JsValue::String(value) if value.as_str_lossy() == "stream")
    {
        "stream"
    } else {
        "process"
    }
}

fn limits_value(deps: &JsValue) -> JsValue {
    let retry = prop(deps, "retry");
    let source = prop(retry, "limits");
    let mut limits = JsValue::object(vec![
        ("freshStart", JsValue::Number(1.0)),
        ("codexDisconnect", JsValue::Number(2.0)),
        ("interruptedResume", JsValue::Number(10.0)),
    ]);
    if let JsValue::Object(entries) = source {
        for (key, value) in entries {
            set(&mut limits, &key.to_string_lossy(), value.clone());
        }
    }
    limits
}

fn delay_ms(deps: &JsValue, key: &str) -> f64 {
    let retry = prop(deps, "retry");
    let delays = prop(retry, "delays");
    let raw = delays.get(key).cloned().unwrap_or(UNDEFINED);
    let number = if truthy(&raw) {
        js_to_number(&raw)
    } else {
        0.0
    };
    if number.is_nan() {
        f64::NAN
    } else if number <= 0.0 {
        0.0
    } else {
        number
    }
}

/// The host retry wrapper's `schedule()` result: branch fields plus the
/// host-clock stamp. Jitter is never supplied by the planner call sites.
fn schedule_retry(decision: &JsValue, delay_key: &str, deps: &JsValue, now_ms: f64) -> JsValue {
    let delay = delay_ms(deps, delay_key);
    object(vec![
        (
            "action",
            decision.get("action").cloned().unwrap_or(UNDEFINED),
        ),
        (
            "classification",
            decision.get("classification").cloned().unwrap_or(UNDEFINED),
        ),
        (
            "attempt",
            decision.get("attempt").cloned().unwrap_or(UNDEFINED),
        ),
        ("delayMs", JsValue::Number(delay)),
        ("scheduledAt", JsValue::Number(now_ms + delay)),
        ("cap", decision.get("cap").cloned().unwrap_or(UNDEFINED)),
    ])
}

fn attempt_or_zero(input: &JsValue, key: &str) -> JsValue {
    let raw = prop(input, key);
    if truthy(raw) {
        raw.clone()
    } else {
        JsValue::Number(0.0)
    }
}

#[allow(clippy::too_many_arguments)]
fn decide_codex_continuation(
    input: &JsValue,
    cli: &JsString,
    has_output: bool,
    result_durable: bool,
    kill_reason: bool,
    native_session: bool,
    deps: &JsValue,
    now_ms: f64,
) -> JsValue {
    let request = object(vec![
        ("event", JsValue::string("codex-stream-disconnect")),
        ("cli", JsValue::String(cli.clone())),
        ("hasOutput", JsValue::Bool(has_output)),
        ("resultSaved", JsValue::Bool(result_durable)),
        ("killReason", JsValue::Bool(kill_reason)),
        ("hasNativeSession", JsValue::Bool(native_session)),
        (
            "attempts",
            object(vec![(
                "codexDisconnect",
                attempt_or_zero(input, "codexDisconnectAttempt"),
            )]),
        ),
        ("limits", limits_value(deps)),
    ]);
    let decision = retry_policy::decide(&request);
    schedule_retry(&decision, "codexDisconnect", deps, now_ms)
}

fn decide_empty_exit(
    input: &JsValue,
    cli: &JsString,
    is_retry: bool,
    retry_blocked_by_adapter_error: bool,
    kill_reason: bool,
    deps: &JsValue,
    now_ms: f64,
) -> JsValue {
    let request = object(vec![
        ("event", JsValue::string("empty-exit")),
        ("cli", JsValue::String(cli.clone())),
        ("isRetry", JsValue::Bool(is_retry)),
        (
            "adapterError",
            JsValue::Bool(retry_blocked_by_adapter_error),
        ),
        ("killReason", JsValue::Bool(kill_reason)),
        ("guardedHandoff", JsValue::Bool(false)),
        (
            "attempts",
            object(vec![(
                "freshStart",
                attempt_or_zero(input, "freshStartAttempt"),
            )]),
        ),
        ("limits", limits_value(deps)),
    ]);
    let decision = retry_policy::decide(&request);
    schedule_retry(&decision, "freshStart", deps, now_ms)
}

fn retry_effects(action: &str, retry: &JsValue, facts: &JsValue) -> Vec<JsValue> {
    if action == "continue-codex" {
        return vec![
            effect("mark-retry-planned", vec![]),
            effect("reset-codex-disconnect-state", vec![]),
            effect("set-streaming", vec![("value", JsValue::Bool(true))]),
            effect("set-status", vec![("status", JsValue::string("running"))]),
            effect(
                "spawn-codex-continuation",
                vec![
                    (
                        "attempt",
                        retry.get("attempt").cloned().unwrap_or(UNDEFINED),
                    ),
                    ("cap", retry.get("cap").cloned().unwrap_or(UNDEFINED)),
                ],
            ),
        ];
    }
    vec![
        effect(
            "reset-native-session",
            vec![("cli", facts.get("cli").cloned().unwrap_or(UNDEFINED))],
        ),
        effect(
            "persist-native-session-reset",
            vec![("bestEffort", JsValue::Bool(true))],
        ),
        effect("reset-chat-turn-count", vec![]),
        effect("set-streaming", vec![("value", JsValue::Bool(true))]),
        effect("clear-stream-replay", vec![]),
        effect("reset-transport-error", vec![]),
        effect("mark-retry-planned", vec![]),
        effect(
            "spawn-fresh-retry",
            vec![
                (
                    "attempt",
                    retry.get("attempt").cloned().unwrap_or(UNDEFINED),
                ),
                ("cap", retry.get("cap").cloned().unwrap_or(UNDEFINED)),
            ],
        ),
    ]
}

fn api_retry_effects(decision: &JsValue) -> Vec<JsValue> {
    let error = prop(decision, "error");
    let cap = if truthy(error) {
        prop(error, "maxAttempts").clone()
    } else {
        error.clone()
    };
    vec![
        effect("mark-retry-planned", vec![]),
        effect("set-streaming", vec![("value", JsValue::Bool(true))]),
        effect(
            "set-status",
            vec![("status", JsValue::string("retry_wait"))],
        ),
        effect(
            "schedule-api-retry",
            vec![
                (
                    "attempt",
                    decision.get("attempt").cloned().unwrap_or(UNDEFINED),
                ),
                ("cap", cap),
                (
                    "delayMs",
                    decision.get("delayMs").cloned().unwrap_or(UNDEFINED),
                ),
                (
                    "retryAt",
                    decision.get("retryAt").cloned().unwrap_or(UNDEFINED),
                ),
            ],
        ),
    ]
}

/// `decideChatRunnerFinality` reduced to the planner's plain-value evidence.
#[allow(clippy::too_many_arguments)]
fn decide_finality(
    kind: &str,
    result_event: bool,
    kill_reason_truthy: bool,
    retry_planned: bool,
    api_error: bool,
    adapter_error: bool,
    normal_exit: bool,
    is_retry: bool,
) -> (bool, Option<&'static str>) {
    if kill_reason_truthy {
        return (false, Some("explicit_lifecycle_stop"));
    }
    if retry_planned {
        return (false, Some("retry_pending"));
    }
    if api_error {
        return (false, Some("api_error"));
    }
    if adapter_error {
        return (false, Some("adapter_error"));
    }
    if kind == "stream" {
        return if result_event {
            (true, None)
        } else {
            (false, Some("stream_result_event_required"))
        };
    }
    let is_final = result_event || (normal_exit && !is_retry);
    if is_final {
        (true, None)
    } else if is_retry {
        (false, Some("retry_result_event_required"))
    } else {
        (false, Some("clean_exit_required"))
    }
}

/// First stage: no host state is mutated. Returns the frozen-shape plan minus
/// JavaScript freezing (the host wrapper freezes the returned value).
pub fn plan_turn_finalization(input: &JsValue, deps: &JsValue, now_ms: f64) -> JsValue {
    let runner_kind = runner_kind(input);
    let cli_raw = prop(input, "cli");
    let cli = (if truthy(cli_raw) {
        js_to_string(cli_raw)
    } else {
        JsString::from_rust_str(if runner_kind == "stream" {
            "claude"
        } else {
            "codex"
        })
    })
    .to_lowercase();
    let kill_reason = string_or_empty(prop(input, "killReason"));
    let pending_stream_error = has_value(prop(input, "pendingStreamError"));
    let has_output = is_true(prop(input, "hasOutput"));
    let recovered_transport =
        is_true(prop(input, "recoveredTransport")) || (pending_stream_error && has_output);
    let current = is_true(prop(input, "current"));
    let api_error = is_true(prop(input, "apiError"));
    let adapter_error = is_true(prop(input, "adapterError")) && !recovered_transport;
    let retry_planned = is_true(prop(input, "retryPlanned"));
    let retry_unavailable = is_true(prop(input, "retryUnavailable"));
    let retry_unavailable_reason = {
        let raw = prop(input, "retryUnavailableReason");
        if truthy(raw) {
            raw.clone()
        } else {
            JsValue::Null
        }
    };
    let result_event = is_true(prop(input, "resultEvent"));
    let result_durable = is_true(prop(input, "resultDurable"));
    let same_durable_partial = is_true(prop(input, "sameDurablePartial"));
    let is_retry = is_true(prop(input, "isRetry"));
    let native_session = is_true(prop(input, "nativeSession"));
    let replay_safe_provider_error = is_true(prop(input, "replaySafeProviderError"));
    let signal = string_or_empty(prop(input, "signal"));
    let code = {
        let raw = prop(input, "code");
        if raw.is_nullish() {
            0.0
        } else {
            js_to_number(raw)
        }
    };
    let api_error_decision = {
        let raw = prop(input, "apiErrorDecision");
        if truthy(raw) {
            raw.clone()
        } else {
            JsValue::Null
        }
    };
    let completion = {
        let raw = prop(input, "completion");
        if truthy(raw) {
            raw.clone()
        } else {
            object(vec![
                ("version", JsValue::Number(1.0)),
                ("state", JsValue::string("unknown")),
                ("reason", JsValue::string("completion_missing")),
                ("source", JsValue::string("host")),
            ])
        }
    };

    let mut facts = JsValue::object(vec![
        ("completion", completion.clone()),
        ("runnerKind", JsValue::string(runner_kind)),
        string_field("cli", &cli),
        ("current", JsValue::Bool(current)),
        string_field("killReason", &kill_reason),
        ("apiError", JsValue::Bool(api_error)),
        ("adapterError", JsValue::Bool(adapter_error)),
        ("retryPlanned", JsValue::Bool(retry_planned)),
        ("retryUnavailable", JsValue::Bool(retry_unavailable)),
        ("retryUnavailableReason", retry_unavailable_reason),
        ("resultEvent", JsValue::Bool(result_event)),
        ("resultDurable", JsValue::Bool(result_durable)),
        ("hasOutput", JsValue::Bool(has_output)),
        ("sameDurablePartial", JsValue::Bool(same_durable_partial)),
        ("isRetry", JsValue::Bool(is_retry)),
        ("recoveredTransport", JsValue::Bool(recovered_transport)),
        ("pendingStreamError", JsValue::Bool(pending_stream_error)),
        ("nativeSession", JsValue::Bool(native_session)),
        (
            "replaySafeProviderError",
            JsValue::Bool(replay_safe_provider_error),
        ),
        string_field("signal", &signal),
        ("code", JsValue::Number(code)),
        ("apiErrorDecision", api_error_decision.clone()),
    ]);
    let retry_blocked_by_adapter_error =
        is_true(prop(input, "retryBlockedByAdapterError")) || adapter_error;
    set(
        &mut facts,
        "retryBlockedByAdapterError",
        JsValue::Bool(retry_blocked_by_adapter_error),
    );

    if !current {
        return object(vec![
            ("action", JsValue::string("noop")),
            ("code", JsValue::string("stale_runner")),
            ("facts", facts),
            ("effects", JsValue::Array(Vec::new())),
        ]);
    }

    let exit_kind = if runner_kind == "process" {
        classify_process_exit(&object(vec![
            string_field("signal", &signal),
            string_field("killReason", &kill_reason),
            ("code", JsValue::Number(code)),
            ("recoveredTransport", JsValue::Bool(recovered_transport)),
            ("resultDurable", JsValue::Bool(result_durable)),
            ("hasOutput", JsValue::Bool(has_output)),
        ]))
    } else {
        "stream_end"
    };
    set(&mut facts, "exitKind", JsValue::string(exit_kind));
    let handoff = normalize_handoff(input);
    set(&mut facts, "handoff", handoff.clone());
    let guarded_handoff_resume_failure =
        is_guarded_handoff_failure(&facts, &handoff) && !replay_safe_provider_error;
    set(
        &mut facts,
        "guardedHandoffResumeFailure",
        JsValue::Bool(guarded_handoff_resume_failure),
    );

    if !retry_unavailable
        && runner_kind == "process"
        && cli.as_str_lossy() == "codex"
        && pending_stream_error
    {
        let retry = decide_codex_continuation(
            input,
            &cli,
            has_output,
            result_durable,
            !kill_reason.is_empty(),
            native_session,
            deps,
            now_ms,
        );
        let resumes = matches!(
            retry.get("action"),
            Some(JsValue::String(action)) if action.as_str_lossy() == "resume"
        );
        if resumes {
            return object(vec![
                ("action", JsValue::string("continue-codex")),
                ("code", JsValue::Null),
                ("facts", facts.clone()),
                ("retry", retry.clone()),
                (
                    "effects",
                    JsValue::Array(retry_effects("continue-codex", &retry, &facts)),
                ),
            ]);
        }
    }

    let api_retry = !retry_unavailable
        && !guarded_handoff_resume_failure
        && matches!(
            api_error_decision.get("action"),
            Some(JsValue::String(action)) if action.as_str_lossy() == "retry"
        );
    if api_retry {
        return object(vec![
            ("action", JsValue::string("retry-api")),
            ("code", JsValue::Null),
            ("facts", facts.clone()),
            ("retry", api_error_decision.clone()),
            (
                "effects",
                JsValue::Array(api_retry_effects(&api_error_decision)),
            ),
        ]);
    }

    if !retry_unavailable
        && runner_kind == "process"
        && !guarded_handoff_resume_failure
        && !api_error
        && !has_output
        && kill_reason.is_empty()
        && !retry_blocked_by_adapter_error
        && !is_retry
    {
        let retry = decide_empty_exit(
            input,
            &cli,
            is_retry,
            retry_blocked_by_adapter_error,
            !kill_reason.is_empty(),
            deps,
            now_ms,
        );
        let retries = matches!(
            retry.get("action"),
            Some(JsValue::String(action)) if action.as_str_lossy() == "retry-fresh"
        );
        if retries {
            return object(vec![
                ("action", JsValue::string("retry-fresh")),
                ("code", JsValue::Null),
                ("facts", facts.clone()),
                ("retry", retry.clone()),
                (
                    "effects",
                    JsValue::Array(retry_effects("retry-fresh", &retry, &facts)),
                ),
            ]);
        }
    }

    let finality_adapter_error = adapter_error || !completed(&completion);
    let (is_final, finality_code) = decide_finality(
        runner_kind,
        result_event,
        !kill_reason.is_empty(),
        retry_planned,
        api_error,
        finality_adapter_error,
        exit_kind == "normal",
        is_retry,
    );
    let append_required = !result_durable && has_output && (result_event || !same_durable_partial);
    let append = object(vec![
        ("required", JsValue::Bool(append_required)),
        ("boundary", JsValue::string("close")),
        ("final", JsValue::Bool(append_required && is_final)),
        ("partial", JsValue::Bool(append_required && !is_final)),
        (
            "checkpointRequired",
            JsValue::Bool(append_required && !is_final),
        ),
        ("requiredForPostTurn", JsValue::Bool(true)),
        (
            "finalityCode",
            finality_code.map(JsValue::string).unwrap_or(JsValue::Null),
        ),
    ]);

    object(vec![
        ("action", JsValue::string("finalize")),
        ("code", JsValue::Null),
        ("facts", facts),
        ("append", append),
        ("effects", JsValue::Array(Vec::new())),
    ])
}

/// A retry attempt can fail after a continuation was selected. Re-plan through
/// an explicit terminal disposition instead of copying retry counters.
pub fn plan_retry_blocked_finalization(source_plan: &JsValue, overrides: &JsValue) -> JsValue {
    let facts_value = if truthy(source_plan) {
        match source_plan.get("facts") {
            Some(facts @ JsValue::Object(_)) => facts.clone(),
            _ => object(Vec::<(&str, JsValue)>::new()),
        }
    } else {
        object(Vec::<(&str, JsValue)>::new())
    };
    let overrides_value = match overrides {
        JsValue::Object(_) => overrides.clone(),
        _ => object(Vec::<(&str, JsValue)>::new()),
    };
    let mut merged = merge(&facts_value, &overrides_value);
    let handoff = {
        let from_overrides = prop(&overrides_value, "handoff");
        if truthy(from_overrides) {
            from_overrides.clone()
        } else {
            prop(&facts_value, "handoff").clone()
        }
    };
    set(&mut merged, "handoff", handoff);
    set(&mut merged, "apiError", JsValue::Bool(true));
    set(&mut merged, "apiErrorDecision", JsValue::Null);
    set(&mut merged, "retryPlanned", JsValue::Bool(false));
    set(&mut merged, "retryUnavailable", JsValue::Bool(true));
    let reason = {
        let raw = prop(&overrides_value, "retryUnavailableReason");
        if truthy(raw) {
            raw.clone()
        } else {
            JsValue::string("retry_unavailable")
        }
    };
    set(&mut merged, "retryUnavailableReason", reason);
    plan_turn_finalization(&merged, &object(Vec::<(&str, JsValue)>::new()), 0.0)
}

fn status_effects(facts: &JsValue, durable_after_append: bool) -> Vec<JsValue> {
    let kill_reason = fact_string(facts, "killReason");
    let kill_truthy = !kill_reason.is_empty();
    let kill_field = if kill_truthy {
        JsValue::String(kill_reason.clone())
    } else {
        JsValue::Null
    };
    let turn_end = |classification: &str| {
        effect(
            "classify-turn-end",
            vec![
                ("classification", JsValue::string(classification)),
                ("killReason", kill_field.clone()),
            ],
        )
    };
    let completion = facts.get("completion").cloned().unwrap_or(UNDEFINED);
    if !fact_true(facts, "apiError")
        && !kill_truthy
        && !fact_true(facts, "guardedHandoffResumeFailure")
        && !completed(&completion)
    {
        let completion_state = match completion.get("state") {
            Some(JsValue::String(text)) => text.clone(),
            _ => JsString::new(),
        };
        let freeze_reason = if completion_state.as_str_lossy() == "failed" {
            "error"
        } else if completion_state.as_str_lossy() == "cancelled" {
            "cancelled"
        } else {
            "unknown_interruption"
        };
        let classification = if completion_state.as_str_lossy() == "unknown" {
            "unknown-interruption"
        } else {
            "interrupted"
        };
        return vec![
            effect(
                "set-status",
                vec![
                    ("status", JsValue::string("waiting")),
                    ("reason", JsValue::string("runner-not-completed")),
                ],
            ),
            effect(
                "freeze-interrupted",
                vec![("reason", JsValue::string(freeze_reason))],
            ),
            turn_end(classification),
        ];
    }
    if fact_string(facts, "runnerKind").as_str_lossy() == "process" {
        if kill_truthy {
            let freeze_reason = if kill_reason.as_str_lossy() == "user_cancel" {
                "cancelled"
            } else {
                "interrupted"
            };
            return vec![
                effect(
                    "set-status",
                    vec![
                        ("status", JsValue::string("waiting")),
                        ("reason", JsValue::string("explicit-kill")),
                    ],
                ),
                effect(
                    "freeze-interrupted",
                    vec![("reason", JsValue::string(freeze_reason))],
                ),
                turn_end("interrupted"),
            ];
        }
        let exit_kind = fact_string(facts, "exitKind");
        let fault = fact_true(facts, "apiError")
            || fact_true(facts, "adapterError")
            || exit_kind.as_str_lossy() == "nonzero_exit"
            || exit_kind.as_str_lossy() == "signaled";
        if fault {
            return vec![
                effect(
                    "freeze-interrupted",
                    vec![("reason", JsValue::string("error"))],
                ),
                turn_end(if fact_true(facts, "apiError") {
                    "api-error"
                } else {
                    "interrupted"
                }),
            ];
        }
        if durable_after_append {
            return vec![
                effect("complete-session-turn", vec![]),
                effect(
                    "classify-turn-end",
                    vec![
                        ("classification", JsValue::string("succeeded")),
                        ("killReason", JsValue::Null),
                    ],
                ),
            ];
        }
        return vec![
            effect(
                "set-status",
                vec![
                    ("status", JsValue::string("waiting")),
                    ("reason", JsValue::String(exit_kind)),
                ],
            ),
            effect(
                "freeze-interrupted",
                vec![("reason", JsValue::string("unknown_interruption"))],
            ),
            turn_end("unknown-interruption"),
        ];
    }

    if fact_true(facts, "guardedHandoffResumeFailure") {
        return vec![
            effect("reset-interrupted-resume", vec![]),
            effect(
                "set-status",
                vec![
                    ("status", JsValue::string("idle")),
                    ("reason", JsValue::string("handoff-resume-failed")),
                ],
            ),
            effect(
                "freeze-interrupted",
                vec![("reason", JsValue::string("handoff_resume_failed"))],
            ),
            turn_end("handoff-resume-failed"),
            effect(
                "report-handoff-resume-failure",
                vec![("preserveHandoff", JsValue::Bool(true))],
            ),
        ];
    }
    if fact_true(facts, "apiError") {
        return vec![
            effect(
                "freeze-interrupted",
                vec![("reason", JsValue::string("error"))],
            ),
            turn_end("api-error"),
        ];
    }
    if durable_after_append {
        return vec![
            effect("reset-interrupted-resume", vec![]),
            effect("complete-session-turn", vec![]),
            turn_end("succeeded"),
            effect(
                "emit-turn-outcome",
                vec![
                    ("status", JsValue::string("succeeded")),
                    ("notifyState", JsValue::string("succeeded")),
                ],
            ),
        ];
    }
    if fact_true(facts, "resultEvent") {
        return vec![
            effect(
                "set-status",
                vec![
                    ("status", JsValue::string("idle")),
                    ("reason", JsValue::string("result-not-durable")),
                ],
            ),
            effect(
                "freeze-interrupted",
                vec![("reason", JsValue::string("message_not_durable"))],
            ),
            turn_end("result-not-durable"),
            effect("report-result-persistence-failure", vec![]),
        ];
    }
    if !kill_truthy {
        return vec![
            effect(
                "set-status",
                vec![
                    ("status", JsValue::string("waiting")),
                    ("reason", JsValue::string("unknown-interruption")),
                ],
            ),
            effect(
                "freeze-interrupted",
                vec![("reason", JsValue::string("unknown_interruption"))],
            ),
            turn_end("unknown-interruption"),
        ];
    }
    let freeze_reason = if kill_reason.as_str_lossy() == "user_cancel" {
        "cancelled"
    } else {
        "interrupted"
    };
    vec![
        effect(
            "set-status",
            vec![
                ("status", JsValue::string("waiting")),
                ("reason", JsValue::string("explicit-kill")),
            ],
        ),
        effect(
            "freeze-interrupted",
            vec![("reason", JsValue::string(freeze_reason))],
        ),
        turn_end("interrupted"),
    ]
}

/// Second stage: `appendFinal` has returned, so the host can resolve status and
/// post-turn guards without inventing a durability proof.
pub fn resolve_turn_finalization(plan: &JsValue, outcome: &JsValue) -> JsValue {
    let action_truthy = truthy(plan) && truthy(prop(plan, "action"));
    let is_finalize = matches!(
        prop(plan, "action"),
        JsValue::String(action) if action.as_str_lossy() == "finalize"
    );
    if !truthy(plan) || !is_finalize {
        let action = if action_truthy {
            prop(plan, "action").clone()
        } else {
            JsValue::string("noop")
        };
        let code = if truthy(plan) && truthy(prop(plan, "code")) {
            prop(plan, "code").clone()
        } else {
            JsValue::string("finalize_plan_required")
        };
        let facts = if truthy(plan) && truthy(prop(plan, "facts")) {
            prop(plan, "facts").clone()
        } else {
            object(Vec::<(&str, JsValue)>::new())
        };
        return object(vec![
            ("action", action),
            ("code", code),
            ("facts", facts),
            ("effects", JsValue::Array(Vec::new())),
        ]);
    }

    let facts = match plan.get("facts") {
        Some(value @ JsValue::Object(_)) => value.clone(),
        _ => object(Vec::<(&str, JsValue)>::new()),
    };
    let durable_after_append =
        is_true(prop(outcome, "resultDurable")) || fact_truthy(&facts, "resultDurable");
    let append_persisted = is_true(prop(outcome, "appendPersisted"));
    let is_stream = fact_string(&facts, "runnerKind").as_str_lossy() == "stream";
    let is_process = !is_stream;
    let kill_truthy = fact_truthy(&facts, "killReason");
    let result_event = fact_true(&facts, "resultEvent");

    let mut effects: Vec<JsValue> = Vec::new();
    effects.push(effect(
        "set-streaming",
        vec![("value", JsValue::Bool(false))],
    ));
    if is_stream {
        effects.push(effect("cancel-classify", vec![]));
    }
    effects.push(effect("clear-stream-replay", vec![]));

    if is_process
        && fact_true(&facts, "isRetry")
        && !fact_true(&facts, "hasOutput")
        && !fact_truthy(&facts, "apiErrorDecision")
        && !fact_true(&facts, "adapterError")
    {
        effects.push(effect("report-empty-retry-failure", vec![]));
    }
    if is_process && fact_true(&facts, "guardedHandoffResumeFailure") {
        effects.push(effect(
            "report-handoff-resume-failure",
            vec![("preserveHandoff", JsValue::Bool(true))],
        ));
    }
    if is_process {
        effects.push(effect("clear-active-process", vec![]));
        effects.push(effect("clear-incremental-save", vec![]));
    }

    let append = plan.get("append").cloned().unwrap_or(UNDEFINED);
    let append_required = append.get("required").map(truthy).unwrap_or(false);
    if append_required {
        effects.push(effect(
            "append-assistant-result",
            vec![
                (
                    "boundary",
                    append.get("boundary").cloned().unwrap_or(UNDEFINED),
                ),
                ("final", append.get("final").cloned().unwrap_or(UNDEFINED)),
                (
                    "partial",
                    append.get("partial").cloned().unwrap_or(UNDEFINED),
                ),
                (
                    "checkpointRequired",
                    append
                        .get("checkpointRequired")
                        .cloned()
                        .unwrap_or(UNDEFINED),
                ),
            ],
        ));
        effects.push(effect(
            "increment-chat-turn-count",
            vec![("when", JsValue::string("append-persisted"))],
        ));
    }

    if durable_after_append {
        effects.push(effect(
            "commit-usage",
            vec![
                ("when", JsValue::string("result-durable")),
                ("exactlyOnce", JsValue::Bool(true)),
            ],
        ));
    }

    if is_stream {
        effects.push(effect("clear-incremental-save", vec![]));
    }
    if is_process && result_event && !durable_after_append {
        effects.push(effect("report-result-persistence-failure", vec![]));
    }
    if is_process && fact_true(&facts, "recoveredTransport") && durable_after_append {
        effects.push(effect("emit-synthetic-result", vec![]));
    }

    effects.push(effect("capture-final-text", vec![]));
    effects.push(effect(
        "reset-turn-output",
        vec![
            ("clearAdapterError", JsValue::Bool(is_process)),
            ("clearTransportState", JsValue::Bool(is_process)),
        ],
    ));
    effects.extend(status_effects(&facts, durable_after_append));
    effects.push(effect("stream-end", vec![]));

    let completion = facts.get("completion").cloned().unwrap_or(UNDEFINED);
    let exit_kind = fact_string(&facts, "exitKind");
    let interrupted = if is_stream {
        !durable_after_append || kill_truthy
    } else {
        kill_truthy
            || fact_true(&facts, "adapterError")
            || (!result_event && exit_kind.as_str_lossy() != "normal")
    };
    effects.push(effect(
        "run-post-turn",
        vec![
            (
                "guard",
                JsValue::string("current-runner-and-durable-final-result"),
            ),
            (
                "interrupted",
                JsValue::Bool(interrupted || !completed(&completion)),
            ),
            ("apiError", JsValue::Bool(fact_true(&facts, "apiError"))),
            (
                "retryPlanned",
                JsValue::Bool(fact_true(&facts, "retryPlanned")),
            ),
            (
                "handoffResumeFailure",
                JsValue::Bool(fact_true(&facts, "guardedHandoffResumeFailure")),
            ),
        ],
    ));
    effects.push(effect("clear-active-runner", vec![]));

    let code = if durable_after_append {
        JsValue::Null
    } else if result_event {
        JsValue::string("result_not_durable")
    } else {
        JsValue::Null
    };
    object(vec![
        ("action", JsValue::string("finalize")),
        ("code", code),
        ("facts", facts),
        ("append", append),
        (
            "result",
            object(vec![
                ("durableAfterAppend", JsValue::Bool(durable_after_append)),
                ("appendPersisted", JsValue::Bool(append_persisted)),
            ]),
        ),
        ("effects", JsValue::Array(effects)),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> JsValue {
        object(vec![
            (
                "completion",
                object(vec![
                    ("version", JsValue::Number(1.0)),
                    ("state", JsValue::string("completed")),
                    ("settled", JsValue::Bool(true)),
                ]),
            ),
            ("current", JsValue::Bool(true)),
            ("runnerKind", JsValue::string("process")),
            ("cli", JsValue::string("codex")),
            ("code", JsValue::Number(0.0)),
            ("signal", JsValue::Null),
            ("hasOutput", JsValue::Bool(true)),
            ("resultEvent", JsValue::Bool(true)),
            ("resultDurable", JsValue::Bool(false)),
        ])
    }

    fn with(mut value: JsValue, key: &str, member: JsValue) -> JsValue {
        set(&mut value, key, member);
        value
    }

    fn effect_types(value: &JsValue) -> Vec<String> {
        match value.get("effects") {
            Some(JsValue::Array(items)) => items
                .iter()
                .map(|item| {
                    item.get("type")
                        .map(|kind| js_to_string(kind).to_string_lossy())
                        .unwrap_or_default()
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    #[test]
    fn process_exit_classification_preserves_distinctions() {
        let killed = object(vec![
            ("signal", JsValue::string("SIGTERM")),
            ("killReason", JsValue::string("user_cancel")),
        ]);
        assert_eq!(classify_process_exit(&killed), "killed");
        let signaled = object(vec![("signal", JsValue::string("SIGTERM"))]);
        assert_eq!(classify_process_exit(&signaled), "signaled");
        let nonzero = object(vec![
            ("code", JsValue::Number(1.0)),
            ("hasOutput", JsValue::Bool(true)),
        ]);
        assert_eq!(classify_process_exit(&nonzero), "nonzero_exit");
        let recovered = object(vec![
            ("code", JsValue::Number(1.0)),
            ("hasOutput", JsValue::Bool(true)),
            ("recoveredTransport", JsValue::Bool(true)),
        ]);
        assert_eq!(classify_process_exit(&recovered), "normal");
        let empty = object(vec![
            ("code", JsValue::Number(0.0)),
            ("hasOutput", JsValue::Bool(false)),
            ("resultDurable", JsValue::Bool(false)),
        ]);
        assert_eq!(classify_process_exit(&empty), "empty_exit");
        let durable = object(vec![
            ("code", JsValue::Number(0.0)),
            ("hasOutput", JsValue::Bool(false)),
            ("resultDurable", JsValue::Bool(true)),
        ]);
        assert_eq!(classify_process_exit(&durable), "normal");
    }

    #[test]
    fn stale_runner_is_a_deterministic_noop() {
        let plan = plan_turn_finalization(
            &with(base(), "current", JsValue::Bool(false)),
            &object(Vec::<(&str, JsValue)>::new()),
            0.0,
        );
        assert_eq!(
            plan.get("action")
                .map(js_to_string)
                .map(|s| s.to_string_lossy()),
            Some("noop".into())
        );
        assert_eq!(
            plan.get("code")
                .map(js_to_string)
                .map(|s| s.to_string_lossy()),
            Some("stale_runner".into())
        );
        assert!(effect_types(&plan).is_empty());
    }

    #[test]
    fn empty_exit_gets_one_fresh_retry_with_ordered_effects() {
        let input = with(
            with(base(), "hasOutput", JsValue::Bool(false)),
            "resultEvent",
            JsValue::Bool(false),
        );
        let plan = plan_turn_finalization(&input, &object(Vec::<(&str, JsValue)>::new()), 5.0);
        assert_eq!(
            plan.get("action")
                .map(js_to_string)
                .map(|s| s.to_string_lossy()),
            Some("retry-fresh".into())
        );
        assert_eq!(
            effect_types(&plan),
            vec![
                "reset-native-session",
                "persist-native-session-reset",
                "reset-chat-turn-count",
                "set-streaming",
                "clear-stream-replay",
                "reset-transport-error",
                "mark-retry-planned",
                "spawn-fresh-retry",
            ]
        );
        let retry = plan.get("retry").expect("retry");
        assert_eq!(retry.get("attempt").map(js_to_number), Some(1.0));
        assert_eq!(retry.get("scheduledAt").map(js_to_number), Some(5.0));
    }

    #[test]
    fn stream_finality_requires_a_result_event() {
        let input = with(
            with(base(), "runnerKind", JsValue::string("stream")),
            "cli",
            JsValue::string("claude"),
        );
        let plan = plan_turn_finalization(&input, &object(Vec::<(&str, JsValue)>::new()), 0.0);
        let append = plan.get("append").expect("append");
        assert_eq!(append.get("final"), Some(&JsValue::Bool(true)));
        let missing = with(input.clone(), "resultEvent", JsValue::Bool(false));
        let plan = plan_turn_finalization(&missing, &object(Vec::<(&str, JsValue)>::new()), 0.0);
        assert_eq!(
            plan.get("append").unwrap().get("final"),
            Some(&JsValue::Bool(false))
        );
    }

    #[test]
    fn resolve_orders_append_usage_classification_and_post_turn() {
        let plan = plan_turn_finalization(&base(), &object(Vec::<(&str, JsValue)>::new()), 0.0);
        let outcome = object(vec![
            ("appendPersisted", JsValue::Bool(true)),
            ("resultDurable", JsValue::Bool(true)),
        ]);
        let resolved = resolve_turn_finalization(&plan, &outcome);
        let types = effect_types(&resolved);
        let at = |needle: &str| types.iter().position(|kind| kind == needle).expect(needle);
        assert!(at("clear-incremental-save") < at("append-assistant-result"));
        assert!(at("append-assistant-result") < at("commit-usage"));
        assert!(at("commit-usage") < at("capture-final-text"));
        assert!(at("reset-turn-output") < at("complete-session-turn"));
        assert!(at("complete-session-turn") < at("classify-turn-end"));
        assert!(at("classify-turn-end") < at("stream-end"));
        assert!(at("stream-end") < at("run-post-turn"));
        assert_eq!(
            types.last().map(String::as_str),
            Some("clear-active-runner")
        );
        assert_eq!(resolved.get("code"), Some(&JsValue::Null));
    }

    #[test]
    fn blocked_retry_replans_as_a_terminal_disposition() {
        let input = with(
            with(
                with(base(), "pendingStreamError", JsValue::string("disconnect")),
                "nativeSession",
                JsValue::Bool(true),
            ),
            "resultEvent",
            JsValue::Bool(false),
        );
        let input = with(input, "codexDisconnectAttempt", JsValue::Number(1.0));
        let plan = plan_turn_finalization(&input, &object(Vec::<(&str, JsValue)>::new()), 0.0);
        assert_eq!(
            plan.get("action")
                .map(js_to_string)
                .map(|s| s.to_string_lossy()),
            Some("continue-codex".into())
        );
        let overrides = object(vec![(
            "retryUnavailableReason",
            JsValue::string("run_not_active"),
        )]);
        let blocked = plan_retry_blocked_finalization(&plan, &overrides);
        assert_eq!(
            blocked
                .get("action")
                .map(js_to_string)
                .map(|s| s.to_string_lossy()),
            Some("finalize".into())
        );
        let facts = blocked.get("facts").expect("facts");
        assert_eq!(facts.get("retryUnavailable"), Some(&JsValue::Bool(true)));
        assert_eq!(
            facts
                .get("retryUnavailableReason")
                .map(js_to_string)
                .map(|s| s.to_string_lossy()),
            Some("run_not_active".into())
        );
        assert_eq!(facts.get("apiError"), Some(&JsValue::Bool(true)));
        assert!(!effect_types(&blocked).contains(&"mark-retry-planned".to_string()));
    }

    #[test]
    fn guarded_handoff_fails_closed_and_never_falls_through_to_fresh_retry() {
        let input = with(
            with(base(), "hasOutput", JsValue::Bool(false)),
            "resultEvent",
            JsValue::Bool(false),
        );
        let input = with(
            input,
            "handoff",
            object(vec![
                ("status", JsValue::string("pending")),
                ("reusedTarget", JsValue::Bool(true)),
                ("toCli", JsValue::string("codex")),
            ]),
        );
        let plan = plan_turn_finalization(&input, &object(Vec::<(&str, JsValue)>::new()), 0.0);
        assert_eq!(
            plan.get("action")
                .map(js_to_string)
                .map(|s| s.to_string_lossy()),
            Some("finalize".into())
        );
        assert_eq!(
            plan.get("facts")
                .unwrap()
                .get("guardedHandoffResumeFailure"),
            Some(&JsValue::Bool(true))
        );
        let resolved = resolve_turn_finalization(&plan, &object(Vec::<(&str, JsValue)>::new()));
        let types = effect_types(&resolved);
        assert!(!types.contains(&"spawn-fresh-retry".to_string()));
        assert!(types.contains(&"report-handoff-resume-failure".to_string()));
        assert_eq!(
            types.last().map(String::as_str),
            Some("clear-active-runner")
        );
        let post_turn = resolved
            .get("effects")
            .and_then(|effects| match effects {
                JsValue::Array(items) => items
                    .iter()
                    .find(|item| matches!(item.get("type"), Some(JsValue::String(kind)) if kind.as_str_lossy() == "run-post-turn")),
                _ => None,
            })
            .expect("run-post-turn");
        assert_eq!(
            post_turn.get("handoffResumeFailure"),
            Some(&JsValue::Bool(true))
        );
    }
}
