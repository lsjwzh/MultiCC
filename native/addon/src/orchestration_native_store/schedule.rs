use super::*;
fn decoded<'a>(s: L<'a>, r: L<'a>, admit: bool) -> Result<L<'a>> {
    revision(s, r)?;
    let wire = r.optional(c"resultJson")?;
    if wire.kind()? != sys::ValueType::napi_string {
        return Ok(r);
    }
    let out = parse(wire)?;
    if admit {
        let value = spread(out)?;
        value.set(c"snapshot", r.get(c"snapshot")?)?;
        Ok(value)
    } else {
        Ok(out)
    }
}
fn asynchronous<'a>(s: L<'a>, op: &CStr, input: L<'a>, admit: bool) -> Result<L<'a>> {
    let native = s.get(c"ports")?.get(c"native")?;
    let p = call(native, op, &[s.get(c"handle")?, input])
        .map_err(|err| rethrow(s, err, |e| transport::normalize(s, e)))?;
    let ok = cb(s, 1, move |s, a| decoded(s, a[0], admit))?;
    let bad = cb(s, 1, |s, a| {
        Err(transport::normalize(s, a[0])?.throw_error())
    })?;
    call(p, c"then", &[ok, bad])
}
fn recover_owned<'a>(s: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let mut result = request(
        s,
        "scheduleRecoverOwnedPrepareExperimental",
        fields(s, &[("entries", array(s, &[])?)])?,
    )?;
    let sessions = result.get(c"sessions")?;
    if sessions.get(c"length")?.positive()? {
        let entries = array(s, &[])?;
        for i in 0..sessions.get(c"length")?.number()? as u32 {
            entries.set_element(i, call(input, c"capture", &[sessions.element(i)?])?)?
        }
        result = request(
            s,
            "scheduleRecoverOwnedPrepareExperimental",
            fields(s, &[("entries", entries)])?,
        )?;
        let missing = result.get(c"sessions")?;
        if missing.get(c"length")?.positive()? {
            return Err(error(
                s,
                &format!(
                    "schedule recovery backfill refused: {}",
                    string_value(call(missing, c"join", &[text(s, ", ")?])?)?
                ),
            )?
            .throw_error());
        }
    }
    let req = fields(
        s,
        &[
            ("expectedRevision", result.get(c"state")?.get(c"revision")?),
            ("expectedDataVersion", result.get(c"dataVersion")?),
            ("at", input.get(c"at")?),
            ("updatedAt", input.get(c"updatedAt")?),
            ("facts", result.get(c"facts")?),
        ],
    )?;
    let r = request(s, "scheduleRecoverOwnedCommitExperimental", req)?;
    revision(s, r)?;
    Ok(r)
}
fn reorder<'a>(s: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let req = fields(
        s,
        &[
            ("sessionId", input.get(c"sessionId")?),
            ("entryId", input.get(c"entryId")?),
        ],
    )?;
    let guard = request(s, "scheduleReorderCheck", req)?;
    let ok = guard.get(c"ok")?.truthy()?;
    let ensured = if ok || guard.get(c"scheduleObserved")?.truthy()? {
        num(s, call(input, c"now", &[])?.explicit_number()?)?
    } else {
        null(s)?
    };
    if !ok && !guard.get(c"scheduleMissing")?.truthy()? {
        return fields(s, &[("ok", flag(s, false)?), ("code", guard.get(c"code")?)]);
    }
    let captured = fields(
        s,
        &[
            ("sessionId", input.get(c"sessionId")?),
            ("entryId", input.get(c"entryId")?),
            ("ensuredAt", ensured),
        ],
    )?;
    if ok {
        let index = input.get(c"toIndex")?.explicit_number()?;
        let at = num(s, call(input, c"now", &[])?.explicit_number()?)?;
        captured.set(
            c"toIndex",
            if index.is_finite() {
                num(s, index)?
            } else {
                null(s)?
            },
        )?;
        captured.set(c"direction", input.get(c"direction")?)?;
        let actor = input.get(c"actor")?;
        captured.set(
            c"actorJson",
            json(string(if actor.truthy()? {
                actor
            } else {
                text(s, "user")?
            })?)?,
        )?;
        captured.set(c"at", at)?;
    } else {
        captured.set(c"at", ensured)?;
    }
    let init = input.get(c"initialState")?;
    if !init.undefined()? {
        captured.set(c"initialStateJson", json(init)?)?
    }
    captured.set(c"expectedRevision", s.get(c"revision")?)?;
    asynchronous(s, c"scheduleReorder", captured, false)
}
fn admission<'a>(s: L<'a>, raw: L<'a>, at: L<'a>) -> Result<L<'a>> {
    fields(
        s,
        &[
            ("requestJson", raw),
            ("expectedRevision", s.get(c"revision")?),
            ("now", if at.undefined()? { now(s)? } else { at }),
        ],
    )
}
fn complete(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    ensure_open(s)?;
    f.set(c"expected", s.get(c"revision")?)?;
    let task_json = json(f.get(c"task")?)?;
    let init = f.get(c"initialState")?;
    let req = fields(
        s,
        &[
            ("sessionId", f.get(c"sessionId")?),
            ("expectedTaskIdJson", task_json),
        ],
    )?;
    if !init.undefined()? {
        req.set(c"initialStateJson", json(init)?)?;
    }
    let token = request(s, "scheduleCompleteTokenExperimental", req)?;
    if !token.get(c"guard")?.get(c"ok")?.truthy()? {
        return token.get(c"guard");
    }
    f.set(c"token", token)?;
    f.set(c"req", req)?;
    f.set(
        c"at",
        num(s, f.get(c"clock")?.call_plain(&[])?.explicit_number()?)?,
    )?;
    let p = yes(f, resolve(undefined(s)?)?, |f, _| {
        let s = f.get(c"s")?;
        let token = f.get(c"token")?;
        let req = f.get(c"req")?;
        req.set(c"expectedRevision", f.get(c"expected")?)?;
        req.set(c"expectedVersion", token.get(c"snapshot")?.get(c"version")?)?;
        req.set(c"expectedDataVersion", token.get(c"dataVersion")?)?;
        req.set(c"at", f.get(c"at")?)?;
        req.set(c"updatedAt", now(s)?)?;
        for (raw, key) in [
            (c"reasonJson", c"reason"),
            (c"classifyStateJson", c"classifyState"),
            (c"awaitingRequestIdJson", c"awaitingRequestId"),
        ] {
            req.set(raw, json(f.get(key)?)?)?;
        }
        yes(
            s,
            request_async(s, "scheduleCompleteExperimental", req)?,
            |s, r| decoded(s, r, false),
        )
    })?;
    no(f, p, |f, err| {
        let s = f.get(c"s")?;
        if let Some(i) = s.catch(|| request(s, "info", fields(s, &[])?))? {
            revision(s, i)?;
        }
        let msg = err.optional(c"message")?;
        if string_value(if msg.truthy()? { msg } else { err })?
            == "schedule completion database version conflict"
        {
            return Err(s
                .get(c"deps")?
                .get(c"OrchestrationSqliteConflictError")?
                .construct(&[s.get(c"file")?, f.get(c"expected")?, s.get(c"revision")?])?
                .throw_error());
        }
        Err(transport::normalize(s, err)?.throw_error())
    })
}
pub(super) fn install(s: L<'_>, api: L<'_>) -> Result<()> {
    attach(s, api, "mutateSync", 2, 2, |s, a| {
        let owned = a[0].is_string("scheduleRecoverOwned")?;
        if !owned && !a[0].is_string("scheduleReorder")? {
            return Err(s.type_error("unknown synchronous domain command"));
        }
        enqueue(frame(s, &[("input", a[1])])?, move |f| {
            let s = f.get(c"s")?;
            ensure_open(s)?;
            let input = f.get(c"input")?;
            (if owned {
                recover_owned(s, input)
            } else {
                reorder(s, input)
            })
            .map_err(|err| rethrow(s, err, |e| transport::normalize(s, e)))
        })
    })?;
    for (name, op) in [
        ("executeScheduleClaim", "scheduleClaim"),
        ("executeScheduleHandoff", "scheduleHandoff"),
    ] {
        set(
            api,
            name,
            function(s, name, 2, 2, move |s, a| {
                enqueue(frame(s, &[("item", a[0]), ("clock", a[1])])?, move |f| {
                    let s = f.get(c"s")?;
                    ensure_open(s)?;
                    let i = f.get(c"item")?;
                    let req = fields(
                        s,
                        &[
                            ("sessionId", i.get(c"sessionId")?),
                            ("entryId", i.get(c"id")?),
                            ("leaseToken", i.get(c"leaseToken")?),
                        ],
                    )?;
                    if op == "scheduleClaim" {
                        req.set(c"lineageJson", json(i.get(c"turnLineage")?)?)?
                    }
                    req.set(
                        c"at",
                        num(s, f.get(c"clock")?.call_plain(&[])?.explicit_number()?)?,
                    )?;
                    req.set(c"updatedAt", now(s)?)?;
                    yes(s, request_async(s, op, req)?, |s, r| {
                        revision(s, r)?;
                        let raw = r.get(c"resultJson")?;
                        if raw.kind()? == sys::ValueType::napi_string {
                            parse(raw)
                        } else {
                            r.get(c"result")
                        }
                    })
                })
            })?,
        )?;
    }
    attach(s, api, "executeScheduleAdmit", 2, 2, |s, a| {
        let raw = match json(a[0]) {
            Ok(v) => v,
            Err(e) => return async_result(s, || Err(e)),
        };
        enqueue(frame(s, &[("raw", raw), ("at", a[1])])?, |f| {
            let s = f.get(c"s")?;
            ensure_open(s)?;
            asynchronous(
                s,
                c"scheduleAdmit",
                admission(s, f.get(c"raw")?, f.get(c"at")?)?,
                true,
            )
        })
    })?;
    attach(s, api, "executeScheduleAdmitSync", 2, 2, |s, a| {
        ensure_open(s)?;
        if context(s)?.truthy()? {
            return Err(error(
                s,
                "session work admission is not allowed inside a draft callback",
            )?
            .throw_error());
        }
        if pending(s)? {
            return Err(error(s, "session work owner has pending operations")?.throw_error());
        }
        let r = request(s, "scheduleAdmit", admission(s, json(a[0])?, a[1])?)?;
        decoded(s, r, true)
    })?;
    attach(s, api, "executeScheduleComplete", 1, 1, |s, a| {
        let opts = a[0];
        let f = frame(
            s,
            &[
                ("sessionId", opts.get(c"sessionId")?),
                ("task", or_default(opts.get(c"expectedTaskId")?, null(s)?)?),
                (
                    "reason",
                    or_default(opts.get(c"reason")?, text(s, "successful")?)?,
                ),
                (
                    "classifyState",
                    or_default(opts.get(c"classifyState")?, text(s, "D")?)?,
                ),
                (
                    "awaitingRequestId",
                    or_default(opts.get(c"awaitingRequestId")?, null(s)?)?,
                ),
                ("initialState", opts.get(c"initialState")?),
                ("clock", opts.get(c"clock")?),
            ],
        )?;
        enqueue(f, complete)
    })
}
