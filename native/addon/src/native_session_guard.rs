//! napi surface for the Rust native-session size guards.
//!
//! Two classes (`RustCodexRolloutGuard`, `RustNativeSessionGuard`) own the
//! per-guard sweep throttle state, plus two default-value functions. Every
//! method returns `{ result, logs }`; the facade in `src/chat/*-guard.js`
//! replays `logs` through the injected logger. Inputs are read through the
//! lossless bridge, so `undefined`/`null`/lone surrogates survive.
use multicc_core::js::JsValue;
use multicc_core::native_session_guard as core;
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;
use std::sync::Mutex;

fn read(env: Env, value: Unknown<'_>) -> Result<JsValue> {
    unsafe { crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new()) }
}

fn write(env: Env, value: &JsValue) -> Result<sys::napi_value> {
    unsafe { crate::js_bridge::write_value(env.raw(), value) }
}

#[napi]
pub fn codex_rollout_guard_defaults(env: Env) -> Result<sys::napi_value> {
    write(env, &core::codex_defaults_value())
}

#[napi]
pub fn native_session_guard_defaults(env: Env) -> Result<sys::napi_value> {
    write(env, &core::native_defaults_value())
}

#[napi]
pub struct RustCodexRolloutGuard {
    inner: Mutex<core::CodexRolloutGuard>,
}

#[napi]
impl RustCodexRolloutGuard {
    #[napi(constructor)]
    pub fn new(env: Env, options: Unknown<'_>) -> Result<Self> {
        let options = core::CodexOptions::from_js(&read(env, options)?);
        Ok(Self {
            inner: Mutex::new(core::CodexRolloutGuard::new(options)),
        })
    }

    #[napi(getter)]
    pub fn max_bytes(&self) -> Result<f64> {
        Ok(self.inner.lock().map_err(|_| poisoned())?.max_bytes())
    }

    #[napi(getter)]
    pub fn archive_ttl_ms(&self) -> Result<f64> {
        Ok(self.inner.lock().map_err(|_| poisoned())?.archive_ttl_ms())
    }

    #[napi]
    pub fn enforce(
        &self,
        env: Env,
        record: Unknown<'_>,
        force: bool,
        prepared: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let record = read(env, record)?;
        let prepared = read(env, prepared)?;
        let now_ms = core::system_now_ms();
        let mut guard = self.inner.lock().map_err(|_| poisoned())?;
        let outcome = guard.enforce(&record, force, &prepared, now_ms);
        write(env, &core::outcome_value(&outcome))
    }

    #[napi]
    pub fn sweep(&self, env: Env, force: bool, now_ms: Option<f64>) -> Result<sys::napi_value> {
        let now_ms = now_ms.unwrap_or_else(core::system_now_ms);
        let mut guard = self.inner.lock().map_err(|_| poisoned())?;
        let outcome = guard.sweep(force, now_ms);
        write(env, &core::outcome_value(&outcome))
    }
}

#[napi]
pub struct RustNativeSessionGuard {
    inner: Mutex<core::NativeSessionGuard>,
}

#[napi]
impl RustNativeSessionGuard {
    #[napi(constructor)]
    pub fn new(env: Env, options: Unknown<'_>) -> Result<Self> {
        let options = core::NativeOptions::from_js(&read(env, options)?);
        Ok(Self {
            inner: Mutex::new(core::NativeSessionGuard::new(options)),
        })
    }

    #[napi(getter)]
    pub fn max_bytes(&self) -> Result<f64> {
        Ok(self.inner.lock().map_err(|_| poisoned())?.max_bytes())
    }

    #[napi(getter)]
    pub fn archive_ttl_ms(&self) -> Result<f64> {
        Ok(self.inner.lock().map_err(|_| poisoned())?.archive_ttl_ms())
    }

    #[napi]
    pub fn handles(&self, env: Env, cli: Unknown<'_>) -> Result<bool> {
        let cli = read(env, cli)?;
        Ok(self.inner.lock().map_err(|_| poisoned())?.handles(&cli))
    }

    #[napi]
    pub fn store_truthy(&self, env: Env, cli: Unknown<'_>) -> Result<bool> {
        let cli = read(env, cli)?;
        Ok(self
            .inner
            .lock()
            .map_err(|_| poisoned())?
            .store_truthy(&cli))
    }

    #[napi]
    pub fn enforce(
        &self,
        env: Env,
        record: Unknown<'_>,
        force: bool,
        homes: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let record = read(env, record)?;
        let homes = read(env, homes)?;
        let now_ms = core::system_now_ms();
        let mut guard = self.inner.lock().map_err(|_| poisoned())?;
        let outcome = guard.enforce(&record, force, &homes, now_ms);
        write(env, &core::outcome_value(&outcome))
    }

    #[napi]
    pub fn sweep(&self, env: Env, force: bool, now_ms: Option<f64>) -> Result<sys::napi_value> {
        let now_ms = now_ms.unwrap_or_else(core::system_now_ms);
        let mut guard = self.inner.lock().map_err(|_| poisoned())?;
        let outcome = guard.sweep(force, now_ms);
        write(env, &core::outcome_value(&outcome))
    }
}

fn poisoned() -> napi::Error {
    napi::Error::from_reason("native_session_guard lock poisoned".to_string())
}
