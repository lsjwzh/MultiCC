//! Per-instance session work coordinator. The durable question and FIFO live in
//! the store. In-flight turn closures, classification retries and cancellations
//! are scoped to a single host and hold live promises or timer handles.
mod cancel;
mod events;
mod questions;
mod transitions;

use crate::host_methods::{async_result, default_object, function as callback};
use crate::route_response::*;
use napi_derive::napi;
use std::ffi::CStr;

fn undef(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Undefined)
}
fn after<'a>(
    state: L<'a>,
    value: L<'a>,
    next: impl for<'b> Fn(L<'b>, L<'b>) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let promise = call(state.global()?.get(c"Promise")?, c"resolve", &[value])?;
    call(
        promise,
        c"then",
        &[callback(state, "", 1, 1, move |s, a| next(s, a[0]))?],
    )
}
fn saved<'a>(s: L<'a>, values: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let frame = fields(s, values)?;
    frame.set(c"host", s)?;
    Ok(frame)
}
fn scheduler(s: L<'_>) -> Result<L<'_>> {
    let rt = call(s.get(c"deps")?, c"runtime", &[])?;
    fallback(rt.optional(c"sessionScheduler")?, V::Null)
}
fn protocol<'a>(op: &str, input: L<'a>, vocab: bool) -> Result<L<'a>> {
    let json = input.global()?.get(c"JSON")?;
    let serialized = call(json, c"stringify", &[input])?
        .coerce_string()?
        .to_string_lossy();
    let output = if vocab {
        multicc_core::classify_vocab::request(op, &serialized)
    } else {
        multicc_core::session_question::request(op, &serialized)
    }
    .map_err(napi::Error::from_reason)?;
    call(json, c"parse", &[text(input, &output)?])
}
fn question<'a>(op: &str, input: L<'a>) -> Result<L<'a>> {
    protocol(op, input, false)
}
fn is_function(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_function)
}
fn bind<'a>(
    api: L<'a>,
    state: L<'a>,
    key: &'static CStr,
    length: usize,
    count: usize,
    execute: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<()> {
    api.set(
        key,
        callback(state, key.to_str().unwrap(), length, count, execute)?,
    )
}
fn create<'a>(ports: L<'a>, deps: L<'a>) -> Result<L<'a>> {
    let deps = default_object(deps)?;
    for key in [
        c"runtime".as_ref(),
        c"getRecord",
        c"getChatSession",
        c"getTaskState",
        c"pendingUserInput",
        c"recordUserInput",
        c"resolveUserInput",
        c"broadcast",
        c"setTaskState",
        c"onTaskBoardQueueEvent",
        c"onWorkspaceQueueStatus",
        c"classifyDisplay",
        c"cancelClassify",
        c"assignKillReason",
        c"finishProviderAttempt",
        c"appendMessage",
        c"cancelPreparation",
        c"dispatchStateAction",
    ] {
        if !is_function(deps.optional(key)?)? {
            return Err(ports.type_error(&format!(
                "[session-work-host] {} port is required",
                key.to_string_lossy()
            )));
        }
    }
    let stream = deps.get(c"chatStream")?;
    if !is_function(stream.optional(c"isAlive")?)? || !is_function(stream.optional(c"cancel")?)? {
        return Err(ports.type_error("[session-work-host] chatStream port is required"));
    }
    let api = fields(ports, &[])?;
    let s = fields(ports, &[("deps", deps), ("crypto", ports.get(c"crypto")?)])?;
    let log = deps.get(c"log")?;
    s.set(
        c"log",
        if log.truthy()? {
            log
        } else {
            ports.global()?.get(c"console")?
        },
    )?;
    for (key, check) in [
        (c"zcodeAuth".as_ref(), c"ensureZcodeAuth".as_ref()),
        (c"kimiAuth", c"ensureKimiAuth"),
    ] {
        let injected = deps.get(key)?;
        let auth = if injected.truthy()? {
            injected
        } else {
            ports.get(key)?
        };
        if !is_function(auth.get(check)?)? {
            return Err(ports.type_error(&format!(
                "[session-work-host] {}.{} is required",
                key.to_string_lossy(),
                check.to_string_lossy()
            )));
        }
        s.set(key, auth)?;
    }
    let map = ports.global()?.get(c"Map")?;
    for key in [
        c"turnClosures".as_ref(),
        c"pendingTransitions",
        c"classificationRetries",
        c"deadRunnerRetries",
        c"cancelOperations",
    ] {
        s.set(key, map.construct(&[])?)?;
    }
    transitions::install(s, api)?;
    events::install(s, api)?;
    cancel::install(s, api)?;
    // Installation is grouped by state ownership. Keep the enumerable facade
    // in its documented caller-visible order independently of that grouping.
    let public = fields(s, &[])?;
    for key in [
        c"admit".as_ref(),
        c"cancelActiveTurn",
        c"stopActiveTurnForProviderError",
        c"classifyTransition",
        c"classifyUnavailable",
        c"getRunState",
        c"hasQueuedDeliveries",
        c"isRunActive",
        c"moveInput",
        c"onSchedulerEvent",
        c"recordInput",
        c"recordInputAsync",
        c"recoveryState",
        c"recoveryStateAsync",
        c"recoveryFacts",
        c"replayState",
        c"replayStateAsync",
        c"resolveTask",
        c"dismissUserInput",
        c"settleRecoveredQuestion",
        c"turnFailed",
        c"turnSucceeded",
    ] {
        public.set(key, api.get(key)?)?;
    }
    public.freeze()
}

#[napi]
pub fn session_work_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let api = fields(ports, &[])?;
    bind(api, ports, c"createSessionWorkHost", 0, 1, |s, a| {
        create(s, a[0])
    })?;
    bind(api, ports, c"createProductionQuestionHost", 0, 1, |s, a| {
        questions::production(s, default_object(a[0])?)
    })?;
    bind(api, ports, c"createProductionWorkHost", 2, 2, |ports, a| {
        let deps = crate::js_live::spread(a[0])?;
        let host = a[1];
        deps.set(c"userInputSignalHost", host)?;
        for (key, method) in [
            (c"pendingUserInput".as_ref(), c"pending".as_ref()),
            (c"recordUserInput", c"record"),
            (c"resolveUserInput", c"resolve"),
            (c"moveUserInput", c"move"),
        ] {
            deps.set(key, host.get(method)?)?;
        }
        let work = crate::js_live::spread(create(ports, deps)?)?;
        work.set(c"recordInput", work.get(c"recordInputAsync")?)?;
        work.set(c"replayState", work.get(c"replayStateAsync")?)?;
        work.freeze()
    })?;
    bind(api, ports, c"createUserInputOwnedHost", 0, 1, |_, a| {
        questions::owned(default_object(a[0])?)
    })?;
    bind(api, ports, c"questionProtocol", 2, 2, |_, a| {
        question(&a[0].coerce_string()?.to_string_lossy(), a[1])
    })?;
    Ok(api.raw())
}

#[napi]
pub fn session_work_api(
    env: Env,
    addon: Unknown<'_>,
    load_ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let s = L::new(&env, addon);
    let api = fields(s, &[])?;
    api.spread_from(L::from_raw(
        s.env(),
        crate::session_work_scheduler::session_work_scheduler_api(env)?,
    ))?;
    let ports = L::new(&env, load_ports).call_plain(&[])?;
    api.spread_from(L::from_raw(
        s.env(),
        session_work_host_api(env, crate::host_methods::arg(ports)?)?,
    ))?;
    Ok(api.raw())
}
