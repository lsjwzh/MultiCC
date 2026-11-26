//! 任务壳返回的回执与普通清除请求使用不同的确认时点。宿主仅等待异步调用。
use super::*;

pub(super) fn effect<'a>(
    p: L<'a>,
    ws: L<'a>,
    session: L<'a>,
    msg: L<'a>,
    shell: L<'a>,
    clear: bool,
) -> Result<L<'a>> {
    let env = Env::from_raw(p.env());
    let state = fields(
        p,
        &[
            ("ports", p),
            ("ws", ws),
            ("session", session),
            ("msg", msg),
            ("shell", shell),
        ],
    )?;
    let invoke = method(&env, state, "", 0, 0, move |s, _| {
        let p = s.get(c"ports")?;
        let ctx = p.get(c"taskContextHost")?;
        let session = s.get(c"session")?;
        let msg = s.get(c"msg")?;
        let shell = s.get(c"shell")?;
        if clear {
            let parsed = s
                .global()?
                .get(c"parseInt")?
                .call_plain(&[msg.get(c"keep")?, num(s, 10.0)?])?;
            let keep = call(
                s.global()?.get(c"Math")?,
                c"max",
                &[num(s, 0.0)?, fallback(parsed, V::Number(0.0))?],
            )?;
            call(
                ctx,
                c"clearTaskShellHistory",
                &[
                    shell,
                    session,
                    keep,
                    fields(s, &[("limit", p.get(c"historyPage")?)])?,
                ],
            )
        } else {
            call(ctx, c"sendTaskShellInput", &[session, msg, shell])
        }
    })?;
    let finish = method(&env, state, "", 1, 1, move |s, a| {
        let p = s.get(c"ports")?;
        if clear {
            let frame = fields(
                p,
                &[
                    ("type", text(p, "chat_history_reset")?),
                    ("shellId", s.get(c"shell")?),
                    ("displayOnly", flag(p, true)?),
                ],
            )?;
            frame.spread_from(a[0])?;
            plain(p, c"chatBroadcast", &[s.get(c"session")?, frame])?;
        } else {
            let frame = fields(p, &[("type", text(p, "task_shell_routed")?)])?;
            frame.spread_from(a[0])?;
            plain(p, c"sendWs", &[s.get(c"ws")?, frame])?;
        }
        p.from_value(&V::Undefined)
    })?;
    let fail = if clear {
        null(state)?
    } else {
        method(&env, state, "", 1, 1, |s, a| {
            let p = s.get(c"ports")?;
            let error = a[0];
            let frame = fields(
                p,
                &[
                    ("type", text(p, "error")?),
                    (
                        "code",
                        fallback(read(error, c"code")?, "task_shell_failed".into())?,
                    ),
                    ("error", error.get(c"message")?),
                    ("clientMsgId", s.get(c"msg")?.get(c"clientMsgId")?),
                    ("receiptId", error.get(c"receiptId")?),
                    (
                        "notDelivered",
                        flag(
                            p,
                            error.get(c"notDelivered")?.is_true()?
                                || !error.get(c"receiptId")?.truthy()?
                                    && error.get(c"status")?.number()? < 500.0,
                        )?,
                    ),
                ],
            )?;
            plain(p, c"sendWs", &[s.get(c"ws")?, frame])?;
            p.from_value(&V::Undefined)
        })?
    };
    plain(p, c"awaitSocketEffect", &[invoke, finish, fail]).map(|v| L::from_raw(p.env(), v.raw()))
}

#[napi]
pub fn chat_replay_unattended(
    env: Env,
    ports: Unknown<'_>,
    ws: Unknown<'_>,
    session: Unknown<'_>,
) -> Result<()> {
    let p = L::new(&env, ports);
    let ws = L::new(&env, ws);
    let session = L::new(&env, session);
    p.catch(|| {
        plain(
            p,
            c"sendWs",
            &[
                ws,
                fields(
                    p,
                    &[
                        ("type", text(p, "unattended_state")?),
                        (
                            "unattended",
                            fallback(plain(p, c"getUnattendedState", &[session])?, V::Null)?,
                        ),
                    ],
                )?,
            ],
        )
    })?;
    Ok(())
}
