//! Identity adoption, immutable fixed bindings, explicit repair and single-flight
//! binding are separate from firing: accepted deliveries retain their own task.
use super::*;
use multicc_core::{js::JsString, recurring::client_id};
fn task(f: L<'_>) -> Result<L<'_>> {
    f.get(c"task")
}
fn owner(f: L<'_>) -> Result<L<'_>> {
    f.get(c"owner")
}
pub(super) fn client<'a>(p: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let mut strings = Vec::<JsString>::new();
    for &part in parts {
        strings.push(if part.nullish()? {
            JsString::new()
        } else {
            string(part)?.coerce_string()?
        });
    }
    p.from_value(&V::String(client_id(&strings)))
}
pub(super) fn clear(t: L<'_>) -> Result<()> {
    t.assign(c"taskBindingError", text(t, "")?)?;
    t.assign(c"taskBindingBrokenAt", null(t)?)?;
    t.assign(c"taskBindingNotifiedFor", null(t)?)?;
    Ok(())
}
pub(super) fn broken<'a>(o: L<'a>, t: L<'a>, e: L<'a>) -> Result<()> {
    let msg = either(
        e.optional(c"message")?,
        either(e.optional(c"code")?, text(o, "固定任务绑定失败")?)?,
    )?;
    t.assign(c"taskBindingError", msg)?;
    t.assign(
        c"taskBindingBrokenAt",
        either(t.get(c"taskBindingBrokenAt")?, now(o)?)?,
    )?;
    let fingerprint = either(t.get(c"taskId")?, text(o, "unbound")?)?;
    if t.get(c"taskBindingNotifiedFor")?.equals(fingerprint)? {
        return Ok(());
    }
    t.assign(c"taskBindingNotifiedFor", fingerprint)?;
    o.catch(||{
        let d=deps(o)?;let dirs=d.get(c"directories")?;let dir=if callable(dirs.optional(c"get")?)?{call(dirs,c"get",&[t.get(c"dirId")?])?}else{undefined(o)?};
        let info=fields(o,&[("id",t.get(c"id")?),("name",t.get(c"name")?),("taskId",either(t.get(c"taskId")?,null(o)?)?),("dirId",t.get(c"dirId")?),("sessionId",either(t.get(c"taskSessionId")?,null(o)?)?),("dirName",either(dir.optional(c"name")?,null(o)?)?),("code",either(e.optional(c"code")?,text(o,"task_binding_broken")?)?),("error",t.get(c"taskBindingError")?),("message",text(o,&format!("定时规则「{}」已停止：固定 Air 任务不可写（{}），请在定时中心重新绑定。",strval(t.get(c"name")?)?,strval(msg)?))?)])?;
        let notify=d.get(c"notifyBroken")?;if !notify.nullish()?{notify.call(d,&[info])?;}Ok(())
    })?;
    Ok(())
}
pub(super) fn is_break(e: L<'_>) -> Result<bool> {
    Ok(matches!(
        strval(e.optional(c"code")?)?.as_str(),
        "task_read_only" | "task_not_found" | "task_archived" | "task_owner_missing"
    ))
}
fn entry<'a>(o: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let d = deps(o)?;
    if !d.get(c"getTask")?.truthy()? {
        return resolve(null(o)?);
    }
    then(invoke(d, c"getTask", &[id])?, o, |o, e| {
        if !e.optional(c"task")?.optional(c"id")?.truthy()? || e.optional(c"readOnly")?.truthy()? {
            let readonly = e.optional(c"readOnly")?.truthy()?;
            return Err(failure(
                o,
                if readonly {
                    "task_read_only"
                } else {
                    "task_not_found"
                },
                if readonly {
                    "固定任务已归档或只读"
                } else {
                    "固定任务不存在"
                },
            )?);
        }
        Ok(e)
    })
}
fn binding<'a>(f: L<'a>, entry: L<'a>, tag: Option<&str>) -> Result<L<'a>> {
    let t = task(f)?;
    let out = fields(
        f,
        &[
            ("taskId", t.get(c"taskId")?),
            ("sessionId", t.get(c"taskSessionId")?),
            ("entry", entry),
        ],
    )?;
    if let Some(tag) = tag {
        out.set_key(text(f, tag)?, flag(f, true)?)?;
    }
    Ok(out)
}
fn adopt<'a>(f: L<'a>, entry: L<'a>) -> Result<L<'a>> {
    let t = task(f)?;
    t.assign(c"taskId", f.get(c"candidate")?)?;
    t.assign(
        c"taskSessionId",
        either(entry.optional(c"sessionId")?, t.get(c"lastSessionId")?)?,
    )?;
    if f.get(c"repair")?.truthy()? {
        existing(f, undefined(f)?)
    } else {
        t.assign(c"taskBindingVersion", num(f, 1.)?)?;
        clear(t)?;
        super::schedule::save(owner(f)?)?;
        binding(f, entry, Some("migrated"))
    }
}
fn created<'a>(f: L<'a>, created: L<'a>) -> Result<L<'a>> {
    if !created.optional(c"ok")?.truthy()? || !created.optional(c"taskId")?.truthy()? {
        let code = either(created.optional(c"code")?, text(f, "task_create_failed")?)?;
        let msg = either(
            created.optional(c"error")?,
            either(
                created.optional(c"code")?,
                text(
                    f,
                    if f.get(c"rebind")?.truthy()? {
                        "重建固定任务失败"
                    } else {
                        "创建固定任务失败"
                    },
                )?,
            )?,
        )?;
        let e = f.global()?.get(c"Error")?.construct(&[msg])?;
        e.set(c"code", code)?;
        return Err(e.throw_error());
    }
    let t = task(f)?;
    if f.get(c"rebind")?.truthy()? {
        let history = either(t.get(c"taskRebindHistory")?, array(f)?)?;
        let next = call(f.global()?.get(c"Array")?, c"from", &[history])?;
        append(
            next,
            fields(
                f,
                &[
                    ("from", f.get(c"previous")?),
                    ("to", created.get(c"taskId")?),
                    ("at", now(f)?),
                    ("reason", f.get(c"reason")?),
                ],
            )?,
        )?;
        t.assign(c"taskRebindHistory", slice(next, -10., None)?)?;
    }
    t.assign(c"taskId", created.get(c"taskId")?)?;
    t.assign(
        c"taskSessionId",
        either(created.get(c"sessionId")?, null(f)?)?,
    )?;
    if f.get(c"rebind")?.truthy()? {
        t.assign(c"lastSessionId", t.get(c"taskSessionId")?)?;
    }
    t.assign(c"taskBindingVersion", num(f, 1.)?)?;
    clear(t)?;
    super::schedule::save(owner(f)?)?;
    if f.get(c"rebind")?.truthy()? {
        fields(
            f,
            &[
                ("ok", flag(f, true)?),
                ("taskId", t.get(c"taskId")?),
                ("sessionId", t.get(c"taskSessionId")?),
                ("previousTaskId", f.get(c"previous")?),
            ],
        )
    } else {
        binding(f, created, Some("created"))
    }
}
fn create(f: L<'_>) -> Result<L<'_>> {
    let o = owner(f)?;
    let t = task(f)?;
    if !callable(deps(o)?.get(c"createTask")?)? {
        return Err(failure(
            f,
            "task_service_unavailable",
            "Air 任务服务尚未就绪",
        )?);
    }
    let id = if f.get(c"rebind")?.truthy()? {
        client(
            f,
            &[
                text(f, "cron-rebind")?,
                t.get(c"id")?,
                either(f.get(c"previous")?, text(f, "unbound")?)?,
            ],
        )?
    } else {
        client(f, &[text(f, "cron-task")?, t.get(c"id")?])?
    };
    let input = fields(
        f,
        &[
            ("dirId", t.get(c"dirId")?),
            ("title", t.get(c"name")?),
            ("cli", either(t.get(c"cli")?, text(f, "claude")?)?),
            ("clientMsgId", id),
        ],
    )?;
    f.set(c"lookupId", t.get(c"taskId")?)?;
    then(
        invoke(deps(o)?, c"createTask", &[input])?,
        f,
        |f, result| {
            if !f.get(c"rebind")?.truthy()?
                && !task(f)?.get(c"taskId")?.equals(f.get(c"lookupId")?)?
            {
                return existing(f, undefined(f)?);
            }
            created(f, result)
        },
    )
}
fn existing<'a>(f: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let id = task(f)?.get(c"taskId")?;
    f.set(c"lookupId", id)?;
    let checked = then(entry(owner(f)?, id)?, f, |f, e| {
        let t = task(f)?;
        if !t.get(c"taskId")?.equals(f.get(c"lookupId")?)? {
            return existing(f, undefined(f)?);
        }
        t.assign(
            c"taskSessionId",
            either(
                e.optional(c"sessionId")?,
                either(t.get(c"taskSessionId")?, null(f)?)?,
            )?,
        )?;
        t.assign(c"taskBindingVersion", num(f, 1.)?)?;
        clear(t)?;
        binding(f, e, None)
    })?;
    caught(checked, f, |f, e| {
        if task(f)?.get(c"taskId")?.equals(f.get(c"lookupId")?)? {
            Err(e.throw_error())
        } else {
            existing(f, undefined(f)?)
        }
    })
}
fn ready<'a>(f: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let o = owner(f)?;
    let t = task(f)?;
    let d = deps(o)?;
    let dir = call(d.get(c"directories")?, c"get", &[t.get(c"dirId")?])?;
    if !dir.truthy()? {
        return Err(failure(f, "directory_missing", "目标目录不存在")?);
    }
    if t.get(c"kind")?.is_string("script")? {
        return fields(
            f,
            &[
                ("taskId", null(f)?),
                ("sessionId", null(f)?),
                ("entry", null(f)?),
                ("script", flag(f, true)?),
                ("dir", dir),
            ],
        );
    }
    let bound = t.get(c"taskId")?.truthy()?;
    if (!bound || !t.get(c"taskBindingVersion")?.is_number(1.)?)
        && t.get(c"lastSessionId")?.truthy()?
        && d.get(c"resolveTaskId")?.truthy()?
    {
        let candidate = call(d, c"resolveTaskId", &[t.get(c"lastSessionId")?])?;
        if candidate.truthy()? && (!bound || !candidate.equals(t.get(c"taskId")?)?) {
            f.set(c"lookupId", t.get(c"taskId")?)?;
            f.set(c"candidate", candidate)?;
            f.set(c"repair", flag(f, bound)?)?;
            // Catch only the historical-entry lookup; failures in creating a
            // replacement or validating the retained binding still propagate.
            let q = caught(entry(o, candidate)?, f, |f, _| undefined(f))?;
            return then(q, f, |f, e| {
                if !task(f)?.get(c"taskId")?.equals(f.get(c"lookupId")?)? {
                    return existing(f, undefined(f)?);
                }
                if e.undefined()? {
                    if f.get(c"repair")?.truthy()? {
                        existing(f, e)
                    } else {
                        create(f)
                    }
                } else {
                    adopt(f, e)
                }
            });
        }
    }
    if bound {
        existing(f, undefined(f)?)
    } else {
        create(f)
    }
}
pub(super) fn ensure<'a>(o: L<'a>, t: L<'a>) -> Result<L<'a>> {
    let flights = o.get(c"bindingFlights")?;
    let id = t.get(c"id")?;
    let current = call(flights, c"get", &[id])?;
    if current.truthy()? {
        return resolve(current);
    }
    let f = fields(o, &[("owner", o), ("task", t)])?;
    let operation = async_result(o, || {
        let wait = deps(o)?.get(c"ready")?;
        if wait.truthy()? {
            then(wait, f, ready)
        } else {
            ready(f, undefined(f)?)
        }
    })?;
    call(flights, c"set", &[id, operation])?;
    let cleanup = function(f, "", 0, 0, |f, _| {
        call(
            owner(f)?.get(c"bindingFlights")?,
            c"delete",
            &[task(f)?.get(c"id")?],
        )?;
        undefined(f)
    })?;
    call(operation, c"finally", &[cleanup])
}
pub(super) fn rebind<'a>(o: L<'a>, t: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    if !callable(deps(o)?.get(c"createTask")?)? {
        return Err(failure(
            o,
            "task_service_unavailable",
            "Air 任务服务尚未就绪",
        )?);
    }
    let opts = default_object(opts)?;
    let previous = either(t.get(c"taskId")?, null(o)?)?;
    let reason = if opts.get(c"reason")?.undefined()? {
        text(o, "manual")?
    } else {
        opts.get(c"reason")?
    };
    let f = fields(
        o,
        &[
            ("owner", o),
            ("task", t),
            ("previous", previous),
            ("reason", reason),
            ("rebind", flag(o, true)?),
        ],
    )?;
    if previous.truthy()? && !opts.get(c"force")?.truthy()? {
        let probe = caught(entry(o, previous)?, f, |f, e| {
            if is_break(e)? {
                undefined(f)
            } else {
                Err(e.throw_error())
            }
        })?;
        then(probe, f, |f, e| {
            if e.undefined()? {
                create(f)
            } else {
                fields(
                    f,
                    &[
                        ("ok", flag(f, false)?),
                        ("code", text(f, "binding_healthy")?),
                        ("taskId", f.get(c"previous")?),
                        ("previousTaskId", f.get(c"previous")?),
                    ],
                )
            }
        })
    } else {
        create(f)
    }
}
fn migration_step(f: L<'_>) -> Result<L<'_>> {
    let tasks = f.get(c"tasks")?;
    let mut index = f.get(c"index")?.number()? as u32;
    while index < tasks.get(c"length")?.number()? as u32 {
        let t = tasks.element(index)?;
        index += 1;
        f.set(c"index", num(f, index as f64)?)?;
        if t.get(c"kind")?.is_string("script")? {
            continue;
        }
        let previous = array(f)?;
        for k in [
            c"taskId",
            c"taskSessionId",
            c"taskBindingVersion",
            c"taskBindingError",
            c"taskBindingBrokenAt",
            c"taskBindingNotifiedFor",
        ] {
            append(previous, t.get(k)?)?;
        }
        f.set(c"task", t)?;
        f.set(c"previousFields", previous)?;
        f.set(c"rebindHistory", t.get(c"taskRebindHistory")?)?;
        let operation = then(ensure(owner(f)?, t)?, f, |f, _| {
            if !f.get(c"previousFields")?.element(0)?.truthy()?
                && task(f)?.get(c"taskId")?.truthy()?
            {
                f.set(c"migrated", plus_one(f.get(c"migrated")?)?)?;
            }
            undefined(f)
        })?;
        let operation = caught(operation, f, |f, e| {
            let t = task(f)?;
            // A manual rebind replaces its history array. A migration that was
            // already in flight must not mark that replacement as broken.
            if !t
                .get(c"taskRebindHistory")?
                .equals(f.get(c"rebindHistory")?)?
            {
                return undefined(f);
            }
            broken(owner(f)?, t, e)?;
            append(
                f.get(c"errors")?,
                fields(
                    f,
                    &[
                        ("id", t.get(c"id")?),
                        (
                            "code",
                            either(e.optional(c"code")?, text(f, "task_binding_failed")?)?,
                        ),
                        ("error", t.get(c"taskBindingError")?),
                    ],
                )?,
            )?;
            undefined(f)
        })?;
        return then(operation, f, |f, _| {
            for (i, k) in [
                c"taskId",
                c"taskSessionId",
                c"taskBindingVersion",
                c"taskBindingError",
                c"taskBindingBrokenAt",
                c"taskBindingNotifiedFor",
            ]
            .into_iter()
            .enumerate()
            {
                if !task(f)?
                    .get(k)?
                    .equals(f.get(c"previousFields")?.element(i as u32)?)?
                {
                    f.set(c"dirty", flag(f, true)?)?;
                }
            }
            migration_step(f)
        });
    }
    if f.get(c"dirty")?.truthy()? {
        super::schedule::save(owner(f)?)?;
    }
    fields(
        f,
        &[
            ("migrated", f.get(c"migrated")?),
            ("errors", f.get(c"errors")?),
        ],
    )
}
pub(super) fn migrate(o: L<'_>) -> Result<L<'_>> {
    if !deps(o)?.optional(c"createTask")?.truthy()? || !deps(o)?.optional(c"getTask")?.truthy()? {
        return resolve(fields(
            o,
            &[("migrated", num(o, 0.)?), ("errors", array(o)?)],
        )?);
    }
    let f = fields(
        o,
        &[
            ("owner", o),
            ("tasks", o.get(c"tasks")?),
            ("index", num(o, 0.)?),
            ("migrated", num(o, 0.)?),
            ("errors", array(o)?),
            ("dirty", flag(o, false)?),
        ],
    )?;
    async_result(o, || migration_step(f))
}
pub(super) fn migrated(o: L<'_>) -> Result<L<'_>> {
    then(either(o.get(c"migration")?, undefined(o)?)?, o, |o, _| {
        let mut pending = false;
        o.get(c"tasks")?.for_each(|t| {
            if !t.get(c"kind")?.is_string("script")?
                && (!t.get(c"taskId")?.truthy()? || !t.get(c"taskBindingVersion")?.is_number(1.)?)
            {
                pending = true;
            }
            Ok(())
        })?;
        if pending {
            migrate(o)
        } else {
            undefined(o)
        }
    })
}
