use crate::js_live::LiveValue;
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi::{bindgen_prelude::Unknown, sys};
use napi_derive::napi;

pub struct ReadContext {
    input: String,
}
impl Task for ReadContext {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        multicc_core::opencode_context::read(&self.input).map_err(napi::Error::from_reason)
    }
    fn resolve(&mut self, _: Env, value: String) -> Result<String> {
        Ok(value)
    }
}

#[napi]
pub fn read_opencode_context(input: String) -> AsyncTask<ReadContext> {
    AsyncTask::new(ReadContext { input })
}

#[napi]
pub fn plan_opencode_context(input: String) -> Result<String> {
    multicc_core::opencode_context::plan(&input).map_err(napi::Error::from_reason)
}

// A pending cross-CLI handoff may contain live, non-serializable host fields.
// Copy its enumerable properties with V8 semantics and keep nested references.
#[napi]
pub fn prepare_opencode_rotation_handoff(
    env: Env,
    session: Unknown<'_>,
    build_checkpoint: Unknown<'_>,
    new_id: Unknown<'_>,
) -> Result<sys::napi_value> {
    let session = LiveValue::new(&env, session);
    let pending = session.get(c"pendingCliHandoff")?;
    let pending = if pending.optional(c"status")?.is_string("pending")? {
        session.get(c"pendingCliHandoff")?
    } else {
        session.from_value(&JsValue::Null)?
    };
    let checkpoint = session.from_value(&JsValue::Object(vec![]))?;
    let source = pending.optional(c"checkpoint")?;
    checkpoint.spread_from(if source.truthy()? {
        source
    } else {
        LiveValue::new(&env, build_checkpoint).call_plain(&[])?
    })?;
    let reason = session.from_value(&JsValue::string("auto_native_context_rotate"))?;
    checkpoint.set(c"reason", reason)?;

    let handoff = session.from_value(&JsValue::Object(vec![]))?;
    handoff.spread_from(pending)?;
    let id = pending.optional(c"id")?;
    handoff.set(
        c"id",
        if id.truthy()? {
            id
        } else {
            LiveValue::new(&env, new_id).call_plain(&[])?
        },
    )?;
    let opencode = session.from_value(&JsValue::string("opencode"))?;
    let origin = pending.optional(c"fromCli")?;
    handoff.set(c"fromCli", if origin.truthy()? { origin } else { opencode })?;
    handoff.set(c"toCli", opencode)?;
    let created_at = pending.optional(c"createdAt")?;
    handoff.set(
        c"createdAt",
        if created_at.truthy()? {
            created_at
        } else {
            checkpoint.get(c"createdAt")?
        },
    )?;
    handoff.set(c"status", session.from_value(&JsValue::string("pending"))?)?;
    handoff.set(c"reason", reason)?;
    handoff.set(c"reusedTarget", session.from_value(&JsValue::Bool(false))?)?;
    handoff.set(c"checkpoint", checkpoint)?;
    Ok(handoff.raw())
}
