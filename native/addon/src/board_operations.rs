//! Board operations retain live V8 records across asynchronous storage and Git callbacks.
use crate::host_api::*;
use napi_derive::napi;
use std::ffi::CStr;

mod lifecycle;
mod relocate;
mod retention;
mod retention_facts;

fn invoke<'a>(object: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    object.get(key)?.call_plain(args)
}
fn optional_call<'a>(object: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    let f = object.get(key)?;
    if f.nullish()? {
        undef(object)
    } else {
        f.call(object, args)
    }
}
fn owner<'a>(ports: L<'a>, options: L<'a>) -> Result<L<'a>> {
    fields(ports, &[("ports", ports), ("options", options)])
}
fn pair<'a>(ctx: L<'a>) -> Result<(L<'a>, L<'a>)> {
    let runtime = ctx.get(c"runtime")?;
    Ok((runtime.get(c"options")?, runtime.get(c"ports")?))
}
fn strict_true(value: L<'_>) -> Result<bool> {
    value.equals(flag(value, true)?)
}
fn coded<'a>(p: L<'a>, code: L<'a>, message: L<'a>, status: Option<i32>) -> Result<napi::Error> {
    let err = p.global()?.get(c"Error")?.construct(&[message])?;
    err.set(c"code", code)?;
    if let Some(status) = status {
        err.set(c"status", num(p, status.into())?)?;
    }
    Ok(err.throw_error())
}
fn denied(p: L<'_>, code: &str, status: Option<i32>) -> Result<napi::Error> {
    let code = text(p, code)?;
    coded(p, code, code, status)
}
fn json_status<'a>(res: L<'a>, status: L<'a>, value: L<'a>) -> Result<L<'a>> {
    call(call(res, c"status", &[status])?, c"json", &[value])
}
fn list_one(v: L<'_>) -> Result<L<'_>> {
    let list = array(v)?;
    call(list, c"push", &[v])?;
    Ok(list)
}

#[napi]
pub fn board_lifecycle_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(methods(
        p,
        &[
            ("createTaskLifecycle", 1, |p, a| {
                lifecycle::create(p, a[0], false)
            }),
            ("createBoardTaskLifecycle", 1, |p, a| {
                lifecycle::create(p, a[0], true)
            }),
        ],
    )?
    .raw())
}
#[napi]
pub fn board_relocate_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(methods(
        p,
        &[("createTaskRelocate", 1, |p, a| relocate::create(p, a[0]))],
    )?
    .raw())
}
#[napi]
pub fn board_retention_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(methods(
        p,
        &[
            ("lastInteraction", 2, |p, a| {
                retention_facts::interaction(p, a[0], a[1])
            }),
            ("retentionCandidates", 1, |p, a| {
                retention_facts::candidates(p, a[0])
            }),
            ("createTaskRetention", 1, |p, a| retention::create(p, a[0])),
        ],
    )?
    .raw())
}
