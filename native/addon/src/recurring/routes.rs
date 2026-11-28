//! Express registration is a transport adapter; all route decisions, identities,
//! projection and effects are driven by the recurring Rust owner.
use super::*;
fn req(f: L<'_>) -> Result<L<'_>> {
    f.get(c"req")
}
fn res(f: L<'_>) -> Result<L<'_>> {
    f.get(c"res")
}
fn body(f: L<'_>) -> Result<L<'_>> {
    either(req(f)?.get(c"body")?, fields(f, &[])?)
}
fn find(f: L<'_>) -> Result<Option<(u32, L<'_>)>> {
    let o = root(f)?;
    let id = req(f)?.get(c"params")?.get(c"id")?;
    let tasks = o.get(c"tasks")?;
    for i in 0..tasks.get(c"length")?.number()? as u32 {
        let t = tasks.element(i)?;
        if t.get(c"id")?.equals(id)? {
            return Ok(Some((i, t)));
        }
    }
    Ok(None)
}
fn uid(o: L<'_>) -> Result<L<'_>> {
    let random = call(o.global()?.get(c"Math")?, c"random", &[])?;
    let prefix = slice(call(random, c"toString", &[num(o, 36.)?])?, 2., Some(10.))?;
    let suffix = slice(call(now(o)?, c"toString", &[num(o, 36.)?])?, -4., None)?;
    text(o, &format!("cron_{}{}", strval(prefix)?, strval(suffix)?))
}
fn create(f: L<'_>) -> Result<L<'_>> {
    let o = root(f)?;
    let t = super::view::sanitize(o, body(f)?, undefined(f)?)?;
    if t.get(c"enabled")?.undefined()? {
        t.set(c"enabled", flag(f, true)?)?;
    }
    if !t.get(c"cli")?.truthy()? {
        t.set(c"cli", text(f, "claude")?)?;
    }
    if !t.get(c"kind")?.truthy()? {
        t.set(c"kind", text(f, "agent")?)?;
    }
    if let Some(err) = super::view::validate(o, t)? {
        return error(res(f)?, 400, err, false);
    }
    t.set(c"id", uid(o)?)?;
    t.set(
        c"createdAt",
        call(
            o.global()?.get(c"Date")?.construct(&[])?,
            c"toISOString",
            &[],
        )?,
    )?;
    if !t.get(c"createdBy")?.truthy()? {
        t.set(c"createdBy", text(f, "user")?)?;
    }
    f.set(c"task", t)?;
    then(super::binding::ensure(o, t)?, f, |f, _| {
        let o = root(f)?;
        let t = f.get(c"task")?;
        append(o.get(c"tasks")?, t)?;
        super::schedule::save(o)?;
        logger(
            o,
            c"log",
            &[text(
                f,
                &format!(
                    "[multicc/cron] created task {} ({}) by {}, kind={}, cron=\"{}\"",
                    strval(t.get(c"id")?)?,
                    strval(t.get(c"name")?)?,
                    strval(t.get(c"createdBy")?)?,
                    strval(t.get(c"kind")?)?,
                    strval(t.get(c"cron")?)?
                ),
            )?],
        )?;
        send(res(f)?, None, super::view::render(o, t)?)
    })
}
fn patch(f: L<'_>) -> Result<L<'_>> {
    let Some((idx, t)) = find(f)? else {
        return error(res(f)?, 404, "task not found", false);
    };
    let input = body(f)?;
    let o = root(f)?;
    if t.get(c"taskId")?.truthy()? {
        if !input.get(c"dirId")?.undefined()?
            && !string(input.get(c"dirId")?)?.equals(t.get(c"dirId")?)?
        {
            return error(
                res(f)?,
                409,
                "固定任务的工作目录不能修改；请新建另一条定时任务",
                false,
            );
        }
        if !input.get(c"cli")?.undefined()?
            && !string(input.get(c"cli")?)?.equals(either(t.get(c"cli")?, text(f, "claude")?)?)?
        {
            return error(
                res(f)?,
                409,
                "请打开固定 Air 任务修改 CLI / Provider",
                false,
            );
        }
    }
    let merged = super::view::sanitize(o, input, t)?;
    if let Some(err) = super::view::validate(o, merged)? {
        return error(res(f)?, 400, err, false);
    }
    merged.set(c"_tickKey", null(f)?)?;
    o.get(c"tasks")?.set_element(idx, merged)?;
    super::schedule::save(o)?;
    send(res(f)?, None, super::view::render(o, merged)?)
}
fn delete(f: L<'_>) -> Result<L<'_>> {
    let Some((idx, t)) = find(f)? else {
        return error(res(f)?, 404, "task not found", false);
    };
    let o = root(f)?;
    call(
        o.get(c"tasks")?,
        c"splice",
        &[num(f, idx as f64)?, num(f, 1.)?],
    )?;
    super::schedule::save(o)?;
    logger(
        o,
        c"log",
        &[text(
            f,
            &format!(
                "[multicc/cron] deleted task {} ({})",
                strval(t.get(c"id")?)?,
                strval(t.get(c"name")?)?
            ),
        )?],
    )?;
    send(res(f)?, None, fields(f, &[("ok", flag(f, true)?)])?)
}
fn runs(f: L<'_>) -> Result<L<'_>> {
    let Some((_, t)) = find(f)? else {
        return error(res(f)?, 404, "task not found", false);
    };
    send(
        res(f)?,
        None,
        fields(
            f,
            &[
                ("ok", flag(f, true)?),
                ("id", t.get(c"id")?),
                ("name", t.get(c"name")?),
                ("runCount", either(t.get(c"runCount")?, num(f, 0.)?)?),
                ("lastRunAt", either(t.get(c"lastRunAt")?, null(f)?)?),
                ("lastStatus", either(t.get(c"lastStatus")?, null(f)?)?),
                ("limit", num(f, 20.)?),
                (
                    "runs",
                    super::view::recent(f, t, num(f, 20.)?, undefined(f)?)?,
                ),
            ],
        )?,
    )
}
fn rebind(f: L<'_>) -> Result<L<'_>> {
    let Some((_, t)) = find(f)? else {
        return error(res(f)?, 404, "task not found", false);
    };
    if t.get(c"kind")?.is_string("script")? {
        return error(
            res(f)?,
            409,
            "脚本任务没有固定 Air 任务，无需重新绑定",
            false,
        );
    }
    let b = body(f)?;
    let opts = fields(
        f,
        &[
            ("force", flag(f, b.get(c"force")?.is_true()?)?),
            ("reason", either(b.get(c"reason")?, text(f, "manual")?)?),
        ],
    )?;
    f.set(c"task", t)?;
    then(
        super::binding::rebind(root(f)?, t, opts)?,
        f,
        |f, result| {
            if !result.get(c"ok")?.truthy()? {
                return send(
                    res(f)?,
                    Some(409),
                    fields(
                        f,
                        &[
                            (
                                "error",
                                either(result.get(c"code")?, text(f, "rebind_failed")?)?,
                            ),
                            ("taskId", either(result.get(c"taskId")?, null(f)?)?),
                        ],
                    )?,
                );
            }
            let o = root(f)?;
            let t = f.get(c"task")?;
            logger(
                o,
                c"log",
                &[text(
                    f,
                    &format!(
                        "[multicc/cron] rebound {} ({}) → Air task {} (was {})",
                        strval(t.get(c"id")?)?,
                        strval(t.get(c"name")?)?,
                        strval(result.get(c"taskId")?)?,
                        strval(either(result.get(c"previousTaskId")?, text(f, "unbound")?)?)?
                    ),
                )?],
            )?;
            let out = spread(result)?;
            out.set(c"task", super::view::render(o, t)?)?;
            send(res(f)?, None, out)
        },
    )
}
fn run(f: L<'_>) -> Result<L<'_>> {
    let Some((_, t)) = find(f)? else {
        return error(res(f)?, 404, "task not found", false);
    };
    then(
        super::schedule::fire(root(f)?, t, text(f, "manual")?, null(f)?)?,
        f,
        |f, r| send(res(f)?, None, r),
    )
}
fn calendar(f: L<'_>) -> Result<L<'_>> {
    let o = root(f)?;
    let month = strval(either(req(f)?.get(c"query")?.get(c"month")?, text(f, "")?)?)?;
    let tasks = value(o.get(c"tasks")?)?;
    let at = now(o)?.number()? as i64;
    let (first, following) = match multicc_core::recurring::calendar_month(&month) {
        Ok(bounds) => bounds,
        Err(message) => return error(res(f)?, 400, message, false),
    };
    let zone = super::timezone::snapshot(
        f,
        first
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis(),
        following
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis(),
    )?;
    let work = work(f, move || {
        let (status, body) = multicc_core::recurring::calendar(&tasks, &month, at, &zone)
            .map_err(napi::Error::from_reason)?;
        multicc_core::js::json_stringify(&V::object(vec![
            ("status", V::Number(status as f64)),
            ("body", body),
        ]))
        .ok_or_else(|| napi::Error::from_reason("invalid calendar"))
    })?;
    then(work, f, |f, v| {
        let result = json_parse(f, &strval(v)?)?;
        let status = result.get(c"status")?.number()? as i32;
        send(
            res(f)?,
            if status == 200 { None } else { Some(status) },
            result.get(c"body")?,
        )
    })
}
fn handle(f: L<'_>) -> Result<L<'_>> {
    match strval(f.get(c"op")?)?.as_str() {
        "list" => then(super::binding::migrated(root(f)?)?, f, |f, _| {
            let o = root(f)?;
            let out = array(f)?;
            o.get(c"tasks")?
                .for_each(|t| append(out, super::view::render(o, t)?))?;
            send(res(f)?, None, out)
        }),
        "calendar" => then(super::binding::migrated(root(f)?)?, f, |f, _| calendar(f)),
        "create" => create(f),
        "patch" => patch(f),
        "delete" => delete(f),
        "runs" => runs(f),
        "rebind" => rebind(f),
        "run" => run(f),
        _ => unreachable!(),
    }
}
pub(super) fn mount<'a>(o: L<'a>, app: L<'a>) -> Result<L<'a>> {
    for (verb, path, op, asynchronous) in [
        (c"get", "/api/cron", "list", true),
        (c"post", "/api/cron", "create", true),
        (c"patch", "/api/cron/:id", "patch", false),
        (c"delete", "/api/cron/:id", "delete", false),
        (c"post", "/api/cron/:id/rebind", "rebind", true),
        (c"post", "/api/cron/:id/run", "run", true),
        (c"get", "/api/cron/:id/runs", "runs", false),
        (c"get", "/api/cron/calendar", "calendar", true),
    ] {
        let route = fields(o, &[("owner", o), ("op", text(o, op)?)])?;
        let handler = function(
            route,
            "",
            if asynchronous { 3 } else { 2 },
            3,
            move |r, a| {
                let f = fields(
                    r,
                    &[
                        ("owner", root(r)?),
                        ("op", r.get(c"op")?),
                        ("req", a[0]),
                        ("res", a[1]),
                        ("next", a[2]),
                    ],
                )?;
                if asynchronous {
                    let p = then(resolve(undefined(f)?)?, f, |f, _| handle(f))?;
                    caught(p, f, |f, e| f.get(c"next")?.call_plain(&[e]))
                } else {
                    handle(f)
                }
            },
        )?;
        call(app, verb, &[text(o, path)?, handler])?;
    }
    undefined(o)
}
