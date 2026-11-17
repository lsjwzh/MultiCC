//! Terminal capabilities retain the host's live session objects and callbacks.
//! The validated port captures them once; no native borrow or retained N-API
//! reference crosses a host callback.
use crate::js_live::LiveValue;
use multicc_core::{auth_security, js::JsValue};
use napi::{bindgen_prelude::Unknown, sys, Env, Error, Result};
use napi_derive::napi;
use std::{ffi::CStr, ptr};

pub(crate) fn object<'a>(anchor: LiveValue<'a>) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::Object(vec![]))
}

fn null<'a>(anchor: LiveValue<'a>) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::Null)
}

/// N-API property reads require an object, but a strict JS accessor on a
/// primitive's prototype observes the primitive as its receiver. Compile one
/// fixed host primitive per command, only if such a read is actually needed.
pub(crate) fn property<'a>(
    reader: &mut Option<LiveValue<'a>>,
    value: LiveValue<'a>,
    key: &CStr,
) -> Result<LiveValue<'a>> {
    if matches!(
        value.kind()?,
        sys::ValueType::napi_object | sys::ValueType::napi_function
    ) {
        return value.get(key);
    }
    let function = if let Some(function) = *reader {
        function
    } else {
        let source = value.from_value(&JsValue::string(
            "(function(target, key) { 'use strict'; return target[key]; })",
        ))?;
        let mut function = ptr::null_mut();
        napi::check_status!(unsafe {
            sys::napi_run_script(value.env(), source.raw(), &mut function)
        })?;
        let function = LiveValue::from_raw(value.env(), function);
        *reader = Some(function);
        function
    };
    let key = value.from_value(&JsValue::string(key.to_str().expect("static property")))?;
    function.call_plain(&[value, key])
}

pub(crate) fn clean<'a>(
    reader: &mut Option<LiveValue<'a>>,
    value: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    if value.nullish()? {
        return value.from_value(&JsValue::string(""));
    }
    let string = value.global()?.get(c"String")?;
    if string.kind()? != sys::ValueType::napi_function {
        return Err(value.type_error("String is not a function"));
    }
    let text = string.call_plain(&[value])?;
    let trim = property(reader, text, c"trim")?;
    if trim.kind()? != sys::ValueType::napi_function {
        return Err(value.type_error("String(...).trim is not a function"));
    }
    trim.call(text, &[])
}

/// `value && value.name`, retaining even falsy primitive values for `clean`.
fn and_property<'a>(
    reader: &mut Option<LiveValue<'a>>,
    value: LiveValue<'a>,
    key: &CStr,
) -> Result<LiveValue<'a>> {
    if value.truthy()? {
        property(reader, value, key)
    } else {
        Ok(value)
    }
}

/// Preserve strict JS assignment on a live host record, including proxy and
/// readonly-property TypeError identity/text. This static script is only the
/// host assignment primitive: it interpolates no inputs, retains no references
/// and reads no mutable global. A host that disallows script compilation gets
/// the original compilation error before any write or persistence. Remove this
/// bridge when session record fields themselves are owned by Rust.
fn assign_token<'a>(session: LiveValue<'a>, token: LiveValue<'a>) -> Result<()> {
    let source = session.from_value(&JsValue::string(
        "(function(target, value) { 'use strict'; target.proxyRouteToken = value; })",
    ))?;
    let mut function = ptr::null_mut();
    napi::check_status!(unsafe {
        sys::napi_run_script(session.env(), source.raw(), &mut function)
    })?;
    LiveValue::from_raw(session.env(), function).call_plain(&[session, token])?;
    Ok(())
}

/// Capture the same constructor arguments that the former JS factory closed
/// over. Getters run in destructuring order before any validity check.
#[napi]
pub fn provider_terminal_validate(env: Env, port: Unknown<'_>) -> Result<sys::napi_value> {
    let mut reader = None;
    let input = LiveValue::new(&env, port);
    let input = if input.undefined()? {
        object(input)?
    } else if input.nullish()? {
        return Err(input.type_error("Cannot destructure property 'persistedSessions' of '(intermediate value)(intermediate value)(intermediate value)' as it is null."));
    } else {
        input
    };
    let sessions = property(&mut reader, input, c"persistedSessions")?;
    let persist = property(&mut reader, input, c"persist")?;
    let encode = property(&mut reader, input, c"encode")?;
    let mint = property(&mut reader, input, c"mint")?;
    if !sessions.truthy()?
        || property(&mut reader, sessions, c"get")?.kind()? != sys::ValueType::napi_function
    {
        return Err(input.type_error("[terminal-route] a session store is required"));
    }
    if encode.kind()? != sys::ValueType::napi_function {
        return Err(input.type_error("[terminal-route] a route encoder is required"));
    }
    let captured = object(input)?;
    captured.set(c"persistedSessions", sessions)?;
    captured.set(c"persist", persist)?;
    captured.set(c"encode", encode)?;
    captured.set(c"mint", mint)?;
    Ok(captured.freeze()?.raw())
}

/// Mint only when no capability is already persisted. The host port contains
/// a test-only minter when supplied; production uses the OS CSPRNG directly.
#[napi]
pub fn provider_terminal_session_segment(
    env: Env,
    session: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    let mut reader = None;
    let session = LiveValue::new(&env, session);
    let port = LiveValue::new(&env, port);
    let id = and_property(&mut reader, session, c"id")?;
    let id = clean(&mut reader, id)?;
    if !id.truthy()? {
        return Ok(id.raw());
    }
    let provider = and_property(&mut reader, session, c"provider")?;
    if !clean(&mut reader, provider)?.truthy()? {
        return Ok(id.raw());
    }
    let token = property(&mut reader, session, c"proxyRouteToken")?;
    let mut token = clean(&mut reader, token)?;
    if !token.truthy()? {
        let mint = port.get(c"mint")?;
        token = if mint.kind()? == sys::ValueType::napi_function {
            mint.call_plain(&[])?
        } else {
            let random = auth_security::random_base64url(18).map_err(Error::from_reason)?;
            port.from_value(&JsValue::string(&random))?
        };
        assign_token(session, token)?;
        let persist = port.get(c"persist")?;
        if persist.kind()? == sys::ValueType::napi_function {
            persist.call_plain(&[
                port.from_value(&JsValue::string("runtime.terminal-route-token"))?
            ])?;
        }
    }
    let encode = port.get(c"encode")?;
    Ok(encode.call_plain(&[id, token])?.raw())
}

/// Resolve against the caller's current Map-shaped facade, not a cached copy:
/// removing a session therefore revokes the capability immediately.
#[napi]
pub fn provider_terminal_lookup(
    env: Env,
    session_id: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    let mut reader = None;
    let session_id = LiveValue::new(&env, session_id);
    let port = LiveValue::new(&env, port);
    let sessions = port.get(c"persistedSessions")?;
    // In `sessions.get(clean(id))`, property lookup precedes argument cleaning.
    let get = property(&mut reader, sessions, c"get")?;
    let id = clean(&mut reader, session_id)?;
    if get.kind()? != sys::ValueType::napi_function {
        return Err(port.type_error("persistedSessions.get is not a function"));
    }
    let record = get.call(sessions, &[id])?;
    if !record.truthy()? || !property(&mut reader, record, c"kind")?.is_string("terminal")? {
        return Ok(null(port)?.raw());
    }
    let provider = property(&mut reader, record, c"provider")?;
    let provider = clean(&mut reader, provider)?;
    let token = property(&mut reader, record, c"proxyRouteToken")?;
    let token = clean(&mut reader, token)?;
    if !provider.truthy()? || !token.truthy()? {
        return Ok(null(port)?.raw());
    }
    // `record.subagent && record.subagent.providerId` reads the first getter
    // twice when truthy; an accessor may change or throw on the second read.
    let subagent = property(&mut reader, record, c"subagent")?;
    let sub = if subagent.truthy()? {
        let subagent = property(&mut reader, record, c"subagent")?;
        property(&mut reader, subagent, c"providerId")?
    } else {
        subagent
    };
    let sub = clean(&mut reader, sub)?;

    // The outer member expression is evaluated before its object argument;
    // capture that exact receiver/function before evaluating the inner freeze.
    let outer_receiver = port.global()?.get(c"Object")?;
    let outer_freeze = property(&mut reader, outer_receiver, c"freeze")?;
    let result = object(port)?;
    result.set(c"token", token)?;
    result.set(c"providerId", provider)?;
    let inner_receiver = port.global()?.get(c"Object")?;
    let inner_freeze = property(&mut reader, inner_receiver, c"freeze")?;
    let allowed = port.from_value(&JsValue::Array(vec![]))?;
    allowed.define_key(port.from_value(&JsValue::string("0"))?, provider)?;
    if sub.truthy()? && !sub.equals(provider)? {
        allowed.define_key(port.from_value(&JsValue::string("1"))?, sub)?;
    }
    if inner_freeze.kind()? != sys::ValueType::napi_function {
        return Err(port.type_error("Object.freeze is not a function"));
    }
    let allowed = inner_freeze.call(inner_receiver, &[allowed])?;
    result.set(c"allowedSubProviderIds", allowed)?;
    if outer_freeze.kind()? != sys::ValueType::napi_function {
        return Err(port.type_error("Object.freeze is not a function"));
    }
    Ok(outer_freeze.call(outer_receiver, &[result])?.raw())
}
