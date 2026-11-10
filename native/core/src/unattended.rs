//! Unattended mode — the pure decision kernel behind `src/unattended/`.
//!
//! Unattended mode replaces Goal mode: after every finished turn (classify
//! letter D or W) an Aux model is asked whether the goal was reached. This
//! module owns everything that must not drift between the HTTP surface, the
//! supervisor loop and the persisted `record.unattended` state:
//!   * [`normalize_config`] — goal/criteria/maxDurationMinutes caps and defaults;
//!   * [`clamp_duration`], [`arm_deadline`], [`deadline_expired`] — the pure
//!     wall-clock supervision math (the round budget no longer exists; `rounds`
//!     is an informational counter only);
//!   * [`build_verdict_prompt`] — the verdict prompt, including the *exact*
//!     definition of "a human is really required";
//!   * [`parse_verdict`] — tolerant JSON extraction (code fences, prose), never
//!     panics and always returns a JSON envelope;
//!   * [`decide`] — the next state/action: stall (same normalized instruction
//!     three times), consecutive Aux failures (two → `error`), history cap and
//!     string caps.
//!
//! All entry points take and return JSON strings because the addon exposes them
//! as plain napi functions (`unattendedNormalizeConfig`, ...); `serde_json` is
//! built with `preserve_order`, so the canonical field order of the persisted
//! state survives the round trip.
use crate::js::{js_trim, utf16_truncate};
use serde_json::{json, Map, Value};

/// The one marker every supervisor-inserted message carries. Bilingual and
/// language-agnostic so history, classify and both UIs can recognise it; the
/// addon exports it (`unattendedTag`) and Web/Flutter hard-code the same literal.
pub const UNATTENDED_TAG: &str = "[无人值守 Unattended]";

pub const MAX_GOAL_CHARS: usize = 2000;
pub const MAX_CRITERIA: usize = 12;
pub const MAX_CRITERION_CHARS: usize = 300;
/// Wall-clock supervision budget. `maxDurationMinutes` replaces the old round
/// budget; out-of-range values are clamped, never rejected.
pub const MAX_DURATION_DEFAULT: i64 = 120;
pub const MAX_DURATION_MIN: i64 = 5;
pub const MAX_DURATION_LIMIT: i64 = 1440;
pub const MS_PER_MINUTE: i64 = 60_000;
/// An `update` whose recomputed deadline already passed is clamped this far ahead.
pub const EXPIRY_CLAMP_MS: i64 = 60_000;
pub const HISTORY_MAX: usize = 10;
pub const STALL_LIMIT: u32 = 3;
pub const AUX_FAILURE_LIMIT: u32 = 2;
/// Consecutive fault-E continuations before the supervisor asks a human.
pub const FAULT_LIMIT: u32 = 3;

const MAX_REASON_CHARS: usize = 1000;
const MAX_INSTRUCTION_CHARS: usize = 4000;
const MAX_HUMAN_REASON_CHARS: usize = 1000;
const MAX_ANSWER_CHARS: usize = 4000;
const MAX_LAST_OUTPUT_CHARS: usize = 8000;
const MAX_RECENT_MESSAGES: usize = 8;
const MAX_RECENT_MESSAGE_CHARS: usize = 1500;
const MAX_PENDING_OPTIONS: usize = 12;
const MAX_PENDING_OPTION_CHARS: usize = 300;
const MAX_PROMPT_HISTORY: usize = HISTORY_MAX;

/// The fault-E instruction. It deliberately only asks to resume and verify;
/// redoing side effects is exactly what a retry must not do blindly.
const FAULT_INSTRUCTION: &str = "The previous turn was interrupted by an upstream fault. Resume from \
where it stopped: first verify the current state (files, running commands, partial results) and which \
side effects already happened, then continue. Never redo writes, commits or external calls that may \
already have completed.";

pub const STATUSES: [&str; 6] = [
    "active",
    "achieved",
    "needs_human",
    "exhausted",
    "stopped",
    "error",
];
pub const VERDICTS: [&str; 3] = ["achieved", "continue", "needs_human"];

// ── small helpers ───────────────────────────────────────────────────────────

fn clamp_text(value: &str, max: usize) -> String {
    utf16_truncate(js_trim(value), max)
}

fn value_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(true)) => "true".to_string(),
        Some(Value::Bool(false)) => String::new(),
        Some(Value::Number(number)) => number.to_string(),
        Some(_) => String::new(),
    }
}

fn field<'a>(container: &'a Value, key: &str) -> Option<&'a Value> {
    container.as_object().and_then(|object| object.get(key))
}

fn int_value(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number.as_i64().or_else(|| {
            let float = number.as_f64()?;
            if float.is_finite() && float.fract() == 0.0 {
                Some(float as i64)
            } else {
                None
            }
        }),
        Some(Value::String(text)) => {
            let trimmed = js_trim(text);
            if trimmed.is_empty() {
                return None;
            }
            trimmed.parse::<i64>().ok().or_else(|| {
                // `parseInt('12abc')` used to accept the prefix.
                let digits: String = trimmed
                    .chars()
                    .take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '+')
                    .collect();
                digits.parse::<i64>().ok()
            })
        }
        Some(Value::Bool(true)) => Some(1),
        Some(Value::Bool(false)) => Some(0),
        _ => None,
    }
}

fn u32_value(value: Option<&Value>) -> u32 {
    int_value(value).unwrap_or(0).max(0) as u32
}

/// Default 120 minutes, clamped to `[5, 1440]`. Legacy `maxRounds` is never read.
fn clamp_duration_minutes(value: Option<&Value>) -> i64 {
    int_value(value)
        .unwrap_or(MAX_DURATION_DEFAULT)
        .clamp(MAX_DURATION_MIN, MAX_DURATION_LIMIT)
}

/// Collapse whitespace and casefold — the equality used by the stall guard.
fn normalized_instruction(text: &str) -> String {
    js_trim(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Remove any marker the Aux model produced itself. The tag is added by code,
/// never by the model, so an emitted one must not be duplicated.
pub fn strip_tag(text: &str) -> String {
    js_trim(&text.replace(UNATTENDED_TAG, " ")).to_string()
}

fn clean_text(value: Option<&Value>, max: usize) -> String {
    clamp_text(&strip_tag(&value_text(value)), max)
}

fn parse_verdict_from_value(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let verdict = object
        .get("verdict")
        .and_then(Value::as_str)
        .map(|text| js_trim(text).to_lowercase())?;
    if !VERDICTS.contains(&verdict.as_str()) {
        return None;
    }
    let reason = clean_text(object.get("reason"), MAX_REASON_CHARS);
    let next_instruction = clean_text(object.get("nextInstruction"), MAX_INSTRUCTION_CHARS);
    let human_reason = clean_text(object.get("humanReason"), MAX_HUMAN_REASON_CHARS);
    let answer = clean_text(object.get("answer"), MAX_ANSWER_CHARS);
    if verdict == "continue" && next_instruction.is_empty() {
        // A "continue" with no instruction cannot drive the session; treating
        // it as a valid verdict would burn a round and inject nothing.
        return None;
    }
    let mut out = Map::new();
    out.insert("verdict".to_string(), Value::String(verdict));
    out.insert("reason".to_string(), Value::String(reason));
    out.insert(
        "nextInstruction".to_string(),
        Value::String(next_instruction),
    );
    out.insert("humanReason".to_string(), Value::String(human_reason));
    out.insert("answer".to_string(), Value::String(answer));
    Some(Value::Object(out))
}

// ── normalizeConfig ─────────────────────────────────────────────────────────

/// Clamp a start/update config. Returns `{ ok:true, config }` or
/// `{ ok:false, error:'goal_required' }`.
pub fn normalize_config(input: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|error| format!("unattended_invalid_input: {error}"))?;
    let goal = clamp_text(&value_text(field(&value, "goal")), MAX_GOAL_CHARS);
    let mut criteria = Vec::new();
    if let Some(items) = field(&value, "criteria").and_then(Value::as_array) {
        for item in items {
            let text = clamp_text(&value_text(Some(item)), MAX_CRITERION_CHARS);
            if !text.is_empty() && !criteria.contains(&Value::String(text.clone())) {
                criteria.push(Value::String(text));
                if criteria.len() >= MAX_CRITERIA {
                    break;
                }
            }
        }
    }
    let max_duration = clamp_duration_minutes(field(&value, "maxDurationMinutes"));
    if goal.is_empty() {
        return Ok(json!({ "ok": false, "error": "goal_required" }).to_string());
    }
    Ok(json!({
        "ok": true,
        "config": { "goal": goal, "criteria": criteria, "maxDurationMinutes": max_duration },
    })
    .to_string())
}

// ── wall-clock deadline math ────────────────────────────────────────────────

/// Clamp `{maxDurationMinutes}` → `{maxDurationMinutes}` (default 120, 5..1440).
pub fn clamp_duration(input: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|error| format!("unattended_invalid_input: {error}"))?;
    Ok(json!({ "maxDurationMinutes": clamp_duration_minutes(field(&value, "maxDurationMinutes")) }).to_string())
}

/// Arm a supervision deadline.
///
/// Input `{startedAt?, maxDurationMinutes?, now}`. `startedAt` defaults to
/// `now` (a fresh `start`/`resume`); an `update` passes the ORIGINAL
/// `startedAt` so only the duration moves the deadline. When the computed
/// deadline is already past it is clamped to `now + 1 minute` and `clamped` is
/// true so the host can note it in the trace.
///
/// Output `{startedAt, deadlineAt, maxDurationMinutes, clamped}`.
pub fn arm_deadline(input: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|error| format!("unattended_invalid_input: {error}"))?;
    let now = int_value(field(&value, "now")).unwrap_or(0).max(0);
    let started_at = int_value(field(&value, "startedAt"))
        .map(|value| value.max(0))
        .unwrap_or(now);
    let minutes = clamp_duration_minutes(field(&value, "maxDurationMinutes"));
    let mut deadline_at = started_at.saturating_add(minutes.saturating_mul(MS_PER_MINUTE));
    let mut clamped = false;
    if deadline_at <= now {
        deadline_at = now.saturating_add(EXPIRY_CLAMP_MS);
        clamped = true;
    }
    Ok(json!({
        "startedAt": started_at,
        "deadlineAt": deadline_at,
        "maxDurationMinutes": minutes,
        "clamped": clamped,
    })
    .to_string())
}

/// `{deadlineAt?, now}` → `{expired}`. A missing/null/zero deadline is never
/// expired (legacy or non-active records).
pub fn deadline_expired(input: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|error| format!("unattended_invalid_input: {error}"))?;
    let now = int_value(field(&value, "now")).unwrap_or(0);
    let deadline_at = int_value(field(&value, "deadlineAt")).unwrap_or(0);
    Ok(json!({ "expired": deadline_at > 0 && now >= deadline_at }).to_string())
}

// ── buildVerdictPrompt ──────────────────────────────────────────────────────

fn append_recent(out: &mut String, recent: Option<&Value>) {
    let Some(items) = recent.and_then(Value::as_array) else {
        return;
    };
    let start = items.len().saturating_sub(MAX_RECENT_MESSAGES);
    for item in &items[start..] {
        let role = value_text(field(item, "role"));
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = clamp_text(
            &value_text(field(item, "content")),
            MAX_RECENT_MESSAGE_CHARS,
        );
        if text.is_empty() {
            continue;
        }
        out.push_str(&format!("{role}: {text}\n"));
    }
}

fn append_history(out: &mut String, history: Option<&Value>) {
    let Some(items) = history.and_then(Value::as_array) else {
        return;
    };
    let start = items.len().saturating_sub(MAX_PROMPT_HISTORY);
    for (index, item) in items[start..].iter().enumerate() {
        let verdict = value_text(field(item, "verdict"));
        let reason = clamp_text(&value_text(field(item, "reason")), 300);
        out.push_str(&format!(
            "{}. {} — {}\n",
            index + 1,
            if verdict.is_empty() { "?" } else { &verdict },
            if reason.is_empty() {
                "(no reason)"
            } else {
                &reason
            }
        ));
    }
}

fn append_pending_question(out: &mut String, pending: Option<&Value>) {
    let Some(pending) = pending.filter(|value| !value.is_null()) else {
        return;
    };
    let question = clamp_text(&value_text(field(pending, "question")), 2000);
    if question.is_empty() {
        return;
    }
    out.push_str("\nThe turn ended on a pending user-input question:\n");
    out.push_str(&format!("question: {question}\n"));
    if let Some(options) = field(pending, "options").and_then(Value::as_array) {
        let mut rendered = Vec::new();
        for option in options.iter().take(MAX_PENDING_OPTIONS) {
            let text = clamp_text(&value_text(Some(option)), MAX_PENDING_OPTION_CHARS);
            if !text.is_empty() {
                rendered.push(format!("- {text}"));
            }
        }
        if !rendered.is_empty() {
            out.push_str("options:\n");
            out.push_str(&rendered.join("\n"));
            out.push('\n');
        }
    }
    out.push_str(
        "You must answer this question yourself: pick the option (or write the answer) the goal implies \
         and put it in \"answer\". Only use needs_human when the answer is one of the human-only facts defined below.\n",
    );
}

/// Build the Aux verdict prompt. Input:
/// `{goal, criteria, lastOutput, recent, history, pendingQuestion, rounds}`.
/// `rounds` is informational only — there is no round budget to enforce.
pub fn build_verdict_prompt(input: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|error| format!("unattended_invalid_input: {error}"))?;
    let goal = clamp_text(&value_text(field(&value, "goal")), MAX_GOAL_CHARS);
    let rounds = int_value(field(&value, "rounds")).unwrap_or(0).max(0);
    let last_output = clamp_text(
        &value_text(field(&value, "lastOutput")),
        MAX_LAST_OUTPUT_CHARS,
    );
    let mut criteria = String::new();
    if let Some(items) = field(&value, "criteria").and_then(Value::as_array) {
        for (index, item) in items.iter().take(MAX_CRITERIA).enumerate() {
            let text = clamp_text(&value_text(Some(item)), MAX_CRITERION_CHARS);
            if !text.is_empty() {
                criteria.push_str(&format!("{}. {text}\n", index + 1));
            }
        }
    }
    if criteria.is_empty() {
        criteria.push_str("(none given; judge against the goal text itself)\n");
    }
    let mut recent = String::new();
    append_recent(&mut recent, field(&value, "recent"));
    if recent.is_empty() {
        recent.push_str("(no recent transcript)\n");
    }
    let mut history = String::new();
    append_history(&mut history, field(&value, "history"));
    if history.is_empty() {
        history.push_str("(no previous verdicts)\n");
    }
    let mut prompt = String::new();
    prompt.push_str(
        "You are the supervisor of an unattended autonomous coding agent. After every finished agent turn \
         you decide whether the goal was reached, whether the agent should continue on its own, or whether \
         a human is really required.\n\n",
    );
    prompt.push_str(&format!("GOAL (what the user wants):\n{goal}\n\n"));
    prompt.push_str(&format!("ACCEPTANCE CRITERIA:\n{criteria}\n"));
    prompt.push_str(&format!(
        "AUTO FOLLOW-UPS SENT SO FAR: {rounds} (an informational count; there is no round limit)\n\n",
    ));
    prompt.push_str(&format!(
        "LAST ASSISTANT OUTPUT (truncated):\n<<<\n{last_output}\n>>>\n\n",
    ));
    prompt.push_str(&format!("RECENT TRANSCRIPT:\n<<<\n{recent}>>>\n\n"));
    prompt.push_str(&format!("PREVIOUS VERDICTS (oldest first):\n{history}\n"));
    append_pending_question(&mut prompt, field(&value, "pendingQuestion"));
    prompt.push_str(
        "\nDecide one verdict:\n\
         - \"achieved\": the goal is reached and the acceptance criteria hold, judged from concrete evidence in \
         the transcript (files changed, commands run, results observed) — not from the agent merely saying it is done.\n\
         - \"continue\": the goal is not reached yet and the agent can make progress by itself. Put the single next \
         instruction in \"nextInstruction\" (imperative, self-contained, no greetings). Never repeat the same \
         instruction you already gave if it produced no progress.\n\
         - \"needs_human\": a human is really required. This is ONLY for:\n\
           * credentials, secrets, CAPTCHA, two-factor codes, payment or account authorisation;\n\
           * physical-world actions (touching hardware, signing papers, going somewhere);\n\
           * an irreversible or destructive approval the goal did not authorise (delete data, force-push, pay money, \
         publish to production);\n\
           * facts only the user knows (their personal preference, an external decision, information that exists \
         nowhere in the workspace);\n\
           * a blocker the agent demonstrably cannot overcome (missing access, a failing third-party service).\n\
           Everything else you must decide yourself: wording, style, naming, file layout, scope trade-offs, which \
         test to write, which plausible option to pick. When the turn ended on a question or options from the agent, \
         choose the answer yourself and return it in \"answer\". Do not hand routine decisions back to the user.\n\n\
         Reply with a single JSON object and nothing else (no markdown fences, no prose):\n\
         {\"verdict\":\"achieved|continue|needs_human\",\"reason\":\"one or two sentences of evidence\",\
         \"nextInstruction\":\"required only for continue\",\"humanReason\":\"required only for needs_human: \
         which human-only fact blocks the agent and what exactly the human must do\",\
         \"answer\":\"only when the turn ended on a question: the answer or the chosen option text\"}\n",
    );
    Ok(json!({ "prompt": prompt }).to_string())
}

// ── parseVerdict ────────────────────────────────────────────────────────────

fn extract_object(text: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(js_trim(text)) {
        if value.is_object() {
            return Some(value);
        }
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&text[start..=end]).ok()
}

/// Parse the Aux reply. Tolerant of code fences and leading/trailing prose, and
/// it never fails the call: an unusable reply is reported as `{ok:false}`.
pub fn parse_verdict(text: &str) -> Result<String, String> {
    if let Some(value) = extract_object(text) {
        if let Some(verdict) = parse_verdict_from_value(&value) {
            let mut out = Map::new();
            out.insert("ok".to_string(), Value::Bool(true));
            out.insert("verdict".to_string(), verdict);
            return Ok(Value::Object(out).to_string());
        }
    }
    Ok(json!({
        "ok": false,
        "error": "unparseable_verdict",
        "raw": clamp_text(text, 500),
    })
    .to_string())
}

// ── decide ──────────────────────────────────────────────────────────────────

fn state_text(state: &Value, key: &str) -> String {
    value_text(field(state, key))
}

fn capped_history(mut history: Vec<Value>, entry: Value) -> Vec<Value> {
    history.push(entry);
    if history.len() > HISTORY_MAX {
        history.drain(0..history.len() - HISTORY_MAX);
    }
    history
}

fn copy_history(state: &Value) -> Vec<Value> {
    field(state, "history")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let verdict = state_text(item, "verdict");
                    if verdict.is_empty() {
                        return None;
                    }
                    let mut out = Map::new();
                    out.insert(
                        "at".to_string(),
                        json!(int_value(field(item, "at")).unwrap_or(0)),
                    );
                    out.insert("verdict".to_string(), Value::String(verdict));
                    out.insert(
                        "reason".to_string(),
                        Value::String(clamp_text(&state_text(item, "reason"), MAX_REASON_CHARS)),
                    );
                    Some(Value::Object(out))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The persisted stall counters folded into one value so `build_state` keeps a
/// readable signature.
struct StallCounts {
    same_instruction: u32,
    aux_failures: u32,
    consecutive_faults: u32,
}

fn build_state(
    state: &Value,
    status: &str,
    rounds: i64,
    now: i64,
    verdict: Option<&Value>,
    history: Vec<Value>,
    stall: StallCounts,
) -> Value {
    let goal = clamp_text(&state_text(state, "goal"), MAX_GOAL_CHARS);
    let criteria: Vec<Value> = field(state, "criteria")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(MAX_CRITERIA)
                .filter_map(|item| {
                    let text = clamp_text(&value_text(Some(item)), MAX_CRITERION_CHARS);
                    if text.is_empty() {
                        None
                    } else {
                        Some(Value::String(text))
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let max_duration = clamp_duration_minutes(field(state, "maxDurationMinutes"));
    let started_at = int_value(field(state, "startedAt")).unwrap_or(now);
    let deadline_at = int_value(field(state, "deadlineAt"))
        .filter(|value| *value > 0)
        .unwrap_or_else(|| started_at.saturating_add(max_duration.saturating_mul(MS_PER_MINUTE)));
    let mut last_verdict = Value::Null;
    if let Some(verdict) = verdict {
        let mut out = Map::new();
        out.insert("verdict".to_string(), json!(state_text(verdict, "verdict")));
        out.insert("reason".to_string(), json!(state_text(verdict, "reason")));
        out.insert(
            "nextInstruction".to_string(),
            json!(state_text(verdict, "nextInstruction")),
        );
        out.insert(
            "humanReason".to_string(),
            json!(state_text(verdict, "humanReason")),
        );
        out.insert("at".to_string(), json!(now));
        last_verdict = Value::Object(out);
    }
    let mut stall_state = Map::new();
    stall_state.insert("sameInstruction".to_string(), json!(stall.same_instruction));
    stall_state.insert("auxFailures".to_string(), json!(stall.aux_failures));
    stall_state.insert(
        "consecutiveFaults".to_string(),
        json!(stall.consecutive_faults),
    );
    let mut out = Map::new();
    out.insert("status".to_string(), json!(status));
    out.insert("goal".to_string(), json!(goal));
    out.insert("criteria".to_string(), Value::Array(criteria));
    out.insert("maxDurationMinutes".to_string(), json!(max_duration));
    out.insert("rounds".to_string(), json!(rounds));
    out.insert("startedAt".to_string(), json!(started_at));
    out.insert("deadlineAt".to_string(), json!(deadline_at));
    out.insert("updatedAt".to_string(), json!(now));
    out.insert("lastVerdict".to_string(), last_verdict);
    out.insert("history".to_string(), Value::Array(history));
    out.insert("stall".to_string(), Value::Object(stall_state));
    // A decide() result is always applied — the evaluation spinner is over and
    // the state is either active (no pause) or terminal (pausedBy has no point).
    out.insert("evaluating".to_string(), json!(false));
    out.insert("pausedBy".to_string(), Value::Null);
    // Verdicts rebuild the state from scratch. Host bookkeeping must survive:
    // `lastSettleAt` keeps boot reconciliation from replaying a handled settle,
    // and `lastTurnEndId` keeps the second turn-end observer a no-op.
    for key in ["lastSettleAt", "lastTurnEndId"] {
        if let Some(value) = field(state, key) {
            out.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(out)
}

fn priority_verdict(state: &Value) -> Option<Value> {
    field(state, "lastVerdict")
        .filter(|value| value.is_object())
        .cloned()
}

/// Accept either the bare verdict object or a `parseVerdict` envelope
/// (`{ok:true, verdict:{...}}`); an explicit `ok:false` means "not usable".
fn unwrap_verdict(raw: Option<&Value>) -> Option<Value> {
    let raw = raw.filter(|item| item.is_object())?;
    match field(raw, "ok") {
        Some(Value::Bool(false)) => None,
        Some(_) => field(raw, "verdict")
            .filter(|item| item.is_object())
            .cloned(),
        None => Some(raw.clone()),
    }
}

/// `decide({state, verdict|parseError, now, evaluation})` →
/// `{nextState, action, message}`. Actions: `inject | achieved | needs_human |
/// stalled | error | none`. (`exhausted` is produced by the host when the
/// wall-clock deadline passes, not by a verdict.)
///
/// For `inject` the result also carries `answer` and `pendingQuestionId` when
/// the Aux answered a pending question — the JS supervisor then resolves the
/// request the same way a human answer does instead of injecting a message.
pub fn decide(input: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|error| format!("unattended_invalid_input: {error}"))?;
    let state = field(&value, "state").cloned().unwrap_or_else(|| json!({}));
    let now = int_value(field(&value, "now")).unwrap_or(0);
    let parse_error = field(&value, "parseError")
        .filter(|item| !item.is_null())
        .map(|item| value_text(Some(item)));
    let verdict = unwrap_verdict(field(&value, "verdict"));
    let pending = field(&value, "evaluation")
        .and_then(|evaluation| field(evaluation, "pendingQuestion"))
        .filter(|item| item.is_object());
    let pending_id = pending
        .map(|item| state_text(item, "requestId"))
        .filter(|text| !text.is_empty());

    let status = state_text(&state, "status");
    if status != "active" {
        return Ok(json!({
            "nextState": state,
            "action": "none",
            "message": "",
        })
        .to_string());
    }
    let rounds = int_value(field(&state, "rounds")).unwrap_or(0).max(0);
    let stall = field(&state, "stall").cloned().unwrap_or_else(|| json!({}));
    let same_instruction = u32_value(field(&stall, "sameInstruction"));
    let aux_failures = u32_value(field(&stall, "auxFailures"));
    let history = copy_history(&state);
    let previous = priority_verdict(&state);

    // ── Aux failure / unparseable reply ────────────────────────────────────
    let Some(verdict) = verdict else {
        let failures = aux_failures.saturating_add(1);
        let reason = parse_error.unwrap_or_else(|| "unparseable_verdict".to_string());
        let capped = clamp_text(&reason, MAX_REASON_CHARS);
        let next_history = capped_history(
            history,
            json!({ "at": now, "verdict": "error", "reason": capped }),
        );
        if failures >= AUX_FAILURE_LIMIT {
            let next_state = build_state(
                &state,
                "error",
                rounds,
                now,
                previous.as_ref(),
                next_history,
                StallCounts {
                    same_instruction,
                    aux_failures: failures,
                    consecutive_faults: 0,
                },
            );
            return Ok(json!({
                "nextState": next_state,
                "action": "error",
                "message": format!(
                    "无人值守已停止：辅助模型连续 {AUX_FAILURE_LIMIT} 次未能给出可解析的判定（{capped}）。可以重新开始或继续手动推进。"
                ),
            })
            .to_string());
        }
        let next_state = build_state(
            &state,
            "active",
            rounds,
            now,
            previous.as_ref(),
            next_history,
            StallCounts {
                same_instruction,
                aux_failures: failures,
                consecutive_faults: 0,
            },
        );
        return Ok(json!({
            "nextState": next_state,
            "action": "none",
            "message": "",
        })
        .to_string());
    };

    let kind = state_text(&verdict, "verdict");
    let reason = strip_tag(&state_text(&verdict, "reason"));
    let next_instruction = strip_tag(&state_text(&verdict, "nextInstruction"));
    let human_reason = strip_tag(&state_text(&verdict, "humanReason"));
    let answer = clamp_text(
        &strip_tag(&state_text(&verdict, "answer")),
        MAX_ANSWER_CHARS,
    );

    let history_entry = json!({ "at": now, "verdict": kind, "reason": reason });

    let (action, message, next_status, next_rounds, same_next) = match kind.as_str() {
        "achieved" => (
            "achieved",
            if reason.is_empty() {
                "无人值守：目标已达成。".to_string()
            } else {
                format!("无人值守：目标已达成。{reason}")
            },
            "achieved",
            rounds,
            0,
        ),
        "needs_human" => (
            "needs_human",
            if human_reason.is_empty() {
                "无人值守需要你介入：辅助模型判断有只有人才能解决的问题。".to_string()
            } else {
                format!("无人值守需要你介入：{human_reason}")
            },
            "needs_human",
            rounds,
            0,
        ),
        _ => {
            // continue — the stall guard only. `rounds` has no cap; the
            // wall-clock deadline is enforced by the host/timer, not here.
            let previous_instruction = previous
                .as_ref()
                .map(|item| state_text(item, "nextInstruction"))
                .unwrap_or_default();
            let same_seen = !previous_instruction.is_empty()
                && normalized_instruction(&previous_instruction)
                    == normalized_instruction(&next_instruction);
            let same_next = if same_seen {
                same_instruction.saturating_add(1)
            } else {
                1
            };
            if same_next >= STALL_LIMIT {
                (
                    "stalled",
                    format!(
                        "无人值守已暂停：连续 {STALL_LIMIT} 次给出同一条指令却没有进展（{}）。请人工检查卡点。",
                        clamp_text(&next_instruction, 200)
                    ),
                    "needs_human",
                    rounds,
                    same_next,
                )
            } else {
                let prefixed = format!("{UNATTENDED_TAG} {next_instruction}");
                ("inject", prefixed, "active", rounds + 1, same_next)
            }
        }
    };

    let next_state = build_state(
        &state,
        next_status,
        next_rounds,
        now,
        Some(&verdict),
        capped_history(history, history_entry),
        StallCounts {
            same_instruction: same_next,
            aux_failures: 0,
            // Any D/W settle that reaches decide() is not a fault anymore.
            consecutive_faults: 0,
        },
    );
    let mut out = Map::new();
    out.insert("nextState".to_string(), next_state);
    out.insert("action".to_string(), json!(action));
    out.insert("message".to_string(), json!(message));
    if action == "inject" && !answer.is_empty() {
        out.insert("answer".to_string(), json!(answer));
        if let Some(pending_id) = pending_id {
            out.insert("pendingQuestionId".to_string(), json!(pending_id));
        }
    }
    Ok(Value::Object(out).to_string())
}

/// Cancel sources a human deliberately initiated. A user Cancel is not a fault:
/// the supervisor pauses and never resurrects work against the user's intent.
const USER_CANCEL_SOURCES: [&str; 8] = [
    "manual_cancel",
    "task-shell",
    "user_cancel",
    "insert_queued",
    "force_insert",
    "new_user_message",
    "cancel_repeat",
    "dispatch_cancel",
];
/// User cancels that also carry a new message: the pause reason is "user input".
const USER_INPUT_SOURCES: [&str; 3] = ["insert_queued", "force_insert", "new_user_message"];
/// Host-side interruptions. They are faults (the goal survives an unhealthy
/// host/upstream), not a human decision to stop, so the supervisor continues.
const HOST_CANCEL_SOURCES: [&str; 9] = [
    "process_watchdog",
    "stalled_recovery",
    "provider_log_error",
    "restart_spawn",
    "restart_recovery",
    "shutdown",
    "cli_switch",
    "relocate",
    // The turn died between its P write and the provider spawn: no runner, no
    // finalizer, and nothing the user asked to stop. The host settles it through
    // the same entry so an armed supervisor continues under its fault cap.
    "preparation_failed",
];

fn is_user_cancel(source: &str, kill_reason: &str) -> bool {
    USER_CANCEL_SOURCES.contains(&source) || USER_CANCEL_SOURCES.contains(&kill_reason)
}

fn is_host_cancel(source: &str, kill_reason: &str) -> bool {
    let known =
        |value: &str| HOST_CANCEL_SOURCES.contains(&value) || value.ends_with("_log_watchdog");
    known(source) || known(kill_reason)
}

/// Pause while preserving the persisted state verbatim (field order included).
fn pause_state(state: &Value, by: &str, now: i64) -> Value {
    let mut out = state.as_object().cloned().unwrap_or_default();
    out.insert("status".to_string(), json!("stopped"));
    out.insert("pausedBy".to_string(), json!(by));
    out.insert("evaluating".to_string(), json!(false));
    out.insert("updatedAt".to_string(), json!(now));
    Value::Object(out)
}

/// A clean D/W settle proves upstream recovered: clear `consecutiveFaults`.
/// Returns the (possibly unchanged) state and whether a write is required.
fn settle_state(state: &Value) -> (Value, bool) {
    let mut out = state.as_object().cloned().unwrap_or_default();
    let streak = field(state, "stall")
        .and_then(|stall| field(stall, "consecutiveFaults"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if streak != 0 {
        let mut stall = field(state, "stall")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        stall.insert("consecutiveFaults".to_string(), json!(0));
        out.insert("stall".to_string(), Value::Object(stall));
    }
    (Value::Object(out), streak != 0)
}

fn none_envelope(reason: &str) -> String {
    json!({ "action": "none", "message": "", "reason": reason }).to_string()
}

/// Stamp the handled turn's identity on the next state. The identity is the
/// per-turn dedupe key: two observers (turn finalize and the cancel writer) may
/// report the same turn, but only the first report may act. It is persisted so
/// boot reconciliation uses exactly the same key.
fn with_turn_end_id(mut state: Value, turn_id: &str) -> Value {
    if !turn_id.is_empty() {
        if let Some(object) = state.as_object_mut() {
            object.insert(
                "lastTurnEndId".to_string(),
                Value::String(turn_id.to_string()),
            );
        }
    }
    state
}

/// Same stamp for a decision envelope that already carries `nextState`.
fn with_turn_end_decision(mut decision: Value, turn_id: &str) -> Value {
    if turn_id.is_empty() {
        return decision;
    }
    if let Some(next_state) = decision.get_mut("nextState") {
        let stamped = with_turn_end_id(next_state.take(), turn_id);
        *next_state = stamped;
    }
    decision
}

fn pause_decision(state: &Value, by: &str, reason: &str, now: i64, turn_id: &str) -> String {
    json!({
        "action": "pause",
        "message": "",
        "pausedBy": by,
        "reason": reason,
        "nextState": with_turn_end_id(pause_state(state, by, now), turn_id),
    })
    .to_string()
}

fn user_pause_by(source: &str, kill_reason: &str) -> &'static str {
    if USER_INPUT_SOURCES.contains(&source) || USER_INPUT_SOURCES.contains(&kill_reason) {
        "input"
    } else {
        "cancel"
    }
}

/// The one decision for *every* way a turn can end.
///
/// The host passes facts only (`kind`, classify letter, cancel attribution, the
/// API policy's retry verdict, whether the scheduler has staged backlog); this
/// function owns the policy and returns one action:
/// `evaluate | fault_continue | needs_human | pause | none`.
///
/// Source attribution is independent of `kind`: an E turn whose `killReason` is
/// a user cancel is still a user cancel (`pause`, never inject). This is the
/// race the turn-finalize observer hits when it reports before the cancel
/// observer: assigning the kill reason happens before the runner is stopped, so
/// a user-caused E always carries its attribution.
///
/// `turnId` makes each turn produce exactly one result: a second report for an
/// already-handled turn is `none`, except that a later user-cancel attribution
/// still pauses (the user wins; nothing new is injected).
///
/// End types:
///   * `settle` D/W → `evaluate` (D defers while the scheduler has backlog);
///   * `fault` (E from the rules path) with a user source → `pause`;
///   * `fault` → `none` when the API policy scheduled its own retry, else the
///     fault continuation policy;
///   * `cancel` with a user source → `pause` (`cancel`, or `input` for inserts);
///   * `cancel` with a host source (watchdog / stalled recovery / restart /
///     shutdown / provider log watchdog) → the same fault continuation policy;
///   * `cancel` with unknown attribution → `pause` (fail safe: unlock input and
///     stop rather than inject work the user may just have stopped);
///   * `user_input` → `pause` as a takeover.
///
/// Input: `{state, now, kind, turnId?, settle?, cancelSource?, killReason?,
/// retryScheduled?, backlogPending?}`. Non-active states are a no-op;
/// `retryScheduled` must be a boolean when present.
pub fn decide_turn_end(input: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|error| format!("unattended_invalid_input: {error}"))?;
    let state = field(&value, "state").cloned().unwrap_or_else(|| json!({}));
    let now = int_value(field(&value, "now")).unwrap_or(0);
    // The fact contract is strict: a string "true" must not be silently treated
    // as false and inject a continuation the API policy already owns.
    let retry_scheduled = match field(&value, "retryScheduled") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => {
            return Err("unattended_invalid_input: retryScheduled must be a boolean".to_string())
        }
    };
    if state_text(&state, "status") != "active" {
        return Ok(none_envelope("not_active"));
    }
    let kind = state_text(&value, "kind");
    let turn_id = state_text(&value, "turnId");
    let source = state_text(&value, "cancelSource");
    let kill_reason = state_text(&value, "killReason");
    if !turn_id.is_empty() && state_text(&state, "lastTurnEndId") == turn_id {
        // The user wins over an earlier host interruption, but only as a pause:
        // the first report already produced its (at most one) action.
        if is_user_cancel(&source, &kill_reason) {
            let by = user_pause_by(&source, &kill_reason);
            return Ok(pause_decision(
                &state,
                by,
                "duplicate_user_takeover",
                now,
                &turn_id,
            ));
        }
        return Ok(none_envelope("duplicate_turn"));
    }
    match kind.as_str() {
        "user_input" => Ok(pause_decision(&state, "input", "user_input", now, &turn_id)),
        "settle" => {
            let settle = state_text(&value, "settle").to_uppercase();
            if settle != "D" && settle != "W" {
                return Ok(none_envelope("not_a_settle_letter"));
            }
            let backlog = field(&value, "backlogPending")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (next_state, reset_faults) = settle_state(&state);
            let next_state = with_turn_end_id(next_state, &turn_id);
            // D with staged FIFO work is not judged yet: the scheduler will
            // drain that queue and its own last D settle evaluates. W is judged
            // even with backlog (its pending question is what Aux must answer).
            if settle == "D" && backlog {
                return Ok(json!({
                    "action": "none",
                    "message": "",
                    "reason": "backlog_pending",
                    "nextState": next_state,
                    "resetFaults": reset_faults,
                })
                .to_string());
            }
            Ok(json!({
                "action": "evaluate",
                "message": "",
                "nextState": next_state,
                "resetFaults": reset_faults,
            })
            .to_string())
        }
        // `fault` and `cancel` differ only in whether the API policy may already
        // own the retry; attribution comes first for both.
        "fault" | "cancel" => {
            if is_user_cancel(&source, &kill_reason) {
                let by = user_pause_by(&source, &kill_reason);
                return Ok(pause_decision(&state, by, "user_cancel", now, &turn_id));
            }
            if kind == "fault" {
                if retry_scheduled {
                    // The API policy owns the retry and reuses the SAME turn:
                    // the turn has not ended, so it must not be claimed as
                    // handled. Stamping lastTurnEndId here would make the
                    // retry's real D/W/E settle look like a duplicate and strand
                    // the session with its input locked.
                    return Ok(none_envelope("policy_retry"));
                }
                return Ok(
                    with_turn_end_decision(fault_decision(&state, now), &turn_id).to_string(),
                );
            }
            if is_host_cancel(&source, &kill_reason) {
                return Ok(
                    with_turn_end_decision(fault_decision(&state, now), &turn_id).to_string(),
                );
            }
            Ok(pause_decision(
                &state,
                "cancel",
                "unrecognized_cancel_source",
                now,
                &turn_id,
            ))
        }
        _ => Ok(none_envelope("unknown_kind")),
    }
}

/// Immediate fault (E) continuation, without an Aux call.
///
/// After the API-error policy has finished with an E — it either scheduled its
/// own retry (the caller must then do nothing) or gave up — the supervisor keeps
/// the goal moving with a fixed instruction. It increments the informational
/// `rounds` counter (there is no round budget; expiry is wall-clock) and never
/// replays side effects. Consecutive faults are capped at [`FAULT_LIMIT`]; after
/// that a human is required so an unhealthy upstream can never loop forever.
/// Non-active states are a no-op.
///
/// Input: `{state, now}`. Returns `{nextState, action, message}` with action
/// `fault_continue | needs_human | none`.
pub fn decide_fault(input: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|error| format!("unattended_invalid_input: {error}"))?;
    let state = field(&value, "state").cloned().unwrap_or_else(|| json!({}));
    let now = int_value(field(&value, "now")).unwrap_or(0);
    if state_text(&state, "status") != "active" {
        return Ok(json!({
            "nextState": state,
            "action": "none",
            "message": "",
        })
        .to_string());
    }
    Ok(fault_decision(&state, now).to_string())
}

/// The shared fault policy (callers have already checked `status == "active"`).
fn fault_decision(state: &Value, now: i64) -> Value {
    let rounds = int_value(field(state, "rounds")).unwrap_or(0).max(0);
    let stall = field(state, "stall").cloned().unwrap_or_else(|| json!({}));
    let same_instruction = u32_value(field(&stall, "sameInstruction"));
    let aux_failures = u32_value(field(&stall, "auxFailures"));
    let faults = u32_value(field(&stall, "consecutiveFaults")).saturating_add(1);
    let history = copy_history(state);
    let previous = priority_verdict(state);

    let (action, message, next_status, next_rounds) = if faults >= FAULT_LIMIT {
        (
            "needs_human",
            format!(
                "无人值守需要你介入：连续 {FAULT_LIMIT} 轮因上游故障中断，已停止自动续接。请检查提供方/网络后再继续。"
            ),
            "needs_human",
            rounds,
        )
    } else {
        (
            "fault_continue",
            format!("{UNATTENDED_TAG} {FAULT_INSTRUCTION}"),
            "active",
            rounds + 1,
        )
    };
    let entry = json!({
        "at": now,
        "verdict": if action == "needs_human" { "needs_human" } else { "continue" },
        "reason": if action == "fault_continue" {
            "fault_continue"
        } else {
            "repeated_faults"
        },
    });
    let next_state = build_state(
        state,
        next_status,
        next_rounds,
        now,
        previous.as_ref(),
        capped_history(history, entry),
        StallCounts {
            same_instruction,
            aux_failures,
            consecutive_faults: faults,
        },
    );
    json!({
        "nextState": next_state,
        "action": action,
        "message": message,
        "faults": faults,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::utf16_len;

    fn config(input: Value) -> Value {
        serde_json::from_str(&normalize_config(&input.to_string()).unwrap()).unwrap()
    }
    fn prompt(input: Value) -> String {
        let out: Value =
            serde_json::from_str(&build_verdict_prompt(&input.to_string()).unwrap()).unwrap();
        out["prompt"].as_str().unwrap().to_string()
    }
    fn parse(text: &str) -> Value {
        serde_json::from_str(&parse_verdict(text).unwrap()).unwrap()
    }
    fn decide_json(input: Value) -> Value {
        serde_json::from_str(&decide(&input.to_string()).unwrap()).unwrap()
    }

    fn active_state(rounds: i64) -> Value {
        json!({
            "status": "active",
            "goal": "ship the feature",
            "criteria": ["tests pass"],
            "maxDurationMinutes": 120,
            "rounds": rounds,
            "startedAt": 100,
            "deadlineAt": 100 + 120 * MS_PER_MINUTE,
            "updatedAt": 100,
            "lastVerdict": null,
            "history": [],
            "stall": { "sameInstruction": 0, "auxFailures": 0 },
        })
    }

    // ── normalizeConfig ────────────────────────────────────────────────────

    #[test]
    fn config_defaults_and_caps() {
        let out = config(json!({ "goal": "  do it  " }));
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["config"]["goal"], json!("do it"));
        assert_eq!(out["config"]["criteria"], json!([]));
        assert_eq!(out["config"]["maxDurationMinutes"], json!(120));
    }

    #[test]
    fn config_requires_goal() {
        assert_eq!(
            config(json!({ "goal": "   " })),
            json!({ "ok": false, "error": "goal_required" })
        );
        assert_eq!(
            config(json!({})),
            json!({ "ok": false, "error": "goal_required" })
        );
    }

    #[test]
    fn config_clamps_duration_and_ignores_legacy_rounds() {
        assert_eq!(
            config(json!({ "goal": "g", "maxDurationMinutes": 0 }))["config"]["maxDurationMinutes"],
            json!(5)
        );
        assert_eq!(
            config(json!({ "goal": "g", "maxDurationMinutes": 5000 }))["config"]
                ["maxDurationMinutes"],
            json!(1440)
        );
        assert_eq!(
            config(json!({ "goal": "g", "maxDurationMinutes": "12" }))["config"]
                ["maxDurationMinutes"],
            json!(12)
        );
        assert_eq!(
            config(json!({ "goal": "g", "maxDurationMinutes": "oops" }))["config"]
                ["maxDurationMinutes"],
            json!(120)
        );
        // The old round budget is accepted but never read or persisted.
        let legacy = config(json!({ "goal": "g", "maxRounds": 7 }));
        assert_eq!(legacy["config"]["maxDurationMinutes"], json!(120));
        assert_eq!(legacy["config"].get("maxRounds"), None);
        let long_goal = "x".repeat(3000);
        let goal = config(json!({ "goal": long_goal }))["config"]["goal"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(utf16_len(&goal), MAX_GOAL_CHARS);
        let criteria: Vec<Value> = (0..20)
            .map(|index| json!(format!("{index}-{}", "y".repeat(400))))
            .collect();
        let out = config(json!({ "goal": "g", "criteria": criteria }));
        let items = out["config"]["criteria"].as_array().unwrap();
        assert_eq!(items.len(), MAX_CRITERIA);
        assert_eq!(utf16_len(items[0].as_str().unwrap()), MAX_CRITERION_CHARS);
    }

    #[test]
    fn config_accepts_a_json_array_of_lone_surrogate_free_strings() {
        let out = config(json!({ "goal": "g", "criteria": ["a", "", "a", null, "b"] }));
        assert_eq!(out["config"]["criteria"], json!(["a", "b"]));
    }

    // ── wall-clock deadline math ───────────────────────────────────────────

    fn clamp_json(input: Value) -> Value {
        serde_json::from_str(&clamp_duration(&input.to_string()).unwrap()).unwrap()
    }
    fn arm_json(input: Value) -> Value {
        serde_json::from_str(&arm_deadline(&input.to_string()).unwrap()).unwrap()
    }
    fn expired_json(input: Value) -> Value {
        serde_json::from_str(&deadline_expired(&input.to_string()).unwrap()).unwrap()
    }

    #[test]
    fn duration_defaults_and_clamps() {
        assert_eq!(clamp_json(json!({}))["maxDurationMinutes"], json!(120));
        assert_eq!(
            clamp_json(json!({ "maxDurationMinutes": 4 }))["maxDurationMinutes"],
            json!(5)
        );
        assert_eq!(
            clamp_json(json!({ "maxDurationMinutes": 1441 }))["maxDurationMinutes"],
            json!(1440)
        );
        assert_eq!(
            clamp_json(json!({ "maxDurationMinutes": "30" }))["maxDurationMinutes"],
            json!(30)
        );
        assert_eq!(
            clamp_json(json!({ "maxRounds": 9 }))["maxDurationMinutes"],
            json!(120)
        );
    }

    #[test]
    fn arm_defaults_started_at_to_now_and_computes_deadline() {
        let out = arm_json(json!({ "maxDurationMinutes": 30, "now": 5000 }));
        assert_eq!(out["startedAt"], json!(5000));
        assert_eq!(out["deadlineAt"], json!(5000 + 30 * MS_PER_MINUTE));
        assert_eq!(out["clamped"], json!(false));
        // An update reuses the original startedAt.
        let updated = arm_json(json!({ "startedAt": 1000, "maxDurationMinutes": 30, "now": 5000 }));
        assert_eq!(updated["startedAt"], json!(1000));
        assert_eq!(updated["deadlineAt"], json!(1000 + 30 * MS_PER_MINUTE));
    }

    #[test]
    fn arm_clamps_a_past_deadline_to_one_minute_from_now() {
        let out =
            arm_json(json!({ "startedAt": 1000, "maxDurationMinutes": 5, "now": 10_000_000 }));
        assert_eq!(out["startedAt"], json!(1000));
        assert_eq!(out["deadlineAt"], json!(10_000_000 + EXPIRY_CLAMP_MS));
        assert_eq!(out["clamped"], json!(true));
    }

    #[test]
    fn expired_only_when_a_real_deadline_has_passed() {
        assert_eq!(
            expired_json(json!({ "deadlineAt": 1000, "now": 999 }))["expired"],
            json!(false)
        );
        assert_eq!(
            expired_json(json!({ "deadlineAt": 1000, "now": 1000 }))["expired"],
            json!(true)
        );
        assert_eq!(
            expired_json(json!({ "deadlineAt": 1000, "now": 5000 }))["expired"],
            json!(true)
        );
        assert_eq!(
            expired_json(json!({ "now": 5000 }))["expired"],
            json!(false)
        );
        assert_eq!(
            expired_json(json!({ "deadlineAt": null, "now": 5000 }))["expired"],
            json!(false)
        );
        assert_eq!(
            expired_json(json!({ "deadlineAt": 0, "now": 5000 }))["expired"],
            json!(false)
        );
    }

    // ── buildVerdictPrompt ─────────────────────────────────────────────────

    #[test]
    fn prompt_encodes_goal_criteria_and_human_only_rules() {
        let text = prompt(json!({
            "goal": "add dark mode to settings",
            "criteria": ["toggle persists", "tests pass"],
            "lastOutput": "done, added the toggle",
            "recent": [
                {"role": "user", "content": "please add dark mode"},
                {"role": "assistant", "content": "added the toggle"},
                {"role": "system", "content": "ignored"},
            ],
            "history": [{"verdict": "continue", "reason": "toggle missing"}],
            "pendingQuestion": {
                "requestId": "usrq-1",
                "question": "Light or dark default?",
                "options": ["light", "dark"],
            },
            "rounds": 2,
        }));
        assert!(text.contains("add dark mode to settings"));
        assert!(text.contains("toggle persists"));
        assert!(text.contains("AUTO FOLLOW-UPS SENT SO FAR: 2"));
        assert!(!text.contains("at most"));
        assert!(text.contains("no round limit"));
        assert!(text.contains("done, added the toggle"));
        assert!(text.contains("continue — toggle missing"));
        assert!(!text.contains("system: ignored"));
        for word in [
            "credentials",
            "CAPTCHA",
            "two-factor",
            "payment",
            "physical-world",
            "irreversible",
            "facts only the user knows",
            "demonstrably cannot overcome",
        ] {
            assert!(text.contains(word), "prompt must name {word}");
        }
        assert!(text.contains("answer this question yourself"));
        assert!(text.contains("\"answer\""));
        assert!(text.contains("pick the option"));
    }

    #[test]
    fn prompt_truncates_last_output() {
        let text = prompt(json!({ "goal": "g", "lastOutput": "z".repeat(20000) }));
        assert!(text.len() < 20000);
        assert!(text.contains(&"z".repeat(100)));
    }

    // ── parseVerdict ───────────────────────────────────────────────────────

    #[test]
    fn parses_plain_and_fenced_json() {
        let plain = parse(
            r#"{"verdict":"achieved","reason":"tests pass","nextInstruction":"","humanReason":""}"#,
        );
        assert_eq!(plain["ok"], json!(true));
        assert_eq!(plain["verdict"]["verdict"], json!("achieved"));
        assert_eq!(plain["verdict"]["reason"], json!("tests pass"));
        let fenced = parse(
            "Sure, here is my answer:\n```json\n{\"verdict\":\"continue\",\"reason\":\"wip\",\"nextInstruction\":\"run the tests\"}\n```\nDone.",
        );
        assert_eq!(fenced["ok"], json!(true));
        assert_eq!(fenced["verdict"]["verdict"], json!("continue"));
        assert_eq!(fenced["verdict"]["nextInstruction"], json!("run the tests"));
    }

    #[test]
    fn rejects_unknown_verdict_and_empty_instruction() {
        assert_eq!(
            parse(r#"{"verdict":"maybe","reason":"x"}"#)["ok"],
            json!(false)
        );
        assert_eq!(
            parse(r#"{"verdict":"continue","nextInstruction":"  "}"#)["ok"],
            json!(false)
        );
        assert_eq!(parse("not json at all")["ok"], json!(false));
        assert_eq!(parse("")["ok"], json!(false));
        assert_eq!(parse("{")["ok"], json!(false));
    }

    #[test]
    fn parse_never_throws_and_caps_strings() {
        let out = parse(&format!(
            "{{\"verdict\":\"needs_human\",\"humanReason\":\"{}\"}}",
            "h".repeat(5000)
        ));
        assert_eq!(out["ok"], json!(true));
        assert_eq!(
            utf16_len(out["verdict"]["humanReason"].as_str().unwrap()),
            MAX_HUMAN_REASON_CHARS
        );
    }

    // ── decide ─────────────────────────────────────────────────────────────

    #[test]
    fn achieved_updates_state_and_history() {
        let out = decide_json(json!({
            "state": active_state(2),
            "verdict": {"ok": true, "verdict": {"verdict": "achieved", "reason": "all green"}},
            "now": 200,
        }));
        assert_eq!(out["action"], json!("achieved"));
        assert_eq!(out["nextState"]["status"], json!("achieved"));
        assert_eq!(out["nextState"]["rounds"], json!(2));
        assert_eq!(out["nextState"]["updatedAt"], json!(200));
        assert_eq!(
            out["nextState"]["lastVerdict"]["verdict"],
            json!("achieved")
        );
        assert_eq!(out["nextState"]["lastVerdict"]["at"], json!(200));
        assert_eq!(out["nextState"]["history"].as_array().unwrap().len(), 1);
        assert!(out["message"].as_str().unwrap().contains("all green"));
    }

    #[test]
    fn continue_injects_and_counts_a_round() {
        let out = decide_json(json!({
            "state": active_state(2),
            "verdict": {"ok": true, "verdict": {"verdict": "continue", "reason": "wip", "nextInstruction": "run the tests"}},
            "now": 200,
        }));
        assert_eq!(out["action"], json!("inject"));
        assert_eq!(out["nextState"]["status"], json!("active"));
        assert_eq!(out["nextState"]["rounds"], json!(3));
        assert_eq!(out["nextState"]["stall"]["sameInstruction"], json!(1));
        assert_eq!(out["nextState"]["stall"]["auxFailures"], json!(0));
        assert_eq!(out["nextState"]["stall"]["consecutiveFaults"], json!(0));
        assert_eq!(
            out["message"],
            json!(format!("{UNATTENDED_TAG} run the tests"))
        );
    }

    #[test]
    fn no_round_cap_keeps_injecting_after_thirty_rounds() {
        let out = decide_json(json!({
            "state": active_state(500),
            "verdict": {"ok": true, "verdict": {"verdict": "continue", "nextInstruction": "one more"}},
            "now": 200,
        }));
        assert_eq!(out["action"], json!("inject"));
        assert_eq!(out["nextState"]["status"], json!("active"));
        assert_eq!(out["nextState"]["rounds"], json!(501));
        assert!(out["message"].as_str().unwrap().contains("one more"));
    }

    #[test]
    fn stall_after_three_identical_normalized_instructions() {
        let mut state = active_state(1);
        state["lastVerdict"] = json!({
            "verdict": "continue",
            "reason": "wip",
            "nextInstruction": "Run   the TESTS",
            "humanReason": "",
            "at": 100,
        });
        state["stall"] = json!({ "sameInstruction": 2, "auxFailures": 0 });
        let out = decide_json(json!({
            "state": state,
            "verdict": {"ok": true, "verdict": {"verdict": "continue", "nextInstruction": " run the tests "}},
            "now": 200,
        }));
        assert_eq!(out["action"], json!("stalled"));
        assert_eq!(out["nextState"]["status"], json!("needs_human"));
        assert_eq!(out["nextState"]["stall"]["sameInstruction"], json!(3));
        assert_eq!(out["nextState"]["rounds"], json!(1));
        assert!(out["message"].as_str().unwrap().contains("同一条指令"));
    }

    #[test]
    fn a_different_instruction_resets_the_stall_counter() {
        let mut state = active_state(1);
        state["lastVerdict"] = json!({
            "verdict": "continue", "nextInstruction": "run the tests", "at": 100,
        });
        state["stall"] = json!({ "sameInstruction": 2, "auxFailures": 0 });
        let out = decide_json(json!({
            "state": state,
            "verdict": {"ok": true, "verdict": {"verdict": "continue", "nextInstruction": "fix the lint error"}},
            "now": 200,
        }));
        assert_eq!(out["action"], json!("inject"));
        assert_eq!(out["nextState"]["stall"]["sameInstruction"], json!(1));
    }

    #[test]
    fn needs_human_carries_the_reason() {
        let out = decide_json(json!({
            "state": active_state(1),
            "verdict": {"ok": true, "verdict": {"verdict": "needs_human", "humanReason": "need the API key"}},
            "now": 200,
        }));
        assert_eq!(out["action"], json!("needs_human"));
        assert_eq!(out["nextState"]["status"], json!("needs_human"));
        assert!(out["message"]
            .as_str()
            .unwrap()
            .contains("need the API key"));
    }

    #[test]
    fn one_aux_failure_keeps_active_and_two_error() {
        let first = decide_json(json!({
            "state": active_state(1),
            "parseError": "unparseable_verdict",
            "now": 200,
        }));
        assert_eq!(first["action"], json!("none"));
        assert_eq!(first["nextState"]["status"], json!("active"));
        assert_eq!(first["nextState"]["stall"]["auxFailures"], json!(1));
        let second = decide_json(json!({
            "state": first["nextState"].clone(),
            "parseError": "aux failed",
            "now": 300,
        }));
        assert_eq!(second["action"], json!("error"));
        assert_eq!(second["nextState"]["status"], json!("error"));
        assert_eq!(second["nextState"]["stall"]["auxFailures"], json!(2));
        assert!(second["message"].as_str().unwrap().contains("连续 2 次"));
    }

    #[test]
    fn a_valid_verdict_resets_aux_failures() {
        let mut state = active_state(1);
        state["stall"] = json!({ "sameInstruction": 0, "auxFailures": 1 });
        let out = decide_json(json!({
            "state": state,
            "verdict": {"ok": true, "verdict": {"verdict": "continue", "nextInstruction": "go on"}},
            "now": 200,
        }));
        assert_eq!(out["nextState"]["stall"]["auxFailures"], json!(0));
    }

    #[test]
    fn history_is_capped_at_ten() {
        let history: Vec<Value> = (0..10)
            .map(|index| json!({"at": index, "verdict": "continue", "reason": format!("r{index}")}))
            .collect();
        let mut state = active_state(1);
        state["history"] = Value::Array(history);
        let out = decide_json(json!({
            "state": state,
            "verdict": {"ok": true, "verdict": {"verdict": "achieved", "reason": "done"}},
            "now": 200,
        }));
        let items = out["nextState"]["history"].as_array().unwrap();
        assert_eq!(items.len(), 10);
        assert_eq!(items[0]["reason"], json!("r1"));
        assert_eq!(items[9]["verdict"], json!("achieved"));
    }

    #[test]
    fn pending_question_answer_is_returned_for_delivery() {
        let out = decide_json(json!({
            "state": active_state(0),
            "verdict": {"ok": true, "verdict": {
                "verdict": "continue",
                "nextInstruction": "apply the choice",
                "answer": "dark",
            }},
            "evaluation": {"pendingQuestion": {"requestId": "usrq-9", "question": "which?"}},
            "now": 200,
        }));
        assert_eq!(out["action"], json!("inject"));
        assert_eq!(out["answer"], json!("dark"));
        assert_eq!(out["pendingQuestionId"], json!("usrq-9"));
    }

    #[test]
    fn non_active_state_is_a_no_op() {
        for status in ["achieved", "needs_human", "exhausted", "stopped", "error"] {
            let mut state = active_state(1);
            state["status"] = json!(status);
            let out = decide_json(json!({
                "state": state,
                "verdict": {"ok": true, "verdict": {"verdict": "continue", "nextInstruction": "x"}},
                "now": 200,
            }));
            assert_eq!(out["action"], json!("none"));
            assert_eq!(out["nextState"]["status"], json!(status));
        }
    }

    #[test]
    fn state_key_order_is_canonical() {
        let out = decide_json(json!({
            "state": active_state(0),
            "verdict": {"ok": true, "verdict": {"verdict": "continue", "nextInstruction": "go"}},
            "now": 200,
        }));
        let keys: Vec<&str> = out["nextState"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "status",
                "goal",
                "criteria",
                "maxDurationMinutes",
                "rounds",
                "startedAt",
                "deadlineAt",
                "updatedAt",
                "lastVerdict",
                "history",
                "stall",
                "evaluating",
                "pausedBy",
            ]
        );
        assert_eq!(out["nextState"]["evaluating"], json!(false));
        assert_eq!(out["nextState"]["pausedBy"], Value::Null);
    }

    #[test]
    fn decide_tolerates_a_minimal_state() {
        let out = decide_json(json!({
            "state": {"status": "active"},
            "verdict": {"ok": true, "verdict": {"verdict": "continue", "nextInstruction": "go"}},
            "now": 1,
        }));
        assert_eq!(out["action"], json!("inject"));
        assert_eq!(out["nextState"]["maxDurationMinutes"], json!(120));
        assert_eq!(out["nextState"]["startedAt"], json!(1));
        assert_eq!(
            out["nextState"]["deadlineAt"],
            json!(1 + 120 * MS_PER_MINUTE)
        );
    }

    // ── v2: optimistic tag stripping ───────────────────────────────────────

    #[test]
    fn an_aux_emitted_tag_is_stripped_before_injection() {
        let out = decide_json(json!({
            "state": active_state(0),
            "verdict": {"ok": true, "verdict": {
                "verdict": "continue",
                "nextInstruction": format!("{UNATTENDED_TAG} {UNATTENDED_TAG} run the tests"),
            }},
            "now": 200,
        }));
        assert_eq!(out["action"], json!("inject"));
        assert_eq!(
            out["message"],
            json!(format!("{UNATTENDED_TAG} run the tests"))
        );
    }

    #[test]
    fn a_valid_verdict_resets_consecutive_faults() {
        let mut state = active_state(1);
        state["stall"] = json!({ "sameInstruction": 0, "auxFailures": 0, "consecutiveFaults": 2 });
        let out = decide_json(json!({
            "state": state,
            "verdict": {"ok": true, "verdict": {"verdict": "continue", "nextInstruction": "go on"}},
            "now": 200,
        }));
        assert_eq!(out["nextState"]["stall"]["consecutiveFaults"], json!(0));
    }

    // ── v2: immediate fault continuation ───────────────────────────────────

    fn fault_json(input: Value) -> Value {
        serde_json::from_str(&decide_fault(&input.to_string()).unwrap()).unwrap()
    }

    #[test]
    fn fault_continue_counts_a_round_and_only_asks_to_verify() {
        let out = fault_json(json!({ "state": active_state(2), "now": 200 }));
        assert_eq!(out["action"], json!("fault_continue"));
        assert_eq!(out["nextState"]["status"], json!("active"));
        assert_eq!(out["nextState"]["rounds"], json!(3));
        assert_eq!(out["nextState"]["stall"]["consecutiveFaults"], json!(1));
        assert_eq!(out["nextState"]["evaluating"], json!(false));
        let message = out["message"].as_str().unwrap();
        assert!(message.starts_with(UNATTENDED_TAG));
        assert!(message.contains("verify the current state"));
        assert!(message.contains("Never redo writes"));
    }

    #[test]
    fn three_consecutive_faults_need_a_human() {
        let mut state = active_state(1);
        state["stall"] = json!({ "sameInstruction": 0, "auxFailures": 0, "consecutiveFaults": 2 });
        let out = fault_json(json!({ "state": state, "now": 200 }));
        assert_eq!(out["action"], json!("needs_human"));
        assert_eq!(out["nextState"]["status"], json!("needs_human"));
        assert_eq!(out["nextState"]["stall"]["consecutiveFaults"], json!(3));
        assert!(!out["message"].as_str().unwrap().starts_with(UNATTENDED_TAG));
    }

    #[test]
    fn a_fault_continues_even_after_many_rounds() {
        let out = fault_json(json!({ "state": active_state(900), "now": 200 }));
        assert_eq!(out["action"], json!("fault_continue"));
        assert_eq!(out["nextState"]["status"], json!("active"));
        assert_eq!(out["nextState"]["rounds"], json!(901));
    }

    #[test]
    fn fault_on_a_non_active_state_is_a_no_op() {
        let mut state = active_state(1);
        state["status"] = json!("stopped");
        let out = fault_json(json!({ "state": state, "now": 200 }));
        assert_eq!(out["action"], json!("none"));
        assert_eq!(out["nextState"]["status"], json!("stopped"));
    }

    // ── one decision for every turn end ────────────────────────────────────

    fn turn_end_json(input: Value) -> Value {
        serde_json::from_str(&decide_turn_end(&input.to_string()).unwrap()).unwrap()
    }

    fn cancel_input(source: &str, kill_reason: &str) -> Value {
        json!({
            "state": active_state(1),
            "now": 200,
            "kind": "cancel",
            "cancelSource": source,
            "killReason": kill_reason,
        })
    }

    #[test]
    fn a_clean_settle_evaluates_and_clears_the_fault_streak() {
        let mut state = active_state(2);
        state["stall"] = json!({ "sameInstruction": 0, "auxFailures": 0, "consecutiveFaults": 2 });
        let out =
            turn_end_json(json!({ "state": state, "now": 200, "kind": "settle", "settle": "D" }));
        assert_eq!(out["action"], json!("evaluate"));
        assert_eq!(out["resetFaults"], json!(true));
        assert_eq!(out["nextState"]["stall"]["consecutiveFaults"], json!(0));

        let w = turn_end_json(json!({
            "state": active_state(1), "now": 200, "kind": "settle", "settle": "W", "backlogPending": true,
        }));
        assert_eq!(
            w["action"],
            json!("evaluate"),
            "W is judged even with staged backlog"
        );
    }

    #[test]
    fn a_d_settle_defers_while_the_scheduler_has_backlog() {
        let out = turn_end_json(json!({
            "state": active_state(1), "now": 200, "kind": "settle", "settle": "D", "backlogPending": true,
        }));
        assert_eq!(out["action"], json!("none"));
        assert_eq!(out["reason"], json!("backlog_pending"));
    }

    #[test]
    fn a_policy_scheduled_retry_is_a_no_op_for_the_supervisor() {
        let out = turn_end_json(json!({
            "state": active_state(1), "now": 200, "kind": "fault", "retryScheduled": true,
            "turnId": "turn-retry",
        }));
        assert_eq!(out["action"], json!("none"));
        assert_eq!(out["reason"], json!("policy_retry"));
        // The retry reuses the same turn object: claiming it as handled here
        // would make the retry's real settle a duplicate and lock the session.
        assert!(
            out.get("nextState").is_none(),
            "policy retry must not claim the turn"
        );

        let settled = turn_end_json(json!({
            "state": active_state(1), "now": 300, "kind": "settle", "settle": "D",
            "turnId": "turn-retry",
        }));
        assert_eq!(
            settled["action"],
            json!("evaluate"),
            "the same turn id must still be evaluable after a policy retry"
        );

        let fail_fast = turn_end_json(json!({
            "state": active_state(1), "now": 200, "kind": "fault", "retryScheduled": false,
        }));
        assert_eq!(fail_fast["action"], json!("fault_continue"));
    }

    #[test]
    fn a_user_cancel_pauses_instead_of_continuing() {
        for source in [
            "manual_cancel",
            "task-shell",
            "user_cancel",
            "cancel_repeat",
            "dispatch_cancel",
            "force_insert",
            "insert_queued",
            "new_user_message",
        ] {
            let out = turn_end_json(cancel_input(source, source));
            assert_eq!(out["action"], json!("pause"), "{source}");
            assert_eq!(out["nextState"]["status"], json!("stopped"), "{source}");
            assert_eq!(out["nextState"]["evaluating"], json!(false));
            let expected =
                if ["force_insert", "insert_queued", "new_user_message"].contains(&source) {
                    "input"
                } else {
                    "cancel"
                };
            assert_eq!(out["pausedBy"], json!(expected), "{source}");
        }
        // The kill reason alone is enough: an insert supersedes the turn.
        let out = turn_end_json(cancel_input("manual_cancel", "new_user_message"));
        assert_eq!(out["action"], json!("pause"));
        assert_eq!(out["pausedBy"], json!("input"));
    }

    #[test]
    fn a_host_side_cancel_is_a_fault_continuation() {
        for (source, kill_reason) in [
            ("process_watchdog", "process_watchdog"),
            ("stalled_recovery", "stalled_recovery"),
            ("shutdown", "shutdown"),
            ("cli_switch", "cli_switch"),
            ("relocate", "relocate"),
            ("restart_spawn", "restart_spawn"),
            ("preparation_failed", "preparation_failed"),
            ("codex_log_watchdog", "provider_log_error"),
        ] {
            let out = turn_end_json(cancel_input(source, kill_reason));
            assert_eq!(out["action"], json!("fault_continue"), "{source}");
            assert_eq!(out["nextState"]["status"], json!("active"), "{source}");
            assert_eq!(
                out["nextState"]["stall"]["consecutiveFaults"],
                json!(1),
                "{source}"
            );
            let message = out["message"].as_str().unwrap();
            assert!(message.starts_with(UNATTENDED_TAG));
            assert!(message.contains("verify the current state"));
        }
    }

    #[test]
    fn three_consecutive_host_cancels_need_a_human() {
        let mut state = active_state(1);
        state["stall"] = json!({ "sameInstruction": 0, "auxFailures": 0, "consecutiveFaults": 2 });
        let out = turn_end_json(json!({
            "state": state, "now": 200, "kind": "cancel", "cancelSource": "process_watchdog",
        }));
        assert_eq!(out["action"], json!("needs_human"));
        assert_eq!(out["nextState"]["status"], json!("needs_human"));
        assert_eq!(out["nextState"]["stall"]["consecutiveFaults"], json!(3));
    }

    #[test]
    fn an_unrecognized_cancel_pauses_instead_of_injecting() {
        let out = turn_end_json(cancel_input("mystery_stop", "mystery_stop"));
        assert_eq!(out["action"], json!("pause"));
        assert_eq!(out["reason"], json!("unrecognized_cancel_source"));
        assert_eq!(out["pausedBy"], json!("cancel"));
    }

    #[test]
    fn a_real_user_message_pauses_as_takeover() {
        let out =
            turn_end_json(json!({ "state": active_state(1), "now": 200, "kind": "user_input" }));
        assert_eq!(out["action"], json!("pause"));
        assert_eq!(out["pausedBy"], json!("input"));
        assert_eq!(out["nextState"]["pausedBy"], json!("input"));
    }

    #[test]
    fn a_turn_end_on_a_non_active_session_is_a_no_op() {
        let mut state = active_state(1);
        state["status"] = json!("needs_human");
        for kind in ["settle", "fault", "cancel", "user_input"] {
            let out = turn_end_json(json!({
                "state": state, "now": 200, "kind": kind, "settle": "D",
                "cancelSource": "process_watchdog",
            }));
            assert_eq!(out["action"], json!("none"), "{kind}");
        }
        let unknown =
            turn_end_json(json!({ "state": active_state(1), "now": 200, "kind": "nope" }));
        assert_eq!(unknown["action"], json!("none"));
        assert_eq!(unknown["reason"], json!("unknown_kind"));
    }

    #[test]
    fn a_user_caused_fault_pauses_instead_of_continuing() {
        // The turn-finalize observer reports E before the cancel writer runs.
        // The kill reason is already assigned at that point, so attribution —
        // not `kind` — decides: a user source pauses and never injects.
        for source in USER_CANCEL_SOURCES {
            for retry_scheduled in [false, true] {
                let out = turn_end_json(json!({
                    "state": active_state(1), "now": 200, "kind": "fault",
                    "killReason": source, "retryScheduled": retry_scheduled,
                }));
                assert_eq!(out["action"], json!("pause"), "{source}");
                assert_eq!(out["nextState"]["status"], json!("stopped"), "{source}");
                assert_eq!(out["nextState"]["evaluating"], json!(false), "{source}");
                let expected = if USER_INPUT_SOURCES.contains(&source) {
                    "input"
                } else {
                    "cancel"
                };
                assert_eq!(out["pausedBy"], json!(expected), "{source}");
            }
        }
        // The cancel-source field is equally authoritative.
        let out = turn_end_json(json!({
            "state": active_state(1), "now": 200, "kind": "fault",
            "cancelSource": "manual_cancel", "retryScheduled": false,
        }));
        assert_eq!(out["action"], json!("pause"));
    }

    #[test]
    fn a_second_report_for_the_same_turn_is_a_no_op() {
        let mut state = active_state(1);
        state["lastTurnEndId"] = json!("turn-1");
        let out = turn_end_json(json!({
            "state": state, "now": 200, "kind": "cancel", "turnId": "turn-1",
            "cancelSource": "process_watchdog", "killReason": "process_watchdog",
        }));
        assert_eq!(out["action"], json!("none"));
        assert_eq!(out["reason"], json!("duplicate_turn"));
        assert!(out.get("nextState").is_none() || out["nextState"].is_null());
    }

    #[test]
    fn a_later_user_cancel_for_a_handled_turn_pauses_without_another_injection() {
        let mut state = active_state(1);
        state["lastTurnEndId"] = json!("turn-1");
        let out = turn_end_json(json!({
            "state": state, "now": 200, "kind": "cancel", "turnId": "turn-1",
            "cancelSource": "manual_cancel",
        }));
        assert_eq!(out["action"], json!("pause"));
        assert_eq!(out["reason"], json!("duplicate_user_takeover"));
        assert_eq!(out["pausedBy"], json!("cancel"));
        assert_eq!(out["nextState"]["lastTurnEndId"], json!("turn-1"));
    }

    #[test]
    fn every_acting_turn_end_records_the_turn_identity() {
        let out = turn_end_json(json!({
            "state": active_state(1), "now": 200, "kind": "cancel", "turnId": "turn-7",
            "cancelSource": "process_watchdog", "killReason": "process_watchdog",
        }));
        assert_eq!(out["action"], json!("fault_continue"));
        assert_eq!(out["nextState"]["lastTurnEndId"], json!("turn-7"));

        let pause = turn_end_json(json!({
            "state": active_state(1), "now": 200, "kind": "cancel", "turnId": "turn-8",
            "cancelSource": "manual_cancel",
        }));
        assert_eq!(pause["nextState"]["lastTurnEndId"], json!("turn-8"));
    }

    #[test]
    fn a_verdict_rebuild_preserves_host_bookkeeping() {
        let mut state = active_state(1);
        state["lastSettleAt"] = json!(6000);
        state["lastTurnEndId"] = json!("turn-9");
        let out = decide_json(json!({
            "state": state,
            "verdict": { "verdict": "continue", "reason": "more", "nextInstruction": "go" },
            "now": 7000,
        }));
        assert_eq!(out["nextState"]["lastSettleAt"], json!(6000));
        assert_eq!(out["nextState"]["lastTurnEndId"], json!("turn-9"));
    }

    #[test]
    fn retry_scheduled_must_be_a_boolean_fact() {
        let error = decide_turn_end(
            &json!({
                "state": active_state(1), "now": 200, "kind": "fault",
                "retryScheduled": "true",
            })
            .to_string(),
        )
        .unwrap_err();
        assert!(error.contains("retryScheduled"), "{error}");
    }
}
