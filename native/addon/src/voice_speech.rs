//! The compatibility host supplies ECMAScript string coercion and iteration.
//! Values crossing this port are strings, retained as UTF-16 code units.
use crate::js_live::LiveValue;
use multicc_core::{js::JsValue, voice_speech};
use napi::{bindgen_prelude::Unknown, sys, Env, Error, Result};
use napi_derive::napi;

#[napi]
pub fn voice_speech_text(
    env: Env,
    raw: Unknown<'_>,
    private_values: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw = LiveValue::new(&env, raw);
    let text = raw
        .string()?
        .ok_or_else(|| Error::from_reason("expected speech text"))?;
    let values = LiveValue::new(&env, private_values);
    let result = if values.undefined()? {
        voice_speech::strip_truncated(&text)
    } else {
        let mut length = 0;
        napi::check_status!(unsafe {
            sys::napi_get_array_length(env.raw(), values.raw(), &mut length)
        })?;
        let private = (0..length)
            .map(|index| {
                values
                    .element(index)?
                    .string()?
                    .ok_or_else(|| Error::from_reason("expected private text"))
            })
            .collect::<Result<Vec<_>>>()?;
        voice_speech::sanitize(&text, &private)
    };
    Ok(raw.from_value(&JsValue::String(result))?.raw())
}
