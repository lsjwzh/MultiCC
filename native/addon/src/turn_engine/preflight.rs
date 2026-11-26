//! 先校验任务、工作区与出口策略，再检查重复投递和待生效配置。
use crate::{js_live::spread, route_response::*};
use multicc_core::turn_progress::probe;
use std::ffi::CStr;

fn blocked(code: L<'_>) -> Result<L<'_>> {
    fields(code, &[("blocked", flag(code, true)?), ("code", code)])
}

fn feedback<'a>(
    p: L<'a>,
    name: &str,
    context: L<'a>,
    session: L<'a>,
    code: L<'a>,
    detail: L<'a>,
) -> Result<()> {
    let logger = p.get(c"logger")?;
    let warn = logger.get(c"warn")?;
    if !warn.nullish()? {
        warn.call(logger, &[text(p, name)?, context])?;
    }
    p.catch(|| {
        p.get(c"chatBroadcast")?.call_plain(&[
            session,
            fields(
                p,
                &[
                    ("type", text(p, "error")?),
                    ("code", code),
                    ("error", detail),
                ],
            )?,
        ])
    })?;
    Ok(())
}
fn optional_port<'a>(p: L<'a>, key: &CStr) -> Result<L<'a>> {
    let get = p.get(key)?;
    if get.nullish()? {
        Ok(get)
    } else {
        get.call_plain(&[])
    }
}

pub(super) fn start<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (session, message, mut opts) = (a[0], a[1], a[2]);
    if opts.optional(c"deliveryClass")?.is_string("notice")?
        || opts.optional(c"deliveryClass")?.is_string("result")?
    {
        opts = spread(opts)?;
        for key in ["taskId", "taskShellReceiptId"] {
            opts.define_key(text(p, key)?, p.from_value(&V::Undefined)?)?;
        }
    }
    let task_host = p.get(c"taskContextHost")?;
    let guard = task_host.optional(c"guardAdmission")?;
    if !guard.nullish()? {
        let verdict = guard.call(task_host, &[session, message, opts])?;
        if verdict.optional(c"ok")?.is_false()? {
            return blocked(fallback(verdict.get(c"code")?, "task_shell_guard".into())?);
        }
    }
    let record = call(p.get(c"persistedSessions")?, c"get", &[session])?;
    if !record.truthy()? {
        let label = format!(
            "[multicc/chat] runChatTurn: no persisted record for {}",
            session.coerce_string()?.to_string_lossy()
        );
        call(p.global()?.get(c"console")?, c"warn", &[text(p, &label)?])?;
        return blocked(text(p, "no_persisted_record")?);
    }
    if record.get(c"taskBoundTaskId")?.truthy()?
        && optional_port(p, c"getSessionHibernation")?.truthy()?
    {
        if let Err(e) = optional_port(p, c"getSessionHibernation")
            .and_then(|host| call(host, c"assertAwake", &[session]))
        {
            let error = p.exception_value()?.ok_or(e)?;
            let code = text(p, "workspace_hibernated")?;
            feedback(
                p,
                "chat_run_hibernated_workspace_blocked",
                fields(p, &[("sessionId", session), ("code", error.get(c"code")?)])?,
                session,
                code,
                text(p, "会话工作区尚未恢复，消息未执行；系统会保留并重试投递。")?,
            )?;
            return blocked(code);
        }
    }
    if record.get(c"provider")?.truthy()? {
        let bound = call(
            p.get(c"providers")?,
            c"getProvider",
            &[p.from_value(&V::Undefined)?, record.get(c"provider")?],
        )?;
        if bound.truthy()? {
            let check = p.get(c"checkEgressIpAllowed")?.call_plain(&[bound])?;
            if !check.get(c"allowed")?.truthy()? {
                let code = check.get(c"code")?;
                feedback(
                    p,
                    "chat_run_egress_ip_blocked",
                    fields(
                        p,
                        &[
                            ("sessionId", session),
                            ("code", code),
                            ("providerId", record.get(c"provider")?),
                        ],
                    )?,
                    session,
                    code,
                    check.get(c"detail")?,
                )?;
                return blocked(code);
            }
        }
    }
    let client = opts.get(c"clientMsgId")?;
    fields(
        p,
        &[
            ("opts", opts),
            ("persisted", record),
            (
                "delivery",
                if client.truthy()? {
                    client
                } else {
                    opts.get(c"deliveryId")?
                },
            ),
        ],
    )
}

pub(super) fn configuration<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (session, opts, message, delivery, replay) = (a[0], a[1], a[2], a[3], a[4]);
    if replay.truthy()? {
        if !replay.is_true()? {
            return p.from_value(&V::Undefined);
        }
        let handoff = p
            .get(c"runnerDeliveryHandoff")?
            .call_plain(&[session, delivery])?;
        let value =
            unsafe { crate::js_bridge::read_value(p.env(), handoff.raw(), 0, &mut Vec::new()) }?;
        if !probe::should_reexecute(&V::Bool(true), &V::Bool(true), Some(&value)) {
            return p.from_value(&V::Undefined);
        }
    }
    let deps = p.get(c"deps")?;
    let apply = deps.get(c"applyPendingConfiguration")?;
    if apply.nullish()? {
        p.from_value(&V::Undefined)
    } else {
        apply.call(deps, &[session, opts, message])
    }
}

pub(super) fn guard_failure<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (session, opts, gate) = (a[0], a[1], a[2]);
    call(
        p.get(c"logger")?,
        c"warn",
        &[
            text(p, "chat_turn_rejected_guard")?,
            fields(
                p,
                &[
                    ("sessionId", session),
                    ("code", fallback(gate.get(c"code")?, V::Null)?),
                    (
                        "deliveryClass",
                        fallback(opts.get(c"deliveryClass")?, V::Null)?,
                    ),
                ],
            )?,
        ],
    )?;
    if opts.get(c"deliveryId")?.truthy()? {
        let code = gate.get(c"code")?;
        let label = code.string()?;
        let setting = match label.as_ref().map(|s| s.to_string_lossy()).as_deref() {
            Some("turn_configuration_pending") => Some((c"backpressure", true)),
            Some(
                "task_identity_mismatch"
                | "task_shell_route_required"
                | "task_deleted"
                | "task_archived"
                | "task_board_read_only",
            ) => Some((c"retryable", false)),
            _ => None,
        };
        if let Some((key, val)) = setting {
            let error = p.global()?.get(c"Error")?.construct(&[code])?;
            error.assign(c"code", code)?;
            error.assign(key, flag(p, val)?)?;
            return Err(error.throw_error());
        }
    }
    flag(p, false)
}
