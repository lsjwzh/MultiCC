//! The turn facade retains the selected native state owner. Argument defaults
//! and the method contract live here alongside the native lifecycle.
use crate::{
    host_methods::{arg, env as environment, method, raw},
    js_iteration::read,
    js_live::{fields, LiveValue as L},
    session_records::RustSessionRecords,
};
use napi::{
    bindgen_prelude::{ClassInstance, FromNapiValue, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;

type Operation = for<'a> fn(&RustSessionRecords, Env, &[L<'a>]) -> Result<sys::napi_value>;

fn records(owner: L<'_>) -> Result<ClassInstance<'_, RustSessionRecords>> {
    // The binding identifies instances created by this addon in its private WeakMap.
    unsafe { ClassInstance::from_napi_value(owner.env(), owner.raw()) }
}

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
    origins: Unknown<'_>,
    addon: Unknown<'_>,
) -> Result<sys::napi_value> {
    let options = L::new(&env, options);
    let supplied = read(options, c"owner")?;
    let owner = if supplied.truthy()? {
        supplied
    } else {
        L::new(&env, create_owner).call_plain(&[])?
    };
    let owner = read(owner, c"native")?;
    let origins = L::new(&env, origins);
    let local = !origins.undefined()?
        && crate::host_methods::call(origins, c"get", &[owner])?.equals(L::new(&env, addon))?;
    let configure = if local
        && crate::host_methods::uses_class_method(owner, "RustSessionRecords\0", c"turnConfigure")?
    {
        Option::None
    } else {
        Some(read(owner, c"turnConfigure")?)
    };
    let clock = if read(options, c"now")?.kind()? == sys::ValueType::napi_function {
        read(options, c"now")?
    } else {
        options.global()?.get(c"Date")?.get(c"now")?
    };
    if let Some(configure) = configure {
        crate::js_live::invoke(owner, configure, &[clock], "native.turnConfigure")?;
    } else {
        records(owner)?.turn_configure(env, arg(clock)?)?;
    }
    use DefaultArg::{None, Object, Reason};
    let facade = fields(owner, &[])?;
    let operations: [(&str, &std::ffi::CStr, usize, DefaultArg, Operation); 12] = [
        ("claim", c"turnClaim", 3, Object, |o, e, a| {
            o.turn_claim(e, arg(a[0])?, arg(a[1])?, arg(a[2])?)
        }),
        (
            "markMessageDurable",
            c"turnMarkMessageDurable",
            2,
            None,
            |o, e, a| o.turn_mark_message_durable(e, arg(a[0])?, arg(a[1])?),
        ),
        (
            "markProviderRouteResolved",
            c"turnMarkProviderRouteResolved",
            3,
            Object,
            |o, e, a| o.turn_mark_provider_route_resolved(e, arg(a[0])?, arg(a[1])?, arg(a[2])?),
        ),
        (
            "providerRouteFailed",
            c"turnProviderRouteFailed",
            3,
            Reason("route-failed"),
            |o, e, a| o.turn_provider_route_failed(e, arg(a[0])?, arg(a[1])?, arg(a[2])?),
        ),
        (
            "abortPreparation",
            c"turnAbortPreparation",
            3,
            Reason("preparation-failed"),
            |o, e, a| o.turn_abort_preparation(e, arg(a[0])?, arg(a[1])?, arg(a[2])?),
        ),
        ("settle", c"turnSettle", 4, Object, |o, e, a| {
            o.turn_settle(e, arg(a[0])?, arg(a[1])?, arg(a[2])?, arg(a[3])?)
        }),
        ("start", c"turnStart", 2, None, |o, e, a| {
            o.turn_start(e, arg(a[0])?, arg(a[1])?)
        }),
        ("beginCleanup", c"turnBeginCleanup", 3, Object, |o, e, a| {
            o.turn_begin_cleanup(e, arg(a[0])?, arg(a[1])?, arg(a[2])?)
        }),
        ("cleanup", c"turnCleanup", 2, None, |o, e, a| {
            o.turn_cleanup(e, arg(a[0])?, arg(a[1])?)
        }),
        ("claimProof", c"turnClaimProof", 2, None, |o, e, a| {
            o.turn_claim_proof(e, arg(a[0])?, arg(a[1])?)
        }),
        ("snapshot", c"turnSnapshot", 1, None, |o, e, a| {
            o.turn_snapshot(e, arg(a[0])?)
        }),
        ("list", c"turnList", 0, None, |o, e, _| o.turn_list(e)),
    ];
    for (name, key, count, default, run) in operations {
        let length = if matches!(default, None) { count } else { 2 };
        let f = method(&env, owner, name, length, count, move |owner, args| {
            if args.len() >= 3 && args[2].undefined()? {
                args[2] = match default {
                    Object => fields(owner, &[])?,
                    Reason(s) => owner.from_value(&s.into())?,
                    None => args[2],
                };
            }
            if local && crate::host_methods::uses_class_method(owner, "RustSessionRecords\0", key)?
            {
                let state = records(owner)?;
                return Ok(raw(owner, run(&state, environment(owner), args)?));
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
