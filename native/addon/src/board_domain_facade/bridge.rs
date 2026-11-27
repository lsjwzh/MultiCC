use super::*;
use crate::task_board_view::task_board_session_fact;

fn apply_collection<'a>(p: L<'a>, board: L<'a>, key: &CStr, next: L<'a>) -> Result<()> {
    if !next.truthy()? {
        return Ok(());
    }
    let mut live = board.get(key)?;
    if !live.truthy()? {
        live = fields(p, &[])?;
        board.assign(key, live)?;
    }
    object_method(p, c"keys", &[live])?.for_each(|id| {
        if !object_method(p, c"hasOwn", &[next, id])?.truthy()? {
            let removed = call(p.global()?.get(c"Reflect")?, c"deleteProperty", &[live, id])?;
            if !removed.truthy()? {
                return Err(live.type_error("Cannot delete board entry"));
            }
        }
        Ok(())
    })?;
    object_method(p, c"entries", &[next])?.for_each(|entry| {
        let (id, value) = entry.iterator_pair()?;
        let current = live.get_key(id)?;
        if current.truthy()? {
            call(p, c"replace", &[current, value])?;
        } else {
            live.set_key(id, value)?;
        }
        Ok(())
    })
}

pub(super) fn board_rule<'a>(p: L<'a>, action: L<'a>, args: L<'a>) -> Result<L<'a>> {
    let command = domain_command(p, "board", action, args)?;
    let out = call(p, c"taskDomain", &[command])?;
    let board = args.get(c"board")?;
    if board.truthy()? {
        let next = out.get(c"board")?;
        if next.truthy()? {
            for key in [c"tasks", c"modules", c"taskGroups"] {
                apply_collection(p, board, key, next.get(key)?)?;
            }
            let deleted = next.get(c"deletedTaskIds")?;
            if deleted.truthy()? {
                board.assign(c"deletedTaskIds", deleted)?;
            }
        }
    }
    let task = args.get(c"task")?;
    if task.truthy()? {
        let next = out.get(c"task")?;
        if next.truthy()? {
            call(p, c"replace", &[task, next])?;
        }
    }
    out.get(c"result")
}

pub(super) fn rule<'a>(p: L<'a>, name: &str, entries: &[(&str, L<'a>)]) -> Result<L<'a>> {
    board_rule(p, text(p, name)?, fields(p, entries)?)
}

fn classification<'a>(p: L<'a>, name: L<'a>, args: L<'a>) -> Result<L<'a>> {
    let ids = array(p, &[])?;
    for i in 0..32 {
        ids.set_element(i, call(p, c"uuid", &[])?)?;
    }
    let order = group_order(p, args.get(c"board")?.optional(c"taskGroups")?, false)?;
    let input = fields(p, &[("op", text(p, "classification")?)])?;
    input.spread_from(args)?;
    input.set(c"newIds", ids)?;
    input.set(c"idOrder", order)?;
    board_rule(p, name, input)
}

fn collect_facts<'a>(
    p: L<'a>,
    task: L<'a>,
    facts: L<'a>,
    run_state: L<'a>,
    options: L<'a>,
) -> Result<()> {
    let mut refs = task.get(c"refs")?;
    if !refs.truthy()? {
        refs = array(p, &[])?;
    }
    let selected = call(refs, c"map", &[p.get(c"readSessionId")?])?;
    let set = p.global()?.get(c"Set")?.construct(&[])?;
    let insert = |id: L<'a>| -> Result<()> {
        if id.truthy()? {
            call(set, c"add", &[id])?;
        }
        Ok(())
    };
    selected.for_each(insert)?;
    insert(task.get(c"routing")?.optional(c"workerSessionId")?)?;
    insert(task.get(c"chatSessionId")?)?;
    set.for_each(|id| {
        if !object_method(p, c"hasOwn", &[facts, id])?.truthy()? {
            let fact = task_board_session_fact(env(p), arg(options)?, arg(run_state)?, arg(id)?)?;
            facts.set_key(id, raw(p, fact))?;
        }
        Ok(())
    })
}

fn dto<'a>(p: L<'a>, board: L<'a>, run_state: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let facts = fields(p, &[])?;
    let dates = array(p, &[])?;
    object_method(p, c"values", &[board.get(c"tasks")?])?.for_each(|task| {
        // Read the property twice, just as the original [dueAt, wireDate(dueAt)]
        // expression did on a live record with an accessor.
        let due = task.get(c"dueAt")?;
        let iso = call(p, c"wireDate", &[task.get(c"dueAt")?])?;
        call(dates, c"push", &[array(p, &[due, iso])?])?;
        collect_facts(p, task, facts, run_state, options)
    })?;
    let order = group_order(p, board.get(c"taskGroups")?, false)?;
    let at = num(p, options.get(c"now")?.explicit_number()?)?;
    let cmd = fields(
        p,
        &[
            ("op", text(p, "view")?),
            ("board", board),
            ("facts", facts),
            ("dates", dates),
            ("idOrder", order),
            ("now", if at.truthy()? { at } else { now(p)? }),
            (
                "hasTurnPort",
                flag(
                    p,
                    options.get(c"sessionHasTurn")?.kind()? == sys::ValueType::napi_function,
                )?,
            ),
            (
                "hasRunPort",
                flag(p, run_state.kind()? == sys::ValueType::napi_function)?,
            ),
        ],
    )?;
    call(p, c"taskDomain", &[cmd])
}

fn view(p: L<'_>) -> Result<L<'_>> {
    p.set(
        c"readSessionId",
        function(p, "sessionId", 1, 1, |_, a| a[0].get(c"sessionId"))?,
    )?;
    let api = fields(p, &[("DISPATCH_CLAIM_GRACE_MS", num(p, 60000.)?)])?;
    for (name, key) in [
        ("taskRunSessionIds", "task"),
        ("soleRunSessionId", "task"),
        ("sessionHasTurn", "record"),
    ] {
        expose(p, api, name, 1, 1, move |p, a| {
            rule(p, name, &[(key, a[0])])
        })?;
    }
    expose(p, api, "deadDispatchClaim", 2, 3, |p, a| {
        rule(
            p,
            "deadDispatchClaim",
            &[
                ("task", a[0]),
                ("hasTurnState", a[1]),
                ("now", time_or_now(a[2])?),
            ],
        )
    })?;
    expose(p, api, "foreignRunSession", 2, 2, |p, a| {
        rule(
            p,
            "foreignRunSession",
            &[("task", a[0]), ("sessionId", a[1])],
        )
    })?;
    expose(p, api, "staleWorkerClaim", 2, 3, |p, a| {
        let at = time_or_now(a[2])?;
        let state = if a[1].nullish()? {
            undefined(p)?
        } else {
            p.catch(|| a[1].call_plain(&[rule(p, "soleRunSessionId", &[("task", a[0])])?]))?
                .unwrap_or(null(p)?)
        };
        rule(
            p,
            "staleWorkerClaim",
            &[("task", a[0]), ("state", state), ("now", at)],
        )
    })?;
    expose(p, api, "buildBoardDto", 2, 3, |p, a| {
        dto(p, a[0], a[1], default_object(a[2])?)
    })?;
    expose(p, api, "aggregateTaskRunState", 2, 2, |p, a| {
        let wrap = function(p, "sessionRef", 1, 1, |p, a| {
            fields(p, &[("sessionId", a[0])])
        })?;
        let refs = call(a[0], c"map", &[wrap])?;
        let task = fields(p, &[("id", text(p, "aggregate")?), ("refs", refs)])?;
        let board = fields(
            p,
            &[
                ("modules", fields(p, &[])?),
                ("tasks", fields(p, &[("aggregate", task)])?),
            ],
        )?;
        dto(p, board, a[1], fields(p, &[])?)?
            .get(c"tasks")?
            .element(0)?
            .get(c"runState")
    })?;
    Ok(api)
}

pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let api = fields(
        p,
        &[
            ("boardView", view(p)?),
            ("MAX_TASKS_IN_PROMPT", num(p, 50.)?),
        ],
    )?;
    expose(p, api, "boardRule", 1, 2, |p, a| {
        board_rule(p, a[0], default_object(a[1])?)
    })?;
    expose(p, api, "classificationRule", 2, 2, |p, a| {
        classification(p, a[0], a[1])
    })?;
    expose(p, api, "recentTaskIds", 1, 1, |p, a| {
        rule(
            p,
            "recentTaskIds",
            &[("board", a[0]), ("limit", num(p, 50.)?)],
        )
    })?;
    Ok(api)
}
