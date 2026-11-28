//! Orchestration over per-instance host services. Durable rows belong to the
//! selected store. Only pending-work projections and worker lifetimes are local.
mod delivery;
mod lifecycle;
mod operations;
mod services;
mod setup;
mod waits;

use crate::host_methods::{async_result, function as callback};
use crate::route_response::*;
use napi_derive::napi;
use std::ffi::CStr;

fn undef(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Undefined)
}
fn fulfilled(value: L<'_>) -> Result<L<'_>> {
    call(value.global()?.get(c"Promise")?, c"resolve", &[value])
}
fn after<'a>(
    state: L<'a>,
    value: L<'a>,
    next: impl for<'b> Fn(L<'b>, L<'b>) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let f = callback(state, "", 1, 1, move |s, a| next(s, a[0]))?;
    call(fulfilled(value)?, c"then", &[f])
}
fn recover<'a>(
    state: L<'a>,
    promise: L<'a>,
    handle: impl for<'b> Fn(L<'b>, L<'b>) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let f = callback(state, "", 1, 1, move |s, a| handle(s, a[0]))?;
    call(promise, c"catch", &[f])
}
fn service<'a>(s: L<'a>, name: &CStr, op: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(s.get(name)?, op, args)
}
fn port<'a>(s: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    s.get(name)?.call_plain(args)
}
fn log(s: L<'_>, message: &str) -> Result<()> {
    port(s, c"log", &[text(s, message)?])?;
    Ok(())
}
fn describe(v: L<'_>) -> Result<String> {
    Ok(v.coerce_string()?.to_string_lossy())
}
fn error_message(v: L<'_>) -> Result<String> {
    describe(v.get(c"message")?)
}
fn fail(s: L<'_>, message: &str) -> napi::Error {
    match s
        .global()
        .and_then(|g| g.get(c"Error"))
        .and_then(|e| e.construct(&[text(s, message)?]))
    {
        Ok(e) => e.throw_error(),
        Err(e) => e,
    }
}
fn saved<'a>(state: L<'a>, kv: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let frame = fields(state, kv)?;
    frame.set(c"runtime", state)?;
    Ok(frame)
}
fn active_status(v: L<'_>) -> Result<bool> {
    Ok(v.is_string("admitted")? || v.is_string("running")?)
}
fn async_method<'a>(
    state: L<'a>,
    api: L<'a>,
    key: &'static CStr,
    count: usize,
    length: usize,
    f: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<()> {
    let name = key.to_str().expect("static method name");
    api.set(key, callback(state, name, length, count, f)?)
}

#[napi]
pub fn orchestration_runtime_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let host = L::new(&env, ports);
    Ok(fields(
        host,
        &[
            ("DEFAULTS", waits::defaults(host)?.freeze()?),
            (
                "publicWait",
                callback(host, "publicWait", 1, 1, |_, a| waits::public_wait(a[0]))?,
            ),
            (
                "createOrchestrationRuntime",
                callback(host, "createOrchestrationRuntime", 0, 1, |h, a| {
                    setup::create(h, a[0])
                })?,
            ),
        ],
    )?
    .raw())
}
