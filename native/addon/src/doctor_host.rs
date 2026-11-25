//! Both doctor services select the same live Aux destination on each run.
use crate::{
    host_methods::call,
    js_iteration::read,
    js_live::{fields, LiveValue as L},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
#[napi]
pub fn doctor_http_target(
    env: Env,
    queue: Unknown<'_>,
    config: Unknown<'_>,
) -> Result<sys::napi_value> {
    let queue = L::new(&env, queue);
    let target = call(queue, c"resolveHttpTarget", &[])?;
    let mut model = read(L::new(&env, config).call_plain(&[])?, c"model")?;
    if !model.truthy()? {
        model = read(target, c"model")?;
    }
    if !model.truthy()? {
        let options = read(target, c"modelOptions")?;
        if options.truthy()? {
            model = read(options, c"0")?;
        }
        if !model.truthy()? {
            model = target.from_value(&"".into())?;
        }
    }
    Ok(fields(target, &[("target", target), ("model", model)])?.raw())
}
