//! Three guard entry points share preparation, throttle state and logging.
use crate::quota_host::*;
use napi_derive::napi;
fn config(p: L<'_>) -> Result<L<'_>> {
    call(p.get(c"guard")?, c"config", &[p.get(c"env")?, now(p)?])?.freeze()
}
fn applies<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    call(
        p,
        c"request",
        &[
            text(p, "appliesTo")?,
            fields(p, &[("providerId", id), ("config", config(p)?)])?,
        ],
    )
}
fn verdict<'a>(p: L<'a>, reason: &str, blocked: bool) -> Result<L<'a>> {
    let v = fields(
        p,
        &[("blocked", flag(p, blocked)?), ("reason", text(p, reason)?)],
    )?;
    if blocked {
        v.set(c"window", text(p, "unavailable")?)?;
        v.set(c"usedPercent", num(p, 0.)?)?;
    }
    v.freeze()
}
fn prepare<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let input = default_object(input)?;
    let app = input.get(c"appType")?;
    let id = input.get(c"providerId")?.clean_text()?;
    if !applies(p, id)?.truthy()? {
        return verdict(p, "scope_mismatch", false);
    }
    let settings = config(p)?;
    if !settings.get(c"enabled")?.truthy()? {
        return verdict(p, "guard_disabled", false);
    }
    if !callable(p.get(c"cache")?.optional(c"get")?)? {
        return verdict(p, "no_cache", false);
    }
    let app = app.clean_text()?;
    let app = if app.truthy()? {
        app
    } else {
        fallback(
            call(id, c"split", &[text(p, "-")?])?.element(0)?,
            "claude".into(),
        )?
    };
    fields(
        p,
        &[("ports", p), ("app", app), ("id", id), ("config", settings)],
    )
}
fn log<'a>(ctx: L<'a>, v: L<'a>, stale: bool) -> Result<()> {
    let p = ctx.get(c"ports")?;
    let logger = p.get(c"logger")?;
    let (method, tag, stamp, date) = if stale {
        (
            c"info",
            "quota_guard_stale_release",
            c"readingAtMs",
            c"readingAt",
        )
    } else {
        (c"warn", "quota_guard_hold", c"resetsAtMs", c"resetsAt")
    };
    if callable(logger.optional(method)?)? {
        let data = pick(v, &[c"window", c"usedPercent"])?;
        data.set(c"providerId", ctx.get(c"id")?)?;
        if !stale {
            data.set(c"threshold", v.get(c"threshold")?)?;
        }
        data.set(
            date,
            call(
                p.global()?.get(c"Date")?.construct(&[v.get(stamp)?])?,
                c"toISOString",
                &[],
            )?,
        )?;
        call(logger, method, &[text(p, tag)?, data])?;
    }
    Ok(())
}
fn finish<'a>(ctx: L<'a>, entry: L<'a>) -> Result<L<'a>> {
    let p = ctx.get(c"ports")?;
    let id = ctx.get(c"id")?;
    let v = call(
        p,
        c"request",
        &[
            text(p, "guardVerdict")?,
            fields(
                p,
                &[
                    ("entry", entry),
                    ("config", ctx.get(c"config")?),
                    ("now", now(p)?),
                ],
            )?,
        ],
    )?
    .freeze()?;
    if v.get(c"blocked")?.truthy()? {
        log(ctx, v, false)?;
    }
    if v.get(c"reason")?.is_string("stale_reading")?
        && call(p.get(c"guard")?, c"shouldRefresh", &[id, now(p)?])?.truthy()?
    {
        log(ctx, v, true)?;
        let f = p.get(c"onStale")?;
        if callable(f)? {
            ignored(p, || f.call_plain(&[ctx.get(c"app")?, id]))?;
        }
    }
    Ok(v)
}
#[napi]
pub fn quota_guard_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    p.set(
        c"guard",
        p.get(c"Owner")?
            .construct(&[fallback(p.get(c"configFile")?, V::Undefined)?])?,
    )?;
    Ok(methods(
        p,
        &[
            ("config", 0, |p, _| config(p)),
            ("appliesTo", 1, |p, a| applies(p, a[0])),
            ("setStaleRefresher", 1, |p, a| {
                p.set(c"onStale", a[0])?;
                undef(p)
            }),
            ("checkEntry", 2, |p, a| {
                let ctx = prepare(p, a[0])?;
                if ctx.get(c"reason")?.truthy()? {
                    Ok(ctx)
                } else {
                    finish(ctx, a[1])
                }
            }),
            ("check", 1, |p, a| {
                let ctx = prepare(p, a[0])?;
                if ctx.get(c"reason")?.truthy()? {
                    return Ok(ctx);
                }
                let entry = p
                    .catch(|| {
                        call(
                            p.get(c"cache")?,
                            c"get",
                            &[ctx.get(c"app")?, ctx.get(c"id")?],
                        )
                    })?
                    .unwrap_or(null(p)?);
                if entry.truthy()? && callable(entry.get(c"then")?)? {
                    recover(entry, p, |p, _| undef(p))?;
                    return verdict(p, "async_cache_read_required", true);
                }
                finish(ctx, entry)
            }),
            ("checkAsync", 1, |p, a| {
                async_result(p, || {
                    let ctx = prepare(p, a[0])?;
                    if ctx.get(c"reason")?.truthy()? {
                        return Ok(ctx);
                    }
                    let result = async_result(p, || {
                        call(
                            p.get(c"cache")?,
                            c"get",
                            &[ctx.get(c"app")?, ctx.get(c"id")?],
                        )
                    })?;
                    call(
                        result,
                        c"then",
                        &[
                            function(ctx, "checkReading", 1, 1, |ctx, a| finish(ctx, a[0]))?,
                            function(p, "readFailed", 0, 0, |p, _| {
                                verdict(p, "cache_read_failed", true)
                            })?,
                        ],
                    )
                })
            }),
        ],
    )?
    .freeze()?
    .raw())
}
