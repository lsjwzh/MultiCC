use super::*;
use multicc_core::orchestration_store;
fn read(v: L<'_>) -> Result<V> {
    unsafe { crate::js_bridge::read_value(v.env(), v.raw(), 0, &mut Vec::new()) }
}
// Draft records can contain large attachments and host-only payloads. Read only
// columns used by the public projection; the SQLite owner supplies plain rows.
fn projected_item(item: L<'_>) -> Result<V> {
    let payload = item.optional(c"payload")?;
    let payload_type = payload.optional(c"type")?;
    let mut p = vec![("type", read(payload_type)?)];
    let mut source = V::Null;
    let source_field = payload.optional(c"source")?;
    if source_field.truthy()? {
        p.push(("source", read(source_field)?));
    } else {
        source = V::object(vec![(
            "type",
            read(item.optional(c"source")?.optional(c"type")?)?,
        )]);
    }
    let kind = kind(item)?;
    let task = crate::schedule_claim_live::task_id(item)?;
    let lineage = V::object(vec![("workKind", read(kind)?), ("taskId", read(task)?)]);
    if payload_type.is_string("session.work")? && kind.is_string("answer")? {
        p.push(("requestId", read(payload.optional(c"requestId")?)?));
    }
    p.push((
        "options",
        V::object(vec![(
            "clientMsgId",
            read(payload.optional(c"options")?.optional(c"clientMsgId")?)?,
        )]),
    ));
    p.push(("message", read(queue_text::bounded_text(payload)?)?));
    Ok(V::object(vec![
        ("id", read(item.get(c"id")?)?),
        ("state", read(item.get(c"state")?)?),
        ("sequence", read(item.get(c"sequence")?)?),
        ("createdAt", read(item.get(c"createdAt")?)?),
        (
            "attempts",
            V::Number(item.get(c"attempts")?.explicit_number()?),
        ),
        ("lastError", read(item.get(c"lastError")?)?),
        ("source", source),
        ("turnLineage", lineage),
        ("payload", V::object(p)),
    ]))
}
fn active_input(item: L<'_>) -> Result<V> {
    let payload = item.optional(c"payload")?;
    let id = payload.optional(c"options")?.optional(c"clientMsgId")?;
    if id.string()?.is_none() || !id.clean_text()?.truthy()? {
        return Ok(V::Null);
    }
    Ok(V::object(vec![(
        "payload",
        V::object(vec![
            ("options", V::object(vec![("clientMsgId", read(id)?)])),
            ("message", read(queue_text::bounded_text(payload)?)?),
        ]),
    )]))
}
fn public_row(schedule: L<'_>) -> Result<V> {
    let mut fields = Vec::new();
    for (name, key) in [
        ("sessionId", c"sessionId".as_ref()),
        ("state", c"state"),
        ("freezeReason", c"freezeReason"),
        ("awaitingRequestId", c"awaitingRequestId"),
        ("classifyState", c"classifyState"),
        ("priorityEntryId", c"priorityEntryId"),
        ("updatedAt", c"updatedAt"),
    ] {
        fields.push((name, read(schedule.get(key)?)?));
    }
    for (name, key) in [
        ("active", c"active".as_ref()),
        ("lastDecision", c"lastDecision"),
    ] {
        let value = schedule.get(key)?;
        fields.push((
            name,
            if value.truthy()? {
                read(json(json(value, c"stringify")?, c"parse")?)?
            } else {
                V::Null
            },
        ));
    }
    Ok(V::object(fields))
}
fn candidates<'a>(draft: L<'a>, id: Option<L<'a>>) -> Result<L<'a>> {
    if callable(draft.get(c"select")?)? {
        let filter = fields(draft, &[])?;
        if let Some(session) = id {
            filter.set(c"sessionId", session)?;
        }
        filter.set(
            c"state",
            array(draft, &[text(draft, "pending")?, text(draft, "leased")?])?,
        )?;
        call(
            draft,
            c"select",
            &[text(draft, "outbox")?, fields(draft, &[("where", filter)])?],
        )
    } else {
        call(
            draft.global()?.get(c"Object")?,
            c"values",
            &[draft.get(c"outbox")?],
        )
    }
}
pub(super) fn queue<'a>(draft: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let schedule = draft.get(c"sessionSchedules")?.get_key(id)?;
    let active = schedule.optional(c"active")?;
    let active_id = or(
        active.optional(c"deliveryId")?,
        active.optional(c"entryId")?,
    )?;
    let mut rows = Vec::new();
    candidates(draft, Some(id))?.for_each(|r| {
        if r.get(c"sessionId")?.equals(id)?
            && has(r.get(c"state")?, &["pending", "leased"])?
            && (!active_id.truthy()? || !r.get(c"id")?.equals(active_id)?)
        {
            rows.push(r);
        }
        Ok(())
    })?;
    crate::session_work_selection::sort(
        &mut rows,
        fallback(schedule.optional(c"priorityEntryId")?, V::Null)?,
    )?;
    array(draft, &rows)
}
pub(super) fn project<'a>(draft: L<'a>, schedule: L<'a>, rows: L<'a>) -> Result<L<'a>> {
    if !schedule.truthy()? {
        return null(draft);
    }
    let active = schedule.get(c"active")?;
    let key = or(
        active.optional(c"deliveryId")?,
        active.optional(c"entryId")?,
    )?;
    let item = if key.truthy()? && !active.optional(c"startedAt")?.truthy()? {
        Some(active_input(draft.get(c"outbox")?.get_key(key)?)?)
    } else {
        None
    };
    let mut values = Vec::new();
    rows.for_each(|r| {
        if !crate::session_work_selection::answer(r)? {
            values.push(projected_item(r)?);
        }
        Ok(())
    })?;
    let projected =
        orchestration_store::project_schedule(&public_row(schedule)?, &values, item.as_ref())
            .map_err(napi::Error::from_reason)?;
    draft.from_value(&projected)
}
pub(super) fn status<'a>(owner: L<'a>, draft: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let s = current(draft, id)?;
    let out = project(draft, s, queue(draft, id)?)?;
    out.set(c"classifyState", classify(owner, id, s)?)?;
    Ok(out)
}
fn current<'a>(draft: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let schedule = draft.get(c"sessionSchedules")?.get_key(id)?;
    if schedule.truthy()? {
        return Ok(schedule);
    }
    fields(
        draft,
        &[
            ("sessionId", id),
            ("state", text(draft, "idle")?),
            ("updatedAt", num(draft, 0.)?),
        ],
    )
}
pub(super) fn summary<'a>(schedule: L<'a>, cls: L<'a>) -> Result<L<'a>> {
    let id = schedule.optional(c"sessionId")?;
    if !id.truthy()? {
        return null(schedule);
    }
    let queued = schedule.get(c"queued")?;
    let state = schedule.get(c"state")?;
    fields(
        schedule,
        &[
            ("sessionId", id),
            (
                "depth",
                if queued.is_array()? {
                    queued.get(c"length")?
                } else {
                    num(schedule, 0.)?
                },
            ),
            (
                "state",
                if has(state, ACTIVE)? {
                    state
                } else {
                    text(state, "idle")?
                },
            ),
            (
                "classifyState",
                if has(cls, &classify_vocab::CLASSIFY_STATES)? {
                    cls
                } else {
                    classify_fallback(schedule)?
                },
            ),
            (
                "updatedAt",
                fallback(
                    num(schedule, schedule.get(c"updatedAt")?.explicit_number()?)?,
                    V::Number(0.),
                )?,
            ),
        ],
    )
}
pub(super) fn list(draft: L<'_>) -> Result<L<'_>> {
    let ids = call(
        draft.global()?.get(c"Object")?,
        c"keys",
        &[draft.get(c"sessionSchedules")?],
    )?;
    call(ids, c"sort", &[])?;
    let mut out = Vec::new();
    ids.for_each(|id| {
        out.push(project(
            draft,
            draft.get(c"sessionSchedules")?.get_key(id)?,
            queue(draft, id)?,
        )?);
        Ok(())
    })?;
    array(draft, &out)
}
pub(super) fn requested(ids: L<'_>) -> Result<L<'_>> {
    if !ids.is_array()? {
        return null(ids);
    }
    let set = ids.global()?.get(c"Set")?.construct(&[])?;
    ids.for_each(|id| {
        let id = string(fallback(id, V::string(""))?)?.clean_text()?;
        if id.truthy()? {
            call(set, c"add", &[id])?;
        }
        Ok(())
    })?;
    call(ids.global()?.get(c"Array")?, c"from", &[set])
}
pub(super) fn summaries<'a>(owner: L<'a>, draft: L<'a>, requested: L<'a>) -> Result<L<'a>> {
    let ids = if requested.is_array()? {
        requested
    } else {
        let keys = call(
            draft.global()?.get(c"Object")?,
            c"keys",
            &[draft.get(c"sessionSchedules")?],
        )?;
        let set = draft.global()?.get(c"Set")?.construct(&[keys])?;
        candidates(draft, None)?.for_each(|r| {
            if has(r.get(c"state")?, &["pending", "leased"])? {
                call(set, c"add", &[r.get(c"sessionId")?])?;
            }
            Ok(())
        })?;
        call(
            call(draft.global()?.get(c"Array")?, c"from", &[set])?,
            c"sort",
            &[],
        )?
    };
    let mut out = Vec::new();
    ids.for_each(|id| {
        let s = current(draft, id)?;
        let projected = project(draft, s, queue(draft, id)?)?;
        out.push(summary(
            projected,
            or(classify(owner, id, s)?, projected.get(c"classifyState")?)?,
        )?);
        Ok(())
    })?;
    array(owner, &out)
}
