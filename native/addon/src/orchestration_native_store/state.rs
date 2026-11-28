use super::*;
const NAMES: [(&CStr, &CStr); 3] = [
    (c"pendingQuestion", c"pendingQuestionJson"),
    (c"activeTurn", c"activeTurnJson"),
    (c"category", c"categoryJson"),
];
fn convert(v: L<'_>, decode: bool, keep: bool) -> Result<L<'_>> {
    let out = if keep { spread(v)? } else { fields(v, &[])? };
    for (field, raw) in NAMES {
        let (from, to) = if decode { (raw, field) } else { (field, raw) };
        let x = v.get(from)?;
        out.delete(from)?;
        out.set(to, if decode { parse(x)? } else { json(x)? })?;
    }
    Ok(out)
}
fn response(v: L<'_>) -> Result<L<'_>> {
    if !v.get(c"snapshot")?.truthy()? {
        return Ok(v);
    }
    let out = spread(v)?;
    out.set(c"snapshot", convert(v.get(c"snapshot")?, true, true)?)?;
    let target = v.get(c"targetSnapshot")?;
    if target.truthy()? {
        out.set(c"targetSnapshot", convert(target, true, true)?)?
    }
    let q = v.get(c"questionJson")?;
    if q.kind()? == sys::ValueType::napi_string {
        out.set(c"question", parse(q)?)?
    }
    out.set(c"notification", parse(v.get(c"notificationJson")?)?)?;
    Ok(out)
}
fn question_attempt(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    let req = f.get(c"req")?;
    let prepare = f.get(c"prepare")?;
    if prepare.truthy()? {
        let patch = prepare.call_plain(&[req.get(c"sessionId")?])?;
        call(s.global()?.get(c"Object")?, c"assign", &[req, patch])?;
    }
    let p = request_async(
        s,
        "sessionWorkQuestionExperimental",
        fields(s, &[("requestJson", json(req)?)])?,
    )?;
    let ok = cb(f, 1, |_, a| response(a[0]))?;
    let fail = cb(f, 1, |f, a| {
        if !question::backfill_missing(a[0], f.get(c"req")?, f.get(c"backfill")?)? {
            return Err(a[0].throw_error());
        }
        let n = f.get(c"attempt")?.number()? + 1.;
        if n == 3. {
            return Err(error(f, "session_work_question_initialization_failed")?.throw_error());
        }
        f.set(c"attempt", num(f, n)?)?;
        question_attempt(f)
    })?;
    call(p, c"then", &[ok, fail])
}
pub(super) fn install(s: L<'_>, api: L<'_>) -> Result<()> {
    attach(s, api, "sessionWorkQuestion", 3, 3, |s, a| {
        let raw = match json(a[0]) {
            Ok(raw) => raw,
            Err(e) => return async_result(s, || Err(e)),
        };
        for (v, msg) in [
            (a[1], "session work backfill must be a function"),
            (a[2], "session work preparation must be a function"),
        ] {
            if !v.undefined()? && !is_func(v)? {
                return async_result(s, || Err(s.type_error(msg)));
            }
        }
        let f = frame(
            s,
            &[
                ("raw", raw),
                ("backfill", a[1]),
                ("prepare", a[2]),
                ("attempt", num(s, 0.)?),
            ],
        )?;
        enqueue(f, |f| {
            ensure_open(f.get(c"s")?)?;
            f.set(c"req", parse(f.get(c"raw")?)?)?;
            question_attempt(f)
        })
    })?;
    attach(s, api, "sessionWorkQuestionSync", 1, 1, |s, a| {
        ensure_open(s)?;
        if context(s)?.truthy()? {
            return Err(unavailable(
                s,
                "session work question writes are not allowed inside a draft callback",
            ));
        }
        if pending(s)? {
            return Err(unavailable(s, "session work owner has pending operations"));
        }
        response(request(
            s,
            "sessionWorkQuestionExperimental",
            fields(s, &[("requestJson", json(a[0])?)])?,
        )?)
    })?;
    attach(s, api, "sessionWorkStateSync", 2, 2, |s, a| {
        ensure_open(s)?;
        let ctx = context(s)?;
        let has_ctx = ctx.truthy()?;
        let initialize = !a[1].undefined()?;
        if has_ctx && initialize {
            return Err(unavailable(
                s,
                "session work initialization is not allowed inside a draft callback",
            ));
        }
        if !has_ctx && pending(s)? {
            return Err(unavailable(s, "session work owner has pending operations"));
        }
        let input = state_input(s, a[0], a[1])?;
        let r = if has_ctx && ctx.get(c"tracked")?.truthy()? && ctx.get(c"detached")?.truthy()? {
            request(
                s,
                "readTrackedDraft",
                fields(
                    s,
                    &[
                        ("operation", text(s, "sessionWorkState")?),
                        ("token", ctx.get(c"token")?),
                        ("input", input),
                    ],
                )?,
            )?
        } else {
            request(s, "sessionWorkState", input)?
        };
        convert(r, true, true)
    })?;
    attach(s, api, "sessionWorkStateReadOrInitialize", 2, 2, |s, a| {
        if a[0].kind()? != sys::ValueType::napi_string || !is_func(a[1])? {
            return async_result(s, || {
                Err(s.type_error("session work read requires a session id and backfill"))
            });
        }
        let f = frame(s, &[("sessionId", a[0]), ("backfill", a[1])])?;
        enqueue(f, |f| {
            let s = f.get(c"s")?;
            ensure_open(s)?;
            let p = request_async(
                s,
                "sessionWorkState",
                state_input(s, f.get(c"sessionId")?, undefined(s)?)?,
            )?;
            yes(f, p, |f, r| {
                if r.get(c"exists")?.truthy()? {
                    return convert(r, true, true);
                }
                let s = f.get(c"s")?;
                let id = f.get(c"sessionId")?;
                let initial = f.get(c"backfill")?.call_plain(&[id])?;
                yes(
                    s,
                    request_async(s, "sessionWorkState", state_input(s, id, initial)?)?,
                    |_, r| convert(r, true, true),
                )
            })
        })
    })?;
    attach(s, api, "sessionWorkState", 1, 1, |s, a| {
        let captured = match capture(a[0]) {
            Ok(x) => x,
            Err(e) => return async_result(s, || Err(e)),
        };
        enqueue(frame(s, &[("captured", captured)])?, |f| {
            let s = f.get(c"s")?;
            ensure_open(s)?;
            let req = f.get(c"captured")?;
            let action = req.get(c"action")?;
            if action.is_string("readOrInitializeBatch")? {
                let p = request_async(s, "sessionWorkState", req)?;
                return yes(f, p, |_, r| decode_many(r));
            }
            let r = request(s, "sessionWorkState", req)?;
            if action.is_string("write")? {
                decode_many(r)
            } else {
                convert(r, true, true)
            }
        })
    })
}
fn state_input<'a>(s: L<'a>, id: L<'a>, initial: L<'a>) -> Result<L<'a>> {
    let input = fields(
        s,
        &[
            ("sessionId", id),
            (
                "action",
                text(
                    s,
                    if initial.undefined()? {
                        "read"
                    } else {
                        "readOrInitialize"
                    },
                )?,
            ),
            ("encoding", text(s, "json")?),
        ],
    )?;
    if !initial.undefined()? {
        input.set(c"initial", convert(initial, false, false)?)?
    }
    Ok(input)
}
fn decode_many(r: L<'_>) -> Result<L<'_>> {
    let list = r.get(c"snapshots")?;
    let out = array(r, &[])?;
    for i in 0..list.get(c"length")?.number()? as u32 {
        out.set_element(i, convert(list.element(i)?, true, true)?)?
    }
    fields(r, &[("snapshots", out)])
}
fn capture(input: L<'_>) -> Result<L<'_>> {
    let c = parse(json(input)?)?;
    c.set(c"encoding", text(c, "json")?)?;
    let action = c.get(c"action")?;
    if action.is_string("readOrInitialize")? {
        c.set(c"initial", convert(c.get(c"initial")?, false, true)?)?
    }
    if action.is_string("readOrInitializeBatch")? {
        let list = c.get(c"entries")?;
        for i in 0..list.get(c"length")?.number()? as u32 {
            let e = list.element(i)?;
            e.set(c"initial", convert(e.get(c"initial")?, false, true)?)?
        }
    }
    if action.is_string("write")? {
        let list = c.get(c"updates")?;
        for i in 0..list.get(c"length")?.number()? as u32 {
            list.set_element(i, convert(list.element(i)?, false, true)?)?
        }
    }
    if action.is_string("patch")? {
        if has(c, "initial")? {
            c.set(c"initial", convert(c.get(c"initial")?, false, true)?)?
        }
        let patch = c.get(c"patch")?;
        for (field, raw) in NAMES {
            if has(patch, field.to_str().unwrap())? {
                patch.set(raw, json(patch.get(field)?)?)?;
                patch.delete(field)?
            }
        }
    }
    Ok(c)
}
