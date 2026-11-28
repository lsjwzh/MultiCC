//! 仅接受当前运行器的子进程输出。stderr 保留未结束的行，供关闭时结算。
use super::*;
use multicc_core::agy_stream::effort;

fn active(st: RunnerContext<'_>) -> Result<bool> {
    Ok(st.cs.get(c"claudeProc")?.equals(st.state.get(c"proc")?)?
        && st
            .port(
                c"isCurrentTurnRunner",
                &[st.cs, st.turn, st.state.get(c"runner")?],
            )?
            .truthy()?)
}
fn line<'a>(st: RunnerContext<'a>, line: L<'a>) -> Result<L<'a>> {
    let s = st.state;
    let runner = s.get(c"runner")?;
    if !st
        .service(
            c"attemptRuntime",
            c"acceptEvent",
            &[runner.get(c"providerAttempt")?],
        )?
        .truthy()?
    {
        return undefined(s);
    }
    let event = s.catch(|| call(s.global()?.get(c"JSON")?, c"parse", &[line]))?;
    let watch = s.get(c"agyEffortFlag")?.truthy()?;
    let Some(event) = event else {
        if watch {
            let diagnostic = line.coerce_string()?.to_string_lossy();
            if effort::unsupported(&diagnostic) {
                s.set(c"agyPlainRejection", flag(s, true)?)?;
                s.set(
                    c"stderrBuf",
                    join(s, &[s.get(c"stderrBuf")?, line, text(s, "\n")?])?,
                )?;
                return undefined(s);
            }
            if diagnostic.trim() != "Fetching available models..." {
                s.set(c"agyOutputObserved", flag(s, true)?)?;
            }
        }
        let count = crate::schedule_note_queued_live::plus_one(fallback(
            st.cs.get(c"_jsonlParseErrors")?,
            V::Number(0.),
        )?)?;
        st.cs.assign(c"_jsonlParseErrors", count)?;
        if st.cs.get(c"_jsonlParseErrors")?.number()? <= 5. {
            st.log(
                c"warn",
                "chat_jsonl_parse_failed",
                &[
                    ("sessionId", st.session),
                    ("provider", st.cs.get(c"cli")?),
                    ("count", st.cs.get(c"_jsonlParseErrors")?),
                    ("bytes", read(line, c"length")?),
                ],
            )?;
        }
        return undefined(s);
    };
    if watch {
        let kind = event.optional(c"event")?;
        let result = event.optional(c"result")?;
        let message = result
            .optional(c"error")?
            .string()?
            .map(|s| s.to_string_lossy());
        if kind.is_string("result")?
            && !result.optional(c"status")?.is_string("SUCCESS")?
            && message.as_deref().is_some_and(effort::unsupported)
        {
            s.set(c"agyRejection", event)?;
            return undefined(s);
        }
        if !kind.is_string("init")? {
            s.set(c"agyOutputObserved", flag(s, true)?)?;
        }
    }
    apply(st, event)
}
fn apply<'a>(st: RunnerContext<'a>, event: L<'a>) -> Result<L<'a>> {
    let s = st.state;
    st.port(
        c"applyAdapterChatEvent",
        &[
            st.provider,
            st.cs,
            st.record,
            st.session,
            event,
            s.get(c"forward")?,
            st.turn,
            s.get(c"runner")?,
        ],
    )?;
    undefined(s)
}
fn stdout<'a>(st: RunnerContext<'a>, chunk: L<'a>) -> Result<L<'a>> {
    let s = st.state;
    if active(st)? {
        st.service(
            c"turnTiming",
            c"markFirstByte",
            &[st.session, st.turn.get(c"turnId")?],
        )?;
        let buf = join(s, &[st.cs.get(c"lineBuf")?, call(chunk, c"toString", &[])?])?;
        st.cs.assign(c"lineBuf", buf)?;
        let lines = call(st.cs.get(c"lineBuf")?, c"split", &[text(s, "\n")?])?;
        st.cs.assign(c"lineBuf", call(lines, c"pop", &[])?)?;
        lines.for_each(|item| {
            if call(item, c"trim", &[])?.truthy()? {
                s.catch(|| line(st, item))?;
            }
            Ok(())
        })?;
    }
    undefined(s)
}
fn stderr<'a>(st: RunnerContext<'a>, chunk: L<'a>) -> Result<L<'a>> {
    let s = st.state;
    if active(st)? {
        let buf = join(
            s,
            &[s.get(c"stderrPending")?, call(chunk, c"toString", &[])?],
        )?;
        s.set(c"stderrPending", buf)?;
        let lines = call(buf, c"split", &[text(s, "\n")?])?;
        s.set(c"stderrPending", call(lines, c"pop", &[])?)?;
        lines.for_each(|item| {
            if !st.port(c"isKnownHarmlessStderrLine", &[item])?.truthy()? {
                s.set(
                    c"stderrBuf",
                    join(s, &[s.get(c"stderrBuf")?, item, text(s, "\n")?])?,
                )?;
                st.log(
                    c"warn",
                    "chat_provider_stderr",
                    &[
                        ("sessionId", st.session),
                        ("provider", st.cs.get(c"cli")?),
                        ("message", st.port(c"sanitizeApiErrorMessage", &[item])?),
                    ],
                )?;
            }
            Ok(())
        })?;
    }
    undefined(s)
}
fn error<'a>(st: RunnerContext<'a>, err: L<'a>) -> Result<L<'a>> {
    let s = st.state;
    if active(st)? {
        let prop = |key: &std::ffi::CStr| -> Result<_> {
            if err.truthy()? {
                read(err, key)
            } else {
                Ok(err)
            }
        };
        let reason = join(
            s,
            &[
                text(s, "spawn_error:")?,
                fallback(prop(c"code")?, "unknown".into())?,
            ],
        )?;
        st.service(
            c"turnTiming",
            c"abort",
            &[st.session, st.turn.get(c"turnId")?, reason],
        )?;
        s.get(c"runner")?.assign(
            c"apiErrorRaw",
            fields(
                s,
                &[
                    ("source", text(s, "process_stderr")?),
                    ("provider", st.cs.get(c"cli")?),
                    ("code", fallback(prop(c"code")?, "spawn_failed".into())?),
                    ("message", prop(c"message")?),
                ],
            )?,
        )?;
        st.log(
            c"error",
            "chat_provider_spawn_error",
            &[
                ("sessionId", st.session),
                ("provider", st.cs.get(c"cli")?),
                ("code", fallback(prop(c"code")?, "spawn_failed".into())?),
            ],
        )?;
    }
    undefined(s)
}
pub(super) fn listen(st: RunnerContext<'_>) -> Result<()> {
    let s = st.state;
    let proc = s.get(c"proc")?;
    if st.record.get(c"cli")?.is_string("agy")?
        && call(
            st.invocation.get(c"args")?,
            c"includes",
            &[text(s, "--effort")?],
        )?
        .truthy()?
    {
        s.set(c"agyEffortFlag", flag(s, true)?)?;
        s.set(
            c"applyAgyRejection",
            st.callback("applyAgyRejection", 1, |st, a| apply(st, a[0]))?,
        )?;
    }
    s.set(c"stderrBuf", text(s, "")?)?;
    s.set(c"stderrPending", text(s, "")?)?;
    s.set(
        c"isActiveProc",
        st.callback("isActiveProc", 0, |st, _| flag(st.state, active(st)?))?,
    )?;
    s.set(
        c"handleLine",
        st.callback("handleLine", 1, |st, a| line(st, a[0]))?,
    )?;
    s.set(
        c"forward",
        st.callback("forward", 1, |st, a| {
            st.port(
                c"forwardProviderEvent",
                &[st.session, st.cs, st.turn, st.state.get(c"runner")?, a[0]],
            )?;
            undefined(st.state)
        })?,
    )?;
    call(
        proc.get(c"stdout")?,
        c"on",
        &[
            text(s, "data")?,
            st.callback("", 1, |st, a| stdout(st, a[0]))?,
        ],
    )?;
    call(
        proc.get(c"stderr")?,
        c"on",
        &[
            text(s, "data")?,
            st.callback("", 1, |st, a| stderr(st, a[0]))?,
        ],
    )?;
    call(
        proc,
        c"on",
        &[
            text(s, "error")?,
            st.callback("", 1, |st, a| error(st, a[0]))?,
        ],
    )?;
    let closed = st.callback("", 2, |st, a| {
        let pending = st.port(c"closeTurn", &[st.state, a[0], a[1]])?;
        let failed = st.callback("", 1, |st, a| {
            let e = a[0];
            let message = if e.truthy()? && read(e, c"message")?.truthy()? {
                read(e, c"message")?
            } else {
                string(e)?
            };
            st.log(
                c"error",
                "chat_close_handler_failed",
                &[("sessionId", st.session), ("message", message)],
            )?;
            undefined(st.state)
        })?;
        call(pending, c"catch", &[failed])?;
        undefined(st.state)
    })?;
    call(proc, c"on", &[text(s, "close")?, closed])?;
    Ok(())
}
