use super::*;

fn message_ref(j: L<'_>) -> Result<L<'_>> {
    let it = item(j)?;
    fields(
        j,
        &[
            ("sessionId", it.get(c"sessionId")?),
            ("deliveryId", it.get(c"id")?),
        ],
    )
}
fn prune<'a>(j: L<'a>, draft: L<'a>) -> Result<L<'a>> {
    let s = owner(j)?;
    let it = item(j)?;
    let saved = draft.get(c"outbox")?.get_key(it.get(c"id")?)?;
    if !saved.truthy()? || !saved.get(c"state")?.is_string("delivered")? {
        return flag(s, false);
    }
    let p = saved.get(c"payload")?;
    let has = call(
        s.global()?
            .get(c"Object")?
            .get(c"prototype")?
            .get(c"hasOwnProperty")?,
        c"call",
        &[p, text(s, "message")?],
    )?;
    if has.truthy()? {
        p.delete(c"message")?;
        p.set(c"messageRef", message_ref(j)?)?;
        saved.set(
            c"updatedAt",
            num(s, port(s, c"now", &[])?.explicit_number()?)?,
        )?;
    }
    let id = it.optional(c"payload")?.optional(c"operationId")?;
    if id.truthy()? {
        let operation = draft.get(c"operations")?.get_key(id)?;
        if operation.optional(c"kind")?.is_string("dispatch")? {
            let spec = operation.get(c"spec")?;
            if spec.truthy()? {
                spec.delete(c"message")?;
                spec.delete(c"taskText")?;
                spec.set(c"messageRef", message_ref(j)?)?;
                operation.set(
                    c"updatedAt",
                    num(s, port(s, c"now", &[])?.explicit_number()?)?,
                )?;
            }
        }
    }
    flag(s, true)
}
fn prune_acked<'a>(j: L<'a>, _: L<'a>) -> Result<L<'a>> {
    then(
        j,
        unit(owner(j)?, c"store", c"mutate", &[cb(j, prune)?])?,
        |j, _| j.get(c"acknowledged"),
    )
}
fn acknowledge(j: L<'_>) -> Result<L<'_>> {
    let s = owner(j)?;
    let it = item(j)?;
    then(
        j,
        unit(
            s,
            c"outbox",
            c"ack",
            &[it.get(c"id")?, it.get(c"leaseToken")?],
        )?,
        |j, ack| {
            let it = item(j)?;
            let s = owner(j)?;
            if !ack.get(c"ok")?.truthy()? {
                return Ok(ack);
            }
            j.set(c"acknowledged", ack)?;
            let p = it.optional(c"payload")?;
            let typ = p.optional(c"type")?;
            if typ.is_string("dispatch.request")? {
                then(
                    j,
                    unit(s, c"operations", c"markRunning", &[p.get(c"operationId")?])?,
                    prune_acked,
                )
            } else if typ.is_string("session.work")? {
                prune_acked(j, ack)
            } else {
                Ok(ack)
            }
        },
    )
}
fn recovery(j: L<'_>) -> Result<L<'_>> {
    port(
        owner(j)?,
        c"getSessionRecoveryStateAsync",
        &[item(j)?.get(c"sessionId")?],
    )
}
fn probe(j: L<'_>) -> Result<L<'_>> {
    let s = owner(j)?;
    let it = item(j)?;
    if !is_fn(s.get(c"runnerDeliveryProbe")?)? {
        return null(s);
    }
    let queried = async_result(j, || {
        port(
            s,
            c"runnerDeliveryProbe",
            &[it.get(c"sessionId")?, identity(it)?],
        )
    })?;
    rescue(j, queried, |j, _| null(j))
}
fn retry<'a>(j: L<'a>, probe: L<'a>) -> Result<L<'a>> {
    let s = owner(j)?;
    let it = item(j)?;
    let input = fields(
        s,
        &[
            ("unattendedStatus", j.get(c"status")?),
            ("unattendedStatusAtStart", j.get(c"initial")?),
            ("probe", probe),
            ("startedAt", j.get(c"startedAt")?),
        ],
    )?;
    let encoded = json(input)?.coerce_string()?.to_string_lossy();
    let decision = multicc_core::unattended::delivery_retry_decision(&encoded)
        .map_err(napi::Error::from_reason)?;
    let decision: serde_json::Value =
        serde_json::from_str(&decision).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let retryable = decision["retryable"] == true;
    let reason = if retryable {
        "runChatTurn rejected delivery"
    } else {
        log(s,&[text(s,"[orchestration] delivery ")?,it.get(c"id")?,text(s," aborted before runner handoff; dead-lettering it; unattended state controls any continuation")?])?;
        "turn preparation failed before runner handoff; unattended state controls continuation"
    };
    fail_and_release(j, reason, "delivery_deferred", retryable)
}
fn fail_and_release<'a>(j: L<'a>, reason: &str, release: &str, retryable: bool) -> Result<L<'a>> {
    let it = item(j)?;
    let s = owner(j)?;
    j.set(c"releaseReason", text(s, release)?)?;
    let failure = unit(
        s,
        c"outbox",
        c"fail",
        &[
            it.get(c"id")?,
            it.get(c"leaseToken")?,
            text(s, reason)?,
            fields(s, &[("retryable", flag(s, retryable)?)])?,
        ],
    )?;
    then(j, failure, |j, failed| {
        j.set(c"result", failed)?;
        then(
            j,
            unit(
                owner(j)?,
                c"sessionScheduler",
                c"releaseClaim",
                &[item(j)?, j.get(c"releaseReason")?],
            )?,
            saved,
        )
    })
}
fn normalized_status(value: L<'_>) -> Result<L<'_>> {
    let status = value.optional(c"unattended")?.optional(c"status")?;
    if status.nullish()? {
        null(value)
    } else {
        Ok(status)
    }
}
fn is_passive_delivery(j: L<'_>) -> Result<bool> {
    let it = item(j)?;
    let payload = it.optional(c"payload")?;
    let typ = payload.optional(c"type")?;
    if typ.is_string("dispatch.result")? && payload.optional(c"gateway")?.truthy()? {
        return Ok(true);
    }
    let desc_cls = j
        .optional(c"descriptor")?
        .optional(c"opts")?
        .optional(c"deliveryClass")?;
    if desc_cls.truthy()? {
        return desc_cls.is_string("notice");
    }
    Ok(typ.is_string("task.interrupted")?)
}
fn accepted<'a>(j: L<'a>, ok: L<'a>) -> Result<L<'a>> {
    let it = item(j)?;
    let s = owner(j)?;
    if !ok.truthy()? {
        return then(j, recovery(j)?, |j, state| {
            let status = normalized_status(state)?;
            j.set(c"status", status)?;
            if status.is_string("active")? || j.get(c"initial")?.is_string("active")? {
                then(j, probe(j)?, retry)
            } else {
                retry(j, null(j)?)
            }
        });
    }
    then(
        j,
        port(
            s,
            c"hasPersistedDelivery",
            &[it.get(c"sessionId")?, it.get(c"id")?],
        )?,
        |j, persisted| {
            if !persisted.truthy()? {
                return fail_and_release(
                    j,
                    "chat history did not persist delivery",
                    "message_not_durable",
                    true,
                );
            }
            let s = owner(j)?;
            let it = item(j)?;
            j.set(
                c"outcome",
                fields(
                    s,
                    &[("accepted", flag(s, true)?), ("durable", flag(s, true)?)],
                )?,
            )?;
            then(
                j,
                unit(s, c"sessionScheduler", c"confirmHandoff", &[it])?,
                |j, handoff| {
                    if handoff.truthy()? {
                        return Ok(handoff);
                    }
                    then(j, acknowledge(j)?, |j, ack| {
                        if ack.get(c"ok")?.truthy()? {
                            let s = owner(j)?;
                            let it = item(j)?;
                            // Passive notices (e.g. task.interrupted) and gateway-only
                            // dispatch results append a chat message without starting an
                            // AI turn. Release the scheduler claim immediately so the
                            // active slot does not stay wedged in `running` forever.
                            let settle = if is_passive_delivery(j)? {
                                unit(
                                    s,
                                    c"sessionScheduler",
                                    c"releaseClaim",
                                    &[it, text(s, "passive_notice_delivered")?],
                                )?
                            } else {
                                unit(s, c"sessionScheduler", c"started", &[it])?
                            };
                            then(j, settle, |j, _| j.get(c"acknowledged"))
                        } else {
                            Ok(ack)
                        }
                    })
                },
            )
        },
    )
}
fn attempt(j: L<'_>) -> Result<L<'_>> {
    let d = descriptor(owner(j)?, item(j)?)?;
    j.set(c"descriptor", d)?;
    then(j, recovery(j)?, |j, state| {
        let s = owner(j)?;
        j.set(c"initial", normalized_status(state)?)?;
        then(
            j,
            port(s, c"beforeDeliver", &[j.get(c"descriptor")?])?,
            |j, guard| {
                let s = owner(j)?;
                let d = j.get(c"descriptor")?;
                j.set(c"guard", guard)?;
                j.set(c"startedAt", call(s.global()?.get(c"Date")?, c"now", &[])?)?;
                let result = if is_fn(s.get(c"deliverOutbox")?)? {
                    port(s, c"deliverOutbox", &[d])?
                } else {
                    port(
                        s,
                        c"runChatTurn",
                        &[d.get(c"sessionId")?, d.get(c"text")?, d.get(c"opts")?],
                    )?
                };
                then(j, result, accepted)
            },
        )
    })
}
fn defer<'a>(j: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    let s = owner(j)?;
    let it = item(j)?;
    let deferred = unit(
        s,
        c"outbox",
        c"defer",
        &[
            it.get(c"id")?,
            it.get(c"leaseToken")?,
            reason,
            fields(s, &[("delayMs", num(s, 0.)?)])?,
        ],
    )?;
    // This branch returns the outbox Promise directly. An asynchronous
    // failure must reach the caller without a second attempt to settle it.
    j.set(c"returningDeferred", flag(j, true)?)?;
    Ok(deferred)
}
fn claim(j: L<'_>) -> Result<L<'_>> {
    let s = owner(j)?;
    let it = item(j)?;
    if port(s, c"isBusy", &[it.get(c"sessionId")?, it])?.truthy()? {
        return defer(j, text(s, "chat session is busy")?);
    }
    then(
        j,
        unit(s, c"sessionScheduler", c"claim", &[it])?,
        |j, claim| {
            let s = owner(j)?;
            let it = item(j)?;
            if !claim.get(c"ok")?.truthy()? {
                return defer(j, or(claim.get(c"code")?, text(s, "session gate closed")?)?);
            }
            j.set(c"claimed", flag(s, true)?)?;
            then(
                j,
                port(
                    s,
                    c"hasPersistedDelivery",
                    &[it.get(c"sessionId")?, it.get(c"id")?],
                )?,
                |j, persisted| {
                    if !persisted.truthy()? {
                        return attempt(j);
                    }
                    then(j, probe(j)?, |j, p| {
                        let s = owner(j)?;
                        let it = item(j)?;
                        if p.truthy()?
                            && p.get(c"known")?.is_true()?
                            && p.get(c"handedOff")?.is_false()?
                        {
                            log(
                                s,
                                &[
                                    text(s, "[orchestration] delivery ")?,
                                    it.get(c"id")?,
                                    text(
                                        s,
                                        " persisted but runner never took over; re-delivering",
                                    )?,
                                ],
                            )?;
                            return attempt(j);
                        }
                        then(j, acknowledge(j)?, |j, ack| {
                            j.set(c"result", ack)?;
                            if is_passive_delivery(j)? {
                                let s = owner(j)?;
                                let it = item(j)?;
                                return then(
                                    j,
                                    unit(
                                        s,
                                        c"sessionScheduler",
                                        c"releaseClaim",
                                        &[it, text(s, "passive_notice_delivered")?],
                                    )?,
                                    saved,
                                );
                            }
                            then(j, recovery(j)?, |j, recovered| {
                                then(
                                    j,
                                    unit(
                                        owner(j)?,
                                        c"sessionScheduler",
                                        c"settlePersistedDelivery",
                                        &[item(j)?, or(recovered, empty(j)?)?],
                                    )?,
                                    saved,
                                )
                            })
                        })
                    })
                },
            )
        },
    )
}
fn inject<'a>(j: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let s = owner(j)?;
    if !is_fn(s.get(c"tryInjectHeldTurn")?)? {
        return claim(j);
    }
    let injection = async_result(j, || {
        port(s, c"tryInjectHeldTurn", &[descriptor(s, item(j)?)?])
    })?;
    let injection = rescue(j, injection, |j, e| {
        let s = owner(j)?;
        log(
            s,
            &[
                text(s, "[orchestration] held-turn injection failed: ")?,
                e.get(c"message")?,
            ],
        )?;
        null(s)
    })?;
    then(j, injection, |j, injected| {
        if !injected.optional(c"delivered")?.is_true()? {
            return claim(j);
        }
        then(j, acknowledge(j)?, |j, ack| {
            if ack.get(c"ok")?.truthy()? {
                let s = owner(j)?;
                log(
                    s,
                    &[
                        text(s, "[orchestration] delivery ")?,
                        item(j)?.get(c"id")?,
                        text(s, " delivered into the held turn")?,
                    ],
                )?;
            }
            Ok(ack)
        })
    })
}
fn error_notice<'a>(j: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let s = owner(j)?;
    let it = item(j)?;
    let error = j.get(c"error")?;
    let settled = j.get(c"settled")?;
    if settled.optional(c"deadLetter")?.truthy()? && typed(it.get(c"payload")?)? {
        log(
            s,
            &[
                text(s, "[orchestration] delivery ")?,
                it.get(c"id")?,
                text(s, " dead-lettered: ")?,
                or(error.get(c"code")?, error.get(c"message")?)?,
            ],
        )?;
        if !s.get(c"notifyLostMessage")?.nullish()? {
            let report = fields(
                s,
                &[
                    ("sessionId", it.get(c"sessionId")?),
                    ("item", it),
                    ("error", error),
                ],
            )?;
            let notice = async_result(j, || port(s, c"notifyLostMessage", &[report]))?;
            let notice = rescue(j, notice, |j, e| {
                let s = owner(j)?;
                log(
                    s,
                    &[
                        text(s, "[orchestration] lost-message notice failed: ")?,
                        e.get(c"message")?,
                    ],
                )?;
                undef(s)
            })?;
            return then(j, notice, error_result);
        }
    }
    error_result(j, settled)
}
fn error_result<'a>(j: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let settled = j.get(c"settled")?;
    if settled.truthy()? {
        Ok(settled)
    } else {
        Err(j.get(c"error")?.throw_error())
    }
}
fn complete_failed<'a>(j: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let settled = j.get(c"settled")?;
    let p = item(j)?.optional(c"payload")?;
    if settled.optional(c"deadLetter")?.truthy()?
        && p.optional(c"type")?.is_string("dispatch.request")?
    {
        let s = owner(j)?;
        let error = j.get(c"error")?;
        let result = fields(
            s,
            &[
                ("status", text(s, "failed")?),
                (
                    "error",
                    or(error.get(c"code")?, text(s, "delivery_failed")?)?,
                ),
                ("retryable", flag(s, false)?),
            ],
        )?;
        then(
            j,
            unit(
                s,
                c"operations",
                c"completeDispatch",
                &[p.get(c"operationId")?, result],
            )?,
            error_notice,
        )
    } else {
        error_notice(j, settled)
    }
}
fn fail<'a>(j: L<'a>, error: L<'a>) -> Result<L<'a>> {
    if j.get(c"returningDeferred")?.is_true()? {
        return Err(error.throw_error());
    }
    let s = owner(j)?;
    let it = item(j)?;
    j.set(c"error", error)?;
    log(
        s,
        &[
            text(s, "[orchestration] delivery ")?,
            it.get(c"id")?,
            text(s, " failed: ")?,
            error.get(c"message")?,
        ],
    )?;
    let outcome = async_result(j, || {
        let id = it.get(c"id")?;
        let token = it.get(c"leaseToken")?;
        if error.get(c"backpressure")?.is_true()? {
            unit(
                s,
                c"outbox",
                c"defer",
                &[
                    id,
                    token,
                    or(error.get(c"code")?, error.get(c"message")?)?,
                    fields(s, &[("delayMs", num(s, 1000.)?)])?,
                ],
            )
        } else {
            unit(
                s,
                c"outbox",
                c"fail",
                &[
                    id,
                    token,
                    error,
                    fields(
                        s,
                        &[("retryable", flag(s, !error.get(c"retryable")?.is_false()?)?)],
                    )?,
                ],
            )
        }
    })?;
    let outcome = rescue(j, outcome, |j, e| {
        let s = owner(j)?;
        log(
            s,
            &[
                text(s, "[orchestration] delivery ")?,
                item(j)?.get(c"id")?,
                text(s, " outbox settle failed: ")?,
                e.get(c"message")?,
            ],
        )?;
        null(s)
    })?;
    then(j, outcome, |j, settled| {
        j.set(c"settled", settled)?;
        if j.get(c"claimed")?.truthy()? {
            let released = unit(
                owner(j)?,
                c"sessionScheduler",
                c"releaseClaim",
                &[item(j)?, text(j, "delivery_error")?],
            )?;
            then(j, rescue(j, released, ignore)?, complete_failed)
        } else {
            complete_failed(j, settled)
        }
    })
}
fn cleanup<'a>(j: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let guard = j.get(c"guard")?;
    if guard.truthy()? && is_fn(guard.get(c"complete")?)? {
        let res = call(guard, c"complete", &[j.get(c"outcome")?])?;
        return rescue(j, res, |j, e| {
            let s = owner(j)?;
            log(
                s,
                &[
                    text(s, "[orchestration] delivery guard ")?,
                    item(j)?.get(c"id")?,
                    text(s, " cleanup failed: ")?,
                    e.get(c"message")?,
                ],
            )?;
            undef(s)
        });
    }
    undef(j)
}
pub(super) fn deliver(j: L<'_>) -> Result<L<'_>> {
    async_result(j, || {
        j.set(
            c"outcome",
            fields(
                j,
                &[("accepted", flag(j, false)?), ("durable", flag(j, false)?)],
            )?,
        )?;
        let start = async_result(j, || then(j, resolve_lineage(j)?, inject))?;
        let settled = rescue(j, start, fail)?;
        call(settled, c"finally", &[cb(j, cleanup)?])
    })
}
