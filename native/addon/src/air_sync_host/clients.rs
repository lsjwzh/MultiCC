use super::*;

pub(super) fn try_close<'a>(s: L<'a>, socket: L<'a>, args: &[L<'a>]) -> Result<()> {
    s.catch(|| {
        let closer = socket.get(c"close")?;
        if closer.nullish()? {
            undef(s)
        } else {
            closer.call(socket, args)
        }
    })?;
    Ok(())
}
pub(super) fn publish_status(s: L<'_>) -> Result<L<'_>> {
    if stopped(s)? {
        return undef(s);
    }
    let state = status(s)?;
    let code = fallback(state.optional(c"issue")?.optional(c"code")?, V::Null)?;
    if code.equals(s.get(c"publishedIssueCode")?)? {
        return undef(s);
    }
    s.set(c"publishedIssueCode", code)?;
    call(s.get(c"clients")?, c"keys", &[])?.for_each(|socket| {
        if socket.get(c"readyState")?.is_number(1.)? {
            let sent = s.catch(|| {
                let row = fields(s, &[("type", text(s, "air_status")?)])?;
                row.spread_from(state)?;
                s.get(c"send")?.call_plain(&[socket, row])
            })?;
            if sent.is_none() {
                try_close(s, socket, &[])?;
            }
        }
        Ok(())
    })?;
    undef(s)
}
fn replay<'a>(f: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    let socket = f.get(c"socket")?;
    if stopped(s)? || !socket.get(c"readyState")?.is_number(1.)? {
        return undef(s);
    }
    let url = f.get(c"url")?;
    let day = reads::day_value(call(
        url.get(c"searchParams")?,
        c"get",
        &[text(f, "dayStart")?],
    )?)?;
    f.set(c"day", day)?;
    let cursor = call(url.get(c"searchParams")?, c"get", &[text(f, "cursor")?])?;
    then(reads::read_sync(s, cursor, day)?, f, |f, a| {
        let s = f.get(c"s")?;
        let socket = f.get(c"socket")?;
        let response = a[0];
        if stopped(s)? || !socket.get(c"readyState")?.is_number(1.)? {
            return undef(s);
        }
        let send = s.get(c"send")?;
        if response.get(c"reset")?.truthy()? {
            send.call_plain(&[
                socket,
                fields(
                    s,
                    &[
                        ("type", text(s, "air_reset")?),
                        ("cursor", response.get(c"cursor")?),
                    ],
                )?,
            ])?;
        } else {
            response.get(c"events")?.for_each(|e| {
                let frame = spread(e)?;
                frame.set(c"taskStats", response.get(c"taskStats")?)?;
                send.call_plain(&[socket, frame])?;
                Ok(())
            })?;
            let frame = fields(
                s,
                &[
                    ("type", text(s, "air_synced")?),
                    ("cursor", response.get(c"cursor")?),
                    ("checkedAt", s.get(c"checkedAt")?),
                ],
            )?;
            frame.spread_from(status(s)?)?;
            send.call_plain(&[socket, frame])?;
        }
        call(s.get(c"clients")?, c"set", &[socket, f.get(c"day")?])?;
        undef(s)
    })
}
pub(super) fn attach<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let socket = a[0];
    call(s.get(c"attaching")?, c"add", &[socket])?;
    let f = fields(s, &[("s", s), ("socket", socket), ("url", a[1])])?;
    let cleanup = function(f, "", 0, 0, |f, _| {
        let s = f.get(c"s")?;
        let socket = f.get(c"socket")?;
        call(s.get(c"clients")?, c"delete", &[socket])?;
        call(s.get(c"attaching")?, c"delete", &[socket])?;
        undef(s)
    })?;
    call(socket, c"once", &[text(s, "close")?, cleanup])?;
    let handoff = then(reads::ready(s)?, f, |f, _| {
        serial(f.get(c"s")?, f, replay, false)
    })?;
    let result = recover(handoff, f, |f, _| {
        let socket = f.get(c"socket")?;
        f.catch(|| {
            if socket.get(c"readyState")?.is_number(1.)? {
                call(
                    socket,
                    c"close",
                    &[num(f, 1013.)?, text(f, "首页摘要正在准备")?],
                )?;
            }
            undef(f)
        })?;
        undef(f)
    })?;
    let done = function(f, "", 0, 0, |f, _| {
        call(
            f.get(c"s")?.get(c"attaching")?,
            c"delete",
            &[f.get(c"socket")?],
        )
    })?;
    call(result, c"finally", &[done])
}
