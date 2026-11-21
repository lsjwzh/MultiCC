use crate::{
    js_bridge::{read_value, write_value},
    js_live::LiveValue as L,
};
use multicc_core::{codex_background::Background, js::JsValue as V};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::cell::RefCell;

#[napi]
pub struct RustCodexBackground {
    state: RefCell<Background>,
}
#[napi]
impl RustCodexBackground {
    #[napi(constructor)]
    pub fn new(env: Env, main: Unknown<'_>, throttle: f64, attach: bool) -> Result<Self> {
        let main = L::new(&env, main);
        let main = unsafe { read_value(main.env(), main.raw(), 0, &mut Vec::new()) }?;
        Ok(Self {
            state: RefCell::new(Background::new(main, throttle, attach)),
        })
    }
    #[napi]
    pub fn call(
        &self,
        env: Env,
        op: String,
        value: Unknown<'_>,
        index: f64,
        now: f64,
        failed: bool,
    ) -> Result<sys::napi_value> {
        let anchor = L::new(&env, value);
        // Fully read the host value before borrowing state: getters may reenter.
        let value = unsafe { read_value(anchor.env(), anchor.raw(), 0, &mut Vec::new()) }?;
        let (result, effects) = {
            let mut state = self.state.borrow_mut();
            let result = match op.as_str() {
                "consume" => state.consume(&value, now),
                "timer" => {
                    state.fire(index as u64, now);
                    V::Undefined
                }
                "attached" => {
                    state.attached(index as usize, &value, failed, now);
                    V::Undefined
                }
                "main" => {
                    state.set_main(value);
                    V::Undefined
                }
                "dispose" => {
                    state.dispose();
                    V::Undefined
                }
                "count" => V::Number(state.active_count() as f64),
                _ => {
                    return Err(napi::Error::from_reason(
                        "unknown_codex_background_operation",
                    ))
                }
            };
            (result, state.effects())
        };
        let output = V::object(vec![("result", result), ("effects", V::Array(effects))]);
        unsafe { write_value(anchor.env(), &output) }
    }
}
#[napi]
pub fn codex_background_text(
    env: Env,
    op: String,
    value: Unknown<'_>,
    limit: Unknown<'_>,
) -> Result<sys::napi_value> {
    let anchor = L::new(&env, value);
    let value = if op == "safe" {
        let value = if anchor.truthy()? {
            anchor
        } else {
            anchor.from_value(&V::from(""))?
        };
        V::String(
            value
                .global()?
                .get(c"String")?
                .call_plain(&[value])?
                .coerce_string()?,
        )
    } else {
        unsafe { read_value(anchor.env(), anchor.raw(), 0, &mut Vec::new()) }?
    };
    let output = match op.as_str() {
        "safe" => {
            let text = multicc_core::codex_background::safe_text(&value, usize::MAX);
            let limit = L::new(&env, limit).number()?;
            let end = if limit < 0.0 {
                text.len().saturating_sub((-limit).trunc() as usize)
            } else {
                limit as usize
            };
            text.truncate_units(end)
        }
        "command" => multicc_core::codex_background::unwrap_command(&value),
        "detail" => multicc_core::codex_background::tool_detail(&value),
        _ => {
            return Err(napi::Error::from_reason(
                "unknown_codex_background_text_operation",
            ))
        }
    };
    unsafe { write_value(anchor.env(), &V::String(output)) }
}
