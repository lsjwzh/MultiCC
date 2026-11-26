//! Live ECMAScript ports for the history owners. Promise continuations retain
//! their operation frame; transcript data and mutation order stay in the owners.
use crate::{
    host_methods::{async_result, function},
    route_response::*,
};
use napi_derive::napi;
use std::ffi::CStr;
mod driver;
mod rotation;
mod routes;
mod service;

fn undefined(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Undefined)
}
fn array<'a>(p: L<'a>, items: &[L<'a>]) -> Result<L<'a>> {
    let a = p.from_value(&V::Array(vec![]))?;
    for (i, v) in items.iter().enumerate() {
        a.set_element(i as u32, *v)?;
    }
    Ok(a)
}
fn callable(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_function)
}
fn run<'a>(p: L<'a>, name: &str, args: &[L<'a>]) -> Result<L<'a>> {
    call(
        p.get(c"runtime")?,
        c"run",
        &[p.get(c"anchor")?, text(p, name)?, array(p, args)?],
    )
}
fn deps(p: L<'_>) -> Result<L<'_>> {
    p.get(c"deps")
}
fn caught<'a>(p: L<'a>, err: napi::Error) -> Result<L<'a>> {
    if let Some(reason) = p.exception_value()? {
        Ok(reason)
    } else {
        p.global()?
            .get(c"Error")?
            .construct(&[text(p, &err.reason)?])
    }
}
fn coded<'a>(p: L<'a>, message: &str, code: &str) -> Result<L<'a>> {
    let err = p.global()?.get(c"Error")?.construct(&[text(p, message)?])?;
    err.set(c"code", text(p, code)?)?;
    Ok(err)
}
type Next = for<'a> fn(L<'a>, L<'a>) -> Result<L<'a>>;
fn continuation<'a>(f: L<'a>, step: Next) -> Result<L<'a>> {
    function(f, "", 1, 1, move |f, a| step(f, a[0]))
}
fn then<'a>(f: L<'a>, wait: L<'a>, step: Next) -> Result<L<'a>> {
    let promise = call(f.global()?.get(c"Promise")?, c"resolve", &[wait])?;
    call(promise, c"then", &[continuation(f, step)?])
}
fn mapped<'a>(
    f: L<'a>,
    op: impl FnOnce() -> Result<L<'a>>,
    event: &'static str,
    message: &'static str,
    code: &'static str,
) -> Result<L<'a>> {
    let pending = async_result(f, op)?;
    let fail = function(f, "", 1, 1, move |f, a| {
        run(
            f.get(c"ports")?,
            "logFailure",
            &[text(f, event)?, a[0], f.get(c"id")?],
        )?;
        Err(coded(f, message, code)?.throw_error())
    })?;
    call(pending, c"catch", &[fail])
}
fn frame<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    fields(p, &[("ports", p), ("id", id)])
}
fn driver_start<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    p.get(c"drive")?.call_plain(&[id])
}

#[napi]
pub fn history_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    p.set(c"waiters", p.global()?.get(c"Map")?.construct(&[])?)?;
    let api = fields(p, &[])?;
    for (name, arity, count) in [
        ("mutate", 3, 3),
        ("advance", 1, 1),
        ("failWaiters", 2, 2),
        ("rotateNativeContext", 2, 2),
        ("clearHistory", 3, 3),
        ("deleteMessage", 3, 3),
        ("historyPage", 3, 3),
        ("contextLevel", 3, 3),
    ] {
        let method = function(p, name, arity, count, move |p, a| match name {
            "mutate" => driver::mutate(p, a[0], a[1], a[2]),
            "advance" => driver::advance(p, a[0]),
            "failWaiters" => driver::fail_waiters(p, a[0], a[1]),
            "rotateNativeContext" => rotation::rotate(p, a[0], a[1]),
            "clearHistory" => routes::clear(p, a[0], a[1], a[2]),
            _ => routes::handle(p, name, a),
        })?;
        api.set_key(text(p, name)?, method)?;
    }
    Ok(api.raw())
}
