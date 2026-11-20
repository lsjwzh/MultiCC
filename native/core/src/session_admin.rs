//! Rules kernel for the session-admin route cluster (`src/routes/session-admin.js`).
//!
//! Everything that is a *rule* over the Node runtime's answers lives here: the
//! public session DTO (`src/session-dto.js`), the four legacy presenters that
//! whitelist and order their fields, the workspace projection
//! (`src/session/workspace-service.js`), the classify-letter predicates, the
//! `isInjectedOrJunkGoal` rule and the transcript helpers used by the debug
//! classifier endpoints. Path matching, parameter decoding, query/body reads and
//! the Express OPTIONS answer live in the front-door handler
//! (`native/gateway/src/app/session_admin.rs`).
//!
//! Everything that needs the process-local world stays in Node behind the host
//! port (`src/routes/session-admin-host.js`): the records Map, terminal/chat
//! live tables, the classify state machine, chat history, workspace status,
//! auxiliary queue, persistence and WebSocket broadcast. The front door only
//! ever sends `{ op, … }` and gets the runtime value back.
//!
//! Byte-for-byte parity is the contract: `express::json` serializes through the
//! V8-compatible `js_json_stringify`, so a value that round-trips through this
//! kernel keeps the exact key order and number spelling Node produced.

use std::sync::OnceLock;

use regex::{Captures, Regex};
use serde_json::{Map, Value};

use crate::js::json::date_to_iso_string;
use crate::js::regex::{ascii_ci, from_unit_view, to_unit_view, BOUNDARY, SPACE};
use crate::js::serde::{
    js_math_min, js_string, js_to_number, number_value, truthy, value_or_empty,
};
use crate::js::string::{js_trim, utf16_len, utf16_prefix, utf16_suffix};
use crate::js::JsString;

// ── classify letters (src/classify/vocab.js) ───────────────────────────────

/// `isTerminalLetter`: a cleanly finished turn.
pub fn is_terminal_letter(state: Option<&Value>) -> bool {
    matches!(state, Some(Value::String(text)) if text == "D")
}

/// `isWaitForUserLetter`.
pub fn is_wait_for_user_letter(state: Option<&Value>) -> bool {
    matches!(state, Some(Value::String(text)) if text == "W")
}

/// `isSettledLetter`: `isTerminalLetter(cls) || isWaitForUserLetter(cls)`.
pub fn is_settled_letter(state: Option<&Value>) -> bool {
    is_terminal_letter(state) || is_wait_for_user_letter(state)
}

/// `GOAL_STATES.achieved`.
pub const GOAL_ACHIEVED: &str = "achieved";

/// `SYSTEM_PREFIX` (src/session/delivery.js).
pub const SYSTEM_PREFIX: &str = "\u{1F507}";

/// `isInjectedOrJunkGoal(goal)`: empty, system-injected or a raw tool payload.
pub fn is_injected_or_junk_goal(goal: Option<&Value>) -> bool {
    let goal = value_or_empty(goal);
    let text = js_trim(&goal);
    if text.is_empty() {
        return true;
    }
    text.starts_with(SYSTEM_PREFIX) || text.starts_with('<') || text.starts_with("\"<")
}

// ── small JS coercions ─────────────────────────────────────────────────────

/// `value || fallback` (`truthy` keeps arrays/objects).
fn or_value(value: Option<&Value>, fallback: Value) -> Value {
    match value {
        Some(inner) if truthy(inner) => inner.clone(),
        _ => fallback,
    }
}

/// `value || null`.
pub fn or_null(value: Option<&Value>) -> Value {
    or_value(value, Value::Null)
}

/// `value || ''` for a value built in place (no temporary borrow to keep).
fn or_empty_value(value: Value) -> Value {
    if truthy(&value) {
        value
    } else {
        Value::String(String::new())
    }
}

/// Strict-string comparison (`value === 'literal'`).
pub fn eq_str(value: Option<&Value>, literal: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == literal)
}

/// `value !== false`.
fn not_false(value: Option<&Value>) -> Value {
    Value::Bool(!matches!(value, Some(Value::Bool(false))))
}

/// `value === true`.
fn is_true(value: Option<&Value>) -> Value {
    Value::Bool(matches!(value, Some(Value::Bool(true))))
}

/// `String(value || '')` for a member of `source`.
fn str_field(source: &Value, key: &str) -> String {
    value_or_empty(source.get(key))
}

/// `nullableString(value, max)`: `String(value).slice(0, max)`, or `null`.
pub fn nullable_string(value: Option<&Value>, max: usize) -> Value {
    match value {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(text)) if text.is_empty() => Value::Null,
        Some(inner) => Value::String(utf16_prefix(&js_string(inner), max)),
    }
}

/// `boundedString(value, max, fallback)` (src/session/workspace-service.js).
pub fn bounded_string(value: Option<&Value>, max: usize, fallback: Value) -> Value {
    match value {
        None | Some(Value::Null) => fallback,
        Some(Value::String(text)) if text.is_empty() => fallback,
        Some(inner) => Value::String(utf16_prefix(&js_string(inner), max)),
    }
}

/// Canonical ISO-8601 with milliseconds, the only form Node produces from
/// `new Date(ms).toISOString()` and the only date string records carry.
fn canonical_iso(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
        })
}

/// `timestamp(value)` / `isoTimestamp(value)`: `new Date(value).toISOString()`
/// when the time is finite, else `null`.
///
/// Records hold epoch milliseconds (numbers). A `Date` reaches this kernel only
/// after the host port's JSON transport turned it into the canonical ISO string,
/// which `new Date(...).toISOString()` returns unchanged.
pub fn timestamp(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(text)) => {
            if canonical_iso(text) {
                Value::String(text.clone())
            } else {
                Value::Null
            }
        }
        Some(inner) => match date_to_iso_string(js_to_number(inner)) {
            Some(text) => Value::String(text),
            None => Value::Null,
        },
    }
}

/// `Math.max(0, Math.floor(Number(value) || 0))`.
fn non_negative_int(value: Option<&Value>) -> Value {
    let number = js_to_number(value.unwrap_or(&Value::Null));
    let number = if number.is_nan() || number == 0.0 {
        0.0
    } else {
        number
    };
    number_value(number.floor().max(0.0))
}

/// `Math.max(0, Number(value) || 0)`.
fn non_negative_number(value: Option<&Value>) -> Value {
    let number = js_to_number(value.unwrap_or(&Value::Null));
    let number = if number.is_nan() || number == 0.0 {
        0.0
    } else {
        number
    };
    number_value(number.max(0.0))
}

// ── src/session-dto.js ─────────────────────────────────────────────────────

pub const SUPPORTED_CLIS: &[&str] = &[
    "claude",
    "claude-exp",
    "codex",
    "codex-exp",
    "opencode",
    "zcode",
    "qoder",
    "kimi",
    "codebuddy",
    "dsh",
    "gemini",
    "grok",
    "agy",
    "commandcode",
    "pi",
];

fn bearer_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(&format!(
            "{BOUNDARY}{}[{SPACE}]+[^{SPACE}]+",
            ascii_ci("Bearer")
        ))
        .expect("bearer redaction pattern")
    })
}

fn secret_token_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        // No `/i`: only the lowercase spellings JS matches.
        Regex::new(&format!(
            "{BOUNDARY}(?:sk|gh[pousr])[-_][-A-Za-z0-9_]{{8,}}{BOUNDARY}"
        ))
        .expect("secret token pattern")
    })
}

fn key_value_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        let api_key = format!("{}[_-]?{}", ascii_ci("api"), ascii_ci("key"));
        Regex::new(&format!(
            "{BOUNDARY}({}|{}|{}|{})[{SPACE}]*([:=])[{SPACE}]*[\"']?[^{SPACE},;\"']+",
            api_key,
            ascii_ci("token"),
            ascii_ci("secret"),
            ascii_ci("password"),
        ))
        .expect("key/value redaction pattern")
    })
}

fn windows_path_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(&format!(r"[A-Za-z]:\\(?:[^\\{SPACE}]+\\){{1,}}[^{SPACE}]*"))
            .expect("windows path pattern")
    })
}

fn posix_path_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?:/[A-Za-z0-9._~@+-]+){2,}").expect("posix path pattern"))
}

/// `sanitizePublicText(value, max)` (src/session-dto.js): five redactions, then
/// `slice(0, max)` in UTF-16 code units.
pub fn sanitize_public_text(value: Option<&Value>, max: usize) -> Value {
    let text = match value {
        None | Some(Value::Null) => return Value::Null,
        Some(Value::String(text)) if text.is_empty() => return Value::Null,
        Some(inner) => js_string(inner),
    };
    let view = to_unit_view(&JsString::from_rust_str(&text));
    let view = bearer_pattern()
        .replace_all(&view, "Bearer [redacted]")
        .into_owned();
    let view = secret_token_pattern()
        .replace_all(&view, "[redacted]")
        .into_owned();
    let view = key_value_pattern()
        .replace_all(&view, |caps: &Captures<'_>| {
            let keyword = caps.get(1).map_or("", |m| m.as_str());
            let operator = caps.get(2).map_or("", |m| m.as_str());
            format!("{keyword}{operator}[redacted]")
        })
        .into_owned();
    let view = windows_path_pattern()
        .replace_all(&view, "[path]")
        .into_owned();
    let view = posix_path_pattern()
        .replace_all(&view, "[path]")
        .into_owned();
    let cut: String = view.chars().take(max).collect();
    Value::String(from_unit_view(&cut).to_string_lossy())
}

/// `subagentDto(value)`.
pub fn subagent_dto(value: Option<&Value>) -> Value {
    let Some(source) = value.filter(|inner| inner.is_object()) else {
        return Value::Null;
    };
    let provider_id = nullable_string(source.get("providerId"), 160);
    let model = nullable_string(source.get("model"), 160);
    if !truthy(&provider_id) || !truthy(&model) {
        return Value::Null;
    }
    let mut out = Map::new();
    out.insert("providerId".into(), provider_id);
    out.insert("model".into(), model);
    out.insert(
        "effectiveModel".into(),
        nullable_string(source.get("effectiveModel"), 160),
    );
    if matches!(source.get("inherited"), Some(Value::Bool(true))) {
        out.insert("inherited".into(), Value::Bool(true));
    }
    Value::Object(out)
}

/// `mergeStateDto(value)`.
pub fn merge_state_dto(value: Option<&Value>) -> Value {
    let Some(source) = value.filter(|inner| inner.is_object()) else {
        return Value::Null;
    };
    let mut out = Map::new();
    out.insert("ahead".into(), non_negative_number(source.get("ahead")));
    out.insert("behind".into(), non_negative_number(source.get("behind")));
    out.insert(
        "dirty".into(),
        Value::Bool(truthy(source.get("dirty").unwrap_or(&Value::Null))),
    );
    out.insert(
        "mergeReady".into(),
        Value::Bool(truthy(source.get("mergeReady").unwrap_or(&Value::Null))),
    );
    out.insert(
        "rebaseInProgress".into(),
        Value::Bool(truthy(
            source.get("rebaseInProgress").unwrap_or(&Value::Null),
        )),
    );
    Value::Object(out)
}

const UNATTENDED_STATUSES: &[&str] = &[
    "active",
    "achieved",
    "needs_human",
    "exhausted",
    "stopped",
    "error",
];
const UNATTENDED_VERDICTS: &[&str] = &["achieved", "continue", "needs_human"];

/// `verdict(value)`: a known verdict, else `'continue'`.
fn unattended_verdict(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) if UNATTENDED_VERDICTS.contains(&text.as_str()) => {
            Value::String(text.clone())
        }
        _ => Value::String("continue".into()),
    }
}

/// `unattendedDto(value)` — the bounded public projection of unattended mode.
pub fn unattended_dto(value: Option<&Value>) -> Value {
    let Some(source) = value.filter(|inner| inner.is_object() || inner.is_array()) else {
        return Value::Null;
    };

    let status = match source.get("status") {
        Some(Value::String(text)) if UNATTENDED_STATUSES.contains(&text.as_str()) => {
            Value::String(text.clone())
        }
        _ => Value::String("stopped".into()),
    };

    let criteria = match source.get("criteria") {
        Some(Value::Array(items)) => Value::Array(
            items
                .iter()
                .take(12)
                .map(|item| nullable_string(Some(item), 300))
                .filter(truthy)
                .collect(),
        ),
        _ => Value::Array(Vec::new()),
    };

    let history = match source.get("history") {
        Some(Value::Array(items)) => {
            let start = items.len().saturating_sub(10);
            Value::Array(
                items[start..]
                    .iter()
                    .map(|row| {
                        let mut out = Map::new();
                        let at = row.get("at").filter(|_| truthy(row)).cloned();
                        out.insert("at".into(), non_negative_number(at.as_ref()));
                        out.insert("verdict".into(), unattended_verdict(row.get("verdict")));
                        out.insert(
                            "reason".into(),
                            or_empty_value(nullable_string(row.get("reason"), 1000)),
                        );
                        Value::Object(out)
                    })
                    .collect(),
            )
        }
        _ => Value::Array(Vec::new()),
    };

    let last_verdict = match source
        .get("lastVerdict")
        .filter(|inner| truthy(inner) && inner.is_object())
    {
        Some(verdict) => {
            let mut out = Map::new();
            out.insert("verdict".into(), unattended_verdict(verdict.get("verdict")));
            out.insert(
                "reason".into(),
                or_empty_value(nullable_string(verdict.get("reason"), 1000)),
            );
            out.insert(
                "nextInstruction".into(),
                or_empty_value(nullable_string(verdict.get("nextInstruction"), 4000)),
            );
            out.insert(
                "humanReason".into(),
                or_empty_value(nullable_string(verdict.get("humanReason"), 1000)),
            );
            out.insert("at".into(), non_negative_number(verdict.get("at")));
            Value::Object(out)
        }
        _ => Value::Null,
    };

    let stall = match source
        .get("stall")
        .filter(|inner| truthy(inner) && inner.is_object())
    {
        Some(stall) => {
            let mut out = Map::new();
            out.insert(
                "sameInstruction".into(),
                non_negative_int(stall.get("sameInstruction")),
            );
            out.insert(
                "auxFailures".into(),
                non_negative_int(stall.get("auxFailures")),
            );
            out.insert(
                "consecutiveFaults".into(),
                non_negative_int(stall.get("consecutiveFaults")),
            );
            Value::Object(out)
        }
        _ => {
            let mut out = Map::new();
            out.insert("sameInstruction".into(), Value::from(0));
            out.insert("auxFailures".into(), Value::from(0));
            out.insert("consecutiveFaults".into(), Value::from(0));
            Value::Object(out)
        }
    };

    let paused_by = match source.get("pausedBy") {
        Some(Value::String(text)) if matches!(text.as_str(), "user" | "input" | "cancel") => {
            Value::String(text.clone())
        }
        _ => Value::Null,
    };

    let retry_at = {
        let value = non_negative_number(source.get("retryAt"));
        if truthy(&value) {
            value
        } else {
            Value::Null
        }
    };

    let retry_category = match source.get("retryCategory") {
        Some(Value::String(text)) if matches!(text.as_str(), "capacity" | "fault") => {
            Value::String(text.clone())
        }
        _ => Value::Null,
    };

    let max_duration = {
        let number = js_to_number(source.get("maxDurationMinutes").unwrap_or(&Value::Null));
        let number = if number.is_nan() || number == 0.0 {
            120.0
        } else {
            number
        };
        let clamped = js_math_min(1440.0, number.floor().max(5.0));
        number_value(clamped)
    };

    let mut out = Map::new();
    out.insert("status".into(), status);
    out.insert(
        "goal".into(),
        or_empty_value(nullable_string(source.get("goal"), 2000)),
    );
    out.insert("criteria".into(), criteria);
    out.insert("maxDurationMinutes".into(), max_duration);
    out.insert("rounds".into(), non_negative_int(source.get("rounds")));
    out.insert(
        "startedAt".into(),
        non_negative_number(source.get("startedAt")),
    );
    out.insert(
        "deadlineAt".into(),
        non_negative_number(source.get("deadlineAt")),
    );
    out.insert(
        "updatedAt".into(),
        non_negative_number(source.get("updatedAt")),
    );
    out.insert("lastVerdict".into(), last_verdict);
    out.insert("history".into(), history);
    out.insert("stall".into(), stall);
    out.insert("retryAt".into(), retry_at);
    out.insert("retryCategory".into(), retry_category);
    out.insert("evaluating".into(), is_true(source.get("evaluating")));
    out.insert("pausedBy".into(), paused_by);
    Value::Object(out)
}

/// `toSessionDto(source)` — the public session contract.
///
/// `providerSelection` is always `null`: the query service's
/// `sessionDtoPresenter` does not forward it, and this DTO is only reached
/// through that presenter.
pub fn to_session_dto(source: &Value) -> Value {
    let cli = match source.get("cli") {
        Some(Value::String(text)) if SUPPORTED_CLIS.contains(&text.as_str()) => {
            Value::String(text.clone())
        }
        _ => Value::String("claude".into()),
    };
    let kind = match source.get("kind") {
        Some(Value::String(text)) if matches!(text.as_str(), "chat" | "terminal") => {
            Value::String(text.clone())
        }
        _ => Value::String("terminal".into()),
    };
    let workspace_state = match source.get("workspaceState") {
        Some(Value::String(text))
            if matches!(
                text.as_str(),
                "planned" | "hibernated" | "hibernating" | "thawing"
            ) =>
        {
            Value::String("hibernated".into())
        }
        _ => Value::String("awake".into()),
    };
    let last_work_at = match source.get("lastWorkAt") {
        Some(inner) if truthy(inner) => timestamp(Some(inner)),
        _ => timestamp(source.get("createdAt")),
    };

    let mut out = Map::new();
    out.insert("id".into(), Value::String(str_field(source, "id")));
    out.insert("dirId".into(), nullable_string(source.get("dirId"), 160));
    out.insert("type".into(), Value::String("session".into()));
    out.insert("cli".into(), cli);
    out.insert("kind".into(), kind);
    out.insert("label".into(), nullable_string(source.get("label"), 160));
    out.insert("model".into(), nullable_string(source.get("model"), 160));
    out.insert(
        "effectiveModel".into(),
        nullable_string(source.get("effectiveModel"), 160),
    );
    out.insert("effort".into(), nullable_string(source.get("effort"), 80));
    out.insert(
        "effectiveEffort".into(),
        nullable_string(source.get("effectiveEffort"), 80),
    );
    out.insert("agent".into(), nullable_string(source.get("agent"), 160));
    out.insert(
        "provider".into(),
        nullable_string(source.get("provider"), 160),
    );
    out.insert("providerSelection".into(), Value::Null);
    out.insert(
        "experimentalMode".into(),
        nullable_string(source.get("experimentalMode"), 80),
    );
    out.insert("subagent".into(), subagent_dto(source.get("subagent")));
    out.insert("autoCommit".into(), not_false(source.get("autoCommit")));
    out.insert("createdAt".into(), timestamp(source.get("createdAt")));
    out.insert("lastActivity".into(), timestamp(source.get("lastActivity")));
    out.insert("clients".into(), non_negative_int(source.get("clients")));
    out.insert(
        "active".into(),
        Value::Bool(truthy(source.get("active").unwrap_or(&Value::Null))),
    );
    out.insert("workspaceState".into(), workspace_state);
    out.insert("lastWorkAt".into(), last_work_at);
    out.insert("hibernatedAt".into(), timestamp(source.get("hibernatedAt")));
    out.insert(
        "mergeState".into(),
        merge_state_dto(source.get("mergeState")),
    );
    out.insert(
        "unattended".into(),
        unattended_dto(source.get("unattended")),
    );
    Value::Object(out)
}

/// `sessionDtoPresenter({record, runtime})` — the source object
/// `toSessionDto` projects for the `/api/v1` surface.
pub fn session_dto_source(record: &Value, runtime: &Value) -> Value {
    let subagent = match runtime.get("subagent") {
        Some(inner) => inner.clone(),
        None => record.get("subagent").cloned().unwrap_or(Value::Null),
    };
    let mut out = Map::new();
    out.insert("id".into(), clone_field(record, "id"));
    out.insert("dirId".into(), clone_field(record, "dirId"));
    out.insert("cli".into(), clone_field(record, "cli"));
    out.insert("kind".into(), clone_field(record, "kind"));
    out.insert("label".into(), clone_field(record, "label"));
    out.insert("model".into(), clone_field(record, "model"));
    out.insert(
        "effectiveModel".into(),
        clone_field(runtime, "effectiveModel"),
    );
    out.insert("effort".into(), clone_field(record, "effort"));
    out.insert(
        "effectiveEffort".into(),
        clone_field(runtime, "effectiveEffort"),
    );
    out.insert("agent".into(), clone_field(record, "agent"));
    out.insert("provider".into(), clone_field(record, "provider"));
    out.insert(
        "experimentalMode".into(),
        clone_field(record, "experimentalMode"),
    );
    out.insert("subagent".into(), subagent);
    out.insert("autoCommit".into(), clone_field(record, "autoCommit"));
    out.insert("createdAt".into(), clone_field(record, "createdAt"));
    out.insert("lastActivity".into(), clone_field(runtime, "lastActivity"));
    out.insert("clients".into(), clone_field(runtime, "clients"));
    out.insert("active".into(), clone_field(runtime, "active"));
    out.insert(
        "workspaceState".into(),
        clone_field(record, "workspaceState"),
    );
    out.insert("lastWorkAt".into(), clone_field(record, "lastWorkAt"));
    out.insert("hibernatedAt".into(), clone_field(record, "hibernatedAt"));
    out.insert("mergeState".into(), clone_field(runtime, "mergeState"));
    out.insert("unattended".into(), clone_field(record, "unattended"));
    Value::Object(out)
}

// ── src/session/workspace-service.js ───────────────────────────────────────

const WORKSPACE_STATUSES: &[&str] = &[
    "idle",
    "thinking",
    "editing",
    "running",
    "waiting",
    "background",
    "succeeded",
    "completed",
    "error",
];

/// `workspaceEntry(session, facts)`: the public session DTO plus the bounded
/// workspace facts. Keys introduced by the spread keep their original order.
pub fn workspace_entry(session: Value, facts: &Value) -> Value {
    let mut out = match session {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    out.insert(
        "status".into(),
        match facts.get("status") {
            Some(Value::String(text)) if WORKSPACE_STATUSES.contains(&text.as_str()) => {
                Value::String(text.clone())
            }
            _ => Value::String("idle".into()),
        },
    );
    out.insert(
        "statusUpdatedAt".into(),
        timestamp(facts.get("lastActivity")),
    );
    out.insert("runStartedAt".into(), timestamp(facts.get("runStartedAt")));
    out.insert("runEndedAt".into(), timestamp(facts.get("runEndedAt")));
    out.insert(
        "pendingNotes".into(),
        non_negative_int(facts.get("pendingNotes")),
    );
    out.insert(
        "summary".into(),
        sanitize_public_text(facts.get("summary"), 1000),
    );
    out.insert("summaryAt".into(), timestamp(facts.get("summaryAt")));
    out.insert(
        "classifyState".into(),
        bounded_string(facts.get("classifyState"), 40, Value::Null),
    );
    out.insert(
        "goal".into(),
        or_empty_value(sanitize_public_text(facts.get("goal"), 1000)),
    );
    out.insert(
        "taskShortCode".into(),
        bounded_string(facts.get("taskShortCode"), 8, Value::String(String::new())),
    );
    out.insert(
        "phase".into(),
        bounded_string(facts.get("phase"), 80, Value::String("idle".into())),
    );
    out.insert("auxUnhealthy".into(), is_true(facts.get("auxUnhealthy")));
    out.insert("auxUnhealthySince".into(), {
        let number = js_to_number(facts.get("auxUnhealthySince").unwrap_or(&Value::Null));
        if number.is_finite() {
            number_value(number)
        } else {
            Value::Null
        }
    });
    Value::Object(out)
}

/// `directoryDto(directory)`.
pub fn directory_dto(directory: Option<&Value>) -> Value {
    let Some(directory) = directory.filter(|inner| inner.is_object()) else {
        return Value::Null;
    };
    if !truthy(directory.get("id").unwrap_or(&Value::Null)) {
        return Value::Null;
    }
    let label_source = match directory.get("label") {
        Some(inner) if truthy(inner) => Some(inner),
        _ => directory.get("name"),
    };
    let mut out = Map::new();
    out.insert("id".into(), Value::String(str_field(directory, "id")));
    out.insert(
        "label".into(),
        bounded_string(label_source, 160, Value::Null),
    );
    Value::Object(out)
}

/// `workspaceContractView(snapshot)` — the v1 projection that lifts the
/// workspace facts above a nested `session` member.
pub fn workspace_contract_view(directory: Value, sessions: Vec<Value>) -> Value {
    const MOVED: &[&str] = &[
        "status",
        "statusUpdatedAt",
        "runStartedAt",
        "runEndedAt",
        "pendingNotes",
        "summary",
        "summaryAt",
        "classifyState",
        "goal",
        "phase",
    ];
    let entries: Vec<Value> = sessions
        .into_iter()
        .map(|entry| {
            let mut session = Map::new();
            let mut lifted: Vec<(&str, Value)> = Vec::new();
            if let Value::Object(map) = entry {
                for (key, value) in map {
                    if MOVED.contains(&key.as_str()) {
                        lifted.push((moved_name(&key), value));
                    } else {
                        session.insert(key, value);
                    }
                }
            }
            let mut out = Map::new();
            out.insert("session".into(), Value::Object(session));
            for (name, value) in lifted {
                out.insert(name.to_string(), value);
            }
            Value::Object(out)
        })
        .collect();
    let count = entries.len();
    let mut out = Map::new();
    out.insert("directory".into(), directory);
    out.insert("sessions".into(), Value::Array(entries));
    out.insert("count".into(), Value::from(count));
    Value::Object(out)
}

fn moved_name(key: &str) -> &'static str {
    match key {
        "status" => "status",
        "statusUpdatedAt" => "statusUpdatedAt",
        "runStartedAt" => "runStartedAt",
        "runEndedAt" => "runEndedAt",
        "pendingNotes" => "pendingNotes",
        "summary" => "summary",
        "summaryAt" => "summaryAt",
        "classifyState" => "classifyState",
        "goal" => "goal",
        _ => "phase",
    }
}

// ── the four legacy presenters ─────────────────────────────────────────────

/// `legacySessionListPresenter({record, runtime})`; `facts` carries the
/// host-computed `providerSelection`, `cliStates` and `pendingCliHandoff`.
pub fn legacy_session_list(record: &Value, runtime: &Value, facts: &Value) -> Value {
    let use_chat_runtime = eq_str(record.get("kind"), "chat")
        || !truthy(runtime.get("terminalActive").unwrap_or(&Value::Null));
    let is_chat = eq_str(record.get("kind"), "chat");
    let mut out = Map::new();
    out.insert("id".into(), or_null(record.get("id")));
    out.insert("dirId".into(), or_null(record.get("dirId")));
    out.insert(
        "cli".into(),
        or_value(record.get("cli"), Value::String("claude".into())),
    );
    out.insert(
        "kind".into(),
        or_value(record.get("kind"), Value::String("terminal".into())),
    );
    out.insert("type".into(), or_null(record.get("type")));
    out.insert("cliSessionId".into(), or_null(record.get("cliSessionId")));
    out.insert("label".into(), or_null(record.get("label")));
    out.insert("model".into(), or_null(record.get("model")));
    out.insert(
        "effectiveModel".into(),
        clone_field(runtime, "effectiveModel"),
    );
    out.insert("effort".into(), or_null(record.get("effort")));
    out.insert(
        "effectiveEffort".into(),
        clone_field(runtime, "effectiveEffort"),
    );
    out.insert("agent".into(), or_null(record.get("agent")));
    out.insert("rolePrompt".into(), or_null(record.get("rolePrompt")));
    out.insert("rolePresetId".into(), or_null(record.get("rolePresetId")));
    out.insert("provider".into(), or_null(record.get("provider")));
    out.insert(
        "providerSelection".into(),
        clone_field(facts, "providerSelection"),
    );
    out.insert(
        "experimentalMode".into(),
        or_null(record.get("experimentalMode")),
    );
    out.insert("subagent".into(), clone_field(runtime, "subagent"));
    out.insert("autoCommit".into(), not_false(record.get("autoCommit")));
    out.insert("cliStates".into(), clone_field(facts, "cliStates"));
    out.insert(
        "pendingCliHandoff".into(),
        clone_field(facts, "pendingCliHandoff"),
    );
    out.insert(
        "pendingConfiguration".into(),
        or_null(record.get("pendingConfiguration")),
    );
    out.insert("cwd".into(), clone_field(runtime, "sessionCwd"));
    out.insert("createdAt".into(), clone_field(record, "createdAt"));
    out.insert("mergeState".into(), clone_field(runtime, "mergeState"));
    out.insert(
        "lastActivity".into(),
        clone_field(
            runtime,
            if is_chat {
                "chatLastActivity"
            } else {
                "terminalLastActivity"
            },
        ),
    );
    out.insert(
        "clients".into(),
        clone_field(
            runtime,
            if use_chat_runtime {
                "chatClients"
            } else {
                "terminalClients"
            },
        ),
    );
    out.insert(
        "active".into(),
        if use_chat_runtime {
            clone_field(runtime, "chatActive")
        } else {
            Value::Bool(true)
        },
    );
    Value::Object(out)
}

/// `legacyDirectorySessionPresenter({record, runtime})`; `facts` carries
/// `cliStates`, `pendingCliHandoff` and `invalid`.
pub fn legacy_directory_session(record: &Value, runtime: &Value, facts: &Value) -> Value {
    let use_terminal_runtime = eq_str(record.get("kind"), "terminal");
    let is_chat = eq_str(record.get("kind"), "chat");
    let mut out = Map::new();
    out.insert("id".into(), or_null(record.get("id")));
    out.insert("dirId".into(), or_null(record.get("dirId")));
    out.insert("cli".into(), or_null(record.get("cli")));
    out.insert("kind".into(), or_null(record.get("kind")));
    out.insert("type".into(), or_null(record.get("type")));
    out.insert("cliSessionId".into(), or_null(record.get("cliSessionId")));
    out.insert("label".into(), or_null(record.get("label")));
    out.insert("model".into(), or_null(record.get("model")));
    out.insert("effort".into(), or_null(record.get("effort")));
    out.insert(
        "effectiveEffort".into(),
        clone_field(runtime, "effectiveEffort"),
    );
    out.insert("agent".into(), or_null(record.get("agent")));
    out.insert("rolePrompt".into(), or_null(record.get("rolePrompt")));
    out.insert("rolePresetId".into(), or_null(record.get("rolePresetId")));
    out.insert("provider".into(), or_null(record.get("provider")));
    out.insert(
        "providerSelection".into(),
        clone_field(facts, "providerSelection"),
    );
    out.insert(
        "experimentalMode".into(),
        or_null(record.get("experimentalMode")),
    );
    out.insert("subagent".into(), clone_field(runtime, "subagent"));
    out.insert("cliStates".into(), clone_field(facts, "cliStates"));
    out.insert(
        "pendingCliHandoff".into(),
        clone_field(facts, "pendingCliHandoff"),
    );
    out.insert(
        "pendingConfiguration".into(),
        or_null(record.get("pendingConfiguration")),
    );
    out.insert("createdAt".into(), clone_field(record, "createdAt"));
    out.insert("branch".into(), or_null(record.get("branch")));
    out.insert("worktreePath".into(), or_null(record.get("worktreePath")));
    out.insert("invalid".into(), or_null(facts.get("invalid")));
    out.insert("mergeState".into(), clone_field(runtime, "mergeState"));
    out.insert(
        "lastActivity".into(),
        clone_field(
            runtime,
            if is_chat {
                "chatLastActivity"
            } else {
                "terminalLastActivity"
            },
        ),
    );
    out.insert(
        "active".into(),
        clone_field(
            runtime,
            if use_terminal_runtime {
                "terminalActive"
            } else {
                "chatActive"
            },
        ),
    );
    out.insert(
        "clients".into(),
        clone_field(
            runtime,
            if use_terminal_runtime {
                "terminalClients"
            } else {
                "chatClients"
            },
        ),
    );
    Value::Object(out)
}

/// `legacyWorkspacePresenter({directory, facts, session})`; `facts` is the
/// host's `sessionView` result and `invalid` its `getInvalidSession` answer.
pub fn legacy_workspace(
    record: &Value,
    runtime: &Value,
    facts: &Value,
    invalid: Option<&Value>,
) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), or_null(record.get("id")));
    out.insert("label".into(), or_null(record.get("label")));
    out.insert(
        "cli".into(),
        or_value(record.get("cli"), Value::String("claude".into())),
    );
    out.insert(
        "kind".into(),
        or_value(record.get("kind"), Value::String("terminal".into())),
    );
    out.insert("branch".into(), or_null(record.get("branch")));
    out.insert("invalid".into(), or_null(invalid));
    out.insert("status".into(), clone_field(facts, "status"));
    out.insert("stateSource".into(), clone_field(facts, "stateSource"));
    out.insert("currentFile".into(), or_null(facts.get("currentFile")));
    out.insert("lastActivity".into(), clone_field(facts, "lastActivity"));
    out.insert("runStartedAt".into(), or_null(facts.get("runStartedAt")));
    out.insert("runEndedAt".into(), or_null(facts.get("runEndedAt")));
    out.insert(
        "clients".into(),
        or_value(runtime.get("clients"), Value::from(0)),
    );
    out.insert("pendingNotes".into(), clone_field(facts, "pendingNotes"));
    out.insert("mergeState".into(), clone_field(runtime, "mergeState"));
    out.insert("summary".into(), or_null(facts.get("summary")));
    out.insert("summaryTs".into(), or_null(facts.get("summaryAt")));
    out.insert("classifyState".into(), or_null(facts.get("classifyState")));
    out.insert(
        "goal".into(),
        or_value(facts.get("goal"), Value::String(String::new())),
    );
    out.insert(
        "taskShortCode".into(),
        or_value(facts.get("taskShortCode"), Value::String(String::new())),
    );
    out.insert(
        "phase".into(),
        or_value(facts.get("phase"), Value::String("idle".into())),
    );
    out.insert("auxUnhealthy".into(), is_true(facts.get("auxUnhealthy")));
    out.insert(
        "auxUnhealthySince".into(),
        or_null(facts.get("auxUnhealthySince")),
    );
    Value::Object(out)
}

/// `legacySessionDetailPresenter({record, runtime})`; `facts` carries
/// `providerSelection`, `providerBaseUrl`, `cliStates`, `cliAvailability` and
/// `pendingCliHandoff`.
pub fn legacy_session_detail(record: &Value, runtime: &Value, facts: &Value) -> Value {
    let cli = or_value(record.get("cli"), Value::String("claude".into()));
    let is_claude_chat =
        eq_str(record.get("cli"), "claude") && !eq_str(record.get("kind"), "terminal");
    let mut out = Map::new();
    out.insert("id".into(), or_null(record.get("id")));
    out.insert("cwd".into(), clone_field(runtime, "cwd"));
    out.insert("createdAt".into(), clone_field(runtime, "createdAt"));
    out.insert("lastActivity".into(), clone_field(runtime, "lastActivity"));
    out.insert(
        "clients".into(),
        or_value(runtime.get("clients"), Value::from(0)),
    );
    out.insert(
        "active".into(),
        Value::Bool(truthy(runtime.get("active").unwrap_or(&Value::Null))),
    );
    out.insert("mergeState".into(), clone_field(runtime, "mergeState"));
    out.insert("cli".into(), cli);
    out.insert("type".into(), or_null(record.get("type")));
    out.insert("model".into(), or_null(record.get("model")));
    out.insert(
        "effectiveModel".into(),
        clone_field(runtime, "effectiveModel"),
    );
    out.insert("effort".into(), or_null(record.get("effort")));
    out.insert(
        "effectiveEffort".into(),
        clone_field(runtime, "effectiveEffort"),
    );
    out.insert("agent".into(), or_null(record.get("agent")));
    out.insert("rolePrompt".into(), or_null(record.get("rolePrompt")));
    out.insert("rolePresetId".into(), or_null(record.get("rolePresetId")));
    out.insert("memory".into(), or_null(record.get("memory")));
    out.insert("provider".into(), or_null(record.get("provider")));
    out.insert(
        "providerSelection".into(),
        clone_field(facts, "providerSelection"),
    );
    out.insert(
        "providerBaseUrl".into(),
        clone_field(facts, "providerBaseUrl"),
    );
    out.insert("cliAccounts".into(), or_null(record.get("cliAccounts")));
    out.insert(
        "experimentalMode".into(),
        or_null(record.get("experimentalMode")),
    );
    out.insert("subagent".into(), clone_field(runtime, "subagent"));
    out.insert("cliStates".into(), clone_field(facts, "cliStates"));
    out.insert(
        "cliAvailability".into(),
        clone_field(facts, "cliAvailability"),
    );
    out.insert(
        "pendingCliHandoff".into(),
        clone_field(facts, "pendingCliHandoff"),
    );
    out.insert(
        "pendingConfiguration".into(),
        or_null(record.get("pendingConfiguration")),
    );
    out.insert("streaming".into(), Value::Bool(is_claude_chat));
    out.insert("autoContinue".into(), not_false(record.get("autoContinue")));
    out.insert("autoCommit".into(), not_false(record.get("autoCommit")));
    out.insert(
        "taskBoundTaskId".into(),
        or_null(record.get("taskBoundTaskId")),
    );
    out.insert("dirId".into(), or_null(record.get("dirId")));
    out.insert("label".into(), or_null(record.get("label")));
    Value::Object(out)
}

fn clone_field(source: &Value, key: &str) -> Value {
    source.get(key).cloned().unwrap_or(Value::Null)
}

// ── transcript helpers (the classifier debug endpoints) ────────────────────

/// `assistantText(message)`.
pub fn assistant_text(message: &Value) -> String {
    if !eq_str(message.get("role"), "assistant") {
        return String::new();
    }
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| truthy(block) && eq_str(block.get("type"), "text"))
            .map(|block| value_or_empty(block.get("text")))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// `latestAssistant(history, minLength)`: the text of the newest assistant
/// message long enough to classify, plus its `ts`.
pub fn latest_assistant(history: &Value, min_length: usize) -> (String, Value) {
    let Some(items) = history.as_array() else {
        return (String::new(), Value::Null);
    };
    for message in items.iter().rev() {
        if !truthy(message) || !eq_str(message.get("role"), "assistant") {
            continue;
        }
        let usable = matches!(
            message.get("content"),
            Some(Value::String(_)) | Some(Value::Array(_))
        );
        if !usable {
            continue;
        }
        let text = assistant_text(message);
        if utf16_len(&text) >= min_length {
            return (text, or_null(message.get("ts")));
        }
    }
    (String::new(), Value::Null)
}

/// `latestStringAssistant(history, minLength)`: the newest assistant message
/// whose content is a plain string.
pub fn latest_string_assistant(history: &Value, min_length: usize) -> String {
    let Some(items) = history.as_array() else {
        return String::new();
    };
    for message in items.iter().rev() {
        if !eq_str(message.get("role"), "assistant") {
            continue;
        }
        let Some(Value::String(content)) = message.get("content") else {
            continue;
        };
        if utf16_len(content) >= min_length {
            return content.clone();
        }
    }
    String::new()
}

/// `text.slice(-1500)` — the transcript tail the debug endpoints render.
pub fn assistant_tail(text: &str) -> String {
    utf16_suffix(text, 1500.0)
}

/// `tail.slice(-300)`.
pub fn tail_300(text: &str) -> String {
    utf16_suffix(text, 300.0)
}

// ── api-contract.js ────────────────────────────────────────────────────────

/// `withApiMeta(payload, {requestId, correlationId})`.
pub fn with_api_meta(payload: Value, ids: &(String, String)) -> Value {
    let mut out = match payload {
        Value::Object(map) => map,
        other => {
            let mut map = Map::new();
            map.insert("data".into(), other);
            map
        }
    };
    out.insert("apiVersion".into(), Value::String("v1".into()));
    out.insert("requestId".into(), Value::String(ids.0.clone()));
    out.insert("correlationId".into(), Value::String(ids.1.clone()));
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classify_letters_and_junk_goals() {
        assert!(is_terminal_letter(Some(&json!("D"))));
        assert!(!is_terminal_letter(Some(&json!("W"))));
        assert!(!is_terminal_letter(None));
        assert!(is_settled_letter(Some(&json!("W"))));
        assert!(is_settled_letter(Some(&json!("D"))));
        assert!(!is_settled_letter(Some(&json!("P"))));

        assert!(is_injected_or_junk_goal(None));
        assert!(is_injected_or_junk_goal(Some(&json!("   "))));
        assert!(is_injected_or_junk_goal(Some(&json!("\u{1F507}系统消息"))));
        assert!(is_injected_or_junk_goal(Some(&json!("<tool_result>"))));
        assert!(is_injected_or_junk_goal(Some(&json!("\"<x>\""))));
        assert!(!is_injected_or_junk_goal(Some(&json!(" 实现登录页 "))));
        // `String(goal || '')`: a falsy number reads as empty.
        assert!(is_injected_or_junk_goal(Some(&json!(0))));
    }

    #[test]
    fn dto_helpers_follow_the_js_rules() {
        assert_eq!(nullable_string(None, 8), Value::Null);
        assert_eq!(nullable_string(Some(&json!("")), 8), Value::Null);
        assert_eq!(nullable_string(Some(&json!(123456789)), 4), json!("1234"));
        assert_eq!(nullable_string(Some(&json!("abc")), 8), json!("abc"));

        assert_eq!(timestamp(None), Value::Null);
        assert_eq!(timestamp(Some(&json!(""))), Value::Null);
        assert_eq!(
            timestamp(Some(&json!(0))),
            json!("1970-01-01T00:00:00.000Z")
        );
        assert_eq!(
            timestamp(Some(&json!("2000-01-01T00:00:00.000Z"))),
            json!("2000-01-01T00:00:00.000Z")
        );
        assert_eq!(timestamp(Some(&json!("not a date"))), Value::Null);

        assert_eq!(subagent_dto(None), Value::Null);
        assert_eq!(subagent_dto(Some(&json!({"providerId": "p"}))), Value::Null);
        assert_eq!(
            subagent_dto(Some(&json!({
                "providerId": "p", "model": "m", "effectiveModel": "em", "inherited": true
            }))),
            json!({"providerId": "p", "model": "m", "effectiveModel": "em", "inherited": true})
        );

        assert_eq!(merge_state_dto(None), Value::Null);
        assert_eq!(
            merge_state_dto(Some(&json!({"ahead": -1, "behind": "2", "dirty": 1}))),
            json!({"ahead": 0, "behind": 2, "dirty": true, "mergeReady": false, "rebaseInProgress": false})
        );
    }

    #[test]
    fn unattended_dto_clamps_and_defaults() {
        assert_eq!(unattended_dto(None), Value::Null);
        let dto = unattended_dto(Some(&json!({
            "status": "bogus",
            "goal": "  ",
            "criteria": ["a", "", null, 5],
            "history": [{"at": -3, "verdict": "nope", "reason": 1}],
            "lastVerdict": {"verdict": "achieved", "at": 7},
            "stall": {"sameInstruction": 1.9},
            "retryAt": 0,
            "retryCategory": "capacity",
            "maxDurationMinutes": 1,
            "evaluating": true,
            "pausedBy": "user",
        })));
        assert_eq!(dto["status"], json!("stopped"));
        // `sanitizePublicText("  ")` is "  " — whitespace is truthy, so `|| ''` keeps it.
        assert_eq!(dto["goal"], json!("  "));
        assert_eq!(dto["criteria"], json!(["a", "5"]));
        assert_eq!(dto["maxDurationMinutes"], json!(5));
        assert_eq!(dto["rounds"], json!(0));
        assert_eq!(
            dto["history"],
            json!([{"at": 0, "verdict": "continue", "reason": "1"}])
        );
        assert_eq!(
            dto["lastVerdict"],
            json!({
                "verdict": "achieved", "reason": "", "nextInstruction": "",
                "humanReason": "", "at": 7
            })
        );
        assert_eq!(
            dto["stall"],
            json!({
                "sameInstruction": 1, "auxFailures": 0, "consecutiveFaults": 0
            })
        );
        assert_eq!(dto["retryAt"], Value::Null);
        assert_eq!(dto["retryCategory"], json!("capacity"));
        assert_eq!(dto["evaluating"], json!(true));
        assert_eq!(dto["pausedBy"], json!("user"));
    }

    #[test]
    fn to_session_dto_orders_and_defaults() {
        let dto = to_session_dto(&json!({
            "id": "s1",
            "cli": "bogus",
            "kind": "bogus",
            "type": "commander",
            "autoCommit": false,
            "createdAt": 1000,
            "clients": -2,
            "active": 1,
            "workspaceState": "hibernating",
            "providerSelection": {"mode": "auto"},
        }));
        let keys: Vec<&str> = dto
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "id",
                "dirId",
                "type",
                "cli",
                "kind",
                "label",
                "model",
                "effectiveModel",
                "effort",
                "effectiveEffort",
                "agent",
                "provider",
                "providerSelection",
                "experimentalMode",
                "subagent",
                "autoCommit",
                "createdAt",
                "lastActivity",
                "clients",
                "active",
                "workspaceState",
                "lastWorkAt",
                "hibernatedAt",
                "mergeState",
                "unattended",
            ]
        );
        assert_eq!(dto["cli"], json!("claude"));
        assert_eq!(dto["kind"], json!("terminal"));
        assert_eq!(dto["type"], json!("session"));
        assert_eq!(dto["providerSelection"], Value::Null);
        assert_eq!(dto["autoCommit"], json!(false));
        assert_eq!(dto["clients"], json!(0));
        assert_eq!(dto["active"], json!(true));
        assert_eq!(dto["workspaceState"], json!("hibernated"));
        assert_eq!(dto["lastWorkAt"], json!("1970-01-01T00:00:01.000Z"));
    }

    #[test]
    fn transcript_helpers_match_the_js_scan() {
        let history = json!([
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "short", "ts": 1},
            {"role": "assistant", "content": "a longer reply for classify", "ts": 2},
        ]);
        let (text, ts) = latest_assistant(&history, 20);
        assert_eq!(text, "a longer reply for classify");
        assert_eq!(ts, json!(2));
        let (empty, ts) = latest_assistant(&history, 200);
        assert_eq!(empty, "");
        assert_eq!(ts, Value::Null);
        assert_eq!(
            latest_string_assistant(&history, 20),
            "a longer reply for classify"
        );

        let blocks = json!([
            {"role": "assistant", "content": [
                {"type": "text", "text": "one"},
                {"type": "tool", "text": "ignored"},
                {"type": "text"},
            ]},
        ]);
        assert_eq!(assistant_text(&blocks[0]), "one ");
        let (text, ts) = latest_assistant(&blocks, 0);
        assert_eq!(text, "one ");
        assert_eq!(ts, Value::Null);
        assert_eq!(latest_string_assistant(&blocks, 0), "");
    }

    #[test]
    fn sanitize_public_text_applies_the_five_redactions() {
        assert_eq!(sanitize_public_text(None, 1000), Value::Null);
        assert_eq!(sanitize_public_text(Some(&json!("")), 1000), Value::Null);
        assert_eq!(
            sanitize_public_text(Some(&json!("use Bearer abc.def")), 1000),
            json!("use Bearer [redacted]")
        );
        assert_eq!(
            sanitize_public_text(Some(&json!("key sk-abcdefghij here")), 1000),
            json!("key [redacted] here")
        );
        // No `/i` on the token pattern: uppercase is left alone.
        assert_eq!(
            sanitize_public_text(Some(&json!("SK-abcdefghij")), 1000),
            json!("SK-abcdefghij")
        );
        assert_eq!(
            sanitize_public_text(Some(&json!("api_key: hunter2")), 1000),
            json!("api_key:[redacted]")
        );
        assert_eq!(
            sanitize_public_text(Some(&json!("open /a/b/c now")), 1000),
            json!("open [path] now")
        );
        assert_eq!(
            sanitize_public_text(Some(&json!(r"open C:\Users\me\file now")), 1000),
            json!("open [path] now")
        );
        assert_eq!(
            sanitize_public_text(Some(&json!("abcdefghij")), 4),
            json!("abcd")
        );
        // `String(value)` for a non-string value.
        assert_eq!(sanitize_public_text(Some(&json!(12)), 10), json!("12"));
    }

    #[test]
    fn workspace_entry_and_contract_view() {
        let session = to_session_dto(&json!({"id": "s1"}));
        let entry = workspace_entry(
            session,
            &json!({
                "status": "bogus",
                "lastActivity": 0,
                "pendingNotes": -3,
                "summary": " /a/b ",
                "classifyState": "D",
                "goal": "  ",
                "phase": null,
            }),
        );
        assert_eq!(entry["status"], json!("idle"));
        assert_eq!(entry["statusUpdatedAt"], json!("1970-01-01T00:00:00.000Z"));
        assert_eq!(entry["pendingNotes"], json!(0));
        assert_eq!(entry["summary"], json!(" [path] "));
        assert_eq!(entry["goal"], json!("  "));
        assert_eq!(entry["phase"], json!("idle"));
        assert_eq!(entry["taskShortCode"], json!(""));
        assert_eq!(entry["auxUnhealthy"], json!(false));
        // `Number(null)` is 0 and finite, so the JS rule emits 0, not null.
        assert_eq!(entry["auxUnhealthySince"], json!(0));

        let view = workspace_contract_view(json!({"id": "d1", "label": "D"}), vec![entry]);
        assert_eq!(view["count"], json!(1));
        let first = &view["sessions"][0];
        assert_eq!(first["status"], json!("idle"));
        assert_eq!(first["classifyState"], json!("D"));
        assert_eq!(first["session"]["id"], json!("s1"));
        assert_eq!(first["session"]["type"], json!("session"));
        assert!(first["session"]["taskShortCode"].is_string());
        assert!(first["session"].get("status").is_none());
        let keys: Vec<&str> = first
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "session",
                "status",
                "statusUpdatedAt",
                "runStartedAt",
                "runEndedAt",
                "pendingNotes",
                "summary",
                "summaryAt",
                "classifyState",
                "goal",
                "phase",
            ]
        );
    }

    #[test]
    fn directory_dto_and_presenters_keep_key_order() {
        assert_eq!(directory_dto(None), Value::Null);
        assert_eq!(directory_dto(Some(&json!({"label": "x"}))), Value::Null);
        assert_eq!(
            directory_dto(Some(&json!({"id": "d1", "name": "Nm", "path": "/p"}))),
            json!({"id": "d1", "label": "Nm"})
        );

        let record = json!({
            "id": "s1", "dirId": "d1", "cli": "codex", "kind": "chat",
            "type": "commander", "cliSessionId": "c1", "label": "L",
            "model": "m", "effort": "high", "agent": "a", "rolePrompt": "r",
            "rolePresetId": "rp", "provider": "p", "experimentalMode": "x",
            "pendingConfiguration": null, "createdAt": 5, "branch": "b",
            "worktreePath": "w", "autoCommit": false, "autoContinue": false,
            "cliAccounts": ["a1"], "memory": {"m": 1}, "taskBoundTaskId": "t1",
        });
        let runtime = json!({
            "effectiveModel": "em", "effectiveEffort": "eh", "subagent": null,
            "sessionCwd": "/cwd", "mergeState": null, "chatActive": true,
            "chatLastActivity": 9, "terminalLastActivity": 8, "chatClients": 2,
            "terminalClients": 1, "terminalActive": false, "cwd": "/cwd", "clients": 2,
            "active": true, "createdAt": 5, "lastActivity": 9,
        });
        let facts = json!({
            "providerSelection": null, "cliStates": {"x": 1}, "cliHandoff": null,
            "pendingCliHandoff": null, "providerBaseUrl": "http://x",
            "cliAvailability": {"y": 2}, "invalid": "bad",
        });

        let list = legacy_session_list(&record, &runtime, &facts);
        let keys: Vec<&str> = list
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "id",
                "dirId",
                "cli",
                "kind",
                "type",
                "cliSessionId",
                "label",
                "model",
                "effectiveModel",
                "effort",
                "effectiveEffort",
                "agent",
                "rolePrompt",
                "rolePresetId",
                "provider",
                "providerSelection",
                "experimentalMode",
                "subagent",
                "autoCommit",
                "cliStates",
                "pendingCliHandoff",
                "pendingConfiguration",
                "cwd",
                "createdAt",
                "mergeState",
                "lastActivity",
                "clients",
                "active",
            ]
        );
        assert_eq!(list["lastActivity"], json!(9));
        assert_eq!(list["clients"], json!(2));
        assert_eq!(list["active"], json!(true));

        let dir = legacy_directory_session(&record, &runtime, &facts);
        let keys: Vec<&str> = dir
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "id",
                "dirId",
                "cli",
                "kind",
                "type",
                "cliSessionId",
                "label",
                "model",
                "effort",
                "effectiveEffort",
                "agent",
                "rolePrompt",
                "rolePresetId",
                "provider",
                "providerSelection",
                "experimentalMode",
                "subagent",
                "cliStates",
                "pendingCliHandoff",
                "pendingConfiguration",
                "createdAt",
                "branch",
                "worktreePath",
                "invalid",
                "mergeState",
                "lastActivity",
                "active",
                "clients",
            ]
        );
        assert_eq!(dir["invalid"], json!("bad"));
        assert_eq!(dir["active"], json!(true));
        assert_eq!(dir["clients"], json!(2));

        let view = json!({
            "status": "running", "stateSource": {"executionSessionId": "s1"},
            "currentFile": "f", "lastActivity": 9, "runStartedAt": 1, "runEndedAt": null,
            "pendingNotes": 3, "summary": "s", "summaryAt": 4, "classifyState": "D",
            "goal": "g", "taskShortCode": "T1", "phase": "p", "auxUnhealthy": true,
            "auxUnhealthySince": 6,
        });
        let workspace = legacy_workspace(&record, &runtime, &view, Some(&json!("bad")));
        let keys: Vec<&str> = workspace
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "id",
                "label",
                "cli",
                "kind",
                "branch",
                "invalid",
                "status",
                "stateSource",
                "currentFile",
                "lastActivity",
                "runStartedAt",
                "runEndedAt",
                "clients",
                "pendingNotes",
                "mergeState",
                "summary",
                "summaryTs",
                "classifyState",
                "goal",
                "taskShortCode",
                "phase",
                "auxUnhealthy",
                "auxUnhealthySince",
            ]
        );
        assert_eq!(workspace["summaryTs"], json!(4));
        assert_eq!(workspace["auxUnhealthy"], json!(true));

        let detail = legacy_session_detail(&record, &runtime, &facts);
        let keys: Vec<&str> = detail
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "id",
                "cwd",
                "createdAt",
                "lastActivity",
                "clients",
                "active",
                "mergeState",
                "cli",
                "type",
                "model",
                "effectiveModel",
                "effort",
                "effectiveEffort",
                "agent",
                "rolePrompt",
                "rolePresetId",
                "memory",
                "provider",
                "providerSelection",
                "providerBaseUrl",
                "cliAccounts",
                "experimentalMode",
                "subagent",
                "cliStates",
                "cliAvailability",
                "pendingCliHandoff",
                "pendingConfiguration",
                "streaming",
                "autoContinue",
                "autoCommit",
                "taskBoundTaskId",
                "dirId",
                "label",
            ]
        );
        assert_eq!(detail["streaming"], json!(false));
        assert_eq!(detail["autoCommit"], json!(false));
        assert_eq!(detail["providerBaseUrl"], json!("http://x"));
    }

    #[test]
    fn with_api_meta_appends_the_v1_stamp() {
        let ids = ("r1".to_string(), "c1".to_string());
        assert_eq!(
            with_api_meta(json!({"sessions": [], "count": 0}), &ids),
            json!({
                "sessions": [], "count": 0,
                "apiVersion": "v1", "requestId": "r1", "correlationId": "c1"
            })
        );
        assert_eq!(
            with_api_meta(json!(5), &ids),
            json!({"data": 5, "apiVersion": "v1", "requestId": "r1", "correlationId": "c1"})
        );
    }
}
