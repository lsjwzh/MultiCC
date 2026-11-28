//! 每次发送绑定独立的运行器；迟到的事件、重试和收尾均使用原序号。
use super::*;
use std::ffi::CStr;

fn current(st: Stream<'_>) -> Result<bool> {
    st.port(
        c"isCurrentTurnRunner",
        &[st.cs, st.turn, st.state.get(c"runner")?],
    )?
    .truthy()
}
fn timing<'a>(st: Stream<'a>, phase: L<'a>) -> Result<L<'a>> {
    if phase.is_string("spawned")? {
        st.service(
            c"turnTiming",
            c"markSpawned",
            &[st.session, st.turn.get(c"turnId")?],
        )?;
        let ws = st.workspace()?;
        if !ws.nullish()? {
            let status = st.service(c"chatStream", c"status", &[st.session])?;
            call(
                ws,
                c"spawned",
                &[
                    st.session,
                    fields(st.state, &[("pid", status.optional(c"pid")?)])?,
                ],
            )?;
        }
    } else if phase.is_string("sent")? {
        st.service(
            c"turnTiming",
            c"markSent",
            &[st.session, st.turn.get(c"turnId")?],
        )?;
        st.service(c"managedContext", c"contextSent", &[st.turn])?;
    } else if phase.is_string("firstByte")? {
        st.service(
            c"turnTiming",
            c"markFirstByte",
            &[st.session, st.turn.get(c"turnId")?],
        )?;
    }
    undefined(st.state)
}
fn rejected<'a>(st: Stream<'a>, err: L<'a>) -> Result<L<'a>> {
    let s = st.state;
    let runner = s.get(c"runner")?;
    let prop = |key: &CStr| -> Result<_> {
        if err.truthy()? {
            read(err, key)
        } else {
            Ok(err)
        }
    };
    let reason = join(
        s,
        &[
            text(s, "stream_ended_before_first_byte:")?,
            fallback(prop(c"code")?, "exit".into())?,
        ],
    )?;
    st.service(
        c"turnTiming",
        c"abort",
        &[st.session, st.turn.get(c"turnId")?, reason],
    )?;
    if !runner.get(c"killReason")?.truthy()? && !runner.get(c"modelTimeoutStopping")?.truthy()? {
        runner.assign(c"sawApiError", flag(s, true)?)?;
        runner.assign(
            c"apiErrorRaw",
            fields(
                s,
                &[
                    ("source", text(s, "anthropic_event")?),
                    ("provider", st.provider.get(c"name")?),
                    ("code", prop(c"code")?),
                    ("message", prop(c"message")?),
                ],
            )?,
        )?;
    }
    let provider = st.provider.get(c"name")?;
    let code = fallback(prop(c"code")?, V::Null)?;
    let message = call(
        string(fallback(prop(c"message")?, "".into())?)?,
        c"slice",
        &[num(s, -240.)?],
    )?;
    let message = st.port(c"sanitizeApiErrorMessage", &[message])?;
    st.log(
        c"warn",
        "chat_stream_ended_early",
        &[
            ("sessionId", st.session),
            ("provider", provider),
            ("code", code),
            ("message", message),
            ("killed", flag(s, runner.get(c"killReason")?.truthy()?)?),
        ],
    )?;
    undefined(s)
}
fn finalize_error<'a>(st: Stream<'a>, error: L<'a>) -> Result<L<'a>> {
    let s = st.state;
    if current(st)? {
        st.cs.assign(c"isStreaming", flag(s, false)?)?;
        st.cs.assign(c"_activeRunner", null(s)?)?;
        call(
            st.port(c"getChatHistoryRuntime", &[])?,
            c"clearIncrementalSave",
            &[st.session],
        )?;
        let failed = call(
            st.port(c"getSessionWorkHost", &[])?,
            c"turnFailed",
            &[st.session, text(s, "finalization_failed")?],
        )?;
        let p = call(s.global()?.get(c"Promise")?, c"resolve", &[failed])?;
        call(
            p,
            c"catch",
            &[st.callback("", 0, |st, _| undefined(st.state))?],
        )?;
        st.port(
            c"chatBroadcast",
            &[
                st.session,
                fields(
                    s,
                    &[
                        ("type", text(s, "error")?),
                        (
                            "error",
                            text(s, "本轮收尾失败，结果尚未确认；请检查日志。")?,
                        ),
                    ],
                )?,
            ],
        )?;
        st.port(
            c"chatBroadcast",
            &[st.session, fields(s, &[("type", text(s, "stream_end")?)])?],
        )?;
    }
    st.log(
        c"error",
        "chat_stream_finalize_failed",
        &[
            ("sessionId", st.session),
            ("turnId", st.turn.get(c"turnId")?),
            (
                "message",
                fallback(error.optional(c"message")?, "finalization failed".into())?,
            ),
        ],
    )?;
    undefined(s)
}
pub(super) fn send<'a>(
    st: Stream<'a>,
    params: L<'a>,
    prepared: L<'a>,
    attempt: L<'a>,
) -> Result<()> {
    let s = st.state;
    // Reflect the JS + operator (including a string recovered from an older session).
    let old = fallback(st.cs.get(c"_streamTurnSeq")?, V::Number(0.))?;
    let seq = crate::schedule_note_queued_live::plus_one(old)?;
    st.cs.assign(c"_streamTurnSeq", seq)?;
    let completion = st.port(c"createAdapterCompletion", &[st.provider])?;
    let random = st.service(c"crypto", c"randomBytes", &[num(s, 6.)?])?;
    let runner_id = join(
        s,
        &[
            text(s, "stream_")?,
            seq,
            text(s, "_")?,
            call(random, c"toString", &[text(s, "hex")?])?,
        ],
    )?;
    let runner = st.port(
        c"createRunnerOwnership",
        &[
            st.turn,
            fields(
                s,
                &[
                    ("completion", completion),
                    ("runnerId", runner_id),
                    ("kind", text(s, "stream")?),
                    ("sequence", seq),
                    ("providerAttempt", attempt),
                    ("routeProof", prepared.get(c"routeProof")?),
                    ("usageAttribution", prepared.get(c"usageAttribution")?),
                ],
            )?,
        ],
    )?;
    let retry = params.get(c"apiRetryAttempt")?.explicit_number()?;
    runner.assign(c"apiRetryAttempt", num(s, retry.max(0.))?)?;
    st.cs.assign(c"_activeTurn", st.turn)?;
    st.cs.assign(c"_activeRunner", runner)?;
    s.set(c"runner", runner)?;
    s.set(c"seq", seq)?;
    s.set(c"prepared", prepared)?;
    s.set(c"prepareInvocation", params.get(c"prepareInvocation")?)?;
    s.set(c"autoTurn", params.get(c"autoTurn")?)?;
    let forward = st.callback("forward", 1, |st, a| {
        st.port(
            c"forwardProviderEvent",
            &[st.session, st.cs, st.turn, st.state.get(c"runner")?, a[0]],
        )?;
        undefined(st.state)
    })?;
    s.set(c"forward", forward)?;
    let count = st.cs.get(c"chatTurnCount")?;
    let model = fallback(st.record.get(c"model")?, "default".into())?;
    let status = st.service(c"chatStream", c"status", &[st.session])?;
    let status = call(s.global()?.get(c"JSON")?, c"stringify", &[status])?;
    st.console(&[
        text(s, "[multicc/chat] [")?,
        st.session,
        text(s, "] (streaming) send turn=")?,
        count,
        text(s, " model=")?,
        model,
        text(s, " status=")?,
        status,
    ])?;
    let event = st.callback("", 1, |st, a| {
        let runner = st.state.get(c"runner")?;
        if current(st)?
            && st
                .service(
                    c"attemptRuntime",
                    c"acceptEvent",
                    &[runner.get(c"providerAttempt")?],
                )?
                .truthy()?
        {
            st.service(
                c"turnTiming",
                c"markFirstByte",
                &[st.session, st.turn.get(c"turnId")?],
            )?;
            if agy::defer(st, a[0])? {
                return undefined(st.state);
            }
            st.port(
                c"applyAdapterChatEvent",
                &[
                    st.provider,
                    st.cs,
                    st.record,
                    st.session,
                    a[0],
                    st.state.get(c"forward")?,
                    st.turn,
                    runner,
                ],
            )?;
        }
        undefined(st.state)
    })?;
    let opts = fields(
        s,
        &[
            ("turnOptions", st.invocation.get(c"turnOptions")?),
            (
                "onTiming",
                st.callback("onTiming", 1, |st, a| timing(st, a[0]))?,
            ),
        ],
    )?;
    let pending = st.service(
        c"chatStream",
        c"send",
        &[st.session, st.invocation.get(c"payload")?, event, opts],
    )?;
    let hooks = fields(
        s,
        &[
            ("runner", runner),
            ("logger", st.ports.get(c"logger")?),
            (
                "finalize",
                st.callback("finalize", 0, |st, _| {
                    let s = st.state;
                    if agy::retry(st)? {
                        return undefined(s);
                    }
                    st.port(
                        c"finalizeStreamingTurn",
                        &[
                            st.session,
                            st.cs,
                            st.record,
                            s.get(c"seq")?,
                            st.turn,
                            s.get(c"runner")?,
                            s.get(c"prepared")?,
                            st.provider,
                            s.get(c"prepareInvocation")?,
                            s.get(c"autoTurn")?,
                        ],
                    )
                })?,
            ),
            (
                "onRejected",
                st.callback("onRejected", 1, |st, a| rejected(st, a[0]))?,
            ),
            (
                "onFinalizeError",
                st.callback("onFinalizeError", 1, |st, a| finalize_error(st, a[0]))?,
            ),
        ],
    )?;
    st.port(c"finalizeCompletionStream", &[pending, hooks])?;
    Ok(())
}
