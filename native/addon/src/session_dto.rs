//! UTF-16 text port for the public session DTO.
use crate::js_live::LiveValue;
use multicc_core::{js::JsValue, session_admin::redact_session_text};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn session_dto_redact_text(env: Env, text: Unknown<'_>) -> Result<sys::napi_value> {
    let value = LiveValue::new(&env, text);
    let text = value
        .string()?
        .ok_or_else(|| value.type_error("expected session text"))?;
    Ok(value
        .from_value(&JsValue::String(redact_session_text(&text)))?
        .raw())
}
