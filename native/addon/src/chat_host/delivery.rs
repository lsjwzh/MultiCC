use super::*;
use coordinator::{current, decision_facts, life};
fn route<'a>(s: L<'a>, i: L<'a>, handoff: bool) -> Result<L<'a>> {
    let t = i.get(c"turn")?;
    let input = fields(
        s,
        &[
            ("turnId", t.get(c"turnId")?),
            ("requestId", t.get(c"requestId")?),
            ("sessionId", t.get(c"sessionId")?),
            ("sessionType", i.get(c"sessionType")?),
            ("finalText", i.get(c"finalText")?),
            ("receipts", i.get(c"receipts")?),
        ],
    )?;
    if handoff {
        input.set(c"handoff", i.get(c"handoff")?)?;
        input.set(c"handoffResumeFailure", i.get(c"handoffResumeFailure")?)?;
    }
    let lineage = t.get(c"lineage")?;
    input.set(
        c"originDispatchId",
        if lineage.get(c"kind")?.is_string("dispatch")? {
            lineage.get(c"operationId")?
        } else {
            null(s)?
        },
    )?;
    call(s.get(c"deps")?.get(c"router")?, c"routePostTurn", &[input])
}
fn refuse<'a>(s: L<'a>, code: L<'a>, route: bool) -> Result<L<'a>> {
    let o = fields(s, &[("ok", flag(s, false)?), ("code", code)])?;
    if route {
        o.set(c"route", null(s)?)?;
    }
    o.set(c"effects", array(s)?.freeze()?)?;
    o.freeze()
}
pub(super) fn reserve<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let i = default_object(a[0])?;
    let t = i.get(c"turn")?;
    let r = i.get(c"runner")?;
    let verdict = life(s, c"evaluatePostTurn", &[t, r, decision_facts(i, i, true)?])?;
    if !verdict.get(c"ok")?.truthy()? {
        return refuse(s, verdict.get(c"code")?, false);
    }
    if t.get(c"postTurnReservation")?.truthy()? {
        return refuse(s, text(s, "post_turn_in_flight")?, false);
    }
    let next = s.get(c"nextId")?;
    let id = if callable(next)? {
        next.call_plain(&[])?.clean_text()?
    } else {
        let n = s.get(c"sequence")?.number()? + 1.;
        s.set(c"sequence", num(s, n)?)?;
        text(s, &format!("post_turn_{n}"))?
    };
    let id = if id.truthy()? {
        id
    } else {
        call(
            text(s, "post_turn_")?,
            c"concat",
            &[
                string(t.get(c"turnId")?)?,
                text(s, "_")?,
                string(r.get(c"runnerId")?)?,
            ],
        )?
    };
    t.assign(
        c"postTurnReservation",
        frozen(
            s,
            &[("reservationId", id), ("runnerId", r.get(c"runnerId")?)],
        )?,
    )?;
    let routed = route(s, i, true)?;
    frozen(
        s,
        &[
            ("ok", flag(s, true)?),
            ("code", null(s)?),
            ("reservationId", id),
            ("route", routed.get(c"route")?),
            ("effects", routed.get(c"effects")?),
            ("turnId", t.get(c"turnId")?),
            ("runnerId", r.get(c"runnerId")?),
        ],
    )
}
pub(super) fn claim<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let i = default_object(a[0])?;
    let t = i.get(c"turn")?;
    let r = i.get(c"runner")?;
    let mut verdict = life(s, c"evaluatePostTurn", &[t, r, decision_facts(i, i, true)?])?;
    if verdict.get(c"ok")?.truthy()? {
        verdict = life(s, c"claimPostTurn", &[t, r, decision_facts(i, i, true)?])?;
    }
    if !verdict.get(c"ok")?.truthy()? {
        return refuse(s, verdict.get(c"code")?, true);
    }
    let routed = route(s, i, false)?;
    let effects = array(s)?;
    for kind in ["consume-cli-handoff", "turn-complete"] {
        let id = call(
            text(s, &format!("{kind}:"))?,
            c"concat",
            &[string(t.get(c"turnId")?)?],
        )?;
        let e = fields(
            s,
            &[
                ("type", text(s, kind)?),
                ("effectId", id),
                ("bestEffort", flag(s, true)?),
                ("requiresDeliveryProof", flag(s, false)?),
                ("sessionId", t.get(c"sessionId")?),
            ],
        )?;
        if kind == "turn-complete" {
            e.set(c"turnId", t.get(c"turnId")?)?;
            e.set(c"lineage", t.get(c"lineage")?)?;
            e.set(c"resultDurable", flag(s, true)?)?;
        }
        call(effects, c"push", &[e.freeze()?])?;
    }
    routed.get(c"effects")?.for_each(|e| {
        call(effects, c"push", &[e])?;
        Ok(())
    })?;
    frozen(
        s,
        &[
            ("ok", flag(s, true)?),
            ("code", null(s)?),
            ("route", routed.get(c"route")?),
            ("effects", effects.freeze()?),
            ("lineage", verdict.get(c"lineage")?),
            ("deliveryProven", flag(s, false)?),
        ],
    )
}
fn release<'a>(t: L<'a>, plan: L<'a>) -> Result<bool> {
    let reservation = t.optional(c"postTurnReservation")?;
    if !reservation.truthy()?
        || !reservation
            .get(c"reservationId")?
            .equals(plan.get(c"reservationId")?)?
    {
        return Ok(false);
    }
    t.assign(c"postTurnReservation", null(t)?)?;
    Ok(true)
}
pub(super) fn abort<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    flag(s, a[0].truthy()? && release(a[1], a[0])?)
}
fn reject<'a>(c: L<'a>, code: L<'a>, effect: Option<L<'a>>, error: Option<L<'a>>) -> Result<L<'a>> {
    release(c.get(c"turn")?, c.get(c"plan")?)?;
    let v = fields(c, &[("ok", flag(c, false)?), ("code", code)])?;
    if let Some(e) = effect {
        v.set(c"effectId", e.get(c"effectId")?)?;
    }
    if let Some(e) = error {
        v.set(c"error", e)?;
    }
    v.set(c"receipts", c.get(c"receipts")?.freeze()?)?;
    v.freeze()
}
fn failure<'a>(c: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    reject(
        c,
        text(c, "effect_delivery_failed")?,
        Some(c.get(c"effect")?),
        Some(err_message(c, a[0], "effect delivery failed")?),
    )
}
fn accepted<'a>(c: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let e = c.get(c"effect")?;
    if e.get(c"requiresDeliveryProof")?.is_true()? {
        let ack = call(
            c.get(c"s")?.get(c"deps")?.get(c"router")?,
            c"acknowledgeDeliveredEffect",
            &[e, a[0]],
        )?;
        if !ack.get(c"ok")?.truthy()? {
            return reject(c, ack.get(c"code")?, Some(e), None);
        }
        call(c.get(c"receipts")?, c"push", &[ack.get(c"receipt")?])?;
    } else if !success(a[0])? {
        return reject(c, text(c, "effect_delivery_failed")?, Some(e), None);
    }
    deliver_next(c)
}
fn deliver_next(c: L<'_>) -> Result<L<'_>> {
    let s = c.get(c"s")?;
    let t = c.get(c"turn")?;
    let r = c.get(c"runner")?;
    let plan = c.get(c"plan")?;
    let i = c.get(c"input")?;
    let step = call(c.get(c"iterator")?, c"next", &[])?;
    if step.get(c"done")?.truthy()? {
        if !current(s, i)? {
            return reject(c, text(c, "stale_runner")?, None, None);
        }
        release(t, plan)?;
        let verdict = life(
            s,
            c"claimPostTurn",
            &[t, r, pick(i, &[c"currentTurn", c"currentRunner"])?],
        )?;
        let receipts = c.get(c"receipts")?.freeze()?;
        if !verdict.get(c"ok")?.truthy()? {
            return frozen(
                c,
                &[
                    ("ok", flag(c, false)?),
                    ("code", verdict.get(c"code")?),
                    ("receipts", receipts),
                ],
            );
        }
        return frozen(
            c,
            &[
                ("ok", flag(c, true)?),
                ("code", null(c)?),
                ("route", plan.get(c"route")?),
                ("receipts", receipts),
                ("lineage", verdict.get(c"lineage")?),
            ],
        );
    }
    let e = step.get(c"value")?;
    c.set(c"effect", e)?;
    let deliver = || {
        call(
            s.get(c"ports")?.get(c"effects")?,
            c"deliver",
            &[
                e,
                frozen(
                    s,
                    &[
                        ("reservationId", plan.get(c"reservationId")?),
                        ("turnId", t.get(c"turnId")?),
                        ("runnerId", r.get(c"runnerId")?),
                    ],
                )?,
            ],
        )
    };
    match deliver() {
        Ok(v) => call(
            resolved(v)?,
            c"then",
            &[
                function(c, "effectDelivered", 1, 1, accepted)?,
                function(c, "deliveryRejected", 1, 1, failure)?,
            ],
        ),
        Err(err) => failure(c, &mut [exception(c, err)?]),
    }
}
pub(super) fn deliver<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let plan = a[0];
        let i = default_object(a[1])?;
        let t = i.get(c"turn")?;
        let r = i.get(c"runner")?;
        let res = t.optional(c"postTurnReservation")?;
        if !plan.truthy()?
            || !plan.get(c"ok")?.is_true()?
            || !res.truthy()?
            || !res
                .get(c"reservationId")?
                .equals(plan.get(c"reservationId")?)?
            || !res.get(c"runnerId")?.equals(r.optional(c"runnerId")?)?
        {
            return frozen(
                s,
                &[
                    ("ok", flag(s, false)?),
                    ("code", text(s, "invalid_post_turn_reservation")?),
                    ("receipts", array(s)?.freeze()?),
                ],
            );
        }
        let c = fields(
            s,
            &[
                ("s", s),
                ("turn", t),
                ("runner", r),
                ("input", i),
                ("plan", plan),
                ("receipts", array(s)?),
            ],
        )?;
        if !current(s, i)? {
            return reject(c, text(s, "stale_runner")?, None, None);
        }
        let port = s.get(c"ports")?.get(c"effects")?;
        if !port.truthy()? || !callable(port.get(c"deliver")?)? {
            return reject(c, text(s, "effects_port_missing")?, None, None);
        }
        c.set(c"iterator", plan.get(c"effects")?.iterator()?.0)?;
        deliver_next(c)
    })
}
