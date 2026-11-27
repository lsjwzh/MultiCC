//! The JS-facing handle queues work in call order before dispatch to N-API's
//! worker pool. The pending tail belongs to this handle, not to a global store.
use crate::{
    host_methods::{default_object, function, typed},
    relay_shares::{relay_share_parse, RustRelayShares},
    route_response::*,
};
use napi::bindgen_prelude::{AsyncTask, ToNapiValue};
use napi_derive::napi;
use std::rc::Rc;

fn public_error(error: L<'_>) -> Result<L<'_>> {
    if error.optional(c"code")?.is_string("GenericFailure")? {
        let message = string(error.get(c"message")?)?
            .coerce_string()?
            .to_string_lossy();
        if let Some((code, detail)) = message.split_once(':') {
            if !code.is_empty() && code.bytes().all(|b| b == b'_' || b.is_ascii_uppercase()) {
                error.assign(c"code", text(error, code)?)?;
                error.assign(c"message", text(error, detail.trim_start())?)?;
                if matches!(code, "STATE_CORRUPTED" | "STATE_UNREADABLE") {
                    error.assign(c"name", text(error, "CorruptedStateError")?)?;
                }
            }
        }
    }
    Ok(error)
}

fn decoded<'a>(json: L<'a>, encoded: L<'a>) -> Result<L<'a>> {
    let value = call(json, c"parse", &[encoded])?;
    if value.is_array()? {
        for index in 0..value.get(c"length")?.number()? as u32 {
            value.element(index)?.freeze()?;
        }
        return Ok(value);
    }
    let share = value.optional(c"share")?;
    if share.truthy()? {
        share.freeze()?;
    }
    if !value.nullish()? && value.kind()? == sys::ValueType::napi_object {
        return value.freeze();
    }
    Ok(value)
}

fn enqueue<'a>(
    state: L<'a>,
    store: Rc<RustRelayShares>,
    operation: &'static str,
    input: L<'a>,
) -> Result<L<'a>> {
    let json = state.global()?.get(c"JSON")?;
    // Snapshot input and surface circular-value errors synchronously.
    let encoded = call(json, c"stringify", &[input])?;
    let job = fields(
        state,
        &[("options", state.get(c"options")?), ("encoded", encoded)],
    )?;
    let dispatch = function(job, "dispatch", 0, 0, move |job, _| {
        let options = job.get(c"options")?;
        let now = if options.get(c"now")?.kind()? == sys::ValueType::napi_function
            && !matches!(operation, "list" | "getCredential")
        {
            Some(call(options, c"now", &[])?.explicit_number()?)
        } else {
            None
        };
        let task = store.run(operation.into(), typed(job.get(c"encoded")?)?, now);
        // N-API creates the work promise in the current JS callback's scope.
        let promise = unsafe { AsyncTask::to_napi_value(job.env(), task) }?;
        Ok(L::from_raw(job.env(), promise))
    })?;
    let tail = state.get(c"tail")?;
    let started = call(tail, c"then", &[dispatch])?;
    let result = call(started, c"then", &[state.get(c"decode")?])?;
    let next = call(result, c"catch", &[state.get(c"mapError")?])?;
    state.set(c"tail", call(next, c"catch", &[state.get(c"resume")?])?)?;
    Ok(next)
}

fn open(options: L<'_>) -> Result<L<'_>> {
    let options = default_object(options)?;
    let file = options.get(c"file")?;
    if !file.truthy()? {
        return Err(options.type_error("provider relay share store requires { file }"));
    }
    let key_file = options.get(c"keyFile")?;
    let key_file = if key_file.nullish()? {
        None
    } else {
        Some(typed(key_file)?)
    };
    let store = RustRelayShares::new(typed(file)?, key_file).map_err(|err| -> napi::Error {
        let make = || -> Result<L<'_>> {
            let cause = options
                .global()?
                .get(c"Error")?
                .construct(&[text(options, &err.reason)?])?;
            cause.set(c"code", text(options, "GenericFailure")?)?;
            public_error(cause)
        };
        match make() {
            Ok(cause) => cause.throw_error(),
            Err(other) => other,
        }
    })?;
    let store = Rc::new(store);
    let json = options.global()?.get(c"JSON")?;
    let initial = call(options.global()?.get(c"Promise")?, c"resolve", &[])?;
    let state = fields(
        options,
        &[
            ("options", options),
            ("tail", initial),
            (
                "decode",
                function(json, "decode", 1, 1, |json, a| decoded(json, a[0]))?,
            ),
            (
                "mapError",
                function(json, "mapError", 1, 1, |_, a| {
                    Err(public_error(a[0])?.throw_error())
                })?,
            ),
            (
                "resume",
                function(json, "resume", 0, 0, |p, _| p.from_value(&V::Undefined))?,
            ),
        ],
    )?;
    let api = fields(options, &[])?;
    for (name, length, count) in [
        ("create", 0, 1),
        ("list", 0, 1),
        ("getCredential", 1, 1),
        ("authorize", 0, 1),
        ("revoke", 1, 1),
        ("revokeProvider", 2, 2),
    ] {
        let owner = Rc::clone(&store);
        let method = function(state, name, length, count, move |s, a| {
            let input = match name {
                "create" | "list" | "authorize" => default_object(a[0])?,
                "revokeProvider" => fields(s, &[("appType", a[0]), ("providerId", a[1])])?,
                _ if a[0].nullish()? => null(s)?,
                _ => a[0],
            };
            enqueue(s, Rc::clone(&owner), name, input)
        })?;
        api.set_key(text(api, name)?, method)?;
    }
    api.freeze()
}

#[napi]
pub fn relay_share_api(env: Env, realm: Unknown<'_>) -> Result<sys::napi_value> {
    let global = L::new(&env, realm);
    let api = fields(
        global,
        &[
            ("MAX_SECRET_LENGTH", num(global, 128.)?),
            ("MIN_SECRET_LENGTH", num(global, 8.)?),
            ("TOKEN_PREFIX", text(global, "mcr1")?),
            (
                "createProviderRelayShareStore",
                function(global, "createProviderRelayShareStore", 0, 1, |_, a| {
                    open(a[0])
                })?,
            ),
        ],
    )?;
    for (name, kind) in [
        ("parseCredential", "credential"),
        ("relayRouteFromBaseUrl", "baseUrl"),
        ("routeTarget", "target"),
    ] {
        let parser = function(global, name, 1, 1, move |g, a| {
            let input = if a[0].nullish()? { null(g)? } else { a[0] };
            let json = g.get(c"JSON")?;
            let encoded = call(json, c"stringify", &[input])?;
            let result = relay_share_parse(kind.into(), typed(encoded)?)?;
            call(json, c"parse", &[text(g, &result)?])
        })?;
        api.set_key(text(api, name)?, parser)?;
    }
    Ok(api.raw())
}
