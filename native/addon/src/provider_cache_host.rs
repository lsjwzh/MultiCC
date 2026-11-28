//! Submission ordering and committed-entry delivery on the isolate that owns the JS listeners.
use crate::host_api::*;
use napi_derive::napi;

fn invoke<'a>(p: L<'a>, op: L<'a>, input: L<'a>) -> Result<L<'a>> {
    call(p, c"submit", &[p.get(c"handle")?, op, input])
}
fn drain<'a>(p: L<'a>, promise: L<'a>) -> Result<()> {
    let ignore = function(p, "settled", 0, 0, |p, _| undef(p))?;
    p.set(c"tail", call(promise, c"then", &[ignore, ignore])?)
}
fn queue<'a>(p: L<'a>, op: &str, input: L<'a>) -> Result<L<'a>> {
    if p.get(c"closed")?.truthy()? {
        return call(
            p.global()?.get(c"Promise")?,
            c"reject",
            &[error_value(
                p,
                &format!(
                    "[provider-limit-cache] database is closed: {}",
                    fold_string(p.get(c"file")?)?
                ),
            )?],
        );
    }
    let ctx = fields(p, &[("ports", p), ("op", text(p, op)?), ("input", input)])?;
    let ready = then(p.get(c"tail")?, p.get(c"opening")?, constant)?;
    let result = then(ready, ctx, |ctx, _| {
        let p = ctx.get(c"ports")?;
        let op = ctx.get(c"op")?;
        let input = ctx.get(c"input")?;
        // A caller can update the keep-set while an earlier write is pending.
        let input = if op.is_string("prune")? {
            fields(
                p,
                &[(
                    "liveKeys",
                    call(p.global()?.get(c"Array")?, c"from", &[input])?,
                )],
            )?
        } else {
            input
        };
        let response = invoke(p, op, input)?;
        if !matches!(
            fold_string(op)?.as_str(),
            "record"
                | "recordFailure"
                | "recordDerived"
                | "transitionAvailability"
                | "recordVirtualFailure"
        ) {
            return Ok(response);
        }
        then(response, ctx, |ctx, a| {
            let p = ctx.get(c"ports")?;
            let op = ctx.get(c"op")?;
            let plan = a[0];
            let failure = op.is_string("recordFailure")?;
            let entry = if failure { plan } else { plan.get(c"entry")? };
            if failure || plan.get(c"write")?.truthy()? {
                p.get(c"listeners")?.for_each(|f| {
                    p.catch(|| f.call_plain(&[entry]))?;
                    Ok(())
                })?;
                let f = p.get(c"onRecord")?;
                if !failure && callable(f)? {
                    ignored(p, || f.call_plain(&[entry]))?;
                }
            }
            if op.is_string("transitionAvailability")? {
                Ok(plan)
            } else {
                Ok(entry)
            }
        })
    })?;
    drain(p, result)?;
    Ok(result)
}
fn identity<'a>(app: L<'a>, id: L<'a>) -> Result<L<'a>> {
    fields(
        app,
        &[("appType", string(app)?), ("providerId", string(id)?)],
    )
}
fn transaction<'a>(p: L<'a>, a: &[L<'a>], op: &str, has_operation: bool) -> Result<L<'a>> {
    let offset = usize::from(has_operation);
    let at = a[3 + offset];
    let at = if at.undefined()? { now(p)? } else { at };
    let input = identity(a[0], a[1])?;
    if has_operation {
        input.set(c"operation", a[2])?;
    }
    input.set(c"arguments", a[2 + offset])?;
    input.set(c"now", num(p, at.explicit_number()?)?)?;
    queue(p, op, input)
}
#[napi]
pub fn provider_cache_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let file = p.get(c"file")?;
    if file.kind()? != sys::ValueType::napi_string || !file.truthy()? {
        return Err(
            p.type_error("[provider-limit-cache] createProviderLimitCache requires { file }")
        );
    }
    if !callable(p.get(c"now")?)? {
        return Err(p.type_error("[provider-limit-cache] now must be a function"));
    }
    let owner = p.get(c"Owner")?;
    if !callable(owner)? {
        return Err(error_value(
            p,
            "[provider-limit-cache] Rust storage unavailable; rebuild the native module",
        )?
        .throw_error());
    }
    p.set(c"handle", owner.construct(&[])?)?;
    p.set(c"listeners", p.global()?.get(c"Set")?.construct(&[])?)?;
    p.set(c"migration", null(p)?)?;
    p.set(c"tail", resolved(undef(p)?)?)?;
    let opening = invoke(
        p,
        text(p, "open")?,
        fields(
            p,
            &[
                ("file", file),
                ("legacyFile", p.get(c"legacyJsonFile")?),
                ("now", num(p, now(p)?.explicit_number()?)?),
            ],
        )?,
    )?;
    let opening = then(opening, p, |p, a| {
        let migration = spread(a[0])?.freeze()?;
        p.set(c"migration", migration)?;
        let logger = p.get(c"logger")?;
        if migration.get(c"migrated")?.truthy()? && logger.optional(c"log")?.truthy()? {
            call(
                logger,
                c"log",
                &[text(
                    p,
                    &format!(
                        "[multicc/provider-limit-cache] imported {} legacy entries into {}",
                        fold_string(migration.get(c"legacyEntryCount")?)?,
                        fold_string(p.get(c"file")?)?
                    ),
                )?],
            )?;
        }
        Ok(migration)
    })?;
    p.set(c"opening", opening)?;
    recover(opening, p, |p, _| undef(p))?;
    let api = methods(
        p,
        &[
            ("ready", 0, |p, _| p.get(c"opening")),
            ("idle", 0, |p, _| {
                then(p.get(c"tail")?, p.get(c"opening")?, constant)
            }),
            ("key", 2, |_, a| {
                call(string(a[0])?, c"concat", &[text(a[0], ":")?, string(a[1])?])
            }),
            ("subscribe", 1, |p, a| {
                let set = p.get(c"listeners")?;
                call(set, c"add", &[a[0]])?;
                function(
                    fields(p, &[("set", set), ("listener", a[0])])?,
                    "unsubscribe",
                    0,
                    0,
                    |ctx, _| call(ctx.get(c"set")?, c"delete", &[ctx.get(c"listener")?]),
                )
            }),
            ("get", 2, |p, a| queue(p, "get", identity(a[0], a[1])?)),
            ("record", 3, |p, a| {
                if !object(a[2])? {
                    return resolved(null(p)?);
                }
                let input = identity(a[0], a[1])?;
                input.set(c"now", num(p, now(p)?.explicit_number()?)?)?;
                input.set(
                    c"entry",
                    pick(
                        a[2],
                        &[
                            c"kind",
                            c"summary",
                            c"summaryText",
                            c"barText",
                            c"fetchedAt",
                        ],
                    )?,
                )?;
                queue(p, "record", input)
            }),
            ("recordDerived", 5, |p, a| {
                transaction(p, a, "recordDerived", true)
            }),
            ("transitionAvailability", 4, |p, a| {
                transaction(p, a, "transitionAvailability", false)
            }),
            ("recordVirtualFailure", 4, |p, a| {
                transaction(p, a, "recordVirtualFailure", false)
            }),
            ("recordFailure", 3, |p, a| {
                let input = identity(a[0], a[1])?;
                input.set(c"now", num(p, now(p)?.explicit_number()?)?)?;
                let meta = default_object(a[2])?;
                let out = fields(p, &[])?;
                for key in [c"error", c"code"] {
                    let v = meta.get(key)?;
                    out.set(key, if v.truthy()? { string(v)? } else { null(p)? })?;
                }
                input.set(c"meta", out)?;
                queue(p, "recordFailure", input)
            }),
            ("snapshot", 0, |p, _| queue(p, "snapshot", fields(p, &[])?)),
            ("prune", 1, |p, a| queue(p, "prune", a[0])),
            ("close", 0, |p, _| {
                if p.get(c"closed")?.truthy()? {
                    return p.get(c"tail");
                }
                let result = queue(p, "close", fields(p, &[])?)?;
                p.set(c"closed", flag(p, true)?)?;
                call(
                    result,
                    c"finally",
                    &[function(p, "clearListeners", 0, 0, |p, _| {
                        call(p.get(c"listeners")?, c"clear", &[])
                    })?],
                )
            }),
        ],
    )?;
    for key in [c"file", c"legacyJsonFile"] {
        api.set(key, p.get(key)?)?;
    }
    api.set(c"isAsync", flag(p, true)?)?;
    let getter = function(p, "migration", 0, 0, |p, _| p.get(c"migration"))?;
    call(
        p.global()?.get(c"Object")?,
        c"defineProperty",
        &[
            api,
            text(p, "migration")?,
            fields(p, &[("get", getter), ("enumerable", flag(p, true)?)])?,
        ],
    )?;
    Ok(api.freeze()?.raw())
}
