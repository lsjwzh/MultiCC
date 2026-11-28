//! Live JavaScript turn identities, Promise continuations and injected host ports.
use crate::host_api::*;
use napi_derive::napi;
use std::ffi::CStr;
mod attribution;
mod coordinator;
mod delivery;
mod lifecycle;
mod questions;
mod runtime;

fn obj(p: L<'_>) -> Result<L<'_>> {
    fields(p, &[])
}
fn frozen<'a>(p: L<'a>, pairs: &[(&str, L<'a>)]) -> Result<L<'a>> {
    fields(p, pairs)?.freeze()
}
fn object_value(v: L<'_>) -> Result<L<'_>> {
    if object(v)? {
        Ok(v)
    } else {
        obj(v)
    }
}
fn choose<'a>(v: L<'a>, other: L<'a>) -> Result<L<'a>> {
    Ok(if v.truthy()? { v } else { other })
}
fn lower(v: L<'_>) -> Result<L<'_>> {
    call(v.clean_text()?, c"toLowerCase", &[])
}
fn keys(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Object")?, c"keys", &[v])
}
fn js_frozen(v: L<'_>) -> Result<bool> {
    call(v.global()?.get(c"Object")?, c"isFrozen", &[v])?.is_true()
}
fn descriptor<'a>(v: L<'a>, k: L<'a>) -> Result<L<'a>> {
    call(
        v.global()?.get(c"Object")?,
        c"getOwnPropertyDescriptor",
        &[v, k],
    )
}
fn define<'a>(v: L<'a>, k: L<'a>, d: L<'a>) -> Result<()> {
    call(v.global()?.get(c"Object")?, c"defineProperty", &[v, k, d])?;
    Ok(())
}
fn is_safe(v: L<'_>) -> Result<bool> {
    call(v.global()?.get(c"Number")?, c"isSafeInteger", &[v])?.is_true()
}
fn err_message<'a>(p: L<'a>, e: L<'a>, default: &str) -> Result<L<'a>> {
    let m = e.optional(c"message")?;
    if m.truthy()? {
        string(m)
    } else {
        text(p, default)
    }
}
fn exception<'a>(p: L<'a>, e: napi::Error) -> Result<L<'a>> {
    match p.exception_value()? {
        Some(c) => Ok(c),
        None => error_value(p, &e.reason),
    }
}
fn success(v: L<'_>) -> Result<bool> {
    Ok(v.is_true()? || (object(v)? && v.get(c"ok")?.is_true()?))
}
fn decision<'a>(p: L<'a>, error: Option<&str>) -> Result<L<'a>> {
    frozen(
        p,
        &[
            ("ok", flag(p, error.is_none())?),
            (
                "code",
                match error {
                    Some(e) => text(p, e)?,
                    None => null(p)?,
                },
            ),
        ],
    )
}
fn owned<'a>(ports: L<'a>, ctor: &CStr, table: &CStr, key: L<'a>) -> Result<L<'a>> {
    let table = ports.get(table)?;
    let previous = call(table, c"get", &[key])?;
    if previous.truthy()? {
        return Ok(previous);
    }
    let state = fields(
        key,
        &[("native", ports.get(c"addon")?.get(ctor)?.construct(&[])?)],
    )?;
    call(table, c"set", &[key, state])?;
    Ok(state)
}
#[napi]
pub fn chat_lifecycle_api(env: Env, addon: Unknown<'_>) -> Result<sys::napi_value> {
    let a = L::new(&env, addon);
    let weak = a.global()?.get(c"WeakMap")?;
    let owner = fields(
        a,
        &[
            ("addon", a),
            ("turns", weak.construct(&[])?),
            ("runners", weak.construct(&[])?),
            ("legacy", weak.construct(&[])?),
        ],
    )?;
    Ok(lifecycle::api(owner)?.raw())
}
#[napi]
pub fn chat_coordinator_api(env: Env, deps: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(coordinator::api(L::new(&env, deps))?.raw())
}
#[napi]
pub fn chat_runtime_api(env: Env, deps: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(runtime::api(L::new(&env, deps))?.raw())
}
