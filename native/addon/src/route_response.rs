//! Express response operations shared by the native handlers for captured routes.
pub(crate) use crate::{
    host_methods::call,
    js_live::{fields, LiveValue as L},
};
pub(crate) use multicc_core::js::JsValue as V;
pub(crate) use napi::{bindgen_prelude::Unknown, sys, Env, Result};

pub(crate) fn text<'a>(a: L<'a>, value: &str) -> Result<L<'a>> {
    a.from_value(&value.into())
}
pub(crate) fn flag(a: L<'_>, value: bool) -> Result<L<'_>> {
    a.from_value(&V::Bool(value))
}
pub(crate) fn num(a: L<'_>, value: f64) -> Result<L<'_>> {
    a.from_value(&V::Number(value))
}
pub(crate) fn null(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&V::Null)
}
pub(crate) fn fallback<'a>(value: L<'a>, default: V) -> Result<L<'a>> {
    if value.truthy()? {
        Ok(value)
    } else {
        value.from_value(&default)
    }
}
pub(crate) fn string(value: L<'_>) -> Result<L<'_>> {
    value.global()?.get(c"String")?.call_plain(&[value])
}
pub(crate) fn send<'a>(res: L<'a>, status: Option<i32>, body: L<'a>) -> Result<L<'a>> {
    let target = match status {
        Some(code) => call(res, c"status", &[num(res, code.into())?])?,
        None => res,
    };
    call(target, c"json", &[body])
}
pub(crate) fn error<'a>(res: L<'a>, code: i32, message: &str, with_ok: bool) -> Result<L<'a>> {
    let out = fields(res, &[])?;
    if with_ok {
        out.set(c"ok", flag(res, false)?)?
    }
    out.set(c"error", text(res, message)?)?;
    send(res, Some(code), out)
}
