//! 用户消息在历史写入前确定身份；写入成功后才可开始归类和流式通知。
mod preparation;
use crate::{js_live::spread, route_response::*};

pub(super) fn select_task<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (task, message, record, session) = (a[0], a[1], a[2], a[3]);
    if task.get(c"id")?.truthy()? {
        return Ok(task);
    }
    let matched = call(message, c"match", &[p.get(c"codePattern")?])?;
    if matched.nullish()? {
        return Ok(task);
    }
    let code_owner = p
        .get(c"taskIdForShortCode")?
        .call_plain(&[matched.element(1)?])?;
    if !code_owner.truthy()? {
        return Ok(task);
    }

    let state = p.get(c"getTaskState")?.call_plain(&[record])?;
    let matches = |entry: L<'_>| entry.optional(c"taskId")?.equals(code_owner);
    let mut known = record.get(c"taskBoundTaskId")?.equals(code_owner)? || matches(state)?;
    if !known {
        let history = state.get(c"classifyHistory")?;
        if history.is_array()? {
            for i in 0..history.get(c"length")?.number()? as u32 {
                if matches(history.element(i)?)? {
                    known = true;
                    break;
                }
            }
        }
    }
    if !known {
        p.catch(|| {
            let history = p.get(c"viewChatHistory")?.call_plain(&[session])?;
            history.for_each_while(|entry| {
                known = matches(entry)?;
                Ok(!known)
            })
        })?;
    }
    if !known {
        return Ok(task);
    }
    fields(
        p,
        &[
            ("id", code_owner),
            ("start", flag(p, false)?),
            ("source", text(p, "code-reference")?),
            ("text", text(p, "")?),
        ],
    )?
    .freeze()
}

fn bind_task<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (cs, task, opts, turn, message, fresh) = (a[0], a[1], a[2], a[3], a[4], a[5]);
    let provisional = !task.get(c"id")?.truthy()? && fresh.truthy()?;
    let context = call(
        p.get(c"taskContextHost")?,
        c"beginTurn",
        &[
            cs,
            task,
            fields(p, &[("provisional", flag(p, provisional)?)])?,
        ],
    )?;
    let id = context.get(c"taskId")?;
    let boundary = context.get(c"boundaryChanged")?;
    let detached = context.get(c"detached")?;
    let message_task = if !task.get(c"id")?.truthy()?
        && boundary.truthy()?
        && !detached.truthy()?
        && id.truthy()?
    {
        fields(
            p,
            &[
                ("id", id),
                ("start", flag(p, true)?),
                ("source", text(p, "provisional")?),
                ("text", message),
            ],
        )?
    } else {
        task
    };
    let auto = opts.get(c"taskShellReceiptId")?.truthy()?
        && opts.get(c"taskShellAutoClassify")?.is_true()?;
    let locked = task.get(c"id")?.truthy()?
        && !auto
        && (!task.get(c"start")?.is_true()?
            || task.get(c"source")?.string()?.is_some_and(|v| {
                ["task-board", "commander", "code-reference", "task-shell"]
                    .iter()
                    .any(|s| v == *s)
            }));
    cs.assign(
        c"_taskShellReceiptId",
        fallback(opts.get(c"taskShellReceiptId")?, V::Null)?,
    )?;
    let bound = spread(message_task)?;
    bound.define_key(text(p, "id")?, id)?;
    p.get(c"bindTurnTask")?.call_plain(&[turn, bound])?;
    fields(
        p,
        &[
            ("id", id),
            ("messageTask", message_task),
            ("detached", detached),
            ("boundaryChanged", boundary),
            ("identityLocked", flag(p, locked)?),
            ("autoClassify", flag(p, auto)?),
        ],
    )
}

fn nonempty_array(v: L<'_>) -> Result<L<'_>> {
    if v.is_array()? && v.get(c"length")?.truthy()? {
        Ok(v)
    } else {
        v.from_value(&V::Undefined)
    }
}

fn user_message<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (bound, content, turn_id, identity, dispatch, opts, tasks, tools) =
        (a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]);
    let msg = fields(
        p,
        &[
            ("role", text(p, "user")?),
            ("content", content),
            ("ts", call(p.global()?.get(c"Date")?, c"now", &[])?),
            ("turnId", turn_id),
            (
                "clientMsgId",
                fallback(identity.get(c"clientMsgId")?, V::Undefined)?,
            ),
            (
                "deliveryId",
                fallback(identity.get(c"deliveryId")?, V::Undefined)?,
            ),
            ("originDispatchId", fallback(dispatch, V::Undefined)?),
            (
                "answeredQuestionId",
                fallback(opts.get(c"userInputRequestId")?, V::Undefined)?,
            ),
        ],
    )?;
    let metadata = call(
        p.get(c"taskContextHost")?,
        c"messageMetadata",
        &[
            bound.get(c"messageTask")?,
            bound.get(c"id")?,
            fields(p, &[("detached", bound.get(c"detached")?)])?,
        ],
    )?;
    msg.spread_from(metadata)?;
    msg.define_key(text(p, "bgTaskIds")?, nonempty_array(tasks)?)?;
    msg.define_key(text(p, "bgToolUseIds")?, nonempty_array(tools)?)?;
    Ok(msg)
}

fn activate<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (cs, session, message, bound, turn_id, persisted) = (a[0], a[1], a[2], a[3], a[4], a[5]);
    cs.assign(c"currentAssistantText", text(p, "")?)?;
    cs.assign(c"currentUserText", message)?;
    let task = bound.get(c"messageTask")?;
    let task_text = task.get(c"text")?;
    let boundary = bound.get(c"boundaryChanged")?;
    let id = bound.get(c"id")?;
    let locked = bound.get(c"identityLocked")?;
    let options = fields(
        p,
        &[
            ("taskId", id),
            (
                "taskText",
                if task_text.truthy()? {
                    task_text
                } else {
                    message
                },
            ),
            ("taskSource", task.get(c"source")?),
            ("explicitContinuation", locked),
            ("turnId", turn_id),
        ],
    )?;
    p.get(c"ensureCurrentTask")?
        .call_plain(&[cs, session, message, boundary, options])?;
    let goal = if cs.get(c"currentTask")?.truthy()? {
        cs.get(c"currentTask")?.get(c"goal")?
    } else {
        text(p, "新任务")?
    };
    cs.assign(c"currentTaskName", goal)?;
    if boundary.truthy()?
        && !persisted.get(c"type")?.is_string("gateway")?
        && !bound.get(c"autoClassify")?.truthy()?
    {
        let options = fields(
            p,
            &[
                ("turnId", turn_id),
                ("source", text(p, "admission")?),
                ("identityLocked", locked),
                ("admittedTaskId", id),
            ],
        )?;
        p.get(c"runClassifyNow")?
            .call_plain(&[cs, session, options])?;
    }
    cs.assign(c"currentToolCalls", p.from_value(&V::Array(vec![]))?)?;
    cs.assign(c"currentCost", null(p)?)?;
    cs.assign(c"isStreaming", flag(p, true)?)?;
    p.from_value(&V::Undefined)
}

pub(super) use preparation::prepare;
pub(super) fn configure(p: L<'_>) -> Result<()> {
    p.set(
        c"codePattern",
        p.global()?.get(c"RegExp")?.construct(&[
            text(p, r"(?:^|\s)#([0-9A-Z]{4})(?=$|\s|[，。,:：;；!?！？])")?,
            text(p, "iu")?,
        ])?,
    )
}
