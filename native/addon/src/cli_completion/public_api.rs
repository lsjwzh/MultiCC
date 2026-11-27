//! Public tracker factories; event values and adapter receivers stay in V8.
use crate::{
    host_methods::{default_object, function},
    route_response::*,
};
use napi_derive::napi;

#[napi]
pub fn cli_result_api(env: Env, addon: Unknown<'_>) -> Result<sys::napi_value> {
    let s = L::new(&env, addon);
    let api = fields(s, &[])?;
    for (name, target, count) in [
        ("isMainResult", c"cliIsMainResult", 1),
        ("resultCompletion", c"cliResultCompletion", 1),
        (
            "createResultCompletionTracker",
            c"createResultCompletionTracker",
            0,
        ),
    ] {
        api.set_key(
            text(s, name)?,
            function(s, name, count, count, move |s, a| call(s, target, a))?,
        )?;
    }
    Ok(api.raw())
}

#[napi]
pub fn cli_completion_api(env: Env, addon: Unknown<'_>) -> Result<sys::napi_value> {
    let s = L::new(&env, addon);
    let api = fields(s, &[])?;
    api.set(
        c"createStepCompletionTracker",
        function(s, "createStepCompletionTracker", 0, 1, |s, a| {
            let boundary =
                crate::js_iteration::read(default_object(a[0])?, c"streamBoundary")?.truthy()?;
            call(s, c"createStepCompletionTracker", &[flag(s, boundary)?])
        })?,
    )?;
    api.set(
        c"completion",
        function(s, "completion", 2, 3, |s, a| {
            if a[2].undefined()? {
                a[2] = text(s, "protocol")?
            }
            call(s, c"cliCompletion", a)
        })?,
    )?;
    api.set(
        c"isCompleted",
        function(s, "isCompleted", 1, 1, |s, a| call(s, c"cliIsCompleted", a))?,
    )?;
    api.set(
        c"createCompletionTracker",
        function(s, "createCompletionTracker", 0, 1, |s, a| {
            call(s, c"createCliCompletionTracker", &[default_object(a[0])?])
        })?,
    )?;
    api.set(
        c"createAdapterCompletion",
        function(s, "createAdapterCompletion", 1, 1, |s, a| {
            let adapter = a[0];
            if adapter.optional(c"createCompletionTracker")?.kind()?
                == sys::ValueType::napi_function
            {
                call(adapter, c"createCompletionTracker", &[])
            } else {
                call(
                    s,
                    c"createCliCompletionTracker",
                    &[fields(s, &[("fallback", flag(s, true)?)])?],
                )
            }
        })?,
    )?;
    api.set(
        c"createProtocolCompletionTracker",
        function(s, "createProtocolCompletionTracker", 1, 1, |s, a| {
            call(s, c"createProtocolCompletionTracker", a)
        })?,
    )?;
    Ok(api.raw())
}
