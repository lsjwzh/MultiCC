//! Only napi marshalling; the policy and per-host cache live in core.
use multicc_core::quota_guard::{self, Guard};
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn quota_guard_request_value(
    env: Env,
    op: String,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw = env.raw();
    let input = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let result = quota_guard::request(&op, &input).map_err(napi::Error::from_reason)?;
    unsafe { crate::js_bridge::write_value(raw, &result) }
}

#[napi]
pub struct RustQuotaGuard {
    inner: Guard,
}

#[napi]
impl RustQuotaGuard {
    #[napi(constructor)]
    pub fn new(file: Option<String>) -> Self {
        Self {
            inner: Guard::new(file.filter(|file| !file.is_empty()).map(Into::into)),
        }
    }

    #[napi]
    pub fn config(&mut self, env: Env, source: Unknown<'_>, now: f64) -> Result<sys::napi_value> {
        let raw = env.raw();
        let source =
            unsafe { crate::js_bridge::read_value(raw, source.raw(), 0, &mut Vec::new()) }?;
        let result = self.inner.config(&source, now);
        unsafe { crate::js_bridge::write_value(raw, &result) }
    }

    #[napi]
    pub fn should_refresh(&mut self, id: String, now: f64) -> bool {
        self.inner.should_refresh(&id, now)
    }
}
