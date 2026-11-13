//! In-memory quota polling admission; JS retains only transport promises.
use multicc_core::usage_limit_poll::PollState;
use napi::{
    bindgen_prelude::{JsValue as _, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;
use std::cell::RefCell;

#[napi]
pub struct RustUsageLimitPoller {
    state: RefCell<PollState>,
}

impl Default for RustUsageLimitPoller {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl RustUsageLimitPoller {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            state: RefCell::new(PollState::default()),
        }
    }

    #[napi]
    pub fn request(&self, env: Env, op: String, input: Unknown<'_>) -> Result<sys::napi_value> {
        let raw = env.raw();
        let input = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
        let result = self.state.borrow_mut().request(&op, &input);
        unsafe { crate::js_bridge::write_value(raw, &result) }
    }
}
