use super::*;

fn child_result<'a>(s: L<'a>, code: L<'a>, output: L<'a>) -> Result<L<'a>> {
    fields(s, &[("code", code), ("output", output)])
}
fn cause<'a>(s: L<'a>, err: napi::Error) -> Result<L<'a>> {
    match s.exception_value()? {
        Some(reason) => Ok(reason),
        None => error_value(s, &err.reason),
    }
}
fn run<'a>(s: L<'a>, file: L<'a>, args: L<'a>) -> Result<L<'a>> {
    let f = fields(
        s,
        &[
            ("s", s),
            ("file", file),
            ("args", args),
            ("output", text(s, "")?),
        ],
    )?;
    let start = function(f, "", 2, 2, |f, a| {
        let s = f.get(c"s")?;
        f.set(c"resolve", a[0])?;
        let stdio = list(f, &[text(f, "ignore")?, text(f, "pipe")?, text(f, "pipe")?])?;
        let options = fields(f, &[("env", s.get(c"env")?), ("stdio", stdio)])?;
        let child = match s
            .get(c"spawn")?
            .call_plain(&[f.get(c"file")?, f.get(c"args")?, options])
        {
            Ok(child) => child,
            Err(err) => {
                let why = cause(f, err)?;
                return a[0].call_plain(&[child_result(f, num(f, -1.)?, why.get(c"message")?)?]);
            }
        };
        let collect = function(f, "collect", 1, 1, |f, a| {
            let combined = call(f.get(c"output")?, c"concat", &[a[0]])?;
            f.set(c"output", call(combined, c"slice", &[num(f, -4000.)?])?)?;
            undef(f)
        })?;
        for stream in [c"stdout", c"stderr"] {
            call(child.get(stream)?, c"on", &[text(f, "data")?, collect])?;
        }
        let failed = function(f, "", 1, 1, |f, a| {
            let output = call(f.get(c"output")?, c"concat", &[a[0].get(c"message")?])?;
            f.get(c"resolve")?
                .call_plain(&[child_result(f, num(f, -1.)?, output)?])
        })?;
        let finished = function(f, "", 1, 1, |f, a| {
            f.get(c"resolve")?
                .call_plain(&[child_result(f, a[0], f.get(c"output")?)?])
        })?;
        call(child, c"on", &[text(f, "error")?, failed])?;
        call(child, c"on", &[text(f, "close")?, finished])?;
        undef(f)
    })?;
    f.global()?.get(c"Promise")?.construct(&[start])
}
fn write_log(s: L<'_>, level: &CStr, message: &str) -> Result<()> {
    call(s.get(c"logger")?, level, &[text(s, message)?])?;
    Ok(())
}
fn outcome<'a>(f: L<'a>, ok: bool) -> Result<L<'a>> {
    let out = spread(f.get(c"decision")?)?;
    out.set(c"ok", flag(f, ok)?)?;
    Ok(out)
}
fn response_failure<'a>(f: L<'a>, reason: &str, error: L<'a>) -> Result<L<'a>> {
    let out = inspect::decision(f, "skip", reason)?;
    out.set(c"ok", flag(f, false)?)?;
    out.set(c"error", error.get(c"message")?)?;
    Ok(out)
}
fn ping(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    let req = run(s, s.get(c"bin")?, list(f, &[text(f, "ping")?])?)?;
    then(req, f, |f, a| {
        let code = a[0].get(c"code")?;
        let ready = code.equals(num(f, 0.)?)?;
        let next = f.get(c"attempt")?.number()? + 1.;
        if !ready && next < 3. {
            f.set(c"attempt", num(f, next)?)?;
            let timer = function(f, "", 2, 2, |f, a| {
                f.global()?
                    .get(c"setTimeout")?
                    .call_plain(&[a[0], num(f, 500.)?])
            })?;
            return then(
                f.global()?.get(c"Promise")?.construct(&[timer])?,
                f,
                |f, _| ping(f),
            );
        }
        let out = outcome(f, true)?;
        out.set(c"ready", flag(f, ready)?)?;
        if !ready {
            let value = call(a[0].get(c"output")?, c"trim", &[])?;
            let lines = call(value, c"split", &[text(f, "\n")?])?;
            let entries = call(lines, c"filter", &[f.global()?.get(c"Boolean")?])?;
            let tail = or(call(entries, c"pop", &[])?, || {
                call(text(f, "exit ")?, c"concat", &[code])
            })?;
            let message = call(tail, c"slice", &[num(f, 0.)?, num(f, 200.)?])?;
            out.set(c"error", message)?;
            write_log(
                f.get(c"s")?,
                c"warn",
                &format!(
                    "[multicc-agent] installed but not answering yet: {}",
                    fold_string(message)?
                ),
            )?;
        }
        out.set(c"replaced", f.get(c"replaced")?)?;
        Ok(out)
    })
}
fn installed<'a>(f: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    let code = a[0].get(c"code")?;
    let action = f.get(c"decision")?.get(c"action")?;
    if code.equals(num(f, 75.)?)? {
        write_log(s,c"warn","[multicc-agent] signing identity unavailable right now; kept the installed Agent and its grants, will retry at the next start")?;
        let out = outcome(f, true)?;
        out.set(c"action", text(f, "skip")?)?;
        out.set(c"reason", text(f, "signing-unavailable")?)?;
        out.set(c"replaced", f.get(c"replaced")?)?;
        return Ok(out);
    }
    if !code.equals(num(f, 0.)?)? {
        let lines = call(
            call(a[0].get(c"output")?, c"trim", &[])?,
            c"split",
            &[text(f, "\n")?],
        )?;
        let tail = call(
            call(lines, c"slice", &[num(f, -3.)?])?,
            c"join",
            &[text(f, " | ")?],
        )?;
        write_log(
            s,
            c"warn",
            &format!(
                "[multicc-agent] {} failed (exit {}): {}",
                fold_string(action)?,
                fold_string(code)?,
                fold_string(tail)?
            ),
        )?;
        let out = outcome(f, false)?;
        out.set(c"error", tail)?;
        return Ok(out);
    }
    write_log(
        s,
        c"log",
        &format!("[multicc-agent] {} done", fold_string(action)?),
    )?;
    if !action.is_string("install")? {
        return ping(f);
    }
    then(
        run(
            s,
            s.get(c"bin")?,
            list(f, &[text(f, "request-permissions")?])?,
        )?,
        f,
        |f, a| {
            if !a[0].get(c"code")?.equals(num(f, 0.)?)? {
                let tail = call(
                    call(a[0].get(c"output")?, c"trim", &[])?,
                    c"slice",
                    &[num(f, -200.)?],
                )?;
                write_log(
                    f.get(c"s")?,
                    c"warn",
                    &format!(
                        "[multicc-agent] permission request failed: {}",
                        fold_string(tail)?
                    ),
                )?;
            }
            ping(f)
        },
    )
}
fn provision<'a>(s: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let checked = (|| {
        let decision = inspect::plan(s, &mut [options])?;
        let replaced = if decision.get(c"action")?.is_string("update")? {
            inspect::inspect(s)?.get(c"replaced")?
        } else {
            null(s)?
        };
        Ok((decision, replaced))
    })();
    let (decision, replaced) = match checked {
        Ok(pair) => pair,
        Err(err) => return response_failure(s, "check-failed", cause(s, err)?),
    };
    if decision.get(c"action")?.is_string("skip")? {
        decision.set(c"ok", flag(s, true)?)?;
        return Ok(decision);
    }
    if replaced.truthy()? {
        write_log(s,c"warn",&format!("[multicc-agent] the Agent was replaced by another MultiCC (now {}); upgrading it back",fold_string(replaced.get(c"app")?)?))?;
    }
    write_log(
        s,
        c"log",
        &format!(
            "[multicc-agent] {} ({}) — running install-agent.sh in the background",
            fold_string(decision.get(c"action")?)?,
            fold_string(decision.get(c"reason")?)?
        ),
    )?;
    let f = fields(
        s,
        &[
            ("s", s),
            ("decision", decision),
            ("replaced", replaced),
            ("attempt", num(s, 0.)?),
        ],
    )?;
    then(
        run(
            s,
            text(s, "/bin/sh")?,
            list(s, &[s.get(c"script")?, text(s, "install")?])?,
        )?,
        f,
        installed,
    )
}
pub(super) fn ensure<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let inflight = s.get(c"inFlight")?;
    if inflight.truthy()? {
        return Ok(inflight);
    }
    // Host logging and process factories can synchronously call ensure again.
    // Publish its shared promise before invoking either port.
    let mut deferred = std::ptr::null_mut();
    let mut promise = std::ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_create_promise(s.env(), &mut deferred, &mut promise) })?;
    let shared = L::from_raw(s.env(), promise);
    s.set(c"inFlight", shared)?;
    let result = async_result(s, || provision(s, default_object(a[0])?))?;
    let result = recover(result, s, |s, a| response_failure(s, "unexpected", a[0]))?;
    let done = then(result, s, |s, a| {
        let last = spread(a[0])?;
        last.set(
            c"at",
            call(
                s.global()?.get(c"Date")?.construct(&[])?,
                c"toISOString",
                &[],
            )?,
        )?;
        s.set(c"last", last)?;
        s.set(c"inFlight", null(s)?)?;
        Ok(last)
    })?;
    napi::check_status!(unsafe { sys::napi_resolve_deferred(s.env(), deferred, done.raw()) })?;
    Ok(shared)
}
