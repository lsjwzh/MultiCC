//! 唤屏 / 解锁路由（移植 src/remote-screen-wake.js）。
//!
//! 同意值由本进程直接读两个电源开关得出（见 [`crate::power`]），再与 Agent 的
//! `unlockPassword` 组合：两个都为真才算「允许自动解锁」。
//!
//! 曾经这个值是 Node 算好、经 `x-multicc-power-consent` 头传进来的 —— 那是远控
//! 最后一处「Rust 必须靠 Node 才能工作」的依赖；头和 Node 侧的计算已一起删除。
//!
//! supported 用 features.wake，不是 profile.supported：唤屏是 macOS 专有的系统动作
//! （caffeinate -u），Linux 上 supported 是 true 但根本没有这件事可做。判成
//! supported 的话，前端会显示一个「唤起屏幕」按钮，点下去永远报 auto-unlock-disabled。

use crate::agent::agent_failed;
use crate::error::AppResult;
use crate::power::Consent;
use crate::routes::{json_response, AppState};
use axum::http::{header, HeaderValue};
use axum::response::Response;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const SESSION: &str = "remote-screen";

pub const MESSAGES: &[(&str, &str)] = &[
    (
        "auto-unlock-disabled",
        "请先在全局设置中开启“允许自动解锁”。",
    ),
    (
        "permissions-required",
        "请先在这台 Mac 上为 MultiCC Agent 开启辅助功能和屏幕录制权限。",
    ),
    ("user-stopped", "本机已按 Esc 急停，请先确认并解除急停。"),
    (
        "no-password",
        "尚未保存登录密码，请在这台 Mac 的全局设置中完成自动解锁配置。",
    ),
    (
        "password-needs-authorization",
        "请先在这台 Mac 的全局设置中完成钥匙串授权。",
    ),
    (
        "password-unreadable",
        "无法读取已保存的登录密码，请在本机检查自动解锁配置。",
    ),
    ("no-password-field", "暂未找到锁屏密码框，请稍后手动重试。"),
    ("desktop-busy", "另一个会话正在操作电脑，请稍后再试。"),
    ("busy", "正在唤起屏幕，请等待当前操作结束。"),
    (
        "platform-unsupported",
        "这台机器上的桌面 Agent 还不支持远程屏幕。",
    ),
];

const DEFAULT_FAIL_MESSAGE: &str = "未能确认屏幕已解锁，请检查本机状态后手动重试。";

pub fn message_for(code: &str) -> Option<&'static str> {
    MESSAGES
        .iter()
        .find(|(key, _)| *key == code)
        .map(|(_, text)| *text)
}

#[derive(Default)]
pub struct WakeState {
    waking: AtomicBool,
}

/// 开关 + Agent 的解锁密码一起判：`None` 表示电源设置读不出来 —— 迁移前
/// readConsent 在那种情况下会抛，整个 state() 变 503 agent-unavailable，
/// 不能折成「用户没同意」的 200（那会让用户去改一个本来没问题的开关）。
pub fn read_consent(consent: Consent, status: &Value) -> Option<bool> {
    match consent {
        Consent::Allowed => Some(status.get("unlockPassword") == Some(&Value::Bool(true))),
        Consent::Denied => Some(false),
        Consent::Unreadable => None,
    }
}

/// GET 每次都要 no-store：它反映的是此刻的锁屏 / 同意状态，缓存住就会误导前端
/// （迁移前的 Express 路由在函数第一行就设了这个头）。
fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn fail(status: u16, code: &str) -> Response {
    json_response(
        status,
        json!({ "ok": false, "error": code, "message": message_for(code).unwrap_or(DEFAULT_FAIL_MESSAGE) }),
    )
}

struct State5 {
    body: Map<String, Value>,
    reason: Option<&'static str>,
}

/// [`Consent`] 由调用方**每个请求算一次**再传下来：一次 POST 会读三次状态
/// （前、后、以及失败回退），中途用户拨了开关不该让同一个请求自相矛盾。
async fn read_state(st: &AppState, consent: Consent) -> AppResult<State5> {
    let status = st
        .agent
        .call(
            json!({ "op": "status", "session": SESSION }),
            Some(Duration::from_millis(3000)),
        )
        .await;
    if status.get("ok") != Some(&Value::Bool(true))
        || !status
            .get("screenLocked")
            .map(|v| v.is_boolean())
            .unwrap_or(false)
    {
        return Err(crate::error::AppError::new(503, "agent-unavailable"));
    }
    let enabled = read_consent(consent, &status)
        .ok_or_else(|| crate::error::AppError::new(503, "agent-unavailable"))?;
    let lease_holder = status
        .pointer("/control/leaseHolder")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let busy = lease_holder
        .map(|holder| holder != SESSION)
        .unwrap_or(false);
    let permissions = status.get("accessibility") == Some(&Value::Bool(true))
        && status.get("screenRecording") == Some(&Value::Bool(true));
    let halted = status.pointer("/control/halted") == Some(&Value::Bool(true));
    let can_wake = enabled && permissions && !busy && !halted;
    let reason = if !enabled {
        Some("auto-unlock-disabled")
    } else if !permissions {
        Some("permissions-required")
    } else if halted {
        Some("user-stopped")
    } else if busy {
        Some("desktop-busy")
    } else {
        None
    };
    let mut body = Map::new();
    body.insert("ok".into(), json!(true));
    body.insert(
        "screenLocked".into(),
        status.get("screenLocked").cloned().unwrap_or(json!(false)),
    );
    body.insert("autoUnlockEnabled".into(), json!(enabled));
    body.insert("canWake".into(), json!(can_wake));
    body.insert(
        "reason".into(),
        reason.map(|r| json!(r)).unwrap_or(Value::Null),
    );
    Ok(State5 { body, reason })
}

pub async fn get(st: &AppState) -> Response {
    if !st.host.profile.features.wake {
        return no_store(json_response(
            200,
            json!({
                "ok": false, "canWake": false, "error": "platform-unsupported",
                "reason": "platform-unsupported", "message": message_for("platform-unsupported"),
            }),
        ));
    }
    match read_state(st, st.power.consent()).await {
        Ok(state) => {
            let message = state.reason.and_then(message_for).unwrap_or("");
            let mut body = state.body;
            body.insert("message".into(), json!(message));
            no_store(json_response(200, Value::Object(body)))
        }
        Err(_) => no_store(fail(503, "agent-unavailable")),
    }
}

pub async fn post(st: &AppState) -> Response {
    if !st.host.profile.features.wake {
        return fail(409, "platform-unsupported");
    }
    // 并发点击不能重复提交解锁密码：第二次进来只回 busy。
    if st.wake.waking.swap(true, Ordering::SeqCst) {
        return fail(409, "busy");
    }
    let result = post_inner(st, st.power.consent()).await;
    st.wake.waking.store(false, Ordering::SeqCst);
    result
}

async fn post_inner(st: &AppState, consent: Consent) -> Response {
    let before = match read_state(st, consent).await {
        Ok(state) => state,
        Err(_) => return fail(503, "agent-unavailable"),
    };
    if !before
        .body
        .get("canWake")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return fail(409, before.reason.unwrap_or("auto-unlock-disabled"));
    }
    if st.host.wake_display().await.is_err() {
        return fail(503, "agent-unavailable");
    }
    if before.body.get("screenLocked") == Some(&Value::Bool(true)) {
        let unlock = st
            .agent
            .call(
                json!({ "op": "unlock", "session": SESSION }),
                Some(Duration::from_millis(20000)),
            )
            .await;
        if unlock.get("ok") != Some(&Value::Bool(true)) {
            let code = unlock
                .get("reason")
                .and_then(|v| v.as_str())
                .or_else(|| unlock.get("error").and_then(|v| v.as_str()))
                .unwrap_or("unlock-failed")
                .to_string();
            return fail(409, &code);
        }
    }
    let after = match read_state(st, consent).await {
        Ok(state) => state,
        Err(_) => return fail(503, "agent-unavailable"),
    };
    if after.body.get("screenLocked") == Some(&Value::Bool(true)) {
        return fail(409, "still-locked");
    }
    st.screen.invalidate();
    let mut body = after.body;
    body.insert("message".into(), json!("屏幕已唤起，正在恢复画面。"));
    json_response(200, Value::Object(body))
}

/// 供测试与其他模块复用：Agent 是否判失败（`ok:false` / null）。
pub fn failed(reply: &Value) -> bool {
    agent_failed(reply)
}
