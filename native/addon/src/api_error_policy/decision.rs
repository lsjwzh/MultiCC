//! An error projection and a retry see the same cached entitlement marker.
//! The host supplies bounded metadata extraction, a clock and jitter.
use super::*;
use crate::{
    js_live::{fields, spread},
    route_response::{call, flag, null, text},
};
use napi::bindgen_prelude::FromNapiValue;
type L<'a> = LiveValue<'a>;
fn unknown(v: L<'_>) -> Result<Unknown<'_>> {
    unsafe { Unknown::from_napi_value(v.env(), v.raw()) }
}
fn local<'a>(v: L<'a>, raw: sys::napi_value) -> L<'a> {
    L::from_raw(v.env(), raw)
}
fn object(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_object && !v.nullish()?)
}
fn clock<'a>(p: L<'a>, deps: L<'a>) -> Result<L<'a>> {
    if deps.get(c"now")?.kind()? == sys::ValueType::napi_function {
        let at = call(deps, c"now", &[])?;
        p.global()?.get(c"Number")?.call_plain(&[at])
    } else {
        call(p.global()?.get(c"Date")?, c"now", &[])
    }
}
fn prepared<'a>(p: L<'a>, raw: L<'a>, ctx: L<'a>) -> Result<L<'a>> {
    let env = Env::from_raw(p.env());
    let selection = local(p, api_error_prepare(env, unknown(raw)?, unknown(ctx)?)?);
    let source = selection.get(c"source")?;
    let provider = selection.get(c"provider")?;
    let rejection = selection.get(c"rejection")?;
    let trusted = call(p.get(c"trusted")?, c"has", &[source])?.truthy()?;
    let failure = if trusted {
        let input = spread(raw)?;
        for key in [c"category", c"code"] {
            if ctx.get(key)?.truthy()? {
                input.define_key(text(p, key.to_str().expect("static key"))?, ctx.get(key)?)?;
            }
        }
        if provider.is_string("opencode")? {
            p.catch(|| {
                let bounded = p.get(c"errorFields")?.call_plain(&[input])?;
                let json = p.global()?.get(c"JSON")?;
                let wire = call(
                    json,
                    c"stringify",
                    &[fields(
                        p,
                        &[
                            ("provider", provider),
                            ("source", source),
                            ("error", bounded),
                        ],
                    )?],
                )?;
                let outcome = crate::opencode_error::classify_provider_error(
                    wire.coerce_string()?.to_string_lossy(),
                )?;
                call(json, c"parse", &[text(p, &outcome)?])
            })?
            .unwrap_or(null(p)?)
        } else {
            null(p)?
        }
    } else {
        null(p)?
    };
    let upstream = if trusted {
        p.get(c"extract")?.call_plain(&[raw])?
    } else {
        fields(p, &[])?
    };
    let rejection = crate::api_error_text::normalize_rejection(rejection)?;
    fields(
        p,
        &[
            ("source", source),
            ("provider", provider),
            ("failure", failure),
            ("upstream", upstream),
            ("rejection", rejection),
        ],
    )
}
fn share<'a>(p: L<'a>, value: L<'a>, flagged: bool, freeze: bool) -> Result<L<'a>> {
    let err = value.get(c"error")?;
    let holder = if object(err)? { err } else { value };
    let rejection = holder.get(c"rejection")?;
    if object(rejection)? {
        if flagged {
            if p.get(c"shared")?.nullish()? {
                p.set(c"shared", rejection.freeze()?)?;
            }
            holder.assign(c"rejection", p.get(c"shared")?)?;
        } else if freeze
            && !call(p.global()?.get(c"Object")?, c"isFrozen", &[rejection])?.truthy()?
        {
            rejection.freeze()?;
        }
    }
    Ok(value)
}
pub(crate) fn decide<'a>(p: L<'a>, raw: L<'a>, ctx: L<'a>, deps: L<'a>) -> Result<L<'a>> {
    let env = Env::from_raw(p.env());
    let at = clock(p, deps)?;
    let random = if deps.get(c"random")?.kind()? == sys::ValueType::napi_function {
        deps.get(c"random")?
    } else {
        p.global()?.get(c"Math")?.get(c"random")?
    };
    let known =
        raw.truthy()? && call(p.get(c"categories")?, c"has", &[raw.get(c"category")?])?.truthy()?;
    let facts = if known {
        fields(
            p,
            &[
                ("source", text(p, "")?),
                ("provider", text(p, "")?),
                ("failure", null(p)?),
                ("upstream", fields(p, &[])?),
                ("rejection", null(p)?),
            ],
        )?
    } else {
        prepared(p, raw, ctx)?
    };
    facts.set(c"now", at)?;
    facts.set(c"known", flag(p, known)?)?;
    let answer = local(
        p,
        api_error_decide(
            env,
            unknown(raw)?,
            unknown(ctx)?,
            unknown(facts)?,
            unknown(random)?,
        )?,
    );
    let shared = p.get(c"shared")?;
    let carried = raw.truthy()? && !shared.nullish()? && raw.get(c"rejection")?.equals(shared)?;
    let input = if object(raw)? {
        raw.get(c"rejection")?
    } else {
        null(p)?
    };
    let frozen =
        object(input)? && call(p.global()?.get(c"Object")?, c"isFrozen", &[input])?.truthy()?;
    let result = share(
        p,
        answer.get(c"result")?,
        answer.get(c"textEntitlement")?.truthy()? || carried,
        !known || frozen,
    )?;
    let err = result.get(c"error")?;
    if object(err)? && !call(p.global()?.get(c"Object")?, c"isFrozen", &[err])?.truthy()? {
        err.freeze()?;
    }
    result.freeze()
}
#[napi]
pub fn api_policy_decision(
    env: Env,
    ports: Unknown<'_>,
    raw: Unknown<'_>,
    context: Unknown<'_>,
    deps: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(decide(
        L::new(&env, ports),
        L::new(&env, raw),
        L::new(&env, context),
        L::new(&env, deps),
    )?
    .raw())
}
#[napi]
pub fn api_policy_normalized(
    env: Env,
    ports: Unknown<'_>,
    raw: Unknown<'_>,
    context: Unknown<'_>,
    deps: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let raw = L::new(&env, raw);
    let ctx = L::new(&env, context);
    let at = clock(p, L::new(&env, deps))?;
    let facts = prepared(p, raw, ctx)?;
    facts.set(c"now", at)?;
    let answer = local(
        p,
        api_error_normalize(env, unknown(raw)?, unknown(ctx)?, unknown(facts)?)?,
    );
    Ok(share(
        p,
        answer.get(c"result")?,
        answer.get(c"textEntitlement")?.truthy()?,
        true,
    )?
    .freeze()?
    .raw())
}
