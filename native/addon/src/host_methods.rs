//! Methods for JS facades over Rust owners. V8's bound argument keeps the
//! owner alive exactly as long as a method is reachable, even when detached.
use crate::js_live::{fields, LiveValue as L};
use multicc_core::js::JsValue as V;
use napi::{
    bindgen_prelude::{FromNapiValue, ToNapiValue, Unknown},
    sys, Env, Result,
};

pub(crate) fn method<'a>(
    env: &'a Env,
    owner: L<'a>,
    name: &'static str,
    length: usize,
    count: usize,
    run: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    bound_method(env, owner, name, length, Some(count), run)
}

pub(crate) fn variadic_method<'a>(
    env: &'a Env,
    owner: L<'a>,
    name: &'static str,
    length: usize,
    run: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    bound_method(env, owner, name, length, None, run)
}

fn bound_method<'a>(
    env: &'a Env,
    owner: L<'a>,
    name: &'static str,
    length: usize,
    count: Option<usize>,
    run: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let f =
        env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(name, move |ctx| {
            let owner = L::new(ctx.env, ctx.get(0)?);
            let undefined = owner.from_value(&V::Undefined)?;
            let count = count.unwrap_or_else(|| ctx.length().saturating_sub(1));
            let mut args = Vec::with_capacity(count);
            for i in 1..=count {
                args.push(if i < ctx.length() {
                    L::new(ctx.env, ctx.get(i)?)
                } else {
                    undefined
                });
            }
            Ok(run(owner, &mut args)?.raw())
        })?;
    let f = L::new(env, f.into_unknown(env)?);
    let bound = f
        .get(c"bind")?
        .call(f, &[owner.from_value(&V::Undefined)?, owner])?;
    let object = owner.global()?.get(c"Object")?;
    let define = object.get(c"defineProperty")?;
    for (key, value) in [
        ("name", V::from(name)),
        ("length", V::Number(length as f64)),
    ] {
        let descriptor = fields(owner, &[("value", owner.from_value(&value)?)])?;
        define.call(object, &[bound, owner.from_value(&key.into())?, descriptor])?;
    }
    Ok(bound)
}

pub(crate) fn call<'a>(receiver: L<'a>, key: &std::ffi::CStr, args: &[L<'a>]) -> Result<L<'a>> {
    crate::js_iteration::read(receiver, key)?.call(receiver, args)
}

/// Adopt a live return value with a fresh Promise, including synchronous host
/// exceptions. The deferred is allocated before the operation can reenter.
pub(crate) fn async_result<'a>(owner: L<'a>, run: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    let mut deferred = std::ptr::null_mut();
    let mut promise = std::ptr::null_mut();
    napi::check_status!(unsafe {
        sys::napi_create_promise(owner.env(), &mut deferred, &mut promise)
    })?;
    match run() {
        Ok(value) => napi::check_status!(unsafe {
            sys::napi_resolve_deferred(owner.env(), deferred, value.raw())
        })?,
        Err(error) => {
            let reason = match owner.exception_value()? {
                Some(cause) => cause,
                None => owner
                    .global()?
                    .get(c"Error")?
                    .construct(&[owner.from_value(&error.reason.into())?])?,
            };
            napi::check_status!(unsafe {
                sys::napi_reject_deferred(owner.env(), deferred, reason.raw())
            })?;
        }
    }
    Ok(L::from_raw(owner.env(), promise))
}

pub(crate) fn arg(value: L<'_>) -> Result<Unknown<'_>> {
    // Both pointers belong to the current native callback scope.
    unsafe { Unknown::from_napi_value(value.env(), value.raw()) }
}
pub(crate) fn env(value: L<'_>) -> Env {
    Env::from_raw(value.env())
}
pub(crate) fn raw(value: L<'_>, handle: sys::napi_value) -> L<'_> {
    L::from_raw(value.env(), handle)
}
pub(crate) fn default_object(value: L<'_>) -> Result<L<'_>> {
    if value.undefined()? {
        fields(value, &[])
    } else {
        Ok(value)
    }
}
pub(crate) fn function<'a>(
    owner: L<'a>,
    name: &'static str,
    length: usize,
    count: usize,
    f: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let e = env(owner);
    Ok(raw(owner, method(&e, owner, name, length, count, f)?.raw()))
}
pub(crate) fn args_default(value: L<'_>) -> Result<Unknown<'_>> {
    arg(default_object(value)?)
}
