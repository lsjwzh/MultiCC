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
