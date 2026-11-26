//! Fail closed when a managed Claude provider cannot use the local proxy.
//! Live values preserve the legacy JavaScript getters and coercion order.
use crate::{
    js_live::LiveValue,
    provider_terminal_routes::{clean, object, property},
};
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ptr;

pub(crate) fn assign_error_code<'a>(error: LiveValue<'a>, code: LiveValue<'a>) -> Result<()> {
    // Match strict assignment even for a patched Error constructor returning a
    // proxy or an object with a non-writable code property.
    let source = error.from_value(&JsValue::string(
        "(function(target, value) { 'use strict'; target.code = value; })",
    ))?;
    let mut function = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_run_script(error.env(), source.raw(), &mut function) })?;
    LiveValue::from_raw(error.env(), function).call_plain(&[error, code])?;
    Ok(())
}

#[napi]
pub fn claude_proxy_env_required(env: Env, options: Unknown<'_>) -> Result<bool> {
    let mut reader = None;
    let options = LiveValue::new(&env, options);
    let options = if options.undefined()? {
        object(options)?
    } else {
        options
    };
    if options.nullish()? {
        return Err(options.type_error("Cannot read properties of null (reading 'providerId')"));
    }
    let id = property(&mut reader, options, c"providerId")?;
    let id = clean(&mut reader, id)?;
    Ok(id.truthy()? && !id.is_string("_default_")?)
}

#[napi]
pub fn assert_claude_proxy_env_applied(env: Env, options: Unknown<'_>) -> Result<bool> {
    let mut reader = None;
    let options = LiveValue::new(&env, options);
    let options = if options.undefined()? {
        object(options)?
    } else {
        options
    };
    if options.nullish()? {
        return Err(options.type_error("Cannot destructure property 'required' of '(intermediate value)(intermediate value)(intermediate value)' as it is null."));
    }
    // Destructuring reads both properties, in order, even when `required` is false.
    let required = property(&mut reader, options, c"required")?;
    let applied = property(&mut reader, options, c"applied")?;
    ensure_applied(options, required.is_true()?, applied)
}

pub(crate) fn ensure_applied(
    options: LiveValue<'_>,
    required: bool,
    applied: LiveValue<'_>,
) -> Result<bool> {
    if required && !applied.is_true()? {
        let message = options.from_value(&JsValue::string("Claude managed provider route could not be materialized; refusing to spawn a direct connection to the provider endpoint"))?;
        let error = options.global()?.get(c"Error")?.construct(&[message])?;
        assign_error_code(
            error,
            options.from_value(&JsValue::string("CLAUDE_PROXY_ENV_REQUIRED"))?,
        )?;
        return Err(error.throw_error());
    }
    applied.is_true()
}
