//! Recurring automation owns its protocols in Rust. Borrowed engine values keep
//! injected task identities and Promise ordering without embedding JavaScript.
mod binding;
mod fanout;
mod git_push;
mod routes;
mod schedule;
mod timezone;
mod view;
use crate::{
    host_methods::{async_result, default_object, function},
    js_live::spread,
    route_response::*,
};
use napi::bindgen_prelude::{AsyncTask, ToNapiValue};
use napi::Task;
use std::ffi::CStr;

fn undefined(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Undefined)
}
fn array(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"Array")?.construct(&[])
}
fn map(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"Map")?.construct(&[])
}
fn append(a: L<'_>, v: L<'_>) -> Result<()> {
    call(a, c"push", &[v])?;
    Ok(())
}
fn either<'a>(v: L<'a>, d: L<'a>) -> Result<L<'a>> {
    Ok(if v.truthy()? { v } else { d })
}
fn strval(v: L<'_>) -> Result<String> {
    Ok(string(v)?.coerce_string()?.to_string_lossy())
}
fn now(p: L<'_>) -> Result<L<'_>> {
    call(p.global()?.get(c"Date")?, c"now", &[])
}
fn iso<'a>(p: L<'a>, ms: L<'a>) -> Result<L<'a>> {
    call(
        p.global()?.get(c"Date")?.construct(&[ms])?,
        c"toISOString",
        &[],
    )
}
fn resolve(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Promise")?, c"resolve", &[v])
}
fn then<'a>(
    pending: L<'a>,
    frame: L<'a>,
    step: for<'b> fn(L<'b>, L<'b>) -> Result<L<'b>>,
) -> Result<L<'a>> {
    call(
        resolve(pending)?,
        c"then",
        &[function(frame, "", 1, 1, move |f, a| step(f, a[0]))?],
    )
}
fn caught<'a>(
    pending: L<'a>,
    frame: L<'a>,
    step: for<'b> fn(L<'b>, L<'b>) -> Result<L<'b>>,
) -> Result<L<'a>> {
    call(
        pending,
        c"catch",
        &[function(frame, "", 1, 1, move |f, a| step(f, a[0]))?],
    )
}
fn invoke<'a>(target: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    async_result(target, || call(target, key, args))
}
fn message(e: L<'_>) -> Result<L<'_>> {
    let msg = e.optional(c"message")?;
    if msg.truthy()? {
        Ok(msg)
    } else {
        string(e)
    }
}
fn failure(p: L<'_>, code: &str, msg: &str) -> Result<napi::Error> {
    let e = p.global()?.get(c"Error")?.construct(&[text(p, msg)?])?;
    if !code.is_empty() {
        e.set(c"code", text(p, code)?)?;
    }
    Ok(e.throw_error())
}
fn logger<'a>(p: L<'a>, level: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(p.get(c"logger")?, level, args)
}
fn value(p: L<'_>) -> Result<V> {
    unsafe { crate::js_bridge::read_value(p.env(), p.raw(), 0, &mut Vec::new()) }
}
fn json_parse<'a>(p: L<'a>, source: &str) -> Result<L<'a>> {
    call(p.global()?.get(c"JSON")?, c"parse", &[text(p, source)?])
}
fn slice(v: L<'_>, start: f64, end: Option<f64>) -> Result<L<'_>> {
    let mut args = vec![num(v, start)?];
    if let Some(end) = end {
        args.push(num(v, end)?)
    }
    call(v, c"slice", &args)
}
struct Work(Box<dyn FnMut() -> Result<String> + Send>);
impl Task for Work {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        (self.0)()
    }
    fn resolve(&mut self, _: Env, v: String) -> Result<String> {
        Ok(v)
    }
}
fn work<'a>(p: L<'a>, run: impl FnMut() -> Result<String> + Send + 'static) -> Result<L<'a>> {
    let task = AsyncTask::new(Work(Box::new(run)));
    Ok(L::from_raw(p.env(), unsafe {
        AsyncTask::<Work>::to_napi_value(p.env(), task)?
    }))
}

fn callable(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_function)
}
fn root(p: L<'_>) -> Result<L<'_>> {
    p.get(c"owner")
}
fn deps(p: L<'_>) -> Result<L<'_>> {
    p.get(c"deps")
}
fn ports(p: L<'_>) -> Result<L<'_>> {
    p.get(c"ports")
}
fn plus_one(v: L<'_>) -> Result<L<'_>> {
    let v = either(v, num(v, 0.)?)?;
    let v = if matches!(
        v.kind()?,
        sys::ValueType::napi_object | sys::ValueType::napi_function
    ) {
        v.number_hint_primitive()?
    } else {
        v
    };
    if let Some(s) = v.string()? {
        let mut u = s.into_units();
        u.push(49);
        v.from_value(&V::String(multicc_core::js::JsString::from_units(u)))
    } else {
        num(v, v.number()? + 1.)
    }
}
