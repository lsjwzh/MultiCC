//! 先验证重复投递和运行中写者，再为通过准入的消息分配回合身份。
use crate::route_response::*;
use multicc_core::{
    turn_progress::probe,
    turn_request::{Admission, AdmissionFacts},
};

pub(super) fn claim<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (session, opts, gate, request, client, delivery) = (a[0], a[1], a[2], a[3], a[4], a[5]);
    let record = gate.get(c"persisted")?;
    let existing = gate.get(c"existingCs")?;
    let history_contains = |id| {
        call(
            p.get(c"getChatHistoryService")?.call_plain(&[])?,
            c"containsDelivery",
            &[session, id],
        )?
        .truthy()
    };
    let seen = (client.truthy()? && history_contains(client)?)
        || (delivery.truthy()? && history_contains(delivery)?);
    let persisted = seen && gate.get(c"deliveryPersisted")?.is_true()?;
    let prior = p
        .get(c"runnerDeliveryHandoff")?
        .call_plain(&[session, if client.truthy()? { client } else { delivery }])?;
    let retry = if seen && persisted {
        let snapshot =
            unsafe { crate::js_bridge::read_value(p.env(), prior.raw(), 0, &mut Vec::new()) }?;
        probe::should_reexecute(&V::Bool(true), &V::Bool(true), Some(&snapshot))
    } else {
        false
    };
    let logger = p.get(c"logger")?;
    if retry {
        let warn = logger.get(c"warn")?;
        if !warn.nullish()? {
            warn.call(
                logger,
                &[
                    text(p, "chat_turn_reexecute_persisted_delivery")?,
                    fields(
                        p,
                        &[
                            ("sessionId", session),
                            ("clientMsgId", fallback(client, V::Null)?),
                            ("deliveryId", fallback(delivery, V::Null)?),
                            ("priorTurnId", fallback(prior.get(c"turnId")?, V::Null)?),
                        ],
                    )?,
                ],
            )?;
        }
    }
    let cli = request.get(c"cli")?;
    let busy = p
        .get(c"isResidentSession")?
        .call_plain(&[cli, record])?
        .truthy()?
        && call(p.get(c"chatStream")?, c"status", &[session])?
            .optional(c"busy")?
            .truthy()?;
    let resident = p.get(c"isResident")?.call_plain(&[cli])?.truthy()?;
    let proxy = if resident && record.get(c"provider")?.truthy()? {
        p.catch(|| {
            let summary = call(
                p.get(c"providerRouterRuntime")?,
                c"getProviderSummary",
                &[text(p, "claude")?, record.get(c"provider")?],
            )?;
            Ok(summary.truthy()?
                && (summary.get(c"baseUrl")?.truthy()?
                    || (summary.get(c"isOfficial")?.truthy()?
                        && p.get(c"getClaudeOfficialViaProxy")?
                            .call_plain(&[])?
                            .truthy()?)))
        })?
        .unwrap_or(false)
    } else {
        false
    };
    let decision = AdmissionFacts {
        duplicate_seen: seen && !retry,
        duplicate_persisted: persisted && !retry,
        shutting_down: p.get(c"isShuttingDown")?.call_plain(&[])?.is_true()?,
        session_missing: false,
        running: (existing.truthy()? && existing.get(c"claudeProc")?.truthy()?) || busy,
        background: proxy
            && call(
                p.get(c"getBackgroundTaskRuntime")?.call_plain(&[])?,
                c"hasProcessBackgroundTasks",
                &[session],
            )?
            .is_true()?,
    }
    .decide();
    match decision {
        Admission::Duplicate(accepted) => {
            if accepted {
                p.get(c"recordDeliveryProbe")?.call_plain(&[
                    session,
                    client,
                    delivery,
                    fields(p, &[("handedOff", flag(p, true)?)])?,
                ])?;
            }
            return fields(p, &[("accepted", flag(p, accepted)?)]);
        }
        Admission::Shutdown => {
            call(
                logger,
                c"warn",
                &[
                    text(p, "chat_turn_rejected_shutdown")?,
                    fields(p, &[("sessionId", session)])?,
                ],
            )?;
        }
        Admission::Background => {
            p.get(c"chatBroadcast")?.call_plain(&[session,fields(p,&[("type",text(p,"error")?),("error",text(p,"后台任务仍在运行；为隔离本轮 Provider 路由，本消息尚未执行。请等待任务结束或先取消任务后重试。")?)])?])?;
        }
        _ => {}
    }
    if decision != Admission::Prepare {
        return fields(p, &[("accepted", flag(p, false)?)]);
    }
    let turn_id = p.get(c"issueTurnId")?.call_plain(&[])?;
    let turn = p
        .get(c"createTurnLifecycle")?
        .call_plain(&[request, fields(p, &[("turnId", turn_id)])?])?;
    let at = if opts
        .get(c"receivedAt")?
        .number_value()?
        .is_some_and(f64::is_finite)
    {
        opts.get(c"receivedAt")?
    } else {
        call(p.global()?.get(c"Date")?, c"now", &[])?
    };
    call(
        p.get(c"turnTiming")?,
        c"begin",
        &[session, turn_id, fields(p, &[("t0", at), ("cli", cli)])?],
    )?;
    let claimed = call(
        p.get(c"chatTurnPreparationRuntime")?,
        c"claim",
        &[
            session,
            turn_id,
            fields(
                p,
                &[
                    ("cli", cli),
                    ("transport", request.get(c"execution")?.get(c"transport")?),
                ],
            )?,
        ],
    )?;
    if !claimed.get(c"ok")?.truthy()? {
        call(
            logger,
            c"warn",
            &[
                text(p, "chat_turn_rejected_preparation_in_flight")?,
                fields(
                    p,
                    &[("sessionId", session), ("code", claimed.get(c"code")?)],
                )?,
            ],
        )?;
        return fields(p, &[("accepted", flag(p, false)?)]);
    }
    fields(
        p,
        &[
            ("turnId", turn_id),
            ("turn", turn),
            ("reexecutePersistedDelivery", flag(p, retry)?),
        ],
    )
}
