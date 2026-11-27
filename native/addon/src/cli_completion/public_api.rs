//! Public tracker factories; event values and adapter receivers stay in V8.
use crate::{
    host_methods::{arg, default_object, env as environment, function, raw},
    route_response::*,
};
use napi_derive::napi;

#[napi]
pub fn cli_result_api(env: Env, addon: Unknown<'_>) -> Result<sys::napi_value> {
    let s = L::new(&env, addon);
    let api = fields(s, &[])?;
    api.set(
        c"isMainResult",
        function(s, "isMainResult", 1, 1, |s, a| {
            flag(s, super::main_result(a[0])?)
        })?,
    )?;
    api.set(
        c"resultCompletion",
        function(s, "resultCompletion", 1, 1, |_, a| {
            super::result_completion(a[0])
        })?,
    )?;
    api.set(
        c"createResultCompletionTracker",
        function(s, "createResultCompletionTracker", 0, 0, |s, _| {
            Ok(raw(
                s,
                super::tracker::create_result_completion_tracker(environment(s))?,
            ))
        })?,
    )?;
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
            Ok(raw(
                s,
                super::tracker::create_step_completion_tracker(environment(s), boundary)?,
            ))
        })?,
    )?;
    api.set(
        c"completion",
        function(s, "completion", 2, 3, |s, a| {
            if a[2].undefined()? {
                a[2] = text(s, "protocol")?
            }
            Ok(raw(
                s,
                super::cli_completion(environment(s), arg(a[0])?, arg(a[1])?, arg(a[2])?)?,
            ))
        })?,
    )?;
    api.set(
        c"isCompleted",
        function(s, "isCompleted", 1, 1, |s, a| {
            flag(s, super::completed(a[0])?)
        })?,
    )?;
    api.set(
        c"createCompletionTracker",
        function(s, "createCompletionTracker", 0, 1, |s, a| {
            Ok(raw(
                s,
                super::tracker::create_cli_completion_tracker(environment(s), arg(a[0])?)?,
            ))
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
                Ok(raw(
                    s,
                    super::tracker::create_cli_completion_tracker(
                        environment(s),
                        arg(fields(s, &[("fallback", flag(s, true)?)])?)?,
                    )?,
                ))
            }
        })?,
    )?;
    api.set(
        c"createProtocolCompletionTracker",
        function(s, "createProtocolCompletionTracker", 1, 1, |s, a| {
            Ok(raw(
                s,
                super::tracker::create_protocol_completion_tracker(environment(s), arg(a[0])?)?,
            ))
        })?,
    )?;
    Ok(api.raw())
}
