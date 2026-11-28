use napi::Result;
use napi_derive::napi;

#[napi]
pub fn record_secret_audit(file: String, input: String) -> Result<String> {
    multicc_core::secret_audit::record(&file, &input).map_err(napi::Error::from_reason)
}

use crate::{host_methods::function, route_response::*};

fn unavailable(p: L<'_>) -> Result<napi::Error> {
    let error = p.global()?.get(c"Error")?.construct(&[text(
        p,
        "Secret audit is unavailable; vault access cannot continue.",
    )?])?;
    error.set(c"code", text(p, "secret_audit_unavailable")?)?;
    error.set(c"statusCode", num(p, 503.)?)?;
    error.set(c"secretToolError", flag(p, true)?)?;
    Ok(error.throw_error())
}
fn record<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let output = p.catch(|| {
        let file = p
            .get(c"auditFile")?
            .call_plain(&[])?
            .coerce_string()?
            .to_string_lossy();
        let json = p.global()?.get(c"JSON")?;
        let input = call(json, c"stringify", &[input])?
            .coerce_string()?
            .to_string_lossy();
        let out = record_secret_audit(file, input)?;
        call(json, c"parse", &[text(p, &out)?])
    })?;
    match output {
        Some(v) => Ok(v),
        None => Err(unavailable(p)?),
    }
}
fn finish<'a>(s: L<'a>, result: L<'a>, error: L<'a>) -> Result<L<'a>> {
    let p = s.get(c"ports")?;
    let row = crate::js_live::spread(s.get(c"metadata")?)?;
    let op = row.get(c"operation")?;
    let summary = if op.is_string("env_inject")? || op.is_string("env_overlay")? {
        null(p)?
    } else {
        result
    };
    row.set(c"phase", text(p, "completed")?)?;
    let elapsed =
        call(p.global()?.get(c"Date")?, c"now", &[])?.number()? - s.get(c"started")?.number()?;
    row.set(c"durationMs", num(p, elapsed.max(0.))?)?;
    row.set(
        c"failed",
        flag(
            p,
            error.truthy()?
                || summary.optional(c"error")?.truthy()?
                || summary.optional(c"ok")?.is_false()?,
        )?,
    )?;
    let code = error.optional(c"code")?;
    if code.kind()? == sys::ValueType::napi_string {
        row.set(c"code", code)?;
    }
    for (source, key) in [(c"exit_code", c"exitCode"), (c"status", c"status")] {
        let v = summary.optional(source)?;
        if v.number_value()?
            .is_some_and(|n| n.is_finite() && n.fract() == 0.)
        {
            row.set(key, v)?;
        }
    }
    row.set(
        c"timedOut",
        flag(
            p,
            summary.optional(c"timed_out")?.is_true()? || code.is_string("http_timeout")?,
        )?,
    )?;
    row.set(
        c"aborted",
        flag(p, summary.optional(c"aborted")?.is_true()?)?,
    )?;
    let signal = summary.optional(c"signal")?;
    row.set(
        c"signaled",
        flag(
            p,
            signal.kind()? == sys::ValueType::napi_string && signal.truthy()?,
        )?,
    )?;
    record(p, row)?;
    if error.truthy()? {
        return Err(error.throw_error());
    }
    Ok(result)
}
#[napi]
pub fn audited_secret_call(
    env: Env,
    ports: Unknown<'_>,
    operation: Unknown<'_>,
    context: Unknown<'_>,
    names: Unknown<'_>,
    action: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let (op, ctx, names, action) = (
        L::new(&env, operation),
        L::new(&env, context),
        L::new(&env, names),
        L::new(&env, action),
    );
    let scope = p.get(c"scope")?;
    let inherited = call(scope, c"getStore", &[])?;
    if inherited.optional(c"operation")?.equals(op)? {
        return Ok(action.call_plain(&[])?.raw());
    }
    let row = fields(p, &[("operation", op)])?;
    for key in [c"source", c"sessionId", c"turnId", c"taskId"] {
        let v = ctx.optional(key)?;
        let v = if v.truthy()? {
            v
        } else {
            inherited.optional(key)?
        };
        row.set(
            key,
            if key == c"source" && !v.truthy()? {
                text(p, "internal")?
            } else {
                v
            },
        )?;
    }
    row.set(c"parentCallId", inherited.optional(c"callId")?)?;
    let filter = function(p, "name", 1, 1, |p, a| {
        flag(p, a[0].kind()? == sys::ValueType::napi_string)
    })?;
    row.set(
        c"names",
        if names.is_array()? {
            call(names, c"filter", &[filter])?
        } else {
            p.from_value(&V::Array(vec![]))?
        },
    )?;
    let start = crate::js_live::spread(row)?;
    start.set(c"phase", text(p, "started")?)?;
    row.set(c"callId", record(p, start)?.get(c"callId")?)?;
    let s = fields(
        p,
        &[
            ("metadata", row),
            ("action", action),
            ("started", call(p.global()?.get(c"Date")?, c"now", &[])?),
            ("ports", p),
        ],
    )?;
    let run = function(s, "execute", 0, 0, |s, _| {
        let result = match s.get(c"action")?.call_plain(&[]) {
            Ok(v) => v,
            Err(e) => {
                let cause = match s.exception_value()? {
                    Some(v) => v,
                    None => s
                        .global()?
                        .get(c"Error")?
                        .construct(&[text(s, &e.reason)?])?,
                };
                return finish(s, null(s)?, cause);
            }
        };
        if result.truthy()? && result.get(c"then")?.kind()? == sys::ValueType::napi_function {
            call(
                result,
                c"then",
                &[
                    function(s, "done", 1, 1, |s, a| finish(s, a[0], null(s)?))?,
                    function(s, "failed", 1, 1, |s, a| finish(s, null(s)?, a[0]))?,
                ],
            )
        } else {
            finish(s, result, null(s)?)
        }
    })?;
    Ok(call(scope, c"run", &[row, run])?.raw())
}
