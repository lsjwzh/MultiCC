use super::*;

fn found<'a>(p: L<'a>, id: L<'a>, created: bool) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("ok", flag(p, true)?),
            ("sessionId", id),
            ("created", flag(p, created)?),
        ],
    )
}
pub(super) fn holds<'a>(p: L<'a>, session: L<'a>, id: L<'a>) -> Result<bool> {
    Ok(p.catch(|| {
        let task = local(p, c"resolvedTask", &[id])?;
        let ids = if task.truthy()? {
            local(p, c"taskIdentityIds", &[task])?
        } else {
            let list = array(p)?;
            call(list, c"push", &[id])?;
            list
        };
        let set = p.global()?.get(c"Set")?.construct(&[ids])?;
        let messages = local(p, c"loadHistory", &[session])?;
        if !messages.truthy()? {
            return Ok(false);
        }
        call(
            messages,
            c"some",
            &[function(set, "", 1, 1, |set, a| {
                call(set, c"has", &[a[0].optional(c"taskId")?])
            })?],
        )?
        .truthy()
    })?
    .unwrap_or(true))
}

fn patch<'a>(p: L<'a>, id: L<'a>, session: L<'a>) -> Result<()> {
    local(
        p,
        c"updateBoardTask",
        &[id, fields(p, &[("chatSessionId", session)])?],
    )?;
    Ok(())
}
fn existing<'a>(p: L<'a>, task: L<'a>, adopt: L<'a>) -> Result<Option<L<'a>>> {
    let records = p.get(c"records")?;
    let id = task.get(c"id")?;
    let bound = task.get(c"chatSessionId")?;
    let bound = if bound.kind()? == sys::ValueType::napi_string {
        bound
    } else {
        text(p, "")?
    };
    if bound.truthy()? {
        if call(records, c"get", &[bound])?.truthy()? {
            return Ok(Some(found(p, bound, false)?));
        }
    } else if records.optional(c"values")?.kind()? == sys::ValueType::napi_function {
        let mut recovered = None;
        call(records, c"values", &[])?.for_each_while(|rec| {
            if rec.optional(c"taskBoundTaskId")?.equals(id)? {
                let card = p.get(c"board")?.get(c"tasks")?.get_key(id)?;
                let session = rec.get(c"id")?;
                if card.truthy()? && !card.get(c"chatSessionId")?.truthy()? {
                    patch(p, id, session)?;
                }
                recovered = Some(found(p, session, false)?);
                return Ok(false);
            }
            Ok(true)
        })?;
        if recovered.is_some() {
            return Ok(recovered);
        }
    }
    if !adopt.truthy()? || records.optional(c"get")?.kind()? != sys::ValueType::napi_function {
        return Ok(None);
    }
    let refs = array(p)?;
    let values = task.get(c"refs")?;
    if values.truthy()? {
        values.for_each(|r| {
            if r.optional(c"sessionId")?.truthy()? {
                call(refs, c"push", &[r])?;
            }
            Ok(())
        })?;
    }
    call(
        refs,
        c"sort",
        &[function(p, "", 2, 2, |p, a| {
            num(
                p,
                fallback(a[1].get(c"ts")?, V::Number(0.))?.number()?
                    - fallback(a[0].get(c"ts")?, V::Number(0.))?.number()?,
            )
        })?],
    )?;
    let mut result = None;
    refs.for_each_while(|r| {
        let session = r.get(c"sessionId")?;
        let rec = call(records, c"get", &[session])?;
        if rec.truthy()?
            && rec.get(c"kind")?.is_string("chat")?
            && !rec.get(c"taskExecutionSlot")?.truthy()?
            && !rec.get(c"taskBoundTaskId")?.truthy()?
            && holds(p, session, id)?
        {
            let value = found(p, rec.get(c"id")?, false)?;
            value.set(c"adopted", flag(p, true)?)?;
            result = Some(value);
            return Ok(false);
        }
        Ok(true)
    })?;
    Ok(result)
}

pub(super) fn ensure<'a>(p: L<'a>, task: L<'a>, options: L<'a>) -> Result<L<'a>> {
    held(p, task.optional(c"id")?, || {
        if let Some(found) = existing(p, task, options.get(c"adoptOrigin")?)? {
            return Ok(found);
        }
        let board = p.get(c"board")?;
        let core = p.get(c"core")?;
        let mut dir_id = options.get(c"dirId")?;
        if !dir_id.truthy()? {
            dir_id = call(core, c"taskDirId", &[board, task])?;
        }
        let resolve = p.get(c"resolveDirectoryPort")?;
        let dir = if dir_id.truthy()? && resolve.truthy()? {
            resolve.call_plain(&[dir_id])?
        } else {
            null(p)?
        };
        if !dir.truthy()? {
            return failure(p, text(p, "directory_not_found")?);
        }
        let create = p.get(c"createSessionRecord")?;
        if !create.truthy()? {
            return failure(p, text(p, "chat_session_unavailable")?);
        }
        let commander = call(
            core,
            c"resolveDirectoryCommander",
            &[p.get(c"records")?, dir_id],
        )?;
        let rec = if commander.get(c"ok")?.truthy()? {
            commander.get(c"record")?
        } else {
            null(p)?
        };
        let runtime = options.get(c"runtime")?;
        let cli = either(
            runtime.optional(c"cli")?,
            fallback(rec.optional(c"cli")?, V::from("claude"))?,
        )?;
        let inherit = !rec.truthy()? || rec.get(c"cli")?.equals(cli)?;
        let inherited = |key: &CStr, default: V| -> Result<L<'a>> {
            if inherit {
                fallback(rec.optional(key)?, default)
            } else {
                p.from_value(&default)
            }
        };
        let selection = runtime.optional(c"providerSelection")?;
        let mut model = runtime.optional(c"model")?;
        if model.nullish()? {
            model = inherited(c"model", V::Null)?;
        }
        let mut provider = runtime.optional(c"provider")?;
        if selection.truthy()? && !provider.truthy()? {
            provider = undef(p)?;
        } else if provider.nullish()? {
            provider = inherited(c"provider", V::from(""))?;
        }
        let title = string(fallback(task.get(c"title")?, V::from(""))?)?;
        let label = call(
            text(p, "任务 · ")?,
            c"concat",
            &[call(title, c"slice", &[num(p, 0.)?, num(p, 40.)?])?],
        )?;
        let args = fields(
            p,
            &[
                ("dir", dir),
                ("cli", cli),
                ("kind", text(p, "chat")?),
                ("label", label),
                ("model", model),
                ("provider", provider),
            ],
        )?;
        if selection.truthy()? {
            args.set(c"providerSelection", selection)?;
        }
        args.set(c"effort", inherited(c"effort", V::Null)?)?;
        args.set(c"taskBoundTaskId", task.get(c"id")?)?;
        args.set(c"persistence", text(p, "required")?)?;
        args.set(
            c"persistenceSource",
            text(p, "runtime.task-chat-session-create")?,
        )?;
        let f = fields(p, &[("ports", p), ("task", task)])?;
        after(f, create.call_plain(&[args])?, |f, created| {
            if !created.optional(c"ok")?.truthy()? {
                return failure(
                    f,
                    fallback(
                        created.optional(c"error")?,
                        V::from("chat_session_create_failed"),
                    )?,
                );
            }
            let id = created.get(c"id")?;
            patch(super::p(f)?, f.get(c"task")?.get(c"id")?, id)?;
            found(f, id, true)
        })
    })
}

fn chat_result<'a>(f: L<'a>, bound: L<'a>) -> Result<L<'a>> {
    let res = f.get(c"res")?;
    if !bound.get(c"ok")?.truthy()? {
        let code = bound.get(c"code")?;
        let status = if code.is_string("chat_session_unavailable")? {
            501
        } else if code.is_string("directory_not_found")? {
            409
        } else {
            502
        };
        return send(res, Some(status), fields(f, &[("error", code)])?);
    }
    let body = fields(
        f,
        &[
            ("ok", flag(f, true)?),
            ("sessionId", bound.get(c"sessionId")?),
            ("created", bound.get(c"created")?),
        ],
    )?;
    if bound.get(c"adopted")?.truthy()? {
        body.set(c"adopted", flag(f, true)?)?;
    }
    send(res, None, body)
}
fn open(f: L<'_>) -> Result<L<'_>> {
    after(
        f,
        ensure(
            p(f)?,
            f.get(c"task")?,
            fields(f, &[("adoptOrigin", flag(f, true)?)])?,
        )?,
        chat_result,
    )
}
pub(super) fn chat<'a>(p: L<'a>, req: L<'a>, res: L<'a>) -> Result<L<'a>> {
    if !p.get(c"createSessionRecord")?.truthy()? {
        return error(res, 501, "chat_session_unavailable", false);
    }
    let task = local(p, c"resolvedTask", &[req.get(c"params")?.get(c"taskId")?])?;
    if !task.truthy()? {
        return error(res, 404, "task_not_found", false);
    }
    let f = fields(p, &[("ports", p), ("res", res), ("task", task)])?;
    let deps = p.get(c"deps")?;
    if !deps.get(c"taskShellTaskEntry")?.truthy()? {
        return open(f);
    }
    after(
        f,
        call(deps, c"taskShellTaskEntry", &[task.get(c"id")?])?,
        |f, entry| {
            if entry.get(c"readOnly")?.truthy()? {
                let body = crate::js_live::spread(entry)?;
                body.set(c"sessionId", null(f)?)?;
                return send(f.get(c"res")?, None, body);
            }
            open(f)
        },
    )
}
