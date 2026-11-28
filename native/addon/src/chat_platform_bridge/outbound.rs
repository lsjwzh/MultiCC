use super::*;

fn delay(c: L<'_>) -> Result<L<'_>> {
    c.global()?
        .get(c"Promise")?
        .construct(&[function(c, "delay", 1, 1, |c, a| {
            c.global()?
                .get(c"setTimeout")?
                .call_plain(&[a[0], num(c, 400.)?])?;
            undef(c)
        })?])
}
fn next<'a>(c: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let s = c.get(c"state")?;
    let index = c.get(c"index")?.number()?;
    let bodies = c.get(c"bodies")?;
    if index >= bodies.get(c"length")?.number()? {
        return undef(s);
    }
    let body = bodies.element(index as u32)?;
    call(s.get(c"echo")?, c"add", &[body])?;
    c.set(c"body", body)?;
    let sent = async_result(c, || {
        if is_slack(s)? {
            call(
                s.get(c"client")?.get(c"client")?.get(c"chat")?,
                c"postMessage",
                &[fields(
                    s,
                    &[("channel", s.get(c"target")?), ("text", body)],
                )?],
            )
        } else if telegram(s)? {
            call(
                s.get(c"client")?,
                c"sendMessage",
                &[s.get(c"target")?, body],
            )
        } else {
            call(c.get(c"channel")?, c"send", &[body])
        }
    })?;
    let sent = if is_slack(s)? {
        sent
    } else {
        recover(sent, c, |c, a| {
            let s = c.get(c"state")?;
            c.set(c"failed", flag(c, true)?)?;
            log(
                s,
                "error",
                concat(s, &format!("{} send failed: ", label(s)?), message(a[0])?)?,
            )?;
            undef(s)
        })?
    };
    then(sent, c, |c, _| {
        let s = c.get(c"state")?;
        if c.get(c"failed")?.truthy()? {
            return undef(s);
        }
        log(s, "out", preview(c.get(c"body")?, 200.)?)?;
        let index = c.get(c"index")?.number()? + 1.;
        c.set(c"index", num(c, index)?)?;
        if index < c.get(c"bodies")?.get(c"length")?.number()? {
            then(delay(c)?, c, next)
        } else {
            undef(s)
        }
    })
}
pub(super) fn send_text<'a>(s: L<'a>, value: L<'a>) -> Result<L<'a>> {
    async_result(s, || {
        if !s.get(c"target")?.truthy()? || !s.get(c"client")?.truthy()? {
            let cut = call(string(value)?, c"slice", &[num(s, 0.)?, num(s, 80.)?])?;
            let target = if telegram(s)? {
                "Telegram chat"
            } else if is_slack(s)? {
                "Slack channel"
            } else {
                "Discord channel"
            };
            log(
                s,
                "system",
                call(
                    concat(s, &format!("Reply ready but no {target} attached: "), cut)?,
                    c"concat",
                    &[text(s, "…")?],
                )?,
            )?;
            return undef(s);
        }
        let max = if telegram(s)? {
            3800.
        } else if is_slack(s)? {
            3500.
        } else {
            1900.
        };
        let bodies = call(
            s.get(c"ports")?.get(c"bridgeGateway")?,
            c"chunkOutbound",
            &[value, fields(s, &[("max", num(s, max)?)])?],
        )?;
        let c = fields(
            s,
            &[
                ("state", s),
                ("bodies", bodies),
                ("index", num(s, 0.)?),
                ("failed", flag(s, false)?),
            ],
        )?;
        if telegram(s)? || is_slack(s)? {
            next(c, &mut [])
        } else {
            let fetched = async_result(s, || {
                call(
                    s.get(c"client")?.get(c"channels")?,
                    c"fetch",
                    &[s.get(c"target")?],
                )
            })?;
            let fetched = recover(fetched, c, |c, a| {
                let s = c.get(c"state")?;
                c.set(c"fetchFailed", flag(c, true)?)?;
                log(
                    s,
                    "error",
                    concat(s, "Discord channel fetch failed: ", message(a[0])?)?,
                )?;
                undef(c)
            })?;
            then(fetched, c, |c, a| {
                let s = c.get(c"state")?;
                if c.get(c"fetchFailed")?.truthy()? {
                    return undef(s);
                }
                let channel = a[0];
                if !channel.truthy()? || !callable(channel.get(c"send")?)? {
                    let msg = call(
                        concat(s, "Discord channel ", s.get(c"target")?)?,
                        c"concat",
                        &[text(s, " is not textable")?],
                    )?;
                    log(s, "error", msg)?;
                    return undef(s);
                }
                // Discord pins one fetched channel; Telegram re-reads its target per chunk.
                c.set(c"channel", channel)?;
                next(c, &mut [])
            })
        }
    })
}
