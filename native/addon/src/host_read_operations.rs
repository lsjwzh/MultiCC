//! Read the live Node services behind four loopback-only gateway ports.
//! Keep host objects, method receivers and exceptions in their original V8 realm.
use crate::{
    host_methods::call,
    js_live::{fields, invoke, LiveValue as L},
};
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn answer<'a>(body: L<'a>, values: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let result = fields(body, &[("ok", body.from_value(&V::Bool(true))?)])?;
    for &(key, value) in values {
        result.define_key(body.from_value(&key.into())?, value)?;
    }
    Ok(result)
}

fn unknown(body: L<'_>) -> Result<L<'_>> {
    fields(body, &[("ok", body.from_value(&V::Bool(false))?)])
}

// The legacy typeof guard and its successful branch each read the property.
fn string_field<'a>(body: L<'a>, key: &CStr, fallback: V) -> Result<L<'a>> {
    if body.get(key)?.kind()? == sys::ValueType::napi_string {
        body.get(key)
    } else {
        body.from_value(&fallback)
    }
}

#[napi]
pub fn agent_resource_operation(
    env: Env,
    runtime: Unknown<'_>,
    body: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (runtime, body) = (L::new(&env, runtime), L::new(&env, body));
    let op = if body.truthy()? {
        string_field(body, c"op", "".into())?
    } else {
        body.from_value(&"".into())?
    };
    let result = if op.is_string("skills")? {
        answer(
            body,
            &[(
                "skills",
                invoke(
                    runtime,
                    runtime.get(c"installedSkills")?,
                    &[],
                    "runtime.installedSkills",
                )?,
            )],
        )?
    } else if op.is_string("presets")? {
        invoke(
            runtime,
            runtime.get(c"presetsList")?,
            &[],
            "runtime.presetsList",
        )?
    } else if op.is_string("preset")? {
        invoke(
            runtime,
            runtime.get(c"presetLookup")?,
            &[string_field(body, c"id", "".into())?],
            "runtime.presetLookup",
        )?
    } else if op.is_string("claude-sessions")? {
        answer(
            body,
            &[(
                "sessions",
                invoke(
                    runtime,
                    runtime.get(c"claudeSessions")?,
                    &[],
                    "runtime.claudeSessions",
                )?,
            )],
        )?
    } else if op.is_string("claude-session-delete")? {
        invoke(
            runtime,
            runtime.get(c"removeClaudeSession")?,
            &[
                string_field(body, c"project", "".into())?,
                string_field(body, c"id", "".into())?,
            ],
            "runtime.removeClaudeSession",
        )?
    } else {
        unknown(body)?
    };
    Ok(result.raw())
}

#[napi]
pub fn token_usage_operation(
    env: Env,
    tracker: Unknown<'_>,
    body: Unknown<'_>,
    empty: Unknown<'_>,
    logger: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (tracker, body) = (L::new(&env, tracker), L::new(&env, body));
    if body.kind()? != sys::ValueType::napi_object || body.is_array()? {
        return Ok(unknown(body)?.raw());
    }
    let op = string_field(body, c"op", "".into())?;
    let payload = if op.is_string("snapshot")? {
        (|| {
            let value = invoke(
                tracker,
                tracker.get(c"snapshot")?,
                &[body.get(c"session")?],
                "tracker.snapshot",
            )?;
            Ok(if value.truthy()? {
                value
            } else {
                L::new(&env, empty)
            })
        })()
    } else if op.is_string("ledger")? {
        invoke(
            tracker,
            tracker.get(c"readLedger")?,
            &[],
            "tracker.readLedger",
        )
    } else {
        return Ok(unknown(body)?.raw());
    };
    Ok(match payload {
        Ok(value) => answer(body, &[("payload", value)])?,
        Err(error) => {
            let exception = body.exception_value()?.ok_or(error)?;
            let logger = L::new(&env, logger);
            if logger.truthy()? {
                logger.call_plain(&[
                    body.from_value(&"token_usage_role_read_failed".into())?,
                    exception,
                ])?;
            }
            unknown(body)?
        }
    }
    .raw())
}

#[napi]
pub fn scan_history_response(
    env: Env,
    history: Unknown<'_>,
    max_passes: f64,
    body: Unknown<'_>,
    response: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (body, history, res) = (
        L::new(&env, body),
        L::new(&env, history),
        L::new(&env, response),
    );
    if !body.get(c"op")?.is_string("snapshot")? {
        let res = call(res, c"status", &[body.from_value(&V::Number(400.0))?])?;
        return Ok(call(
            res,
            c"json",
            &[fields(
                body,
                &[("error", body.from_value(&"unknown host operation".into())?)],
            )?],
        )?
        .raw());
    }
    let limit = if body.get(c"limit")?.number_value()?.is_some()
        && body
            .get(c"limit")?
            .number_value()?
            .is_some_and(f64::is_finite)
    {
        body.get(c"limit")?
    } else {
        body.from_value(&V::Number(20.0))?
    };
    let limit = call(
        body.global()?.get(c"Math")?,
        c"min",
        &[limit, body.from_value(&V::Number(max_passes))?],
    )?;
    let json = res.get(c"json")?;
    let seq = history.get(c"seq")?;
    let kept = history.get(c"passes")?.get(c"length")?;
    let passes = call(
        history.get(c"passes")?,
        c"slice",
        &[body.from_value(&V::Number(0.0))?, limit],
    )?;
    Ok(json
        .call(
            res,
            &[fields(
                body,
                &[("seq", seq), ("kept", kept), ("passes", passes)],
            )?],
        )?
        .raw())
}

fn nullable(value: L<'_>) -> Result<L<'_>> {
    if value.truthy()? {
        Ok(value)
    } else {
        value.from_value(&V::Null)
    }
}

#[napi]
pub fn turn_ledger_operation(
    env: Env,
    deps: Unknown<'_>,
    input: Unknown<'_>,
    trust: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (deps, input) = (L::new(&env, deps), L::new(&env, input));
    let body = if input.kind()? == sys::ValueType::napi_object {
        input
    } else {
        fields(input, &[])?
    };
    let id = body.get(c"sessionId")?;
    let id = if id.kind()? == sys::ValueType::napi_string {
        id
    } else {
        body.from_value(&"".into())?
    };
    let record = body.get(c"op")?.is_string("ledger")?;
    let result = if record || body.get(c"op")?.is_string("launch")? {
        let launch = nullable(invoke(deps, deps.get(c"launch")?, &[id], "deps.launch")?)?;
        let out = answer(body, &[("launch", launch)])?;
        if record {
            out.set(
                c"record",
                nullable(invoke(deps, deps.get(c"record")?, &[id], "deps.record")?)?,
            )?;
        }
        out
    } else if body.get(c"op")?.is_string("trust")? {
        L::new(&env, trust).call_plain(&[body])?
    } else {
        unknown(body)?
    };
    Ok(result.raw())
}

#[napi]
pub fn turn_ledger_trust(
    env: Env,
    deps: Unknown<'_>,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (deps, body) = (L::new(&env, deps), L::new(&env, input));
    let trust = deps.get(c"trust")?;
    let write = body.from_value(&V::Bool(body.get(c"write")?.is_true()?))?;
    let text = |key| -> Result<_> {
        let val = body.get(key)?;
        if val.kind()? == sys::ValueType::napi_string {
            Ok(val)
        } else {
            body.from_value(&V::Null)
        }
    };
    Ok(invoke(
        deps,
        trust,
        &[fields(
            body,
            &[
                ("write", write),
                ("codexHome", text(c"codexHome")?),
                ("cwd", text(c"cwd")?),
            ],
        )?],
        "deps.trust",
    )?
    .raw())
}
