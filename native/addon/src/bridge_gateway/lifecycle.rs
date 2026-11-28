use super::*;

fn get(p: L<'_>) -> Result<L<'_>> {
    fallback(
        call(
            p.get(c"persistedSessions")?,
            c"get",
            &[p.get(c"sessionId")?],
        )?,
        V::Null,
    )
}
fn validate(cli: L<'_>) -> Result<()> {
    if cli.is_string("claude")? || cli.is_string("codex")? {
        Ok(())
    } else {
        Err(error_value(cli, "cli must be claude or codex")?.throw_error())
    }
}
fn message<'a>(p: L<'a>, suffix: &str) -> Result<L<'a>> {
    concat(p, &[p.get(c"platformLabel")?, text(p, suffix)?])
}
fn save(p: L<'_>) -> Result<L<'_>> {
    p.get(c"savePersistedSessions")?.call_plain(&[])
}
fn chat(p: L<'_>) -> Result<L<'_>> {
    let sessions = p.get(c"chatSessions")?;
    if sessions.nullish()? {
        undef(p)
    } else {
        call(sessions, c"get", &[p.get(c"sessionId")?])
    }
}
fn kill(cs: L<'_>, clear: bool) -> Result<()> {
    if cs.get(c"claudeProc")?.truthy()? {
        cs.catch(|| call(cs.get(c"claudeProc")?, c"kill", &[text(cs, "SIGTERM")?]))?;
        if clear {
            cs.assign(c"claudeProc", null(cs)?)?;
        }
    }
    Ok(())
}
fn reconnect(p: L<'_>) -> Result<()> {
    call(p.get(c"chatWsCtl")?, c"disconnect", &[])?;
    call(p.get(c"chatWsCtl")?, c"reconnectIfRunning", &[])?;
    Ok(())
}
fn create_record<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if get(p)?.truthy()? {
        return fail(p, &[message(p, " gateway already exists")?]);
    }
    validate(a[0])?;
    p.catch(|| {
        call(
            p.get(c"ports")?.get(c"fs")?,
            c"mkdirSync",
            &[p.get(c"cwd")?, fields(p, &[("recursive", flag(p, true)?)])?],
        )
    })?;
    let rec = fields(
        p,
        &[
            ("id", p.get(c"sessionId")?),
            ("type", text(p, "gateway")?),
            ("kind", text(p, "chat")?),
            ("cli", a[0]),
            ("cliSessionId", null(p)?),
            ("label", p.get(c"label")?),
            ("cwd", p.get(c"cwd")?),
            ("createdAt", iso_now(p)?),
        ],
    )?;
    call(
        p.get(c"persistedSessions")?,
        c"set",
        &[p.get(c"sessionId")?, rec],
    )?;
    save(p)?;
    log(
        p,
        "system",
        concat(
            p,
            &[message(p, " gateway created (cli=")?, a[0], text(p, ")")?],
        )?,
    )?;
    Ok(rec)
}
fn switch<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let rec = get(p)?;
    if !rec.truthy()? {
        return fail(p, &[message(p, " gateway does not exist")?]);
    }
    validate(a[0])?;
    if rec.get(c"cli")?.equals(a[0])? {
        return Ok(rec);
    }
    rec.assign(c"cli", a[0])?;
    rec.assign(c"cliSessionId", null(p)?)?;
    save(p)?;
    let cs = chat(p)?;
    if cs.truthy()? {
        kill(cs, true)?;
        cs.assign(c"cli", a[0])?;
        cs.assign(c"chatTurnCount", num(p, 0.)?)?;
    }
    reconnect(p)?;
    log(
        p,
        "system",
        concat(p, &[message(p, " gateway cli switched to ")?, a[0]])?,
    )?;
    Ok(rec)
}
fn destroy<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    if !get(p)?.truthy()? {
        return undef(p);
    }
    call(p.get(c"chatWsCtl")?, c"disconnect", &[])?;
    let cs = chat(p)?;
    if !cs.nullish()? && cs.get(c"claudeProc")?.truthy()? {
        // The legacy destroy leaves the handle on the soon-to-be-removed
        // object, unlike switch/reset which clear it.
        cs.catch(|| call(cs.get(c"claudeProc")?, c"kill", &[text(p, "SIGTERM")?]))?;
    }
    let sessions = p.get(c"chatSessions")?;
    if !sessions.nullish()? {
        call(sessions, c"delete", &[p.get(c"sessionId")?])?;
    }
    call(
        p.get(c"persistedSessions")?,
        c"delete",
        &[p.get(c"sessionId")?],
    )?;
    save(p)?;
    log(p, "system", message(p, " gateway destroyed")?)?;
    undef(p)
}
fn finish_reset<'a>(frame: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let p = frame.get(c"lifecycle")?;
    let rec = frame.get(c"record")?;
    // The history owner may yield while this gateway is destroyed/recreated.
    // A completed clear belongs only to the exact record that requested it.
    if !get(p)?.equals(rec)? {
        return undef(p);
    }
    rec.assign(
        c"cliSessionId",
        if rec.get(c"cli")?.is_string("claude")? {
            call(p.get(c"ports")?.get(c"crypto")?, c"randomUUID", &[])?
        } else {
            null(p)?
        },
    )?;
    save(p)?;
    let cs = chat(p)?;
    if cs.truthy()? {
        kill(cs, true)?;
        cs.assign(c"chatTurnCount", num(p, 0.)?)?;
    }
    reconnect(p)?;
    log(p, "system", message(p, " gateway history cleared")?)?;
    undef(p)
}

fn reset<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let rec = get(p)?;
    if !rec.truthy()? {
        return undef(p);
    }
    async_result(p, || {
        let frame = fields(p, &[("lifecycle", p), ("record", rec)])?;
        // No file fallback: this owner is the sole authority for clearing
        // persisted/cached/in-flight bridge history. A throw or rejection must
        // reach the caller before any success-side effect is allowed.
        let cleared = p
            .get(c"clearBridgeHistory")?
            .call_plain(&[p.get(c"sessionId")?])?;
        then(cleared, frame, finish_reset)
    })
}

pub(super) fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = a[0];
    let p = defaults(
        opts,
        ports,
        &[
            (c"sessionId", None),
            (c"cwd", None),
            (c"label", None),
            (c"platformLabel", None),
            (c"persistedSessions", None),
            (c"chatSessions", None),
            (c"savePersistedSessions", None),
            (c"clearBridgeHistory", None),
            (c"chatWsCtl", None),
            (c"log", None),
        ],
    )?;
    if !callable(p.get(c"persistedSessions")?.optional(c"get")?)? {
        return Err(p.type_error("gateway-core lifecycle: persistedSessions Map required"));
    }
    methods(
        p,
        &[
            ("get", 0, |p, _| get(p)),
            ("create", 1, create_record),
            ("switchCli", 1, switch),
            ("destroy", 0, destroy),
            ("resetHistory", 0, reset),
        ],
    )
}
