//! The four captured memory handlers share the live record and folder owners.
use crate::host_methods::function;
use crate::route_response::*;
use napi_derive::napi;
use std::ffi::CStr;

fn callable(value: L<'_>, key: &CStr) -> Result<bool> {
    Ok(value.optional(key)?.kind()? == sys::ValueType::napi_function)
}

fn validate(deps: L<'_>) -> Result<()> {
    if !deps.truthy()? || deps.kind()? != sys::ValueType::napi_object {
        return Err(deps.type_error("[session-memory] dependencies are required"));
    }
    if !deps.get(c"fs")?.truthy()? || !deps.get(c"path")?.truthy()? {
        return Err(deps.type_error("[session-memory] filesystem dependencies are required"));
    }
    if !callable(deps.get(c"records")?, c"get")? {
        return Err(deps.type_error("[session-memory] records.get is required"));
    }
    let folder = deps.get(c"folderMemory")?;
    for name in [
        c"ensureDirs",
        c"sessionDir",
        c"sharedDir",
        c"primaryFileName",
        c"listFiles",
        c"safeFileName",
        c"scopeDir",
        c"curatedLimit",
        c"safeSegment",
    ] {
        if !callable(folder, name)? {
            return Err(deps.type_error(&format!(
                "[session-memory] folderMemory.{} is required",
                name.to_string_lossy()
            )));
        }
    }
    for name in [
        c"getMemoryEntries",
        c"scanMemoryContent",
        c"atomicWriteMemoryFile",
        c"applyCuratedMemoryAction",
        c"appendEvent",
        c"workspaceBroadcast",
        c"directoriesKeys",
    ] {
        if !callable(deps, name)? {
            return Err(deps.type_error(&format!(
                "[session-memory] {} is required",
                name.to_string_lossy()
            )));
        }
    }
    Ok(())
}

#[napi]
pub fn assert_session_memory_dependencies(env: Env, deps: Unknown<'_>) -> Result<sys::napi_value> {
    let deps = L::new(&env, deps);
    validate(deps)?;
    Ok(deps.raw())
}

#[derive(Clone, Copy)]
enum Route {
    Read,
    Write,
    Delete,
    Curate,
}

#[napi]
pub fn mount_session_memory_routes(env: Env, app: Unknown<'_>, deps: Unknown<'_>) -> Result<()> {
    let app = L::new(&env, app);
    let deps = L::new(&env, deps);
    let routes = [
        (c"get", Route::Read),
        (c"put", Route::Write),
        (c"delete", Route::Delete),
        (c"post", Route::Curate),
    ];
    for (key, _) in routes {
        if !callable(app, key)? {
            return Err(app.type_error("[session-memory] Express app is required"));
        }
    }
    validate(deps)?;
    let owner = fields(
        deps,
        &[("deps", deps), ("folder", deps.get(c"folderMemory")?)],
    )?;
    for (key, route) in routes {
        let path = if matches!(route, Route::Curate) {
            "/api/sessions/:id/memory/action"
        } else {
            "/api/sessions/:id/memory"
        };
        let handler = function(owner, "", 2, 2, move |owner, args| {
            let deps = owner.get(c"deps")?;
            let req = args[0];
            let res = args[1];
            let record = call(
                deps.get(c"records")?,
                c"get",
                &[req.get(c"params")?.get(c"id")?],
            )?;
            if !record.truthy()? {
                return error(res, 404, "session not found", false);
            }
            let folder = owner.get(c"folder")?;
            match route {
                Route::Read => list(deps, folder, record, res),
                Route::Write | Route::Delete => file(deps, folder, record, req, res, route),
                Route::Curate => curate(deps, folder, record, req, res),
            }
        })?;
        call(app, key, &[text(app, path)?, handler])?;
    }
    Ok(())
}

fn task_id(record: L<'_>) -> Result<L<'_>> {
    let state = record.get(c"taskState")?;
    if state.truthy()? {
        record.get(c"taskState")?.get(c"taskId")
    } else {
        Ok(state)
    }
}

fn list<'a>(deps: L<'a>, folder: L<'a>, record: L<'a>, res: L<'a>) -> Result<L<'a>> {
    call(folder, c"ensureDirs", &[record])?;
    let own = call(folder, c"sessionDir", &[record])?;
    let shared = call(folder, c"sharedDir", &[record.get(c"dirId")?])?;
    let files = |dir| call(folder, c"listFiles", &[dir]);
    let own = fields(
        res,
        &[
            ("dir", own),
            (
                "primary",
                call(folder, c"primaryFileName", &[record.get(c"cli")?])?,
            ),
            ("files", files(own)?),
        ],
    )?;
    let shared = fields(res, &[("dir", shared), ("files", files(shared)?)])?;
    let machine = fields(
        res,
        &[
            ("dir", call(folder, c"machineDir", &[])?),
            ("files", files(call(folder, c"machineDir", &[])?)?),
        ],
    )?;
    let cli_dir = || call(folder, c"cliDir", &[record.get(c"cli")?]);
    let empty = || res.from_value(&V::Array(vec![]));
    let cli = fields(
        res,
        &[
            ("dir", cli_dir()?),
            (
                "files",
                if cli_dir()?.truthy()? {
                    files(cli_dir()?)?
                } else {
                    empty()?
                },
            ),
        ],
    )?;
    let task = task_id(record)?;
    let dir = if task.truthy()? {
        call(folder, c"taskDir", &[record.get(c"dirId")?, task])?
    } else {
        null(res)?
    };
    let task = fields(
        res,
        &[
            ("taskId", fallback(task, V::Null)?),
            ("dir", dir),
            ("files", if dir.truthy()? { files(dir)? } else { empty()? }),
        ],
    )?;
    let legacy = call(deps, c"getMemoryEntries", &[record])?;
    send(
        res,
        None,
        fields(
            res,
            &[
                ("own", own),
                ("shared", shared),
                ("machine", machine),
                ("cli", cli),
                ("task", task),
                ("legacy", legacy),
            ],
        )?,
    )
}

fn broadcast<'a>(deps: L<'a>, record: L<'a>, dir_id: L<'a>, scope: L<'a>) -> Result<()> {
    let payload = fields(
        record,
        &[
            ("type", text(record, "memory")?),
            ("sessionId", record.get(c"id")?),
            ("scope", scope),
        ],
    )?;
    call(deps, c"workspaceBroadcast", &[dir_id, payload])?;
    Ok(())
}

fn prefixed_error<'a>(res: L<'a>, status: i32, prefix: &str, value: L<'a>) -> Result<L<'a>> {
    let message = call(text(res, prefix)?, c"concat", &[value])?;
    send(res, Some(status), fields(res, &[("error", message)])?)
}

fn file<'a>(
    deps: L<'a>,
    folder: L<'a>,
    record: L<'a>,
    req: L<'a>,
    res: L<'a>,
    route: Route,
) -> Result<L<'a>> {
    let put = matches!(route, Route::Write);
    let body = req.get(c"body")?;
    let body = if body.truthy()? {
        body
    } else {
        fields(req, &[])?
    };
    let shared = body.optional(c"scope")?.is_string("shared")?;
    let name = body.optional(c"name")?;
    let content = if put {
        Some(body.optional(c"content")?)
    } else {
        None
    };
    let scope = text(res, if shared { "shared" } else { "own" })?;
    let name = call(folder, c"safeFileName", &[name])?;
    if !name.truthy()? {
        return error(
            res,
            400,
            if put {
                "invalid file name (must be a plain *.md name)"
            } else {
                "invalid file name"
            },
            false,
        );
    }
    let content = if let Some(value) = content {
        let value = if value.nullish()? {
            text(res, "")?
        } else {
            string(value)?
        };
        if value.get(c"length")?.number()? > 40000.0 {
            return error(res, 400, "content too long (max 40000)", false);
        }
        let threat = call(deps, c"scanMemoryContent", &[value])?;
        if threat.truthy()? {
            return prefixed_error(res, 400, "memory write blocked: ", threat);
        }
        call(folder, c"ensureDirs", &[record])?;
        Some(value)
    } else {
        None
    };
    let dir = call(folder, c"scopeDir", &[record, scope])?;
    let path = || call(deps.get(c"path")?, c"join", &[dir, name]);
    let result = (|| {
        if let Some(value) = content {
            deps.get(c"atomicWriteMemoryFile")?
                .call(deps, &[path()?, value])
        } else {
            let fs = deps.get(c"fs")?;
            fs.get(c"unlinkSync")?.call(fs, &[path()?])
        }
    })();
    if let Err(failure) = result {
        let thrown = res.exception_value()?.ok_or(failure)?;
        if put || !thrown.get(c"code")?.is_string("ENOENT")? {
            return prefixed_error(
                res,
                500,
                if put {
                    "write failed: "
                } else {
                    "delete failed: "
                },
                thrown.get(c"message")?,
            );
        }
    }
    if record.get(c"dirId")?.truthy()? {
        broadcast(deps, record, record.get(c"dirId")?, scope)?;
    }
    send(
        res,
        None,
        fields(
            res,
            &[
                ("ok", flag(res, true)?),
                ("files", call(folder, c"listFiles", &[dir])?),
            ],
        )?,
    )
}

fn lower<'a>(value: L<'a>, default: &str) -> Result<L<'a>> {
    let trimmed = call(string(fallback(value, default.into())?)?, c"trim", &[])?;
    call(trimmed, c"toLowerCase", &[])
}

fn curate<'a>(deps: L<'a>, folder: L<'a>, record: L<'a>, req: L<'a>, res: L<'a>) -> Result<L<'a>> {
    if record.get(c"type")?.is_string("aux")? || record.get(c"type")?.is_string("gateway")? {
        return error(
            res,
            400,
            "system sessions do not have curated memory",
            false,
        );
    }
    call(folder, c"ensureDirs", &[record])?;
    let body = req.get(c"body")?;
    let scope = lower(body.optional(c"scope")?, "own")?;
    let name = scope.coerce_string()?.to_string_lossy();
    let label = match name.as_str() {
        "own" => "私有",
        "shared" => "公共",
        "machine" => "机器全局",
        "cli" => "CLI",
        "task" => "任务",
        "skill" => "技能",
        _ => {
            return error(
                res,
                400,
                "invalid scope (must be one of own/shared/machine/cli/task/skill)",
                false,
            )
        }
    };
    let extra = fields(res, &[])?;
    if name == "task" {
        let explicit = call(folder, c"safeSegment", &[body.optional(c"taskId")?])?;
        let current = task_id(record)?;
        let id = if explicit.truthy()? {
            explicit
        } else if call(folder, c"safeSegment", &[current])?.truthy()? {
            current
        } else {
            null(res)?
        };
        if !id.truthy()? {
            return error(
                res,
                400,
                "task scope requires a current bound task or an explicit taskId",
                false,
            );
        }
        extra.set(c"taskId", id)?;
    } else if name == "skill" {
        let skill = call(folder, c"safeSegment", &[body.optional(c"skill")?])?;
        if !skill.truthy()? {
            return error(
                res,
                400,
                "skill scope requires a skill name (safe word characters only)",
                false,
            );
        }
        extra.set(c"skill", skill)?;
    }
    let dir = call(folder, c"scopeDir", &[record, scope, extra])?;
    if !dir.truthy()? {
        return error(
            res,
            400,
            &format!("scope {name} resolves to no directory on this session"),
            false,
        );
    }
    let apply = deps.get(c"applyCuratedMemoryAction")?;
    let params = fields(
        res,
        &[
            ("dir", dir),
            ("action", lower(req.get(c"body")?.optional(c"action")?, "")?),
            ("content", req.get(c"body")?.optional(c"content")?),
            ("oldText", req.get(c"body")?.optional(c"oldText")?),
            ("charLimit", call(folder, c"curatedLimit", &[scope])?),
        ],
    )?;
    let result = apply.call(deps, &[params])?;
    if !result.get(c"ok")?.truthy()? {
        return send(res, Some(400), result);
    }
    let event = deps.get(c"appendEvent")?;
    let dir_id = record.get(c"dirId")?;
    let message = call(
        text(res, &format!("{label}记忆："))?,
        c"concat",
        &[result.get(c"message")?],
    )?;
    event.call(
        deps,
        &[
            dir_id,
            text(res, "memory_updated")?,
            message,
            record.get(c"id")?,
        ],
    )?;
    if name == "machine" || name == "cli" {
        call(deps, c"directoriesKeys", &[])?.for_each(|id| broadcast(deps, record, id, scope))?;
    } else {
        broadcast(deps, record, record.get(c"dirId")?, scope)?;
    }
    send(res, None, result)
}
