//! The turn facade retains the selected native state owner. Argument defaults
//! and the method contract live here alongside the native lifecycle.
use crate::{
    host_methods::method,
    js_iteration::read,
    js_live::{fields, LiveValue as L},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

enum DefaultArg {
    None,
    Object,
    Reason(&'static str),
}

#[napi]
pub fn turn_runtime_store(
    env: Env,
    options: Unknown<'_>,
    create_owner: Unknown<'_>,
) -> Result<sys::napi_value> {
    let options = L::new(&env, options);
    let supplied = read(options, c"owner")?;
    let owner = if supplied.truthy()? {
        supplied
    } else {
        L::new(&env, create_owner).call_plain(&[])?
    };
    let owner = read(owner, c"native")?;
    let configure = read(owner, c"turnConfigure")?;
    let clock = if read(options, c"now")?.kind()? == sys::ValueType::napi_function {
        read(options, c"now")?
    } else {
        options.global()?.get(c"Date")?.get(c"now")?
    };
    crate::js_live::invoke(owner, configure, &[clock], "native.turnConfigure")?;
    use DefaultArg::{None, Object, Reason};
    let facade = fields(owner, &[])?;
    for (name, key, count, default) in [
        ("claim", c"turnClaim", 3, Object),
        ("markMessageDurable", c"turnMarkMessageDurable", 2, None),
        (
            "markProviderRouteResolved",
            c"turnMarkProviderRouteResolved",
            3,
            Object,
        ),
        (
            "providerRouteFailed",
            c"turnProviderRouteFailed",
            3,
            Reason("route-failed"),
        ),
        (
            "abortPreparation",
            c"turnAbortPreparation",
            3,
            Reason("preparation-failed"),
        ),
        ("settle", c"turnSettle", 4, Object),
        ("start", c"turnStart", 2, None),
        ("beginCleanup", c"turnBeginCleanup", 3, Object),
        ("cleanup", c"turnCleanup", 2, None),
        ("claimProof", c"turnClaimProof", 2, None),
        ("snapshot", c"turnSnapshot", 1, None),
        ("list", c"turnList", 0, None),
    ] {
        let length = if matches!(default, None) { count } else { 2 };
        let f = method(&env, owner, name, length, count, move |owner, args| {
            if args.len() >= 3 && args[2].undefined()? {
                args[2] = match default {
                    Object => fields(owner, &[])?,
                    Reason(s) => owner.from_value(&s.into())?,
                    None => args[2],
                };
            }
            let function = read(owner, key)?;
            if function.kind()? != sys::ValueType::napi_function {
                return Err(owner.type_error(&format!(
                    "native.{} is not a function",
                    key.to_string_lossy()
                )));
            }
            function.call(owner, args)
        })?;
        facade.define_key(owner.from_value(&name.into())?, f)?;
    }
    Ok(facade.freeze()?.raw())
}
