use super::*;

pub(super) fn clear<'a>(p: L<'a>, id: L<'a>, msg: L<'a>, state: L<'a>) -> Result<L<'a>> {
    if msg.optional(c"preserveHistory")?.is_true()? {
        return rotation::rotate(p, id, state);
    }
    let f = frame(p, id)?;
    mapped(
        f,
        || {
            let key = string(id)?;
            f.set(c"id", key)?;
            f.set(c"state", state)?;
            let keep = fallback(msg.optional(c"keep")?, V::from("0"))?;
            let parsed = f
                .global()?
                .get(c"parseInt")?
                .call_plain(&[keep, num(f, 10.)?])?;
            let keep = num(f, parsed.number()?.max(0.))?;
            let pending = driver::mutate(p, key, text(f, "clear")?, array(f, &[keep])?)?;
            then(f, pending, |f, result| {
                let p = f.get(c"ports")?;
                let id = f.get(c"id")?;
                let page = run(
                    p,
                    "paginate",
                    &[id, fields(f, &[("limit", p.get(c"pageSize")?)])?],
                )?;
                let msgs = p
                    .get(c"replay")?
                    .call_plain(&[page.get(c"messages")?, f.get(c"state")?])?;
                let event = fields(
                    f,
                    &[
                        ("type", text(f, "chat_history_reset")?),
                        ("messages", msgs),
                        ("hasMore", page.get(c"hasMore")?),
                    ],
                )?;
                if page.get(c"byteBudgetTruncated")?.is_true()? {
                    event.set(c"byteBudgetTruncated", flag(f, true)?)?;
                }
                let obj = f.global()?.get(c"Object")?;
                call(obj, c"assign", &[event, result])?;
                event.set(c"displayOnly", flag(f, true)?)?;
                call(deps(p)?, c"chatBroadcast", &[id, event])?;
                let out = call(obj, c"assign", &[fields(f, &[])?, result])?;
                out.set(c"clearedNativeSessions", num(f, 0.)?)?;
                out.freeze()
            })
        },
        "chat_history_clear_failed",
        "chat history clear failed",
        "CHAT_HISTORY_CLEAR_FAILED",
    )
}
fn page<'a>(f: L<'a>, query: L<'a>) -> Result<L<'a>> {
    let id = f.get(c"id")?;
    let opts = fields(
        f,
        &[(
            "includeHidden",
            flag(f, query.get(c"historyScope")?.is_string("archive")?)?,
        )],
    )?;
    for key in [c"before", c"around", c"limit"] {
        let v = query.get(key)?;
        opts.set(key, if v.truthy()? { string(v)? } else { v })?;
    }
    let page = run(f.get(c"ports")?, "paginate", &[id, opts])?;
    let out = fields(
        f,
        &[
            ("messages", page.get(c"messages")?),
            ("hasMore", page.get(c"hasMore")?),
        ],
    )?;
    if page.get(c"byteBudgetTruncated")?.is_true()? {
        out.set(c"byteBudgetTruncated", flag(f, true)?)?;
    }
    if query.get(c"around")?.truthy()? {
        for key in [c"found", c"hasNewer"] {
            out.set(key, flag(f, page.get(key)?.is_true()?)?)?;
        }
    }
    send(f.get(c"res")?, None, out)
}
fn context<'a>(f: L<'a>, rec: L<'a>, query: L<'a>) -> Result<L<'a>> {
    let p = f.get(c"ports")?;
    let d = deps(p)?;
    let res = f.get(c"res")?;
    let yes = flag(f, true)?;
    let no = flag(f, false)?;
    if !callable(d.get(c"cwdForSession")?)? {
        return send(
            res,
            None,
            fields(
                f,
                &[
                    ("ok", yes),
                    ("supported", no),
                    ("reason", text(f, "no-cwd-resolver")?),
                ],
            )?,
        );
    }
    let cli = rec.get(c"cli")?;
    if cli.is_string("opencode")? {
        let mut sid = rec.get(c"_streamSessionId")?;
        if !sid.truthy()? {
            sid = fallback(rec.get(c"cliSessionId")?, V::Null)?;
        }
        let pending = p
            .get(c"readOpencode")?
            .call_plain(&[sid, fallback(rec.get(c"model")?, V::Null)?])?;
        return then(f, pending, |f, r| {
            send(
                f.get(c"res")?,
                None,
                fields(
                    f,
                    &[
                        ("ok", flag(f, true)?),
                        ("supported", flag(f, true)?),
                        ("cli", text(f, "opencode")?),
                        ("native", r),
                    ],
                )?,
            )
        });
    }
    if !cli.is_string("claude")? && !cli.is_string("claude-exp")? {
        return send(
            res,
            None,
            fields(
                f,
                &[
                    ("ok", yes),
                    ("supported", no),
                    ("reason", text(f, "cli-not-claude")?),
                    ("cli", fallback(cli, V::Null)?),
                ],
            )?,
        );
    }
    let prune = p.get(c"pruning")?.call_plain(&[])?;
    let cwd = call(d, c"cwdForSession", &[rec])?;
    let file = prune
        .get(c"findSessionClaudeFile")?
        .call_plain(&[cwd, rec])?;
    let tr = prune.get(c"measureFile")?.call_plain(&[file])?;
    let out = fields(
        f,
        &[
            ("ok", yes),
            ("supported", yes),
            ("cli", cli),
            ("transcript", tr),
        ],
    )?;
    let stream = d.get(c"chatStream")?;
    let status = stream.get(c"status")?;
    if callable(status)? {
        let s = status.call(stream, &[f.get(c"id")?])?;
        if s.truthy()? {
            let process = fields(f, &[])?;
            for k in [c"alive", c"busy", c"recycleRequested"] {
                process.set(k, flag(f, s.get(k)?.is_true()?)?)?;
            }
            out.set(c"process", process)?;
        }
    }
    if tr.get(c"found")?.truthy()? {
        let plan = query.get(c"plan")?;
        if plan.is_string("1")? || plan.is_string("true")? {
            let report = prune
                .get(c"pruneFile")?
                .call_plain(&[file, fields(f, &[("dryRun", yes), ("force", yes)])?])?;
            let public = if report.truthy()? {
                let x = call(
                    f.global()?.get(c"Object")?,
                    c"assign",
                    &[fields(f, &[])?, report],
                )?;
                call(
                    f.global()?.get(c"Reflect")?,
                    c"deleteProperty",
                    &[x, text(f, "file")?],
                )?;
                x
            } else {
                null(f)?
            };
            out.set(c"plan", public)?;
        }
    }
    send(res, None, out)
}
fn failed<'a>(f: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    run(
        f.get(c"ports")?,
        "logFailure",
        &[f.get(c"logEvent")?, reason, f.get(c"id")?],
    )?;
    let next = f.get(c"next")?;
    if callable(next)? {
        return next.call_plain(&[f
            .global()?
            .get(c"Error")?
            .construct(&[text(f, "chat history operation failed")?])?]);
    }
    send(
        f.get(c"res")?,
        Some(500),
        fields(f, &[("error", f.get(c"failure")?)])?,
    )
}
pub(super) fn handle<'a>(p: L<'a>, name: &str, a: &[L<'a>]) -> Result<L<'a>> {
    let req = a[0];
    let res = a[1];
    let invoke = || {
        let params = req.get(c"params")?;
        let id = params.get(c"id")?;
        let rec = call(deps(p)?.get(c"persistedSessions")?, c"get", &[id])?;
        if !rec.truthy()? {
            return error(res, 404, "session not found", false);
        }
        let f = frame(p, id)?;
        f.set(c"res", res)?;
        f.set(c"next", a[2])?;
        let (event, message) = match name {
            "historyPage" => ("chat_history_page_failed", "chat history load failed"),
            "deleteMessage" => ("chat_history_delete_failed", "chat history delete failed"),
            _ => ("context_level_failed", "context level failed"),
        };
        f.set(c"logEvent", text(f, event)?)?;
        f.set(c"failure", text(f, message)?)?;
        if name == "historyPage" {
            return page(f, req.get(c"query")?).or_else(|e| failed(f, caught(f, e)?));
        }
        let pending = async_result(f, || {
            if name == "contextLevel" {
                return context(f, rec, req.get(c"query")?);
            }
            let msg = params.get(c"msgId")?;
            f.set(c"params", params)?;
            let pending = driver::mutate(p, id, text(f, "remove")?, array(f, &[msg])?)?;
            then(f, pending, |f, removed| {
                let res = f.get(c"res")?;
                if !removed.truthy()? {
                    return error(res, 404, "message not found", false);
                }
                let event = fields(
                    f,
                    &[
                        ("type", text(f, "chat_msg_deleted")?),
                        ("id", f.get(c"params")?.get(c"msgId")?),
                        ("displayOnly", flag(f, true)?),
                    ],
                )?;
                call(
                    deps(f.get(c"ports")?)?,
                    c"chatBroadcast",
                    &[f.get(c"id")?, event],
                )?;
                send(res, None, fields(f, &[("ok", flag(f, true)?)])?)
            })
        })?;
        call(pending, c"catch", &[continuation(f, failed)?])
    };
    if name == "historyPage" {
        invoke()
    } else {
        async_result(p, invoke)
    }
}
