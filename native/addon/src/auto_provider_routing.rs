//! napi wrappers for Auto Provider difficulty routing.
//!
//! The decisions and the verdict store live in
//! `multicc_core::auto_provider_routing`; this file marshals values and owns
//! the per-process store instance. The Jev call, the single-flight promise and
//! the host wiring stay in `src/chat/auto-provider-routing.js`.

use multicc_core::auto_provider_routing as kernel;
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

#[napi]
pub fn auto_provider_text_hash(env: Env, text: Unknown<'_>) -> Result<String> {
    let text = data(env, text)?;
    Ok(kernel::text_hash(Some(&text)))
}

#[napi]
pub fn auto_provider_unknown_tier(
    env: Env,
    routing: Unknown<'_>,
    verdict: Unknown<'_>,
) -> Result<String> {
    let routing = data(env, routing)?;
    let verdict = data(env, verdict)?;
    let answer = kernel::unknown_tier(Some(&routing), Some(&verdict));
    serde_json::to_string(&answer).map_err(|error| reason(error.to_string()))
}

#[napi]
pub fn auto_provider_resolve_tier(env: Env, request: Unknown<'_>) -> Result<String> {
    let request = data(env, request)?;
    let answer = kernel::resolve_tier(&request).unwrap_or(Value::Null);
    serde_json::to_string(&answer).map_err(|error| reason(error.to_string()))
}

/// The store's own defaults, so JavaScript never restates them.
#[napi]
pub fn auto_provider_routing_defaults() -> Result<String> {
    Ok(format!(
        "{{\"defaultTtlMs\":{},\"maxEntries\":{}}}",
        kernel::DEFAULT_TTL_MS,
        kernel::MAX_ENTRIES
    ))
}

/// One process-wide verdict store. The caller owns it (one per runtime) and
/// passes the clock, so the kernel never reads time itself.
#[napi]
pub struct RustAutoProviderRouting {
    state: RefCell<kernel::Store>,
}

#[napi]
impl RustAutoProviderRouting {
    #[napi(constructor)]
    pub fn new(env: Env, options: Unknown<'_>) -> Result<Self> {
        let options = data(env, options)?;
        let number = |key: &str| options.get(key).map(js_to_number);
        Ok(Self {
            state: RefCell::new(kernel::Store::new(number("ttlMs"), number("maxEntries"))),
        })
    }

    /// `remember(sessionId, hash, verdict)`.
    #[napi]
    pub fn remember(&self, env: Env, request: Unknown<'_>) -> Result<()> {
        let request = data(env, request)?;
        let session_id = request.get("sessionId").map(js_string).unwrap_or_default();
        let hash = request.get("hash").map(js_string).unwrap_or_default();
        let now = request.get("now").map(js_to_number).unwrap_or(f64::NAN);
        let verdict = request.get("verdict").cloned().unwrap_or(Value::Null);
        self.state
            .borrow_mut()
            .remember(&session_id, &hash, verdict, now);
        Ok(())
    }

    /// `consume({ sessionId, text })` — the verdict as JSON, or `null`.
    #[napi]
    pub fn consume(&self, env: Env, request: Unknown<'_>) -> Result<String> {
        let request = data(env, request)?;
        let session_id = request.get("sessionId").map(js_string).unwrap_or_default();
        let now = request.get("now").map(js_to_number).unwrap_or(f64::NAN);
        let answer = self
            .state
            .borrow_mut()
            .consume(&session_id, request.get("text"), now);
        serde_json::to_string(&answer.unwrap_or(Value::Null))
            .map_err(|error| reason(error.to_string()))
    }

    #[napi]
    pub fn clear_session(&self, session_id: String) {
        self.state.borrow_mut().clear_session(&session_id);
    }

    #[napi(getter)]
    pub fn size(&self) -> u32 {
        self.state.borrow().size() as u32
    }

    /// The effective entries cap, for the JavaScript single-flight map.
    #[napi(getter)]
    pub fn max_entries(&self) -> f64 {
        self.state.borrow().max_entries()
    }
}
