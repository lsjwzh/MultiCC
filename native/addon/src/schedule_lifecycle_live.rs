//! Live JavaScript draft adapter: Rust owns the scheduler state transitions.
//! The host provides only the clock and the existing public read projection.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use napi::bindgen_prelude::Unknown;
use napi::{Env, Result};
use napi_derive::napi;

#[napi]
pub fn schedule_lifecycle_live(
    env: Env,
    draft: Unknown<'_>,
    action: String,
    input: Unknown<'_>,
    clock: Unknown<'_>,
    project: Unknown<'_>,
) -> Result<napi::sys::napi_value> {
    let draft = L::new(&env, draft);
    let input = L::new(&env, input);
    let clock = L::new(&env, clock);
    let project = L::new(&env, project);
    let schedules = draft.get(c"sessionSchedules")?;
    let session = if action == "turnEnded" {
        input
    } else {
        input.get(c"sessionId")?
    };
    let schedule = schedules.get_key(session)?;
    let fail = |code: &str| {
        draft.from_value(&V::object(vec![
            ("ok", false.into()),
            ("code", V::string(code)),
        ]))
    };
    let active = schedule.optional(c"active")?;
    if action == "turnEnded" {
        if !active.truthy()? {
            return Ok(fail("no_active_task")?.raw());
        }
        let state = schedule.get(c"state")?;
        if !(state.is_string("starting")?
            || state.is_string("running")?
            || state.is_string("assessing")?
            || state.is_string("frozen")?)
        {
            return Ok(fail("no_active_task")?.raw());
        }
    } else if !active.truthy()?
        || !schedule
            .get(c"active")?
            .get(c"deliveryId")?
            .equals(input.get(c"id")?)?
    {
        return Ok(fail("active_delivery_mismatch")?.raw());
    }
    let null = draft.from_value(&V::Null)?;
    if action == "turnEnded" {
        schedule.assign(c"state", draft.from_value(&V::string("assessing"))?)?;
        schedule.assign(c"classifyState", draft.from_value(&V::string("P"))?)?;
        schedule.assign(c"freezeReason", null)?;
        schedule.assign(c"awaitingRequestId", null)?;
        let at = clock.call_plain(&[])?.explicit_number()?;
        schedule.assign(c"updatedAt", draft.from_value(&V::Number(at))?)?;
    } else {
        let at = clock.call_plain(&[])?.explicit_number()?;
        let at_value = draft.from_value(&V::Number(at))?;
        if action == "started" {
            schedule.assign(c"state", draft.from_value(&V::string("running"))?)?;
            schedule.assign(c"freezeReason", null)?;
            schedule.assign(c"awaitingRequestId", null)?;
            schedule.assign(c"classifyState", draft.from_value(&V::string("P"))?)?;
            let target = schedule.get(c"active")?;
            let started = schedule.get(c"active")?.get(c"startedAt")?;
            target.assign(
                c"startedAt",
                if started.truthy()? { started } else { at_value },
            )?;
            schedule
                .get(c"active")?
                .assign(c"attempt", input.get(c"attempts")?)?;
        } else if action == "releaseClaim" {
            if schedule
                .get(c"active")?
                .get(c"entryId")?
                .equals(input.get(c"id")?)?
                && !schedule.get(c"active")?.get(c"startedAt")?.truthy()?
            {
                schedule.assign(c"active", null)?;
                schedule.assign(c"state", draft.from_value(&V::string("idle"))?)?;
                schedule.assign(c"freezeReason", null)?;
                schedule.assign(c"awaitingRequestId", null)?;
                let classify = schedule.get(c"classifyState")?;
                schedule.assign(
                    c"classifyState",
                    if classify.truthy()? {
                        classify
                    } else {
                        draft.from_value(&V::string("D"))?
                    },
                )?;
                if schedule
                    .get(c"priorityEntryId")?
                    .equals(input.get(c"id")?)?
                {
                    schedule.assign(c"priorityEntryId", null)?;
                }
            } else {
                let target = schedule.get(c"active")?;
                target.assign(c"deliveryId", schedule.get(c"active")?.get(c"entryId")?)?;
                schedule
                    .get(c"active")?
                    .assign(c"workKind", draft.from_value(&V::string("task"))?)?;
                schedule.assign(c"state", draft.from_value(&V::string("frozen"))?)?;
                schedule.assign(
                    c"freezeReason",
                    draft.from_value(&V::string("incomplete_requires_resume"))?,
                )?;
            }
        } else {
            return Err(napi::Error::from_reason(
                "unknown scheduler lifecycle action",
            ));
        }
        schedule.assign(c"updatedAt", at_value)?;
    }
    let public = project.call_plain(&[schedule])?;
    let result = draft.from_value(&V::object(vec![("ok", true.into())]))?;
    result.set(c"schedule", public)?;
    Ok(result.raw())
}

fn active_task<'a>(schedule: L<'a>) -> Result<L<'a>> {
    let task = schedule.optional(c"active")?.optional(c"taskId")?;
    if task.truthy()? {
        Ok(task)
    } else {
        schedule.from_value(&V::Null)
    }
}
fn string_or_default<'a>(root: L<'a>, value: L<'a>, default: &str) -> Result<L<'a>> {
    let value = if value.truthy()? {
        value
    } else {
        root.from_value(&V::string(default))?
    };
    root.global()?.get(c"String")?.call_plain(&[value])
}
fn string_prefix<'a>(root: L<'a>, value: L<'a>, default: &str, limit: usize) -> Result<L<'a>> {
    let string = string_or_default(root, value, default)?;
    let start = root.from_value(&V::Number(0.0))?;
    let end = root.from_value(&V::Number(limit as f64))?;
    string.get(c"slice")?.call(string, &[start, end])
}

// Separate live arguments preserve the original getter and clock order.
#[allow(clippy::too_many_arguments)]
#[napi]
pub fn schedule_freeze_live(
    env: Env,
    draft: Unknown<'_>,
    session_id: Unknown<'_>,
    reason: Unknown<'_>,
    request_id: Unknown<'_>,
    expected_task_id: Unknown<'_>,
    classify_state: Unknown<'_>,
    clock: Unknown<'_>,
    project: Unknown<'_>,
) -> Result<napi::sys::napi_value> {
    let draft = L::new(&env, draft);
    let session_id = L::new(&env, session_id);
    let reason = L::new(&env, reason);
    let request_id = L::new(&env, request_id);
    let expected = L::new(&env, expected_task_id);
    let classify = L::new(&env, classify_state);
    let clock = L::new(&env, clock);
    let project = L::new(&env, project);
    let schedule = draft.get(c"sessionSchedules")?.get_key(session_id)?;
    let fail = |code: &str| {
        draft.from_value(&V::object(vec![
            ("ok", false.into()),
            ("code", V::string(code)),
        ]))
    };
    if !schedule.optional(c"active")?.truthy()? {
        return Ok(fail("no_active_task")?.raw());
    }
    if expected.truthy()?
        && active_task(schedule)?.truthy()?
        && !expected.equals(active_task(schedule)?)?
    {
        return Ok(fail("active_task_mismatch")?.raw());
    }
    let at = draft.from_value(&V::Number(clock.call_plain(&[])?.explicit_number()?))?;
    schedule.assign(c"state", draft.from_value(&V::string("frozen"))?)?;
    schedule.assign(
        c"freezeReason",
        string_prefix(draft, reason, "unknown_interruption", 160)?,
    )?;
    schedule.assign(
        c"awaitingRequestId",
        if request_id.truthy()? {
            request_id
        } else {
            draft.from_value(&V::Null)?
        },
    )?;
    let classified = if ["P", "D", "W", "B", "E"]
        .iter()
        .any(|state| classify.is_string(state).unwrap_or(false))
    {
        Some(classify)
    } else {
        let key = string_or_default(draft, reason, "")?
            .coerce_string()?
            .to_string_lossy();
        let letter = match key.as_str() {
            "awaiting_user_input" | "waiting" | "classify_waiting" => Some("W"),
            "awaiting_callback" | "classify_background" => Some("B"),
            "error" | "classification_error" | "unknown_interruption" | "classify_error" => {
                Some("E")
            }
            "incomplete_requires_resume" | "classify_running" => Some("P"),
            _ => None,
        };
        letter
            .map(|letter| draft.from_value(&V::string(letter)))
            .transpose()?
    };
    if let Some(classified) = classified {
        schedule.assign(c"classifyState", classified)?;
        schedule.assign(c"classifyStateAt", at)?;
    }
    schedule.assign(c"updatedAt", at)?;
    let public = project.call_plain(&[schedule])?;
    let result = draft.from_value(&V::object(vec![("ok", true.into())]))?;
    result.set(c"schedule", public)?;
    Ok(result.raw())
}

// Separate live arguments preserve the original getter and clock order.
#[allow(clippy::too_many_arguments)]
#[napi]
pub fn schedule_resolve_live(
    env: Env,
    draft: Unknown<'_>,
    session_id: Unknown<'_>,
    action: Unknown<'_>,
    reason: Unknown<'_>,
    actor: Unknown<'_>,
    clock: Unknown<'_>,
    project: Unknown<'_>,
) -> Result<napi::sys::napi_value> {
    let draft = L::new(&env, draft);
    let session_id = L::new(&env, session_id);
    let action = L::new(&env, action);
    let reason = L::new(&env, reason);
    let actor = L::new(&env, actor);
    let clock = L::new(&env, clock);
    let project = L::new(&env, project);
    let schedule = draft.get(c"sessionSchedules")?.get_key(session_id)?;
    let fail = |code: &str| {
        draft.from_value(&V::object(vec![
            ("ok", false.into()),
            ("code", V::string(code)),
        ]))
    };
    if !schedule.optional(c"active")?.truthy()? {
        return Ok(fail("no_active_task")?.raw());
    }
    if !action.is_string("cancel")? && !schedule.get(c"state")?.is_string("frozen")? {
        return Ok(fail("active_task_not_frozen")?.raw());
    }
    let at = draft.from_value(&V::Number(clock.call_plain(&[])?.explicit_number()?))?;
    // The original projection clones via JSON stringify/parse, including any
    // native toJSON hooks and errors before modifying the schedule.
    let json = draft.global()?.get(c"JSON")?;
    let encoded = json
        .get(c"stringify")?
        .call(json, &[schedule.get(c"active")?])?;
    let resolved = json.get(c"parse")?.call(json, &[encoded])?;
    let null = draft.from_value(&V::Null)?;
    schedule.assign(c"active", null)?;
    schedule.assign(c"state", draft.from_value(&V::string("idle"))?)?;
    schedule.assign(c"freezeReason", null)?;
    schedule.assign(c"awaitingRequestId", null)?;
    schedule.assign(c"classifyState", draft.from_value(&V::string("D"))?)?;
    let decision = draft.from_value(&V::object(Vec::<(&str, V)>::new()))?;
    decision.set(c"action", action)?;
    decision.set(c"reason", string_prefix(draft, reason, "", 500)?)?;
    decision.set(c"actor", string_prefix(draft, actor, "user", 80)?)?;
    decision.set(c"entryId", resolved.get(c"entryId")?)?;
    let task_id = resolved.get(c"taskId")?;
    decision.set(c"taskId", if task_id.truthy()? { task_id } else { null })?;
    let origin = resolved.get(c"originDispatchId")?;
    decision.set(
        c"originDispatchId",
        if origin.truthy()? { origin } else { null },
    )?;
    decision.set(c"at", at)?;
    schedule.assign(c"lastDecision", decision)?;
    schedule.assign(c"updatedAt", at)?;
    let public = project.call_plain(&[schedule])?;
    let result = draft.from_value(&V::object(vec![("ok", true.into())]))?;
    result.set(c"resolved", resolved)?;
    result.set(c"schedule", public)?;
    Ok(result.raw())
}

pub(crate) fn ensure_schedule<'a>(draft: L<'a>, session: L<'a>, at: L<'a>) -> Result<L<'a>> {
    let schedules = draft.get(c"sessionSchedules")?;
    if !schedules.get_key(session)?.truthy()? {
        let target = draft.get(c"sessionSchedules")?;
        let null = draft.from_value(&V::Null)?;
        let schedule = draft.from_value(&V::object(Vec::<(&str, V)>::new()))?;
        schedule.assign(c"sessionId", session)?;
        schedule.assign(c"state", draft.from_value(&V::string("idle"))?)?;
        for key in [
            c"freezeReason",
            c"awaitingRequestId",
            c"classifyState",
            c"classifyStateAt",
            c"priorityEntryId",
            c"active",
            c"lastDecision",
        ] {
            schedule.assign(key, null)?;
        }
        schedule.assign(c"updatedAt", at)?;
        target.set_key(session, schedule)?;
    }
    draft.get(c"sessionSchedules")?.get_key(session)
}

// Separate live arguments preserve the original getter and clock order.
#[allow(clippy::too_many_arguments)]
#[napi]
pub fn schedule_cancel_queued_live(
    env: Env,
    draft: Unknown<'_>,
    session_id: Unknown<'_>,
    entry_id: Unknown<'_>,
    actor: Unknown<'_>,
    reason: Unknown<'_>,
    clock: Unknown<'_>,
    project: Unknown<'_>,
) -> Result<napi::sys::napi_value> {
    let draft = L::new(&env, draft);
    let session_id = L::new(&env, session_id);
    let entry = L::new(&env, entry_id);
    let actor = L::new(&env, actor);
    let reason = L::new(&env, reason);
    let clock = L::new(&env, clock);
    let project = L::new(&env, project);
    let item = draft.get(c"outbox")?.get_key(entry)?;
    let fail = |code: &str| {
        draft.from_value(&V::object(vec![
            ("ok", false.into()),
            ("code", V::string(code)),
        ]))
    };
    if !item.truthy()? || !item.get(c"sessionId")?.equals(session_id)? {
        return Ok(fail("queued_entry_not_found")?.raw());
    }
    let ensure_at = draft.from_value(&V::Number(clock.call_plain(&[])?.explicit_number()?))?;
    let schedule = ensure_schedule(draft, session_id, ensure_at)?;
    let active_entry = schedule.optional(c"active")?.optional(c"entryId")?;
    let active_delivery = schedule.optional(c"active")?.optional(c"deliveryId")?;
    if (active_entry.truthy()? && active_entry.equals(entry)?)
        || (active_delivery.truthy()? && active_delivery.equals(entry)?)
        || item.get(c"state")?.is_string("leased")?
    {
        return Ok(fail("queued_entry_already_claimed")?.raw());
    }
    if !item.get(c"state")?.is_string("pending")? {
        return Ok(fail("queued_entry_not_pending")?.raw());
    }
    let at = draft.from_value(&V::Number(clock.call_plain(&[])?.explicit_number()?))?;
    item.assign(c"state", draft.from_value(&V::string("cancelled"))?)?;
    item.assign(c"cancelledAt", at)?;
    item.assign(c"updatedAt", at)?;
    item.assign(
        c"lastError",
        string_prefix(draft, reason, "cancelled before start", 500)?,
    )?;
    if schedule.get(c"priorityEntryId")?.equals(entry)? {
        schedule.assign(c"priorityEntryId", draft.from_value(&V::Null)?)?;
    }
    schedule.assign(c"updatedAt", at)?;
    let cancelled = draft.from_value(&V::object(Vec::<(&str, V)>::new()))?;
    cancelled.set(c"entryId", entry)?;
    cancelled.set(c"actor", string_prefix(draft, actor, "user", 80)?)?;
    cancelled.set(c"at", at)?;
    let public = project.call_plain(&[schedule])?;
    let result = draft.from_value(&V::object(vec![("ok", true.into())]))?;
    result.set(c"cancelled", cancelled)?;
    result.set(c"schedule", public)?;
    Ok(result.raw())
}

// Separate live arguments preserve the original getter and clock order.
#[allow(clippy::too_many_arguments)]
#[napi]
pub fn schedule_edit_queued_live(
    env: Env,
    draft: Unknown<'_>,
    session_id: Unknown<'_>,
    entry_id: Unknown<'_>,
    text: Unknown<'_>,
    actor: Unknown<'_>,
    clock: Unknown<'_>,
    queue: Unknown<'_>,
    project: Unknown<'_>,
) -> Result<napi::sys::napi_value> {
    let draft = L::new(&env, draft);
    let session_id = L::new(&env, session_id);
    let entry = L::new(&env, entry_id);
    let text = L::new(&env, text);
    let actor = L::new(&env, actor);
    let clock = L::new(&env, clock);
    let queue = L::new(&env, queue);
    let project = L::new(&env, project);
    let fail = |code: &str| {
        draft.from_value(&V::object(vec![
            ("ok", false.into()),
            ("code", V::string(code)),
        ]))
    };
    let item = draft.get(c"outbox")?.get_key(entry)?;
    if !item.truthy()? || !item.get(c"sessionId")?.equals(session_id)? {
        return Ok(fail("queued_entry_not_found")?.raw());
    }
    let ensure_at = draft.from_value(&V::Number(clock.call_plain(&[])?.explicit_number()?))?;
    let schedule = ensure_schedule(draft, session_id, ensure_at)?;
    let active_entry = schedule.optional(c"active")?.optional(c"entryId")?;
    let active_delivery = schedule.optional(c"active")?.optional(c"deliveryId")?;
    if (active_entry.truthy()? && active_entry.equals(entry)?)
        || (active_delivery.truthy()? && active_delivery.equals(entry)?)
        || item.get(c"state")?.is_string("leased")?
    {
        return Ok(fail("queued_entry_already_claimed")?.raw());
    }
    if !item.get(c"state")?.is_string("pending")? {
        return Ok(fail("queued_entry_not_pending")?.raw());
    }
    let message = item.optional(c"payload")?.optional(c"message")?;
    let value = if !message.nullish()? {
        message
    } else {
        let task = item.optional(c"payload")?.optional(c"taskText")?;
        if !task.nullish()? {
            task
        } else {
            let delivery = item.optional(c"payload")?.optional(c"deliveryText")?;
            if !delivery.nullish()? {
                delivery
            } else {
                draft.from_value(&V::string(""))?
            }
        }
    };
    let string_fn = draft.global()?.get(c"String")?;
    let previous_full = string_fn.call_plain(&[value])?;
    if text.get(c"length")?.number()? > 20000.0
        && text.get(c"length")?.number()? > previous_full.get(c"length")?.number()?
    {
        let result = fail("queued_entry_text_too_long")?;
        result.set(c"limit", draft.from_value(&V::Number(20000.0))?)?;
        return Ok(result.raw());
    }
    let at = draft.from_value(&V::Number(clock.call_plain(&[])?.explicit_number()?))?;
    let payload = item.optional(c"payload")?;
    let payload = if payload.truthy()? {
        payload
    } else {
        draft.from_value(&V::object(Vec::<(&str, V)>::new()))?
    };
    let message = payload.get(c"message")?;
    let shown = if message.truthy()? {
        message
    } else {
        let task = payload.get(c"taskText")?;
        if task.truthy()? {
            task
        } else {
            let delivery = payload.get(c"deliveryText")?;
            if delivery.truthy()? {
                delivery
            } else {
                draft.from_value(&V::string(""))?
            }
        }
    };
    let previous = string_prefix(draft, shown, "", 20000)?;
    let original_payload = item.get(c"payload")?;
    let replacement = draft.from_value(&V::object(Vec::<(&str, V)>::new()))?;
    if original_payload.truthy()? {
        replacement.spread_from(original_payload)?;
    }
    replacement.set(c"message", text)?;
    item.assign(c"payload", replacement)?;
    item.assign(c"updatedAt", at)?;
    schedule.assign(c"updatedAt", at)?;
    let queued = queue.call_plain(&[])?;
    let edited = draft.from_value(&V::object(Vec::<(&str, V)>::new()))?;
    edited.set(c"entryId", entry)?;
    edited.set(c"previous", previous)?;
    edited.set(c"text", text)?;
    edited.set(c"actor", string_prefix(draft, actor, "user", 80)?)?;
    edited.set(c"at", at)?;
    let public = project.call_plain(&[schedule, queued])?;
    let result = draft.from_value(&V::object(vec![("ok", true.into())]))?;
    result.set(c"edited", edited)?;
    result.set(c"schedule", public)?;
    Ok(result.raw())
}
