//! 适配器完成证据与流收尾。V8 在 Promise 结算时调用这些入口。
use super::host_evidence;
use crate::{js_iteration::read, js_live::LiveValue};
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn settle<'a>(
    runner: LiveValue<'a>,
    boundary: LiveValue<'a>,
    logger: LiveValue<'a>,
    assign: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let tracker = read(runner, c"completion")?;
    let mut outcome = tracker;
    if !tracker.nullish()? {
        let finish = tracker.get(c"finish")?;
        if finish.kind()? != sys::ValueType::napi_function {
            return Err(finish.type_error("runner.completion?.finish is not a function"));
        }
        outcome = finish.call(tracker, &[boundary])?;
    }
    if !outcome.truthy()? {
        outcome = host_evidence(
            runner,
            "unknown",
            runner.from_value(&"completion_tracker_missing".into())?,
        )?;
    }
    set_outcome(assign, runner, outcome)?;

    let info = logger.optional(c"info")?;
    if !info.nullish()? {
        let fields = runner.from_value(&JsValue::Object(vec![]))?;
        fields.set(c"turnId", runner.get(c"turnId")?)?;
        fields.set(c"runnerId", runner.get(c"runnerId")?)?;
        fields.set(
            c"sessionId",
            runner.get(c"providerAttempt")?.optional(c"sessionId")?,
        )?;
        fields.set(
            c"routeAttemptId",
            runner
                .get(c"providerAttempt")?
                .optional(c"routeAttemptId")?,
        )?;
        fields.set(c"boundary", read(boundary, c"kind")?)?;
        fields.set(c"completion", outcome)?;
        if info.kind()? != sys::ValueType::napi_function {
            return Err(info.type_error("logger?.info is not a function"));
        }
        info.call(
            logger,
            &[
                runner.from_value(&"chat_adapter_completion".into())?,
                fields,
            ],
        )?;
    }
    Ok(outcome)
}

// Use V8's strict assignment to preserve Proxy/setter errors and their messages.
fn set_outcome<'a>(
    assign: LiveValue<'a>,
    runner: LiveValue<'a>,
    outcome: LiveValue<'a>,
) -> Result<()> {
    assign.call_plain(&[
        runner,
        runner.from_value(&"completionOutcome".into())?,
        outcome,
    ])?;
    Ok(())
}

#[napi]
pub fn cli_settle_adapter_completion(
    env: Env,
    runner: Unknown<'_>,
    boundary: Unknown<'_>,
    logger: Unknown<'_>,
    assign: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(settle(
        LiveValue::new(&env, runner),
        LiveValue::new(&env, boundary),
        LiveValue::new(&env, logger),
        LiveValue::new(&env, assign),
    )?
    .raw())
}

#[napi]
pub fn cli_settle_completion_stream(
    env: Env,
    ports: Unknown<'_>,
    rejected: bool,
    error: Unknown<'_>,
) -> Result<sys::napi_value> {
    let ports = LiveValue::new(&env, ports);
    let runner = ports.get(c"runner")?;
    let boundary = ports.from_value(&JsValue::object(vec![
        ("kind", "stream".into()),
        (if rejected { "rejected" } else { "resolved" }, true.into()),
    ]))?;
    boundary.set(c"killReason", read(runner, c"killReason")?)?;
    settle(
        runner,
        boundary,
        ports.get(c"logger")?,
        ports.get(c"assignHostProperty")?,
    )?;
    // 原实现的 finally 返回 finalize()，即使 onRejected 同步抛错也继续。
    if rejected {
        ports.catch(|| {
            ports
                .get(c"onRejected")?
                .call_plain(&[LiveValue::new(&env, error)])
        })?;
    }
    Ok(call_hook(ports.get(c"finalize")?, "finalize", &[])?.raw())
}

#[napi]
pub fn cli_fail_completion_stream(
    env: Env,
    ports: Unknown<'_>,
    error: Unknown<'_>,
) -> Result<sys::napi_value> {
    let ports = LiveValue::new(&env, ports);
    let runner = ports.get(c"runner")?;
    let evidence = host_evidence(
        runner,
        "failed",
        runner.from_value(&"finalization_failed".into())?,
    )?;
    let settled = runner.from_value(&JsValue::Object(vec![]))?;
    settled.spread_from(evidence)?;
    settled.set(c"settled", runner.from_value(&true.into())?)?;
    set_outcome(ports.get(c"assignHostProperty")?, runner, settled.freeze()?)?;
    Ok(call_hook(
        ports.get(c"onFinalizeError")?,
        "onFinalizeError",
        &[LiveValue::new(&env, error)],
    )?
    .raw())
}

fn call_hook<'a>(
    function: LiveValue<'a>,
    label: &str,
    args: &[LiveValue<'a>],
) -> Result<LiveValue<'a>> {
    if function.kind()? != sys::ValueType::napi_function {
        return Err(function.type_error(&format!("{label} is not a function")));
    }
    function.call_plain(args)
}
