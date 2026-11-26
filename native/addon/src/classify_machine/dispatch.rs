//! One writer for classification history, scheduler transitions and settled notices.
//! The scheduler owns its durable queue. Its receipt is observed asynchronously.
mod settle;
use super::*;
use std::ffi::CStr;

fn port<'a>(p: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    p.get(key)?.call_plain(args)
}
fn or<'a>(v: L<'a>, other: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if v.truthy()? {
        Ok(v)
    } else {
        other()
    }
}
fn nil(v: L<'_>) -> Result<L<'_>> {
    fallback(v, V::Null)
}
fn empty(v: L<'_>) -> Result<L<'_>> {
    fallback(v, "".into())
}
fn undef(v: L<'_>) -> Result<L<'_>> {
    v.from_value(&V::Undefined)
}
fn joined<'a>(p: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let mut s = JsString::new();
    for part in parts {
        s.push(&part.coerce_string()?);
    }
    p.from_value(&V::String(s))
}
fn callback<'a>(
    owner: L<'a>,
    count: usize,
    run: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let env = Env::from_raw(owner.env());
    let f = method(&env, owner, "", count, count, run)?;
    Ok(L::from_raw(owner.env(), f.raw()))
}
fn log<'a>(p: L<'a>, level: &CStr, event: &str, data: L<'a>) -> Result<()> {
    let logger = p.get(c"logger")?;
    let f = logger.get(level)?;
    if !f.nullish()? {
        f.call(logger, &[text(p, event)?, data])?;
    }
    Ok(())
}
fn persist<'a>(p: L<'a>, name: L<'a>, change: L<'a>) -> Result<()> {
    port(p, c"setTaskState", &[name, change])?;
    Ok(())
}
struct Transition<'a> {
    p: L<'a>,
    ctx: L<'a>,
    result: L<'a>,
    name: L<'a>,
    id: L<'a>,
    cs: L<'a>,
    record: L<'a>,
    state: L<'a>,
    goal: L<'a>,
    phase: L<'a>,
    turn: L<'a>,
    cancel: L<'a>,
}
impl<'a> Transition<'a> {
    fn task_id(&self) -> Result<L<'a>> {
        if turn::has_task_id(self.ctx)? {
            nil(self.ctx.get(c"taskId")?)
        } else {
            nil(self.cs.optional(c"_currentTaskId")?)
        }
    }
    fn scheduler(&self, live: L<'a>, task: L<'a>) -> Result<()> {
        let p = self.p;
        let recover = self.ctx.get(c"source")?.is_string("multicc/scan")?
            && live.get(c"state")?.is_string("inactive")?;
        let options = fields(
            p,
            &[
                ("recoverMissingBoundary", flag(p, recover)?),
                ("livenessReason", nil(live.get(c"reason")?)?),
            ],
        )?;
        let ack = call(
            port(p, c"getSessionWorkHost", &[])?,
            c"classifyTransition",
            &[self.name, task, self.result, options],
        )?;
        let owner = fields(p, &[("ports", p), ("name", self.name), ("task", task)])?;
        let ok = callback(owner, 1, |s, a| {
            if a[0].optional(c"ok")?.is_false()?
                && !a[0].get(c"code")?.is_string("stale_classification")?
            {
                let data = fields(
                    s,
                    &[
                        ("sessionId", s.get(c"name")?),
                        ("taskId", s.get(c"task")?),
                        ("code", fallback(a[0].get(c"code")?, "unknown".into())?),
                    ],
                )?;
                log(
                    s.get(c"ports")?,
                    c"warn",
                    "session_scheduler_classification_rejected",
                    data,
                )?;
            }
            undef(s)
        })?;
        let fail = callback(owner, 1, |s, a| {
            let message = or(a[0].optional(c"message")?, || string(empty(a[0])?))?;
            let data = fields(
                s,
                &[
                    ("sessionId", s.get(c"name")?),
                    ("taskId", s.get(c"task")?),
                    ("code", text(s, "transition_rejected")?),
                    ("error", message),
                ],
            )?;
            log(
                s.get(c"ports")?,
                c"warn",
                "session_scheduler_classification_rejected",
                data,
            )?;
            undef(s)
        })?;
        let promise = call(p.global()?.get(c"Promise")?, c"resolve", &[ack])?;
        call(promise, c"then", &[ok, fail])?;
        Ok(())
    }
    fn goal_state(&self) -> Result<L<'a>> {
        let p = self.p;
        if self
            .result
            .get(c"evidence")?
            .is_string("user_dismissed_question")?
        {
            return null(p);
        }
        if self.ctx.get(c"source")?.is_string("multicc/turn-rules")?
            && !self
                .result
                .get(c"evidence")?
                .is_string("gateway_turn_succeeded")?
        {
            if self.state.is_string("D")? {
                let state = port(p, c"getTaskState", &[self.record])?;
                let start = or(
                    self.cs.optional(c"currentTask")?.optional(c"startedAt")?,
                    || fallback(state.get(c"startedAt")?, 0.0.into()),
                )?
                .explicit_number()?;
                if state.get(c"goalState")?.is_string("achieved")?
                    && fallback(state.get(c"goalStateManualAt")?, 0.0.into())?.explicit_number()?
                        >= start
                {
                    return text(p, "achieved");
                }
            }
            return null(p);
        }
        resolve_goal(
            self.state,
            self.result.get(c"goalState")?,
            self.goal,
            self.phase,
        )
    }
    fn observation(&self, event: &str) -> Result<()> {
        let p = self.p;
        let data = fields(
            p,
            &[
                ("sessionId", self.name),
                (
                    "provider",
                    fallback(self.record.optional(c"cli")?, "unknown".into())?,
                ),
                (
                    "policyAction",
                    fallback(
                        self.cs
                            .optional(c"_lastApiErrorDecision")?
                            .optional(c"action")?,
                        "fail_fast".into(),
                    )?,
                ),
            ],
        )?;
        log(p, c"info", event, data)
    }
}
pub(super) fn resolve_goal<'a>(
    state: L<'a>,
    model: L<'a>,
    goal: L<'a>,
    phase: L<'a>,
) -> Result<L<'a>> {
    let input = fields(
        state,
        &[
            ("state", state),
            ("modelValue", model),
            (
                "result",
                fields(state, &[("state", state), ("goal", goal), ("phase", phase)])?,
            ),
        ],
    )?;
    let json = state.global()?.get(c"JSON")?;
    let wire = call(json, c"stringify", &[input])?.coerce_string()?;
    let answer = multicc_core::classify_vocab::request("resolveGoalState", &wire.to_string_lossy())
        .map_err(napi::Error::from_reason)?;
    call(json, c"parse", &[text(state, &answer)?])
}
pub(super) fn dispatch<'a>(p: L<'a>, result: L<'a>, ctx: L<'a>) -> Result<L<'a>> {
    let state = result.get(c"state")?;
    let goal = result.get(c"goal")?;
    let phase = result.get(c"phase")?;
    let cancel = result.get(c"cancel")?;
    let cancel = if cancel.kind()? == sys::ValueType::napi_object {
        cancel
    } else {
        null(p)?
    };
    let name = ctx.get(c"sessionName")?;
    let cs = ctx.get(c"cs")?;
    let id = ctx.get(c"sessionId")?;
    let live = or(ctx.get(c"liveness")?, || turn::liveness(p, name))?;
    let at = now(p)?;
    let record = call(p.get(c"persistedSessions")?, c"get", &[name])?;
    let history_task = if turn::has_task_id(ctx)? {
        nil(ctx.get(c"taskId")?)?
    } else {
        or(cs.optional(c"_currentTaskId")?, || {
            nil(record.optional(c"taskState")?.optional(c"taskId")?)
        })?
    };
    let task = cs.optional(c"currentTask")?;
    if task.truthy()? {
        task.assign(
            c"goal",
            if goal.truthy()? && !goal.is_string("—")? {
                goal
            } else {
                text(p, "")?
            },
        )?;
        if phase.truthy()? {
            task.assign(c"phase", phase)?;
        }
    }
    let t = Transition {
        p,
        ctx,
        result,
        name,
        id,
        cs,
        record,
        state,
        cancel,
        turn: if ctx.get(c"turnId")?.undefined()? {
            null(p)?
        } else {
            ctx.get(c"turnId")?
        },
        goal: if task.truthy()? {
            task.get(c"goal")?
        } else {
            goal
        },
        phase: if task.truthy()? {
            task.get(c"phase")?
        } else {
            phase
        },
    };
    let substate = t.goal_state()?;
    let entry = fields(
        p,
        &[
            ("at", at),
            ("goal", empty(goal)?),
            ("taskId", history_task),
            ("phase", empty(phase)?),
            ("state", state),
            ("goalState", substate),
            ("error", flag(p, state.is_string("E")?)?),
            (
                "evidence",
                fallback(result.get(c"evidence")?, V::Undefined)?,
            ),
        ],
    )?;
    if record.truthy()? {
        port(
            p,
            c"appendClassifyHistory",
            &[name, entry, num(p, at.number()? - 604800000.)?],
        )?;
    }
    if name.truthy()? {
        let patch = fields(p, &[("goal", empty(t.goal)?)])?;
        if t.phase.truthy()? {
            patch.set(c"phase", t.phase)?;
        }
        persist(p, name, patch)?;
    }
    if id.truthy()? && t.goal.truthy()? {
        port(p, c"setSessionSummary", &[id, t.goal])?;
    }
    verdict::board_goal(p, name, t.goal, t.phase, cs, state)?;
    let processing = state.is_string("P")? || state.is_string("C")?;
    if !live.get(c"state")?.is_string("inactive")? && !processing && !cancel.truthy()? {
        let msg = joined(
            p,
            &[
                text(p, "[multicc/scan] ")?,
                name,
                text(p, " classify candidate held: state=")?,
                state,
                text(p, ", liveness=")?,
                live.get(c"state")?,
                text(p, "/")?,
                fallback(live.get(c"reason")?, "unknown".into())?,
            ],
        )?;
        call(p.global()?.get(c"console")?, c"log", &[msg])?;
        return undef(p);
    }
    if processing {
        // Only an open stream refreshes labels. The runner owns the single bounded retry.
        if cs.optional(c"isStreaming")?.truthy()? {
            return verdict::running(
                p,
                name,
                verdict::running_label(t.goal, p.get(c"phaseLabels")?.get_key(phase)?)?,
            );
        }
        t.observation("api_error_classifier_interrupted_observed")?;
    }
    let task = t.task_id()?;
    t.scheduler(live, task)?;
    if state.is_string("D")? {
        t.success(substate, or(task, || Ok(history_task))?)?;
    } else {
        t.waiting(processing)?;
    }
    undef(p)
}
