use crate::{host_methods::function, route_response::*};
use napi_derive::napi;

#[napi]
pub fn fcm_credentials(env: Env, value: Unknown<'_>) -> Result<bool> {
    let p = L::new(&env, value);
    if !p.get(c"type")?.is_string("service_account")? {
        return Ok(false);
    }
    let id = p.get(c"project_id")?.coerce_string()?;
    let s = id.as_units();
    Ok((5..=63).contains(&s.len())
        && matches!(s[0], 97..=122)
        && s.iter().all(|c| matches!(c,97..=122|48..=57|45))
        && p.get(c"client_email")?.kind()? == sys::ValueType::napi_string
        && p.get(c"private_key")?.kind()? == sys::ValueType::napi_string)
}
#[napi]
pub fn fcm_token_claims(env: Env, email: Unknown<'_>, iat: f64) -> Result<sys::napi_value> {
    let p = L::new(&env, email);
    Ok(fields(
        p,
        &[
            ("iss", p),
            (
                "scope",
                text(p, "https://www.googleapis.com/auth/firebase.messaging")?,
            ),
            ("aud", text(p, "https://oauth2.googleapis.com/token")?),
            ("iat", num(p, iat)?),
            ("exp", num(p, iat + 3600.)?),
        ],
    )?
    .raw())
}
fn fcm_token_ttl(seconds: f64) -> f64 {
    (if seconds.is_nan() || seconds == 0. {
        3600.
    } else {
        seconds.min(3600.)
    }) * 1000.
}
#[napi]
pub fn fcm_message(env: Env, token: Unknown<'_>, data: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, token);
    let android = fields(
        p,
        &[("priority", text(p, "HIGH")?), ("ttl", text(p, "3600s")?)],
    )?;
    let msg = fields(
        p,
        &[
            ("token", p),
            ("data", L::new(&env, data)),
            ("android", android),
        ],
    )?;
    Ok(fields(p, &[("message", msg)])?.raw())
}
#[napi]
pub fn fcm_delivery(
    env: Env,
    response: Unknown<'_>,
    body: Unknown<'_>,
    invalidate: Unknown<'_>,
) -> Result<sys::napi_value> {
    let r = L::new(&env, response);
    let b = L::new(&env, body);
    let accepted =
        r.get(c"ok")?.truthy()? && b.get(c"name")?.kind()? == sys::ValueType::napi_string;
    let code = if accepted {
        "accepted"
    } else {
        if r.get(c"status")?.is_number(401.)? {
            L::new(&env, invalidate).call_plain(&[])?;
        }
        let details = b.get(c"error")?.optional(c"details")?;
        let stale = if details.nullish()? {
            false
        } else {
            let test = function(b, "", 1, 1, |_, a| {
                flag(
                    a[0],
                    a[0].get(c"@type")?
                        .is_string("type.googleapis.com/google.firebase.fcm.v1.FcmError")?
                        && a[0].get(c"errorCode")?.is_string("UNREGISTERED")?,
                )
            })?;
            call(details, c"some", &[test])?.truthy()?
        };
        if stale {
            "unregistered"
        } else {
            "rejected"
        }
    };
    Ok(fields(r, &[("ok", flag(r, accepted)?), ("code", text(r, code)?)])?.raw())
}

/// Scope the token to its transport. The injected clock and JS addition retain
/// their original coercion and getter ordering, including on a refresh.
#[napi]
pub fn fcm_token_cache(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let state = fields(p, &[("ports", p), ("entry", null(p)?)])?;
    let lookup = function(state, "lookup", 0, 0, |state, _| {
        let entry = state.get(c"entry")?;
        if !entry.nullish()?
            && call(state.get(c"ports")?, c"fresh", &[entry.get(c"expires")?])?.truthy()?
        {
            return state.get(c"entry")?.get(c"token");
        }
        state.from_value(&V::Undefined)
    })?;
    let remember = function(state, "remember", 2, 2, |state, a| {
        if !a[0].get(c"ok")?.truthy()?
            || a[1].get(c"access_token")?.kind()? != sys::ValueType::napi_string
        {
            return Err(state
                .global()?
                .get(c"Error")?
                .construct(&[text(state, "FCM_AUTH_FAILED")?])?
                .throw_error());
        }
        let token = a[1].get(c"access_token")?;
        let ports = state.get(c"ports")?;
        let now = call(ports, c"now", &[])?;
        let ttl = fcm_token_ttl(a[1].get(c"expires_in")?.explicit_number()?);
        let expires = call(ports, c"add", &[now, num(state, ttl)?])?;
        state.set(
            c"entry",
            fields(state, &[("token", token), ("expires", expires)])?,
        )?;
        Ok(token)
    })?;
    let clear = function(state, "clear", 0, 0, |state, _| {
        state.set(c"entry", null(state)?)?;
        state.from_value(&V::Undefined)
    })?;
    Ok(fields(
        p,
        &[("lookup", lookup), ("remember", remember), ("clear", clear)],
    )?
    .raw())
}
