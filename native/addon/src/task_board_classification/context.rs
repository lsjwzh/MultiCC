//! 从当前轮和历史引用取证。只有历史读取异常才标记“不可读”；
//! 首个完整问答优先于仅有用户正文的引用，后者仍优先于读取异常。
use super::*;

pub(super) struct Input<'a> {
    pub user: L<'a>,
    pub reply: L<'a>,
    pub reference: L<'a>,
}
pub(super) enum Resolution<'a> {
    Found(Input<'a>),
    Missing,
    Unreadable,
}

fn is_user(message: L) -> Result<bool> {
    message.optional(c"role")?.is_string("user")
}
fn final_assistant(message: L) -> Result<bool> {
    Ok(message.optional(c"role")?.is_string("assistant")?
        && !message.get(c"_interim")?.truthy()?
        && !message.get(c"error")?.truthy()?)
}

fn find_index<'a>(
    messages: L<'a>,
    indices: impl Iterator<Item = u32>,
    mut predicate: impl FnMut(L<'a>) -> Result<bool>,
) -> Result<Option<u32>> {
    for i in indices {
        if predicate(messages.element(i)?)? {
            return Ok(Some(i));
        }
    }
    Ok(None)
}

fn by_id(messages: L, reference: L, key: &CStr) -> Result<Option<u32>> {
    if !reference.get(key)?.truthy()? {
        return Ok(None);
    }
    if !messages.is_array()? {
        return Err(messages.type_error("history.findIndex is not a function"));
    }
    find_index(messages, 0..messages.length()?, |m| {
        Ok(m.truthy()? && m.get(c"id")?.equals(reference.get(key)?)?)
    })
}

fn following_assistant(messages: L, user: Option<u32>) -> Result<Option<u32>> {
    let Some(user) = user else { return Ok(None) };
    let mut found = None;
    let mut i = user + 1;
    while i < messages.length()? {
        let message = messages.element(i)?;
        if is_user(message)? {
            break;
        }
        if final_assistant(message)? {
            found = Some(i);
        }
        i += 1;
    }
    Ok(found)
}

fn at(messages: L, index: Option<u32>) -> Result<L> {
    match index {
        Some(i) => messages.element(i),
        None => messages.from_value(&J::Null),
    }
}

pub(super) fn settled_messages<'a>(host: Host<'a>, turn: L<'a>) -> Result<(L<'a>, L<'a>)> {
    if !turn.is_array()? {
        return Ok((host.null()?, host.null()?));
    }
    let mut user = host.null()?;
    for i in 0..turn.length()? {
        let candidate = turn.element(i)?;
        if is_user(candidate)? {
            user = candidate;
            break;
        }
    }
    // 旧入口先按迭代器顺序展开，再从尾部找最终回复。
    let mut snapshot = Vec::new();
    turn.for_each(|m| {
        snapshot.push(m);
        Ok(())
    })?;
    for message in snapshot.into_iter().rev() {
        if final_assistant(message)? {
            return Ok((user, message));
        }
    }
    Ok((user, host.null()?))
}

fn turn_messages<'a>(host: Host<'a>, history: L<'a>, wanted: L<'a>) -> Result<(L<'a>, L<'a>)> {
    let mut user = find_index(history, (0..history.length()?).rev(), |m| {
        Ok(is_user(m)? && (!wanted.truthy()? || host.text(m)?.equals(wanted)?))
    })?;
    if user.is_none() && wanted.truthy()? {
        user = find_index(history, (0..history.length()?).rev(), is_user)?;
    }
    let assistant = following_assistant(history, user)?;
    Ok((at(history, user)?, at(history, assistant)?))
}

fn ref_messages<'a>(
    host: Host<'a>,
    task: L<'a>,
    reference: L<'a>,
    history: L<'a>,
) -> Result<(L<'a>, L<'a>)> {
    let mut user = by_id(history, reference, c"userMsgId")?;
    if user.is_none() {
        user = find_index(history, (0..history.length()?).rev(), |m| {
            Ok(is_user(m)? && m.get(c"taskId")?.equals(task.get(c"id")?)?)
        })?;
    }
    if user.is_none() {
        user = find_index(history, (0..history.length()?).rev(), |m| {
            if !is_user(m)? {
                return Ok(false);
            }
            let text = host.core(c"messageText", &[m])?;
            host.core(c"extractTaskMarker", &[text])?
                .equals(task.get(c"id")?)
        })?;
    }
    let assistant = match by_id(history, reference, c"assistantMsgId")? {
        Some(i) => Some(i),
        None => following_assistant(history, user)?,
    };
    Ok((at(history, user)?, at(history, assistant)?))
}

pub(super) fn slice(value: L, limit: usize) -> Result<L> {
    value.invoke(
        c"slice",
        &[
            value.from_value(&J::Number(0.0))?,
            value.from_value(&J::Number(limit as f64))?,
        ],
    )
}

fn seed<'a>(task: L<'a>, reference: L<'a>) -> Result<L<'a>> {
    task.get(c"moduleAssignment")?
        .optional(c"seed")?
        .or(|| reference.get(c"excerpt"))
}

fn stored_input<'a>(
    host: Host<'a>,
    task: L<'a>,
    stored: L<'a>,
    user: L<'a>,
    assistant: L<'a>,
    user_text: L<'a>,
    reply_text: L<'a>,
) -> Result<Input<'a>> {
    let reference = host.object(&[
        (c"sessionId", stored.get(c"sessionId")?),
        (
            c"dirId",
            stored
                .get(c"dirId")?
                .or(|| host.record(stored.get(c"sessionId")?)?.optional(c"dirId"))?
                .or(|| host.null())?,
        ),
        (c"dirLabel", host.null()?),
        (
            c"userMsgId",
            user.optional(c"id")?
                .or(|| stored.get(c"userMsgId"))?
                .or(|| host.null())?,
        ),
        (
            c"assistantMsgId",
            assistant
                .optional(c"id")?
                .or(|| stored.get(c"assistantMsgId"))?
                .or(|| host.null())?,
        ),
        (
            c"ts",
            assistant
                .optional(c"ts")?
                .or(|| user.optional(c"ts"))?
                .or(|| stored.get(c"ts"))?
                .or(|| host.now())?,
        ),
        (
            c"excerpt",
            slice(seed(task, stored)?.or(|| Ok(user_text))?, 140)?,
        ),
    ])?;
    Ok(Input {
        user: user_text,
        reply: reply_text,
        reference,
    })
}

pub(super) fn resolve<'a>(host: Host<'a>, task: L<'a>) -> Result<Resolution<'a>> {
    let mut partial = None;
    let mut unreadable = false;
    for i in (0..task.get(c"refs")?.length()?).rev() {
        let stored = task.get(c"refs")?.element(i)?;
        let Some(history) = host.0.catch(|| host.history(stored.get(c"sessionId")?))? else {
            unreadable = true;
            continue;
        };
        let (user, assistant) = ref_messages(host, task, stored, history)?;
        let text = host
            .text(user)?
            .or(|| seed(task, stored))?
            .or(|| host.value(""))?;
        let reply = host.text(assistant)?;
        if text.truthy()? && partial.is_none() {
            partial = Some(stored_input(
                host,
                task,
                stored,
                user,
                host.null()?,
                text,
                host.value("")?,
            )?);
        }
        if text.truthy()? && reply.truthy()? {
            return Ok(Resolution::Found(stored_input(
                host, task, stored, user, assistant, text, reply,
            )?));
        }
    }
    Ok(match partial {
        Some(input) => Resolution::Found(input),
        None if unreadable => Resolution::Unreadable,
        None => Resolution::Missing,
    })
}

fn eligible(record: L) -> Result<bool> {
    Ok(record.truthy()?
        && !record.get(c"type")?.is_string("aux")?
        && !record.get(c"type")?.is_string("gateway")?
        && !record.get(c"type")?.is_string("commander")?)
}

/// 轮末索引与目标分类共享当前轮的锚点；两个入口的任务 ID 优先级不同。
enum TurnEvent<'a> {
    End,
    Goal { goal: L<'a>, phase: L<'a> },
}

fn apply_turn<'a>(host: Host<'a>, session: L<'a>, turn: L<'a>, event: TurnEvent<'a>) -> Result<()> {
    let rec = host.record(session)?;
    if !eligible(rec)? {
        return Ok(());
    }
    let current_text = || {
        turn.optional(c"currentUserText")?
            .or(|| host.value(""))?
            .clean_text()
    };
    let (text, history) = match event {
        TurnEvent::End => {
            let text = current_text()?;
            if !text.truthy()?
                || host
                    .0
                    .get(c"isSystemInjected")?
                    .call_plain(&[text])?
                    .truthy()?
            {
                return Ok(());
            }
            (text, host.history(session)?)
        }
        TurnEvent::Goal { .. } => {
            let history = host.history(session)?;
            (
                turn.get(c"currentUserText")?
                    .or(|| host.value(""))?
                    .clean_text()?,
                history,
            )
        }
    };
    let (user, assistant) = turn_messages(host, history, text)?;
    if !user.truthy()? && !assistant.truthy()? {
        return Ok(());
    }
    let msg_id = || {
        user.optional(c"taskId")?
            .or(|| assistant.optional(c"taskId"))
    };
    let id = match event {
        TurnEvent::End => msg_id()?.or(|| turn.optional(c"_currentTaskId"))?,
        TurnEvent::Goal { .. } => turn.get(c"taskId")?.or(msg_id)?,
    }
    .or(|| host.core(c"extractTaskMarker", &[text]))?;
    if !id.truthy()? {
        return Ok(());
    }
    let task = host.0.invoke(c"resolvedTask", &[id])?;
    if !task.truthy()? {
        return Ok(());
    }
    let now = host.now()?;
    let reference = host.object(&[
        (c"sessionId", session),
        (c"dirId", rec.get(c"dirId")?.or(|| host.null())?),
        (c"dirLabel", host.null()?),
        (c"userMsgId", user.optional(c"id")?.or(|| host.null())?),
        (
            c"assistantMsgId",
            assistant.optional(c"id")?.or(|| host.null())?,
        ),
        (
            c"ts",
            assistant
                .optional(c"ts")?
                .or(|| user.optional(c"ts"))?
                .or(|| Ok(now))?,
        ),
        (
            c"excerpt",
            if user.optional(c"taskId")?.truthy()? {
                host.value("")?
            } else {
                match event {
                    TurnEvent::End => slice(text, 140)?,
                    TurnEvent::Goal { goal, .. } => {
                        slice(explicit_string(host, goal.or(|| host.value(""))?)?, 200)?
                    }
                }
            },
        ),
    ])?;
    let mut changed = host
        .core(c"addRefToTask", &[task, reference, now])?
        .truthy()?;
    if let TurnEvent::Goal { goal, .. } = event {
        let title = goal.or(|| host.value(""))?.clean_text()?;
        let pending = host.0.get(c"core")?.get(c"PENDING_TASK_TITLE")?;
        if !task.get(c"titleSource")?.is_string("manual")?
            && task.get(c"title")?.equals(pending)?
            && title.truthy()?
            && !title.equals(pending)?
        {
            task.assign(c"title", slice(title, 40)?)?;
            changed = true;
        }
        if turn.get(c"runState")?.truthy()?
            && !task.get(c"runState")?.equals(turn.get(c"runState")?)?
        {
            host.0.invoke(
                c"noteRunState",
                &[task, task.get(c"runState")?, turn.get(c"runState")?],
            )?;
            task.assign(c"runState", turn.get(c"runState")?)?;
            task.assign(c"updatedAt", now)?;
            changed = true;
        }
    }
    if changed {
        host.save()?;
        host.notify(reference.get(c"dirId")?, task)?;
    }
    if let TurnEvent::Goal { phase, .. } = event {
        host.0
            .invoke(c"logGoal", &[task.get(c"id")?, session, phase])?;
    }
    Ok(())
}

pub(super) fn explicit_string<'a>(host: Host<'a>, value: L<'a>) -> Result<L<'a>> {
    host.0.global()?.get(c"String")?.call_plain(&[value])
}

#[napi]
pub fn task_board_turn_end(
    env: Env,
    ports: Unknown<'_>,
    session: Unknown<'_>,
    turn: Unknown<'_>,
) -> Result<()> {
    apply_turn(
        Host(L::new(&env, ports)),
        L::new(&env, session),
        L::new(&env, turn),
        TurnEvent::End,
    )
}

#[napi]
pub fn task_board_classify_goal(
    env: Env,
    ports: Unknown<'_>,
    session: Unknown<'_>,
    goal: Unknown<'_>,
    phase: Unknown<'_>,
    turn: Unknown<'_>,
) -> Result<()> {
    apply_turn(
        Host(L::new(&env, ports)),
        L::new(&env, session),
        L::new(&env, turn),
        TurnEvent::Goal {
            goal: L::new(&env, goal),
            phase: L::new(&env, phase),
        },
    )
}
