use super::*;
use crate::task_board_planning::task_board_planning_result;

fn plan<'a>(p: L<'a>, action: &'static str, args: L<'a>) -> Result<L<'a>> {
    let input = args.get(c"input")?;
    let dates = array(p, &[])?;
    for value in [
        input,
        input.optional(c"dueAt")?,
        args.get(c"task")?.optional(c"dueAt")?,
    ] {
        if !value.undefined()? {
            date_pair(p, dates, value)?;
        }
    }
    let board = args.get(c"board")?;
    let order = if call(p, c"boardStoreOf", &[board])?.truthy()? {
        undefined(p)?
    } else {
        let keys = object_method(p, c"keys", &[empty_if_falsy(board.optional(c"tasks")?)?])?;
        call(keys, c"sort", &[p.get(c"compareIds")?])?
    };
    let command = domain_command(p, "planning", text(p, action)?, args)?;
    command.set(
        c"inputNonFinite",
        flag(p, input.number_value()?.is_some_and(|n| !n.is_finite()))?,
    )?;
    command.set(c"dates", dates)?;
    command.set(c"idOrder", order)?;
    let output = call(p, c"taskDomain", &[command])?;
    Ok(raw(
        p,
        task_board_planning_result(
            env(p),
            action.into(),
            arg(args)?,
            arg(output)?,
            arg(p.get(c"replace")?)?,
            arg(p.get(c"mapTasks")?)?,
        )?,
    ))
}

fn mutation<'a>(p: L<'a>, name: &'static str, args: &[L<'a>]) -> Result<L<'a>> {
    let create = name == "createPlannedTask";
    let board = args[0];
    let index = if create { 1 } else { 2 };
    let input = if name == "renameTask" {
        args[index]
    } else {
        default_object(args[index])?
    };
    let original = default_object(args[index + 1])?;
    let id = if create {
        let id = original.get(c"id")?;
        if id.truthy()? {
            id
        } else {
            new_id(p, text(p, "tsk-plan")?)?
        }
    } else {
        args[1]
    };
    let options = fields(p, &[("now", now(p)?)])?;
    options.spread_from(original)?;
    plan(
        p,
        name,
        fields(
            p,
            &[
                ("board", board),
                ("taskId", id),
                ("input", input),
                ("options", options),
            ],
        )?,
    )
}

pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let out = fields(
        p,
        &[
            ("wireDate", p.get(c"wireDate")?),
            ("TASK_BOARD_SCHEMA_VERSION", num(p, 2.)?),
            (
                "TASK_RECORD_TYPES",
                string_set(p, &["planned", "observed"])?,
            ),
            (
                "WORKFLOW_STAGES",
                string_set(p, &["inbox", "ready", "doing", "review", "done"])?,
            ),
            (
                "TASK_PRIORITIES",
                string_set(p, &["low", "medium", "high", "urgent"])?,
            ),
            ("RANK_STEP", num(p, 1024.)?),
        ],
    )?;
    for name in ["normalizePriority", "normalizeDueAt"] {
        expose(p, out, name, 1, 1, move |p, a| {
            plan(p, name, fields(p, &[("input", a[0])])?)
        })?;
    }
    for (name, fallback) in [("normalizeRank", 0.), ("planningRevision", 1.)] {
        expose(p, out, name, 1, 2, move |p, a| {
            let options = fields(p, &[("fallback", or_default(a[1], num(p, fallback)?)?)])?;
            plan(
                p,
                name,
                fields(p, &[("input", a[0]), ("options", options)])?,
            )
        })?;
    }
    for (name, key) in [
        ("recordTypeForTask", "origin"),
        ("validateExpectedRevision", "input"),
    ] {
        expose(p, out, name, 2, 2, move |p, a| {
            plan(p, name, fields(p, &[("task", a[0]), (key, a[1])])?)
        })?;
    }
    expose(p, out, "normalizePlanningTask", 1, 2, |p, a| {
        plan(
            p,
            "normalizePlanningTask",
            fields(p, &[("task", a[0]), ("options", default_object(a[1])?)])?,
        )
    })?;
    expose(p, out, "planningFields", 1, 1, |p, a| {
        plan(p, "planningFields", fields(p, &[("task", a[0])])?)
    })?;
    for name in ["plannedTasksInStage", "rankAtEnd", "renumberStage"] {
        expose(p, out, name, 2, 4, move |p, a| {
            plan(
                p,
                name,
                fields(
                    p,
                    &[
                        ("board", a[0]),
                        ("stage", a[1]),
                        ("exclude", or_default(a[2], null(p)?)?),
                        ("dirId", or_default(a[3], null(p)?)?),
                    ],
                )?,
            )
        })?;
    }
    expose(p, out, "rankForMove", 3, 4, |p, a| {
        let input = default_object(a[3])?;
        plan(
            p,
            "rankForMove",
            fields(
                p,
                &[
                    ("board", a[0]),
                    ("taskId", a[1]),
                    ("stage", a[2]),
                    ("input", input),
                    ("options", input),
                ],
            )?,
        )
    })?;
    for (name, length, count) in [
        ("createPlannedTask", 1, 3),
        ("updatePlannedTask", 2, 4),
        ("renameTask", 3, 4),
        ("movePlannedTask", 2, 4),
    ] {
        expose(p, out, name, length, count, move |p, a| {
            mutation(p, name, a)
        })?;
    }
    expose(p, out, "markPlannedTaskStarted", 1, 2, |p, a| {
        let options = fields(p, &[("now", time_or_now(a[1])?)])?;
        plan(
            p,
            "markPlannedTaskStarted",
            fields(p, &[("task", a[0]), ("options", options)])?,
        )
    })?;
    expose(p, out, "alignStageWithStatus", 2, 4, |p, a| {
        let options = fields(p, &[("now", time_or_now(a[2])?)])?;
        plan(
            p,
            "alignStageWithStatus",
            fields(
                p,
                &[
                    ("task", a[0]),
                    ("board", or_default(a[3], null(p)?)?),
                    ("status", a[1]),
                    ("options", options),
                ],
            )?,
        )
    })?;
    Ok(out)
}
