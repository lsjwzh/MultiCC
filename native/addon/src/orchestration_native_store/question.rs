use super::*;

fn store(q: L<'_>) -> Result<L<'_>> {
    let s = q.get(c"getStore")?.call_plain(&[])?;
    if !is_func(s.optional(c"sessionWorkStateSync")?)?
        || !is_func(s.optional(c"sessionWorkQuestionSync")?)?
    {
        return Err(unavailable(q, "session_work_question_owner_unavailable"));
    }
    Ok(s)
}
pub(super) fn backfill_missing<'a>(e: L<'a>, req: L<'a>, read: L<'a>) -> Result<bool> {
    if !e
        .optional(c"code")?
        .is_string("ORCHESTRATION_SQLITE_ERROR")?
        || !read.truthy()?
    {
        return Ok(false);
    }
    let msg = e.get(c"message")?;
    for (message, field, session) in [
        (
            "question transition requires a trusted initial snapshot",
            "initialState",
            c"sessionId",
        ),
        (
            "question move requires a trusted target snapshot",
            "targetInitialState",
            c"targetSessionId",
        ),
    ] {
        if msg.is_string(message)? && !has(req, field)? {
            set(req, field, read.call_plain(&[req.get(session)?])?)?;
            return Ok(true);
        }
    }
    Ok(false)
}
fn transition<'a>(
    q: L<'a>,
    action: &str,
    id: L<'a>,
    fields: L<'a>,
    prepare: L<'a>,
    asynchronous: bool,
) -> Result<L<'a>> {
    let run = || {
        let s = store(q)?;
        if asynchronous && !is_func(s.get(c"sessionWorkQuestion")?)? {
            return Err(unavailable(q, "session_work_question_owner_unavailable"));
        }
        fields.set(c"action", text(q, action)?)?;
        fields.set(c"sessionId", id)?;
        fields.set(c"at", now(q)?)?;
        let init = q.get(c"initialState")?;
        if asynchronous {
            return call(s, c"sessionWorkQuestion", &[fields, init, prepare]);
        }
        for _ in 0..3 {
            match call(s, c"sessionWorkQuestionSync", &[fields]) {
                Ok(out) => return Ok(out),
                Err(err) => match s.exception_value()? {
                    Some(e) if backfill_missing(e, fields, init)? => continue,
                    Some(e) => return Err(e.throw_error()),
                    None => return Err(err),
                },
            }
        }
        Err(error(s, "session_work_question_initialization_failed")?.throw_error())
    };
    if asynchronous {
        async_result(q, run)
    } else {
        run()
    }
}
pub(super) fn create(options: L<'_>) -> Result<L<'_>> {
    let o = default_object(options)?;
    let q = fields(o, &[])?;
    for name in ["getStore", "initialState", "liveTurn", "now"] {
        let v = get(o, name)?;
        let v = if name == "now" {
            or_default(v, o.global()?.get(c"Date")?.get(c"now")?)?
        } else {
            v
        };
        if !is_func(v)? {
            return Err(o.type_error(&format!("[question-owner] {name} is required")));
        }
        set(q, name, v)?;
    }
    let api = fields(q, &[])?;
    attach(q, api, "read", 1, 1, |q, a| {
        let s = store(q)?;
        let r = call(s, c"sessionWorkStateSync", &[a[0]])?;
        if r.get(c"exists")?.truthy()? {
            Ok(r)
        } else {
            call(
                s,
                c"sessionWorkStateSync",
                &[a[0], q.get(c"initialState")?.call_plain(&[a[0]])?],
            )
        }
    })?;
    attach(q, api, "readAsync", 1, 1, |q, a| {
        let s = store(q)?;
        if !is_func(s.get(c"sessionWorkStateReadOrInitialize")?)? {
            return Err(unavailable(q, "session_work_question_owner_unavailable"));
        }
        call(
            s,
            c"sessionWorkStateReadOrInitialize",
            &[a[0], q.get(c"initialState")?],
        )
    })?;
    for (name, action, n, argc, asynchronous) in [
        ("record", "record", 1, 1, false),
        ("recordAsync", "record", 1, 1, true),
        ("beginTurn", "beginTurn", 1, 2, false),
        ("beginTurnAsync", "beginTurn", 1, 2, true),
        ("resolve", "resolve", 2, 3, false),
        ("resolveAsync", "resolve", 2, 3, true),
        ("patchFacts", "patchFacts", 1, 2, false),
        ("patchFactsAsync", "patchFacts", 1, 2, true),
        ("move", "move", 2, 3, false),
        ("moveAsync", "move", 2, 3, true),
        ("refreshTurnAsync", "patchFacts", 2, 2, true),
        ("refreshUnattendedAsync", "patchFacts", 2, 2, true),
    ] {
        set(
            api,
            name,
            function(q, name, n, argc, move |q, a| {
                let mut id = a[0];
                let f = fields(q, &[])?;
                let mut prepare = undefined(q)?;
                match name {
                    "record" | "recordAsync" => {
                        let session = || {
                            let v = a[0].get(c"sessionId")?;
                            string(if v.truthy()? { v } else { text(q, "")? })
                        };
                        id = session()?;
                        f.set(c"signal", a[0])?;
                        if !asynchronous {
                            f.set(
                                c"liveActiveTurn",
                                q.get(c"liveTurn")?.call_plain(&[session()?])?,
                            )?;
                        }
                    }
                    "beginTurn" | "beginTurnAsync" => {
                        let opts = default_object(a[1])?;
                        f.set(
                            c"originContinue",
                            or_default(opts.get(c"originContinue")?, flag(q, false)?)?,
                        )?;
                        f.set(c"turnId", opts.get(c"turnId")?)?;
                        if asynchronous {
                            let j = fields(q, &[("read", q.get(c"liveTurn")?), ("id", id)])?;
                            prepare = cb(j, 0, |j, _| {
                                fields(
                                    j,
                                    &[(
                                        "activeTurn",
                                        j.get(c"read")?.call_plain(&[j.get(c"id")?])?,
                                    )],
                                )
                            })?;
                        } else {
                            f.set(c"activeTurn", q.get(c"liveTurn")?.call_plain(&[id])?)?
                        }
                    }
                    "resolve" | "resolveAsync" => {
                        let opts = default_object(a[2])?;
                        f.set(c"requestId", a[1])?;
                        f.set(
                            c"dismissed",
                            or_default(opts.get(c"dismissed")?, flag(q, false)?)?,
                        )?;
                        if asynchronous {
                            let read = opts.get(c"readDismissFacts")?;
                            prepare = if read.truthy()? {
                                cb(read, 0, |read, _| {
                                    fields(read, &[("dismissFacts", read.call_plain(&[])?)])
                                })?
                            } else {
                                read
                            }
                        }
                    }
                    "patchFacts" | "patchFactsAsync" => {
                        let opts = default_object(a[1])?;
                        f.set(c"categoryPatch", opts.get(c"categoryPatch")?)?;
                        f.set(c"activeTurn", opts.get(c"activeTurn")?)?;
                    }
                    "move" | "moveAsync" => {
                        let opts = default_object(a[2])?;
                        f.set(c"targetSessionId", a[1])?;
                        for k in [c"turnId", c"taskId", c"expectedRequestId"] {
                            f.set(k, opts.get(k)?)?
                        }
                    }
                    "refreshTurnAsync" => {
                        prepare = cb(a[1], 0, |r, _| {
                            fields(r, &[("activeTurn", r.call_plain(&[])?)])
                        })?
                    }
                    _ => {
                        prepare = cb(a[1], 0, |r, _| {
                            let v = r.call_plain(&[])?;
                            fields(
                                r,
                                &[(
                                    "categoryPatch",
                                    fields(
                                        r,
                                        &[("unattended", if v.truthy()? { v } else { null(r)? })],
                                    )?,
                                )],
                            )
                        })?
                    }
                }
                transition(q, action, id, f, prepare, asynchronous)
            })?,
        )?;
    }
    api.freeze()
}
