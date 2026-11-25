use crate::{
    host_methods::call,
    js_live::{fields, LiveValue as L},
};
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn skill_sync_response(
    env: Env,
    runtime: Unknown<'_>,
    res: Unknown<'_>,
    run: bool,
    sanitize: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (runtime, res) = (L::new(&env, runtime), L::new(&env, res));
    let none = res.from_value(&V::Undefined)?;
    if !run {
        res.get(c"json")?
            .call(res, &[call(runtime, c"getStatus", &[])?])?;
        return Ok(none.raw());
    }
    let result = (|| {
        let value = call(runtime, c"runNow", &[])?;
        call(
            res,
            c"json",
            &[fields(
                res,
                &[("ok", res.from_value(&V::Bool(true))?), ("result", value)],
            )?],
        )
    })();
    let Err(error) = result else {
        return Ok(none.raw());
    };
    let err = res.exception_value()?.ok_or(error)?;
    let busy = err.truthy()? && err.get(c"code")?.is_string("SKILL_SYNC_RUNNING")?;
    let sender = call(
        res,
        c"status",
        &[res.from_value(&V::Number(if busy { 409.0 } else { 500.0 }))?],
    )?;
    let json = sender.get(c"json")?;
    let message = if busy {
        res.from_value(&"sync already running".into())?
    } else {
        let message = if err.truthy()? {
            err.get(c"message")?
        } else {
            err
        };
        L::new(&env, sanitize)
            .call_plain(&[message, res.from_value(&"skill sync failed".into())?])?
    };
    Ok(json
        .call(
            sender,
            &[fields(
                res,
                &[("ok", res.from_value(&V::Bool(false))?), ("error", message)],
            )?],
        )?
        .raw())
}
