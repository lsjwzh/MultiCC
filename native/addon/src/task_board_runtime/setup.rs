//! Compose the live board once. Persistent records and callbacks keep their V8
//! identity for the lifetime of the runtime.
use super::{board_state, lifecycle, projection, route_ports, worktree};
use crate::{
    host_api::*,
    host_methods::{arg, env, raw},
    task_board_classification::{task_board_classify_goal, task_board_turn_end},
    task_board_groups::{task_board_assert_deps, task_board_link_related},
};
use napi_derive::napi;

mod classification;
fn host(p: L<'_>) -> Result<L<'_>> {
    p.get(c"host")
}
fn deps(p: L<'_>) -> Result<L<'_>> {
    p.get(c"deps")
}
fn init_ports<'a>(host: L<'a>, d: L<'a>) -> Result<L<'a>> {
    let logger = d.get(c"logger")?;
    let logger = if logger.truthy()? {
        logger
    } else {
        d.global()?.get(c"console")?
    };
    let supplied = d.get(c"taskBoardRepository")?;
    let repo = if supplied.truthy()? {
        supplied
    } else {
        call(host, c"createTaskBoardRepository", &[d.get(c"file")?])?
    };
    let loaded = call(repo, c"load", &[])?;
    if loaded.get(c"restored")?.truthy()? {
        call(
            logger,
            c"log",
            &[text(
                d,
                "[multicc/taskboard] restored planning board from v2 recovery sidecar",
            )?],
        )?;
    }
    let quarantined = loaded.get(c"quarantined")?;
    if quarantined.optional(c"length")?.truthy()? {
        let warn = logger.get(c"warn")?;
        let log = if warn.truthy()? {
            warn
        } else {
            logger.get(c"log")?
        };
        let count = fold_string(quarantined.get(c"length")?)?;
        let files = fold_string(call(quarantined, c"join", &[text(d, ", ")?])?)?;
        log.call(
            logger,
            &[text(
                d,
                &format!(
                    "[multicc/taskboard] quarantined {count} unreadable board file(s): {files}"
                ),
            )?],
        )?;
    }
    let store = call(
        host,
        c"openBoardStore",
        &[fields(
            d,
            &[
                ("raw", loaded.get(c"raw")?),
                ("repository", repo),
                ("logger", logger),
            ],
        )?],
    )?;
    let p = pick(
        d,
        &[
            c"records",
            c"loadHistory",
            c"workspaceBroadcast",
            c"getSessionRunState",
        ],
    )?;
    p.spread_from(pick(
        host,
        &[
            c"core",
            c"planning",
            c"attention",
            c"crypto",
            c"recentTaskIds",
            c"runStateForFreezeReason",
            c"runStateForLetter",
            c"isVoiceRouterRecord",
        ],
    )?)?;
    p.set(c"deps", d)?;
    p.set(c"host", host)?;
    p.set(c"logger", logger)?;
    p.set(c"boardStore", store)?;
    p.set(c"board", store.get(c"board")?)?;
    let map = d.global()?.get(c"Map")?;
    p.set(c"activeTaskOperations", map.construct(&[])?)?;
    let create = d.get(c"createSessionRecord")?;
    p.set(
        c"createSessionRecord",
        if callable(create)? { create } else { null(p)? },
    )?;
    let resolve = d.get(c"resolveSessionQueue")?;
    p.set(
        c"resolveSessionQueue",
        if callable(resolve)? {
            resolve
        } else {
            function(p, "resolveSessionQueue", 0, 0, |p, _| {
                resolved(fields(
                    p,
                    &[
                        ("ok", flag(p, false)?),
                        ("code", text(p, "no_active_task")?),
                    ],
                )?)
            })?
        },
    )?;
    let dirs = d.get(c"directories")?;
    let resolve = if dirs.instance_of(map)? {
        function(d, "getDirectory", 1, 1, |d, a| {
            call(d.get(c"directories")?, c"get", a)
        })?
    } else if callable(dirs)? {
        dirs
    } else {
        null(p)?
    };
    p.set(c"resolveDirectoryPort", resolve)?;
    // All three factories capture p; publish their results together before use.
    let state = raw(p, board_state::task_board_state_api(env(p), arg(p)?)?);
    let projection = raw(p, projection::task_board_projection_api(env(p), arg(p)?)?);
    let lifecycle = raw(p, lifecycle::task_board_lifecycle_api(env(p), arg(p)?)?);
    for api in [state, projection, lifecycle] {
        p.spread_from(api)?;
    }
    p.set(
        c"getBoard",
        function(p, "getBoard", 0, 0, |p, _| p.get(c"board"))?,
    )?;
    p.set(
        c"taskDirId",
        function(p, "taskDirId", 1, 1, |p, a| {
            call(p.get(c"core")?, c"taskDirId", &[p.get(c"board")?, a[0]])
        })?,
    )?;
    Ok(p)
}
fn task_worktree(p: L<'_>) -> Result<L<'_>> {
    let d = deps(p)?;
    if !p.get(c"resolveDirectoryPort")?.truthy()? {
        return null(p);
    }
    for key in [c"gitWorktreeAdd", c"gitWorktreeRemove", c"gitMergeBack"] {
        if !callable(d.get(key)?)? {
            return null(p);
        }
    }
    let opts = raw(p, worktree::task_board_worktree_ports(env(p), arg(p)?)?);
    opts.set(c"getDirectory", p.get(c"resolveDirectoryPort")?)?;
    opts.set(c"taskDirIdOf", p.get(c"taskDirId")?)?;
    opts.set(
        c"updateTask",
        function(p, "updateTask", 2, 2, |p, a| {
            call(
                p,
                c"updateBoardTask",
                &[
                    a[0],
                    a[1],
                    fields(p, &[("requirePersist", flag(p, true)?)])?,
                ],
            )
        })?,
    )?;
    opts.spread_from(pick(
        d,
        &[c"gitWorktreeAdd", c"gitWorktreeRemove", c"gitMergeBack"],
    )?)?;
    let exists = d.get(c"existsSync")?;
    opts.set(
        c"existsSync",
        if callable(exists)? {
            exists
        } else {
            host(p)?.get(c"existsSync")?
        },
    )?;
    opts.set(c"beginTaskOperation", p.get(c"holdTaskOperation")?)?;
    opts.set(c"logger", p.get(c"logger")?)?;
    call(host(p)?, c"createTaskWorktreeService", &[opts])
}
fn wire_mutations(p: L<'_>) -> Result<()> {
    let h = host(p)?;
    let d = deps(p)?;
    let shared = pick(
        p,
        &[
            c"deps",
            c"getBoard",
            c"taskIdentityIds",
            c"taskDto",
            c"notify",
            c"taskDirId",
        ],
    )?;
    shared.set(c"resolveTask", p.get(c"resolvedTask")?)?;
    shared.set(c"commit", p.get(c"commitPlanningMutation")?)?;
    let opts = spread(shared)?;
    opts.set(c"activeOperations", p.get(c"activeTaskOperations")?)?;
    let lifecycle = call(h, c"createBoardTaskLifecycle", &[opts])?;
    p.set(c"taskLifecycle", lifecycle)?;
    let busy = function(lifecycle, "isTaskBusy", 1, 1, |lc, a| {
        call(lc, c"isBusy", a)
    })?;
    p.set(c"isTaskBusy", busy)?;

    let retention = pick(p, &[c"getBoard", c"records", c"taskDirId"])?;
    retention.set(c"taskLineageIds", p.get(c"taskIdentityIds")?)?;
    retention.set(
        c"getPinnedTaskIds",
        function(d, "getPinnedTaskIds", 0, 0, |d, _| {
            call(d, c"getPinnedTaskIds", &[])
        })?,
    )?;
    retention.set(c"getRunState", p.get(c"getSessionRunState")?)?;
    retention.set(
        c"isSessionBusy",
        function(d, "isSessionBusy", 1, 1, |d, a| {
            let f = d.get(c"isSessionBusy")?;
            flag(d, !f.nullish()? && f.call(d, a)?.is_true()?)
        })?,
    )?;
    retention.set(
        c"isTaskBusy",
        function(p, "isTaskBusy", 1, 1, |p, a| {
            flag(
                p,
                call(p, c"isTaskBusy", a)?.truthy()?
                    || call(p.get(c"activeTaskOperations")?, c"get", a)?.truthy()?,
            )
        })?,
    )?;
    retention.set(
        c"prepareDelete",
        function(d, "prepareDelete", 3, 3, |d, a| {
            call(d, c"prepareTaskDelete", a)
        })?,
    )?;
    retention.set(
        c"deleteById",
        function(lifecycle, "deleteById", 2, 2, |lc, a| {
            call(lc, c"deleteById", a)
        })?,
    )?;
    p.set(c"retention", call(h, c"createTaskRetention", &[retention])?)?;
    shared.set(c"isBusy", busy)?;
    shared.set(c"logger", p.get(c"logger")?)?;
    p.set(c"taskRelocate", call(h, c"createTaskRelocate", &[shared])?)?;

    let planning = pick(
        p,
        &[c"getBoard", c"taskDto", c"taskDirId", c"notify", c"logger"],
    )?;
    planning.set(c"resolveTask", p.get(c"resolvedTask")?)?;
    planning.set(c"commitMutation", p.get(c"commitPlanningMutation")?)?;
    let rename = d.get(c"syncTaskTitle")?;
    if callable(rename)? {
        planning.set(c"afterRename", rename)?;
    }
    let dir = p.get(c"resolveDirectoryPort")?;
    if dir.truthy()? {
        planning.set(
            c"hasDirectory",
            function(dir, "hasDirectory", 1, 1, |f, a| {
                flag(f, f.call_plain(a)?.truthy()?)
            })?,
        )?;
    }
    planning.set(
        c"beforeStageChange",
        function(p, "beforeStageChange", 1, 1, |p, a| {
            call(
                p,
                c"resolveLegacySessionQueues",
                &[
                    a[0],
                    text(
                        p,
                        "当前任务仍在执行；请先取消，或等待其进入冻结状态后再移动到已完成。",
                    )?,
                ],
            )
        })?,
    )?;
    p.set(
        c"planningRuntime",
        call(h, c"createTaskPlanningRuntime", &[planning])?,
    )?;
    let follow = pick(
        p,
        &[
            c"board",
            c"core",
            c"planning",
            c"records",
            c"crypto",
            c"logger",
            c"loadHistory",
            c"resolvedTask",
            c"ensureBoundChatSession",
            c"save",
            c"notify",
            c"isTaskBusy",
        ],
    )?;
    follow.spread_from(pick(d, &[c"sendSessionMessage", c"buildTaskRunContext"])?)?;
    let start = pick(
        p,
        &[
            c"board",
            c"core",
            c"records",
            c"crypto",
            c"logger",
            c"createSessionRecord",
            c"ensureBoundChatSession",
            c"ensureTaskIndex",
            c"updateBoardTask",
            c"save",
            c"notify",
        ],
    )?;
    start.spread_from(pick(d, &[c"sendSessionMessage", c"dispatchToSession"])?)?;
    p.set(c"followupPorts", follow)?;
    p.set(c"startPorts", start)
}
#[napi]
pub fn task_board_runtime_create(
    env_arg: Env,
    deps: Unknown<'_>,
    host: Unknown<'_>,
) -> Result<sys::napi_value> {
    let d = L::new(&env_arg, deps);
    task_board_assert_deps(env(d), arg(d)?)?;
    let p = init_ports(L::new(&env_arg, host), d)?;
    let worktree = task_worktree(p)?;
    let scan = classification::setup(p)?;
    wire_mutations(p)?;
    let routes = raw(p, route_ports::task_board_route_ports(env(p), arg(p)?)?);
    let timer = call(p.global()?, c"setTimeout", &[scan, num(p, 1000.)?])?;
    if callable(timer.get(c"unref")?)? {
        call(timer, c"unref", &[])?;
    }
    let result = pick(
        p,
        &[
            c"registerShellTask",
            c"onMessagePersisted",
            c"onQueueEvent",
            c"reconcileRunState",
            c"recordRouterAdmission",
            c"reassignTurnTask",
            c"routeCommanderInput",
            c"routeCommanderFollowup",
            c"markTaskSeen",
            c"getBoard",
            c"save",
            c"archiveTasks",
        ],
    )?;
    result.set(c"routePorts", routes)?;
    result.set(c"isTaskLifecycleBusy", p.get(c"isTaskBusy")?)?;
    result.set(c"taskWorktree", worktree)?;
    result.set(c"scanPendingClassifications", scan)?;
    result.set(
        c"evictOldestSafeTask",
        function(p, "evictOldestSafeTask", 4, 4, |p, a| {
            call(p.get(c"retention")?, c"evict", a)
        })?,
    )?;
    classification::public(p, result)?;
    let linking = pick(p, &[c"board", c"save", c"notify"])?;
    linking.set(
        c"groupRelatedTasks",
        p.get(c"core")?.get(c"groupRelatedTasks")?,
    )?;
    linking.set(c"now", p.global()?.get(c"Date")?.get(c"now")?)?;
    result.set(
        c"linkRelatedTasks",
        function(linking, "linkRelatedTasks", 2, 2, |link, a| {
            Ok(raw(
                link,
                task_board_link_related(env(link), arg(link)?, arg(a[0])?, arg(a[1])?)?,
            ))
        })?,
    )?;
    Ok(result.freeze()?.raw())
}
