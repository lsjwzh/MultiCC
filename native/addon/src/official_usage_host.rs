//! Official account window projection and single-flight Codex polling.
use crate::host_api::*;
use napi_derive::napi;
fn row<'a>(p: L<'a>, window: L<'a>, label: &str, pct: f64, reset: f64) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("window", window),
            ("label", text(p, label)?),
            ("usedPercent", num(p, pct.clamp(0., 100.))?),
            (
                "resetMs",
                if reset.is_finite() {
                    num(p, reset)?
                } else {
                    null(p)?
                },
            ),
        ],
    )
}
fn claude(usage: L<'_>) -> Result<L<'_>> {
    let rows = array(usage)?;
    if object(usage)? {
        for (key, window, label) in [
            (c"five_hour", "5h", "Current session"),
            (c"seven_day", "7d", "Weekly"),
        ] {
            let w = usage.get(key)?;
            let pct = w.optional(c"utilization")?;
            if pct.nullish()? {
                continue;
            }
            let pct = pct.explicit_number()?;
            if !pct.is_finite() {
                continue;
            }
            let reset = w.get(c"resets_at")?;
            let reset = if reset.truthy()? {
                call(usage.global()?.get(c"Date")?, c"parse", &[reset])?.number()?
            } else {
                f64::NAN
            };
            call(
                rows,
                c"push",
                &[row(usage, text(usage, window)?, label, pct, reset)?],
            )?;
        }
    }
    Ok(rows)
}
fn codex(dto: L<'_>) -> Result<L<'_>> {
    let rows = array(dto)?;
    if !object(dto)? {
        return Ok(rows);
    }
    let pct = dto.get(c"utilization")?.explicit_number()?;
    if !pct.is_finite() {
        return Ok(rows);
    }
    let windows = dto.get(c"windows")?;
    if windows.is_array()? && windows.get(c"length")?.truthy()? {
        windows.for_each(|w| {
            if !w.truthy()? {
                return Ok(());
            }
            let percent = w.get(c"usedPercent")?.explicit_number()?;
            if !percent.is_finite() {
                return Ok(());
            }
            let window = w.get(c"window")?;
            let reset = w.get(c"resetMs")?;
            let (window, label) = if window.is_string("1wk")? {
                (text(dto, "7d")?, "Weekly")
            } else if window.is_string("5h")? {
                (window, "Current session")
            } else {
                (window, "Monthly")
            };
            call(
                rows,
                c"push",
                &[row(
                    dto,
                    window,
                    label,
                    percent,
                    if reset.nullish()? {
                        f64::NAN
                    } else {
                        reset.explicit_number()?
                    },
                )?],
            )?;
            Ok(())
        })?;
    } else {
        let reset = dto.get(c"resetsAt")?.explicit_number()?;
        call(
            rows,
            c"push",
            &[row(
                dto,
                text(dto, "7d")?,
                "Weekly",
                pct * 100.,
                if reset < 1e12 { reset * 1000. } else { reset },
            )?],
        )?;
    }
    Ok(rows)
}
fn poll<'a>(ctx: L<'a>, count: L<'a>) -> Result<L<'a>> {
    let p = ctx.get(c"ports")?;
    let id = ctx.get(c"account")?.get(c"id")?;
    let key = call(text(p, "codex:")?, c"concat", &[string(id)?])?;
    if fallback(call(p.get(c"blocked")?, c"get", &[key])?, 0f64.into())?.number()?
        > now(p)?.number()?
    {
        return Ok(count);
    }
    let accounts = p.get(c"accounts")?;
    if !callable(accounts.get(c"codexDir")?)? {
        return Ok(count);
    }
    let turn = fields(
        p,
        &[("ports", p), ("id", id), ("key", key), ("count", count)],
    )?;
    let result = async_result(p, || {
        let auth = call(p, c"authFile", &[call(accounts, c"codexDir", &[id])?])?;
        let reading = call(
            p,
            c"pollCodex",
            &[fields(p, &[("authFile", auth)])?, now(p)?],
        )?;
        then(reading, turn, |turn, a| {
            let windows = codex(a[0])?;
            let p = turn.get(c"ports")?;
            let count = turn.get(c"count")?;
            if !windows.get(c"length")?.truthy()? {
                return Ok(count);
            }
            let kind = text(p, "codex")?;
            let id = call(p, c"accountProviderId", &[kind, turn.get(c"id")?])?;
            let write = call(
                p.get(c"recorder")?,
                c"recordOfficialWindows",
                &[
                    kind,
                    id,
                    fields(p, &[("windows", windows), ("fetchedAt", now(p)?)])?,
                ],
            )?;
            then(write, num(p, count.number()? + 1.)?, constant)
        })
    })?;
    recover(result, turn, |turn, a| {
        let p = turn.get(c"ports")?;
        let e = a[0];
        let interval = p.get(c"intervalMs")?.number()?;
        let delay = match e.optional(c"status")?.number_value()? {
            Some(429.) => e
                .get(c"retryAfterMs")?
                .explicit_number()?
                .max(0.)
                .max(interval),
            Some(401.) => interval * 6.,
            _ => 0.,
        };
        if delay != 0. {
            call(
                p.get(c"blocked")?,
                c"set",
                &[turn.get(c"key")?, num(p, now(p)?.number()? + delay)?],
            )?;
        }
        let logger = p.get(c"logger")?;
        if logger.optional(c"warn")?.truthy()? {
            let msg = e.optional(c"message")?;
            call(
                logger,
                c"warn",
                &[text(
                    p,
                    &format!(
                        "[official-account-usage] codex {} poll failed: {}",
                        fold_string(turn.get(c"id")?)?,
                        fold_string(if msg.truthy()? { msg } else { e })?
                    ),
                )?],
            )?;
        }
        turn.get(c"count")
    })
}
fn sweep<'a>(p: L<'a>, options: L<'a>) -> Result<L<'a>> {
    async_result(p, || {
        let accounts = p.get(c"accounts")?;
        let mut signed = vec![];
        if callable(accounts.get(c"listCodexAccounts")?)? {
            let list = call(accounts, c"listCodexAccounts", &[])?;
            if list.is_array()? {
                list.for_each(|a| {
                    if a.optional(c"loggedIn")?.truthy()? {
                        signed.push(a);
                    }
                    Ok(())
                })?;
            }
        }
        let mut tail = resolved(num(p, 0.)?)?;
        if options.optional(c"force")?.truthy()? || signed.len() >= 2 {
            for account in signed {
                tail = then(
                    tail,
                    fields(p, &[("ports", p), ("account", account)])?,
                    |ctx, a| poll(ctx, a[0]),
                )?;
            }
        }
        Ok(tail)
    })
}
fn tick<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let running = p.get(c"running")?;
    if running.truthy()? {
        return Ok(running);
    }
    let result = recover(sweep(p, undef(p)?)?, p, |p, _| num(p, 0.))?;
    let result = call(
        result,
        c"finally",
        &[function(p, "finished", 0, 0, |p, _| {
            p.set(c"running", null(p)?)?;
            undef(p)
        })?],
    )?;
    p.set(c"running", result)?;
    Ok(result)
}
#[napi]
pub fn official_usage_windows(
    env: Env,
    dto: Unknown<'_>,
    is_codex: bool,
) -> Result<sys::napi_value> {
    let v = L::new(&env, dto);
    Ok(if is_codex { codex(v)? } else { claude(v)? }.raw())
}
#[napi]
pub fn official_usage_sweeper(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    if !p.get(c"accounts")?.truthy()? || !p.get(c"recorder")?.truthy()? {
        return Err(p.type_error("[official-account-usage] requires { accounts, recorder }"));
    }
    p.set(c"blocked", p.global()?.get(c"Map")?.construct(&[])?)?;
    Ok(methods(
        p,
        &[
            ("sweepOnce", 1, |p, a| sweep(p, a[0])),
            ("start", 0, |p, _| {
                if !p.get(c"timer")?.truthy()? {
                    let tick = function(p, "pollAccounts", 0, 0, tick)?;
                    for (method, key, ms) in [
                        (c"setInterval", c"timer", p.get(c"intervalMs")?),
                        (c"setTimeout", c"initial", num(p, 30000.)?),
                    ] {
                        let timer = call(p.global()?, method, &[tick, ms])?;
                        p.set(key, timer)?;
                        if callable(timer.optional(c"unref")?)? {
                            call(timer, c"unref", &[])?;
                        }
                    }
                }
                undef(p)
            }),
            ("stop", 0, |p, _| {
                for (clear, key) in [(c"clearInterval", c"timer"), (c"clearTimeout", c"initial")] {
                    let t = p.get(key)?;
                    if t.truthy()? {
                        call(p.global()?, clear, &[t])?;
                        p.set(key, null(p)?)?;
                    }
                }
                undef(p)
            }),
        ],
    )?
    .freeze()?
    .raw())
}
