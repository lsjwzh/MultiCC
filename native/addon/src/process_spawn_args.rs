//! Spawn argument ordering, preserving live iterable and payload semantics.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn process_spawn_args(
    env: Env,
    invocation: Unknown<'_>,
    settings: Unknown<'_>,
) -> Result<sys::napi_value> {
    let invocation = L::new(&env, invocation);
    let args = invocation.from_value(&V::Array(vec![]))?;
    let mut index = 0usize;
    invocation.get(c"args")?.for_each(|value| {
        args.define_key(args.from_value(&V::from(index.to_string()))?, value)?;
        index += 1;
        Ok(())
    })?;
    let settings = L::new(&env, settings);
    if settings.truthy()? {
        let separated = args
            .get(c"at")?
            .call(args, &[args.from_value(&V::Number(-1.0))?])?
            .is_string("--")?;
        if separated {
            args.get(c"pop")?.call(args, &[])?;
        }
        args.get(c"push")?
            .call(args, &[args.from_value(&V::from("--settings"))?, settings])?;
        if separated {
            args.get(c"push")?
                .call(args, &[args.from_value(&V::from("--"))?])?;
        }
    }
    args.get(c"push")?
        .call(args, &[invocation.get(c"payload")?])?;
    Ok(args.raw())
}
