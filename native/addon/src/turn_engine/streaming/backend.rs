//! 常驻后端的原生会话恢复、工作区写租约和进程生命周期。
use super::*;

fn resume<'a>(st: Stream<'a>) -> Result<L<'a>> {
    let s = st.state;
    let session = st.session;
    let id = st.turn.get(c"turnId")?;
    st.port(c"clearSessionApiErrorState", &[session, st.cs])?;
    st.service(
        c"turnProgressHeartbeat",
        c"updatePhase",
        &[session, id, text(s, "recovering")?],
    )?;
    st.port(
        c"setSessionStatus",
        &[
            session,
            fields(
                s,
                &[("status", text(s, "thinking")?), ("currentFile", null(s)?)],
            )?,
        ],
    )?;
    st.port(
        c"chatBroadcast",
        &[
            session,
            fields(
                s,
                &[
                    ("type", text(s, "system")?),
                    ("subtype", text(s, "warning")?),
                    (
                        "message",
                        text(
                            s,
                            "Claude 原生会话记录已失效，已自动新建上下文并重试本条消息。",
                        )?,
                    ),
                ],
            )?,
        ],
    )?;
    st.log(
        c"warn",
        "chat_stream_resume_target_missing_recovered",
        &[("sessionId", session), ("turnId", st.turn.get(c"turnId")?)],
    )?;
    caught(
        s,
        || {
            let get = st.ports.get(c"getChatHistoryService")?;
            let service = if get.kind()? == sys::ValueType::napi_function {
                get.call_plain(&[])?
            } else {
                null(s)?
            };
            let built = if service.optional(c"handoffCheckpoint")?.kind()?
                == sys::ValueType::napi_function
            {
                let record = if st.record.truthy()? {
                    fields(
                        s,
                        &[
                            ("taskState", st.record.get(c"taskState")?),
                            ("summary", st.record.get(c"summary")?),
                        ],
                    )?
                } else {
                    st.record
                };
                let opts = fields(
                    s,
                    &[
                        ("session", record),
                        ("excludeTurnId", fallback(st.turn.get(c"turnId")?, V::Null)?),
                    ],
                )?;
                call(service, c"handoffCheckpoint", &[session, opts])?
            } else {
                null(s)?
            };
            let cli = text(s, "claude")?;
            let checkpoint = if built.truthy()? {
                let date = s.global()?.get(c"Date")?.construct(&[])?;
                fields(
                    s,
                    &[
                        ("version", num(s, 1.)?),
                        ("createdAt", call(date, c"toISOString", &[])?),
                        ("fromCli", cli),
                        ("toCli", cli),
                        ("task", built.get(c"task")?),
                        ("git", null(s)?),
                        ("transcript", built.get(c"transcript")?),
                    ],
                )?
            } else {
                let opts = fields(
                    s,
                    &[
                        ("session", st.record),
                        ("fromCli", cli),
                        ("toCli", cli),
                        ("history", st.port(c"viewChatHistory", &[session])?),
                        ("git", null(s)?),
                        ("excludeTurnId", fallback(st.turn.get(c"turnId")?, V::Null)?),
                    ],
                )?;
                st.port(c"buildHandoffCheckpoint", &[opts])?
            };
            let reason = text(s, "auto_native_resume_recovery")?;
            checkpoint.assign(c"reason", reason)?;
            let prompt = st.port(
                c"renderHandoffPrompt",
                &[fields(
                    s,
                    &[
                        (
                            "id",
                            join(
                                s,
                                &[
                                    text(s, "resume_recovery_")?,
                                    fallback(st.turn.get(c"turnId")?, "unknown".into())?,
                                ],
                            )?,
                        ),
                        ("fromCli", cli),
                        ("toCli", cli),
                        ("reason", reason),
                        ("checkpoint", checkpoint),
                    ],
                )?],
            )?;
            let payload = st.invocation.get(c"payload")?;
            fields(
                s,
                &[(
                    "text",
                    if prompt.truthy()? {
                        join(s, &[prompt, payload])?
                    } else {
                        payload
                    },
                )],
            )
        },
        |error| {
            let code = if error.truthy()? && read(error, c"code")?.truthy()? {
                read(error, c"code")?
            } else {
                text(s, "checkpoint_failed")?
            };
            st.log(
                c"warn",
                "chat_stream_resume_checkpoint_failed",
                &[
                    ("sessionId", session),
                    ("turnId", st.turn.get(c"turnId")?),
                    ("code", code),
                ],
            )?;
            fields(s, &[("text", st.invocation.get(c"payload")?)])
        },
    )
}
fn invalidate<'a>(st: Stream<'a>, count: L<'a>) -> Result<L<'a>> {
    if count.positive()? {
        call(
            st.port(c"getChatHistoryService", &[])?,
            c"invalidate",
            &[st.session],
        )?;
        st.console(&[
            text(st.state, "[multicc/chat] [")?,
            st.session,
            text(st.state, "] sanitized ")?,
            count,
            text(st.state, " empty thinking block(s) from session JSONL")?,
        ])?;
    }
    undefined(st.state)
}
pub(super) fn ensure<'a>(
    st: Stream<'a>,
    args: L<'a>,
    file: L<'a>,
    resume_existing: bool,
) -> Result<()> {
    let s = st.state;
    let inv = st.invocation;
    let spawn = st.port(c"spawnContractOf", &[st.record])?;
    let opts = fields(
        s,
        &[
            ("cmd", inv.get(c"cmd")?),
            ("spawnContract", spawn),
            (
                "onHoldCap",
                st.callback("onHoldCap", 1, |st, a| {
                    let n = a[0].explicit_number()?;
                    let n = if n.is_nan() { 0. } else { n };
                    st.service(
                        c"sessionNotices",
                        c"notifyHoldCap",
                        &[fields(
                            st.state,
                            &[
                                ("sessionId", st.session),
                                ("minutes", num(st.state, n / 60_000.)?),
                            ],
                        )?],
                    )?;
                    undefined(st.state)
                })?,
            ),
            ("cwd", st.cs.get(c"cwd")?),
            ("sessionId", st.record.get_key(s.get(c"nativeKey")?)?),
            ("sdkOptions", inv.get(c"sdkOptions")?),
            ("streamBackend", inv.get(c"streamBackend")?),
            ("settingsFile", file),
            ("resume", flag(s, resume_existing)?),
            ("baseArgs", args),
            (
                "onNewSessionId",
                st.callback("onNewSessionId", 1, |st, a| {
                    st.set_session_id(a[0], "runtime.streaming-session-id-capture")?;
                    undefined(st.state)
                })?,
            ),
            (
                "onResumeTargetMissing",
                st.callback("onResumeTargetMissing", 0, |st, _| resume(st))?,
            ),
            (
                "acquireWriter",
                st.callback("acquireWriter", 0, |st, _| {
                    let v = st.workspace_optional(
                        c"acquireProcessWriter",
                        &[st.session, text(st.state, "stream")?],
                    )?;
                    if v.nullish()? {
                        null(st.state)
                    } else {
                        Ok(v)
                    }
                })?,
            ),
            (
                "annotateWriter",
                st.callback("annotateWriter", 2, |st, a| {
                    st.workspace_optional(c"annotateWriterPid", &[st.session, a[0], a[1]])
                })?,
            ),
            (
                "releaseWriter",
                st.callback("releaseWriter", 1, |st, a| {
                    st.workspace_optional(c"finishProcessWriter", &[st.session, a[0]])
                })?,
            ),
            (
                "beforeSpawn",
                st.callback("beforeSpawn", 1, |st, a| {
                    let session_id = read(a[0], c"sessionId")?;
                    let opts = fields(
                        st.state,
                        &[("sessionId", st.session), ("baseUrl", st.base_url()?)],
                    )?;
                    st.service(
                        c"routerToolHost",
                        c"refreshPersistentProcess",
                        &[st.cs, st.state.get(c"childEnv")?, opts],
                    )?;
                    let cleaned = if st.provider.get(c"prepareSpawn")?.kind()?
                        == sys::ValueType::napi_function
                    {
                        call(
                            st.provider,
                            c"prepareSpawn",
                            &[fields(st.state, &[("sessionId", session_id)])?],
                        )?
                    } else {
                        num(st.state, 0.)?
                    };
                    if cleaned.truthy()?
                        && read(cleaned, c"then")?.kind()? == sys::ValueType::napi_function
                    {
                        let cb = st.callback("invalidate", 1, |st, a| invalidate(st, a[0]))?;
                        call(cleaned, c"then", &[cb])
                    } else {
                        invalidate(st, cleaned)
                    }
                })?,
            ),
            ("env", s.get(c"childEnv")?),
            (
                "onWorkspaceActivity",
                st.callback("onWorkspaceActivity", 0, |st, _| {
                    st.workspace_optional(
                        c"recordWriterActivity",
                        &[st.session, text(st.state, "stream")?],
                    )
                })?,
            ),
            (
                "onDispose",
                st.callback("onDispose", 0, |st, _| {
                    st.service(c"routerToolHost", c"releasePersistentProcess", &[st.cs])
                })?,
            ),
            ("monitorAdmission", flag(s, true)?),
            (
                "onBackgroundEvent",
                st.callback("onBackgroundEvent", 1, |st, a| {
                    caught(
                        st.state,
                        || {
                            st.workspace_optional(
                                c"recordWriterActivity",
                                &[st.session, text(st.state, "background")?],
                            )
                        },
                        |e| {
                            st.log(
                                c"warn",
                                "workspace_writer_fence_failed",
                                &[("sessionId", st.session), ("code", read(e, c"code")?)],
                            )
                        },
                    )?;
                    call(
                        st.port(c"getBackgroundTaskRuntime", &[])?,
                        c"handleEvent",
                        &[st.session, st.cs, a[0]],
                    )
                })?,
            ),
            (
                "isBackgroundActive",
                st.callback("isBackgroundActive", 0, |st, _| {
                    call(
                        st.port(c"getBackgroundTaskRuntime", &[])?,
                        c"hasProcessBackgroundTasks",
                        &[st.session],
                    )
                })?,
            ),
            (
                "onExit",
                st.callback("onExit", 0, |st, _| {
                    caught(
                        st.state,
                        || {
                            let reaped = call(
                                st.port(c"getBackgroundTaskRuntime", &[])?,
                                c"reapSessionShadows",
                                &[
                                    st.session,
                                    fields(
                                        st.state,
                                        &[("reason", text(st.state, "stream_exit")?)],
                                    )?,
                                ],
                            )?;
                            if reaped.positive()? {
                                st.console(&[
                                    text(st.state, "[multicc/chat] [")?,
                                    st.session,
                                    text(st.state, "] stream exited; reaped ")?,
                                    reaped,
                                    text(st.state, " background task(s)")?,
                                ])?;
                            }
                            undefined(st.state)
                        },
                        |e| {
                            st.log(
                                c"warn",
                                "bg_reap_on_exit_failed",
                                &[("sessionId", st.session), ("error", read(e, c"message")?)],
                            )?;
                            undefined(st.state)
                        },
                    )
                })?,
            ),
        ],
    )?;
    if inv.get(c"streamBackend")?.is_string("agy-stream-json")? {
        agy::configure(st, opts)?;
    }
    st.service(c"chatStream", c"ensure", &[st.session, opts])?;
    Ok(())
}
