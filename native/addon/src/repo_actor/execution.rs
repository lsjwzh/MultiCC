use super::*;

fn frame_key(s: L<'_>) -> Result<L<'_>> {
    call(
        s.global()?.get(c"Symbol")?,
        c"for",
        &[text(s, "multicc.repoActor.taskFrame")?],
    )
}

fn progress<'e>(f: L<'e>, phase: L<'e>, detail: L<'e>) -> Result<L<'e>> {
    let detail = if detail.undefined()? {
        null(f)?
    } else {
        detail
    };
    let event = fields(
        f,
        &[
            ("phase", phase),
            ("detail", detail),
            ("ts", now(f)?),
            ("queueDepth", f.get(c"queue")?.get(c"depth")?),
        ],
    )?;
    let history = f.get(c"op")?.get(c"progress")?;
    call(history, c"push", &[event])?;
    if history.get(c"length")?.number()? > 100. {
        call(history, c"shift", &[])?;
    }
    let opts = f.get(c"options")?;
    if opts.get(c"onProgress")?.kind()? == sys::ValueType::napi_function {
        let notification = fields(f, &[("operationId", f.get(c"id")?)])?;
        notification.spread_from(event)?;
        call(opts, c"onProgress", &[notification])?;
    }
    undef(f)
}

fn git<'e>(f: L<'e>, cwd: L<'e>, args: L<'e>, options: L<'e>) -> Result<L<'e>> {
    async_result(f, || {
        let opts = default_object(options)?;
        let argv = call(f.global()?.get(c"Array")?, c"from", &[args])?;
        progress(
            f,
            text(f, "git")?,
            fields(f, &[("cwd", cwd), ("args", argv)])?,
        )?;
        let request = async_result(f, || {
            let actor = f.get(c"actor")?;
            let host = ports(actor)?;
            let environment = spread(host.get(c"environment")?)?;
            environment.set(c"PATH", host.get(c"process")?.get(c"env")?.get(c"PATH")?)?;
            environment.spread_from(opts.get(c"env")?)?;
            let config = fields(
                f,
                &[
                    ("windowsHide", flag(f, true)?),
                    ("cwd", cwd),
                    ("encoding", text(f, "utf8")?),
                    (
                        "timeout",
                        fallback(opts.get(c"timeout")?, V::Number(TIMEOUT))?,
                    ),
                    (
                        "maxBuffer",
                        fallback(opts.get(c"maxBuffer")?, V::Number(MAX_BUFFER))?,
                    ),
                    ("killSignal", text(f, "SIGKILL")?),
                    ("env", environment),
                ],
            )?;
            call(actor, c"execFile", &[text(f, "git")?, args, config])
        })?;
        let output = function(opts, "gitOutput", 1, 1, |opts, a| {
            let stdout = string(fallback(a[0].get(c"stdout")?, V::from(""))?)?;
            if opts.get(c"raw")?.is_true()? {
                Ok(stdout)
            } else {
                call(stdout, c"trim", &[])
            }
        })?;
        let failure = function(f, "gitFailure", 1, 1, |_, a| {
            let error = a[0];
            if error.truthy()? && !error.get(c"stderr")?.nullish()? {
                error.assign(c"stderr", string(error.get(c"stderr")?)?)?;
            }
            Err(error.throw_error())
        })?;
        call(call(request, c"then", &[output])?, c"catch", &[failure])
    })
}

pub(crate) fn exec_context_git<'e>(
    task_ctx: L<'e>,
    cwd: L<'e>,
    args: L<'e>,
    options: L<'e>,
) -> Result<L<'e>> {
    let frame = task_ctx.get_key(frame_key(task_ctx)?)?;
    if frame.undefined()? {
        return task_ctx.get(c"execGit")?.call_plain(&[cwd, args, options]);
    }
    git(frame, cwd, args, options)
}

pub(crate) fn context_progress<'e>(task_ctx: L<'e>, phase: L<'e>, detail: L<'e>) -> Result<L<'e>> {
    let frame = task_ctx.get_key(frame_key(task_ctx)?)?;
    if frame.undefined()? {
        return task_ctx.get(c"progress")?.call_plain(&[phase, detail]);
    }
    progress(frame, phase, detail)
}

fn leased<'e>(f: L<'e>, sid: L<'e>) -> Result<()> {
    let held = lease(f.get(c"actor")?, sid)?;
    if !held.truthy()? {
        return Ok(());
    }
    let msg = call(
        text(f, "session/worktree is leased by ")?,
        c"concat",
        &[held.get(c"operationId")?],
    )?;
    let err = f.global()?.get(c"Error")?.construct(&[msg])?;
    err.set(c"code", text(f, "SESSION_LEASED")?)?;
    Err(err.throw_error())
}

fn invoke_task(f: L<'_>) -> Result<L<'_>> {
    let op = f.get(c"op")?;
    let id = f.get(c"id")?;
    let sid = op.get(c"sessionId")?;
    if sid.truthy()? {
        // An asynchronous active check can let a different repository acquire
        // the same session lease. Check again at the actual insertion point.
        leased(f, sid)?;
        let record = fields(
            f,
            &[
                ("operationId", id),
                ("kind", op.get(c"kind")?),
                ("acquiredAt", now(f)?),
            ],
        )?;
        call(f.get(c"actor")?.get(c"leases")?, c"set", &[sid, record])?;
        f.set(c"leased", flag(f, true)?)?;
    }
    progress(f, text(f, "started")?, null(f)?)?;
    let ctx = fields(
        f,
        &[
            ("operationId", id),
            ("repoKey", f.get(c"repoKey")?),
            (
                "progress",
                function(f, "progress", 1, 2, |f, a| progress(f, a[0], a[1]))?,
            ),
            (
                "execGit",
                function(f, "execGit", 2, 3, |f, a| git(f, a[0], a[1], a[2]))?,
            ),
            (
                "queueDepth",
                function(f, "queueDepth", 0, 0, |f, _| f.get(c"queue")?.get(c"depth"))?,
            ),
        ],
    )?;
    call(
        f.global()?.get(c"Object")?,
        c"defineProperty",
        &[ctx, frame_key(ctx)?, fields(f, &[("value", f)])?],
    )?;
    f.get(c"task")?.call_plain(&[ctx])
}

fn start(f: L<'_>) -> Result<L<'_>> {
    let sid = f.get(c"op")?.get(c"sessionId")?;
    let opts = f.get(c"options")?;
    if sid.truthy()? {
        leased(f, sid)?;
        if opts.get(c"activeCheck")?.truthy()? {
            let checked = resolved(call(opts, c"activeCheck", &[])?)?;
            return call(
                checked,
                c"then",
                &[function(f, "afterRepoActiveCheck", 1, 1, |f, a| {
                    if a[0].truthy()? {
                        let error = f
                            .global()?
                            .get(c"Error")?
                            .construct(&[text(f, "session/worktree is active")?])?;
                        error.set(c"code", text(f, "SESSION_ACTIVE")?)?;
                        return Err(error.throw_error());
                    }
                    invoke_task(f)
                })?],
            );
        }
    }
    invoke_task(f)
}

fn complete<'e>(f: L<'e>, value: L<'e>) -> Result<L<'e>> {
    f.get(c"op")?.set(c"status", text(f, "completed")?)?;
    progress(f, text(f, "completed")?, null(f)?)?;
    let out = if value.kind()? == sys::ValueType::napi_object && !value.nullish()? {
        spread(value)?
    } else {
        fields(f, &[("ok", flag(f, true)?), ("value", value)])?
    };
    out.set(c"operationId", f.get(c"id")?)?;
    out.set(c"queueDepth", f.get(c"queuedDepth")?)?;
    Ok(out)
}

fn fail<'e>(f: L<'e>, error: L<'e>) -> Result<L<'e>> {
    let op = f.get(c"op")?;
    op.set(c"status", text(f, "failed")?)?;
    let message = error.optional(c"message")?;
    let message = if message.truthy()? {
        message
    } else {
        string(error)?
    };
    op.set(c"error", message)?;
    progress(f, text(f, "failed")?, fields(f, &[("error", message)])?)?;
    error.assign(c"operationId", f.get(c"id")?)?;
    error.assign(c"queueDepth", f.get(c"queuedDepth")?)?;
    Err(error.throw_error())
}

fn release(f: L<'_>) -> Result<L<'_>> {
    let op = f.get(c"op")?;
    let queue = f.get(c"queue")?;
    let id = f.get(c"id")?;
    op.set(c"finishedAt", now(f)?)?;
    if queue.get(c"running")?.equals(id)? {
        queue.set(c"running", null(f)?)?;
    }
    if f.get(c"leased")?.truthy()? {
        let sid = op.get(c"sessionId")?;
        let leases = f.get(c"actor")?.get(c"leases")?;
        if call(leases, c"get", &[sid])?
            .optional(c"operationId")?
            .equals(id)?
        {
            call(leases, c"delete", &[sid])?;
        }
    }
    undef(f)
}

fn execute(f: L<'_>) -> Result<L<'_>> {
    let op = f.get(c"op")?;
    let queue = f.get(c"queue")?;
    op.set(c"status", text(f, "running")?)?;
    op.set(c"startedAt", now(f)?)?;
    op.set(c"queueDepth", queue.get(c"depth")?)?;
    queue.set(c"running", f.get(c"id")?)?;
    let pending = async_result(f, || start(f))?;
    let finished = call(
        pending,
        c"then",
        &[function(f, "completeRepoOperation", 1, 1, |f, a| {
            complete(f, a[0])
        })?],
    )?;
    let handled = call(
        finished,
        c"catch",
        &[function(f, "failRepoOperation", 1, 1, |f, a| {
            fail(f, a[0])
        })?],
    )?;
    call(
        handled,
        c"finally",
        &[function(f, "releaseRepoLease", 0, 0, |f, _| release(f))?],
    )
}

fn cleanup(f: L<'_>) -> Result<L<'_>> {
    let q = f.get(c"queue")?;
    let depth = q.get(c"depth")?.number()? - 1.;
    q.set(c"depth", num(f, depth)?)?;
    if depth == 0. && !q.get(c"running")?.truthy()? {
        call(
            f.get(c"actor")?.get(c"queues")?,
            c"delete",
            &[f.get(c"repoKey")?],
        )?;
    }
    undef(f)
}

pub(crate) fn run<'e>(
    actor: L<'e>,
    input: L<'e>,
    kind: L<'e>,
    task: L<'e>,
    options: L<'e>,
) -> Result<L<'e>> {
    async_result(actor, || {
        let h = ports(actor)?;
        let options = default_object(options)?;
        let mut key = options.get(c"repoKey")?;
        if !key.truthy()? {
            key = repository::key(h, input)?;
        }
        let q = queue(actor, key)?;
        let mut id = options.get(c"operationId")?;
        if !id.truthy()? {
            id = repository::id(h, fallback(kind, V::from("repo"))?)?;
        }
        let depth = num(actor, q.get(c"depth")?.number()? + 1.)?;
        let op = fields(
            actor,
            &[
                ("operationId", id),
                ("kind", fallback(kind, V::from("git"))?),
                ("repoKey", key),
                ("sessionId", fallback(options.get(c"sessionId")?, V::Null)?),
                ("status", text(actor, "queued")?),
                ("queueDepth", depth),
                ("createdAt", now(actor)?),
                ("startedAt", null(actor)?),
                ("finishedAt", null(actor)?),
                ("progress", actor.from_value(&V::Array(vec![]))?),
            ],
        )?;
        call(actor.get(c"operations")?, c"set", &[id, op])?;
        trim(actor)?;
        q.set(c"depth", depth)?;
        let f = fields(
            actor,
            &[
                ("actor", actor),
                ("queue", q),
                ("id", id),
                ("repoKey", key),
                ("options", options),
                ("task", task),
                ("op", op),
                ("queuedDepth", depth),
                ("leased", flag(actor, false)?),
            ],
        )?;
        let dispatch = function(f, "executeRepoOperation", 0, 0, |f, _| execute(f))?;
        let result = call(q.get(c"tail")?, c"then", &[dispatch, dispatch])?;
        let discard = function(f, "discardRepoResult", 0, 0, |s, _| undef(s))?;
        let handled = call(result, c"then", &[discard, discard])?;
        let tail = call(
            handled,
            c"finally",
            &[function(f, "releaseRepoQueue", 0, 0, |f, _| cleanup(f))?],
        )?;
        q.set(c"tail", tail)?;
        Ok(result)
    })
}

pub(crate) fn run_git<'e>(actor: L<'e>, cwd: L<'e>, args: L<'e>, opts: L<'e>) -> Result<L<'e>> {
    let opts = default_object(opts)?;
    let kind = fallback(opts.get(c"kind")?, V::from("git"))?;
    let custom = !uses_default_run(actor)?;
    let frame = fields(
        actor,
        &[
            ("cwd", cwd),
            ("args", args),
            ("opts", opts),
            ("custom", flag(actor, custom)?),
        ],
    )?;
    let task = function(frame, "runGitTask", 1, 1, |f, a| {
        let (cwd, args, opts) = (f.get(c"cwd")?, f.get(c"args")?, f.get(c"opts")?);
        let request = if f.get(c"custom")?.truthy()? {
            resolved(a[0].get(c"execGit")?.call_plain(&[cwd, args, opts])?)?
        } else {
            exec_context_git(a[0], cwd, args, opts)?
        };
        call(
            request,
            c"then",
            &[function(f, "wrapGitOutput", 1, 1, |f, a| {
                fields(f, &[("ok", flag(f, true)?), ("stdout", a[0])])
            })?],
        )
    })?;
    let result = if custom {
        call(actor, c"run", &[cwd, kind, task, opts])?
    } else {
        run(actor, cwd, kind, task, opts)?
    };
    call(
        result,
        c"then",
        &[function(opts, "readGitResult", 1, 1, |opts, a| {
            if opts.get(c"withMetadata")?.truthy()? {
                Ok(a[0])
            } else {
                a[0].get(c"stdout")
            }
        })?],
    )
}
