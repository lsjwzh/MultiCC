use super::*;
use std::{fs, time::UNIX_EPOCH};

fn fingerprint(spec: L<'_>) -> Result<L<'_>> {
    let binary = spec.get(c"binary")?;
    let modified = binary
        .string()?
        .and_then(|name| fs::metadata(name.to_string_lossy()).ok())
        .and_then(|m| m.modified().ok())
        .map(|mtime| {
            mtime
                .duration_since(UNIX_EPOCH)
                .map_or_else(|e| -e.duration().as_secs_f64(), |d| d.as_secs_f64())
                * 1000.
        })
        .unwrap_or(0.);
    call(
        string(binary)?,
        c"concat",
        &[
            text(spec, "|")?,
            string(spec.get(c"version")?)?,
            text(spec, "|")?,
            string(num(spec, modified)?)?,
        ],
    )
}
fn on_exit<'a>(rec: L<'a>, child: L<'a>, exit: L<'a>) -> Result<()> {
    if child.truthy()? && !rec.get(c"child")?.equals(child)? {
        return Ok(());
    }
    let s = rec.get(c"host")?;
    rec.set(c"child", null(rec)?)?;
    rec.set(c"ready", flag(rec, false)?)?;
    protocol::settle(rec, "插件进程已退出")?;
    if rec.get(c"stopping")?.truthy()? || s.get(c"stopped")?.truthy()? {
        return Ok(());
    }
    let last = spread(exit)?;
    last.set(c"at", clock(s)?)?;
    rec.set(c"lastExit", last)?;
    let started = rec.get(c"startedAt")?;
    if started.truthy()?
        && clock(s)?.number()? - started.number()? >= s.get(c"healthyAfterMs")?.number()?
    {
        rec.set(c"failures", num(s, 0.)?)?;
    }
    let failures = rec.get(c"failures")?.number()?;
    let backoff = s.get(c"backoffMs")?;
    let index = failures.min(backoff.get(c"length")?.number()? - 1.);
    let delay = backoff.get_key(string(num(s, index)?)?)?;
    rec.set(c"failures", num(s, failures + 1.)?)?;
    if !rec.get(c"downSince")?.truthy()? {
        rec.set(c"downSince", clock(s)?)?;
    }
    let detail = fields(s, &[("id", rec.get(c"id")?)])?;
    detail.spread_from(exit)?;
    detail.set(c"restartInMs", delay)?;
    detail.set(
        c"stderr",
        call(rec.get(c"stderr")?, c"slice", &[num(s, -3.)?])?,
    )?;
    log(s, c"warn", "plugin_resident_exited", detail)?;
    let restart = timeout(rec, delay, |rec, _| launch(rec))?;
    rec.set(c"restartTimer", restart)?;
    clear(rec, c"downTimer")?;
    let down = (rec.get(c"downSince")?.number()? + s.get(c"downAlertMs")?.number()?
        - clock(s)?.number()?
        + 10.)
        .max(10.);
    rec.set(c"downTimer", timeout(rec, num(s, down)?, alert::check)?)?;
    Ok(())
}
fn take_line<'a>(ctx: L<'a>, line: L<'a>) -> Result<()> {
    let rec = ctx.get(c"rec")?;
    let s = rec.get(c"host")?;
    if ctx.get(c"stderr")?.truthy()? {
        let lines = rec.get(c"stderr")?;
        call(lines, c"push", &[cap(line, 500.)?])?;
        if lines.get(c"length")?.number()? > 20. {
            call(lines, c"shift", &[])?;
        }
    } else if let Some(v) = s.catch(|| json_call(s, c"parse", line))? {
        protocol::message(rec, v)?;
    } else {
        log(
            s,
            c"warn",
            "plugin_resident_bad_line",
            fields(s, &[("id", rec.get(c"id")?), ("line", cap(line, 200.)?)])?,
        )?;
    }
    Ok(())
}
fn attach<'a>(rec: L<'a>, child: L<'a>, stderr: bool) -> Result<()> {
    let stream = child.get(if stderr { c"stderr" } else { c"stdout" })?;
    call(stream, c"setEncoding", &[text(rec, "utf8")?])?;
    let ctx = fields(
        rec,
        &[
            ("rec", rec),
            ("child", child),
            ("stderr", flag(rec, stderr)?),
            ("buffer", text(rec, "")?),
        ],
    )?;
    let consume = function(ctx, "onData", 1, 1, |ctx, a| {
        let mut buffer = call(ctx.get(c"buffer")?, c"concat", &[a[0]])?;
        loop {
            let newline = call(buffer, c"indexOf", &[text(ctx, "\n")?])?.number()?;
            if newline < 0. {
                break;
            }
            let line = call(buffer, c"slice", &[num(ctx, 0.)?, num(ctx, newline)?])?;
            buffer = call(buffer, c"slice", &[num(ctx, newline + 1.)?])?;
            ctx.set(c"buffer", buffer)?;
            let line = call(line, c"trim", &[])?;
            if line.truthy()? {
                take_line(ctx, line)?;
            }
        }
        if buffer.get(c"length")?.number()? > 4. * 1024. * 1024. {
            ctx.set(c"buffer", text(ctx, "")?)?;
            if !ctx.get(c"stderr")?.truthy()? {
                let rec = ctx.get(c"rec")?;
                log(
                    rec.get(c"host")?,
                    c"warn",
                    "plugin_resident_line_too_long",
                    fields(ctx, &[("id", rec.get(c"id")?)])?,
                )?;
                ctx.catch(|| call(ctx.get(c"child")?, c"kill", &[text(ctx, "SIGKILL")?]))?;
            }
        } else {
            ctx.set(c"buffer", buffer)?;
        }
        undef(ctx)
    })?;
    call(stream, c"on", &[text(rec, "data")?, consume])?;
    Ok(())
}
fn launch(rec: L<'_>) -> Result<L<'_>> {
    let s = rec.get(c"host")?;
    if s.get(c"stopped")?.truthy()? || rec.get(c"stopping")?.truthy()? {
        return undef(s);
    }
    rec.set(c"restartTimer", null(s)?)?;
    rec.set(c"ready", flag(s, false)?)?;
    rec.set(c"startedAt", clock(s)?)?;
    if !rec.get(c"downSince")?.truthy()? {
        rec.set(c"downSince", clock(s)?)?;
    }
    let id = rec.get(c"id")?;
    let env = spread(s.get(c"process")?.get(c"env")?)?;
    env.set(c"MULTICC_PLUGIN_ID", id)?;
    env.set(c"MULTICC_PLUGIN_PROTOCOL", text(s, "1")?)?;
    env.set(
        c"MULTICC_PLUGIN_DATA_DIR",
        call(s.get(c"path")?, c"join", &[s.get(c"dataDir")?, id])?,
    )?;
    let url = s.get(c"baseUrl")?;
    let url = if callable(url)? {
        url.call_plain(&[])?
    } else {
        url
    };
    if url.truthy()? {
        env.set(c"MULTICC_BASE_URL", url)?;
    }
    let spec = rec.get(c"spec")?;
    let argv = array(s)?;
    argv.set_element(0, text(s, "serve")?)?;
    let stdio = array(s)?;
    for i in 0..3 {
        stdio.set_element(i, text(s, "pipe")?)?;
    }
    let spawn = || -> Result<L<'_>> {
        let opts = fields(
            s,
            &[("cwd", spec.get(c"dir")?), ("env", env), ("stdio", stdio)],
        )?;
        s.get(c"spawn")?
            .call_plain(&[spec.get(c"binary")?, argv, opts])
    };
    let child = match spawn() {
        Ok(child) => child,
        Err(e) => {
            let err = caught_error(s, e)?;
            on_exit(
                rec,
                null(s)?,
                fields(
                    s,
                    &[
                        ("code", null(s)?),
                        ("signal", null(s)?),
                        ("error", err.get(c"message")?),
                    ],
                )?,
            )?;
            return undef(s);
        }
    };
    rec.set(c"child", child)?;
    attach(rec, child, false)?;
    attach(rec, child, true)?;
    call(
        child.get(c"stdin")?,
        c"on",
        &[
            text(s, "error")?,
            function(rec, "ignoreEpipe", 0, 0, empty)?,
        ],
    )?;
    let ctx = fields(s, &[("rec", rec), ("child", child)])?;
    let failed = function(ctx, "onError", 1, 1, |c, a| {
        let v = fields(
            c,
            &[
                ("code", null(c)?),
                ("signal", null(c)?),
                ("error", a[0].get(c"message")?),
            ],
        )?;
        on_exit(c.get(c"rec")?, c.get(c"child")?, v)?;
        undef(c)
    })?;
    call(child, c"on", &[text(s, "error")?, failed])?;
    let exited = function(ctx, "onExit", 2, 2, |c, a| {
        on_exit(
            c.get(c"rec")?,
            c.get(c"child")?,
            fields(c, &[("code", a[0]), ("signal", a[1])])?,
        )?;
        undef(c)
    })?;
    call(child, c"on", &[text(s, "exit")?, exited])?;
    // A restart already has a timer for the original outage deadline.
    if !rec.get(c"downTimer")?.truthy()? {
        rec.set(
            c"downTimer",
            timeout(
                rec,
                num(s, s.get(c"downAlertMs")?.number()? + 10.)?,
                alert::check,
            )?,
        )?;
    }
    log(
        s,
        c"info",
        "plugin_resident_started",
        fields(s, &[("id", id), ("pid", child.get(c"pid")?)])?,
    )?;
    undef(s)
}
fn start_record<'a>(s: L<'a>, spec: L<'a>) -> Result<()> {
    let id = spec.get(c"id")?;
    let rec = fields(
        s,
        &[
            ("id", id),
            ("spec", spec),
            ("host", s),
            ("fingerprint", fingerprint(spec)?),
            ("child", null(s)?),
            ("ready", flag(s, false)?),
            ("stopping", flag(s, false)?),
            ("startedAt", null(s)?),
            ("readyAt", null(s)?),
            ("reportedVersion", null(s)?),
            ("failures", num(s, 0.)?),
            ("lastExit", null(s)?),
            ("downSince", null(s)?),
            ("pending", map(s)?),
            ("alerts", map(s)?),
            ("alertTimes", array(s)?),
            ("stderr", array(s)?),
            ("restartTimer", null(s)?),
            ("downTimer", null(s)?),
            ("knownTargets", null(s)?),
        ],
    )?;
    call(s.get(c"records")?, c"set", &[id, rec])?;
    launch(rec)?;
    Ok(())
}
pub(super) fn stop_record(rec: L<'_>) -> Result<()> {
    rec.set(c"stopping", flag(rec, true)?)?;
    clear(rec, c"restartTimer")?;
    clear(rec, c"downTimer")?;
    protocol::settle(rec, "插件已停止")?;
    let child = rec.get(c"child")?;
    if !child.truthy()? {
        return Ok(());
    }
    rec.catch(|| call(child.get(c"stdin")?, c"end", &[]))?;
    timeout(child, rec.get(c"host")?.get(c"stopGraceMs")?, |child, _| {
        if child.get(c"exitCode")?.equals(null(child)?)?
            && child.get(c"signalCode")?.equals(null(child)?)?
        {
            child.catch(|| call(child, c"kill", &[text(child, "SIGKILL")?]))?;
        }
        undef(child)
    })?;
    Ok(())
}
pub(super) fn reconcile(s: L<'_>) -> Result<L<'_>> {
    if s.get(c"stopped")?.truthy()? {
        return undef(s);
    }
    let gather = || {
        let items = s.get(c"discover")?.call_plain(&[])?;
        call(
            items,
            c"filter",
            &[function(s, "resident", 1, 1, |s, a| {
                flag(s, a[0].truthy()? && a[0].get(c"resident")?.is_true()?)
            })?],
        )
    };
    let specs = match gather() {
        Ok(specs) => specs,
        Err(e) => {
            let error = caught_error(s, e)?;
            log(
                s,
                c"warn",
                "plugin_resident_scan_failed",
                fields(s, &[("error", error.get(c"message")?)])?,
            )?;
            return undef(s);
        }
    };
    let wanted = map(s)?;
    let skipped = s.get(c"skipped")?;
    let records = s.get(c"records")?;
    call(skipped, c"clear", &[])?;
    specs.for_each(|spec| {
        let id = spec.get(c"id")?;
        let reason = unsupported(spec, s.get(c"platform")?)?;
        if reason.truthy()? {
            call(
                skipped,
                c"set",
                &[id, fields(s, &[("spec", spec), ("reason", reason)])?],
            )?;
        } else {
            call(wanted, c"set", &[id, spec])?;
        }
        Ok(())
    })?;
    records.for_each(|entry| {
        let id = entry.element(0)?;
        let rec = entry.element(1)?;
        let spec = get(wanted, id)?;
        if spec.truthy()? && fingerprint(spec)?.equals(rec.get(c"fingerprint")?)? {
            rec.set(c"spec", spec)?;
            return Ok(());
        }
        let reason = text(s, if spec.truthy()? { "changed" } else { "removed" })?;
        log(
            s,
            c"info",
            "plugin_resident_stopping",
            fields(s, &[("id", id), ("reason", reason)])?,
        )?;
        stop_record(rec)?;
        call(records, c"delete", &[id])?;
        Ok(())
    })?;
    wanted.for_each(|entry| {
        if !call(records, c"has", &[entry.element(0)?])?.truthy()? {
            start_record(s, entry.element(1)?)?;
        }
        Ok(())
    })?;
    call(records, c"values", &[])?.for_each(|rec| {
        if rec.get(c"ready")?.truthy()? && rec.get(c"spec")?.get(c"channel")?.truthy()? {
            view::refresh(rec)?;
        }
        Ok(())
    })?;
    undef(s)
}
