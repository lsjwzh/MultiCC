//! Host draft bridge for the entry-scoped immediate insertion transition.
//! The clock, pending-input lookup and existing read projection remain host ports.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, check_status, sys, Env, Result};
use napi_derive::napi;
use std::ptr;

fn ensure_schedule<'a>(draft: L<'a>, session: L<'a>, at: L<'a>) -> Result<L<'a>> {
    if !draft.get(c"sessionSchedules")?.get_key(session)?.truthy()? {
        let null = draft.from_value(&V::Null)?;
        let schedule = draft.from_value(&V::object(Vec::<(&str, V)>::new()))?;
        schedule.set(c"sessionId", session)?;
        schedule.set(c"state", draft.from_value(&V::string("idle"))?)?;
        for key in [
            c"freezeReason",
            c"awaitingRequestId",
            c"classifyState",
            c"classifyStateAt",
            c"priorityEntryId",
            c"active",
            c"lastDecision",
        ] {
            schedule.set(key, null)?;
        }
        schedule.set(c"updatedAt", at)?;
        let collection = draft.get(c"sessionSchedules")?;
        let reflect = draft.global()?.get(c"Reflect")?;
        if !reflect
            .get(c"set")?
            .call(reflect, &[collection, session, schedule, collection])?
            .truthy()?
        {
            return Err(draft.type_error("Cannot assign to read-only property"));
        }
    }
    draft.get(c"sessionSchedules")?.get_key(session)
}
fn or_null<'a>(root: L<'a>, value: L<'a>) -> Result<L<'a>> {
    if value.truthy()? {
        Ok(value)
    } else {
        root.from_value(&V::Null)
    }
}
fn origin<'a>(item: L<'a>) -> Result<L<'a>> {
    let transferred = item
        .optional(c"turnLineage")?
        .optional(c"originDispatchId")?;
    if transferred.truthy()? {
        return Ok(transferred);
    }
    let direct = item.optional(c"payload")?.optional(c"originDispatchId")?;
    if direct.truthy()? {
        return Ok(direct);
    }
    let value = if item
        .optional(c"payload")?
        .optional(c"type")?
        .is_string("dispatch.request")?
    {
        item.get(c"payload")?.get(c"operationId")?
    } else {
        item.from_value(&V::Null)?
    };
    or_null(item, value)
}
fn task_id<'a>(item: L<'a>) -> Result<L<'a>> {
    let lineage = item.optional(c"turnLineage")?.optional(c"taskId")?;
    if lineage.truthy()? {
        return Ok(lineage);
    }
    let payload = if item
        .optional(c"payload")?
        .optional(c"type")?
        .is_string("dispatch.result")?
    {
        item.from_value(&V::Null)?
    } else {
        item.optional(c"payload")?
    };
    let task = payload.optional(c"taskId")?;
    or_null(item, task)
}
fn string_prefix<'a>(root: L<'a>, value: L<'a>, default: &str, length: f64) -> Result<L<'a>> {
    let value = if value.truthy()? {
        value
    } else {
        root.from_value(&V::string(default))?
    };
    let text = root.global()?.get(c"String")?.call_plain(&[value])?;
    text.get(c"slice")?.call(
        text,
        &[
            root.from_value(&V::Number(0.0))?,
            root.from_value(&V::Number(length))?,
        ],
    )
}
// Match compactJson: spread is already evaluated; Object.entries and the
// assignment of each non-undefined property occur before normalization.
fn compact<'a>(root: L<'a>, object: L<'a>) -> Result<L<'a>> {
    let output = root.from_value(&V::object(Vec::<(&str, V)>::new()))?;
    let ctor = root.global()?.get(c"Object")?;
    let entries = ctor.get(c"entries")?.call(ctor, &[object])?;
    let length = entries.get(c"length")?.number()? as u32;
    for index in 0..length {
        let entry = entries.element(index)?;
        let key = entry.element(0)?;
        let value = entry.element(1)?;
        if !value.undefined()? {
            let reflect = root.global()?.get(c"Reflect")?;
            if !reflect
                .get(c"set")?
                .call(reflect, &[output, key, value, output])?
                .truthy()?
            {
                return Err(root.type_error("Cannot assign to read-only property"));
            }
        }
    }
    let string = crate::wait_canonical::canonical_live(output)?;
    let json = root.global()?.get(c"JSON")?;
    json.get(c"parse")?.call(json, &[string])
}
fn contains_active<'a>(root: L<'a>, schedule: L<'a>, entry: L<'a>) -> Result<bool> {
    let set_ctor = root.global()?.get(c"Set")?;
    // Keep both property reads before filtering, like [a,b].filter(Boolean).
    let first = schedule.optional(c"active")?.optional(c"entryId")?;
    let second = schedule.optional(c"active")?.optional(c"deliveryId")?;
    let list = root.from_value(&V::Array(vec![]))?;
    list.set_element(0, first)?;
    list.set_element(1, second)?;
    let filtered = list
        .get(c"filter")?
        .call(list, &[root.global()?.get(c"Boolean")?])?;
    let mut set = ptr::null_mut();
    let args = [filtered.raw()];
    check_status!(unsafe {
        sys::napi_new_instance(root.env(), set_ctor.raw(), 1, args.as_ptr(), &mut set)
    })?;
    let set = L::from_raw(root.env(), set);
    set.get(c"has")?.call(set, &[entry])?.truthy()
}
// Explicit host ports preserve the order and identity of observable JS calls.
#[allow(clippy::too_many_arguments)]
#[napi]
pub fn schedule_insert_queued_live(
    env: Env,
    draft: Unknown<'_>,
    session_id: Unknown<'_>,
    entry_id: Unknown<'_>,
    actor: Unknown<'_>,
    clock: Unknown<'_>,
    pending: Unknown<'_>,
    project: Unknown<'_>,
) -> Result<sys::napi_value> {
    let draft = L::new(&env, draft);
    let session = L::new(&env, session_id);
    let entry = L::new(&env, entry_id);
    let actor = L::new(&env, actor);
    let clock = L::new(&env, clock);
    let pending = L::new(&env, pending);
    let project = L::new(&env, project);
    let fail = |code: &str| {
        draft.from_value(&V::object(vec![
            ("ok", false.into()),
            ("code", code.into()),
        ]))
    };
    let item = draft.get(c"outbox")?.get_key(entry)?;
    if !item.truthy()? || !item.get(c"sessionId")?.equals(session)? {
        return Ok(fail("queued_entry_not_found")?.raw());
    }
    let ensure_at = draft.from_value(&V::Number(clock.call_plain(&[])?.explicit_number()?))?;
    let schedule = ensure_schedule(draft, session, ensure_at)?;
    if schedule
        .optional(c"active")?
        .optional(c"supersededByEntryId")?
        .truthy()?
        && !schedule
            .get(c"active")?
            .get(c"supersededByEntryId")?
            .equals(entry)?
    {
        let failure = fail("active_supersession_in_progress")?;
        failure.set(
            c"supersededByEntryId",
            schedule.get(c"active")?.get(c"supersededByEntryId")?,
        )?;
        return Ok(failure.raw());
    }
    if contains_active(draft, schedule, entry)? || item.get(c"state")?.is_string("leased")? {
        return Ok(fail("queued_entry_already_claimed")?.raw());
    }
    if !item.get(c"state")?.is_string("pending")? {
        return Ok(fail("queued_entry_not_pending")?.raw());
    }
    let at = draft.from_value(&V::Number(clock.call_plain(&[])?.explicit_number()?))?;
    let active = schedule.get(c"active")?;
    let payload_task = or_null(draft, item.optional(c"payload")?.optional(c"taskId")?)?;
    let explicit = item
        .optional(c"payload")?
        .optional(c"options")?
        .optional(c"taskStart")?
        .is_true()?
        || item
            .optional(c"payload")?
            .optional(c"taskStart")?
            .is_true()?;
    let existing_origin = origin(item)?;
    let same_task = active.truthy()?
        && item
            .optional(c"payload")?
            .optional(c"type")?
            .is_string("session.work")?
        && !explicit
        && (!payload_task.truthy()?
            || (active.get(c"taskId")?.truthy()?
                && payload_task.equals(active.get(c"taskId")?)?))
        && (!existing_origin.truthy()?
            || !active.get(c"originDispatchId")?.truthy()?
            || existing_origin.equals(active.get(c"originDispatchId")?)?);
    if same_task {
        let prior = item.get(c"turnLineage")?;
        let lineage = draft.from_value(&V::object(Vec::<(&str, V)>::new()))?;
        if prior.truthy()? {
            lineage.spread_from(prior)?;
        }
        let task = if payload_task.truthy()? {
            payload_task
        } else {
            or_null(draft, active.get(c"taskId")?)?
        };
        lineage.set(c"taskId", task)?;
        let dispatch = if existing_origin.truthy()? {
            existing_origin
        } else {
            or_null(draft, active.get(c"originDispatchId")?)?
        };
        lineage.set(c"originDispatchId", dispatch)?;
        lineage.set(c"workKind", draft.from_value(&V::string("continuation"))?)?;
        lineage.set(c"activeEntryId", active.get(c"entryId")?)?;
        lineage.set(
            c"inheritedBy",
            draft.from_value(&V::string("insert_queued"))?,
        )?;
        lineage.set(c"inheritedAt", at)?;
        item.assign(c"turnLineage", compact(draft, lineage)?)?;
    }
    if active.truthy()? {
        active.assign(c"supersededByEntryId", entry)?;
        active.assign(c"supersededAt", at)?;
        active.assign(
            c"supersededLineageTransferred",
            draft.from_value(&V::Bool(same_task))?,
        )?;
        let origin_transferred = same_task
            && active.get(c"originDispatchId")?.truthy()?
            && origin(item)?.equals(active.get(c"originDispatchId")?)?;
        active.assign(
            c"supersededOriginTransferred",
            draft.from_value(&V::Bool(origin_transferred))?,
        )?;
    }
    item.assign(c"directRun", draft.from_value(&V::Bool(true))?)?;
    let question = pending.call_plain(&[])?;
    item.assign(
        c"userInputOverrideId",
        or_null(draft, question.optional(c"requestId")?)?,
    )?;
    schedule.assign(c"priorityEntryId", entry)?;
    schedule.assign(c"updatedAt", at)?;
    let inserted = draft.from_value(&V::object(Vec::<(&str, V)>::new()))?;
    inserted.set(c"entryId", entry)?;
    inserted.set(c"actor", string_prefix(draft, actor, "user", 80.0)?)?;
    inserted.set(c"taskId", task_id(item)?)?;
    inserted.set(c"originDispatchId", origin(item)?)?;
    inserted.set(c"inheritedLineage", draft.from_value(&V::Bool(same_task))?)?;
    inserted.set(c"at", at)?;
    let public = project.call_plain(&[schedule])?;
    let result = draft.from_value(&V::object(vec![("ok", true.into())]))?;
    result.set(c"inserted", inserted)?;
    result.set(c"schedule", public)?;
    Ok(result.raw())
}
