//! napi wrappers for the Auto Provider turn runtime.
//!
//! The decisions live in `multicc_core::auto_provider_runtime`; this file
//! marshals the pool snapshot the JavaScript host assembled (each line's lane,
//! enabled flag, limit state and limit summary) and hands back the answer.

use multicc_core::auto_provider_runtime as kernel;
use multicc_core::js::serde::{js_string, js_to_number, to_serde};
use multicc_core::js::JsValue as V;
use napi::{
    bindgen_prelude::{JsValue as _, Unknown},
    Env, Result,
};
use napi_derive::napi;
use serde_json::Value;
use std::cell::RefCell;

fn read(env: Env, value: Unknown<'_>) -> Result<V> {
    unsafe { crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new()) }
}

/// The JS value as ordinary JSON data. `undefined` arrives as `null`, which is
/// what every field read here treats it as.
fn data(env: Env, value: Unknown<'_>) -> Result<Value> {
    Ok(to_serde(&read(env, value)?))
}

fn reason(error: String) -> napi::Error {
    napi::Error::from_reason(error)
}

/// `retryNotBefore({ cli, now, candidates })` — the epoch-ms as JSON, or
/// `null`.
#[napi]
pub fn auto_provider_retry_not_before(env: Env, request: Unknown<'_>) -> Result<String> {
    let request = data(env, request)?;
    let candidates = request
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let cli = request.get("cli").map(js_string).unwrap_or_default();
    let now = request.get("now").map(js_to_number).unwrap_or(f64::NAN);
    match kernel::retry_not_before(&candidates, &cli, now) {
        Some(at) => {
            serde_json::to_string(&Value::from(at)).map_err(|error| reason(error.to_string()))
        }
        None => Ok("null".to_string()),
    }
}

fn answer(value: Value) -> Result<String> {
    serde_json::to_string(&value).map_err(|error| reason(error.to_string()))
}

/// One per `createAutoProviderRuntime` call. The per-session route state and
/// the turn closures live here; JavaScript keeps only the host facts it must
/// look up (providers catalog, limit cache, price table, clocks, emit/logger).
#[napi]
pub struct RustAutoProviderRuntime {
    state: RefCell<kernel::Runtime>,
}

impl Default for RustAutoProviderRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl RustAutoProviderRuntime {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            state: RefCell::new(kernel::Runtime::default()),
        }
    }

    /// The `syncSelection` first half: reset the session when its policy key
    /// changed, and say which host lookup the second half needs.
    #[napi]
    pub fn sync_prepare(&self, env: Env, request: Unknown<'_>) -> Result<String> {
        let request = data(env, request)?;
        answer(self.state.borrow_mut().sync_prepare(&request))
    }

    /// The `seedFromPool` half, once `lastGoodRoute` has answered.
    #[napi]
    pub fn sync_finish_seed(&self, env: Env, request: Unknown<'_>) -> Result<String> {
        let request = data(env, request)?;
        answer(self.state.borrow_mut().sync_finish_seed(&request))
    }

    /// The legacy unsigned-route match, once the lane catalog has answered.
    #[napi]
    pub fn sync_finish_legacy(&self, env: Env, request: Unknown<'_>) -> Result<String> {
        let request = data(env, request)?;
        answer(self.state.borrow_mut().sync_finish_legacy(&request))
    }

    /// `planTurn` — the lane-switch decision and its narrated event.
    #[napi]
    pub fn plan_turn(&self, env: Env, request: Unknown<'_>) -> Result<String> {
        let request = data(env, request)?;
        answer(self.state.borrow_mut().plan_turn(&request))
    }

    /// `beginTurn` — pin the turn's pool, return its handle.
    #[napi]
    pub fn begin_turn(&self, env: Env, request: Unknown<'_>) -> Result<String> {
        let request = data(env, request)?;
        answer(self.state.borrow_mut().begin_turn(&request))
    }

    /// `turn.initial()`.
    #[napi]
    pub fn turn_initial(&self, handle: f64) -> Result<String> {
        answer(self.state.borrow_mut().turn_initial(handle as u64))
    }

    /// `turn.failover(decision, attempt)`.
    #[napi]
    pub fn turn_failover(&self, env: Env, request: Unknown<'_>) -> Result<String> {
        let request = data(env, request)?;
        answer(self.state.borrow_mut().turn_failover(&request))
    }

    /// `turn.prepareHandoff(decision, attempt)`.
    #[napi]
    pub fn turn_prepare_handoff(&self, env: Env, request: Unknown<'_>) -> Result<String> {
        let request = data(env, request)?;
        answer(self.state.borrow_mut().turn_prepare_handoff(&request))
    }

    /// `turn.recordSuccess(attempt)` — returns `undefined`.
    #[napi]
    pub fn turn_record_success(&self, env: Env, request: Unknown<'_>) -> Result<String> {
        let request = data(env, request)?;
        answer(self.state.borrow_mut().turn_record_success(&request))
    }

    /// `snapshot(sessionId)`.
    #[napi]
    pub fn snapshot(&self, session_id: String) -> Result<String> {
        answer(self.state.borrow().snapshot(&session_id))
    }

    /// `clearSession(sessionId)`.
    #[napi]
    pub fn clear_session(&self, session_id: String) {
        self.state.borrow_mut().clear_session(&session_id);
    }
}
