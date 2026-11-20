//! Durable receipt identity for the task-shell input carried by /ws/chat.
use crate::js::{self, JsValue as V};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    Work,
    Answer,
    Cancel,
}

impl Intent {
    fn label(self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::Answer => "answer",
            Self::Cancel => "cancel",
        }
    }
}

pub struct Rejection {
    pub code: &'static str,
    pub message: String,
    not_delivered: bool,
}

impl Rejection {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            not_delivered: true,
        }
    }

    pub fn state(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            not_delivered: false,
        }
    }

    pub fn frame(self, client_id: V) -> V {
        V::object(vec![
            ("type", V::from("error")),
            ("code", V::from(self.code)),
            ("error", V::from(self.message)),
            ("clientMsgId", client_id),
            ("notDelivered", V::Bool(self.not_delivered)),
        ])
    }
}

fn property(value: &V, key: &str) -> V {
    value.get(key).cloned().unwrap_or(V::Undefined)
}

fn identifier(value: V, field: &str) -> Result<V, Rejection> {
    if matches!(&value, V::String(text) if (1..=160).contains(&text.len())
    && text.as_units().iter().all(|&unit| u8::try_from(unit).is_ok_and(
        |byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte)
    ))) {
        Ok(value)
    } else {
        Err(Rejection::new("invalid_input", format!("invalid {field}")))
    }
}

fn optional_identifier(value: V, field: &str) -> Result<V, Rejection> {
    if value.is_nullish() {
        Ok(V::Null)
    } else {
        identifier(value, field)
    }
}

pub fn intent(message: &V) -> Intent {
    if message.get("type") == Some(&V::from("cancel")) {
        Intent::Cancel
    } else if js::truthy_opt(message.get("userInputRequestId")) {
        Intent::Answer
    } else {
        Intent::Work
    }
}

/// The WebSocket projects input before calling the task-shell runtime. IDs for
/// controls come from the authorized execution and the shell cursor.
pub fn normalize(message: &V, control_task: Option<&str>) -> Result<V, Rejection> {
    let intent = intent(message);
    let client_id = identifier(property(message, "clientMsgId"), "clientMsgId")?;
    let text = if intent == Intent::Cancel {
        V::from("")
    } else {
        let raw = property(message, "text");
        let V::String(raw) = raw else {
            return Err(Rejection::new("invalid_text", "invalid_text"));
        };
        let trimmed = raw.trim();
        if raw.len() > 32_000 || trimmed.is_empty() {
            return Err(Rejection::new("invalid_text", "invalid_text"));
        }
        V::String(trimmed)
    };
    let (task, turn, request) = if intent == Intent::Work {
        (V::Null, V::Null, V::Null)
    } else {
        let task = optional_identifier(control_task.map_or(V::Null, V::from), "taskId")?;
        let turn = optional_identifier(property(message, "turnId"), "turnId")?;
        let request = optional_identifier(property(message, "userInputRequestId"), "requestId")?;
        if task.is_nullish() || turn.is_nullish() {
            return Err(Rejection::new(
                "invalid_control",
                "Controls require the original task and turn",
            ));
        }
        if intent == Intent::Answer && request.is_nullish() {
            return Err(Rejection::new(
                "invalid_control",
                "Answer requires requestId",
            ));
        }
        (task, turn, request)
    };
    let mut fields = vec![
        ("clientMsgId", client_id),
        ("intent", V::from(intent.label())),
        ("text", text),
        ("taskId", task),
        ("newTask", V::Bool(false)),
        ("contextTaskIds", V::Array(vec![])),
        ("dependsOn", V::Array(vec![])),
        ("turnId", turn),
        ("requestId", request),
    ];
    if let Some(value @ (V::Object(_) | V::Array(_))) = message.get("unattended") {
        fields.push(("unattended", value.clone()));
    } else if message.get("goal") == Some(&V::Bool(true)) {
        fields.push(("unattended", V::Object(vec![])));
    }
    if let Some(V::String(lang)) = message.get("lang") {
        if lang == "zh" || lang == "en" {
            fields.push(("lang", V::String(lang.clone())));
        }
    }
    if message.get("inputSource") == Some(&V::from("voice")) {
        let raw = match message.get("voiceRaw") {
            Some(V::String(raw)) => V::String(raw.trim().truncate_units(4000)),
            _ => V::from(""),
        };
        fields.push(("voice", V::object(vec![("raw", raw)])));
    }
    Ok(V::object(fields))
}

fn digest(value: &V) -> String {
    format!(
        "{:x}",
        Sha256::digest(js::json_stringify_or_undefined(value))
    )
}

pub fn normalize_http(raw: &V, internal_dispatch: bool) -> Result<V, Rejection> {
    let client_id = identifier(property(raw, "clientMsgId"), "clientMsgId")?;
    let intent = raw
        .get("intent")
        .filter(|value| js::truthy(value))
        .cloned()
        .unwrap_or(V::from("work"));
    if !["work", "steer", "answer", "cancel"]
        .iter()
        .any(|name| intent == V::from(*name))
    {
        return Err(Rejection::new("invalid_intent", "invalid_intent"));
    }
    let V::String(text) = property(raw, "text") else {
        return Err(Rejection::new("invalid_text", "invalid_text"));
    };
    if text.len() > if internal_dispatch { 270_000 } else { 32_000 }
        || (intent != V::from("cancel") && text.trim().is_empty())
    {
        return Err(Rejection::new("invalid_text", "invalid_text"));
    }
    let list = |field: &str| -> Result<V, Rejection> {
        let value = property(raw, field);
        if value.is_nullish() {
            return Ok(V::Array(vec![]));
        }
        let V::Array(values) = value else {
            return Err(Rejection::new("invalid_input", format!("invalid {field}")));
        };
        if values.len() > 3 {
            return Err(Rejection::new("invalid_input", format!("invalid {field}")));
        }
        let mut ids = values
            .into_iter()
            .map(|id| identifier(id, field))
            .collect::<Result<Vec<_>, _>>()?;
        ids.sort_by(|a, b| {
            js::js_to_string(a)
                .as_units()
                .cmp(js::js_to_string(b).as_units())
        });
        ids.dedup();
        Ok(V::Array(ids))
    };
    let task = optional_identifier(property(raw, "taskId"), "taskId")?;
    let turn = optional_identifier(property(raw, "turnId"), "turnId")?;
    let request = optional_identifier(property(raw, "requestId"), "requestId")?;
    let new_task = raw.get("newTask") == Some(&V::Bool(true));
    let contexts = list("contextTaskIds")?;
    let dependencies = list("dependsOn")?;
    let mut fields = vec![
        ("clientMsgId", client_id),
        ("intent", intent.clone()),
        ("text", V::String(text.trim())),
        ("taskId", task.clone()),
        ("newTask", V::Bool(new_task)),
    ];
    if let Some(value) = raw
        .get("expectedCursorVersion")
        .filter(|value| !value.is_nullish())
    {
        fields.push(("expectedCursorVersion", V::Number(js::js_to_number(value))));
    }
    fields.extend([
        ("contextTaskIds", contexts.clone()),
        ("dependsOn", dependencies.clone()),
        ("turnId", turn.clone()),
        ("requestId", request.clone()),
    ]);
    if let Some(value @ (V::Object(_) | V::Array(_))) = raw.get("unattended") {
        fields.push(("unattended", value.clone()));
    } else if raw.get("goal") == Some(&V::Bool(true)) {
        fields.push(("unattended", V::Object(vec![])));
    }
    if let Some(lang @ V::String(_)) = raw
        .get("lang")
        .filter(|value| **value == V::from("zh") || **value == V::from("en"))
    {
        fields.push(("lang", lang.clone()));
    }
    if raw.get("inputSource") == Some(&V::from("voice")) {
        let voice = match raw.get("voiceRaw") {
            Some(V::String(text)) => V::String(text.trim().truncate_units(4000)),
            _ => V::from(""),
        };
        fields.push(("voice", V::object(vec![("raw", voice)])));
    }
    let references = matches!(&contexts,V::Array(rows) if !rows.is_empty())
        || matches!(&dependencies,V::Array(rows) if !rows.is_empty());
    if intent != V::from("work")
        && (new_task || task.is_nullish() || turn.is_nullish() || references)
    {
        return Err(Rejection::new(
            "invalid_control",
            "Controls require the original task and turn",
        ));
    }
    if intent == V::from("answer") && request.is_nullish() {
        return Err(Rejection::new(
            "invalid_control",
            "Answer requires requestId",
        ));
    }
    Ok(V::object(fields))
}

pub fn source_shell_id(session: &str) -> String {
    format!("sh_{}", &digest(&V::from(session))[..24])
}

pub fn receipt_identity(shell: &str, input: &V) -> (String, String) {
    let key = V::Array(vec![V::from(shell), property(input, "clientMsgId")]);
    (format!("sr_{}", &digest(&key)[..40]), digest(input))
}

pub fn routed_frame(
    shell: &str,
    receipt: &str,
    task: &str,
    session: &str,
    decision: &str,
    client_id: V,
) -> V {
    V::object(vec![
        ("type", V::from("task_shell_routed")),
        ("ok", V::Bool(true)),
        ("taskId", V::from(task)),
        ("sessionId", V::from(session)),
        ("receiptId", V::from(receipt)),
        ("decision", V::from(decision)),
        ("shellId", V::from(shell)),
        ("clientMsgId", client_id),
    ])
}
