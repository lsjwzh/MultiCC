// legacy fallback: package-local scheduled_tasks.json
// Recurring work enters the fixed task through the task-shell receipt protocol.
use super::*;
use multicc_core::recurring::Expression;
use napi_derive::napi;
use std::path::PathBuf;
pub(super) fn save(o: L<'_>) -> Result<()> {
    let operation = ports(o)?.get(c"atomicWriteJson")?.call_plain(&[
        ports(o)?.get(c"paths")?.get(c"scheduledTasksFile")?,
        o.get(c"tasks")?,
    ]);
    if let Err(e) = operation {
        let e = o.exception_value()?.unwrap_or(
            o.global()?
                .get(c"Error")?
                .construct(&[text(o, &e.reason)?])?,
        );
        logger(
            o,
            c"error",
            &[
                text(o, "[multicc/cron] save failed:")?,
                e.optional(c"message")?,
            ],
        )?;
    }
    Ok(())
}
fn load(o: L<'_>) -> Result<()> {
    let file = PathBuf::from(strval(
        ports(o)?.get(c"paths")?.get(c"scheduledTasksFile")?,
    )?);
    let legacy = PathBuf::from(strval(ports(o)?.get(c"legacyStore")?)?);
    let legacy_selected = !file.exists() && legacy.exists();
    let source = if legacy_selected { legacy } else { file };
    let tasks = std::fs::read(&source)
        .ok()
        .and_then(|b| multicc_core::js::json_parse(&String::from_utf8_lossy(&b)).ok())
        .filter(|v| matches!(v, V::Array(_)))
        .unwrap_or(V::Array(vec![]));
    o.set(c"tasks", o.from_value(&tasks)?)?;
    if legacy_selected {
        save(o)?;
    }
    Ok(())
}
fn stop(o: L<'_>) -> Result<L<'_>> {
    let timer = o.get(c"timer")?;
    if timer.truthy()? {
        o.global()?.get(c"clearInterval")?.call_plain(&[timer])?;
        o.set(c"timer", null(o)?)?;
    }
    undefined(o)
}
fn tick_loop(f: L<'_>) -> Result<L<'_>> {
    let tasks = f.get(c"tasks")?;
    let mut i = f.get(c"index")?.number()? as u32;
    while i < tasks.get(c"length")?.number()? as u32 {
        let t = tasks.element(i)?;
        i += 1;
        f.set(c"index", num(f, i as f64)?)?;
        if !t.get(c"enabled")?.truthy()? {
            continue;
        }
        let Some(expr) = Expression::parse(&strval(t.get(c"cron")?)?) else {
            continue;
        };
        if t.get(c"_tickKey")?.equals(f.get(c"key")?)? {
            continue;
        }
        let date = f.get(c"date")?;
        let mut values = [0; 5];
        for (i, k) in [
            c"getMinutes",
            c"getHours",
            c"getDate",
            c"getMonth",
            c"getDay",
        ]
        .into_iter()
        .enumerate()
        {
            values[i] = call(date, k, &[])?.number()? as u32;
        }
        values[3] += 1;
        if expr.matches(values) {
            t.assign(c"_tickKey", f.get(c"key")?)?;
            return then(
                fire(root(f)?, t, text(f, "schedule")?, f.get(c"key")?)?,
                f,
                |f, _| tick_loop(f),
            );
        }
    }
    undefined(f)
}
fn tick(o: L<'_>) -> Result<L<'_>> {
    then(o.get(c"migration")?, o, |o, _| {
        let date = o.global()?.get(c"Date")?.construct(&[])?;
        let mut key = String::new();
        for k in [
            c"getFullYear",
            c"getMonth",
            c"getDate",
            c"getHours",
            c"getMinutes",
        ] {
            key.push_str(&strval(call(date, k, &[])?)?);
        }
        tick_loop(fields(
            o,
            &[
                ("owner", o),
                ("date", date),
                ("key", text(o, &key)?),
                ("tasks", o.get(c"tasks")?),
                ("index", num(o, 0.)?),
            ],
        )?)
    })
}
fn finalized(f: L<'_>) -> Result<L<'_>> {
    let o = root(f)?;
    let t = f.get(c"task")?;
    let binding = f.get(c"binding")?;
    let result = f.get(c"result")?;
    let script = t.get(c"kind")?.is_string("script")?;
    t.assign(c"lastRunAt", f.get(c"at")?)?;
    if binding.optional(c"sessionId")?.truthy()? || result.optional(c"sessionId")?.truthy()? {
        t.assign(
            c"taskSessionId",
            either(result.optional(c"sessionId")?, binding.get(c"sessionId")?)?,
        )?;
        t.assign(c"lastSessionId", t.get(c"taskSessionId")?)?;
    }
    t.assign(c"runCount", plus_one(t.get(c"runCount")?)?)?;
    let ok = result.optional(c"ok")?.is_true()?;
    let row = fields(
        f,
        &[
            ("at", f.get(c"at")?),
            (
                "reason",
                text(
                    f,
                    if f.get(c"reason")?.is_string("manual")? {
                        "manual"
                    } else {
                        "schedule"
                    },
                )?,
            ),
            ("status", either(t.get(c"lastStatus")?, text(f, "error")?)?),
            ("decision", either(result.optional(c"decision")?, null(f)?)?),
            (
                "taskId",
                either(
                    t.get(c"taskId")?,
                    either(binding.optional(c"taskId")?, null(f)?)?,
                )?,
            ),
            (
                "sessionId",
                either(
                    t.get(c"taskSessionId")?,
                    either(
                        result.optional(c"sessionId")?,
                        either(binding.optional(c"sessionId")?, null(f)?)?,
                    )?,
                )?,
            ),
            (
                "receiptId",
                either(result.optional(c"receiptId")?, null(f)?)?,
            ),
            (
                "error",
                if ok {
                    text(f, "")?
                } else if t.get(c"lastError")?.truthy()? {
                    slice(string(t.get(c"lastError")?)?, 0., Some(200.))?
                } else {
                    text(f, "")?
                },
            ),
        ],
    )?;
    if script {
        let exit = t.get(c"lastExitCode")?;
        if !exit.nullish()? {
            row.set(c"exitCode", num(f, exit.explicit_number()?)?)?;
        }
        let output = t.get(c"lastOutput")?;
        if output.truthy()? {
            row.set(c"output", slice(string(output)?, 0., Some(2000.))?)?;
        }
    }
    let runs = t.get(c"runs")?;
    let runs = if runs.is_array()? { runs } else { array(f)? };
    append(runs, row)?;
    let count = runs.get(c"length")?.number()?;
    if count > 20. {
        call(runs, c"splice", &[num(f, 0.)?, num(f, count - 20.)?])?;
    }
    t.assign(c"runs", runs)?;
    save(o)?;
    let destination = if script {
        format!(
            "脚本退出码 {}",
            if t.get(c"lastExitCode")?.nullish()? {
                "?".into()
            } else {
                strval(t.get(c"lastExitCode")?)?
            }
        )
    } else {
        format!(
            "Air task {}",
            strval(either(t.get(c"taskId")?, text(f, "unbound")?)?)?
        )
    };
    logger(
        o,
        c"log",
        &[text(
            f,
            &format!(
                "[multicc/cron] fired {} ({}) [{}] → {destination}, {}",
                strval(t.get(c"id")?)?,
                strval(t.get(c"name")?)?,
                strval(f.get(c"reason")?)?,
                strval(if ok {
                    t.get(c"lastStatus")?
                } else {
                    t.get(c"lastError")?
                })?
            ),
        )?],
    )?;
    fields(
        f,
        &[
            ("ok", flag(f, ok)?),
            ("taskId", either(t.get(c"taskId")?, null(f)?)?),
            ("sessionId", either(t.get(c"taskSessionId")?, null(f)?)?),
            (
                "receiptId",
                either(result.optional(c"receiptId")?, null(f)?)?,
            ),
            ("decision", either(result.optional(c"decision")?, null(f)?)?),
            (
                "exitCode",
                if script && !t.get(c"lastExitCode")?.nullish()? {
                    t.get(c"lastExitCode")?
                } else {
                    null(f)?
                },
            ),
            ("error", if ok { null(f)? } else { t.get(c"lastError")? }),
        ],
    )
}
fn script_result<'a>(f: L<'a>, raw: L<'a>) -> Result<L<'a>> {
    let run = if raw.kind()? == sys::ValueType::napi_string {
        json_parse(f, &strval(raw)?)?
    } else {
        raw
    };
    let t = f.get(c"task")?;
    let code = run.get(c"code")?;
    let out = run.get(c"output")?;
    if code.is_number(0.)? {
        t.assign(c"lastStatus", text(f, "ok")?)?;
        t.assign(c"lastExitCode", num(f, 0.)?)?;
        t.assign(c"lastError", text(f, "")?)?;
        f.set(
            c"result",
            fields(
                f,
                &[
                    ("ok", flag(f, true)?),
                    ("exitCode", num(f, 0.)?),
                    ("output", out),
                ],
            )?,
        )?;
    } else {
        t.assign(c"lastStatus", text(f, "error")?)?;
        t.assign(c"lastExitCode", code)?;
        let head = if run.get(c"timedOut")?.truthy()? {
            "脚本超时".into()
        } else {
            format!("脚本退出码 {}", strval(code)?)
        };
        let error = if out.truthy()? {
            let joined = text(f, &format!("{head}："))?;
            call(joined, c"concat", &[slice(out, 0., Some(120.))?])?
        } else {
            text(f, &head)?
        };
        t.assign(c"lastError", error)?;
    }
    t.assign(c"lastOutput", out)?;
    super::binding::clear(t)?;
    undefined(f)
}
fn delivered<'a>(f: L<'a>, result: L<'a>) -> Result<L<'a>> {
    f.set(c"result", result)?;
    if !result.optional(c"ok")?.truthy()? {
        let e = f.global()?.get(c"Error")?.construct(&[either(
            result.optional(c"error")?,
            either(result.optional(c"code")?, text(f, "任务入队失败")?)?,
        )?])?;
        e.set(
            c"code",
            either(result.optional(c"code")?, text(f, "task_delivery_failed")?)?,
        )?;
        return Err(e.throw_error());
    }
    let t = f.get(c"task")?;
    t.assign(c"lastError", text(f, "")?)?;
    super::binding::clear(t)?;
    t.assign(
        c"lastStatus",
        text(
            f,
            if result.get(c"decision")?.is_string("queued")? {
                "queued"
            } else {
                "ok"
            },
        )?,
    )?;
    t.assign(
        c"lastReceiptId",
        either(result.get(c"receiptId")?, null(f)?)?,
    )?;
    t.assign(
        c"lastDecision",
        either(result.get(c"decision")?, text(f, "continue")?)?,
    )?;
    undefined(f)
}
pub(super) fn fire<'a>(o: L<'a>, t: L<'a>, reason: L<'a>, key: L<'a>) -> Result<L<'a>> {
    let f = fields(
        o,
        &[
            ("owner", o),
            ("task", t),
            ("reason", reason),
            ("key", key),
            ("at", now(o)?),
            ("binding", null(o)?),
            ("result", null(o)?),
        ],
    )?;
    let pipeline = async_result(o, || {
        let script = t.get(c"kind")?.is_string("script")?;
        if script && !callable(deps(o)?.get(c"directories")?.optional(c"get")?)? {
            return Err(failure(
                o,
                "task_service_unavailable",
                "脚本任务目录服务尚未就绪",
            )?);
        }
        if !script && !callable(deps(o)?.get(c"sendTaskMessage")?)? {
            return Err(failure(
                o,
                "task_service_unavailable",
                "Air 任务入口尚未就绪",
            )?);
        }
        then(super::binding::ensure(o, t)?, f, |f, binding| {
            f.set(c"binding", binding)?;
            let o = root(f)?;
            let t = f.get(c"task")?;
            if t.get(c"kind")?.is_string("script")? {
                let direct = binding.get(c"dir")?;
                let dir = if direct.truthy()? {
                    direct
                } else {
                    call(deps(o)?.get(c"directories")?, c"get", &[t.get(c"dirId")?])?
                };
                let command = call(
                    string(either(t.get(c"command")?, text(f, "")?)?)?,
                    c"trim",
                    &[],
                )?;
                let timeout = either(t.get(c"scriptTimeoutMs")?, num(f, 120000.)?)?;
                let injected = ports(o)?.get(c"executeScript")?;
                let pending = if callable(injected)? {
                    injected.call_plain(&[
                        command,
                        either(dir.optional(c"path")?, undefined(f)?)?,
                        timeout,
                    ])?
                } else {
                    script_io(
                        o,
                        command,
                        either(dir.optional(c"path")?, undefined(f)?)?,
                        timeout,
                    )?
                };
                then(pending, f, script_result)
            } else {
                let key = if f.get(c"key")?.truthy()? {
                    f.get(c"key")?
                } else if f.get(c"reason")?.is_string("manual")? {
                    ports(o)?.get(c"randomUUID")?.call_plain(&[])?
                } else {
                    string(f.get(c"at")?)?
                };
                let id = super::binding::client(
                    f,
                    &[text(f, "cron-run")?, t.get(c"id")?, f.get(c"reason")?, key],
                )?;
                let opts = fields(
                    f,
                    &[
                        ("clientMsgId", id),
                        ("source", text(f, "cron")?),
                        ("taskText", t.get(c"name")?),
                    ],
                )?;
                then(
                    invoke(
                        deps(o)?,
                        c"sendTaskMessage",
                        &[binding.get(c"taskId")?, t.get(c"prompt")?, opts],
                    )?,
                    f,
                    delivered,
                )
            }
        })
    })?;
    let pipeline = caught(pipeline, f, |f, e| {
        let t = f.get(c"task")?;
        t.assign(c"lastStatus", text(f, "error")?)?;
        t.assign(
            c"lastError",
            either(
                e.optional(c"message")?,
                either(e.optional(c"code")?, text(f, "任务执行失败")?)?,
            )?,
        )?;
        if !t.get(c"kind")?.is_string("script")? {
            if !t.get(c"taskId")?.truthy()? {
                t.assign(c"taskBindingError", t.get(c"lastError")?)?;
            } else if super::binding::is_break(e)? {
                super::binding::broken(root(f)?, t, e)?;
            }
        }
        undefined(f)
    })?;
    then(pipeline, f, |f, _| finalized(f))
}
fn cleanup_run<'a>(o: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let d = deps(o)?;
    let board = call(d, c"taskBoard", &[])?;
    if !board.truthy()? || !callable(board.get(c"getBoard")?)? {
        return null(o);
    }
    let board_state = call(board, c"getBoard", &[])?;
    let tasks = call(
        o.global()?.get(c"Object")?,
        c"values",
        &[either(board_state.optional(c"tasks")?, fields(o, &[])?)?],
    )?;
    let f = fields(o, &[("board", board)])?;
    let options = fields(
        o,
        &[
            ("dataDir", ports(o)?.get(c"paths")?.get(c"root")?),
            (
                "markerFile",
                ports(o)?.get(c"paths")?.get(c"cronFanoutMigrationFile")?,
            ),
            ("pkgRoot", ports(o)?.get(c"paths")?.get(c"pkgRoot")?),
            ("version", ports(o)?.get(c"version")?),
            ("tasks", tasks),
            ("rules", o.get(c"tasks")?),
            (
                "archiveTasks",
                function(f, "", 1, 1, |f, a| {
                    call(f.get(c"board")?, c"archiveTasks", &[a[0]])
                })?,
            ),
            ("fromVersion", d.get(c"fromVersion")?),
            ("versionSource", d.get(c"versionSource")?),
            ("logger", o.get(c"logger")?),
        ],
    )?;
    invoke(ports(o)?.get(c"fanout")?, c"run", &[options])
}
fn cleanup(o: L<'_>) -> Result<L<'_>> {
    let current = o.get(c"fanoutCleanup")?;
    if current.truthy()? {
        return Ok(current);
    }
    let pending = async_result(o, || {
        if !deps(o)?.truthy()? || !callable(deps(o)?.get(c"taskBoard")?)? {
            return null(o);
        }
        then(deps(o)?.get(c"ready")?, o, |o, _| {
            then(o.get(c"migration")?, o, cleanup_run)
        })
    })?;
    let pending = caught(pending, o, |o, e| {
        logger(
            o,
            c"error",
            &[
                text(o, "[multicc/cron] fan-out cleanup failed:")?,
                message(e)?,
            ],
        )?;
        null(o)
    })?;
    o.set(c"fanoutCleanup", pending)?;
    Ok(pending)
}
fn init<'a>(o: L<'a>, injected: L<'a>) -> Result<L<'a>> {
    o.set(c"deps", injected)?;
    load(o)?;
    let migration = caught(super::binding::migrate(o)?, o, |o, e| {
        logger(
            o,
            c"error",
            &[
                text(o, "[multicc/cron] Air task migration failed:")?,
                e.optional(c"message")?,
            ],
        )?;
        fields(
            o,
            &[
                ("migrated", num(o, 0.)?),
                (
                    "errors",
                    o.from_value(&V::Array(vec![V::object(vec![(
                        "error",
                        value(e.optional(c"message")?)?,
                    )])]))?,
                ),
            ],
        )
    })?;
    o.set(c"migration", migration)?;
    cleanup(o)?;
    stop(o)?;
    let callback = function(o, "", 0, 0, |o, _| async_result(o, || tick(o)))?;
    let timer = o
        .global()?
        .get(c"setInterval")?
        .call_plain(&[callback, num(o, 30000.)?])?;
    o.set(c"timer", timer)?;
    if timer.get(c"unref")?.truthy()? {
        call(timer, c"unref", &[])?;
    }
    logger(
        o,
        c"log",
        &[text(
            o,
            &format!(
                "[multicc/cron] scheduler started, {} task(s) loaded",
                strval(o.get(c"tasks")?.get(c"length")?)?
            ),
        )?],
    )?;
    undefined(o)
}
fn sessions(o: L<'_>) -> Result<L<'_>> {
    let ids = o.global()?.get(c"Set")?.construct(&[])?;
    o.get(c"tasks")?.for_each(|t| {
        if t.get(c"kind")?.is_string("script")? {
            return Ok(());
        }
        let id = either(t.get(c"taskSessionId")?, t.get(c"lastSessionId")?)?;
        if id.truthy()? {
            call(ids, c"add", &[id])?;
        }
        Ok(())
    })?;
    call(o.global()?.get(c"Array")?, c"from", &[ids])
}
#[napi]
pub fn cron_tasks_api(env: Env, host: Unknown<'_>) -> Result<sys::napi_value> {
    let host = L::new(&env, host);
    let o = fields(
        host,
        &[
            ("ports", host),
            ("logger", host.get(c"logger")?),
            ("tasks", array(host)?),
            ("deps", null(host)?),
            ("migration", null(host)?),
            ("fanoutCleanup", null(host)?),
            ("timer", null(host)?),
            ("bindingFlights", map(host)?),
        ],
    )?;
    let api = fields(o, &[])?;
    for (name, length, count) in [
        ("init", 1, 1),
        ("stop", 0, 0),
        ("mount", 1, 1),
        ("sessionIds", 0, 0),
        ("cronValidate", 1, 1),
        ("cronNext", 2, 2),
        ("_fireTask", 2, 3),
        ("_ensureTask", 1, 1),
        ("_rebindTask", 1, 2),
        ("_migrateTasks", 0, 0),
        ("_runFanoutCleanup", 0, 0),
        ("_recentRuns", 1, 3),
    ] {
        api.set_key(
            text(o, name)?,
            function(o, name, length, count, move |o, a| match name {
                "init" => init(o, a[0]),
                "stop" => stop(o),
                "mount" => super::routes::mount(o, a[0]),
                "sessionIds" => sessions(o),
                "cronValidate" => flag(o, super::view::valid(a[0])?),
                "cronNext" => super::view::next(o, a[0], a[1]),
                "_fireTask" => async_result(o, || fire(o, a[0], a[1], a[2])),
                "_ensureTask" => async_result(o, || super::binding::ensure(o, a[0])),
                "_rebindTask" => async_result(o, || super::binding::rebind(o, a[0], a[1])),
                "_migrateTasks" => async_result(o, || super::binding::migrate(o)),
                "_runFanoutCleanup" => cleanup(o),
                "_recentRuns" => super::view::recent(o, a[0], a[1], a[2]),
                _ => unreachable!(),
            })?,
        )?;
    }
    api.set(c"RUN_HISTORY_LIMIT", num(o, 20.)?)?;
    api.set(c"RUN_HISTORY_VIEW", num(o, 10.)?)?;
    Ok(api.raw())
}

// exec is an IO port only. In particular its SIGTERM/stdio-close semantics and
// Windows shell setup remain Node-compatible; no JS callback contains policy.
fn script_io<'a>(o: L<'a>, command: L<'a>, cwd: L<'a>, timeout: L<'a>) -> Result<L<'a>> {
    let f = fields(
        o,
        &[
            ("owner", o),
            ("command", command),
            ("cwd", cwd),
            ("timeout", timeout),
        ],
    )?;
    let executor = function(f, "", 2, 2, |f, a| {
        f.set(c"resolve", a[0])?;
        let done = function(f, "", 3, 3, |f, a| {
            let err = a[0];
            let code = if err.truthy()? {
                let code = err.get(c"code")?;
                if code.kind()? == sys::ValueType::napi_number {
                    code
                } else {
                    num(f, 1.)?
                }
            } else {
                num(f, 0.)?
            };
            let output = array(f)?;
            for v in [a[1], a[2]] {
                if v.truthy()? {
                    append(output, v)?;
                }
            }
            let output = call(call(output, c"join", &[text(f, "\n")?])?, c"trim", &[])?;
            let result = fields(
                f,
                &[
                    ("code", code),
                    ("output", output),
                    (
                        "timedOut",
                        flag(f, err.truthy()? && err.get(c"killed")?.truthy()?)?,
                    ),
                ],
            )?;
            f.get(c"resolve")?.call_plain(&[result])
        })?;
        let o = root(f)?;
        let options = fields(
            f,
            &[
                ("cwd", f.get(c"cwd")?),
                ("timeout", f.get(c"timeout")?),
                ("maxBuffer", num(f, 4. * 1024. * 1024.)?),
                ("windowsHide", flag(f, true)?),
                ("env", spread(ports(o)?.get(c"env")?)?),
            ],
        )?;
        ports(o)?
            .get(c"exec")?
            .call_plain(&[f.get(c"command")?, options, done])?;
        undefined(f)
    })?;
    f.global()?.get(c"Promise")?.construct(&[executor])
}
