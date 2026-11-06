//! Typed provider failures. Protocol extraction, evidence and recovery are
//! separate from presentation. No request bodies or arbitrary object walks.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

mod legacy;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    AuthenticationPermission,
    BillingQuota,
    RateLimit,
    ProviderTransient,
    Network,
    Timeout,
    InvalidRequestModel,
    ContextTokenLimit,
    ToolProtocol,
    CancelShutdown,
    AdapterConfiguration,
    Unknown,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    ContextOverflow,
    OutputLimit,
    Other,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    Category,
    ErrorType,
    HttpStatus,
    LegacyMessage,
    TokenBudget,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub kind: EvidenceKind,
    pub path: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextAction {
    Keep,
    Rotate,
    Review,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub retry_same_request: bool,
    pub context: ContextAction,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub category: Category,
    pub reason: Reason,
    pub evidence: Evidence,
    pub recovery: Recovery,
}

impl Diagnosis {
    fn new(category: Category, reason: Reason, kind: EvidenceKind, path: String) -> Self {
        let context = if reason != Reason::ContextOverflow {
            ContextAction::Keep
        } else if kind == EvidenceKind::LegacyMessage {
            ContextAction::Review
        } else {
            ContextAction::Rotate
        };
        Self {
            category,
            reason,
            evidence: Evidence { kind, path },
            recovery: Recovery {
                retry_same_request: matches!(
                    category,
                    Category::RateLimit
                        | Category::ProviderTransient
                        | Category::Network
                        | Category::Timeout
                        | Category::Unknown
                ),
                context,
            },
        }
    }

    pub fn should_rotate_context(&self) -> bool {
        self.recovery.context == ContextAction::Rotate
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Event,
    NativeHistory,
    Stderr,
}

struct Frame {
    value: Value,
    path: String,
}

// Preserve envelope boundaries and paths, unlike collecting all strings into
// one bag. Only known protocol edges are followed. Embedded JSON is accepted
// only as a complete error envelope, never extracted from quoted prose.
fn frames(value: &Value, path: &str, depth: usize, out: &mut Vec<Frame>) {
    if depth > 6 || out.len() >= 24 || !value.is_object() {
        return;
    }
    out.push(Frame {
        value: value.clone(),
        path: path.into(),
    });
    for key in ["rpcError", "error", "data"] {
        if value[key].is_object() {
            frames(&value[key], &format!("{path}.{key}"), depth + 1, out);
        }
    }
    if value["response"]["error"].is_object() {
        frames(
            &value["response"]["error"],
            &format!("{path}.response.error"),
            depth + 1,
            out,
        );
    }
    if let Some(text) = value["message"].as_str().filter(|s| s.len() <= 65536) {
        if let Ok(embedded) = crate::json_lenient::from_str::<Value>(text) {
            if embedded["error"].is_object() || embedded["response"]["error"].is_object() {
                frames(&embedded, &format!("{path}.message"), depth + 1, out);
            }
        }
    }
}

/// Codes that name a local stop: the user, the server or MultiCC itself ended
/// the run. A local stop is never a provider fault, so it outranks every other
/// piece of evidence and Auto never fails over on it. This is the one table:
/// `src/chat/api-error-policy.js` reads it through [`facts`].
pub const LOCAL_CANCELLATION_CODES: &[&str] = &[
    "aborterror",
    "aborted",
    "cancelled",
    "canceled",
    "user_cancel",
    "new_user_message",
    "shutdown",
    "server_shutting_down",
    "session_delete",
    "cli_switch",
    "relocate",
    "sigterm",
    "sigint",
    // The server killed its own child to respawn it.
    "restart_spawn",
];

/// The classifier's tables that JavaScript policy still consults.
pub fn facts() -> String {
    json!({ "cancellationCodes": LOCAL_CANCELLATION_CODES }).to_string()
}

// Wire identifiers are an adapter contract, not error prose. Generic wrappers
// carry no domain meaning; unknown specific types block legacy inference.
fn wire_type(provider: &str, code: &str) -> Option<(Category, Reason)> {
    use Category::*;
    use Reason::*;
    let code = code.to_ascii_lowercase();
    if LOCAL_CANCELLATION_CODES.contains(&code.as_str()) {
        return Some((CancelShutdown, Other));
    }
    Some(match code.as_str() {
        "contextoverflowerror" if provider == "opencode" => (ContextTokenLimit, ContextOverflow),
        "messageabortederror" if provider == "opencode" => (CancelShutdown, Other),
        "providerautherror" if provider == "opencode" => (AuthenticationPermission, Other),
        "context_length_exceeded" | "context_window_exceeded" => {
            (ContextTokenLimit, ContextOverflow)
        }
        "max_tokens_exceeded" | "max_output_tokens" => (ContextTokenLimit, OutputLimit),
        "authentication_error"
        | "permission_denied"
        | "unauthorized"
        | "forbidden"
        | "invalid_api_key"
        | "auth_required" => (AuthenticationPermission, Other),
        "billing_error" | "insufficient_quota" | "quota_exceeded" => (BillingQuota, Other),
        "rate_limit_error" | "rate_limited" | "too_many_requests" => (RateLimit, Other),
        _ => return None,
    })
}

fn generic_type(code: &str) -> bool {
    matches!(
        code.to_ascii_lowercase().as_str(),
        "error"
            | "unknownerror"
            | "apierror"
            | "internal_error"
            | "internal_server_error"
            | "agent_exited"
    )
}

pub fn diagnose(provider: &str, origin: Origin, value: &Value) -> Option<Diagnosis> {
    if origin == Origin::Stderr {
        let mut metadata = value.clone();
        metadata.as_object_mut()?.remove("message");
        if let Some(diagnosis) = diagnose(provider, Origin::Event, &metadata) {
            return Some(diagnosis);
        }
        // Stderr is an unstructured stream, not a trusted error.message field.
        // Only standalone error records qualify; prompt dumps never do.
        return value["message"]
            .as_str()?
            .lines()
            .take(512)
            .find_map(|line| {
                let line = line.trim();
                if let Ok(record) = crate::json_lenient::from_str::<Value>(line) {
                    if record["error"].is_object() {
                        return diagnose(provider, Origin::Event, &record);
                    }
                }
                line.strip_prefix("Error: ")
                    .or_else(|| line.strip_prefix("ERROR: "))
                    .and_then(|message| {
                        diagnose(provider, Origin::Event, &json!({"message":message}))
                    })
            });
    }
    let mut chain = Vec::new();
    frames(value, "$", 0, &mut chain);
    // Cancellation wins even when an earlier RPC failed while being stopped.
    for frame in &chain {
        for key in ["code", "errorName", "name", "type"] {
            if frame.value[key]
                .as_str()
                .and_then(|s| wire_type(provider, s))
                .is_some_and(|(category, _)| category == Category::CancelShutdown)
            {
                return Some(Diagnosis::new(
                    Category::CancelShutdown,
                    Reason::Other,
                    EvidenceKind::ErrorType,
                    format!("{}.{key}", frame.path),
                ));
            }
        }
    }
    // Explicit categories and specific wire types outrank every prose fallback.
    for frame in &chain {
        if let Ok(category) = serde_json::from_value::<Category>(frame.value["category"].clone()) {
            if category != Category::Unknown {
                return Some(Diagnosis::new(
                    category,
                    Reason::Other,
                    EvidenceKind::Category,
                    format!("{}.category", frame.path),
                ));
            }
        }
    }
    let mut specific_type = None;
    for frame in &chain {
        for key in ["code", "errorName", "name", "type"] {
            let Some(code) = frame.value[key].as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            if let Some((category, reason)) = wire_type(provider, code) {
                return Some(Diagnosis::new(
                    category,
                    reason,
                    EvidenceKind::ErrorType,
                    format!("{}.{key}", frame.path),
                ));
            }
            if !generic_type(code) && specific_type.is_none() {
                specific_type = Some(format!("{}.{key}", frame.path));
            }
        }
    }
    // Auth/quota status cannot be replaced by a context phrase in a gateway
    // message. Generic 400/500 and JSON-RPC -32603 do not identify the cause.
    for frame in &chain {
        for key in ["httpStatus", "statusCode", "status"] {
            let category = match frame.value[key].as_u64() {
                Some(401 | 403) => Category::AuthenticationPermission,
                Some(402) => Category::BillingQuota,
                Some(429) => Category::RateLimit,
                _ => continue,
            };
            return Some(Diagnosis::new(
                category,
                Reason::Other,
                EvidenceKind::HttpStatus,
                format!("{}.{key}", frame.path),
            ));
        }
    }
    if let Some(path) = specific_type {
        return Some(Diagnosis::new(
            Category::Unknown,
            Reason::Other,
            EvidenceKind::ErrorType,
            path,
        ));
    }
    // Legacy compatibility is deliberately limited to the OpenCode boundary.
    if provider != "opencode" {
        return None;
    }
    chain.iter().rev().find_map(|frame| {
        let kind = legacy::context_evidence(frame.value["message"].as_str()?)?;
        Some(Diagnosis::new(
            Category::ContextTokenLimit,
            Reason::ContextOverflow,
            kind,
            format!("{}.message", frame.path),
        ))
    })
}

// Presentation consumes the typed result; it cannot influence recovery.
fn presentation(diagnosis: &Diagnosis) -> Value {
    if diagnosis.reason != Reason::ContextOverflow {
        return Value::Null;
    }
    json!({
        "message": "请求或会话历史超过模型上下文上限。",
        "userAction": "请使用聊天菜单中的“压缩上下文”新开原生上下文（保留完整聊天历史），再继续任务；若仍超限，请缩短本次输入或选择上下文容量更大的模型。"
    })
}

pub fn classify(input: &str) -> Result<String, String> {
    let args: Value = crate::json_lenient::from_str(input).map_err(|e| e.to_string())?;
    let origin = match args["source"].as_str() {
        Some("process_stderr") => Origin::Stderr,
        Some("native_history") => Origin::NativeHistory,
        _ => Origin::Event,
    };
    let result = diagnose(
        args["provider"].as_str().unwrap_or(""),
        origin,
        &args["error"],
    )
    .map(|diagnosis| json!({"presentation":presentation(&diagnosis),"diagnosis":diagnosis}));
    serde_json::to_string(&result).map_err(|e| e.to_string())
}
