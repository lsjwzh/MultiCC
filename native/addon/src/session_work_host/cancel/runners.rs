//! Process and transport stop. The cancelled child remains observable after detaching
//! claudeProc. A resident runner's claim is released only after this wait completes.
use super::*;
use multicc_core::cli_capability;

pub(super) fn process_alive(p: L<'_>) -> Result<bool> {
    crate::session_records::session_runtime_process_alive(env(p), Some(arg(p)?))
}
fn cli_name(state: L<'_>) -> Result<String> {
    let v = state.get(c"cli")?;
    if v.nullish()? {
        Ok(String::new())
    } else {
        Ok(string(v)?.coerce_string()?.trim().to_string_lossy())
    }
}
pub(super) fn stopped(f: L<'_>) -> Result<bool> {
    let state = chat(f)?;
    if !state.truthy()? {
        return Ok(true);
    }
    // The cancelled resident runner keeps _activeRunner until this wait completes.
    if state.get(c"isStreaming")?.truthy()?
        || state.get(c"claudeProc")?.truthy()?
        || process_alive(state.get(c"_cancelledProc")?)?
    {
        return Ok(false);
    }
    let stream = deps(f)?.get(c"chatStream")?;
    Ok(if cli_capability::cancel_stops_process(&cli_name(state)?) {
        !call(stream, c"isAlive", &[id(f)?])?.truthy()?
    } else {
        !call(stream, c"status", &[id(f)?])?
            .optional(c"busy")?
            .truthy()?
    })
}
fn signal(proc: L<'_>, sig: &str) -> Result<()> {
    proc.catch(|| call(proc, c"kill", &[text(proc, sig)?]))?;
    Ok(())
}
fn force_kill(f: L<'_>) -> Result<bool> {
    let proc = chat(f)?.optional(c"_cancelledProc")?;
    if !process_alive(proc)? {
        return Ok(false);
    }
    warn(
        f,
        "session_cancel_runner_force_kill",
        &[("pid", proc.get(c"pid")?)],
    )?;
    signal(proc, "SIGKILL")?;
    Ok(true)
}
fn poll<'a>(f: L<'a>, _: L<'a>) -> Result<L<'a>> {
    if stopped(f)? {
        return flag(f, true);
    }
    if !f.get(c"escalated")?.truthy()?
        && now(f)?.number()? - f.get(c"start")?.number()?
            >= h(f)?.get(c"runnerKillGraceMs")?.number()?
    {
        f.set(c"escalated", flag(f, true)?)?;
        force_kill(f)?;
    }
    if now(f)?.number()? >= f.get(c"deadline")?.number()? {
        if !f.get(c"escalated")?.truthy()? {
            force_kill(f)?;
        }
        return flag(f, stopped(f)?);
    }
    let resolve_after_delay = callback(f, "", 2, 2, |f, a| {
        call(f.global()?, c"setTimeout", &[a[0], num(f, 25.)?])
    })?;
    let delay = f
        .global()?
        .get(c"Promise")?
        .construct(&[resolve_after_delay])?;
    schedule_step(f, delay, poll, None)
}
pub(super) fn await_stop(f: L<'_>) -> Result<L<'_>> {
    async_result(f, || {
        let start = now(f)?;
        f.set(c"start", start)?;
        f.set(
            c"deadline",
            num(
                f,
                start.number()? + h(f)?.get(c"runnerStopTimeoutMs")?.number()?,
            )?,
        )?;
        f.set(c"escalated", flag(f, false)?)?;
        poll(f, empty(f)?)
    })
}
pub(super) fn provider_stop(f: L<'_>) -> Result<L<'_>> {
    let p = chat(f)?.optional(c"claudeProc")?;
    if !p.truthy()? {
        return response(f, "no_live_runner");
    }
    warn(
        f,
        "session_provider_error_stop",
        &[
            ("source", f.get(c"source")?),
            ("reason", f.get(c"reason")?),
            ("pid", p.get(c"pid")?),
        ],
    )?;
    signal(p, "SIGTERM")?;
    f.set(c"providerProc", p)?;
    let kill = callback(f, "", 0, 0, |f, _| {
        let p = f.get(c"providerProc")?;
        warn(
            f,
            "session_provider_error_force_kill",
            &[("pid", p.get(c"pid")?)],
        )?;
        signal(p, "SIGKILL")?;
        empty(f)
    })?;
    let timeout = call(
        f.global()?,
        c"setTimeout",
        &[kill, h(f)?.get(c"runnerKillGraceMs")?],
    )?;
    if callable(timeout.get(c"unref")?)? {
        call(timeout, c"unref", &[])?;
    }
    p.catch(|| {
        let clear = callback(timeout, "", 0, 0, |t, _| {
            call(t.global()?, c"clearTimeout", &[t])
        })?;
        call(p, c"once", &[text(f, "exit")?, clear])
    })?;
    fields(f, &[("ok", flag(f, true)?), ("pid", p.get(c"pid")?)])
}
fn clear_transcript<'a>(state: L<'a>, _: L<'a>) -> Result<L<'a>> {
    state.assign(c"currentAssistantText", text(state, "")?)?;
    state.assign(c"currentToolCalls", state.from_value(&V::Array(vec![]))?)?;
    empty(state)
}
pub(super) fn stop(f: L<'_>) -> Result<L<'_>> {
    async_result(f, || {
        let s = chat(f)?;
        let id = id(f)?;
        let reason = f.get(c"effectiveReason")?;
        let kill = f.get(c"effectiveKill")?;
        d(
            f,
            c"assignKillReason",
            &[s.optional(c"_activeRunner")?, kill],
        )?;
        d(f, c"cancelPreparation", &[id, reason])?;
        if !s.truthy()? {
            return empty(f);
        }
        d(f, c"cancelClassify", &[s])?;
        if has_dep(f, c"cancelSessionClassifyJobs")? {
            warn_error(
                f,
                "session_cancel_classify_jobs_failed",
                d(f, c"cancelSessionClassifyJobs", &[id]),
            )?;
        }
        let runner = s.get(c"_activeRunner")?;
        if runner.optional(c"providerAttempt")?.truthy()? {
            let outcome = fields(
                f,
                &[
                    ("outcome", text(f, "failed")?),
                    ("errorCategory", text(f, "cancelled")?),
                    ("reasonCode", kill),
                ],
            )?;
            d(
                f,
                c"finishProviderAttempt",
                &[runner.get(c"providerAttempt")?, outcome],
            )?;
        }
        let stream = deps(f)?.get(c"chatStream")?;
        if cli_capability::is_resident(&cli_name(s)?)
            && (call(stream, c"isAlive", &[id])?.truthy()?
                || (!stream.get(c"status")?.nullish()?
                    && call(stream, c"status", &[id])?
                        .optional(c"busy")?
                        .truthy()?))
        {
            log(
                f,
                c"log",
                &[interpolate(
                    f,
                    "[multicc/chat] [",
                    &[(id, "] (streaming) cancel requested ("), (reason, ")")],
                )?],
            )?;
            call(stream, c"cancel", &[id])?;
        }
        let p = s.get(c"claudeProc")?;
        if p.truthy()? {
            log(
                f,
                c"log",
                &[interpolate(
                    f,
                    "[multicc/chat] [",
                    &[
                        (id, "] Cancel requested ("),
                        (reason, "), killing child process pid="),
                        (p.get(c"pid")?, ""),
                    ],
                )?],
            )?;
            signal(p, "SIGTERM")?;
            s.assign(c"claudeProc", null(f)?)?;
            s.assign(c"_cancelledProc", p)?;
            p.catch(|| {
                let refs = fields(f, &[("proc", p), ("state", s)])?;
                let clear = callback(refs, "", 0, 0, |refs, _| {
                    let state = refs.get(c"state")?;
                    if state.get(c"_cancelledProc")?.equals(refs.get(c"proc")?)? {
                        state.assign(c"_cancelledProc", null(state)?)?;
                    }
                    empty(state)
                })?;
                call(p, c"once", &[text(f, "exit")?, clear])
            })?;
            s.assign(c"lineBuf", text(f, "")?)?;
            if s.get(c"isStreaming")?.truthy()? {
                f.catch(|| {
                    d(
                        f,
                        c"broadcast",
                        &[id, fields(f, &[("type", text(f, "stream_end")?)])?],
                    )
                })?;
            }
        }
        s.assign(c"isStreaming", flag(f, false)?)?;
        call(deps(f)?.get(c"replay")?, c"clear", &[id])?;
        let list = s.get(c"currentToolCalls")?;
        let tools = if list.is_array()? {
            s.get(c"currentToolCalls")?
        } else {
            f.from_value(&V::Array(vec![]))?
        };
        if s.get(c"currentAssistantText")?.truthy()? || tools.get(c"length")?.truthy()? {
            let msg = fields(
                f,
                &[
                    ("role", text(f, "assistant")?),
                    (
                        "content",
                        fallback(s.get(c"currentAssistantText")?, "".into())?,
                    ),
                    (
                        "tools",
                        if tools.get(c"length")?.truthy()? {
                            tools
                        } else {
                            empty(f)?
                        },
                    ),
                    ("ts", now(f)?),
                    ("cancelled", flag(f, true)?),
                ],
            )?;
            let redacted = raw(
                f,
                crate::provider_scrub::redaction_route_capability_value(env(f), arg(msg)?)?,
            );
            return schedule_step(
                s,
                d(f, c"appendMessage", &[id, redacted])?,
                clear_transcript,
                None,
            );
        }
        empty(f)
    })
}
