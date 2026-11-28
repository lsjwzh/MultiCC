//! Per-mount pin, to-do and ignored-issue stores share the visible task list within a snapshot.
use super::*;
pub(super) fn ids_for_session<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let out = array(p)?;
    let bound = rec(p, id)?.optional(c"taskBoundTaskId")?;
    if bound.truthy()? {
        append(out, bound)?;
        return Ok(out);
    }
    let board = call(deps(p)?, c"getBoard", &[])?;
    values(js_or(board.get(c"tasks")?, fields(p, &[])?)?)?.for_each(|t| {
        if t.get(c"sessionId")?.equals(id)?
            || t.get(c"chatSessionId")?.equals(id)?
            || call(
                call(ports(p)?.get(c"boardCore")?, c"taskRunSessionIds", &[t])?,
                c"includes",
                &[id],
            )?
            .truthy()?
        {
            append(out, t.get(c"id")?)?;
        }
        Ok(())
    })?;
    Ok(out)
}
fn visible(p: L<'_>) -> Result<L<'_>> {
    let held = p.get(c"taskSnapshot")?;
    if held.truthy()? {
        return Ok(held);
    }
    let board = js_or(lookup(deps(p)?, c"getBoard", &[])?, fields(p, &[])?)?;
    let shells = js_or(lookup(shell(p)?, c"listTasks", &[])?, array(p)?)?;
    let ids = domain(
        p,
        &[
            ("op", text(p, "airVisible")?),
            ("board", board),
            ("shellTasks", shells),
        ],
    )?;
    let out = array(p)?;
    ids.for_each(|id| append(out, board.get(c"tasks")?.get_key(id)?))?;
    Ok(out)
}
pub(super) fn fact_ids<'a>(p: L<'a>, task: L<'a>, project: bool) -> Result<L<'a>> {
    let out = p.global()?.get(c"Set")?.construct(&[])?;
    let add = |id: L<'a>| -> Result<()> {
        if id.truthy()? {
            call(out, c"add", &[id])?;
        }
        Ok(())
    };
    if project {
        call(ports(p)?.get(c"boardCore")?, c"taskRunSessionIds", &[task])?.for_each(add)?;
    } else {
        js_or(task.get(c"refs")?, array(p)?)?.for_each(|r| add(r.get(c"sessionId")?))?;
    }
    add(task.get(c"routing")?.optional(c"workerSessionId")?)?;
    add(task.get(c"chatSessionId")?)?;
    Ok(out)
}
pub(super) fn facts_for<'a>(p: L<'a>, task: L<'a>, out: L<'a>, keys: Option<L<'a>>) -> Result<()> {
    fact_ids(p, task, keys.is_none())?.for_each(|id| {
        if keys.is_some() && call(p.global()?.get(c"Object")?, c"hasOwn", &[out, id])?.truthy()? {
            return Ok(());
        }
        let run = p
            .catch(|| lookup(deps(p)?, c"getSessionRunState", &[id]))?
            .unwrap_or(null(p)?);
        let state = rec(p, id)?.optional(c"taskState")?;
        let projection = if !state.truthy()? {
            null(p)?
        } else if let Some(keys) = keys {
            let fact = fields(p, &[])?;
            keys.for_each(|key| fact.define_key(key, state.get_key(key)?))?;
            fact
        } else {
            state
        };
        out.define_key(
            id,
            fields(
                p,
                &[("taskState", projection), ("runState", nullable(run)?)],
            )?,
        )
    })
}
fn problem<'a>(p: L<'a>, t: L<'a>) -> Result<L<'a>> {
    let now = now_ms(p)?;
    let f = fields(p, &[])?;
    facts_for(p, t, f, None)?;
    let state = domain(
        p,
        &[
            ("op", text(p, "runState")?),
            ("task", t),
            ("facts", f),
            ("now", now),
        ],
    )?;
    let mut at = 0.;
    let mut kind = null(p)?;
    if state.is_string("error")? || state.is_string("waiting")? {
        kind = state;
        let id = event_session(t)?;
        let task_state = if id.truthy()? {
            rec(p, id)?.optional(c"taskState")?
        } else {
            null(p)?
        };
        let pending = if id.truthy()? && callable(deps(p)?.get(c"pendingUserInput")?)? {
            call(deps(p)?, c"pendingUserInput", &[id])?
        } else {
            task_state.optional(c"pendingUserInput")?
        };
        for (owner, key) in [
            (task_state, c"endedAt"),
            (pending, c"createdAt"),
            (task_state, c"lastTurnEndedAt"),
        ] {
            let n = owner.optional(key)?.explicit_number()?;
            if !n.is_nan() && n != 0. {
                at = n.max(0.);
                break;
            }
        }
    }
    fields(p, &[("kind", kind), ("occurredAt", num(p, at)?)])
}
fn list<'a>(p: L<'a>, name: &str) -> Result<L<'a>> {
    let (slot, file_key, create) = match name {
        "pins" => (c"pins", c"pinsFile", c"createAirPinRuntime"),
        "todos" => (c"todos", c"todosFile", c"createAirTodoRuntime"),
        _ => (
            c"ignores",
            c"todoIgnoresFile",
            c"createAirTodoIgnoreRuntime",
        ),
    };
    let existing = p.get(slot)?;
    if existing.truthy()? {
        return Ok(existing);
    }
    let d = deps(p)?;
    let mut file = d.get(file_key)?;
    if !file.truthy()? && name != "pins" {
        let adjacent = if name == "todos" {
            d.get(c"pinsFile")?
        } else {
            let todos = d.get(c"todosFile")?;
            if todos.truthy()? {
                todos
            } else {
                d.get(c"pinsFile")?
            }
        };
        if adjacent.truthy()? {
            let path = ports(p)?.get(c"path")?;
            file = call(
                path,
                c"join",
                &[
                    call(path, c"dirname", &[adjacent])?,
                    text(
                        p,
                        if name == "todos" {
                            "air-todos.json"
                        } else {
                            "air-todo-ignores.json"
                        },
                    )?,
                ],
            )?;
        }
    }
    let options = fields(
        p,
        &[
            ("file", file),
            (
                "logger",
                js_or(d.get(c"logger")?, p.global()?.get(c"console")?)?,
            ),
        ],
    )?;
    if name == "ignores" {
        options.set(
            c"listTasks",
            function(p, "listTasks", 0, 0, |p, _| visible(p))?,
        )?;
        options.set(
            c"problemOf",
            function(p, "problemOf", 1, 1, |p, a| problem(p, a[0]))?,
        )?;
        options.set(
            c"readTodos",
            function(p, "readTodos", 0, 0, |p, _| {
                call(list(p, "todos")?, c"read", &[])
            })?,
        )?;
    } else {
        options.set(
            c"listTaskIds",
            function(p, "listTaskIds", 0, 0, |p, _| {
                let out = array(p)?;
                visible(p)?.for_each(|t| append(out, t.get(c"id")?))?;
                Ok(out)
            })?,
        )?;
    }
    let value = call(ports(p)?.get(c"domain")?, create, &[options])?;
    p.set(slot, value)?;
    Ok(value)
}
pub(super) fn snapshot<'a>(p: L<'a>, tasks: L<'a>) -> Result<L<'a>> {
    let prev = p.get(c"taskSnapshot")?;
    p.set(c"taskSnapshot", tasks)?;
    let result = (|| {
        fields(
            p,
            &[
                ("taskPins", call(list(p, "pins")?, c"read", &[])?),
                ("taskTodos", call(list(p, "todos")?, c"read", &[])?),
                ("taskTodoIgnored", call(list(p, "ignores")?, c"read", &[])?),
            ],
        )
    })();
    if let Err(err) = result {
        let thrown = p.exception_value()?;
        p.set(c"taskSnapshot", prev)?;
        return Err(if let Some(e) = thrown {
            e.throw_error()
        } else {
            err
        });
    }
    p.set(c"taskSnapshot", prev)?;
    result
}
pub(super) fn operation<'a>(p: L<'a>, b: L<'a>, op: &str) -> Result<L<'a>> {
    let which = if op == "todos-ignore" {
        "ignores"
    } else if op.starts_with("pins-") {
        "pins"
    } else {
        "todos"
    };
    let l = list(p, which)?;
    match op.split_once('-').map(|(_, s)| s) {
        Some("read") => call(l, c"read", &[]),
        Some("replace") => call(l, c"replace", &[b.get(c"taskIds")?]),
        _ => call(l, c"toggle", &[b.get(c"taskId")?]),
    }
}
