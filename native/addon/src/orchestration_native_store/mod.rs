//! JavaScript-facing transactions over the isolated Rust orchestration owner.
mod maintenance;
mod question;
mod schedule;
mod specialized;
mod state;
mod transaction;
mod transport;
mod view;

use crate::host_methods::{async_result, default_object, function};
use crate::route_response::*;
use napi_derive::napi;
use std::ffi::{CStr, CString};
use transport::{ensure_open, request, request_async};
type Method = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;

fn undefined(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Undefined)
}
fn string_value(s: L<'_>) -> Result<String> {
    Ok(s.coerce_string()?.to_string_lossy())
}
fn is_func(s: L<'_>) -> Result<bool> {
    Ok(s.kind()? == sys::ValueType::napi_function)
}
fn key(name: &str) -> CString {
    CString::new(name).expect("constant or indexed property name")
}
fn get<'a>(s: L<'a>, name: &str) -> Result<L<'a>> {
    s.get(&key(name))
}
fn set(s: L<'_>, name: &str, v: L<'_>) -> Result<()> {
    s.set(&key(name), v)
}
fn or_default<'a>(v: L<'a>, fallback: L<'a>) -> Result<L<'a>> {
    Ok(if v.undefined()? { fallback } else { v })
}
fn spread(s: L<'_>) -> Result<L<'_>> {
    let obj = fields(s, &[])?;
    obj.spread_from(s)?;
    Ok(obj)
}
fn own(s: L<'_>, k: L<'_>) -> Result<bool> {
    call(s.global()?.get(c"Object")?, c"hasOwn", &[s, k])?.truthy()
}
fn has(s: L<'_>, k: &str) -> Result<bool> {
    own(s, text(s, k)?)
}
fn keys(s: L<'_>) -> Result<L<'_>> {
    call(s.global()?.get(c"Object")?, c"keys", &[s])
}
fn parse(value: L<'_>) -> Result<L<'_>> {
    call(value.global()?.get(c"JSON")?, c"parse", &[value])
}
fn json(value: L<'_>) -> Result<L<'_>> {
    call(value.global()?.get(c"JSON")?, c"stringify", &[value])
}
fn array<'a>(s: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    let v = s.global()?.get(c"Array")?.construct(&[])?;
    for (i, e) in values.iter().enumerate() {
        v.set_element(i as u32, *e)?;
    }
    Ok(v)
}
fn now(s: L<'_>) -> Result<L<'_>> {
    num(s, s.get(c"now")?.call_plain(&[])?.explicit_number()?)
}
fn error<'a>(s: L<'a>, message: &str) -> Result<L<'a>> {
    s.global()?.get(c"Error")?.construct(&[text(s, message)?])
}
fn unavailable(s: L<'_>, message: &str) -> napi::Error {
    match error(s, message).and_then(|e| {
        e.set(c"code", text(e, "SESSION_WORK_OWNER_UNAVAILABLE")?)?;
        Ok(e)
    }) {
        Ok(e) => e.throw_error(),
        Err(e) => e,
    }
}
fn cb<'a>(
    s: L<'a>,
    count: usize,
    f: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    function(s, "", count, count, f)
}
fn attach(
    s: L<'_>,
    api: L<'_>,
    name: &'static str,
    len: usize,
    count: usize,
    f: Method,
) -> Result<()> {
    set(api, name, function(s, name, len, count, f)?)
}
fn yes<'a>(
    s: L<'a>,
    promise: L<'a>,
    f: impl for<'b> Fn(L<'b>, L<'b>) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let next = cb(s, 1, move |s, a| f(s, a[0]))?;
    call(promise, c"then", &[next])
}
fn no<'a>(
    s: L<'a>,
    promise: L<'a>,
    f: impl for<'b> Fn(L<'b>, L<'b>) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let next = cb(s, 1, move |s, a| f(s, a[0]))?;
    call(promise, c"catch", &[next])
}
fn resolve(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Promise")?, c"resolve", &[v])
}
fn frame<'a>(s: L<'a>, args: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let f = fields(s, args)?;
    f.set(c"s", s)?;
    Ok(f)
}
fn enqueue<'a>(f: L<'a>, run: impl for<'b> Fn(L<'b>) -> Result<L<'b>> + 'static) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    s.set(c"queued", num(s, s.get(c"queued")?.number()? + 1.)?)?;
    let operation = cb(f, 0, move |f, _| run(f))?;
    let job = fields(s, &[("als", s.get(c"als")?), ("operation", operation)])?;
    let start = cb(job, 0, |j, _| {
        call(
            j.get(c"als")?,
            c"run",
            &[undefined(j)?, j.get(c"operation")?],
        )
    })?;
    let promise = call(s.get(c"tail")?, c"then", &[start, start])?;
    let done = cb(s, 0, |s, _| {
        s.set(c"queued", num(s, s.get(c"queued")?.number()? - 1.)?)?;
        undefined(s)
    })?;
    s.set(c"tail", call(promise, c"then", &[done, done])?)?;
    Ok(promise)
}
fn context(s: L<'_>) -> Result<L<'_>> {
    call(s.get(c"als")?, c"getStore", &[])
}
fn pending(s: L<'_>) -> Result<bool> {
    let n = s.get(c"queued")?.number()?;
    Ok(n != 0. && !(n == 1. && s.get(c"detached")?.truthy()?))
}
fn revision(s: L<'_>, res: L<'_>) -> Result<()> {
    let rev = res.optional(c"state")?.optional(c"revision")?;
    if !rev.nullish()? {
        s.set(c"revision", rev)?;
    }
    Ok(())
}
fn rethrow<'a>(s: L<'a>, e: napi::Error, fix: impl FnOnce(L<'a>) -> Result<L<'a>>) -> napi::Error {
    match s.exception_value() {
        Ok(Some(reason)) => match fix(reason) {
            Ok(err) => err.throw_error(),
            Err(err) => err,
        },
        _ => e,
    }
}
fn ignore(s: L<'_>, r: Result<L<'_>>) {
    if r.is_err() {
        let _ = s.exception_value();
    }
}
#[napi]
pub fn orchestration_native_store_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    specialized::capture(p)?;
    let api = fields(p, &[])?;
    attach(p, api, "createNativeStore", 0, 2, |p, a| {
        transport::create(p, a[0], a[1])
    })?;
    attach(p, api, "createQuestionOwner", 0, 1, |_, a| {
        question::create(a[0])
    })?;
    Ok(api.freeze()?.raw())
}
