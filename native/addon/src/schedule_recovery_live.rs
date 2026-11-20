//! Compatibility drafts use the same recovery transition as the SQLite owner.
use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as V, orchestration_store};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn read(value: L<'_>) -> Result<V> {
    unsafe { crate::js_bridge::read_value(value.env(), value.raw(), 0, &mut Vec::new()) }
}

#[napi]
pub fn schedule_recover_live(
    env: Env,
    draft: Unknown<'_>,
    observe: Unknown<'_>,
    clock: Unknown<'_>,
    queue_for: Unknown<'_>,
    project: Unknown<'_>,
) -> Result<sys::napi_value> {
    let draft = L::new(&env, draft);
    let observe = L::new(&env, observe);
    let at = L::new(&env, clock).call_plain(&[])?.number()?;
    let queue_for = L::new(&env, queue_for);
    let project = L::new(&env, project);
    let global = draft.global()?;
    let schedules = draft.get(c"sessionSchedules")?;
    let object = global.get(c"Object")?;
    let keys = object.get(c"keys")?.call(object, &[schedules])?;
    let set = global.get(c"Set")?;
    let mut raw_set = std::ptr::null_mut();
    napi::check_status!(unsafe {
        sys::napi_new_instance(env.raw(), set.raw(), 1, [keys.raw()].as_ptr(), &mut raw_set)
    })?;
    let sessions = L::from_raw(env.raw(), raw_set);
    let select = draft.get(c"select")?;
    let candidates = if select.kind()? == sys::ValueType::napi_function {
        select.call(
            draft,
            &[
                draft.from_value(&V::from("outbox"))?,
                draft.from_value(&V::object(vec![(
                    "where",
                    V::object(vec![(
                        "state",
                        V::Array(vec![V::from("pending"), V::from("leased")]),
                    )]),
                )]))?,
            ],
        )?
    } else {
        object
            .get(c"values")?
            .call(object, &[draft.get(c"outbox")?])?
    };
    candidates.for_each(|item| {
        let state = item.get(c"state")?;
        if state.is_string("pending")? || state.is_string("leased")? {
            sessions
                .get(c"add")?
                .call(sessions, &[item.get(c"sessionId")?])?;
        }
        Ok(())
    })?;
    let changes = draft.from_value(&V::Array(vec![]))?;
    let mut index = 0;
    sessions.for_each(|id| {
        let held = schedules.get_key(id)?;
        let observed = observe.call_plain(&[id])?;
        let observed = if observed.truthy()? {
            observed
        } else {
            draft.from_value(&V::Object(vec![]))?
        };
        let missing = !held.truthy()?;
        let before = if missing { None } else { Some(read(held)?) };
        let delivery = held.optional(c"active")?.optional(c"deliveryId")?;
        let item = if delivery.truthy()? {
            draft.get(c"outbox")?.get_key(delivery)?
        } else {
            draft.from_value(&V::Null)?
        };
        let state = item.optional(c"state")?;
        let needs_ack =
            item.truthy()? && (state.is_string("pending")? || state.is_string("leased")?);
        let (after, event) = orchestration_store::recover_schedule_transition(
            &id.coerce_string()?.to_string_lossy(),
            before.clone(),
            &read(observed)?,
            at,
            needs_ack,
        )
        .map_err(napi::Error::from_reason)?;
        let schedule = if missing {
            let result = draft.from_value(&after)?;
            schedules.set_key(id, result)?;
            result
        } else {
            if let V::Object(fields) = &after {
                for (key, value) in fields {
                    let key = key.to_string_lossy();
                    if before.as_ref().and_then(|before| before.get(&key)) != Some(value) {
                        held.set_key(draft.from_value(&V::from(key))?, draft.from_value(value)?)?;
                    }
                }
            }
            held
        };
        if let Some(event) = event {
            let event = draft.from_value(&event)?;
            if !missing {
                let queue = queue_for.call_plain(&[draft, id])?;
                event.set(c"queued", queue.get(c"length")?)?;
                let queue = queue_for.call_plain(&[draft, id])?;
                event.set(
                    c"queuedItems",
                    project
                        .call_plain(&[schedule, queue, draft])?
                        .get(c"queued")?,
                )?;
            }
            changes.set_element(index, event)?;
            index += 1;
        }
        Ok(())
    })?;
    Ok(changes.raw())
}

#[napi]
pub fn decode_scheduler_recovery_events(env: Env, raw: String) -> Result<sys::napi_value> {
    let mut events =
        multicc_core::js::json_parse(&raw).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    if let V::Array(events) = &mut events {
        for event in events {
            if let V::Object(fields) = event {
                if let Some((_, V::Array(items))) =
                    fields.iter_mut().find(|(key, _)| key == "queuedItems")
                {
                    for item in items {
                        for key in ["entryId", "sequence", "state", "admittedAt"] {
                            if item.get(key).is_none() {
                                multicc_core::quota_guard::set(item, key, V::Undefined);
                            }
                        }
                    }
                }
            }
        }
    }
    unsafe { crate::js_bridge::write_value(env.raw(), &events) }
}
