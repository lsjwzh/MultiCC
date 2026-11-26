//! Commit the rule verdict before queuing best-effort attribution. A background
//! or indexing failure is diagnostic; a failed state write must reach the caller.
use super::*;
use std::ffi::CStr;

fn if_missing(value: L<'_>, default: V) -> Result<L<'_>> {
    if value.undefined()? {
        value.from_value(&default)
    } else {
        Ok(value)
    }
}
pub(super) fn has_task_id(opts: L<'_>) -> Result<bool> {
    let proto = opts.global()?.get(c"Object")?.get(c"prototype")?;
    proto
        .get(c"hasOwnProperty")?
        .call(opts, &[text(opts, "taskId")?])?
        .truthy()
}
fn warn<'a>(p: L<'a>, event: &str, session: L<'a>, error: napi::Error) -> Result<()> {
    let cause = match p.exception_value()? {
        Some(e) => e,
        None => p
            .global()?
            .get(c"Error")?
            .construct(&[text(p, &error.reason)?])?,
    };
    let logger = p.get(c"logger")?;
    let write = logger.get(c"warn")?;
    if !write.nullish()? {
        write.call(
            logger,
            &[
                text(p, event)?,
                fields(
                    p,
                    &[("sessionId", session), ("error", cause.get(c"message")?)],
                )?,
            ],
        )?;
    }
    Ok(())
}
pub(super) fn liveness<'a>(p: L<'a>, session: L<'a>) -> Result<L<'a>> {
    let found = p
        .catch(|| {
            let host = p.get(c"getLivenessRuntime")?.call_plain(&[])?;
            let value = call(host, c"ownership", &[session])?;
            let state = value.optional(c"state")?;
            Ok(
                if state.is_string("active")?
                    || state.is_string("inactive")?
                    || state.is_string("unknown")?
                {
                    Some(value)
                } else {
                    None
                },
            )
        })?
        .flatten();
    match found {
        Some(v) => Ok(v),
        None => fields(
            p,
            &[
                ("state", text(p, "unknown")?),
                ("reason", text(p, "liveness_unavailable")?),
            ],
        ),
    }
}
pub(super) fn cancel(cs: L<'_>) -> Result<L<'_>> {
    if cs.get(c"_classifyTimer")?.truthy()? {
        cs.global()?
            .get(c"clearTimeout")?
            .call_plain(&[cs.get(c"_classifyTimer")?])?;
        cs.assign(c"_classifyTimer", null(cs)?)?;
    }
    cs.from_value(&V::Undefined)
}
pub(super) fn end<'a>(p: L<'a>, cs: L<'a>, name: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let opts = if opts.undefined()? {
        fields(opts, &[])?
    } else {
        opts
    };
    let boundary = opts.get(c"classification")?;
    let turn = if_missing(opts.get(c"turnId")?, V::Null)?;
    let locked = if_missing(opts.get(c"identityLocked")?, V::Bool(false))?;
    let reason = opts.get(c"killReason")?;
    let reason = if reason.truthy()? {
        string(opts.get(c"killReason")?)?
    } else {
        null(p)?
    };
    cancel(cs)?;
    let persisted = call(p.get(c"persistedSessions")?, c"get", &[name])?;
    call(queue(p)?, c"cancelClassifyFor", &[name])?;
    if cs.truthy()? {
        cs.assign(c"_classifyTaskId", null(p)?)?;
    }
    let id = persisted.optional(c"id")?;
    let id = if id.truthy()? { id } else { name };
    let live = liveness(p, name)?;
    let signals = p.get(c"getUserInputSignalHost")?.call_plain(&[])?;
    let background = match p.get(c"hasBackgroundPending")?.call_plain(&[name]) {
        Ok(v) => v.is_true()?,
        Err(e) => {
            warn(p, "background_state_unavailable", name, e)?;
            false
        }
    };
    let pending = signals.get(c"pending")?.kind()? == sys::ValueType::napi_function
        && call(signals, c"pending", &[name])?.truthy()?;
    let facts = fields(
        p,
        &[
            ("liveness", live),
            (
                "boundary",
                fallback(boundary, "unknown-interruption".into())?,
            ),
            (
                "sessionType",
                fallback(persisted.optional(c"type")?, V::Null)?,
            ),
            ("pendingUserInput", flag(p, pending)?),
            ("backgroundPending", flag(p, background)?),
        ],
    )?;
    let verdict = crate::turn_state::resolve_live(facts)?;
    let apply = fields(
        p,
        &[
            ("cwd", cs.optional(c"cwd")?),
            ("source", text(p, "multicc/turn-rules")?),
            ("killReason", reason),
            (
                "handoffPending",
                flag(p, opts.get(c"handoffPending")?.is_true()?)?,
            ),
        ],
    )?;
    if opts.get(c"handoffPending")?.is_true()? {
        apply.set(c"turnId", turn)?;
    }
    if has_task_id(opts)? {
        apply.set(c"taskId", fallback(opts.get(c"taskId")?, V::Null)?)?;
    }
    let task_field = |key: &CStr, default: &str| {
        let value = cs.optional(c"currentTask")?.optional(key)?;
        if value.truthy()? {
            Ok(value)
        } else {
            fallback(
                p.get(c"getTaskState")?.call_plain(&[persisted])?.get(key)?,
                default.into(),
            )
        }
    };
    verdict.set(c"goal", task_field(c"goal", "")?)?;
    let phase = if verdict
        .get(c"evidence")?
        .is_string("gateway_turn_succeeded")?
    {
        text(p, "done")?
    } else {
        task_field(c"phase", "planning")?
    };
    verdict.set(c"phase", phase)?;
    verdict::apply(p, cs, name, id, verdict, apply)?;
    if !persisted.optional(c"type")?.is_string("gateway")? {
        let admitted = if has_task_id(opts)? {
            fallback(opts.get(c"taskId")?, V::Null)?
        } else {
            null(p)?
        };
        let inputs = fields(
            p,
            &[
                ("turnId", turn),
                ("skipCancel", flag(p, true)?),
                ("identityLocked", locked),
                ("admittedTaskId", admitted),
            ],
        )?;
        attribution::run(p, cs, name, inputs)?;
    }
    call(
        p.get(c"getTaskBoardRuntime")?.call_plain(&[])?,
        c"onTurnEnd",
        &[cs, name],
    )?;
    let sync = || -> Result<()> {
        let getter = p.get(c"getMessageSearch")?;
        if getter.kind()? == sys::ValueType::napi_function {
            let search = getter.call_plain(&[])?;
            if search.truthy()?
                && search.get(c"syncSession")?.kind()? == sys::ValueType::napi_function
            {
                call(search, c"syncSession", &[id])?;
            }
        }
        Ok(())
    };
    if let Err(error) = sync() {
        warn(p, "message_search_sync_failed", id, error)?;
    }
    p.from_value(&V::Undefined)
}
