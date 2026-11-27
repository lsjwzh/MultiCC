use crate::route_response::*;
use multicc_core::js::JsString as S;
use napi_derive::napi;
fn eq(s: &[u16], ascii: &str) -> bool {
    s.len() == ascii.len() && s.iter().zip(ascii.bytes()).all(|(&a, b)| a == u16::from(b))
}
fn redact(s: &[u16]) -> S {
    if ["pr1.", "mcr1.", "mcp1."]
        .iter()
        .any(|prefix| s.get(..prefix.len()).is_some_and(|p| eq(p, prefix)))
    {
        let mut out = S::from_units(s[..4].to_vec());
        out.push_str("<redacted>");
        out
    } else {
        S::from_units(s.to_vec())
    }
}
#[napi]
pub fn codex_trace_route(env: Env, url: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, url);
    let s = p.coerce_string()?;
    let path = s
        .as_units()
        .split(|&c| c == 63 || c == 35)
        .next()
        .unwrap_or_default();
    let parts = path.split(|&c| c == 47).map(redact).collect::<Vec<_>>();
    Ok(p.from_value(&V::String(
        S::join(&parts, &S::from("/")).truncate_units(300),
    ))?
    .raw())
}
#[napi]
pub fn codex_trace_parts(env: Env, url: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, url);
    let s = p.coerce_string()?;
    let mut parts = s
        .as_units()
        .split(|&c| c == 63)
        .next()
        .unwrap_or_default()
        .split(|&c| c == 47)
        .filter(|x| !x.is_empty());
    parts.find(|s| eq(s, "codex-proxy"));
    let val = |s: Option<&[u16]>| match s {
        Some(x) => p.from_value(&V::String(redact(x))),
        None => null(p),
    };
    let provider = val(parts.next())?;
    let session = parts.next().filter(|s| !eq(s, "responses"));
    let role = parts.next();
    let role = if session.is_some() && parts.next().is_some_and(|s| eq(s, "responses")) {
        val(role)?
    } else {
        null(p)?
    };
    Ok(fields(
        p,
        &[
            ("providerId", provider),
            ("session", val(session)?),
            ("role", role),
        ],
    )?
    .raw())
}
#[napi]
pub fn codex_trace_settle(
    env: Env,
    entry: Unknown<'_>,
    response: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<bool> {
    let e = L::new(&env, entry);
    let r = L::new(&env, response);
    let p = L::new(&env, ports);
    if e.get(c"ended")?.truthy()? {
        return Ok(false);
    }
    e.set(c"ended", flag(e, true)?)?;
    let status = if r.truthy()?
        && r.get(c"statusCode")?
            .number_value()?
            .is_some_and(|n| n.is_finite() && n.fract() == 0.)
    {
        r.get(c"statusCode")?
    } else {
        null(e)?
    };
    e.set(c"status", status)?;
    let locals = if r.truthy()? { r.get(c"locals")? } else { r };
    let stage = if locals.kind()? == sys::ValueType::napi_object {
        locals.get(c"multiccProxyStage")?
    } else {
        null(e)?
    };
    e.set(
        c"stage",
        if stage.kind()? == sys::ValueType::napi_string && stage.truthy()? {
            stage
        } else {
            text(e, "proxy")?
        },
    )?;
    e.set(c"durationMs", call(p, c"duration", &[e])?)?;
    let aborted = r.truthy()? && r.get(c"writableFinished")?.is_false()?;
    e.set(c"aborted", flag(e, aborted)?)?;
    e.set(
        c"expressResponded",
        if r.truthy()? && r.get(c"getHeader")?.kind()? == sys::ValueType::napi_function {
            flag(
                e,
                call(r, c"getHeader", &[text(e, "x-powered-by")?])?.truthy()?,
            )?
        } else {
            null(e)?
        },
    )?;
    Ok(e.get(c"stage")?.is_string("unmatched")?
        || aborted
        || status.is_number(404.)?
        || status.number_value()?.is_some_and(|n| n >= 500.))
}
