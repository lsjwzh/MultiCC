use super::*;
fn usable<'a>(p: L<'a>, id: L<'a>) -> Result<bool> {
    let r = port(p, c"getRecord", &[id])?;
    Ok(r.truthy()?
        && !r.get(c"type")?.is_string("aux")?
        && !r.get(c"type")?.is_string("gateway")?)
}
fn normalize<'a>(p: L<'a>, src: L<'a>, base: L<'a>, goal: L<'a>) -> Result<L<'a>> {
    let v = fields(p, &[("goal", goal)])?;
    for key in [c"criteria", c"maxDurationMinutes"] {
        let a = src.get(key)?;
        v.set(
            key,
            if a.nullish()? && base.truthy()? {
                base.get(key)?
            } else {
                a
            },
        )?;
    }
    rule(p, c"normalizeConfig", &[v])
}
fn armed<'a>(p: L<'a>, start: L<'a>, config: L<'a>, at: L<'a>) -> Result<L<'a>> {
    rule(
        p,
        c"armDeadline",
        &[fields(
            p,
            &[
                ("startedAt", start),
                ("maxDurationMinutes", config.get(c"maxDurationMinutes")?),
                ("now", at),
            ],
        )?],
    )
}
fn stall(p: L<'_>) -> Result<L<'_>> {
    let z = num(p, 0.)?;
    fields(
        p,
        &[
            ("sameInstruction", z),
            ("auxFailures", z),
            ("consecutiveFaults", z),
        ],
    )
}
fn fresh<'a>(p: L<'a>, cfg: L<'a>) -> Result<L<'a>> {
    let at = now(p)?;
    let t = armed(p, at, cfg, at)?;
    let n = null(p)?;
    let criteria = cfg.get(c"criteria")?;
    fields(
        p,
        &[
            ("status", text(p, "active")?),
            ("goal", cfg.get(c"goal")?),
            (
                "criteria",
                if criteria.is_array()? {
                    criteria
                } else {
                    arr(p)?
                },
            ),
            ("maxDurationMinutes", cfg.get(c"maxDurationMinutes")?),
            ("rounds", num(p, 0.)?),
            ("startedAt", t.get(c"startedAt")?),
            ("deadlineAt", t.get(c"deadlineAt")?),
            ("updatedAt", at),
            ("lastVerdict", n),
            ("history", arr(p)?),
            ("stall", stall(p)?),
            ("retryAt", n),
            ("retryCategory", n),
            ("evaluating", flag(p, false)?),
            ("pausedBy", n),
        ],
    )
}
fn equal_cfg<'a>(p: L<'a>, a: L<'a>, b: L<'a>) -> Result<bool> {
    let json = p.global()?.get(c"JSON")?;
    Ok(a.get(c"goal")?.equals(b.get(c"goal")?)?
        && a.get(c"maxDurationMinutes")?
            .equals(b.get(c"maxDurationMinutes")?)?
        && call(json, c"stringify", &[or(a.get(c"criteria")?, arr(p)?)?])?.equals(call(
            json,
            c"stringify",
            &[or(b.get(c"criteria")?, arr(p)?)?],
        )?)?)
}
pub(super) fn arm<'a>(p: L<'a>, id: L<'a>, spec: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    if spec.nullish()? || spec.kind()? != sys::ValueType::napi_object {
        return fail(p, "invalid_spec", None);
    }
    if !usable(p, id)? {
        return fail(p, "session_not_found", None);
    }
    let goal = spec.get(c"goal")?;
    let goal = if goal.nullish()? || goal.is_string("")? {
        def(opts.get(c"defaultGoal")?, text(p, "")?)?
    } else {
        goal
    };
    let n = normalize(p, spec, null(p)?, goal)?;
    if !n.get(c"ok")?.truthy()? {
        return fail(p, &str_or(n.get(c"error")?, "goal_required")?, None);
    }
    let cfg = n.get(c"config")?;
    let old = state(p, id)?;
    if active(old)? && equal_cfg(p, old, cfg)? {
        let out = success(old)?;
        out.set(c"unchanged", flag(p, true)?)?;
        return Ok(out);
    }
    let next = fresh(p, cfg)?;
    if !persist(p, id, next, true)? {
        return fail(p, "persist_failed", None);
    }
    success(next)
}
pub(super) fn start_resume<'a>(p: L<'a>, id: L<'a>, body: L<'a>, resume: bool) -> Result<L<'a>> {
    let next = if resume {
        let old = state(p, id)?;
        if !old.truthy()? {
            return fail(p, "no_unattended", Some(409));
        }
        if !matches!(
            js(old.get(c"status")?)?.as_str(),
            "needs_human" | "exhausted" | "stopped" | "error"
        ) {
            return fail(p, "invalid_state", Some(409));
        }
        let dur = body.get(c"maxDurationMinutes")?;
        let input = fields(
            p,
            &[
                ("goal", old.get(c"goal")?),
                ("criteria", old.get(c"criteria")?),
                (
                    "maxDurationMinutes",
                    if dur.nullish()? {
                        old.get(c"maxDurationMinutes")?
                    } else {
                        dur
                    },
                ),
            ],
        )?;
        let n = rule(p, c"normalizeConfig", &[input])?;
        if !n.get(c"ok")?.truthy()? {
            return fail(p, &str_or(n.get(c"error")?, "goal_required")?, Some(400));
        }
        let cfg = n.get(c"config")?;
        let at = now(p)?;
        let t = armed(p, at, cfg, at)?;
        let nil = null(p)?;
        patch(
            old,
            &[
                ("status", text(p, "active")?),
                ("pausedBy", nil),
                ("evaluating", flag(p, false)?),
                ("maxDurationMinutes", cfg.get(c"maxDurationMinutes")?),
                ("startedAt", t.get(c"startedAt")?),
                ("deadlineAt", t.get(c"deadlineAt")?),
                (
                    "rounds",
                    if old.get(c"status")?.is_string("exhausted")? {
                        num(p, 0.)?
                    } else {
                        old.get(c"rounds")?
                    },
                ),
                ("stall", stall(p)?),
                ("retryAt", nil),
                ("retryCategory", nil),
                ("updatedAt", at),
            ],
        )?
    } else {
        if !usable(p, id)? {
            return fail(p, "session_not_found", Some(404));
        }
        let n = normalize(p, body, null(p)?, body.get(c"goal")?)?;
        if !n.get(c"ok")?.truthy()? {
            return fail(p, &str_or(n.get(c"error")?, "goal_required")?, Some(400));
        }
        fresh(p, n.get(c"config")?)?
    };
    if !persist(p, id, next, true)? {
        return fail(p, "persist_failed", Some(500));
    }
    let f = frame(p, id)?;
    f.set(c"next", next)?;
    f.set(c"reason", text(p, if resume { "resume" } else { "start" })?)?;
    if !resume && body.get(c"evaluateNow")?.is_false()? {
        let r = success(or(state(p, id)?, next)?)?;
        r.set(c"deferred", flag(p, false)?)?;
        return Ok(r);
    }
    then(f, evaluation::deferred(p, id)?, |f, d| {
        let p = f.get(c"host")?;
        let id = f.get(c"id")?;
        if current(f)? && !d.truthy()? {
            evaluation::evaluate(p, id, fields(p, &[("reason", f.get(c"reason")?)])?)?;
        }
        let r = success(or(state(p, id)?, f.get(c"next")?)?)?;
        r.set(c"deferred", d)?;
        Ok(r)
    })
}
pub(super) fn update<'a>(p: L<'a>, id: L<'a>, body: L<'a>) -> Result<L<'a>> {
    let old = state(p, id)?;
    if !old.truthy()? {
        return fail(p, "no_unattended", Some(409));
    }
    if !active(old)? && !old.get(c"status")?.is_string("needs_human")? {
        return fail(p, "invalid_state", Some(409));
    }
    let at = now(p)?;
    let goal = body.get(c"goal")?;
    let n = normalize(
        p,
        body,
        old,
        if goal.nullish()? {
            old.get(c"goal")?
        } else {
            goal
        },
    )?;
    if !n.get(c"ok")?.truthy()? {
        return fail(p, &str_or(n.get(c"error")?, "goal_required")?, Some(400));
    }
    let cfg = n.get(c"config")?;
    let start = old.get(c"startedAt")?.explicit_number()?;
    let t = armed(p, if start > 0. { num(p, start)? } else { at }, cfg, at)?;
    let next = patch(
        old,
        &[
            ("goal", cfg.get(c"goal")?),
            ("criteria", cfg.get(c"criteria")?),
            ("maxDurationMinutes", cfg.get(c"maxDurationMinutes")?),
            ("deadlineAt", t.get(c"deadlineAt")?),
            ("updatedAt", at),
        ],
    )?;
    let changed = !equal_cfg(p, old, cfg)?;
    if changed {
        next.set(c"evaluating", flag(p, false)?)?;
    }
    if !persist(p, id, next, changed)? {
        return fail(p, "persist_failed", Some(500));
    }
    if active(old)? && t.get(c"clamped")?.is_true()? {
        p.catch(|| {
            effects::trace(
                p,
                id,
                tagged(
                    p,
                    "新的值守时长已使截止时间落在过去，截止时间顺延到 1 分钟后",
                )?,
            )
        })?;
    }
    success(next)
}
pub(super) fn pause_trace<'a>(p: L<'a>, id: L<'a>, by: &str) -> Result<()> {
    let label = match by {
        "input" => "用户输入",
        "cancel" => "已取消",
        _ => "用户接管",
    };
    p.catch(|| effects::trace(p, id, tagged(p, &format!("已暂停（{label}）"))?))?;
    Ok(())
}
pub(super) fn stop<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let old = state(p, id)?;
    if !old.truthy()? {
        return fail(p, "no_unattended", Some(409));
    }
    if old.get(c"status")?.is_string("stopped")? {
        return success(old);
    }
    let n = null(p)?;
    let next = patch(
        old,
        &[
            ("status", text(p, "stopped")?),
            ("pausedBy", text(p, "user")?),
            ("evaluating", flag(p, false)?),
            ("retryAt", n),
            ("retryCategory", n),
            ("updatedAt", now(p)?),
        ],
    )?;
    if !persist(p, id, next, true)? {
        return fail(p, "persist_failed", Some(500));
    }
    pause_trace(p, id, "user")?;
    success(next)
}
pub(super) fn clear<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let old = state(p, id)?;
    let dec = match rule(
        p,
        c"decideClear",
        &[fields(
            p,
            &[(
                "status",
                if old.truthy()? {
                    old.get(c"status")?
                } else {
                    null(p)?
                },
            )],
        )?],
    ) {
        Ok(v) => v,
        Err(e) => {
            let v = caught(p, e)?;
            log_err(frame(p, id)?, "clear decision failed", v)?;
            return fail(p, "decision_failed", Some(500));
        }
    };
    if !dec.optional(c"allowed")?.is_true()? {
        return fail(
            p,
            &str_or(dec.optional(c"code")?, "invalid_state")?,
            Some(409),
        );
    }
    let noop = !old.truthy()? || dec.get(c"noop")?.is_true()?;
    if noop {
        for k in [c"timers", c"retryTimers", c"backlogRechecks"] {
            timers::clear(p, id, k)?;
        }
    } else if !persist(p, id, null(p)?, true)? {
        return fail(p, "persist_failed", Some(500));
    }
    effects::withdraw(p, id, None)?;
    effects::release(p, id)?;
    let out = success(null(p)?)?;
    if noop {
        out.set(c"noop", flag(p, true)?)?;
    } else {
        effects::trace(p, id, tagged(p, "无人值守已结束，设置已清除")?)?;
    }
    store(p, c"generations", c"delete", &[id])?;
    Ok(out)
}
pub(super) fn expire<'a>(p: L<'a>, id: L<'a>) -> Result<bool> {
    let old = state(p, id)?;
    if !active(old)? {
        return Ok(false);
    }
    let deadline = old.get(c"deadlineAt")?.explicit_number()?;
    if !deadline.is_finite() || deadline <= 0. {
        return Ok(false);
    }
    let due = p
        .catch(|| {
            rule(
                p,
                c"deadlineExpired",
                &[fields(
                    p,
                    &[("deadlineAt", num(p, deadline)?), ("now", now(p)?)],
                )?],
            )?
            .get(c"expired")?
            .is_true()
        })?
        .unwrap_or(false);
    if !due {
        return Ok(false);
    }
    let at = now(p)?;
    let msg = tagged(p, "已达到最长值守时间")?;
    let n = null(p)?;
    let verdict = fields(
        p,
        &[
            ("verdict", text(p, "needs_human")?),
            ("reason", text(p, "已达到最长值守时间")?),
            ("nextInstruction", text(p, "")?),
            ("humanReason", msg),
            ("at", at),
        ],
    )?;
    let next = patch(
        old,
        &[
            ("status", text(p, "exhausted")?),
            ("evaluating", flag(p, false)?),
            ("pausedBy", n),
            ("retryAt", n),
            ("retryCategory", n),
            ("lastVerdict", verdict),
            ("updatedAt", at),
        ],
    )?;
    if !persist(p, id, next, true)? {
        return Ok(false);
    }
    effects::trace(p, id, msg)?;
    let f = frame(p, id)?;
    let decision = fields(
        p,
        &[
            ("action", text(p, "exhausted")?),
            ("message", msg),
            ("nextState", next),
        ],
    )?;
    ignore(
        f,
        async_result(f, || effects::apply(f, decision))?,
        "expiry apply failed",
    )?;
    effects::release(p, id)?;
    Ok(true)
}
