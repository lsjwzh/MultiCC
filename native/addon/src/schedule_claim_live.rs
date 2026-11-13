//! Rust-owned scheduler claim transition over a borrowed, transactional draft.
//! The host supplies the clock and the existing public read projection.
use crate::js_live::LiveValue as L;
use crate::schedule_lifecycle_live::ensure_schedule;
use crate::session_work_selection::replay;
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, Env, Result};
use napi_derive::napi;

fn kind<'a>(item: L<'a>) -> Result<L<'a>> {
    let transfer = item.optional(c"turnLineage")?.optional(c"workKind")?;
    if transfer.truthy()? {
        return Ok(transfer);
    }
    let payload = item.optional(c"payload")?;
    let payload = if payload.truthy()? {
        payload
    } else {
        item.from_value(&V::object(Vec::<(&str, V)>::new()))?
    };
    if payload.get(c"type")?.is_string("session.work")? {
        let work = payload.get(c"workKind")?;
        return if work.truthy()? {
            Ok(work)
        } else {
            item.from_value(&V::string("task"))
        };
    }
    if payload.get(c"type")?.is_string("dispatch.request")? {
        let continuation =
            payload.get(c"taskStart")?.is_false()? && payload.get(c"taskId")?.truthy()?;
        return item.from_value(&V::string(if continuation {
            "continuation"
        } else {
            "task"
        }));
    }
    for typ in [
        "wait.result",
        "wait.callback",
        "wait.resolved",
        "detached.result",
        "dispatch.result",
        "task.interrupted",
    ] {
        if payload.get(c"type")?.is_string(typ)? {
            return item.from_value(&V::string("callback"));
        }
    }
    item.from_value(&V::string(if payload.get(c"originContinue")?.is_true()? {
        "continuation"
    } else {
        "task"
    }))
}

fn related(schedule: L<'_>, item: L<'_>) -> Result<bool> {
    if !schedule.optional(c"active")?.truthy()? {
        return Ok(false);
    }
    let control = kind(item)?;
    let mut is_control = false;
    for name in [
        "answer",
        "approval",
        "callback",
        "continuation",
        "retry",
        "resume",
    ] {
        if control.is_string(name)? {
            is_control = true;
            break;
        }
    }
    if !is_control {
        return Ok(false);
    }
    let payload = item.get(c"payload")?;
    let payload = if payload.truthy()? {
        payload
    } else {
        item.from_value(&V::object(Vec::<(&str, V)>::new()))?
    };
    if payload.get(c"type")?.is_string("session.work")? {
        return Ok(true);
    }
    if payload.get(c"activeEntryId")?.truthy()?
        && !payload
            .get(c"activeEntryId")?
            .equals(schedule.get(c"active")?.get(c"entryId")?)?
    {
        return Ok(false);
    }
    if !payload.get(c"type")?.is_string("task.interrupted")?
        && !payload.get(c"type")?.is_string("dispatch.result")?
        && payload.get(c"taskId")?.truthy()?
        && schedule
            .optional(c"active")?
            .optional(c"taskId")?
            .truthy()?
        && !payload
            .get(c"taskId")?
            .equals(schedule.optional(c"active")?.optional(c"taskId")?)?
    {
        return Ok(false);
    }
    if kind(item)?.is_string("answer")?
        && schedule.get(c"awaitingRequestId")?.truthy()?
        && !payload
            .get(c"requestId")?
            .equals(schedule.get(c"awaitingRequestId")?)?
    {
        return Ok(false);
    }
    Ok(true)
}

fn task_id<'a>(item: L<'a>) -> Result<L<'a>> {
    let transfer = item.optional(c"turnLineage")?.optional(c"taskId")?;
    if transfer.truthy()? {
        return Ok(transfer);
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
    if task.truthy()? {
        Ok(task)
    } else {
        item.from_value(&V::Null)
    }
}

fn origin_id<'a>(item: L<'a>) -> Result<L<'a>> {
    let transfer = item
        .optional(c"turnLineage")?
        .optional(c"originDispatchId")?;
    if transfer.truthy()? {
        return Ok(transfer);
    }
    let origin = item.optional(c"payload")?.optional(c"originDispatchId")?;
    if origin.truthy()? {
        return Ok(origin);
    }
    if item
        .optional(c"payload")?
        .optional(c"type")?
        .is_string("dispatch.request")?
    {
        let id = item.get(c"payload")?.get(c"operationId")?;
        if id.truthy()? {
            return Ok(id);
        }
    }
    item.from_value(&V::Null)
}

fn source<'a>(item: L<'a>) -> Result<L<'a>> {
    let value = item.optional(c"payload")?.optional(c"source")?;
    if value.truthy()? {
        return Ok(value);
    }
    let value = item.optional(c"source")?.optional(c"type")?;
    if value.truthy()? {
        return Ok(value);
    }
    item.from_value(&V::string("legacy"))
}

#[napi]
pub fn schedule_claim_live(
    env: Env,
    draft: Unknown<'_>,
    item: Unknown<'_>,
    clock: Unknown<'_>,
    project: Unknown<'_>,
) -> Result<napi::sys::napi_value> {
    let draft = L::new(&env, draft);
    let item = L::new(&env, item);
    let clock = L::new(&env, clock);
    let project = L::new(&env, project);
    let current = draft.get(c"outbox")?.get_key(item.get(c"id")?)?;
    let fail = |code: &str| {
        draft.from_value(&V::object(vec![
            ("ok", false.into()),
            ("code", V::string(code)),
        ]))
    };
    if !current.truthy()? || !current.get(c"state")?.is_string("leased")? {
        return Ok(fail("delivery_not_leased")?.raw());
    }
    let at = draft.from_value(&V::Number(clock.call_plain(&[])?.explicit_number()?))?;
    let schedule = ensure_schedule(draft, item.get(c"sessionId")?, at)?;
    let null = draft.from_value(&V::Null)?;
    if !schedule.get(c"active")?.truthy()? || schedule.get(c"state")?.is_string("idle")? {
        let active = draft.from_value(&V::object(Vec::<(&str, V)>::new()))?;
        active.set(c"entryId", item.get(c"id")?)?;
        active.set(c"deliveryId", item.get(c"id")?)?;
        active.set(c"taskId", task_id(item)?)?;
        active.set(c"originDispatchId", origin_id(item)?)?;
        active.set(c"source", source(item)?)?;
        active.set(c"workKind", kind(item)?)?;
        active.set(c"admittedAt", item.get(c"createdAt")?)?;
        active.set(c"claimedAt", at)?;
        active.set(c"startedAt", null)?;
        active.set(c"attempt", item.get(c"attempts")?)?;
        schedule.assign(c"active", active)?;
        if schedule.get(c"priorityEntryId")?.equals(item.get(c"id")?)? {
            schedule.assign(c"priorityEntryId", null)?;
        }
    } else if replay(schedule, item)? || related(schedule, item)? {
        schedule
            .get(c"active")?
            .assign(c"deliveryId", item.get(c"id")?)?;
        schedule.get(c"active")?.assign(c"workKind", kind(item)?)?;
        schedule
            .get(c"active")?
            .assign(c"attempt", item.get(c"attempts")?)?;
        if !schedule.get(c"active")?.get(c"taskId")?.truthy()? && task_id(item)?.truthy()? {
            schedule.get(c"active")?.assign(c"taskId", task_id(item)?)?;
        }
        if !schedule
            .get(c"active")?
            .get(c"originDispatchId")?
            .truthy()?
            && origin_id(item)?.truthy()?
        {
            schedule
                .get(c"active")?
                .assign(c"originDispatchId", origin_id(item)?)?;
        }
    } else {
        return Ok(fail("session_gate_closed")?.raw());
    }
    schedule.assign(c"state", draft.from_value(&V::string("starting"))?)?;
    schedule.assign(c"freezeReason", null)?;
    schedule.assign(c"updatedAt", at)?;
    let public = project.call_plain(&[schedule])?;
    let result = draft.from_value(&V::object(vec![("ok", true.into())]))?;
    result.set(c"schedule", public)?;
    Ok(result.raw())
}
