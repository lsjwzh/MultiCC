//! Session lifecycle, correlation, buffering and cancellation are native-owned.
use super::*;

fn sessions(p: L<'_>) -> Result<L<'_>> {
    p.get(c"sessions")
}
fn find<'a>(p: L<'a>, params: L<'a>) -> Result<L<'a>> {
    call(
        sessions(p)?,
        c"get",
        &[clean_value(default_object(params)?.get(c"sessionId")?)?],
    )
}
fn capacity(p: L<'_>) -> Result<()> {
    if sessions(p)?.get(c"size")?.number()? >= p.get(c"sessionLimit")?.number()? {
        fail(p, "session_limit_reached", "ACP session limit reached")?;
    }
    Ok(())
}
fn uuid(p: L<'_>) -> Result<L<'_>> {
    p.get(c"randomUUID")?.call_plain(&[])
}
fn new_session<'a>(p: L<'a>, id: L<'a>, cwd: L<'a>, g: L<'a>) -> Result<L<'a>> {
    let s = fields(
        p,
        &[
            ("p", p),
            ("id", id),
            ("cwd", clean_value(cwd)?),
            ("gatewayRecord", g),
            (
                "target",
                if g.truthy()? {
                    transport::fleet_target(g)?
                } else {
                    null(p)?
                },
            ),
            ("socket", null(p)?),
            ("openPromise", null(p)?),
            ("active", null(p)?),
            ("closed", flag(p, false)?),
        ],
    )?;
    call(sessions(p)?, c"set", &[id, s])?;
    Ok(s)
}
fn initial_gateway(p: L<'_>) -> Result<L<'_>> {
    if p.get(c"launchMode")?.truthy()? {
        resolved(null(p)?)
    } else {
        transport::gateway(p)
    }
}
fn created<'a>(q: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = q.get(c"p")?;
    let id = uuid(p)?;
    new_session(p, id, q.get(c"cwd")?, a[0])?;
    let meta = if p.get(c"launchMode")?.truthy()? {
        fields(
            p,
            &[
                ("routing", text(p, "voice-launch")?),
                ("taskAuthority", text(p, "multicc-task-board")?),
            ],
        )?
    } else {
        fields(
            p,
            &[
                ("directoryId", p.get(c"directory")?),
                ("gatewayId", a[0].get(c"id")?),
                ("commanderSessionId", a[0].get(c"commanderSessionId")?),
                ("taskAuthority", text(p, "multicc-task-board")?),
            ],
        )?
    };
    fields(
        p,
        &[
            ("sessionId", id),
            ("_meta", fields(p, &[("multicc", meta)])?),
        ],
    )
}
pub(super) fn create<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let o = default_object(a[0])?;
        let cwd = o.get(c"cwd")?;
        capacity(p)?;
        let q = fields(p, &[("p", p), ("cwd", cwd)])?;
        // Launch creation has no await in the original contract: publish its
        // mapping synchronously, so consecutive calls see capacity immediately.
        if p.get(c"launchMode")?.truthy()? {
            return created(q, &mut [null(p)?]);
        }
        then(transport::gateway(p)?, q, created)
    })
}
pub(super) fn resume<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let o = default_object(a[0])?;
        let id = clean_value(o.get(c"sessionId")?)?;
        if !id.truthy()? {
            return Err(p.type_error("ACP resume requires sessionId"));
        }
        let previous = call(sessions(p)?, c"get", &[id])?;
        if !previous.truthy()? {
            capacity(p)?;
        }
        let q = fields(p, &[("p", p), ("id", id), ("cwd", o.get(c"cwd")?)])?;
        let closed = if previous.truthy()? {
            close_inner(previous)?
        } else {
            undef(p)?
        };
        let ready = then(closed, q, |q, _| initial_gateway(q.get(c"p")?))?;
        then(ready, q, |q, a| {
            new_session(q.get(c"p")?, q.get(c"id")?, q.get(c"cwd")?, a[0])?;
            fields(q, &[])
        })
    })
}
pub(super) fn prompt<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let o = default_object(a[0])?;
        let s = find(p, o)?;
        if !s.truthy()? {
            return fail(
                p,
                "session_not_found",
                &format!(
                    "ACP session {} not found",
                    fold_string(o.get(c"sessionId")?)?
                ),
            );
        }
        if s.get(c"active")?.truthy()? {
            return fail(
                p,
                "session_busy",
                &format!(
                    "ACP session {} already has an active prompt",
                    fold_string(s.get(c"id")?)?
                ),
            );
        }
        let parts = prompt_parts(o.get(c"prompt")?)?;
        if !parts.get(c"text")?.truthy()? {
            return fail(
                p,
                "empty_prompt",
                "ACP prompt contains no supported content",
            );
        }
        let q = fields(
            p,
            &[
                ("s", s),
                ("parts", parts),
                ("notify", a[1]),
                ("signal", a[2]),
            ],
        )?;
        let ready = then(
            transport::refresh(s, parts.get(c"launchId")?)?,
            s,
            |s, _| transport::connect(s),
        )?;
        then(ready, q, |q, _| {
            let s = q.get(c"s")?;
            let p = s.get(c"p")?;
            let mut client = JsString::from("voice:");
            client.push(&s.get(c"target")?.get(c"key")?.coerce_string()?);
            client.push_str(":");
            client.push(&uuid(p)?.coerce_string()?);
            q.set(c"clientMsgId", js(q, client.truncate_units(128))?)?;
            q.global()?
                .get(c"Promise")?
                .construct(&[function(q, "beginPrompt", 2, 2, |q, a| {
                    let s = q.get(c"s")?;
                    let p = s.get(c"p")?;
                    let target = s.get(c"target")?;
                    let private = array(q)?;
                    for (i, v) in [
                        s.get(c"cwd")?,
                        target.get(c"sessionId")?,
                        target.get(c"directoryId")?,
                        target.get(c"commanderSessionId")?,
                    ]
                    .iter()
                    .enumerate()
                    {
                        private.set_element(i as u32, *v)?;
                    }
                    let mut message_id = JsString::from("voice_msg_");
                    message_id.push(&uuid(p)?.coerce_string()?);
                    let active = fields(
                        q,
                        &[
                            ("s", s),
                            ("clientMsgId", q.get(c"clientMsgId")?),
                            ("messageId", js(q, message_id)?),
                            ("assistantText", text(q, "")?),
                            ("started", flag(q, false)?),
                            ("cancelRequested", flag(q, false)?),
                            ("finished", flag(q, false)?),
                            ("settled", flag(q, false)?),
                            (
                                "structured",
                                flag(q, target.get(c"scope")?.is_string("global")?)?,
                            ),
                            ("admission", null(q)?),
                            ("settleTimer", null(q)?),
                            ("privateValues", private),
                            ("notify", q.get(c"notify")?),
                            ("notifyChain", resolved(undef(q)?)?),
                            ("signal", q.get(c"signal")?),
                            ("resolve", a[0]),
                            ("reject", a[1]),
                        ],
                    )?;
                    let abort = function(s, "abortPrompt", 0, 0, |s, _| cancel_inner(s))?;
                    active.set(c"abortListener", abort)?;
                    let signal = active.get(c"signal")?;
                    if !signal.nullish()? {
                        call(
                            signal,
                            c"addEventListener",
                            &[
                                text(q, "abort")?,
                                abort,
                                fields(q, &[("once", flag(q, true)?)])?,
                            ],
                        )?;
                    }
                    s.set(c"active", active)?;
                    let sent = s.catch(|| {
                        transport::send(
                            s,
                            fields(
                                s,
                                &[
                                    ("type", text(s, "user_message")?),
                                    ("text", q.get(c"parts")?.get(c"text")?),
                                    ("clientMsgId", active.get(c"clientMsgId")?),
                                ],
                            )?,
                        )
                    })?;
                    if sent.is_none() {
                        unknown(s, active, "send_failed")?;
                    }
                    if signal.optional(c"aborted")?.truthy()? {
                        cancel_inner(s)?;
                    }
                    undef(q)
                })?])
        })
    })
}
fn notify<'a>(active: L<'a>, update: L<'a>) -> Result<L<'a>> {
    let q = fields(active, &[("active", active), ("update", update)])?;
    let chain = then(active.get(c"notifyChain")?, q, |q, _| {
        q.get(c"active")?
            .get(c"notify")?
            .call(q.get(c"active")?, &[q.get(c"update")?])
    })?;
    let chain = recover(chain, active, |a, e| {
        log(
            a.get(c"s")?,
            "voice_acp_notify_failed",
            fields(a, &[("error", e[0].get(c"message")?)])?,
        )
    })?;
    active.set(c"notifyChain", chain)?;
    Ok(chain)
}
fn log<'a>(s: L<'a>, event: &str, data: L<'a>) -> Result<L<'a>> {
    let fields = fields(s, &[("sessionId", s.get(c"id")?)])?;
    fields.spread_from(data)?;
    s.get(c"p")?
        .get(c"log")?
        .call_plain(&[text(s, event)?, fields])
}
fn speak<'a>(active: L<'a>, value: L<'a>) -> Result<()> {
    let value = str_or_empty(value)?;
    if value.truthy()? {
        notify(
            active,
            fields(
                active,
                &[
                    ("sessionUpdate", text(active, "agent_message_chunk")?),
                    ("messageId", active.get(c"messageId")?),
                    (
                        "content",
                        fields(active, &[("type", text(active, "text")?), ("text", value)])?,
                    ),
                ],
            )?,
        )?;
    }
    Ok(())
}
pub(super) fn stop_result(p: L<'_>, cancelled: bool) -> Result<L<'_>> {
    fields(
        p,
        &[(
            "stopReason",
            text(p, if cancelled { "cancelled" } else { "end_turn" })?,
        )],
    )
}
pub(super) fn finish<'a>(s: L<'a>, active: L<'a>, result: L<'a>) -> Result<()> {
    if !s.get(c"active")?.equals(active)? || active.get(c"finished")?.truthy()? {
        return Ok(());
    }
    active.set(c"finished", flag(s, true)?)?;
    clear_deadline(active)?;
    s.set(c"active", null(s)?)?;
    let signal = active.get(c"signal")?;
    if !signal.nullish()? {
        call(
            signal,
            c"removeEventListener",
            &[text(s, "abort")?, active.get(c"abortListener")?],
        )?;
    }
    let q = fields(s, &[("active", active), ("result", result)])?;
    // Completion waits for every notification, including caught failures.
    finish_with(active.get(c"notifyChain")?, q, |q, _| {
        q.get(c"active")?
            .get(c"resolve")?
            .call_plain(&[q.get(c"result")?])
    })?;
    Ok(())
}
fn clear_deadline(active: L<'_>) -> Result<()> {
    let timer = active.get(c"settleTimer")?;
    if timer.truthy()? {
        call(
            active.get(c"s")?.get(c"p")?.get(c"timers")?,
            c"clearTimeout",
            &[timer],
        )?;
        active.set(c"settleTimer", null(active)?)?;
    }
    Ok(())
}
fn done(active: L<'_>) -> Result<bool> {
    Ok(active.get(c"settled")?.truthy()? || active.get(c"finished")?.truthy()?)
}
fn settle<'a>(s: L<'a>, active: L<'a>, outcome: L<'a>) -> Result<()> {
    if done(active)? {
        return Ok(());
    }
    active.set(c"settled", flag(s, true)?)?;
    clear_deadline(active)?;
    let cancelled = active.get(c"cancelRequested")?.truthy()?;
    if !cancelled {
        speak(
            active,
            speech(
                outcome,
                active.get(c"admission")?,
                if active.get(c"structured")?.truthy()? {
                    text(s, "")?
                } else {
                    active.get(c"assistantText")?
                },
                active.get(c"privateValues")?,
            )?,
        )?;
    }
    finish(s, active, stop_result(s, cancelled)?)
}
pub(super) fn unknown<'a>(s: L<'a>, active: L<'a>, reason: &str) -> Result<()> {
    if done(active)? {
        return Ok(());
    }
    log(
        s,
        "voice_acp_unknown",
        fields(s, &[("reason", text(s, reason)?)])?,
    )?;
    active.set(
        c"admission",
        fields(s, &[("outcome", text(s, "unknown")?)])?,
    )?;
    settle(s, active, text(s, "unknown")?)
}
fn arm(active: L<'_>) -> Result<()> {
    if done(active)? || active.get(c"settleTimer")?.truthy()? {
        return Ok(());
    }
    let p = active.get(c"s")?.get(c"p")?;
    let timer = call(
        p.get(c"timers")?,
        c"setTimeout",
        &[
            function(active, "admissionDeadline", 0, 0, |a, _| {
                a.set(c"settleTimer", null(a)?)?;
                if !done(a)? {
                    let s = a.get(c"s")?;
                    log(
                        s,
                        "voice_acp_overall_timeout",
                        fields(a, &[("structured", a.get(c"structured")?)])?,
                    )?;
                    unknown(s, a, "overall_timeout")?;
                }
                undef(a)
            })?,
            p.get(c"admissionTimeout")?,
        ],
    )?;
    unref(timer)?;
    active.set(c"settleTimer", timer)
}
fn admission<'a>(s: L<'a>, active: L<'a>, message: L<'a>) -> Result<()> {
    if !active.get(c"structured")?.truthy()?
        || done(active)?
        || !message.get(c"version")?.equals(num(s, 1.)?)?
        || !clean_value(message.get(c"requestId")?)?.equals(active.get(c"clientMsgId")?)?
        || active.get(c"admission")?.truthy()?
    {
        return Ok(());
    }
    let value = message.get(c"outcome")?;
    let mut outcome = text(s, "unknown")?;
    for v in [
        "no_dispatch",
        "admitted",
        "rejected",
        "failed",
        "cancelled",
        "unknown",
    ] {
        if value.is_string(v)? {
            outcome = value;
            break;
        }
    }
    let err = message.get(c"error")?;
    let mut err = if err.truthy()? && object(err)? {
        err
    } else {
        null(s)?
    };
    let operation = if outcome.is_string("admitted")? {
        clean_value(message.get(c"operationId")?)?
    } else {
        text(s, "")?
    };
    if outcome.is_string("admitted")? && !operation.truthy()? {
        outcome = text(s, "failed")?;
        err = fields(
            s,
            &[
                ("code", text(s, "operation_id_missing")?),
                ("retryable", flag(s, true)?),
                (
                    "publicMessage",
                    text(s, "任务提交结果不完整，请稍后重试。")?,
                ),
            ],
        )?;
    }
    let speech = message.get(c"speechText")?;
    active.set(
        c"admission",
        fields(
            s,
            &[
                ("outcome", outcome),
                (
                    "operationId",
                    if outcome.is_string("admitted")? {
                        operation
                    } else {
                        text(s, "")?
                    },
                ),
                ("duplicate", flag(s, message.get(c"duplicate")?.is_true()?)?),
                ("queueStatus", clean_value(message.get(c"queueStatus")?)?),
                (
                    "speechText",
                    if speech.string()?.is_some() {
                        speech
                    } else {
                        text(s, "")?
                    },
                ),
                ("error", err),
            ],
        )?,
    )?;
    settle(s, active, outcome)
}
fn cancel_frame<'a>(s: L<'a>, active: L<'a>) -> Result<L<'a>> {
    transport::send(
        s,
        fields(
            s,
            &[
                ("type", text(s, "cancel")?),
                ("operationId", active.get(c"clientMsgId")?),
            ],
        )?,
    )
}
pub(super) fn message<'a>(s: L<'a>, data: L<'a>) -> Result<L<'a>> {
    let parsed = s.catch(|| json_call(s, c"parse", call(data, c"toString", &[])?))?;
    let Some(message) = parsed else {
        return undef(s);
    };
    let active = s.get(c"active")?;
    if !active.truthy()? {
        return undef(s);
    }
    // Null JSON is transport noise, just like invalid JSON. It must not create
    // an unhandled rejected message callback while a real turn is pending.
    let kind = message.optional(c"type")?;
    if kind.is_string("chat_msg_meta")?
        && message.get(c"role")?.is_string("user")?
        && message
            .get(c"clientMsgId")?
            .equals(active.get(c"clientMsgId")?)?
    {
        active.set(c"started", flag(s, true)?)?;
        arm(active)?;
        if active.get(c"cancelRequested")?.truthy()? && transport::is_open(s)? {
            cancel_frame(s, active)?;
        }
        return undef(s);
    }
    if kind.is_string("voice_admission")? {
        admission(s, active, message)?;
        return undef(s);
    }
    if !active.get(c"started")?.truthy()? || active.get(c"structured")?.truthy()? {
        return undef(s);
    }
    let content = message.optional(c"message")?.optional(c"content")?;
    if kind.is_string("assistant")? && content.is_array()? {
        let snapshot = message.get(c"message")?.get(c"textSnapshot")?;
        let snapshot = flag(s, snapshot.is_true()?)?;
        content.for_each(|block| {
            let kind = block.optional(c"type")?;
            if kind.is_string("text")? {
                active.set(
                    c"assistantText",
                    delta(
                        s,
                        active.get(c"assistantText")?,
                        block.get(c"text")?,
                        snapshot,
                    )?
                    .get(c"snapshot")?,
                )?;
            } else if kind.is_string("tool_use")? {
                let id = clean_value(block.get(c"id")?)?;
                let id = if id.truthy()? {
                    id
                } else {
                    let mut v = JsString::from("tool_");
                    v.push(&uuid(s.get(c"p")?)?.coerce_string()?);
                    js(s, v)?
                };
                let name = clean_value(block.get(c"name")?)?;
                notify(
                    active,
                    fields(
                        s,
                        &[
                            ("sessionUpdate", text(s, "tool_call")?),
                            ("toolCallId", id),
                            ("title", or(name, text(s, "MultiCC tool")?)?),
                            ("name", or(name, null(s)?)?),
                            (
                                "kind",
                                text(
                                    s,
                                    kernel::tool_kind(
                                        &str_or_empty(block.get(c"name")?)?.coerce_string()?,
                                    ),
                                )?,
                            ),
                            ("status", text(s, "in_progress")?),
                        ],
                    )?,
                )?;
            }
            Ok(())
        })?;
        return undef(s);
    }
    if kind.is_string("user")? && content.is_array()? {
        content.for_each(|block| {
            if block.optional(c"type")?.is_string("tool_result")? {
                let id = clean_value(block.get(c"tool_use_id")?)?;
                if id.truthy()? {
                    notify(
                        active,
                        fields(
                            s,
                            &[
                                ("sessionUpdate", text(s, "tool_call_update")?),
                                ("toolCallId", id),
                                (
                                    "status",
                                    text(
                                        s,
                                        if block.get(c"is_error")?.truthy()? {
                                            "failed"
                                        } else {
                                            "completed"
                                        },
                                    )?,
                                ),
                            ],
                        )?,
                    )?;
                }
            }
            Ok(())
        })?;
        return undef(s);
    }
    if kind.is_string("error")? {
        unknown(s, active, "commander_error")?;
        return undef(s);
    }
    if !kind.is_string("result")? {
        return undef(s);
    }
    let usage = message.get(c"usage")?;
    let result = stop_result(s, active.get(c"cancelRequested")?.truthy()?)?;
    if usage.truthy()? && object(usage)? {
        let out = fields(s, &[])?;
        for (snake, camel) in [
            (c"total_tokens", c"totalTokens"),
            (c"input_tokens", c"inputTokens"),
            (c"output_tokens", c"outputTokens"),
        ] {
            let n = or(usage.get(snake)?, usage.get(camel)?)?.explicit_number()?;
            out.set(camel, num(s, if n == 0. || n.is_nan() { 0. } else { n })?)?;
        }
        if out.get(c"totalTokens")?.truthy()? {
            result.set(c"usage", out)?;
        }
    }
    let spoken = sanitize(
        active.get(c"assistantText")?,
        fields(s, &[("privateValues", active.get(c"privateValues")?)])?,
    )?;
    speak(active, or(spoken, text(s, kernel::HANDLED)?)?)?;
    finish(s, active, result)?;
    undef(s)
}
fn cancel_inner(s: L<'_>) -> Result<L<'_>> {
    async_result(s, || {
        let active = s.get(c"active")?;
        if !active.truthy()? || active.get(c"finished")?.truthy()? {
            return fields(s, &[("ok", flag(s, true)?), ("idle", flag(s, true)?)]);
        }
        active.set(c"cancelRequested", flag(s, true)?)?;
        if active.get(c"started")?.truthy()? {
            if transport::is_open(s)? {
                s.catch(|| cancel_frame(s, active))?;
            }
            finish(s, active, stop_result(s, true)?)?;
            return fields(s, &[("ok", flag(s, true)?), ("active", flag(s, true)?)]);
        }
        let q = fields(s, &[("s", s), ("active", active)])?;
        let task = async_result(s, || {
            transport::cancel_queued(
                s.get(c"p")?,
                s.get(c"target")?.get(c"sessionId")?,
                active.get(c"clientMsgId")?,
            )
        })?;
        let task = recover(task, q, |q, a| {
            let s = q.get(c"s")?;
            log(
                s,
                "voice_acp_cancel_failed",
                fields(s, &[("error", a[0].get(c"message")?)])?,
            )?;
            fields(
                s,
                &[
                    ("ok", flag(s, false)?),
                    ("code", or(a[0].get(c"code")?, text(s, "cancel_failed")?)?),
                ],
            )
        })?;
        finish_with(task, q, |q, _| {
            let s = q.get(c"s")?;
            finish(s, q.get(c"active")?, stop_result(s, true)?)?;
            undef(q)
        })
    })
}
pub(super) fn cancel<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let s = find(p, a[0])?;
        if s.truthy()? {
            cancel_inner(s)
        } else {
            fields(p, &[("ok", flag(p, true)?), ("idle", flag(p, true)?)])
        }
    })
}
fn close_inner(s: L<'_>) -> Result<L<'_>> {
    async_result(s, || {
        if s.get(c"closed")?.truthy()? {
            return undef(s);
        }
        s.set(c"closed", flag(s, true)?)?;
        let task = if s.get(c"active")?.truthy()? {
            cancel_inner(s)?
        } else {
            resolved(undef(s)?)?
        };
        finish_with(task, s, |s, _| {
            let a = s.get(c"active")?;
            if a.truthy()? {
                finish(s, a, stop_result(s, true)?)?;
            }
            transport::close_socket(s)?;
            undef(s)
        })
    })
}
pub(super) fn close<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let id = clean_value(default_object(a[0])?.get(c"sessionId")?)?;
        let s = call(sessions(p)?, c"get", &[id])?;
        let q = fields(p, &[("p", p), ("id", id)])?;
        let closed = if s.truthy()? {
            close_inner(s)?
        } else {
            undef(p)?
        };
        then(closed, q, |q, _| {
            call(sessions(q.get(c"p")?)?, c"delete", &[q.get(c"id")?])?;
            fields(q, &[])
        })
    })
}
pub(super) fn stop<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let all = array(p)?;
        let values = call(sessions(p)?, c"values", &[])?;
        let mut i = 0;
        values.for_each(|s| {
            all.set_element(i, close_inner(s)?)?;
            i += 1;
            Ok(())
        })?;
        then(
            call(p.global()?.get(c"Promise")?, c"all", &[all])?,
            p,
            |p, _| {
                call(sessions(p)?, c"clear", &[])?;
                undef(p)
            },
        )
    })
}
