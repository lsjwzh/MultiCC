//! Header and response eligibility rules for the Express compatibility host.
use crate::route_response::*;
use multicc_core::js::JsString;
use napi_derive::napi;

fn word(unit: u16) -> bool {
    u8::try_from(unit).is_ok_and(|c| c.is_ascii_alphanumeric() || c == b'_')
}
fn literal(units: &[u16], token: &[u8]) -> bool {
    units.len() == token.len()
        && units
            .iter()
            .zip(token)
            .all(|(&u, c)| u8::try_from(u).is_ok_and(|v| v.eq_ignore_ascii_case(c)))
}
fn header(value: L<'_>) -> Result<JsString> {
    Ok(string(fallback(value, "".into())?)?
        .string()?
        .unwrap_or_default())
}
fn json<'a>(res: L<'a>, ports: L<'a>) -> Result<bool> {
    let s = header(call(ports, c"get", &[res, text(res, "Content-Type")?])?)?;
    let token = b"application/json";
    let units = s.as_units();
    Ok(units.len() >= token.len()
        && literal(&units[..token.len()], token)
        && !units.get(token.len()).is_some_and(|u| word(*u)))
}
#[napi]
pub fn response_accepts_gzip(env: Env, value: Unknown<'_>) -> Result<bool> {
    let s = header(L::new(&env, value))?;
    let u = s.as_units();
    Ok(u.windows(4).enumerate().any(|(i, t)| {
        literal(t, b"gzip")
            && (i == 0 || !word(u[i - 1]))
            && !u.get(i + 4).is_some_and(|n| word(*n))
    }))
}
#[napi]
pub fn response_json_vary(env: Env, response: Unknown<'_>, ports: Unknown<'_>) -> Result<()> {
    let res = L::new(&env, response);
    let ports = L::new(&env, ports);
    if res.get(c"headersSent")?.truthy()? || !json(res, ports)? {
        return Ok(());
    }
    let mut vary = header(call(ports, c"get", &[res, text(res, "Vary")?])?)?;
    for token in vary.as_units().split(|u| *u == 44) {
        let token = JsString::from_units(token.to_vec()).trim();
        if literal(token.as_units(), b"accept-encoding") || literal(token.as_units(), b"*") {
            return Ok(());
        }
    }
    if !vary.is_empty() {
        vary.push(&", ".into());
    }
    vary.push(&"Accept-Encoding".into());
    call(
        ports,
        c"set",
        &[res, text(res, "Vary")?, res.from_value(&V::String(vary))?],
    )?;
    Ok(())
}
#[napi]
pub fn response_json_eligible(
    env: Env,
    response: Unknown<'_>,
    body: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<bool> {
    let res = L::new(&env, response);
    let ports = L::new(&env, ports);
    if L::new(&env, body).nullish()? || res.get(c"headersSent")?.truthy()? {
        return Ok(false);
    }
    if call(ports, c"below200", &[res.get(c"statusCode")?])?.truthy()?
        || res.get(c"statusCode")?.is_number(204.)?
        || res.get(c"statusCode")?.is_number(304.)?
    {
        return Ok(false);
    }
    if call(ports, c"get", &[res, text(res, "Content-Encoding")?])?.truthy()? {
        return Ok(false);
    }
    json(res, ports)
}

/// Express and Buffer stay in the host. Rust installs and restores the
/// one-shot end hook and owns all response eligibility and header decisions.
#[napi]
pub fn json_compression_middleware(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    use crate::host_methods::{arg, env as scope, function};
    let p = L::new(&env, ports);
    Ok(function(p, "jsonCompression", 3, 3, |p, a| {
        let (req, res, next) = (a[0], a[1], a[2]);
        if req.get(c"method")?.is_string("HEAD")?
            || !call(req.get(c"path")?, c"startsWith", &[text(p, "/api/")?])?.truthy()?
        {
            return next.call_plain(&[]);
        }
        let gzip = response_accepts_gzip(
            scope(p),
            arg(req.get(c"headers")?.get(c"accept-encoding")?)?,
        )?;
        let state = fields(
            p,
            &[
                ("ports", p),
                ("gzip", flag(p, gzip)?),
                ("res", res),
                ("end", res.get(c"end")?),
            ],
        )?;
        let hook = function(state, "endMaybeCompressed", 3, 3, |s, a| {
            let res = s.get(c"res")?;
            let end = s.get(c"end")?;
            res.assign(c"end", end)?;
            let p = s.get(c"ports")?;
            let (chunk, mut encoding, mut callback) = (a[0], a[1], a[2]);
            if chunk.kind()? == sys::ValueType::napi_function {
                return end.call(res, &[chunk]);
            }
            if encoding.kind()? == sys::ValueType::napi_function {
                callback = encoding;
                encoding = p.from_value(&V::Undefined)?;
            }
            response_json_vary(scope(p), arg(res)?, arg(p)?)?;
            if !s.get(c"gzip")?.truthy()?
                || !response_json_eligible(scope(p), arg(res)?, arg(chunk)?, arg(p)?)?
                || !call(p, c"largeEnough", &[chunk, encoding])?.truthy()?
            {
                return end.call(res, &[chunk, encoding, callback]);
            }
            let body = call(p, c"buffer", &[chunk, encoding])?;
            let pending = fields(
                s,
                &[
                    ("res", res),
                    ("end", end),
                    ("body", body),
                    ("callback", callback),
                ],
            )?;
            let done = function(pending, "compressed", 2, 2, |s, a| {
                let res = s.get(c"res")?;
                let body = if a[0].truthy()? || res.get(c"headersSent")?.truthy()? {
                    s.get(c"body")?
                } else {
                    call(
                        res,
                        c"setHeader",
                        &[text(s, "Content-Encoding")?, text(s, "gzip")?],
                    )?;
                    call(
                        res,
                        c"setHeader",
                        &[text(s, "Content-Length")?, a[1].get(c"length")?],
                    )?;
                    a[1]
                };
                s.get(c"end")?.call(res, &[body, s.get(c"callback")?])
            })?;
            call(p, c"gzip", &[body, done])?;
            Ok(res)
        })?;
        res.assign(c"end", hook)?;
        next.call_plain(&[])?;
        p.from_value(&V::Undefined)
    })?
    .raw())
}
