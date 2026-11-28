use super::*;
fn export<'a>(s: L<'a>, file: L<'a>) -> Result<L<'a>> {
    ensure_open(s)?;
    if !file.truthy()? || file.kind()? != sys::ValueType::napi_string {
        return Err(
            s.type_error("[orchestration-sqlite-store] exportLegacy requires a target file")
        );
    }
    yes(
        s,
        request_async(s, "export", fields(s, &[("file", file)])?)?,
        |s, r| {
            s.set(c"revision", r.get(c"revision")?)?;
            Ok(r)
        },
    )
}
fn close(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    if s.get(c"closed")?.truthy()? {
        return undefined(s);
    }
    let legacy = s.get(c"legacyFile")?;
    if !legacy.truthy()? || !f.get(c"rollback")?.truthy()? {
        return close_handle(f);
    }
    let p = async_result(f, || export(s, legacy))?;
    let ok = cb(f, 0, |f, _| close_handle(f))?;
    let bad = cb(f, 1, |f, a| {
        f.set(c"failure", a[0])?;
        close_handle(f)
    })?;
    call(p, c"then", &[ok, bad])
}
fn close_handle(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    let p = request_async(s, "close", fields(s, &[])?)?;
    let ok = cb(f, 0, |f, _| {
        let s = f.get(c"s")?;
        s.set(c"closed", flag(s, true)?)?;
        let err = f.get(c"failure")?;
        if err.truthy()? {
            Err(err.throw_error())
        } else {
            undefined(s)
        }
    })?;
    let bad = cb(s, 1, |s, a| {
        s.set(c"closed", flag(s, true)?)?;
        Err(a[0].throw_error())
    })?;
    call(p, c"then", &[ok, bad])
}
pub(super) fn install(s: L<'_>, api: L<'_>) -> Result<()> {
    attach(s, api, "metrics", 0, 0, |s, _| spread(s.get(c"metrics")?))?;
    attach(s, api, "flush", 0, 0, |s, _| {
        enqueue(frame(s, &[])?, |f| {
            let s = f.get(c"s")?;
            ensure_open(s)?;
            request_async(s, "checkpoint", fields(s, &[])?)
        })
    })?;
    attach(s, api, "exportLegacy", 0, 1, |s, a| {
        enqueue(
            frame(s, &[("file", or_default(a[0], s.get(c"legacyFile")?)?)])?,
            |f| export(f.get(c"s")?, f.get(c"file")?),
        )
    })?;
    attach(s, api, "taskActivity", 1, 1, |s, a| {
        enqueue(frame(s, &[("input", a[0])])?, |f| {
            let s = f.get(c"s")?;
            ensure_open(s)?;
            yes(
                s,
                request_async(s, "taskActivity", f.get(c"input")?)?,
                |_, r| transport::parse_rows(r.get(c"rowsJson")?),
            )
        })
    })?;
    for (name, apply) in [("pruneRetained", true), ("retentionReport", false)] {
        set(
            api,
            name,
            function(s, name, 0, 1, move |s, a| {
                let clock = default_object(a[0])?.get(c"now")?;
                let clock = if clock.undefined()? {
                    s.get(c"now")?.call_plain(&[])?
                } else {
                    clock
                };
                enqueue(frame(s, &[("clock", clock)])?, move |f| {
                    let s = f.get(c"s")?;
                    ensure_open(s)?;
                    let p = request_async(
                        s,
                        "retention",
                        fields(s, &[("now", f.get(c"clock")?), ("apply", flag(s, apply)?)])?,
                    )?;
                    if !apply {
                        return Ok(p);
                    }
                    yes(s, p, |s, r| {
                        if r.get(c"deletedTasks")?.truthy()? || r.get(c"deletedOutbox")?.truthy()? {
                            s.set(c"revision", r.get(c"revision")?)?;
                        }
                        Ok(r)
                    })
                })
            })?,
        )?;
    }
    attach(s, api, "close", 0, 1, |s, a| {
        let rollback = or_default(
            default_object(a[0])?.get(c"exportRollback")?,
            flag(s, true)?,
        )?;
        enqueue(frame(s, &[("rollback", rollback)])?, close)
    })
}
