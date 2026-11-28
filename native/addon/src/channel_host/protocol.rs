use super::*;

fn problem<'a>(p: L<'a>, message: L<'a>, kind: &str) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("ok", flag(p, false)?),
            ("error", message),
            (kind, flag(p, true)?),
        ],
    )
}
pub(super) fn settle(rec: L<'_>, message: &str) -> Result<()> {
    let pending = rec.get(c"pending")?;
    call(pending, c"values", &[])?.for_each(|slot| {
        clear(slot, c"timer")?;
        slot.get(c"resolve")?
            .call_plain(&[problem(rec, text(rec, message)?, "exited")?])?;
        Ok(())
    })?;
    call(pending, c"clear", &[])?;
    Ok(())
}
fn executor<'a>(c: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let rec = c.get(c"rec")?;
    let resolve = a[0];
    let child = rec.optional(c"child")?;
    if !child.truthy()? {
        return resolve.call_plain(&[problem(c, text(c, "插件常驻进程没有运行")?, "down")?]);
    }
    if !rec.get(c"ready")?.truthy()? {
        return resolve.call_plain(&[problem(c, text(c, "插件常驻进程正在启动")?, "down")?]);
    }
    let s = rec.get(c"host")?;
    let id = s.get(c"nextRequestId")?;
    s.set(c"nextRequestId", num(c, id.number()? + 1.)?)?;
    let pending = rec.get(c"pending")?;
    let ms = c.get(c"ms")?;
    let slot = fields(
        c,
        &[
            ("resolve", resolve),
            ("id", id),
            ("pending", pending),
            ("ms", ms),
        ],
    )?;
    let timeout = timeout(slot, ms, |slot, _| {
        let id = slot.get(c"id")?;
        call(slot.get(c"pending")?, c"delete", &[id])?;
        let secs = call(
            slot.global()?.get(c"Math")?,
            c"round",
            &[num(slot, slot.get(c"ms")?.number()? / 1000.)?],
        )?;
        let message = format!("插件没有在 {} 秒内回应", fold_string(secs)?);
        slot.get(c"resolve")?
            .call_plain(&[problem(slot, text(slot, &message)?, "timeout")?])
    })?;
    slot.set(c"timer", timeout)?;
    call(pending, c"set", &[id, slot])?;
    let write = || -> Result<()> {
        let frame = fields(c, &[("id", id), ("type", c.get(c"type")?)])?;
        frame.spread_from(c.get(c"body")?)?;
        let line = call(
            json_call(c, c"stringify", frame)?,
            c"concat",
            &[text(c, "\n")?],
        )?;
        call(child.get(c"stdin")?, c"write", &[line])?;
        Ok(())
    };
    if let Err(error) = write() {
        let cause = caught_error(c, error)?;
        call(pending, c"delete", &[id])?;
        clear(slot, c"timer")?;
        let msg = call(
            text(c, "发给插件失败：")?,
            c"concat",
            &[cause.get(c"message")?],
        )?;
        resolve.call_plain(&[problem(c, msg, "down")?])?;
    }
    undef(c)
}
pub(super) fn request<'a>(rec: L<'a>, kind: &str, body: L<'a>, ms: L<'a>) -> Result<L<'a>> {
    let c = fields(
        body,
        &[
            ("rec", rec),
            ("type", text(body, kind)?),
            ("body", body),
            ("ms", ms),
        ],
    )?;
    c.global()?
        .get(c"Promise")?
        .construct(&[function(c, "request", 2, 2, executor)?])
}
pub(super) fn message(rec: L<'_>, msg: L<'_>) -> Result<()> {
    if !msg.truthy()? || !object(msg)? {
        return Ok(());
    }
    let s = rec.get(c"host")?;
    let id = msg.get(c"id")?;
    let pending = rec.get(c"pending")?;
    if call(s.global()?.get(c"Number")?, c"isSafeInteger", &[id])?.truthy()?
        && call(pending, c"has", &[id])?.truthy()?
    {
        let slot = get(pending, id)?;
        call(pending, c"delete", &[id])?;
        clear(slot, c"timer")?;
        let reply = if msg.get(c"ok")?.is_true()? {
            let data = msg.get(c"data")?;
            fields(
                s,
                &[
                    ("ok", flag(s, true)?),
                    (
                        "data",
                        if data.nullish()? {
                            fields(s, &[])?
                        } else {
                            data
                        },
                    ),
                ],
            )?
        } else {
            fields(
                s,
                &[
                    ("ok", flag(s, false)?),
                    (
                        "error",
                        fallback(cap(msg.get(c"error")?, 2000.)?, "插件命令失败".into())?,
                    ),
                ],
            )?
        };
        slot.get(c"resolve")?.call_plain(&[reply])?;
    } else if msg.get(c"event")?.is_string("hello")? {
        let id = rec.get(c"id")?;
        let protocol = msg.get(c"protocol")?;
        if !protocol.is_number(1.)? {
            log(
                s,
                c"warn",
                "plugin_protocol_mismatch",
                fields(s, &[("id", id), ("protocol", protocol)])?,
            )?;
        }
        rec.set(c"ready", flag(s, true)?)?;
        rec.set(c"readyAt", clock(s)?)?;
        rec.set(c"downSince", null(s)?)?;
        let version = fallback(cap(msg.get(c"version")?, 40.)?, V::Null)?;
        rec.set(c"reportedVersion", version)?;
        let down = text(s, "plugin-down")?;
        if call(rec.get(c"alerts")?, c"has", &[down])?.truthy()? {
            alert::raise(
                rec,
                fields(s, &[("key", down), ("resolved", flag(s, true)?)])?,
                false,
            )?;
        }
        let child = rec.get(c"child")?;
        let pid = if child.truthy()? {
            child.get(c"pid")?
        } else {
            child
        };
        log(
            s,
            c"info",
            "plugin_resident_ready",
            fields(s, &[("id", id), ("pid", pid), ("version", version)])?,
        )?;
        if rec.get(c"spec")?.get(c"channel")?.truthy()? {
            view::refresh(rec)?;
        }
    } else if msg.get(c"event")?.is_string("alert")? {
        alert::raise(rec, msg, false)?;
    }
    Ok(())
}
pub(super) fn run<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let rec = get(s.get(c"records")?, a[0])?;
        let body = fields(
            s,
            &[
                ("command", a[1]),
                (
                    "input",
                    if a[2].nullish()? {
                        fields(s, &[])?
                    } else {
                        a[2]
                    },
                ),
            ],
        )?;
        then(
            request(rec, "run", body, s.get(c"requestTimeoutMs")?)?,
            s,
            |s, a| {
                let r = a[0];
                let (status, payload) = if r.get(c"ok")?.truthy()? {
                    (200., r.get(c"data")?)
                } else {
                    let status = if r.get(c"timeout")?.truthy()? {
                        504.
                    } else if r.get(c"down")?.truthy()? || r.get(c"exited")?.truthy()? {
                        503.
                    } else {
                        400.
                    };
                    (status, fields(s, &[("error", r.get(c"error")?)])?)
                };
                fields(s, &[("status", num(s, status)?), ("payload", payload)])
            },
        )
    })
}
pub(super) fn deliver<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let rec = get(s.get(c"records")?, a[0])?;
        if !rec.truthy()? || !rec.get(c"spec")?.get(c"channel")?.truthy()? {
            return fields(
                s,
                &[
                    ("ok", flag(s, false)?),
                    ("error", text(s, "unknown channel plugin")?),
                ],
            );
        }
        then(
            request(rec, "deliver", spread(a[1])?, num(s, 5000.)?)?,
            s,
            |s, a| {
                let r = a[0];
                if !r.get(c"ok")?.truthy()? {
                    return fields(
                        s,
                        &[
                            ("ok", flag(s, false)?),
                            ("error", r.get(c"error")?),
                            (
                                "down",
                                flag(s, r.get(c"down")?.truthy()? || r.get(c"exited")?.truthy()?)?,
                            ),
                        ],
                    );
                }
                let data = value_or(r.get(c"data")?, fields(s, &[])?)?;
                let id = data.get(c"deliveryId")?;
                fields(
                    s,
                    &[
                        ("ok", flag(s, true)?),
                        ("receipt", data),
                        ("deliveryId", if id.nullish()? { null(s)? } else { id }),
                    ],
                )
            },
        )
    })
}
