//! Auxiliary runs are stored in the live log. Resolve the session before touching
//! the log, then choose the anchor, task or unfiltered index in that order.
use crate::{
    host_methods::call,
    js_live::{fields, LiveValue as L},
};
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn id<'a>(object: L<'a>, key: &CStr) -> Result<L<'a>> {
    let value = object.get(key)?;
    if !value.truthy()? {
        return object.from_value(&"".into());
    }
    object.global()?.get(c"String")?.call_plain(&[value])
}

fn missing<'a>(res: L<'a>, message: &str) -> Result<L<'a>> {
    let sender = call(res, c"status", &[res.from_value(&V::Number(404.0))?])?;
    call(
        sender,
        c"json",
        &[fields(res, &[("error", res.from_value(&message.into())?)])?],
    )
}

#[napi]
pub fn aux_run_response(
    env: Env,
    records: Unknown<'_>,
    get_log: Unknown<'_>,
    detail: bool,
    req: Unknown<'_>,
    res: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (req, res) = (L::new(&env, req), L::new(&env, res));
    let session = id(req.get(c"params")?, c"id")?;
    if !call(L::new(&env, records), c"get", &[session])?.truthy()? {
        return Ok(missing(res, "session not found")?.raw());
    }
    let log = L::new(&env, get_log).call_plain(&[])?;
    if detail {
        let run = log
            .get(c"get")?
            .call(log, &[session, id(req.get(c"params")?, c"runId")?])?;
        return Ok(if run.truthy()? {
            call(res, c"json", &[fields(res, &[("run", run)])?])?
        } else {
            missing(res, "aux run not found")?
        }
        .raw());
    }
    let message = id(req.get(c"query")?, c"messageId")?;
    let task = id(req.get(c"query")?, c"taskId")?;
    let number = req.global()?.get(c"Number")?;
    let parsed = number
        .get(c"parseInt")?
        .call(
            number,
            &[
                req.get(c"query")?.get(c"limit")?,
                req.from_value(&V::Number(10.0))?,
            ],
        )?
        .number()?;
    let limit = if parsed.is_nan() {
        0.0
    } else {
        parsed.clamp(0.0, 200.0)
    };
    let count = req.from_value(&V::Number(limit))?;
    let runs = if message.truthy()? {
        call(log, c"byAnchor", &[session, message])?
    } else if task.truthy()? {
        call(log, c"byTask", &[session, task])?
    } else {
        call(log, c"list", &[session, fields(req, &[("limit", count)])?])?
    };
    let json = res.get(c"json")?;
    let runs = if limit > 0.0 && runs.get(c"length")?.explicit_number()? > limit {
        call(runs, c"slice", &[req.from_value(&V::Number(-limit))?])?
    } else {
        runs
    };
    Ok(json.call(res, &[fields(res, &[("runs", runs)])?])?.raw())
}
