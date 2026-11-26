//! Public board operations retain the live task selected by the resident board.
//! Pure classification commands work for both resident and detached boards.
use crate::{
    host_methods::{arg, default_object, env, function, raw},
    route_response::*,
    task_board_classification::{task_board_system_prompt, task_board_user_prompt},
};
use napi_derive::napi;

fn inherit<'a>(api: L<'a>, source: L<'a>, names: &[&str]) -> Result<()> {
    for name in names {
        let key = text(api, name)?;
        api.set_key(key, source.get_key(key)?)?;
    }
    Ok(())
}

fn current_time(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Date")?, c"now", &[])
}

fn time_or_now(v: L<'_>) -> Result<L<'_>> {
    if v.undefined()? {
        current_time(v)
    } else {
        Ok(v)
    }
}

fn classified<'a>(p: L<'a>, action: &str, payload: L<'a>) -> Result<L<'a>> {
    p.get(c"classificationRule")?
        .call_plain(&[text(p, action)?, payload])
}

fn classified_task<'a>(p: L<'a>, action: &str, board: L<'a>, payload: L<'a>) -> Result<L<'a>> {
    let task = classified(p, action, payload)?;
    if task.truthy()? {
        board.get(c"tasks")?.get_key(task.get(c"id")?)
    } else {
        null(p)
    }
}

#[napi]
pub fn task_board_core_api(env_arg: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let ports = L::new(&env_arg, ports);
    let api = fields(ports, &[])?;
    let normalize = ports.get(c"normalize")?;
    let bridge = ports.get(c"bridge")?;
    inherit(
        api,
        normalize,
        &[
            "MAX_TAGS_PER_TURN",
            "MAX_REFS_PER_TASK",
            "CLASSIFY_PENDING_MODULE_NAME",
            "PENDING_TASK_TITLE",
            "TASK_ORIGINS",
        ],
    )?;
    inherit(
        api,
        ports.get(c"planning")?,
        &["TASK_RECORD_TYPES", "WORKFLOW_STAGES"],
    )?;
    inherit(
        api,
        normalize,
        &[
            "taskOriginForSource",
            "legacyTaskOrigin",
            "deriveTaskTitle",
            "createEmptyBoard",
            "normalizeBoard",
        ],
    )?;
    for (system, user, backfill) in [
        ("buildTagSystemPrompt", "buildTagUserPrompt", false),
        ("buildBackfillSystemPrompt", "buildBackfillUserPrompt", true),
    ] {
        api.set_key(
            text(api, system)?,
            function(bridge, system, 0, 0, move |p, _| {
                text(p, task_board_system_prompt(backfill))
            })?,
        )?;
        api.set_key(
            text(api, user)?,
            function(bridge, user, 1, 1, move |p, a| {
                Ok(raw(
                    p,
                    task_board_user_prompt(
                        env(p),
                        arg(a[0])?,
                        arg(p.get(c"recentTaskIds")?)?,
                        backfill,
                    )?,
                ))
            })?,
        )?;
    }
    for name in ["parseTagResult", "parseBackfillResult"] {
        api.set_key(
            text(api, name)?,
            function(bridge, name, 1, 1, move |p, a| {
                classified(p, name, fields(p, &[("value", a[0])])?)
            })?,
        )?;
    }
    api.set(
        c"applyTagResult",
        function(bridge, "applyTagResult", 3, 5, |p, a| {
            classified(
                p,
                "applyTagResult",
                fields(
                    p,
                    &[
                        ("board", a[0]),
                        ("entries", a[1]),
                        ("ref", a[2]),
                        ("now", time_or_now(a[3])?),
                        ("options", default_object(a[4])?),
                    ],
                )?,
            )
        })?,
    )?;
    api.set(
        c"applyBackfillResult",
        function(bridge, "applyBackfillResult", 3, 4, |p, a| {
            let now = time_or_now(a[3])?;
            let refs = call(p.global()?.get(c"Object")?, c"fromEntries", &[a[2]])?;
            classified(
                p,
                "applyBackfillResult",
                fields(
                    p,
                    &[
                        ("board", a[0]),
                        ("entries", a[1]),
                        ("refByTurn", refs),
                        ("now", now),
                    ],
                )?,
            )
        })?,
    )?;
    inherit(
        api,
        normalize,
        &[
            "addRefToTask",
            "groupRelatedTasks",
            "relatedTaskGroup",
            "reconcileTaskGroups",
        ],
    )?;
    for (name, len) in [("mergeTasks", 1), ("createPendingTask", 2)] {
        api.set_key(
            text(api, name)?,
            function(bridge, name, len, 2, move |p, a| {
                let input = fields(p, &[("now", current_time(p)?)])?;
                input.spread_from(a[1])?;
                let payload = fields(p, &[("board", a[0]), ("input", input)])?;
                if name == "createPendingTask" {
                    classified_task(p, name, a[0], payload)
                } else {
                    classified(p, name, payload)
                }
            })?,
        )?;
    }
    api.set(
        c"applyTaskClassification",
        function(bridge, "applyTaskClassification", 4, 6, |p, a| {
            classified(
                p,
                "applyTaskClassification",
                fields(
                    p,
                    &[
                        ("board", a[0]),
                        ("taskId", a[1]),
                        ("entry", a[2]),
                        ("ref", a[3]),
                        ("now", time_or_now(a[4])?),
                        ("options", default_object(a[5])?),
                    ],
                )?,
            )
        })?,
    )?;
    inherit(
        api,
        normalize,
        &[
            "canonicalTaskTitle",
            "taskTitleSimilarity",
            "findModuleByName",
        ],
    )?;
    api.set(
        c"findTaskByTitle",
        function(bridge, "findTaskByTitle", 3, 4, |p, a| {
            classified_task(
                p,
                "findTaskByTitle",
                a[0],
                fields(
                    p,
                    &[
                        ("board", a[0]),
                        ("moduleId", a[1]),
                        ("value", a[2]),
                        ("options", default_object(a[3])?),
                    ],
                )?,
            )
        })?,
    )?;
    inherit(
        api,
        normalize,
        &["taskLastTs", "taskDirId", "resolveTask", "taskLineageIds"],
    )?;
    inherit(
        api,
        ports.get(c"routing")?,
        &[
            "pickRouteTarget",
            "pickDirTarget",
            "resolveDirectoryCommander",
            "isRoutableRecord",
            "routingTerms",
            "buildRoutingContext",
            "buildSessionRoutingProfile",
            "routingRelevanceScore",
            "recordAppearsAvailable",
            "rankRoutingCandidates",
            "buildRoutedMessage",
            "buildCommanderRoutedMessage",
            "extractTaskMarker",
            "messageText",
        ],
    )?;
    inherit(
        api,
        bridge.get(c"boardView")?,
        &[
            "buildBoardDto",
            "taskRunSessionIds",
            "deadDispatchClaim",
            "foreignRunSession",
            "staleWorkerClaim",
            "soleRunSessionId",
            "sessionHasTurn",
        ],
    )?;
    inherit(api, normalize, &["normalizeTaskRouting", "setTaskRouting"])?;
    Ok(api.raw())
}
