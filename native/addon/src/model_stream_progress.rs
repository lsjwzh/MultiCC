use crate::js_live::LiveValue as L;
use multicc_core::model_stream_progress::ModelStreamProgress;
use napi::bindgen_prelude::{
    Buffer, FromNapiValue, JsValue as _, ToNapiValue, Unknown, ValidateNapiValue,
};
use napi::{sys, Env, Result};
use napi_derive::napi;
use std::cell::RefCell;

/// The compatibility host still supplies Buffer.from, but reader state and
/// callback lifetime belong to Rust. No V8 values are retained by the closure.
#[napi]
pub fn create_model_stream_progress(env: Env) -> Result<sys::napi_value> {
    let state = RefCell::new(ModelStreamProgress::default());
    let callback = env.create_function_from_closure::<Unknown<'_>, bool, _>(
        "modelStreamProgress",
        move |ctx| {
            let value = if ctx.length() == 0 {
                ().into_unknown(ctx.env)?
            } else {
                ctx.get::<Unknown<'_>>(0)?
            };
            let value = L::new(ctx.env, value);
            if let Some(text) = value.string()? {
                return Ok(state.borrow_mut().feed_text(&text.to_string_lossy()));
            }
            let buffer = value.global()?.get(c"Buffer")?;
            let bytes = buffer.get(c"from")?.call(buffer, &[value])?;
            // Conversion may call user valueOf/getters and reenter the reader.
            // Borrow state only after it completes, just like the old wrapper.
            unsafe { Buffer::validate(ctx.env.raw(), bytes.raw()) }?;
            let bytes = unsafe { Buffer::from_napi_value(ctx.env.raw(), bytes.raw()) }?;
            Ok(state.borrow_mut().feed_bytes(bytes.as_ref()))
        },
    )?;
    Ok(callback.raw())
}

#[napi]
pub struct RustModelStreamProgress {
    inner: ModelStreamProgress,
}
impl Default for RustModelStreamProgress {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl RustModelStreamProgress {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: ModelStreamProgress::default(),
        }
    }
    #[napi]
    pub fn feed(&mut self, bytes: Buffer) -> bool {
        self.inner.feed_bytes(bytes.as_ref())
    }
    #[napi]
    pub fn feed_text(&mut self, text: String) -> bool {
        self.inner.feed_text(&text)
    }
}
