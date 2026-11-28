//! The originating model reads the terminal result first. Only a subsequent
//! acknowledgement of that exact version can withdraw a pending FIFO wake-up.
use crate::orchestration_runtime::wakeups::Withdrawals;
use crate::{js_live::LiveValue as L, schedule_lifecycle_live::cancel_pending_entry};
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn detached_result_live(
    env: Env,
    draft: Unknown<'_>,
    session: Unknown<'_>,
    operation_id: Unknown<'_>,
    acknowledge_version: Unknown<'_>,
    clock: Unknown<'_>,
    project: Unknown<'_>,
) -> Result<sys::napi_value> {
    let draft = L::new(&env, draft);
    let session = L::new(&env, session);
    let id = L::new(&env, operation_id);
    let ack = L::new(&env, acknowledge_version);
    let operation = draft.get(c"operations")?.get_key(id)?;
    let error = |code: &str| {
        Ok(draft
            .from_value(&V::object(vec![
                ("ok", false.into()),
                ("code", V::string(code)),
            ]))?
            .raw())
    };
    if !operation.truthy()?
        || !operation.get(c"kind")?.is_string("detached")?
        || !operation.get(c"ownerSessionId")?.equals(session)?
        || !operation.get(c"resultSessionId")?.equals(session)?
    {
        return error("detached_operation_not_found");
    }
    let reply = draft.from_value(&V::object(vec![("ok", true.into())]))?;
    reply.set(c"operation_id", id)?;
    reply.set(c"status", operation.get(c"status")?)?;
    let version = operation.get(c"resultHash")?;
    if ack.nullish()? {
        if version.truthy()? {
            reply.set(c"result_version", version)?;
            reply.set(c"result", operation.get(c"result")?)?;
        }
        return Ok(reply.raw());
    }
    if !version.truthy()? {
        return error("detached_result_not_ready");
    }
    if !ack.equals(version)? {
        return error("detached_result_version_mismatch");
    }
    let outbox_id = operation.get(c"resultOutboxId")?;
    let item = draft.get(c"outbox")?.get_key(outbox_id)?;
    if !item.truthy()? {
        return error("detached_notification_not_found");
    }
    let payload = item.get(c"payload")?;
    if !item.get(c"sessionId")?.equals(session)?
        || !payload.optional(c"type")?.is_string("detached.result")?
        || !payload.optional(c"operationId")?.equals(id)?
    {
        return error("detached_notification_mismatch");
    }
    let clock = L::new(&env, clock);
    let state = item.get(c"state")?;
    if item.get(c"acknowledgedResultHash")?.equals(version)? {
        reply.set(c"notification", draft.from_value(&V::string("withdrawn"))?)?;
    } else if state.is_string("pending")? {
        let changed = cancel_pending_entry(
            draft,
            session,
            outbox_id,
            draft.from_value(&V::string("result_recipient"))?,
            draft.from_value(&V::string(
                "terminal result acknowledged by originating session",
            ))?,
            clock,
            L::new(&env, project),
        )?;
        if !changed.get(c"ok")?.is_true()? {
            return Ok(changed.raw());
        }
        item.assign(c"acknowledgedResultHash", version)?;
        reply.set(c"notification", draft.from_value(&V::string("withdrawn"))?)?;
        reply.set(c"queueChange", changed)?;
    } else {
        reply.set(c"notification", state)?;
    }
    let external = operation.get(c"externalId")?;
    if external.kind()? == sys::ValueType::napi_string && external.truthy()? {
        let withdrawals = Withdrawals::new(draft, session, clock)?;
        withdrawals.matching_waits(
            &[external],
            None,
            None,
            draft.from_value(&V::Undefined)?,
            "detached_result_acknowledged",
        )?;
        let changes = withdrawals.finish()?;
        if changes.get(c"cancelled")?.get(c"length")?.truthy()?
            || changes.get(c"pendingWaitIds")?.get(c"length")?.truthy()?
        {
            let result_change = reply.get(c"queueChange")?;
            if result_change.truthy()? && changes.get(c"schedule")?.truthy()? {
                result_change.set(c"schedule", changes.get(c"schedule")?)?;
            }
            reply.set(c"wakeupChanges", changes)?;
        }
    }
    Ok(reply.raw())
}
