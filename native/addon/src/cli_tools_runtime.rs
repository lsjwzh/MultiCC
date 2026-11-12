//! Direct native-value bridge; cache/job state is never serialized into JS.
use multicc_core::cli_tools_runtime as kernel;
use multicc_core::js::{from_serde, to_serde};
use napi::{
    bindgen_prelude::{JsValue as _, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;
use std::cell::RefCell;

#[napi]
pub struct RustCliToolsRuntime {
    state: RefCell<kernel::Runtime>,
}
#[napi]
impl RustCliToolsRuntime {
    #[napi(constructor)]
    pub fn new(env: Env, config: Unknown<'_>) -> Result<Self> {
        let value =
            unsafe { crate::js_bridge::read_value(env.raw(), config.raw(), 0, &mut Vec::new()) }?;
        Ok(Self {
            state: RefCell::new(kernel::Runtime::new(to_serde(&value))),
        })
    }
    #[napi]
    pub fn request(&self, env: Env, op: String, input: Unknown<'_>) -> Result<sys::napi_value> {
        let value =
            unsafe { crate::js_bridge::read_value(env.raw(), input.raw(), 0, &mut Vec::new()) }?;
        let output = self.state.borrow_mut().request(&op, &value);
        unsafe { crate::js_bridge::write_value(env.raw(), &output) }
    }
}
#[napi]
pub fn cli_tools_official_specs(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let value =
        unsafe { crate::js_bridge::read_value(env.raw(), input.raw(), 0, &mut Vec::new()) }?;
    let output = from_serde(&kernel::official_specs(&to_serde(&value)));
    unsafe { crate::js_bridge::write_value(env.raw(), &output) }
}
