use serde::Deserialize;
use serde_json::{json, Map, Value};

// Only these fields are materialized. Context ledgers and message bodies are skipped
// by serde, rather than parsed into a general-purpose JSON tree.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    id: String,
    #[serde(default)]
    dir_id: Option<String>,
    title: String,
    #[serde(default, deserialize_with = "present")]
    status: Option<Value>,
    #[serde(default)]
    record_type: Value,
    #[serde(default)]
    workflow_stage: Value,
    #[serde(default)]
    updated_at: Option<f64>,
    #[serde(default)]
    created_at: Option<f64>,
    #[serde(default)]
    chat_session_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    refs: Vec<Reference>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    #[serde(default)]
    ts: Option<f64>,
    #[serde(default)]
    dir_id: Option<String>,
}
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Ok(Some(Value::deserialize(d)?))
}

pub fn number(value: &Value) -> Result<f64, String> {
    let n = match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().ok_or("read_model_invalid_number")?,
        Value::String(s) if s.trim().is_empty() => 0.0,
        Value::String(s) => s.trim().parse().map_err(|_| "read_model_invalid_number")?,
        _ => return Err("read_model_invalid_number".into()),
    };
    if !n.is_finite() || n.abs() > 9_007_199_254_740_991.0 {
        return Err("read_model_invalid_number".into());
    }
    Ok(n)
}
pub fn at(card: &Value) -> f64 {
    card["lastMessageAt"]
        .as_f64()
        .filter(|n| *n != 0.0)
        .or_else(|| card["updatedAt"].as_f64())
        .unwrap_or(0.0)
}
pub fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}

pub fn project(id: &str, body: &str) -> Result<Value, String> {
    let source: Source = serde_json::from_str(body).map_err(|_| "read_model_invalid_record")?;
    if id != source.id || id.is_empty() {
        return Err("read_model_unsupported_identity".into());
    }
    let created = source.created_at.unwrap_or(0.0);
    let updated = source.updated_at.filter(|n| *n != 0.0).unwrap_or(created);
    let last = source
        .refs
        .iter()
        .filter_map(|r| r.ts)
        .fold(0.0_f64, f64::max);
    let last = if last != 0.0 {
        last
    } else if created != 0.0 {
        created
    } else {
        updated
    };
    for n in [created, updated, last]
        .into_iter()
        .chain(source.refs.iter().filter_map(|r| r.ts))
    {
        number(&json!(n))?;
    }
    let dir = source.dir_id.filter(|s| !s.is_empty()).or_else(|| {
        source
            .refs
            .iter()
            .find_map(|r| r.dir_id.as_ref().filter(|s| !s.is_empty()).cloned())
    });
    let session = source
        .chat_session_id
        .filter(|s| !s.is_empty())
        .or_else(|| source.session_id.filter(|s| !s.is_empty()));
    let mut card = json!({"id":id,"dirId":dir,"title":source.title,
        "recordType":if truthy(&source.record_type) { source.record_type } else { Value::Null },
        "workflowStage":if truthy(&source.workflow_stage) { source.workflow_stage } else { Value::Null },
        "updatedAt":updated,"lastMessageAt":last,"sessionId":session});
    if let Some(status) = source.status {
        if !status.is_string() && !status.is_null() {
            return Err("read_model_invalid_record".into());
        }
        card["status"] = status;
    }
    Ok(card)
}

pub fn overlay(mut card: Value, overlays: &Map<String, Value>) -> Result<Value, String> {
    if let Some(overlay) = overlays.get(text(&card, "id")) {
        let fields = overlay.as_object().ok_or("read_model_invalid_overlay")?;
        for (key, value) in fields {
            // Existing host rules supply these fields; this model does not infer
            // permissions, live queue state, Git state, capacity or visibility.
            if ![
                "dirId",
                "sessionId",
                "readOnly",
                "shellId",
                "access",
                "providerName",
                "runState",
                "goalState",
                "resource",
                "worktreeChanges",
                "attention",
            ]
            .contains(&key.as_str())
            {
                return Err("read_model_unsupported_overlay".into());
            }
            card[key] = value.clone();
        }
    }
    for field in ["dirId", "runState", "goalState"] {
        if !card[field].is_null() && !card[field].is_string() {
            return Err("read_model_invalid_overlay".into());
        }
    }
    Ok(card)
}

pub fn state(card: &Value) -> String {
    let lifecycle = text(card, "status").trim().to_lowercase();
    if ["archived", "done"].contains(&lifecycle.as_str()) {
        return lifecycle;
    }
    let raw = text(card, "runState").trim().to_lowercase();
    match raw.as_str() {
        "" => {
            if lifecycle == "active" {
                "idle"
            } else {
                "unknown"
            }
        }
        "done" | "completed" | "complete" | "success" | "finished" => "succeeded",
        "thinking" | "editing" | "working" | "processing" | "starting" | "assessing" | "busy"
        | "active" | "claimed" | "resumed" | "started" => "running",
        "frozen" | "paused" | "pending" => "waiting",
        "failed" | "fail" | "errored" => "error",
        "canceled" | "aborted" | "interrupted" => "cancelled",
        "skipped" | "released" => "idle",
        "stopped" | "disconnected" | "inactive" | "gone" => "offline",
        "idle" | "queued" | "running" | "waiting" | "background" | "blocked" | "error"
        | "succeeded" | "cancelled" | "archived" | "offline" | "unknown" => &raw,
        _ => "unknown",
    }
    .into()
}
