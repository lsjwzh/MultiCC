//! 路由错误：状态码 + 回给前端的 `{ok:false,error,message}` 三段。
//!
//! JS 里错误是 `Object.assign(new Error(msg), { status, reason, agent })`：
//! `agent` 是 Agent 的原始回复，`reason` 是契约里的 reason code。
//! 这里照搬同样的三个槽，`sendError` 的分支判断才能一一对应。

use crate::jsval::truthy;
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct AppError {
    pub status: u16,
    /// JS 的 `error.message`：没有 agent 回复时它就是回给前端的 `error`
    pub message: String,
    pub reason: Option<String>,
    /// 装箱：Agent 原始回复可大，但不该让整条 Result 的 Err 变体跟着变大。
    pub agent: Option<Box<Value>>,
}

impl AppError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            reason: None,
            agent: None,
        }
    }

    pub fn with_reason(status: u16, message: impl Into<String>, reason: &str) -> Self {
        Self {
            status,
            message: message.into(),
            reason: Some(reason.to_string()),
            agent: None,
        }
    }

    /// Agent 回了 `ok:false`：原始回复整个带上，文案从它的 reason/hint 推。
    pub fn from_agent(status: u16, message: impl Into<String>, agent: Value) -> Self {
        Self {
            status,
            message: message.into(),
            reason: None,
            agent: Some(Box::new(agent)),
        }
    }

    /// 平台不支持（win32）：三条路由与唤屏都干净地回 503，不去连不存在的 socket。
    pub fn unsupported() -> Self {
        Self::with_reason(503, "platform-unsupported", "platform-unsupported")
    }

    pub fn invalid_region() -> Self {
        Self::new(400, "invalid-region")
    }

    pub fn region_outside() -> Self {
        Self::new(400, "region-outside-screen")
    }

    /// 平台专有的壳外调用走错了平台要响亮地失败：静默 ENOENT 比明说难查得多。
    pub fn wrong_platform(name: &str) -> Self {
        Self::with_reason(
            500,
            format!("{name} 是 macOS 专有实现（调 sips/osascript）；Linux 走 host.captureDirect"),
            "wrong-platform-helper",
        )
    }

    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// JS `sendError` 的 `error` 字段：agent 的 reason/error 优先，其次 error.message。
/// JS 是 `agent.reason || agent.error || error.message` —— 用真值判断，空串 /
/// null / false 都要继续往后找，不是「键存在就用」。
pub fn error_field(err: &AppError) -> Value {
    if let Some(agent) = &err.agent {
        for key in ["reason", "error"] {
            if let Some(v) = agent.get(key).filter(|v| truthy(Some(v))) {
                return v.clone();
            }
        }
    }
    Value::String(err.message.clone())
}

/// JS `sendError` 喂给 `describe` 的对象（条件同样是 `agent.error || agent.reason`）。
pub fn describe_source(err: &AppError) -> Value {
    match &err.agent {
        Some(agent) if truthy(agent.get("error")) || truthy(agent.get("reason")) => {
            (**agent).clone()
        }
        _ => json!({ "error": err.message }),
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_or_falsy_agent_fields_fall_through_like_js_or() {
        // reason 是空串 → JS 的 || 继续看 error。
        let err = AppError::from_agent(
            502,
            "boom",
            json!({ "ok": false, "reason": "", "error": "user-stopped" }),
        );
        assert_eq!(error_field(&err), json!("user-stopped"));
        assert_eq!(describe_source(&err)["error"], json!("user-stopped"));

        // 两个都假 → 回落到 error.message。
        let err = AppError::from_agent(
            502,
            "boom",
            json!({ "ok": false, "reason": null, "error": "" }),
        );
        assert_eq!(error_field(&err), json!("boom"));
        assert_eq!(describe_source(&err), json!({ "error": "boom" }));

        let err = AppError::from_agent(502, "boom", json!({ "ok": false, "reason": false }));
        assert_eq!(error_field(&err), json!("boom"));
        assert_eq!(describe_source(&err), json!({ "error": "boom" }));
    }

    #[test]
    fn truthy_agent_fields_win_in_reason_error_order() {
        let err = AppError::from_agent(
            502,
            "boom",
            json!({ "ok": false, "reason": "screen-locked", "error": "other" }),
        );
        assert_eq!(error_field(&err), json!("screen-locked"));
    }
}
