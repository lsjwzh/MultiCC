//! Per-task workspace lifecycle. All git operations run through the caller's repo actor ports.
use crate::host_api::*;
use napi_derive::napi;
use std::ffi::CStr;

fn port<'a>(p: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    p.get(c"opts")?.get(name)?.call_plain(args)
}
fn token<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let hash = call(p.get(c"crypto")?, c"createHash", &[text(p, "sha256")?])?;
    let bytes = string(fallback(id, "".into())?)?;
    call(hash, c"update", &[bytes, text(p, "utf8")?])?;
    let hex = fold_string(call(hash, c"digest", &[text(p, "hex")?])?)?;
    text(p, &format!("task-{}", &hex[..8]))
}
fn id_key(id: L<'_>) -> Result<L<'_>> {
    call(string(fallback(id, "".into())?)?, c"trim", &[])
}
fn failed<'a>(p: L<'a>, code: &str) -> Result<L<'a>> {
    fields(p, &[("ok", flag(p, false)?), ("code", text(p, code)?)])
}
fn busy<'a>(p: L<'a>, id: L<'a>) -> Result<Option<L<'a>>> {
    let check = p.get(c"opts")?.get(c"isTaskRunning")?;
    if check.truthy()? && check.call_plain(&[id])?.truthy()? {
        let refusal = failed(p, "run_active")?;
        refusal.set(c"blocked", flag(p, true)?)?;
        return Ok(Some(refusal));
    }
    Ok(None)
}
fn held<'a>(p: L<'a>, id: L<'a>, action: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    async_result(p, || {
        let begin = p.get(c"opts")?.get(c"beginTaskOperation")?;
        if !begin.truthy()? {
            return action();
        }
        let release = begin.call_plain(&[id])?;
        match action() {
            Ok(value) => {
                let mut pending = false;
                napi::check_status!(unsafe {
                    sys::napi_is_promise(p.env(), value.raw(), &mut pending)
                })?;
                if pending {
                    let done = function(release, "release", 0, 0, |release, _| {
                        release.call_plain(&[])?;
                        undef(release)
                    })?;
                    call(value, c"finally", &[done])
                } else {
                    release.call_plain(&[])?;
                    Ok(value)
                }
            }
            Err(error) => {
                let thrown = p.exception_value()?;
                release.call_plain(&[])?;
                Err(thrown.map(|v| v.throw_error()).unwrap_or(error))
            }
        }
    })
}
fn directory<'a>(p: L<'a>, task: L<'a>) -> Result<L<'a>> {
    port(p, c"getDirectory", &[port(p, c"taskDirIdOf", &[task])?])
}
fn info<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let id = id_key(a[0])?;
    let task = port(p, c"getBoardTask", &[id])?;
    if !task.truthy()? || !task.get(c"worktreePath")?.truthy()? || !task.get(c"branch")?.truthy()? {
        return null(p);
    }
    let dir = directory(p, task)?;
    if !dir.truthy()? {
        return null(p);
    }
    fields(
        p,
        &[
            ("dirId", dir.get(c"id")?),
            ("dir", dir),
            ("worktreePath", task.get(c"worktreePath")?),
            ("branch", task.get(c"branch")?),
            ("token", token(p, id)?),
        ],
    )
}
fn ensure<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let id = id_key(a[0])?;
        held(p, id, || {
            let frame = fields(p, &[("p", p), ("id", id)])?;
            let result: Result<L<'_>> = (|| {
                let task = port(p, c"getBoardTask", &[id])?;
                if !task.truthy()? {
                    return failed(p, "task_not_found");
                }
                let dir = directory(p, task)?;
                if !dir.truthy()? || !dir.get(c"path")?.truthy()? {
                    return failed(p, "directory_not_found");
                }
                let result = port(
                    p,
                    c"gitWorktreeAdd",
                    &[dir.get(c"path")?, token(p, id)?, dir.get(c"baseBranch")?],
                )?;
                let f = fields(p, &[("p", p), ("task", task), ("id", id), ("dir", dir)])?;
                then(result, f, |f, a| {
                    let task = f.get(c"task")?;
                    let update = pick(a[0], &[c"worktreePath", c"branch"])?;
                    if !task
                        .get(c"worktreePath")?
                        .equals(update.get(c"worktreePath")?)?
                        || !task.get(c"branch")?.equals(update.get(c"branch")?)?
                    {
                        port(f.get(c"p")?, c"updateTask", &[f.get(c"id")?, update])?;
                    }
                    let out = fields(f, &[("ok", flag(f, true)?)])?;
                    out.spread_from(update)?;
                    out.set(c"dirId", f.get(c"dir")?.get(c"id")?)?;
                    out.set(c"reused", flag(f, a[0].get(c"existing")?.is_true()?)?)?;
                    Ok(out)
                })
            })();
            match result {
                Ok(result) if result.optional(c"ok")?.is_false()? => Ok(result),
                Ok(result) => recover(result, frame, ensure_failed),
                Err(error) => match p.exception_value()? {
                    Some(why) => ensure_failed(frame, &mut [why]),
                    None => Err(error),
                },
            }
        })
    })
}
fn ensure_failed<'a>(f: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let msg = a[0].optional(c"message")?;
    let detail = if msg.truthy()? { msg } else { string(a[0])? };
    let logger = with_default(
        f.get(c"p")?.get(c"opts")?.get(c"logger")?,
        f.global()?.get(c"console")?,
    )?;
    call(
        logger,
        c"log",
        &[text(
            f,
            &format!(
                "[multicc/taskworktree] ensure failed for {}: {}",
                fold_string(f.get(c"id")?)?,
                fold_string(detail)?
            ),
        )?],
    )?;
    let out = failed(f, "worktree_create_failed")?;
    out.set(c"error", detail)?;
    Ok(out)
}
fn merge_task<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let id = a[0];
    held(p, id, || {
        let r = info(p, &mut [id])?;
        if !r.truthy()? {
            return failed(p, "worktree_not_found");
        }
        if let Some(v) = busy(p, id)? {
            return Ok(v);
        }
        let session = fields(
            p,
            &[
                ("id", r.get(c"token")?),
                ("worktreePath", r.get(c"worktreePath")?),
                ("branch", r.get(c"branch")?),
            ],
        )?;
        resolved(port(p, c"gitMergeBack", &[r.get(c"dir")?, session])?)
    })
}
fn removal<'a>(f: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(f, || {
        let o = default_object(a[0])?;
        let id = o.get(c"sessionId")?;
        let p = f.get(c"p")?;
        let id = if id.undefined()? {
            token(p, f.get(c"id")?)?
        } else {
            id
        };
        let task = f.get(c"expected")?;
        let path = task.get(c"worktreePath")?;
        let exists = with_default(p.get(c"opts")?.get(c"existsSync")?, p.get(c"existsSync")?)?;
        if !exists.call_plain(&[path])?.truthy()? {
            return fields(
                f,
                &[
                    ("ok", flag(f, true)?),
                    ("removed", flag(f, true)?),
                    ("alreadyGone", flag(f, true)?),
                ],
            );
        }
        let dir = f.get(c"dir")?;
        let session = fields(
            f,
            &[
                ("id", id),
                ("worktreePath", path),
                ("branch", task.get(c"branch")?),
            ],
        )?;
        let active = pick(o, &[c"activeCheck"])?;
        let merged = port(p, c"gitMergeBack", &[dir, session, active])?;
        let frame = fields(f, &[("f", f), ("session", session), ("active", active)])?;
        then(merged, frame, |c, a| {
            let f = c.get(c"f")?;
            let merged = a[0];
            if !merged.get(c"ok")?.truthy()? {
                let out = failed(f, "merge_failed")?;
                out.set(c"merge", merged)?;
                return Ok(out);
            }
            let dir = f.get(c"dir")?;
            let s = c.get(c"session")?;
            let options = fields(
                f,
                &[
                    ("sessionId", s.get(c"id")?),
                    ("activeCheck", c.get(c"active")?.get(c"activeCheck")?),
                    ("baseBranch", dir.get(c"baseBranch")?),
                    (
                        "force",
                        flag(f, f.get(c"options")?.get(c"force")?.is_true()?)?,
                    ),
                ],
            )?;
            let result = port(
                f.get(c"p")?,
                c"gitWorktreeRemove",
                &[
                    dir.get(c"path")?,
                    s.get(c"worktreePath")?,
                    s.get(c"branch")?,
                    options,
                ],
            )?;
            then(result, merged, |merge, a| {
                if !a[0].get(c"ok")?.truthy()? {
                    let out = failed(merge, "worktree_remove_refused")?;
                    out.set(c"merge", merge)?;
                    out.set(c"removal", a[0])?;
                    return Ok(out);
                }
                fields(
                    merge,
                    &[
                        ("ok", flag(merge, true)?),
                        ("removed", flag(merge, true)?),
                        ("merged", flag(merge, merge.get(c"merged")?.is_true()?)?),
                    ],
                )
            })
        })
    })
}
fn complete<'a>(f: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if a[0].optional(c"ok")?.truthy()? && a[0].get(c"removed")?.truthy()? {
        let p = f.get(c"p")?;
        let id = f.get(c"id")?;
        let expected = f.get(c"expected")?;
        let current = port(p, c"getBoardTask", &[id])?;
        if !current
            .optional(c"worktreePath")?
            .equals(expected.get(c"worktreePath")?)?
            || !current
                .optional(c"branch")?
                .equals(expected.get(c"branch")?)?
        {
            return failed(p, "workspace_changed");
        }
        port(
            p,
            c"updateTask",
            &[
                id,
                fields(p, &[("worktreePath", null(p)?), ("branch", null(p)?)])?,
            ],
        )?;
    }
    Ok(a[0])
}
fn cleanup<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let id = id_key(a[0])?;
        let options = default_object(a[1])?;
        held(p, id, || {
            let task = port(p, c"getBoardTask", &[id])?;
            if !task.truthy()? {
                return failed(p, "task_not_found");
            }
            if !task.get(c"worktreePath")?.truthy()? || !task.get(c"branch")?.truthy()? {
                return fields(
                    p,
                    &[
                        ("ok", flag(p, true)?),
                        ("skipped", flag(p, true)?),
                        ("code", text(p, "worktree_not_found")?),
                    ],
                );
            }
            if let Some(result) = busy(p, id)? {
                return Ok(result);
            }
            let dir = directory(p, task)?;
            if !dir.truthy()? {
                return failed(p, "directory_not_found");
            }
            let expected = spread(task)?;
            let f = fields(
                p,
                &[
                    ("p", p),
                    ("id", id),
                    ("options", options),
                    ("expected", expected),
                    ("dir", dir),
                ],
            )?;
            let wrap = p.get(c"opts")?.get(c"withCleanup")?;
            if wrap.undefined()? {
                return then(removal(f, &mut [fields(f, &[])?])?, f, complete);
            }
            resolved(wrap.call_plain(&[
                expected,
                function(f, "remove", 0, 1, removal)?,
                function(f, "complete", 1, 1, complete)?,
            ])?)
        })
    })
}
fn service<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let input = default_object(a[0])?;
    let opts = pick(
        input,
        &[
            c"getBoardTask",
            c"updateTask",
            c"getDirectory",
            c"taskDirIdOf",
            c"gitWorktreeAdd",
            c"gitWorktreeRemove",
            c"gitMergeBack",
            c"existsSync",
            c"isTaskRunning",
            c"beginTaskOperation",
            c"withCleanup",
            c"logger",
        ],
    )?;
    let state = spread(p)?;
    state.set(c"opts", opts)?;
    for name in [
        "getBoardTask",
        "updateTask",
        "getDirectory",
        "taskDirIdOf",
        "gitWorktreeAdd",
        "gitWorktreeRemove",
        "gitMergeBack",
        "existsSync",
        "isTaskRunning",
        "beginTaskOperation",
    ] {
        let v = opts.get_key(text(p, name)?)?;
        if (name == "existsSync" && v.undefined()?)
            || (matches!(name, "isTaskRunning" | "beginTaskOperation") && v.nullish()?)
        {
            continue;
        }
        if !callable(v)? {
            let message = if matches!(name, "isTaskRunning" | "beginTaskOperation") {
                "port must be a function"
            } else {
                "port required"
            };
            return Err(p.type_error(&format!("[task-worktree] {name} {message}")));
        }
    }
    defaulted_methods(
        state,
        &[
            ("ensureForTask", 1, 1, ensure),
            ("info", 1, 1, info),
            ("mergeTask", 1, 1, merge_task),
            ("cleanupWorktree", 1, 2, cleanup),
        ],
    )?
    .freeze()
}
#[napi]
pub fn task_worktree_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = defaulted_methods(
        p,
        &[
            ("createTaskWorktreeService", 0, 1, service),
            ("taskWorktreeToken", 1, 1, |p, a| token(p, a[0])),
            ("slotOwnsWorktree", 1, 1, |p, a| {
                let rec = a[0];
                flag(
                    p,
                    rec.truthy()?
                        && rec.get(c"branch")?.equals(call(
                            text(p, "multicc/")?,
                            c"concat",
                            &[rec.get(c"id")?],
                        )?)?,
                )
            }),
            ("cleanupAfterPublication", 1, 1, |p, a| {
                async_result(p, || {
                    let input = a[0];
                    let dir = input.get(c"dirPath")?;
                    if !dir.truthy()? {
                        return failed(p, "directory_not_found");
                    }
                    let noop = function(p, "", 0, 0, |p, _| resolved(null(p)?))?;
                    let result = call(
                        input.get(c"repoActor")?,
                        c"run",
                        &[dir, text(p, "task-cleanup-after-publication")?, noop],
                    )?;
                    then(result, input, |p, _| {
                        p.get(c"cleanup")?.call_plain(&[p.get(c"taskId")?])
                    })
                })
            }),
        ],
    )?;
    api.set(c"WORKTREE_SUBDIR", text(p, ".multicc-worktrees")?)?;
    Ok(api.raw())
}
