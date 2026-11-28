use super::*;
pub(super) fn signal<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let request = json_call(p, c"stringify", default_object(a[0])?)?;
    let out = multicc_core::session_question::request("adapterSignal", &fold_string(request)?)
        .map_err(napi::Error::from_reason)?;
    json_call(p, c"parse", text(p, &out)?)
}
fn outcome<'a>(c: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let ok = a[0].truthy()? && a[0].get(c"ok")?.is_true()?;
    fields(
        c,
        &[
            ("ok", flag(c, ok)?),
            (
                "requestId",
                if ok {
                    c.get(c"signal")?.get(c"requestId")?
                } else {
                    null(c)?
                },
            ),
            (
                "fallbackText",
                if ok {
                    text(c, "")?
                } else {
                    fallback(c.get(c"evt")?.optional(c"fallbackText")?, "".into())?
                },
            ),
        ],
    )
}
pub(super) fn record<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let i = default_object(a[0])?;
    let evt = i.get(c"evt")?;
    let args = fields(
        p,
        &[
            ("sessionId", i.get(c"sessionId")?),
            ("turnId", i.get(c"turnId")?),
        ],
    )?;
    for k in [c"question", c"reason", c"options", c"allowMultiple"] {
        args.set(k, evt.optional(k)?)?;
    }
    let sig = signal(p, &mut [args])?;
    let rec = i.get(c"recordInput")?;
    let res = if sig.truthy()? && callable(rec)? {
        rec.call_plain(&[sig])?
    } else {
        null(p)?
    };
    let c = fields(p, &[("evt", evt), ("signal", sig)])?;
    if res.truthy()? && callable(res.get(c"then")?)? {
        call(res, c"then", &[function(c, "outcome", 1, 1, outcome)?])
    } else {
        outcome(c, &mut [res])
    }
}
pub(super) fn question<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let i = a[0];
    let work = i.get(c"work")?;
    if !work.truthy()? {
        return null(p);
    }
    let sid = i.get(c"sessionId")?;
    let args = fields(
        p,
        &[
            ("evt", i.get(c"evt")?),
            ("sessionId", sid),
            ("turnId", i.get(c"turnId")?),
            (
                "recordInput",
                function(work, "recordInput", 1, 1, |work, a| {
                    call(work, c"recordInput", a)
                })?,
            ),
        ],
    )?;
    let result = i.get(c"recordAdapterUserInput")?.call_plain(&[args])?;
    if !result.truthy()? || !callable(result.get(c"then")?)? {
        return Ok(result);
    }
    let cs = call(i.get(c"chatSessions")?, c"get", &[sid])?;
    let r = cs.optional(c"_activeRunner")?;
    let c = fields(
        p,
        &[
            ("input", i),
            ("state", cs),
            ("turn", cs.optional(c"_activeTurn")?),
            ("runner", r),
        ],
    )?;
    let logged = recover(result, c, |c, a| {
        let i = c.get(c"input")?;
        let logger = i.get(c"logger")?;
        if !logger.get(c"warn")?.nullish()? {
            call(
                logger,
                c"warn",
                &[
                    text(c, "user_input_record_failed")?,
                    fields(
                        c,
                        &[
                            ("sessionId", i.get(c"sessionId")?),
                            ("code", fallback(a[0].optional(c"code")?, "unknown".into())?),
                        ],
                    )?,
                ],
            )?;
        }
        fields(
            c,
            &[
                ("ok", flag(c, false)?),
                (
                    "fallbackText",
                    fallback(i.get(c"evt")?.optional(c"fallbackText")?, "".into())?,
                ),
            ],
        )
    })?;
    let pending = then(logged, c, |c, a| {
        let i = c.get(c"input")?;
        let cs = c.get(c"state")?;
        let t = c.get(c"turn")?;
        let r = c.get(c"runner")?;
        if !a[0].get(c"ok")?.truthy()?
            && a[0].get(c"fallbackText")?.truthy()?
            && t.truthy()?
            && r.truthy()?
            && i.get(c"isCurrentTurnRunner")?
                .call_plain(&[cs, t, r])?
                .truthy()?
        {
            i.get(c"forwardFallback")?.call_plain(&[
                i.get(c"sessionId")?,
                cs,
                t,
                r,
                a[0].get(c"fallbackText")?,
            ])?;
        }
        undef(c)
    })?;
    if r.truthy()? {
        let mut arr = r.get(c"pendingUserInputRecords")?;
        if !arr.truthy()? {
            arr = array(p)?;
            r.assign(c"pendingUserInputRecords", arr)?;
        }
        call(arr, c"push", &[pending])?;
    }
    fields(p, &[("ok", flag(p, true)?)])
}
fn off(c: L<'_>) -> Result<()> {
    call(
        c.get(c"ws")?,
        c"off",
        &[text(c, "message")?, c.get(c"buffer")?],
    )?;
    Ok(())
}
fn replay_fail<'a>(c: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    off(c)?;
    let i = c.get(c"input")?;
    let ws = c.get(c"ws")?;
    i.get(c"sendWs")?.call_plain(&[
        ws,
        fields(
            c,
            &[
                ("type", text(c, "error")?),
                ("code", text(c, "session_work_owner_unavailable")?),
                ("error", text(c, "无法读取会话问题状态，请重试。")?),
            ],
        )?,
    ])?;
    call(ws, c"close", &[])?;
    null(c)
}
fn gate<'a>(c: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if c.get(c"closed")?.is_true()? {
        off(c)?;
        return null(c);
    }
    fields(
        c,
        &[
            ("turnId", a[0]),
            (
                "finish",
                function(c, "finish", 0, 0, |c, _| {
                    off(c)?;
                    let ws = c.get(c"ws")?;
                    if !c.get(c"closed")?.is_true()? {
                        c.get(c"messages")?.for_each(|args| {
                            let mut all = vec![text(c, "message")?];
                            args.for_each(|v| {
                                all.push(v);
                                Ok(())
                            })?;
                            call(ws, c"emit", &all)?;
                            Ok(())
                        })?;
                    }
                    undef(c)
                })?,
            ),
        ],
    )
}
pub(super) fn replay<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    use crate::host_methods::{env, raw, variadic_method};
    async_result(p, || {
        let i = a[0];
        let ws = i.get(c"ws")?;
        let messages = array(p)?;
        let c = fields(
            p,
            &[
                ("input", i),
                ("ws", ws),
                ("messages", messages),
                ("closed", flag(p, false)?),
            ],
        )?;
        let buffer = raw(
            p,
            variadic_method(&env(p), messages, "bufferMessage", 0, |messages, args| {
                let packet = array(messages)?;
                for (index, v) in args.iter().enumerate() {
                    packet.set_element(index as u32, *v)?;
                }
                call(messages, c"push", &[packet])
            })?
            .raw(),
        );
        c.set(c"buffer", buffer)?;
        call(ws, c"on", &[text(p, "message")?, buffer])?;
        call(
            ws,
            c"on",
            &[
                text(p, "close")?,
                function(c, "onClose", 0, 0, |c, _| {
                    c.set(c"closed", flag(c, true)?)?;
                    c.get(c"input")?.get(c"cleanup")?.call_plain(&[])?;
                    undef(c)
                })?,
            ],
        )?;
        let read = || -> Result<(L<'a>, bool)> {
            let input = i.get(c"input")?;
            let sid = i.get(c"sessionId")?;
            if callable(input.get(c"turnIdAsync")?)? {
                return Ok((call(input, c"turnIdAsync", &[sid])?, true));
            }
            if callable(input.get(c"turnId")?)? {
                return Ok((call(input, c"turnId", &[sid])?, false));
            }
            Ok((
                fallback(
                    i.get(c"persisted")?
                        .get(c"taskState")?
                        .optional(c"userInputSignalTurnId")?,
                    V::Null,
                )?,
                false,
            ))
        };
        match read() {
            Ok((v, true)) => call(
                resolved(v)?,
                c"then",
                &[
                    function(c, "replayGate", 1, 1, gate)?,
                    function(c, "replayFailed", 1, 1, replay_fail)?,
                ],
            ),
            Ok((v, false)) => gate(c, &mut [v]),
            Err(e) => {
                exception(c, e)?;
                replay_fail(c, &mut [])
            }
        }
    })
}
