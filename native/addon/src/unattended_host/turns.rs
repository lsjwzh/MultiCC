use super::*;

pub(super) fn probe<'a>(p: L<'a>, status: L<'a>) -> Result<L<'a>> {
    let queued = or(status.get(c"queued")?, arr(p)?)?;
    let map = function(p, "", 1, 1, |p, a| {
        fields(
            p,
            &[
                ("id", a[0].get(c"entryId")?),
                ("taskSource", a[0].get(c"source")?),
                ("message", a[0].get(c"text")?),
            ],
        )
    })?;
    rule(
        p,
        c"selectQueued",
        &[fields(
            p,
            &[
                ("handoffProbe", flag(p, true)?),
                ("items", call(queued, c"map", &[map])?),
            ],
        )?],
    )
}
fn fault_trace<'a>(p: L<'a>, id: L<'a>, before: L<'a>, d: L<'a>) -> Result<()> {
    let faults = str_or(d.get(c"faults")?, "1")?;
    let at = d.get(c"retryAt")?.explicit_number()?;
    let clock = if at.is_finite() && at > 0. {
        Some(js(port(p, c"formatClock", &[num(p, at)?])?)?)
    } else {
        None
    };
    let trace = match (d.get(c"action")?.is_string("fault_wait")?, clock.as_ref()) {
        (true, Some(clock)) if d.get(c"retryCategory")?.is_string("capacity")? => {
            format!("上游额度/线路暂不可用，将在 {clock} 自动重试（第 {faults} 次）")
        }
        (true, Some(clock)) => format!("故障后将在 {clock} 自动重试（第 {faults} 次）"),
        _ => format!("故障后自动继续（第 {faults} 次）"),
    };
    effects::trace(p, id, tagged(p, &trace)?)?;
    let prev = before
        .get(c"stall")?
        .optional(c"consecutiveFaults")?
        .explicit_number()?;
    if d.get(c"faults")?.explicit_number()? == 3. && !(prev >= 3.) {
        let when = clock
            .map(|c| format!("下一次尝试预计在 {c}"))
            .unwrap_or_else(|| "下一次尝试即将开始".into());
        let msg = text(
            p,
            &format!(
                "无人值守仍在自动重试：连续第 {faults} 次上游故障，{when}；你可以随时暂停并接管。"
            ),
        )?;
        let waiting = text(p, "waiting")?;
        p.catch(|| port(p, c"notify", &[id, waiting, msg, obj(p)?]))?;
        p.catch(|| {
            port(
                p,
                c"broadcast",
                &[
                    id,
                    fields(
                        p,
                        &[
                            ("type", text(p, "notify")?),
                            ("state", waiting),
                            ("message", msg),
                        ],
                    )?,
                ],
            )
        })?;
    }
    Ok(())
}
pub(super) fn end<'a>(p: L<'a>, id: L<'a>, facts: L<'a>) -> Result<L<'a>> {
    let push = facts.get(c"fallbackPush")?;
    if !active(state(p, id)?)? {
        effects::fire(p, push)?;
        return null(p);
    }
    if lifecycle::expire(p, id)? {
        return null(p);
    }
    let f = frame(p, id)?;
    f.set(c"facts", facts)?;
    let kind = def(facts.get(c"kind")?, text(p, "settle")?)?;
    then(f, port(p, c"readTurnFacts", &[id, kind])?, decide)
}
fn decide<'a>(f: L<'a>, read: L<'a>) -> Result<L<'a>> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    let facts = f.get(c"facts")?;
    let push = facts.get(c"fallbackPush")?;
    let latest = state(p, id)?;
    if !current(f)? || !active(latest)? {
        effects::fire(p, push)?;
        return null(p);
    }
    if lifecycle::expire(p, id)? {
        return null(p);
    }
    let input = fields(
        p,
        &[
            ("state", latest),
            ("now", now(p)?),
            ("retryScheduled", facts.get(c"retryScheduled")?),
            (
                "handoffPending",
                def(facts.get(c"handoffPending")?, flag(p, false)?)?,
            ),
            ("backlogPending", read.get(c"backlogPending")?),
            ("retryNotBefore", read.get(c"retryNotBefore")?),
        ],
    )?;
    for (key, default) in [
        (c"kind", "settle"),
        (c"settle", ""),
        (c"turnId", ""),
        (c"cancelSource", ""),
        (c"killReason", ""),
        (c"faultCategory", ""),
    ] {
        input.set(key, def(facts.get(key)?, text(p, default)?)?)?;
    }
    let d = match rule(p, c"decideTurnEnd", &[input]) {
        Ok(d) => d,
        Err(e) => {
            log_err(f, "turn-end decision failed", caught(p, e)?)?;
            effects::release(p, id)?;
            effects::fire(p, push)?;
            return null(p);
        }
    };
    let action = str_or(d.optional(c"action")?, "none")?;
    let mut next = d.optional(c"nextState")?;
    if action == "pause" {
        let by = if d.get(c"pausedBy")?.is_string("input")? {
            "input"
        } else {
            "cancel"
        };
        next = patch(
            or(next, latest)?,
            &[
                ("status", text(p, "stopped")?),
                ("pausedBy", text(p, by)?),
                ("evaluating", flag(p, false)?),
                ("updatedAt", now(p)?),
            ],
        )?;
    }
    if next.truthy()? {
        next = patch(next, &[("lastSettleAt", now(p)?)])?;
        if !persist(p, id, next, action == "pause")? {
            effects::fire(p, push)?;
            return null(p);
        }
    } else if matches!(
        action.as_str(),
        "fault_continue" | "fault_wait" | "needs_human"
    ) {
        effects::fire(p, push)?;
        return null(p);
    }
    match action.as_str() {
        "evaluate" => evaluation::evaluate(
            p,
            id,
            fields(
                p,
                &[
                    ("reason", text(p, "turn_end")?),
                    ("assistantText", facts.get(c"assistantText")?),
                    ("fallbackPush", push),
                    ("settledAt", now(p)?),
                ],
            )?,
        ),
        "pause" => {
            lifecycle::pause_trace(p, id, &js(next.get(c"pausedBy")?)?)?;
            Ok(next)
        }
        "fault_continue" | "fault_wait" => {
            fault_trace(p, id, latest, d)?;
            if action == "fault_continue" && callable(p.get(c"inject")?)? {
                f.set(c"faultEpoch", store(p, c"faultEpoch", c"get", &[id])?)?;
                let sent = port(
                    p,
                    c"inject",
                    &[
                        id,
                        tagged(p, &js(d.get(c"message")?)?)?,
                        fields(p, &[("unattendedRecovery", flag(p, true)?)])?,
                    ],
                )?;
                effects::admission(f, sent, true, false)?;
            }
            Ok(d)
        }
        "needs_human" => {
            effects::decision_trace(p, id, d)?;
            ignore(
                f,
                async_result(f, || effects::apply(f, d))?,
                "fault apply failed",
            )?;
            Ok(d)
        }
        _ => {
            let reason = str_or(d.optional(c"reason")?, "none")?;
            if reason == "backlog_pending" {
                timers::backlog(p, id, d, 0.)?;
            }
            if callable(push)? {
                effects::hold(p, id, push)?;
                effects::release(p, id)?;
            }
            fail(p, &reason, None)
        }
    }
}
pub(super) fn input<'a>(p: L<'a>, id: L<'a>, turn: Option<L<'a>>, handoff: bool) -> Result<L<'a>> {
    let s = state(p, id)?;
    let no = if handoff { flag(p, false)? } else { null(p)? };
    if !active(s)? {
        return Ok(no);
    }
    let facts = fields(
        p,
        &[
            ("state", s),
            ("now", now(p)?),
            (
                "kind",
                text(
                    p,
                    if handoff {
                        "handoff_accepted"
                    } else {
                        "user_input"
                    },
                )?,
            ),
        ],
    )?;
    let turn = turn.unwrap_or(undef(p)?);
    if handoff {
        facts.set(c"turnId", turn)?;
    }
    let d = rule(p, c"decideTurnEnd", &[facts])?;
    let next = d.optional(c"nextState")?;
    if !handoff {
        if next.truthy()? && !persist(p, id, next, false)? {
            return Ok(no);
        }
        return state(p, id);
    }
    if !next.truthy()? || !persist(p, id, patch(next, &[("lastSettleAt", now(p)?)])?, false)? {
        return Ok(no);
    }
    store(p, c"faultEpoch", c"set", &[id, obj(p)?])?;
    effects::withdraw(p, id, Some("fault"))?;
    if callable(p.get(c"kernel")?.get(c"selectQueued")?)? {
        let f = frame(p, id)?;
        f.set(c"turn", turn)?;
        let pending = then(f, undef(p)?, |f, _| {
            port(f.get(c"host")?, c"getSchedulerStatus", &[f.get(c"id")?])
        })?;
        let done = then(f, pending, |f, status| {
            let p = f.get(c"host")?;
            let id = f.get(c"id")?;
            if status.truthy()?
                && current(f)?
                && state(p, id)?
                    .optional(c"lastTurnEndId")?
                    .equals(f.get(c"turn")?)?
            {
                effects::withdraw_ids(p, id, probe(p, status)?.get(c"faultEntryIds")?)?;
            }
            undef(p)
        })?;
        ignore(f, done, "queued fault lookup failed")?;
    }
    flag(p, true)
}
