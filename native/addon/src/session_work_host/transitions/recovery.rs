use super::*;

pub(super) fn run_state<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let record = dep(s, c"getRecord", &[id])?;
    if !record.truthy()? {
        return null(s);
    }
    let state = record.get(c"taskState")?;
    let queue = state.optional(c"queueState")?;
    if queue.is_string("queued")? || queue.is_string("running")? {
        return Ok(queue);
    }
    let classify = state.optional(c"classifyState")?;
    if classify.truthy()? {
        return dep(s, c"classifyDisplay", &[classify])?.get(c"cardStatus");
    }
    if queue.is_string("frozen")? {
        return crate::session_work_scheduler::freeze_state(state.get(c"queueFreezeReason")?);
    }
    text(s, "idle")
}
pub(super) fn run_active<'a>(s: L<'a>, id: L<'a>) -> Result<bool> {
    let state = dep(s, c"getRecord", &[id])?.optional(c"taskState")?;
    Ok(state.truthy()?
        && !state.get(c"queueState")?.is_string("assessing")?
        && run_state(s, id)?.is_string("running")?)
}
pub(super) fn facts<'a>(s: L<'a>, id: L<'a>, record: L<'a>, state: L<'a>) -> Result<L<'a>> {
    let record = if record.undefined()? {
        dep(s, c"getRecord", &[id])?
    } else {
        record
    };
    let state = if state.undefined()? {
        dep(s, c"getTaskState", &[record])?
    } else {
        state
    };
    let last = state.get(c"lastTurnEndedAt")?;
    let end = if last.truthy()? {
        last
    } else {
        state.get(c"endedAt")?
    };
    let ended = n(num(s, end.explicit_number()?)?)?;
    let typ = record.optional(c"type")?;
    let class = state.get(c"classifyState")?;
    let recovered = if typ.is_string("gateway")?
        && (class.is_string("P")? || class.is_string("C")?)
        && ended.truthy()?
    {
        text(s, "D")?
    } else {
        class
    };
    fields(
        s,
        &[
            ("classifyState", recovered),
            ("unattended", n(record.optional(c"unattended")?)?),
            ("runActive", flag(s, run_active(s, id)?)?),
            ("startedAt", state.get(c"startedAt")?),
            ("endedAt", ended),
            (
                "taskId",
                n(dep(s, c"getChatSession", &[id])?.optional(c"_currentTaskId")?)?,
            ),
            (
                "recoveryRecordType",
                if typ.kind()? == sys::ValueType::napi_string {
                    typ
                } else {
                    null(s)?
                },
            ),
        ],
    )
}
fn project<'a>(facts: L<'a>, pending: L<'a>, turn: L<'a>) -> Result<L<'a>> {
    facts.delete(c"recoveryRecordType")?;
    let q = if pending.truthy()? && !pending.get(c"resolved")?.is_true()? {
        let q = fields(
            facts,
            &[
                ("requestId", pending.get(c"requestId")?),
                ("taskId", n(pending.get(c"taskId")?)?),
                ("resolved", flag(facts, false)?),
            ],
        )?;
        let turn = pending.get(c"turnId")?;
        if turn.truthy()? {
            q.set(c"turnId", turn)?;
        }
        q
    } else {
        null(facts)?
    };
    facts.set(c"pendingUserInput", q)?;
    if turn.truthy()? {
        facts.set(c"turnId", turn)?;
    }
    Ok(facts)
}
pub(super) fn state<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let record = dep(s, c"getRecord", &[id])?;
    let state = dep(s, c"getTaskState", &[record])?;
    let pending = dep(s, c"pendingUserInput", &[id])?;
    let q = signal(s)?;
    let turn = if callable(q, c"turnId")? {
        call(q, c"turnId", &[id])?
    } else {
        state.get(c"userInputSignalTurnId")?
    };
    project(facts(s, id, record, state)?, pending, turn)
}
pub(super) fn state_async<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let q = signal(s)?;
    if !callable(q, c"snapshotAsync")? {
        return state(s, id);
    }
    let f = saved(s, &[("id", id)])?;
    after(f, call(q, c"snapshotAsync", &[id])?, |f, snap| {
        let s = f.get(c"host")?;
        let pending = snap.get(c"pendingQuestion")?;
        let turn = snap.get(c"category")?.optional(c"userInputSignalTurnId")?;
        project(
            facts(s, f.get(c"id")?, undef(s)?, undef(s)?)?,
            pending,
            turn,
        )
    })
}
