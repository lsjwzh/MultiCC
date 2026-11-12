//! Direct-value bridge for upstream discovery; HTTP runs off the JS thread.
use multicc_core::{cli_upstream_version as kernel, js::JsValue};
use napi::{
    bindgen_prelude::{JsValue as _, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;
use std::cell::RefCell;

fn read(env: Env, input: Unknown<'_>) -> Result<JsValue> {
    unsafe { crate::js_bridge::read_value(env.raw(), input.raw(), 0, &mut Vec::new()) }
}
#[napi]
pub fn cli_upstream_version_request(
    env: Env,
    op: String,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let output = kernel::request(&op, &read(env, input)?);
    unsafe { crate::js_bridge::write_value(env.raw(), &output) }
}
#[napi]
pub struct RustCliUpstreamFetch {
    inner: RefCell<kernel::Fetch>,
}
#[napi]
impl RustCliUpstreamFetch {
    #[napi(constructor)]
    pub fn new(env: Env, input: Unknown<'_>) -> Result<Self> {
        Ok(Self {
            inner: RefCell::new(kernel::Fetch::new(&read(env, input)?)),
        })
    }
    #[napi]
    pub fn request(&self, env: Env, op: String, input: Unknown<'_>) -> Result<sys::napi_value> {
        let value = read(env, input)?;
        let output = self.inner.borrow_mut().input(&op, &value);
        unsafe { crate::js_bridge::write_value(env.raw(), &output) }
    }
}
#[napi]
pub fn cli_upstream_version_fetch(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input = read(env, input)?;
    // Network waits use NAPI's Tokio runtime, not libuv's limited blocking pool.
    let promise = env.spawn_future_with_callback(
        async move { Ok(kernel::fetch(&input).await) },
        |env, output| unsafe { crate::js_bridge::write_value(env.raw(), &output) },
    )?;
    Ok(promise.raw())
}
