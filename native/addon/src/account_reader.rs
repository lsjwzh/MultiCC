//! Coalesce credential reads by vendor/account until the cache write settles.
//! Credential adapters and the optional fetch implementation belong to Node.
use crate::{
    host_methods::{async_result, default_object, function},
    route_response::*,
};
use napi_derive::napi;
fn status<'a>(p: L<'a>, value: &str) -> Result<L<'a>> {
    fields(p, &[("status", text(p, value)?)])
}
fn once(s: L<'_>) -> Result<L<'_>> {
    let owner = s.get(c"owner")?;
    let deps = owner.get(c"deps")?;
    let p = owner.get(c"ports")?;
    let id = s.get(c"id")?;
    let vendor = owner.get(c"vendor")?;
    if vendor.is_string("codex")? {
        let auth = if !id.truthy()? {
            call(p, c"defaultCodexAuth", &[])?
        } else {
            let resolve = deps.get(c"resolveAccountAuthFile")?;
            if resolve.nullish()? {
                return status(s, "no_auth");
            }
            resolve.call(deps, &[id])?
        };
        if !auth.truthy()? {
            return status(s, "no_auth");
        }
        return call(
            p,
            c"query",
            &[
                fields(s, &[("vendor", vendor), ("authFile", auth)])?,
                fields(s, &[("fetch", deps.get(c"fetch")?)])?,
            ],
        );
    }
    let credential = if id.truthy()? {
        call(deps.get(c"credentials")?, c"peekAccountToken", &[id])?
    } else {
        let reader = deps.get(c"readCliCredentials")?;
        if reader.truthy()? {
            reader.call_plain(&[])?
        } else {
            call(p, c"readCliCredentials", &[])?
        }
    };
    let pending = call(p.global()?.get(c"Promise")?, c"resolve", &[credential])?;
    call(
        pending,
        c"then",
        &[function(s, "queryCredential", 1, 1, |s, a| {
            let owner = s.get(c"owner")?;
            let r = a[0];
            let token = if s.get(c"id")?.truthy()? {
                r.optional(c"token")?
            } else if r.optional(c"ok")?.truthy()?
                && (r.get(c"expiresAt")?.nullish()?
                    || r.get(c"expiresAt")?.number()?
                        > call(s.global()?.get(c"Date")?, c"now", &[])?.number()?)
            {
                r.get(c"accessToken")?
            } else {
                s.from_value(&V::Undefined)?
            };
            call(
                owner.get(c"ports")?,
                c"query",
                &[
                    fields(s, &[("vendor", owner.get(c"vendor")?), ("token", token)])?,
                    fields(s, &[("fetch", owner.get(c"deps")?.get(c"fetch")?)])?,
                ],
            )
        })?],
    )
}
fn read<'a>(owner: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let vendor = owner.get(c"vendor")?;
    let p = owner.get(c"ports")?;
    if vendor.is_string("claude")? && id.truthy()? {
        let list = call(
            owner.get(c"deps")?.get(c"accounts")?,
            c"listClaudeAccounts",
            &[],
        )?;
        let matched = function(id, "matches", 1, 1, |id, a| {
            flag(id, a[0].get(c"id")?.equals(id)?)
        })?;
        if !call(list, c"some", &[matched])?.truthy()? {
            return status(p, "no_auth");
        }
    }
    let key = p.from_value(&V::String(multicc_core::js::JsString::concat(&[
        &vendor.coerce_string()?,
        &"\0".into(),
        &id.coerce_string()?,
    ])))?;
    let pending = p.get(c"pending")?;
    if call(pending, c"has", &[key])?.truthy()? {
        return call(pending, c"get", &[key]);
    }
    let attempt = call(p.global()?.get(c"Date")?, c"now", &[])?;
    let s = fields(
        p,
        &[
            ("owner", owner),
            ("id", id),
            ("attemptAt", attempt),
            ("key", key),
        ],
    )?;
    let result = async_result(s, || once(s))?;
    let observed = call(
        result,
        c"catch",
        &[function(s, "failed", 1, 1, |s, a| {
            status(
                s,
                if a[0].optional(c"status")?.is_number(401.)? {
                    "no_auth"
                } else {
                    "unavailable"
                },
            )
        })?],
    )?;
    let recorded = call(
        observed,
        c"then",
        &[function(s, "record", 1, 1, |s, a| {
            let owner = s.get(c"owner")?;
            let recorded = call(
                owner.get(c"ports")?.get(c"cache")?,
                c"record",
                &[
                    owner.get(c"vendor")?,
                    s.get(c"id")?,
                    a[0],
                    s.get(c"attemptAt")?,
                ],
            )?;
            let done = function(a[0], "result", 0, 0, |result, _| Ok(result))?;
            call(recorded, c"then", &[done, done])
        })?],
    )?;
    let result = call(
        recorded,
        c"finally",
        &[function(s, "finished", 0, 0, |s, _| {
            call(
                s.get(c"owner")?.get(c"ports")?.get(c"pending")?,
                c"delete",
                &[s.get(c"key")?],
            )
        })?],
    )?;
    call(pending, c"set", &[key, result])?;
    Ok(result)
}
#[napi]
pub fn account_reader_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    p.set(c"pending", p.global()?.get(c"Map")?.construct(&[])?)?;
    let register = function(p, "registerAccountSubscriptionReader", 1, 2, |p, a| {
        let owner = fields(
            p,
            &[
                ("ports", p),
                ("vendor", a[0]),
                ("deps", default_object(a[1])?),
            ],
        )?;
        let reader = function(owner, "read", 1, 1, |s, a| {
            async_result(s, || read(s, a[0]))
        })?;
        call(p.get(c"cache")?, c"register", &[a[0], reader])?;
        Ok(reader)
    })?;
    Ok(fields(
        p,
        &[
            ("query", p.get(c"query")?),
            ("registerAccountSubscriptionReader", register),
        ],
    )?
    .raw())
}
