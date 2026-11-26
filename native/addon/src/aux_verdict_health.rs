//! Project the public Aux freshness fields and notify sessions that display a verdict.
use crate::js_live::LiveValue;
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

pub(crate) fn freshness(provider: LiveValue<'_>, broadcast: bool) -> Result<LiveValue<'_>> {
    let null = provider.from_value(&JsValue::Null)?;
    let health = if provider.kind()? == sys::ValueType::napi_function {
        provider.catch(|| provider.call_plain(&[]))?.unwrap_or(null)
    } else {
        null
    };
    let unhealthy =
        health.kind()? == sys::ValueType::napi_object && health.get(c"unhealthy")?.truthy()?;
    let since = if unhealthy {
        health.get(c"sinceAt")?
    } else {
        null
    };
    let payload = provider.from_value(&JsValue::Object(Vec::new()))?;
    if broadcast {
        payload.set(
            c"type",
            provider.from_value(&JsValue::string("aux_verdict_staleness"))?,
        )?;
    }
    payload.set(
        c"auxUnhealthy",
        provider.from_value(&JsValue::Bool(unhealthy))?,
    )?;
    payload.set(
        c"auxUnhealthySince",
        if since.truthy()? { since } else { null },
    )?;
    Ok(payload)
}

#[napi]
pub fn aux_verdict_staleness(env: Env, provider: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(freshness(LiveValue::new(&env, provider), false)?.raw())
}

#[napi]
pub fn fan_out_aux_verdict_staleness(
    env: Env,
    provider: Unknown<'_>,
    sessions: Unknown<'_>,
    get_task_state: Unknown<'_>,
    chat_broadcast: Unknown<'_>,
    workspace_broadcast: Unknown<'_>,
) -> Result<f64> {
    fan_out(
        LiveValue::new(&env, provider),
        LiveValue::new(&env, sessions),
        LiveValue::new(&env, get_task_state),
        LiveValue::new(&env, chat_broadcast),
        LiveValue::new(&env, workspace_broadcast),
    )
}
pub(crate) fn fan_out<'a>(
    provider: LiveValue<'a>,
    sessions: LiveValue<'a>,
    state: LiveValue<'a>,
    chat: LiveValue<'a>,
    workspace: LiveValue<'a>,
) -> Result<f64> {
    let payload = freshness(provider, true)?;
    let mut told = 0.0;
    sessions.for_each(|entry| {
        let (id, record) = entry.iterator_pair()?;
        if !record.truthy()?
            || record.get(c"type")?.is_string("aux")?
            || record.get(c"type")?.is_string("gateway")?
        {
            return Ok(());
        }
        let task = state.call_plain(&[record])?;
        if !task.get(c"goal")?.truthy()? && !task.get(c"classifyState")?.truthy()? {
            return Ok(());
        }
        chat.catch(|| chat.call_plain(&[id, payload]))?;
        if record.get(c"dirId")?.truthy()? {
            workspace.catch(|| {
                let dir = record.get(c"dirId")?;
                let copy = payload.from_value(&JsValue::Object(Vec::new()))?;
                copy.spread_from(payload)?;
                copy.set(c"sessionId", id)?;
                workspace.call_plain(&[dir, copy])
            })?;
        }
        told += 1.0;
        Ok(())
    })?;
    Ok(told)
}
