//! 每次已认领回合独立持有准备阶段状态，直到交给运行器或完成回滚。
use crate::route_response::*;

fn log<'a>(p: L<'a>, level: &std::ffi::CStr, event: &str, items: &[(&str, L<'a>)]) -> Result<()> {
    let logger = p.get(c"logger")?;
    let f = logger.get(level)?;
    if level != c"warn" || !f.nullish()? {
        f.call(logger, &[text(p, event)?, fields(p, items)?])?;
    }
    Ok(())
}

pub(super) fn start<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("session", a[0]),
            ("turnId", a[1]),
            ("clientMsgId", a[2]),
            ("deliveryId", a[3]),
            ("open", flag(p, true)?),
            ("failure", text(p, "preparation-failed")?),
            ("activated", flag(p, false)?),
            ("messageDurable", flag(p, false)?),
            ("runnerHandedOff", flag(p, false)?),
            ("settled", flag(p, false)?),
            ("attempt", null(p)?),
        ],
    )
}

pub(super) fn settle<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (s, cs) = (a[0], a[1]);
    if s.get(c"settled")?.truthy()? || !s.get(c"activated")?.truthy()? {
        return p.from_value(&V::Undefined);
    }
    s.set(c"settled", flag(p, true)?)?;
    if cs.truthy()? {
        cs.assign(c"_activeTurn", null(p)?)?;
    }
    let get = p.get(c"getSessionWorkHost")?;
    let host = if get.kind()? == sys::ValueType::napi_function {
        get.call_plain(&[])?
    } else {
        null(p)?
    };
    let session = s.get(c"session")?;
    if !host.truthy()? || host.get(c"cancelActiveTurn")?.kind()? != sys::ValueType::napi_function {
        let cleared = p.get(c"setTaskState")?.call_plain(&[
            session,
            fields(p, &[("activeTurnId", null(p)?)])?,
            fields(p, &[("save", flag(p, true)?)])?,
        ]);
        if let Err(error) = cleared {
            let error = p.exception_value()?.ok_or(error)?;
            log(
                p,
                c"warn",
                "chat_preparation_identity_clear_failed",
                &[
                    ("sessionId", session),
                    ("error", error.optional(c"message")?),
                ],
            )?;
        }
        return p.from_value(&V::Undefined);
    }
    let reason = s.get(c"failure")?;
    let options = fields(
        p,
        &[
            ("reason", reason),
            ("killReason", reason),
            ("source", text(p, "preparation_failed")?),
        ],
    )?;
    call(host, c"cancelActiveTurn", &[session, options])
}

pub(super) fn handed_off<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (s, kind) = (a[0], a[1]);
    s.set(c"runnerHandedOff", flag(p, true)?)?;
    let session = s.get(c"session")?;
    let id = s.get(c"turnId")?;
    let result = call(
        p.get(c"chatTurnPreparationRuntime")?,
        c"settle",
        &[
            session,
            id,
            fields(p, &[("status", text(p, "delegated")?), ("reason", kind)])?,
        ],
    )?;
    s.set(c"open", flag(p, false)?)?;
    if !result.get(c"ok")?.truthy()? {
        log(
            p,
            c"error",
            "chat_turn_preparation_release_failed_after_handoff",
            &[
                ("sessionId", session),
                ("turnId", id),
                ("runner", kind),
                ("code", result.get(c"code")?),
            ],
        )?;
    }
    flag(p, true)
}

pub(super) fn failed<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (s, cs, error) = (a[0], a[1], a[2]);
    if s.get(c"failure")?.is_string("preparation-failed")? {
        s.set(c"failure", text(p, "preparation-exception")?)?;
    }
    let session = s.get(c"session")?;
    let message = if error.truthy()? {
        error.get(c"message")?
    } else {
        error
    };
    if s.get(c"runnerHandedOff")?.truthy()? {
        log(
            p,
            c"error",
            "chat_turn_host_error_after_runner_handoff",
            &[
                ("sessionId", session),
                ("turnId", s.get(c"turnId")?),
                ("error", message),
            ],
        )?;
        s.set(c"open", flag(p, false)?)?;
        return flag(p, true);
    }
    let attempt = s.get(c"attempt")?;
    if attempt.truthy()? {
        call(
            p.get(c"attemptRuntime")?,
            c"finishAttempt",
            &[
                attempt,
                fields(
                    p,
                    &[
                        ("outcome", text(p, "failed")?),
                        ("errorCategory", text(p, "preparation")?),
                        ("reasonCode", s.get(c"failure")?),
                    ],
                )?,
            ],
        )?;
    }
    let reason = if message.truthy()? { message } else { error };
    let mut label = multicc_core::js::JsString::from("[multicc/chat] [");
    label.push(&session.coerce_string()?);
    label.push_str("] turn preparation failed before runner handoff: ");
    label.push(&reason.coerce_string()?);
    call(
        p.global()?.get(c"console")?,
        c"error",
        &[p.from_value(&V::String(label))?],
    )?;
    let public_error = if s.get(c"messageDurable")?.truthy()? {
        "消息已保存，但本轮准备失败，尚未启动新的 CLI 请求。"
    } else {
        "本轮准备失败，尚未启动新的 CLI 请求。"
    };
    p.catch(|| {
        p.get(c"chatBroadcast")?.call_plain(&[
            session,
            fields(
                p,
                &[
                    ("type", text(p, "error")?),
                    ("error", text(p, public_error)?),
                ],
            )?,
        ])
    })?;
    if s.get(c"activated")?.truthy()? {
        if cs.truthy()? {
            cs.assign(c"isStreaming", flag(p, false)?)?;
        }
        p.get(c"setSessionStatus")?.call_plain(&[
            session,
            fields(
                p,
                &[("status", text(p, "idle")?), ("currentFile", null(p)?)],
            )?,
        ])?;
    }
    flag(p, false)
}

pub(super) fn release<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let s = a[0];
    let id = s.get(c"turnId")?;
    let session = s.get(c"session")?;
    p.get(c"recordDeliveryProbe")?.call_plain(&[
        session,
        s.get(c"clientMsgId")?,
        s.get(c"deliveryId")?,
        fields(
            p,
            &[("handedOff", s.get(c"runnerHandedOff")?), ("turnId", id)],
        )?,
    ])?;
    if s.get(c"open")?.truthy()? {
        let reason = s.get(c"failure")?;
        call(p.get(c"turnProgressHeartbeat")?, c"stop", &[session, id])?;
        call(
            p.get(c"chatTurnPreparationRuntime")?,
            c"settle",
            &[
                session,
                id,
                fields(p, &[("status", text(p, "failed")?), ("reason", reason)])?,
            ],
        )?;
        let mut msg = multicc_core::js::JsString::from("preparation:");
        msg.push(&reason.coerce_string()?);
        let timing = p.get(c"turnTiming")?;
        call(
            timing,
            c"abort",
            &[session, id, p.from_value(&V::String(msg))?],
        )?;
        call(timing, c"drop", &[session, id])?;
    }
    p.from_value(&V::Undefined)
}

pub(super) fn settle_failed<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let s = a[0];
    log(
        p,
        c"warn",
        "chat_preparation_settle_failed",
        &[
            ("sessionId", s.get(c"session")?),
            ("reason", s.get(c"failure")?),
            ("error", a[1].optional(c"message")?),
        ],
    )?;
    p.from_value(&V::Undefined)
}
