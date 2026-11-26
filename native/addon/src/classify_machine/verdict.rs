//! Only an inactive owned turn may commit a terminal classification. Active and
//! unknown owners can refresh the task title and board card observationally.
use super::*;

pub(super) fn board_goal<'a>(
    p: L<'a>,
    name: L<'a>,
    goal: L<'a>,
    phase: L<'a>,
    cs: L<'a>,
    letter: L<'a>,
) -> Result<L<'a>> {
    let letter = if letter.undefined()? {
        text(p, "P")?
    } else {
        letter
    };
    call(
        p.get(c"getTaskContextHost")?.call_plain(&[])?,
        c"recordGoal",
        &[name, goal, phase, cs, letter],
    )?;
    p.from_value(&V::Undefined)
}
pub(super) fn running<'a>(p: L<'a>, name: L<'a>, msg: L<'a>) -> Result<L<'a>> {
    let persisted = call(p.get(c"persistedSessions")?, c"get", &[name])?;
    if persisted.truthy()? {
        let id = persisted.get(c"id")?;
        let id = if id.truthy()? { id } else { name };
        p.get(c"setSessionSummary")?.call_plain(&[id, msg])?;
        let notice = || {
            fields(
                p,
                &[
                    ("type", text(p, "notify")?),
                    ("state", text(p, "running")?),
                    ("message", msg),
                ],
            )
        };
        p.get(c"chatBroadcast")?.call_plain(&[name, notice()?])?;
        let dir = persisted.get(c"dirId")?;
        if dir.truthy()? {
            let event = fields(
                p,
                &[
                    ("type", text(p, "notify")?),
                    ("sessionId", id),
                    ("state", text(p, "running")?),
                    ("message", msg),
                ],
            )?;
            p.get(c"workspaceBroadcast")?.call_plain(&[dir, event])?;
        }
    }
    p.from_value(&V::Undefined)
}
fn log(p: L<'_>, message: String) -> Result<()> {
    call(p.global()?.get(c"console")?, c"log", &[text(p, &message)?])?;
    Ok(())
}
fn display(v: L<'_>) -> Result<String> {
    Ok(v.coerce_string()?.to_string_lossy())
}
pub(super) fn running_label<'a>(goal: L<'a>, phase: L<'a>) -> Result<L<'a>> {
    let a = goal;
    let mut label = JsString::from("处理中");
    if goal.truthy()? {
        label.push_str("：");
        label.push(&goal.coerce_string()?);
        if phase.truthy()? {
            label.push_str(" · ");
            label.push(&phase.coerce_string()?);
        }
    } else if phase.truthy()? {
        label.push_str("：");
        label.push(&phase.coerce_string()?);
    } else {
        label.push_str("…");
    }
    a.from_value(&V::String(label))
}
pub(super) fn apply<'a>(
    p: L<'a>,
    cs: L<'a>,
    name: L<'a>,
    id: L<'a>,
    mut result: L<'a>,
    options: L<'a>,
) -> Result<L<'a>> {
    let opts = if options.undefined()? {
        fields(p, &[])?
    } else {
        options
    };
    let cwd = opts.get(c"cwd")?;
    let source = opts.get(c"source")?;
    let live = turn::liveness(p, name)?;
    let persisted = call(p.get(c"persistedSessions")?, c"get", &[name])?;
    let state = p.get(c"getTaskState")?.call_plain(&[persisted])?;
    if state.get(c"classifyState")?.is_string("E")? && state.get(c"cancelledAt")?.truthy()? {
        call(
            p.get(c"logger")?,
            c"info",
            &[
                text(p, "classify_result_ignored_after_cancel")?,
                fields(p, &[("sessionId", name), ("source", source)])?,
            ],
        )?;
        return p.from_value(&V::Undefined);
    }
    let signals = p.get(c"getUserInputSignalHost")?.call_plain(&[])?;
    if signals.get(c"apply")?.kind()? == sys::ValueType::napi_function {
        result = call(signals, c"apply", &[name, result])?;
    }
    if !live.get(c"state")?.is_string("inactive")? {
        let task = cs.optional(c"currentTask")?;
        if task.truthy()? {
            let goal = result.get(c"goal")?;
            task.assign(
                c"goal",
                if goal.truthy()? && !result.get(c"goal")?.is_string("-")? {
                    result.get(c"goal")?
                } else {
                    text(p, "")?
                },
            )?;
            if result.get(c"phase")?.truthy()? {
                task.assign(c"phase", result.get(c"phase")?)?;
            }
        }
        let task = || cs.get(c"currentTask");
        let patch = fields(
            p,
            &[
                ("goal", fallback(task()?.optional(c"goal")?, "".into())?),
                (
                    "phase",
                    fallback(task()?.optional(c"phase")?, "planning".into())?,
                ),
            ],
        )?;
        p.get(c"setTaskState")?.call_plain(&[name, patch])?;
        let phase = p
            .get(c"phaseLabels")?
            .get_key(task()?.optional(c"phase")?)?;
        let goal = fallback(task()?.optional(c"goal")?, "".into())?;
        board_goal(
            p,
            name,
            goal,
            task()?.optional(c"phase")?,
            cs,
            text(p, "P")?,
        )?;
        running(p, name, running_label(goal, phase)?)?;
        log(
            p,
            format!(
                "[{}] Classify observational for {}: liveness={}/{} goal=\"{}\" phase={}",
                display(source)?,
                display(name)?,
                display(live.get(c"state")?)?,
                display(fallback(live.get(c"reason")?, "unknown".into())?)?,
                display(goal)?,
                display(fallback(task()?.optional(c"phase")?, "?".into())?)?
            ),
        )?;
    } else {
        let turn = opts.get(c"turnId")?;
        let turn = if turn.truthy()? {
            turn
        } else {
            fallback(cs.optional(c"_activeTurn")?.optional(c"turnId")?, V::Null)?
        };
        let ctx = fields(
            p,
            &[
                ("sessionName", name),
                ("sessionId", id),
                ("cs", cs),
                ("isTerminal", flag(p, false)?),
                ("cwd", cwd),
                ("source", source),
                ("liveness", live),
                ("turnId", turn),
                ("killReason", fallback(opts.get(c"killReason")?, V::Null)?),
                (
                    "handoffPending",
                    flag(p, opts.get(c"handoffPending")?.is_true()?)?,
                ),
            ],
        )?;
        if turn::has_task_id(opts)? {
            ctx.set(c"taskId", opts.get(c"taskId")?)?;
        }
        dispatch::dispatch(p, result, ctx)?;
        let mut msg = format!(
            "[{}] Classify RESULT for {}: state={} goal=\"{}\" phase={}",
            display(source)?,
            display(name)?,
            display(result.get(c"state")?)?,
            display(result.get(c"goal")?)?,
            display(fallback(result.get(c"phase")?, "?".into())?)?
        );
        if result.get(c"state")?.is_string("E")? {
            msg.push_str(" (API error)");
        }
        if result.get(c"evidence")?.truthy()? {
            msg.push_str(" evidence=");
            msg.push_str(&display(result.get(c"evidence")?)?);
        }
        log(p, msg)?;
    }
    p.from_value(&V::Undefined)
}
