use super::bridge::{board_rule, rule};
use super::*;

fn normalized<'a>(p: L<'a>, name: &str, args: L<'a>) -> Result<L<'a>> {
    let board = args.get(c"board")?;
    let value = args.get(c"value")?;
    let mut groups = board.optional(c"taskGroups")?;
    if !groups.truthy()? {
        groups = value.optional(c"taskGroups")?;
    }
    let order = group_order(p, groups, true)?;
    let dates = array(p, &[])?;
    let tasks = empty_if_falsy(value.optional(c"tasks")?)?;
    object_method(p, c"values", &[tasks])?.for_each(|task| {
        let due = task.get(c"dueAt")?;
        let iso = call(p, c"wireDate", &[task.get(c"dueAt")?])?;
        call(dates, c"push", &[array(p, &[due, iso])?])?;
        Ok(())
    })?;
    let input = fields(p, &[("op", text(p, "normalize")?)])?;
    input.spread_from(args)?;
    input.set(c"idOrder", order)?;
    input.set(c"dates", dates)?;
    board_rule(p, text(p, name)?, input)
}

fn live<'a>(result: L<'a>, board: L<'a>, kind: &CStr) -> Result<L<'a>> {
    if result.truthy()? {
        board.get(kind)?.get_key(result.get(c"id")?)
    } else {
        null(board)
    }
}

pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let out = fields(
        p,
        &[
            ("MAX_TAGS_PER_TURN", num(p, 3.)?),
            ("MAX_AREAS_PER_TASK", num(p, 8.)?),
            ("MAX_REFS_PER_TASK", num(p, f64::INFINITY)?),
            ("MAX_TASKS_IN_PROMPT", num(p, 50.)?),
            ("MAX_TITLE_LEN", num(p, 40.)?),
            ("MAX_MODULE_LEN", num(p, 20.)?),
            ("MAX_TASKS_PER_GROUP", num(p, 100.)?),
            ("CLASSIFY_PENDING_MODULE_NAME", text(p, "待归类")?),
            ("PENDING_TASK_TITLE", text(p, "新任务")?),
            (
                "TASK_RUN_STATES",
                p.global()?
                    .get(c"Set")?
                    .construct(&[p.get(c"turnRunStates")?])?,
            ),
            ("TASK_ORIGINS", string_set(p, &["board", "session"])?),
        ],
    )?;
    for name in [
        "taskOriginForSource",
        "legacyTaskOrigin",
        "safeClassificationError",
        "normalizeModuleName",
        "normalizeBoard",
        "normalizeName",
        "canonicalTaskTitle",
        "deriveTaskTitle",
    ] {
        expose(p, out, name, 1, 1, move |p, a| {
            normalized(p, name, fields(p, &[("value", a[0])])?)
        })?;
    }
    expose(p, out, "createEmptyBoard", 0, 0, |p, _| {
        normalized(p, "createEmptyBoard", fields(p, &[])?)
    })?;
    expose(p, out, "taskTitleSimilarity", 2, 2, |p, a| {
        normalized(
            p,
            "taskTitleSimilarity",
            fields(p, &[("a", a[0]), ("b", a[1])])?,
        )
    })?;
    expose(p, out, "findModuleByName", 2, 3, |p, a| {
        let args = fields(
            p,
            &[
                ("board", a[0]),
                ("value", a[1]),
                ("dirId", or_default(a[2], null(p)?)?),
            ],
        )?;
        live(normalized(p, "findModuleByName", args)?, a[0], c"modules")
    })?;
    expose(p, out, "ownTask", 2, 2, |p, a| {
        let tasks = a[0].optional(c"tasks")?;
        if tasks.truthy()? && object_method(p, c"hasOwn", &[tasks, a[1]])?.truthy()? {
            tasks.get_key(a[1])
        } else {
            null(p)
        }
    })?;
    expose(p, out, "reconcileTaskGroups", 1, 1, |p, a| {
        normalized(p, "reconcileTaskGroups", fields(p, &[("board", a[0])])?)?;
        empty_if_falsy(a[0].optional(c"taskGroups")?)
    })?;
    expose(p, out, "relatedTaskGroup", 2, 2, |p, a| {
        let args = fields(p, &[("board", a[0]), ("taskId", a[1])])?;
        live(
            normalized(p, "relatedTaskGroup", args)?,
            a[0],
            c"taskGroups",
        )
    })?;
    expose(p, out, "groupRelatedTasks", 3, 4, |p, a| {
        normalized(
            p,
            "groupRelatedTasks",
            fields(
                p,
                &[
                    ("board", a[0]),
                    ("taskId", a[1]),
                    ("relatedTaskId", a[2]),
                    ("now", time_or_now(a[3])?),
                ],
            )?,
        )
    })?;
    expose(p, out, "normalizeTaskRouting", 1, 1, |p, a| {
        rule(p, "normalizeTaskRouting", &[("value", a[0])])
    })?;
    expose(p, out, "setTaskRouting", 2, 2, |p, a| {
        rule(
            p,
            "setTaskRouting",
            &[("task", a[0]), ("value", a[1]), ("now", now(p)?)],
        )
    })?;
    expose(p, out, "taskDirId", 2, 2, |p, a| {
        let modules = call(p, c"moduleEntry", &[a[0], a[1]])?;
        rule(
            p,
            "taskDirId",
            &[
                ("board", fields(p, &[("modules", modules)])?),
                ("task", a[1]),
            ],
        )
    })?;
    expose(p, out, "resolveTask", 2, 2, |p, a| {
        live(
            rule(p, "resolveTask", &[("board", a[0]), ("taskId", a[1])])?,
            a[0],
            c"tasks",
        )
    })?;
    expose(p, out, "taskLineageIds", 2, 2, |p, a| {
        rule(p, "taskLineageIds", &[("board", a[0]), ("taskId", a[1])])
    })?;
    expose(p, out, "taskLastTs", 1, 1, |p, a| {
        rule(p, "taskLastTs", &[("task", a[0])])
    })?;
    expose(p, out, "addRefToTask", 3, 4, |p, a| {
        rule(
            p,
            "addRefToTask",
            &[
                ("task", a[0]),
                ("ref", a[1]),
                ("now", a[2]),
                ("maxRefs", or_default(a[3], num(p, f64::INFINITY)?)?),
            ],
        )
    })?;
    expose(p, out, "newId", 1, 1, |p, a| new_id(p, a[0]))?;
    Ok(out)
}
