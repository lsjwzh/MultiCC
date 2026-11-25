//! Methods for JS facades over Rust owners. V8's bound argument keeps the
//! owner alive exactly as long as a method is reachable, even when detached.
use crate::js_live::{fields, LiveValue as L};
use multicc_core::js::JsValue as V;
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
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
    let f =
        env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(name, move |ctx| {
            let owner = L::new(ctx.env, ctx.get(0)?);
            let undefined = owner.from_value(&V::Undefined)?;
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
