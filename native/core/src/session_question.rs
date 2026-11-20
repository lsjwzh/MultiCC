//! Client and internal-tool protocol for the durable session question.
use crate::classify_vocab;
use crate::js::{self, JsString, JsValue as V};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const MAX_QUESTION_LENGTH: usize = 16 * 1024;
pub const MAX_REASON_LENGTH: usize = 4 * 1024;
const MAX_OPTION_LENGTH: usize = 512;
const MAX_OPTIONS: usize = 12;
const PROMPT: &[&str] = &[
    "[Waiting for a user answer] When you are about to end the turn with a blocking question (a missing user decision, confirmation, choice, or required information means the task cannot safely continue), you must first call the MultiCC MCP tool wait_for_user_answer; the old name request_user_input exists only for compatibility.",
    "The tool may appear as multicc_router.wait_for_user_answer or mcp__multicc_router__wait_for_user_answer. After a successful call, present the same question and options to the user as the final reply of this turn, then end the turn without running further tools.",
    "Do not call it when you can reasonably continue with the information you have. Ordinary suggestions, optional follow-up work, and polite rhetorical questions do not require waiting for the user.",
];
const CODEX_CONSTRAINT: &[&str] = &[
    "[MultiCC environment constraints]",
    "- The Codex built-in request_user_input / AskUserQuestion tools are unavailable in this non-interactive execution environment.",
    "- Before ending a turn with a blocking question, you must call the MultiCC MCP tool wait_for_user_answer (it may appear as mcp__multicc_router__wait_for_user_answer); do not call the Codex built-in tool of the same name.",
    "- After the tool returns, present the same question as the final reply and end the turn; do not call it when you can safely and reasonably continue.",
    "[End of MultiCC environment constraints]",
];

fn field(value: &V, key: &str) -> V {
    value.get(key).cloned().unwrap_or(V::Undefined)
}

fn or(value: V, fallback: V) -> V {
    if js::truthy(&value) {
        value
    } else {
        fallback
    }
}

fn string(value: &V) -> JsString {
    match value {
        V::Undefined | V::Null => JsString::default(),
        value => js::js_to_string(value),
    }
}

fn clipped(value: &V, limit: usize) -> JsString {
    let trimmed = string(value).trim();
    JsString::from_units(trimmed.as_units()[..trimmed.len().min(limit)].to_vec())
}

fn request_id(parts: &[JsString]) -> V {
    let joined = JsString::join(parts, &JsString::from("\0"));
    let hash = format!("{:x}", Sha256::digest(joined.to_string_lossy().as_bytes()));
    V::from(format!("usrq-{}", &hash[..24]))
}

pub fn adapter_signal(input: &V) -> V {
    let question = clipped(&field(input, "question"), MAX_QUESTION_LENGTH);
    if question.is_empty() {
        return V::Null;
    }
    let reason = clipped(&field(input, "reason"), MAX_REASON_LENGTH);
    let mut seen = HashSet::new();
    let options: Vec<JsString> = match input.get("options") {
        Some(V::Array(options)) => options
            .iter()
            .map(|option| clipped(option, MAX_OPTION_LENGTH))
            .filter(|option| !option.is_empty() && seen.insert(option.clone()))
            .take(MAX_OPTIONS)
            .collect(),
        _ => Vec::new(),
    };
    let multiple = input.get("allowMultiple") == Some(&V::Bool(true)) && options.len() >= 2;
    let session = field(input, "sessionId");
    let turn = field(input, "turnId");
    let id = request_id(&[
        string(&session),
        string(&turn),
        question.clone(),
        reason.clone(),
        JsString::join(&options, &JsString::from("\0")),
        JsString::from(if multiple { "true" } else { "false" }),
    ]);
    V::object(vec![
        ("requestId", id),
        ("sessionId", V::String(string(&or(session, V::Null)))),
        ("turnId", V::String(string(&or(turn, V::Null)))),
        ("question", V::String(question)),
        ("reason", V::String(reason)),
        (
            "options",
            V::Array(options.into_iter().map(V::String).collect()),
        ),
        ("allowMultiple", V::Bool(multiple)),
    ])
}

fn checked_text(value: &V, field: &str, limit: usize, required: bool) -> Result<JsString, V> {
    let text = string(value).trim();
    if required && text.is_empty() {
        return Err(argument_error(
            "invalid_arguments",
            format!("{field} is required"),
            400,
        ));
    }
    if text.len() > limit {
        return Err(argument_error(
            "payload_too_large",
            format!("{field} exceeds {limit} characters"),
            413,
        ));
    }
    Ok(text)
}

fn argument_error(code: &str, message: String, status: u16) -> V {
    V::object(vec![
        ("code", V::from(code)),
        ("message", V::from(message)),
        ("status", V::Number(f64::from(status))),
    ])
}

fn invalid(message: &str) -> V {
    argument_error("invalid_arguments", message.into(), 400)
}

pub fn tool_signal(session: &str, turn: &str, input: &V) -> Result<V, V> {
    let question = checked_text(
        &field(input, "question"),
        "question",
        MAX_QUESTION_LENGTH,
        true,
    )?;
    let reason = checked_text(&field(input, "reason"), "reason", MAX_REASON_LENGTH, false)?;
    let options = match input.get("options") {
        None | Some(V::Null) => Vec::new(),
        Some(V::Array(options)) if options.len() <= MAX_OPTIONS => {
            let options = options
                .iter()
                .map(|option| checked_text(option, "option", MAX_OPTION_LENGTH, true))
                .collect::<Result<Vec<_>, _>>()?;
            if options.iter().collect::<HashSet<_>>().len() != options.len() {
                return Err(invalid("options must be unique"));
            }
            options
        }
        Some(V::Array(_)) => {
            return Err(invalid(&format!(
                "options cannot exceed {MAX_OPTIONS} items"
            )))
        }
        _ => return Err(invalid("options must be an array")),
    };
    let multiple = input.get("allow_multiple") == Some(&V::Bool(true));
    if multiple && options.len() < 2 {
        return Err(invalid("allow_multiple requires at least two options"));
    }
    let id = request_id(&[
        JsString::from(session),
        JsString::from(turn),
        question.clone(),
        reason.clone(),
        JsString::join(&options, &JsString::from("\0")),
        JsString::from(if multiple { "true" } else { "false" }),
    ]);
    Ok(V::object(vec![
        ("requestId", id),
        ("sessionId", V::from(session)),
        ("turnId", V::from(turn)),
        ("question", V::String(question)),
        ("reason", V::String(reason)),
        (
            "options",
            V::Array(options.into_iter().map(V::String).collect()),
        ),
        ("allowMultiple", V::Bool(multiple)),
    ]))
}

pub fn required_frame(pending: &V) -> V {
    let mut frame = vec![
        ("type", V::from("user_input_required")),
        ("requestId", field(pending, "requestId")),
        ("turnId", or(field(pending, "turnId"), V::Null)),
        ("taskId", or(field(pending, "taskId"), V::Null)),
        ("question", field(pending, "question")),
        ("reason", or(field(pending, "reason"), V::from(""))),
        (
            "options",
            or(field(pending, "options"), V::Array(Vec::new())),
        ),
        (
            "allowMultiple",
            V::Bool(pending.get("allowMultiple") == Some(&V::Bool(true))),
        ),
    ];
    let name = field(pending, "secretName");
    if pending.get("inputType") == Some(&V::from("secret")) && js::truthy(&name) {
        frame.extend([
            ("inputType", V::from("secret")),
            ("secretName", V::String(string(&name))),
        ]);
    }
    V::object(frame)
}

pub fn is_open(pending: &V) -> bool {
    js::truthy(pending) && pending.get("resolved") != Some(&V::Bool(true))
}

pub fn replay(pending: &V, last: &V) -> V {
    if is_open(pending) {
        return required_frame(pending);
    }
    let last = if js::truthy(last) { last } else { pending };
    let id = field(last, "requestId");
    if !js::truthy(&id) {
        return V::Null;
    }
    let mut frame = vec![
        ("type", V::from("user_input_resolved")),
        ("requestId", id),
        (
            "taskId",
            js::nullish(last.get("taskId"), None)
                .cloned()
                .unwrap_or(V::Null),
        ),
    ];
    if js::truthy_opt(last.get("superseded")) {
        frame.push(("superseded", V::Bool(true)));
    }
    frame.push(("replay", V::Bool(true)));
    V::object(frame)
}

fn rejection(code: &str) -> V {
    V::object(vec![("ok", V::Bool(false)), ("code", V::from(code))])
}

pub(crate) fn dismissal(input: &V) -> V {
    let pending = field(input, "pending");
    let queue = field(input, "queue");
    let liveness = field(input, "liveness");
    let active = field(&queue, "active");
    let active_task = field(&active, "taskId");
    let task = field(&pending, "taskId");
    let class = field(input, "classifyState");
    let unloaded =
        liveness.get("reason") == Some(&V::from("no_chat_runtime")) && !js::truthy(&active);
    let code = if !js::truthy(&queue) {
        "scheduler_not_ready"
    } else if !js::truthy(&pending) {
        "no_pending_request"
    } else if pending.get("requestId") != input.get("requestId") {
        "request_id_mismatch"
    } else if !is_open(&pending) {
        return V::object(vec![("ok", V::Bool(true)), ("duplicate", V::Bool(true))]);
    } else if input.get("streaming") == Some(&V::Bool(true))
        || classify_vocab::is_processing_letter(&string(&class).to_string_lossy())
        || (js::truthy(&active) && queue.get("state") != Some(&V::from("frozen")))
    {
        "turn_still_active"
    } else if input.get("externalWait") == Some(&V::Bool(true)) {
        "external_wait_pending"
    } else if js::truthy(&active_task) && js::truthy(&task) && active_task != task {
        "active_task_mismatch"
    } else if !unloaded && liveness.get("state") != Some(&V::from("inactive")) {
        "turn_still_active"
    } else {
        return V::object(vec![
            ("ok", V::Bool(true)),
            ("taskId", or(task, V::Null)),
            (
                "liveness",
                if unloaded {
                    V::object(vec![
                        ("state", V::from("inactive")),
                        ("reason", V::from("unloaded_idle_session")),
                    ])
                } else {
                    liveness
                },
            ),
        ]);
    };
    rejection(code)
}

fn recovery(input: &V) -> V {
    let pending = field(input, "pending");
    let queue = field(input, "queue");
    let active = field(&queue, "active");
    let active_task = field(&active, "taskId");
    let task = field(&pending, "taskId");
    if !js::truthy(&active)
        || queue.get("state") != Some(&V::from("frozen"))
        || queue.get("freezeReason") != Some(&V::from("classify_running"))
    {
        return rejection("not_recovered_turn");
    }
    if !is_open(&pending) {
        return rejection("no_pending_request");
    }
    if js::truthy(&active_task) && js::truthy(&task) && active_task != task {
        return rejection("active_task_mismatch");
    }
    V::object(vec![
        ("ok", V::Bool(true)),
        ("taskId", or(active_task, or(task, V::Null))),
        ("requestId", field(&pending, "requestId")),
    ])
}

pub fn request(op: &str, input: &str) -> Result<String, String> {
    let input = js::json_parse(input).map_err(|error| error.to_string())?;
    let output = match op {
        "adapterSignal" => adapter_signal(&input),
        "toolSignal" => {
            let session = string(&field(&input, "sessionId")).to_string_lossy();
            let turn = string(&field(&input, "turnId")).to_string_lossy();
            match tool_signal(&session, &turn, &field(&input, "args")) {
                Ok(signal) => V::object(vec![("signal", signal)]),
                Err(error) => V::object(vec![("error", error)]),
            }
        }
        "prompt" => V::Array(PROMPT.iter().copied().map(V::from).collect()),
        "codexConstraint" => V::from(if js::truthy(&input) {
            CODEX_CONSTRAINT.join("\n")
        } else {
            String::new()
        }),
        "requiredFrame" => required_frame(&input),
        "replay" => replay(&field(&input, "pending"), &field(&input, "last")),
        "dismissal" => dismissal(&input),
        "recovery" => recovery(&input),
        _ => return Err(format!("unknown session question operation: {op}")),
    };
    js::json_stringify(&output).ok_or_else(|| "session question output undefined".into())
}
