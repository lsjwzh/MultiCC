//! Missing-resume recovery — the decision kernel shared by the legacy
//! `--resume` process lane (`src/chat/chat-stream.js`) and the Claude Agent SDK
//! lane (`src/chat/claude-sdk-stream.js`).
//!
//! Claude reports a `--resume <id>` whose target transcript no longer exists as
//! an ordinary stream-json result (`type: "result"`, `is_error: true`) rather
//! than as a process failure, so the exit paths never see it. The legacy lane
//! learned to self-heal; the SDK lane did not, and because the Rust
//! `api_error_policy` classifies that text as `adapter_configuration` /
//! `fail_fast` the same turn failed forever. This module owns the *decision*
//! (may we rotate? what evidence does the transcript store give?) so both lanes
//! answer it identically; each lane keeps only its own process/event IO.
//!
//! Three sources were migrated here:
//!   * `isMissingResumeResult` and `recoverMissingResume` in
//!     `src/chat/chat-stream.js` — classifier, replay-safety gates, attempt cap
//!     and id rotation;
//!   * `hasNativeHistory` in `src/cli-adapters/claude-exp-history.js` — the
//!     fail-closed transcript probe;
//!   * the `isFirstTurn` formula from [`crate::turn_request`], reused verbatim
//!     so a planned spawn and a recovery decision cannot disagree.
//!
//! The addon reads the request as a JavaScript value and converts it with
//! [`crate::js::tags`], so `undefined` and non-finite numbers are not rewritten
//! by a JSON boundary before this module sees them.
//!
//! ## Classifier regex semantics (deliberate one-way relaxation)
//!
//! The classifier reuses [`crate::api_error_policy::no_session_regex`], which
//! compiles `TEXT_FALLBACK_NO_SESSION_SOURCE` —
//! `no conversation found with session id\b`. The legacy JS regex was
//! `/No conversation found with session ID\s*:/i`: it required a colon after
//! optional whitespace. The shared source ends at an ASCII word boundary and
//! therefore also matches shapes without the colon (for example a truncated
//! `No conversation found with session ID u-1`). It is wider, and that is on
//! purpose: the JS copy is deleted by this migration, so no second
//! interpretation of the same event survives to disagree with Rust, and
//! `api_error_policy` already classifies those same strings as
//! `adapter_configuration`. Matching runs over lowercased text, mirroring
//! `text_fallback_category`.
//!
//! ## Evidence tri-state
//!
//! [`Evidence`] keeps `Unknown` for callers that one day need to say "the
//! probe itself is undecidable". The current probe never produces it: the
//! legacy semantics are fail-closed, so every I/O doubt resolves to
//! `present` (do not rotate) and only a proven `ENOENT` walk resolves to
//! `proven_absent`.
use crate::api_error_policy::no_session_regex;
use crate::js::tags;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// The four operations, in catalog order.
pub const OPS: [&str; 4] = ["classifyResult", "decide", "probeTranscript", "resumePlan"];
pub const ACTIONS: [&str; 2] = ["rotate", "skip"];
pub const EVIDENCE: [&str; 4] = ["present", "proven_absent", "unknown", "skipped"];

/// Reasons `decide` can answer, in gate order.
pub const DECIDE_REASONS: [&str; 5] = [
    "not_missing_resume",
    "not_a_resume_spawn",
    "events_already_forwarded",
    "attempt_exhausted",
    "resume_target_missing",
];

/// Reasons `resumePlan` can answer.
pub const RESUME_PLAN_REASONS: [&str; 5] = [
    "transcript_proven_absent",
    "present",
    "unknown",
    "first_turn",
    "no_session_id_cannot_resume",
];

const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

/// A structured failure, the same `{code, message}` shape
/// [`crate::turn_request::Failure`] uses.
#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Failure {
            code,
            message: message.into(),
        }
    }
}

// ── missing-resume classifier ───────────────────────────────────────────────

/// `No conversation found with session ID` over the shared policy regex.
fn text_reports_missing_resume(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    no_session_regex().is_match(&text.to_lowercase())
}

/// The candidate strings `isMissingResumeResult` fed to `String(message || '')`:
/// every entry of `errors[]`, `error` (string) or `error.message` (object), and
/// `result`.
fn candidate_messages(object: &Map<String, Value>) -> Vec<Option<&Value>> {
    let mut candidates: Vec<Option<&Value>> = Vec::new();
    if let Some(Value::Array(errors)) = object.get("errors") {
        candidates.extend(errors.iter().map(Some));
    }
    match object.get("error") {
        Some(error) if error.is_string() => candidates.push(Some(error)),
        Some(error) => candidates.push(error.get("message")),
        None => candidates.push(None),
    }
    candidates.push(object.get("result"));
    candidates
}

/// `isMissingResumeResult(event)`.
fn is_missing_resume_result(event: &Value) -> bool {
    if tags::is_tagged_scalar(event) {
        return false;
    }
    let Some(object) = event.as_object() else {
        return false;
    };
    if object.get("type").and_then(Value::as_str) != Some("result") {
        return false;
    }
    // Strict `=== true`: the string "true" and the number 1 are not proof.
    if !matches!(object.get("is_error"), Some(Value::Bool(true))) {
        return false;
    }
    candidate_messages(object)
        .into_iter()
        .any(|candidate| text_reports_missing_resume(&tags::value_or_empty(candidate)))
}

// ── id rotation ─────────────────────────────────────────────────────────────

/// `crypto.randomUUID()`: a lowercase RFC 4122 v4 id.
fn new_session_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        fallback_entropy(&mut bytes);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut out = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        out.push(HEX_DIGITS[(byte >> 4) as usize] as char);
        out.push(HEX_DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Last resort when the OS entropy source is unavailable. A rotated id only
/// has to be well formed and distinct in practice, never secret.
fn fallback_entropy(bytes: &mut [u8; 16]) {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut seed = nanos ^ (u128::from(std::process::id()) << 64) ^ 0x9e37_79b9_7f4a_7c15;
    for slot in bytes.iter_mut() {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *slot = (seed >> 64) as u8;
    }
}

/// The standard lowercase v4 shape, case-insensitive like the legacy JS test.
fn session_id_shape() -> &'static Regex {
    static SHAPE: OnceLock<Regex> = OnceLock::new();
    SHAPE.get_or_init(|| {
        Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
            .expect("session id shape regex")
    })
}

// ── transcript probe ────────────────────────────────────────────────────────

/// Three-state answer from the transcript store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Evidence {
    Present,
    ProvenAbsent,
    /// Reserved: the probe cannot be undecidable today, because every doubt
    /// resolves to [`Evidence::Present`] (fail closed). Kept so a future probe
    /// can report "unknown" without changing the wire contract.
    #[allow(dead_code)]
    Unknown,
}

impl Evidence {
    fn as_str(self) -> &'static str {
        match self {
            Evidence::Present => "present",
            Evidence::ProvenAbsent => "proven_absent",
            Evidence::Unknown => "unknown",
        }
    }
}

/// `options.configDir || process.env.CLAUDE_CONFIG_DIR || ~/.claude`.
fn config_dir(config_dir_input: Option<&Value>) -> Option<PathBuf> {
    if let Some(value) = config_dir_input.filter(|value| tags::truthy(value)) {
        let text = tags::js_string(value);
        if !text.is_empty() {
            return Some(PathBuf::from(text));
        }
    }
    if let Some(text) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|text| !text.is_empty()) {
        return Some(PathBuf::from(text));
    }
    home_dir().map(|home| home.join(".claude"))
}

/// `os.homedir()`.
fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let variable = "USERPROFILE";
    #[cfg(not(windows))]
    let variable = "HOME";
    std::env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Fail-closed evidence for a directory read error: only a proven `ENOENT`
/// means the store is absent; permissions and every other doubt mean "present".
fn read_error_evidence(error: &std::io::Error) -> Evidence {
    if crate::node_fs_error::classify(error).code == "ENOENT" {
        Evidence::ProvenAbsent
    } else {
        Evidence::Present
    }
}

/// The `hasNativeHistory` probe: search every project directory for
/// `<sessionId>.jsonl` by UUID, because the SDK canonicalizes symlinks, hashes
/// long paths and supports custom project names.
fn probe_session(session_id: &str, config_dir_input: Option<&Value>) -> Evidence {
    // Not a well-formed v4 id: nothing can be proven, so fail closed.
    if !session_id_shape().is_match(session_id) {
        return Evidence::Present;
    }
    let Some(config_dir) = config_dir(config_dir_input) else {
        // No home directory to probe: undecidable, so fail closed.
        return Evidence::Present;
    };
    let projects = config_dir.join("projects");
    let entries = match std::fs::read_dir(&projects) {
        Ok(entries) => entries,
        Err(error) => return read_error_evidence(&error),
    };
    for entry in entries {
        // A partial listing is I/O doubt, never proof of absence.
        let Ok(entry) = entry else {
            return Evidence::Present;
        };
        let Ok(file_type) = entry.file_type() else {
            return Evidence::Present;
        };
        if !file_type.is_dir() && !file_type.is_symlink() {
            continue;
        }
        let transcript = projects
            .join(entry.file_name())
            .join(format!("{session_id}.jsonl"));
        match std::fs::metadata(&transcript) {
            Ok(_) => return Evidence::Present,
            Err(error) => {
                if crate::node_fs_error::classify(&error).code != "ENOENT" {
                    return Evidence::Present;
                }
            }
        }
    }
    Evidence::ProvenAbsent
}

pub fn has_native_transcript(session_id: &str) -> bool {
    probe_session(session_id, None) != Evidence::ProvenAbsent
}

/// Full `hasNativeHistory` check (former `src/cli-adapters/claude-exp-history.js`):
/// only a pending NEW `claude-exp` handoff with a well-formed UUID triggers the
/// on-disk transcript probe; every other shape fails closed (`true`) when an ID
/// is present.
pub fn claude_exp_has_native_history(
    cli: Option<&str>,
    cli_session_id: Option<&str>,
    handoff_status: Option<&str>,
    handoff_to_cli: Option<&str>,
    handoff_reused_target: Option<bool>,
    config_dir_override: Option<&str>,
) -> bool {
    let Some(id) = cli_session_id.filter(|s| !s.is_empty()) else {
        return false;
    };
    if cli != Some("claude-exp")
        || handoff_status != Some("pending")
        || handoff_to_cli != Some("claude-exp")
        || handoff_reused_target != Some(false)
    {
        return true;
    }
    if !session_id_shape().is_match(id) {
        return true;
    }
    let dir_val = config_dir_override
        .filter(|s| !s.is_empty())
        .map(|s| Value::String(s.to_string()));
    probe_session(id, dir_val.as_ref()) != Evidence::ProvenAbsent
}

/// A truthy `sessionId` as text; empty/missing/non-truthy means "no id".
fn session_id_of(input: &Value) -> Option<String> {
    match input.get("sessionId") {
        Some(value) if tags::truthy(value) => {
            let text = tags::js_string(value);
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

// ── operations ──────────────────────────────────────────────────────────────

fn decision(action: &str, next_session_id: Option<String>, reason: &str) -> Value {
    let mut out = Map::new();
    out.insert("action".to_string(), Value::String(action.to_string()));
    if let Some(next_session_id) = next_session_id {
        out.insert("nextSessionId".to_string(), Value::String(next_session_id));
    }
    out.insert("reason".to_string(), Value::String(reason.to_string()));
    Value::Object(out)
}

/// `forwardedEventCount === 0`. Only a numeric zero passes; a missing field, a
/// string and `NaN` all mean "events were already forwarded", so fail closed.
fn is_zero_forwarded(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Number(number)) if number.as_f64() == Some(0.0))
}

fn decide_action(input: &Value) -> Value {
    let event = input.get("event").unwrap_or(&Value::Null);
    if !is_missing_resume_result(event) {
        return decision("skip", None, "not_missing_resume");
    }
    // Without a `--resume` spawn the missing id cannot be our target.
    if !matches!(input.get("lastSpawnWasResume"), Some(Value::Bool(true))) {
        return decision("skip", None, "not_a_resume_spawn");
    }
    // Replay safety: once anything was forwarded, a retry could duplicate
    // visible output or tool side effects, so never rotate.
    if !is_zero_forwarded(input.get("forwardedEventCount")) {
        return decision("skip", None, "events_already_forwarded");
    }
    let attempt = input
        .get("attempt")
        .map(tags::js_to_number)
        .unwrap_or(f64::NAN);
    if attempt >= 1.0 {
        return decision("skip", None, "attempt_exhausted");
    }
    decision("rotate", Some(new_session_id()), "resume_target_missing")
}

/// `isFirstTurn`, verbatim from [`crate::turn_request::normalize`]: `claude-exp`
/// only looks at native history, every other CLI also needs a first turn.
fn is_first_turn(cli: &str, turn_count: f64, has_native_session: bool) -> bool {
    if cli == "claude-exp" {
        !has_native_session
    } else {
        turn_count == 0.0 || !has_native_session
    }
}

fn resume_plan(input: &Value) -> Value {
    let cli = match input.get("cli") {
        Some(value) if !tags::is_nullish(value) => tags::js_string(value).to_lowercase(),
        _ => String::new(),
    };
    let has_native_session = matches!(input.get("hasNativeSession"), Some(Value::Bool(true)));
    let turn_count = match input.get("turnCount") {
        Some(value) if !tags::is_nullish(value) => tags::js_to_number(value),
        _ => 0.0,
    };
    let mut first_turn = is_first_turn(&cli, turn_count, has_native_session);

    let mut probe = "skipped";
    let mut recover_before_spawn = false;
    let reason;
    if first_turn {
        reason = "first_turn";
    } else if let Some(session_id) = session_id_of(input) {
        let evidence = probe_session(&session_id, input.get("configDir"));
        probe = evidence.as_str();
        match evidence {
            Evidence::ProvenAbsent => {
                // The transcript is gone but the id is real: recovery only
                // fires *earlier*. The caller rotates the id, writes the
                // handoff checkpoint and warns, then replays. The turn stays a
                // resume — flipping `isFirstTurn` here would silently start a
                // new conversation and drop the user's context with no
                // checkpoint and no warning.
                recover_before_spawn = true;
                reason = "transcript_proven_absent";
            }
            Evidence::Present => reason = "present",
            Evidence::Unknown => reason = "unknown",
        }
    } else {
        // No id at all while the plan said resume. This is not a missing
        // transcript: there is no id pointing at *any* conversation, and the
        // caller (`turn-engine`) is about to mint a brand-new UUID. Resuming an
        // id that has never existed is a logical contradiction, so this must
        // become a first turn — unlike `transcript_proven_absent`, where the
        // conversation really existed and only fail-closed rotation is allowed.
        //
        // This case still means the user has visible chat history
        // (`turnCount > 0 && hasNativeSession`) and the native side is blank, so
        // `recoverBeforeSpawn` asks the caller for the handoff checkpoint and
        // warning: the missing context must be recorded, never silently
        // discarded.
        first_turn = true;
        recover_before_spawn = true;
        reason = "no_session_id_cannot_resume";
    }

    let mut out = Map::new();
    out.insert("isFirstTurn".to_string(), Value::Bool(first_turn));
    out.insert("probe".to_string(), Value::String(probe.to_string()));
    out.insert(
        "recoverBeforeSpawn".to_string(),
        Value::Bool(recover_before_spawn),
    );
    out.insert("reason".to_string(), Value::String(reason.to_string()));
    Value::Object(out)
}

// ── entry points ────────────────────────────────────────────────────────────

/// Constant tables; the JS facade snapshots this at load instead of hardcoding
/// op names, actions, evidence values and reasons.
pub fn catalog() -> Result<String, String> {
    Ok(json!({
        "ops": OPS,
        "actions": ACTIONS,
        "evidence": EVIDENCE,
        "reasons": {
            "decide": DECIDE_REASONS,
            "resumePlan": RESUME_PLAN_REASONS,
        },
    })
    .to_string())
}

#[derive(Clone, Copy)]
pub enum Operation {
    ClassifyResult,
    Decide,
    ProbeTranscript,
    ResumePlan,
}

impl Operation {
    fn evaluate(self, input: &Value) -> Value {
        match self {
            Self::ClassifyResult => {
                let event = input.get("event").unwrap_or(&Value::Null);
                json!({ "missing": is_missing_resume_result(event) })
            }
            Self::Decide => decide_action(input),
            Self::ProbeTranscript => {
                let evidence = match session_id_of(input) {
                    Some(session_id) => probe_session(&session_id, input.get("configDir")),
                    None => Evidence::Present,
                };
                json!({ "evidence": evidence.as_str() })
            }
            Self::ResumePlan => resume_plan(input),
        }
    }
    pub fn evaluate_value(self, input: &crate::js::JsValue) -> crate::js::JsValue {
        tags::to_js(&self.evaluate(&tags::from_js(input)))
    }
}

fn dispatch(op: &str, input: &Value) -> Result<Value, Failure> {
    let op = match op {
        "classifyResult" => Operation::ClassifyResult,
        "decide" => Operation::Decide,
        "probeTranscript" => Operation::ProbeTranscript,
        "resumePlan" => Operation::ResumePlan,
        _ => {
            return Err(Failure::new(
                "unknown_op",
                format!("missing_resume_recovery_unknown_op: {op}"),
            ))
        }
    };
    Ok(op.evaluate(input))
}

fn envelope(result: Result<Value, Failure>) -> Value {
    match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(failure) => json!({
            "ok": false,
            "error": { "code": failure.code, "message": failure.message },
        }),
    }
}

/// One value-in/value-out entry for the four operations. The payload keeps
/// `undefined` and the non-finite numbers, which JSON cannot carry.
pub fn request_value(op: &str, input: &crate::js::JsValue) -> Result<crate::js::JsValue, String> {
    let payload = tags::from_js(input);
    let result = envelope(dispatch(op, &payload));
    Ok(tags::to_js(&result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    const PRESENT_ID: &str = "11111111-2222-4333-8444-555555555555";

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "multicc-missing-resume-{}-{label}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp root");
        dir
    }

    fn config(text: &Path) -> Value {
        json!({ "configDir": text.to_string_lossy() })
    }

    fn missing_event() -> Value {
        json!({
            "type": "result",
            "is_error": true,
            "errors": ["No conversation found with session ID: abc"],
        })
    }

    fn decide(event: Value, resume: bool, forwarded: Value, attempt: Value) -> Value {
        decide_action(&json!({
            "event": event,
            "lastSpawnWasResume": resume,
            "forwardedEventCount": forwarded,
            "attempt": attempt,
        }))
    }

    // ── classifyResult ─────────────────────────────────────────────────────

    #[test]
    fn classifies_every_message_source() {
        let sources = [
            json!({ "type": "result", "is_error": true,
                "errors": ["No conversation found with session ID: a"] }),
            json!({ "type": "result", "is_error": true,
                "error": "No conversation found with session ID: a" }),
            json!({ "type": "result", "is_error": true,
                "error": { "message": "No conversation found with session ID: a" } }),
            json!({ "type": "result", "is_error": true,
                "result": "No conversation found with session ID: a" }),
        ];
        for event in sources {
            assert!(is_missing_resume_result(&event), "{event}");
        }
    }

    #[test]
    fn classifier_requires_a_strict_boolean_error_flag() {
        for is_error in [json!("true"), json!(1), json!(null)] {
            let event = json!({
                "type": "result",
                "is_error": is_error,
                "errors": ["No conversation found with session ID: a"],
            });
            assert!(!is_missing_resume_result(&event), "{is_error}");
        }
    }

    #[test]
    fn classifier_ignores_other_event_types_and_texts() {
        assert!(!is_missing_resume_result(&json!({
            "type": "assistant", "is_error": true,
            "errors": ["No conversation found with session ID: a"],
        })));
        assert!(!is_missing_resume_result(&missing_event_with_text("boom")));
        assert!(!is_missing_resume_result(&json!(null)));
        assert!(!is_missing_resume_result(&json!(
            "No conversation found with session ID: a"
        )));
        assert!(!is_missing_resume_result(&json!([1, 2, 3])));
    }

    fn missing_event_with_text(text: &str) -> Value {
        json!({ "type": "result", "is_error": true, "errors": [text] })
    }

    #[test]
    fn classifier_is_case_insensitive_and_wider_than_the_legacy_colon_form() {
        for text in [
            "NO CONVERSATION FOUND WITH SESSION ID: a",
            "no conversation found with session id a",
            "No Conversation Found With Session ID",
        ] {
            assert!(
                is_missing_resume_result(&missing_event_with_text(text)),
                "{text}"
            );
        }
    }

    // ── decide ─────────────────────────────────────────────────────────────

    #[test]
    fn decide_gates_skip_individually() {
        let not_missing = decide(
            json!({ "type": "result", "is_error": true }),
            true,
            json!(0),
            json!(0),
        );
        assert_eq!(not_missing["action"], "skip");
        assert_eq!(not_missing["reason"], "not_missing_resume");

        let not_resume = decide(missing_event(), false, json!(0), json!(0));
        assert_eq!(not_resume["reason"], "not_a_resume_spawn");

        for forwarded in [json!(1), json!("0"), json!(null)] {
            let forwarded_skip = decide(missing_event(), true, forwarded.clone(), json!(0));
            assert_eq!(
                forwarded_skip["reason"], "events_already_forwarded",
                "{forwarded}"
            );
        }

        for attempt in [json!(1), json!(2)] {
            let exhausted = decide(missing_event(), true, json!(0), attempt.clone());
            assert_eq!(exhausted["reason"], "attempt_exhausted", "{attempt}");
        }
    }

    #[test]
    fn decide_rotates_to_a_fresh_lowercase_v4_id() {
        let first = decide(missing_event(), true, json!(0), json!(0));
        assert_eq!(first["action"], "rotate");
        assert_eq!(first["reason"], "resume_target_missing");
        let id = first["nextSessionId"].as_str().expect("id").to_string();
        assert!(session_id_shape().is_match(&id), "{id}");
        assert_eq!(id, id.to_lowercase());

        let second = decide(missing_event(), true, json!(0), json!(0));
        assert_ne!(second["nextSessionId"], first["nextSessionId"]);
    }

    #[test]
    fn decide_accepts_negative_zero_forwarded_count_like_javascript() {
        let rotated = decide_action(&json!({
            "event": missing_event(),
            "lastSpawnWasResume": true,
            "forwardedEventCount": -0.0,
            "attempt": 0,
        }));
        assert_eq!(rotated["action"], "rotate");
    }

    // ── probeTranscript ────────────────────────────────────────────────────

    #[test]
    fn probe_finds_the_transcript_in_any_project_directory() {
        let root = temp_root("probe-present");
        let project = root.join("projects").join("-Users-someone-hashed-path");
        fs::create_dir_all(&project).expect("project");
        fs::write(project.join(format!("{PRESENT_ID}.jsonl")), "{}\n").expect("transcript");
        let mut input = config(&root);
        input["sessionId"] = json!(PRESENT_ID);
        assert_eq!(
            probe_session(PRESENT_ID, input.get("configDir")),
            Evidence::Present
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn probe_proves_absence_only_from_an_empty_store() {
        let root = temp_root("probe-empty");
        fs::create_dir_all(root.join("projects")).expect("projects");
        assert_eq!(
            probe_session(PRESENT_ID, config(&root).get("configDir")),
            Evidence::ProvenAbsent
        );
        let _ = fs::remove_dir_all(&root);

        let missing = temp_root("probe-no-projects");
        assert_eq!(
            probe_session(PRESENT_ID, config(&missing).get("configDir")),
            Evidence::ProvenAbsent
        );
        let _ = fs::remove_dir_all(&missing);
    }

    #[test]
    fn probe_fails_closed_for_unprovable_ids() {
        let root = temp_root("probe-shape");
        assert_eq!(
            probe_session("not-a-uuid", config(&root).get("configDir")),
            Evidence::Present
        );
        assert_eq!(
            probe_session("", config(&root).get("configDir")),
            Evidence::Present
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn probe_skips_entries_that_are_neither_directories_nor_symlinks() {
        // The permission branch shares one code path with every non-ENOENT stat
        // error (`read_error_evidence` / the inner `classify(...) != "ENOENT"`
        // arm), which cannot be provoked portably. This exercises the other
        // shape-only rule: a plain file under projects is not searched.
        let root = temp_root("probe-file-entry");
        let projects = root.join("projects");
        fs::create_dir_all(&projects).expect("projects");
        fs::write(projects.join("not-a-project"), "x").expect("file");
        assert_eq!(
            probe_session(PRESENT_ID, config(&root).get("configDir")),
            Evidence::ProvenAbsent
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn probe_follows_symlinked_project_directories() {
        use std::os::unix::fs::symlink;
        let root = temp_root("probe-symlink");
        let real = root.join("real-project");
        fs::create_dir_all(&real).expect("real");
        fs::write(real.join(format!("{PRESENT_ID}.jsonl")), "").expect("transcript");
        let projects = root.join("projects");
        fs::create_dir_all(&projects).expect("projects");
        symlink(&real, projects.join("linked")).expect("symlink");
        assert_eq!(
            probe_session(PRESENT_ID, config(&root).get("configDir")),
            Evidence::Present
        );
        let _ = fs::remove_dir_all(&root);
    }

    // ── resumePlan ─────────────────────────────────────────────────────────

    #[test]
    fn resume_plan_matches_the_turn_request_first_turn_formula() {
        // claude-exp ignores turnCount entirely.
        for turn_count in [0, 5] {
            let plan = resume_plan(&json!({
                "cli": "claude-exp", "turnCount": turn_count, "hasNativeSession": false,
            }));
            assert_eq!(plan["isFirstTurn"], true, "claude-exp {turn_count}");
            let plan = resume_plan(&json!({
                "cli": "claude-exp", "turnCount": turn_count, "hasNativeSession": true,
                "sessionId": PRESENT_ID,
            }));
            assert_eq!(plan["isFirstTurn"], false, "claude-exp {turn_count}");
        }
        // Every other CLI needs both a non-zero turn count and native history.
        assert_eq!(
            resume_plan(&json!({ "cli": "claude", "turnCount": 0, "hasNativeSession": true }))
                ["isFirstTurn"],
            true
        );
        assert_eq!(
            resume_plan(&json!({ "cli": "claude", "turnCount": 3, "hasNativeSession": false }))
                ["isFirstTurn"],
            true
        );
        // A resume plan needs a real id; without one the contradiction branch
        // below turns it into a first turn and this formula no longer applies.
        let root = temp_root("plan-formula");
        let resumed = resume_plan(&json!({
            "cli": "claude", "turnCount": 3, "hasNativeSession": true,
            "sessionId": PRESENT_ID, "configDir": root.to_string_lossy(),
        }));
        assert_eq!(resumed["isFirstTurn"], false);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resume_plan_keeps_a_real_first_turn_out_of_the_missing_id_branch() {
        // `turnCount == 0` is already a first turn, even without an id: the new
        // contradiction branch must not steal its classification.
        for session_id in [json!(null), json!(PRESENT_ID)] {
            let first = resume_plan(&json!({
                "cli": "claude", "turnCount": 0, "hasNativeSession": true,
                "sessionId": session_id,
            }));
            assert_eq!(first["isFirstTurn"], true);
            assert_eq!(first["probe"], "skipped");
            assert_eq!(first["recoverBeforeSpawn"], false);
            assert_eq!(first["reason"], "first_turn");
        }
    }

    #[test]
    fn resume_plan_without_an_id_must_become_a_first_turn_with_recovery() {
        // A plan that says "resume" but carries no id is a contradiction, not a
        // missing transcript: the caller is about to mint a brand-new UUID, and
        // resuming an id that never existed can only fail. So this branch DOES
        // flip `isFirstTurn` — the opposite of the `transcript_proven_absent`
        // semantic lock below, where the conversation was real and silently
        // starting a new one would drop the user's context. Here there is no
        // context attached to any id, but the user does have visible history (a
        // resume plan requires `turnCount > 0 && hasNativeSession`), so
        // `recoverBeforeSpawn` still asks for the handoff checkpoint + warning.
        for input in [
            json!({ "cli": "claude", "turnCount": 2, "hasNativeSession": true }),
            json!({ "cli": "claude", "turnCount": 2, "hasNativeSession": true, "sessionId": "" }),
            json!({ "cli": "claude", "turnCount": 2, "hasNativeSession": true, "sessionId": null }),
        ] {
            let plan = resume_plan(&input);
            assert_eq!(plan["isFirstTurn"], true, "{input}");
            assert_eq!(plan["probe"], "skipped", "{input}");
            assert_eq!(plan["recoverBeforeSpawn"], true, "{input}");
            assert_eq!(plan["reason"], "no_session_id_cannot_resume", "{input}");
        }
    }

    #[test]
    fn resume_plan_reports_present_history_without_recovering() {
        let root = temp_root("plan-present");
        let project = root.join("projects").join("project");
        fs::create_dir_all(&project).expect("project");
        fs::write(project.join(format!("{PRESENT_ID}.jsonl")), "").expect("transcript");
        let plan = resume_plan(&json!({
            "cli": "claude", "turnCount": 4, "hasNativeSession": true,
            "sessionId": PRESENT_ID, "configDir": root.to_string_lossy(),
        }));
        assert_eq!(plan["isFirstTurn"], false);
        assert_eq!(plan["probe"], "present");
        assert_eq!(plan["recoverBeforeSpawn"], false);
        assert_eq!(plan["reason"], "present");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resume_plan_recovers_before_spawn_without_flipping_the_turn_kind() {
        // Semantic lock: a proven-absent transcript makes recovery fire before
        // the spawn, but it must NOT turn the planned resume into a first turn.
        // Silently starting a new conversation would lose the user's context
        // with no checkpoint and no warning — exactly the trade-off
        // claude-exp-history.js refuses. The caller still goes through the
        // normal rotate + handoff-checkpoint + warning path.
        let root = temp_root("plan-absent");
        let plan = resume_plan(&json!({
            "cli": "claude", "turnCount": 3, "hasNativeSession": true,
            "sessionId": PRESENT_ID, "configDir": root.to_string_lossy(),
        }));
        assert_eq!(
            plan["isFirstTurn"], false,
            "recovery must never flip the turn kind"
        );
        assert_eq!(plan["probe"], "proven_absent");
        assert_eq!(plan["recoverBeforeSpawn"], true);
        assert_eq!(plan["reason"], "transcript_proven_absent");
        let _ = fs::remove_dir_all(&root);
    }

    // ── catalog / dispatch ─────────────────────────────────────────────────

    #[test]
    fn catalog_lists_every_op_action_evidence_and_reason() {
        let catalog: Value = serde_json::from_str(&catalog().unwrap()).unwrap();
        assert_eq!(
            catalog["ops"],
            json!(["classifyResult", "decide", "probeTranscript", "resumePlan"])
        );
        assert_eq!(catalog["actions"], json!(["rotate", "skip"]));
        assert_eq!(
            catalog["evidence"],
            json!(["present", "proven_absent", "unknown", "skipped"])
        );
        assert_eq!(catalog["reasons"]["decide"].as_array().unwrap().len(), 5);
        let resume_plan_reasons = catalog["reasons"]["resumePlan"].as_array().unwrap();
        assert_eq!(resume_plan_reasons.len(), 5);
        assert!(resume_plan_reasons.contains(&json!("no_session_id_cannot_resume")));
        assert!(!resume_plan_reasons.contains(&json!("no_session_id")));
    }

    #[test]
    fn dispatch_reports_an_unknown_op_through_the_envelope() {
        let expected = envelope(dispatch("mystery", &json!(null)));
        assert_eq!(expected["ok"], false);
        assert_eq!(expected["error"]["code"], "unknown_op");
    }

    #[test]
    fn request_value_round_trips_through_the_js_value_bridge() {
        let request = tags::to_js(&json!({
            "event": missing_event(),
            "lastSpawnWasResume": true,
            "forwardedEventCount": 0,
            "attempt": 0,
        }));
        let response = request_value("decide", &request).expect("decides");
        let value = tags::from_js(&response);
        assert_eq!(value["ok"], true);
        assert_eq!(value["value"]["action"], "rotate");
        assert_eq!(value["value"]["reason"], "resume_target_missing");
    }
}
