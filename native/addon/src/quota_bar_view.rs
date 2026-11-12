//! Direct native-value quota renderer bridge.
use napi::{
    bindgen_prelude::{JsValue as _, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;
#[napi]
pub fn quota_bar_view_request(env: Env, op: String, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input =
        unsafe { crate::js_bridge::read_value(env.raw(), input.raw(), 0, &mut Vec::new()) }?;
    let output = multicc_core::quota_bar_view::request(&op, &input);
    unsafe { crate::js_bridge::write_value(env.raw(), &output) }
}
