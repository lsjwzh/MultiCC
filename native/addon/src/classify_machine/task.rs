//! The active turn and its provisional/canonical identity are installed in one
//! state write. The history anchor is resolved against the current transcript.
use super::*;

fn title<'a>(p: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let normalized = if let Some(input) = value.string()? {
        serde_json::Value::String(input.to_string_lossy())
    } else {
        // The title is an optional JSON property. Serialize the envelope to
        // retain toJSON("value"), omission of undefined, and host exceptions.
        let envelope = fields(p, &[("value", value)])?;
        let wire = call(p.global()?.get(c"JSON")?, c"stringify", &[envelope])?.coerce_string()?;
        let mut doc: serde_json::Value =
            multicc_core::json_lenient::from_str(&wire.to_string_lossy())
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        doc["value"].take()
    };
    text(p, &multicc_core::task_domain::normalize::title(&normalized))
}

fn increment(seq: L<'_>) -> Result<L<'_>> {
    let v = crate::message_composer::default_primitive(seq)?;
    if let Some(mut s) = v.string()? {
        s.push_str("1");
        return v.from_value(&V::String(s));
    }
    if v.kind()? == sys::ValueType::napi_bigint {
        return Err(v.type_error("Cannot mix BigInt and other types, use explicit conversions"));
    }
    num(v, v.number()? + 1.)
}

fn known_goal<'a>(p: L<'a>, name: L<'a>, id: L<'a>) -> Result<L<'a>> {
    if !id.truthy()? {
        return text(p, "");
    }
    let row = call(p.get(c"persistedSessions")?, c"get", &[name])?;
    let state = p.get(c"getTaskState")?.call_plain(&[row])?;
    if state.get(c"taskId")?.equals(id)? && state.get(c"goal")?.truthy()? {
        return state.get(c"goal");
    }
    let history = state.get(c"classifyHistory")?;
    if history.is_array()? {
        for i in (0..history.get(c"length")?.number()? as u32).rev() {
            let m = history.element(i)?;
            if m.optional(c"taskId")?.equals(id)? && m.get(c"goal")?.truthy()? {
                return m.get(c"goal");
            }
        }
    }
    let goal = p.catch(|| {
        let history = p.get(c"viewChatHistory")?.call_plain(&[name])?;
        for i in (0..history.get(c"length")?.number()? as u32).rev() {
            let m = history.element(i)?;
            if !m.optional(c"taskId")?.equals(id)? {
                continue;
            }
            let mut goal = m.get(c"taskName")?;
            if !goal.truthy()? && m.get(c"taskText")?.truthy()? {
                goal = title(p, m.get(c"taskText")?)?;
            }
            if goal.truthy()? && !goal.is_string("新任务")? {
                return Ok(goal);
            }
        }
        text(p, "")
    })?;
    goal.map_or_else(|| text(p, ""), Ok)
}

pub(super) fn ensure<'a>(
    p: L<'a>,
    cs: L<'a>,
    name: L<'a>,
    user: L<'a>,
    force: L<'a>,
    identity: L<'a>,
) -> Result<L<'a>> {
    if !cs.truthy()? {
        return p.from_value(&V::Undefined);
    }
    let force = if force.undefined()? {
        flag(p, false)?
    } else {
        force
    };
    let identity = if identity.undefined()? {
        fields(p, &[])?
    } else {
        identity
    };
    let time = now(p)?;
    let prev = cs.get(c"currentTask")?;
    let continuation = cs.get(c"_currentTaskId")?.truthy()? && !force.truthy()? && prev.truthy()?;
    let context = p.get(c"getTaskContextHost")?.call_plain(&[])?;
    let active = |patch: L<'a>| -> Result<()> {
        patch.set(c"classifyState", text(p, "P")?)?;
        patch.set(
            c"activeTurnId",
            fallback(identity.get(c"turnId")?, V::Null)?,
        )?;
        for key in [c"goalState", c"cancelledAt", c"cancelReason"] {
            patch.set(key, null(p)?)?;
        }
        patch.set(c"cancelSuperseded", flag(p, false)?)?;
        patch.set(c"supersededByEntryId", null(p)?)?;
        p.get(c"setTaskState")?.call_plain(&[name, patch])?;
        Ok(())
    };
    if call(context, c"continues", &[cs, prev, force, time])?.truthy()? {
        let seq = fallback(prev.get(c"turnSeq")?, 0.0.into())?;
        prev.assign(c"turnSeq", increment(seq)?)?;
        if continuation && prev.get(c"phase")?.is_string("done")? {
            prev.assign(c"phase", text(p, "planning")?)?;
        }
        active(fields(p, &[])?)?;
        return Ok(prev);
    }
    let explicit = identity.get(c"explicitContinuation")?.is_true()?;
    let id = identity.get(c"taskId")?;
    let id = if id.truthy()? {
        id
    } else {
        fallback(cs.get(c"_currentTaskId")?, V::Null)?
    };
    let mut goal = if explicit {
        known_goal(p, name, id)?
    } else {
        text(p, "")?
    };
    if !goal.truthy()? {
        let supplied = identity.get(c"taskText")?;
        goal = title(p, if supplied.truthy()? { supplied } else { user })?;
    }
    cs.assign(c"currentTask", new_task(goal)?)?;
    let task = || cs.get(c"currentTask");
    task()?.assign(c"turnSeq", num(p, 1.)?)?;
    cs.assign(c"_currentTaskId", id)?;
    let anchor = identity.get(c"anchorMessageId")?;
    let anchor = if anchor.truthy()? {
        anchor
    } else {
        transcript::anchor(p, name)?
    };
    let patch = fields(
        p,
        &[
            ("goal", task()?.get(c"goal")?),
            ("phase", task()?.get(c"phase")?),
            ("startedAt", task()?.get(c"startedAt")?),
            ("endedAt", null(p)?),
            ("taskId", id),
            (
                "taskIdentityState",
                text(p, if explicit { "canonical" } else { "provisional" })?,
            ),
            ("taskIdentityPending", flag(p, !explicit)?),
            ("taskIdentityAnchorMessageId", anchor),
        ],
    )?;
    active(patch)?;
    verdict::board_goal(
        p,
        name,
        task()?.get(c"goal")?,
        task()?.get(c"phase")?,
        cs,
        text(p, "P")?,
    )?;
    let mut msg = JsString::from(if explicit {
        "处理中："
    } else {
        "归类中："
    });
    msg.push(&task()?.get(c"goal")?.coerce_string()?);
    verdict::running(p, name, p.from_value(&V::String(msg))?)?;
    task()
}
