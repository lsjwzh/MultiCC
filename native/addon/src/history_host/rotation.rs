use super::*;
use multicc_core::chat_context_rotation;

fn record<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    call(deps(p)?.get(c"persistedSessions")?, c"get", &[id])
}
fn facts<'a>(d: L<'a>, id: L<'a>, rec: L<'a>) -> Result<L<'a>> {
    let exists = rec.truthy()?;
    let kind = fallback(rec.optional(c"kind")?, V::from(""))?;
    let out = fields(
        d,
        &[
            ("exists", flag(d, exists)?),
            ("kind", string(kind)?),
            ("pending", null(d)?),
            ("rotationReady", flag(d, false)?),
            ("runState", text(d, "running")?),
            ("backgroundCount", num(d, 0.)?),
        ],
    )?;
    if !exists || (kind.truthy()? && !kind.is_string("chat")?) {
        return Ok(out);
    }
    let handoff = rec.get(c"pendingCliHandoff")?;
    if handoff.optional(c"status")?.is_string("pending")? {
        let reason = handoff.get(c"reason")?;
        out.set(
            c"pending",
            fields(
                d,
                &[
                    ("id", handoff.get(c"id")?),
                    ("status", text(d, "pending")?),
                    (
                        "reason",
                        if reason.undefined()? {
                            null(d)?
                        } else {
                            string(reason)?
                        },
                    ),
                ],
            )?,
        )?;
        return Ok(out);
    }
    let ready = callable(d.get(c"getSessionRunState")?)?
        && callable(d.get(c"getActiveBackgroundTasks")?)?
        && callable(d.get(c"sessionPersistence")?.optional(c"mutate")?)?;
    out.set(c"rotationReady", flag(d, ready)?)?;
    if ready {
        out.set(c"runState", string(call(d, c"getSessionRunState", &[id])?)?)?;
        let bg = call(d, c"getActiveBackgroundTasks", &[id])?;
        if bg.is_array()? {
            out.set(c"backgroundCount", bg.get(c"length")?)?;
        }
    }
    Ok(out)
}
fn request<'a>(op: &str, input: L<'a>) -> Result<L<'a>> {
    let json = input.global()?.get(c"JSON")?;
    let data = call(json, c"stringify", &[input])?
        .coerce_string()?
        .to_string_lossy();
    let output = chat_context_rotation::request(op, &data).map_err(napi::Error::from_reason)?;
    call(json, c"parse", &[text(input, &output)?])
}
fn apply<'a>(f: L<'a>, plan: L<'a>) -> Result<L<'a>> {
    let d = deps(f.get(c"ports")?)?;
    let id = f.get(c"id")?;
    let mut cleared = undefined(f)?;
    plan.get(c"effects")?.for_each(|effect| {
        let kind = effect.get(c"type")?;
        if kind.is_string("broadcast")? {
            let event = effect.get(c"event")?;
            if event.get(c"type")?.is_string("native_context_rotated")?
                && !event.get(c"reused")?.is_true()?
            {
                event.set(
                    c"clearedNativeSessions",
                    if cleared.undefined()? {
                        null(f)?
                    } else {
                        cleared
                    },
                )?;
            }
            call(d, c"chatBroadcast", &[id, event])?;
        } else if kind.is_string("mutate")? {
            f.set(c"handoff", plan.get(c"handoff")?)?;
            let write = function(f, "", 0, 0, |f, _| {
                let d = deps(f.get(c"ports")?)?;
                let rec = f.get(c"record")?;
                let count = call(d, c"clearAllNativeCliStates", &[rec])?;
                rec.assign(c"pendingCliHandoff", f.get(c"handoff")?)?;
                call(d, c"rememberActiveCliState", &[rec])?;
                Ok(count)
            })?;
            cleared = call(
                d.get(c"sessionPersistence")?,
                c"mutate",
                &[effect.get(c"operation")?, write],
            )?;
        } else if kind.is_string("closeStream")? {
            call(d.get(c"chatStream")?, c"close", &[id])?;
        } else if kind.is_string("zeroChatTurnCount")? {
            let state = f.get(c"state")?;
            if state.truthy()? {
                state.assign(c"chatTurnCount", num(f, 0.)?)?;
            }
        }
        Ok(())
    })?;
    if !plan.get(c"ok")?.is_true()? {
        return fields(f, &[("ok", flag(f, false)?), ("code", plan.get(c"code")?)])?.freeze();
    }
    let reused = plan.get(c"reused")?.is_true()?;
    fields(
        f,
        &[
            ("ok", flag(f, true)?),
            ("reused", flag(f, reused)?),
            ("checkpointId", plan.get(c"checkpointId")?),
            (
                "clearedNativeSessions",
                if reused { num(f, 0.)? } else { cleared },
            ),
        ],
    )?
    .freeze()
}
fn checked<'a>(f: L<'a>, rec: L<'a>) -> Result<std::result::Result<L<'a>, L<'a>>> {
    let p = f.get(c"ports")?;
    let id = f.get(c"id")?;
    let facts = facts(deps(p)?, id, rec)?;
    let verdict = request("decision", facts)?;
    if !verdict.get(c"ok")?.is_true()? || verdict.get(c"reused")?.is_true()? {
        return Ok(Err(apply(f, verdict)?));
    }
    if !rec.equals(f.get(c"record")?)? {
        let code = text(f, "session_changed")?;
        call(
            deps(p)?,
            c"chatBroadcast",
            &[
                id,
                fields(
                    f,
                    &[
                        ("type", text(f, "native_context_rotation_rejected")?),
                        ("code", code),
                    ],
                )?,
            ],
        )?;
        return Ok(Err(
            fields(f, &[("ok", flag(f, false)?), ("code", code)])?.freeze()?
        ));
    }
    Ok(Ok(facts))
}
fn checkpoint<'a>(f: L<'a>, git: L<'a>, cli: L<'a>) -> Result<L<'a>> {
    let p = f.get(c"ports")?;
    let d = deps(p)?;
    let rec = f.get(c"record")?;
    let id = f.get(c"id")?;
    if d.get(c"buildHandoffCheckpoint")?
        .equals(p.get(c"defaultCheckpoint")?)?
    {
        let session = fields(
            f,
            &[
                ("taskState", rec.get(c"taskState")?),
                ("summary", rec.get(c"summary")?),
            ],
        )?;
        let built = call(
            p.get(c"service")?,
            c"handoffCheckpoint",
            &[id, fields(f, &[("session", session)])?],
        )?;
        let date = f
            .global()?
            .get(c"Date")?
            .construct(&[p.get(c"now")?.call_plain(&[])?])?;
        fields(
            f,
            &[
                ("version", num(f, 1.)?),
                ("createdAt", call(date, c"toISOString", &[])?),
                ("fromCli", cli),
                ("toCli", cli),
                ("task", built.get(c"task")?),
                ("git", fallback(git, V::Null)?),
                ("transcript", built.get(c"transcript")?),
            ],
        )
    } else {
        let history = run(p, "load", &[id])?;
        call(
            d,
            c"buildHandoffCheckpoint",
            &[fields(
                f,
                &[
                    ("session", rec),
                    ("fromCli", cli),
                    ("toCli", cli),
                    ("history", history),
                    ("git", git),
                ],
            )?],
        )
    }
}
pub(super) fn rotate<'a>(p: L<'a>, id: L<'a>, state: L<'a>) -> Result<L<'a>> {
    let f = frame(p, id)?;
    mapped(
        f,
        || {
            let id = string(id)?;
            f.set(c"id", id)?;
            f.set(c"state", state)?;
            let rec = record(p, id)?;
            f.set(c"record", rec)?;
            if let Err(result) = checked(f, rec)? {
                return Ok(result);
            }
            // Custom builders historically open the transcript before asking Git.
            // Prime the owner's cache without cloning; take the copy at commit.
            if !deps(p)?
                .get(c"buildHandoffCheckpoint")?
                .equals(p.get(c"defaultCheckpoint")?)?
            {
                run(p, "viewHistory", &[id])?;
            }
            then(
                f,
                call(deps(p)?, c"cliSwitchGitSnapshot", &[rec])?,
                |f, git| {
                    let p = f.get(c"ports")?;
                    let id = f.get(c"id")?;
                    let rec = record(p, id)?;
                    if let Err(result) = checked(f, rec)? {
                        return Ok(result);
                    }
                    let mut cli = f.get(c"state")?.optional(c"cli")?;
                    if !cli.truthy()? {
                        cli = rec.get(c"cli")?;
                    }
                    let checkpoint = checkpoint(f, git, cli)?;
                    let bytes = p.get(c"randomBytes")?.call_plain(&[num(f, 8.)?])?;
                    let hex = call(bytes, c"toString", &[text(f, "hex")?])?;
                    let facts = match checked(f, record(p, id)?)? {
                        Ok(v) => v,
                        Err(result) => return Ok(result),
                    };
                    facts.set(
                        c"cli",
                        if cli.nullish()? {
                            text(f, "")?
                        } else {
                            string(cli)?
                        },
                    )?;
                    facts.set(c"checkpoint", checkpoint)?;
                    facts.set(c"randomHex", hex)?;
                    apply(f, request("commit", facts)?)
                },
            )
        },
        "native_context_rotation_failed",
        "native context rotation failed",
        "NATIVE_CONTEXT_ROTATION_FAILED",
    )
}
