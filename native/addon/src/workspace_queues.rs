//! Temporary host boundary for the native queue owner. Only selected input
//! fields are read; callbacks and coercions run without holding the owner lock.
use crate::js_live::LiveValue;
use multicc_core::{
    js::{JsString, JsValue as V},
    workspace_queues::{Queue, Store},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::sync::Mutex;

fn id(value: LiveValue<'_>) -> Result<JsString> {
    value
        .string()?
        .ok_or_else(|| value.type_error("[workspace] session id must be a string"))
}
fn string_or(value: LiveValue<'_>, fallback: &str) -> Result<JsString> {
    if !value.truthy()? {
        return Ok(fallback.into());
    }
    value
        .global()?
        .get(c"String")?
        .call_plain(&[value])?
        .string()?
        .ok_or_else(|| value.type_error("String did not return a string"))
}
fn normalize(session: JsString, input: LiveValue<'_>) -> Result<Queue> {
    let input = if input.undefined()? {
        input.from_value(&V::Object(vec![]))?
    } else {
        input
    };
    let state = string_or(input.get(c"state")?, "idle")?;
    let classify = string_or(input.get(c"classifyState")?, "")?;
    let depth = input.get(c"depth")?.explicit_number()?;
    let updated = input.get(c"updatedAt")?.explicit_number()?;
    Ok(Queue::new(session, state, classify, depth, updated))
}
fn snapshot<'a>(anchor: LiveValue<'a>, queue: &Queue) -> Result<LiveValue<'a>> {
    anchor.from_value(&queue.value())?.freeze()
}
fn view<'a>(anchor: LiveValue<'a>, queue: &Queue, source: LiveValue<'a>) -> Result<LiveValue<'a>> {
    // stateSource is opaque live host metadata, not cloned/enumerated/encoded.
    let value = anchor.from_value(&queue.value())?;
    value.set(c"stateSource", source)?;
    Ok(value)
}

#[napi]
pub struct RustWorkspaceQueues {
    inner: Mutex<Store>,
}

#[napi]
impl RustWorkspaceQueues {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Store::default()),
        }
    }

    #[napi]
    pub fn get(&self, env: Env, session_id: Unknown<'_>) -> Result<sys::napi_value> {
        let anchor = LiveValue::new(&env, session_id);
        let key = anchor.string()?;
        let queue = key.as_ref().and_then(|key| {
            self.inner
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(key)
                .cloned()
        });
        Ok(match queue {
            Some(queue) => snapshot(anchor, &queue)?,
            None => anchor.from_value(&V::Undefined)?,
        }
        .raw())
    }

    #[napi]
    pub fn has(&self, env: Env, session_id: Unknown<'_>) -> Result<bool> {
        let key = LiveValue::new(&env, session_id).string()?;
        Ok(key.as_ref().is_some_and(|key| {
            self.inner
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(key)
                .is_some()
        }))
    }

    #[napi(getter)]
    pub fn size(&self) -> u32 {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).len() as u32
    }

    #[napi]
    pub fn update(
        &self,
        env: Env,
        session_id: Unknown<'_>,
        input: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let anchor = LiveValue::new(&env, session_id);
        let queue = normalize(id(anchor)?, LiveValue::new(&env, input))?;
        // All input getters have finished. A reentrant update must be visible
        // to the stale-event check, not overwritten from an earlier snapshot.
        let update = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .update(queue);
        let result = anchor.from_value(&V::object(vec![("changed", V::Bool(update.changed))]))?;
        result.set(c"value", snapshot(anchor, &update.queue)?)?;
        Ok(result.raw())
    }

    #[napi]
    pub fn project(
        &self,
        env: Env,
        session_id: Unknown<'_>,
        input: Unknown<'_>,
        state_source: Unknown<'_>,
        clock: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let anchor = LiveValue::new(&env, session_id);
        let input = LiveValue::new(&env, input);
        let clock = LiveValue::new(&env, clock);
        let next = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .next_view_time();
        let now = clock.call_plain(&[])?;
        // JS evaluates Number(queue?.updatedAt) before Math.max coerces now.
        let updated = input.optional(c"updatedAt")?.explicit_number()?;
        let now = now.number()?;
        let at = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .advance_view(next, now, updated);
        // Clock publication precedes normalization, including its exceptions.
        let queue = Store::project(id(anchor)?, normalize(id(anchor)?, input)?, at);
        Ok(view(anchor, &queue, LiveValue::new(&env, state_source))?.raw())
    }

    #[napi]
    pub fn view(
        &self,
        env: Env,
        session_id: Unknown<'_>,
        execution_id: Unknown<'_>,
        state_source: Unknown<'_>,
        clock: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let anchor = LiveValue::new(&env, session_id);
        let session = id(anchor)?;
        let execution = LiveValue::new(&env, execution_id).string()?;
        let (queue, next) = {
            let owner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            (
                execution
                    .as_ref()
                    .and_then(|key| owner.get(key))
                    .cloned()
                    .unwrap_or_else(|| Queue::empty(session.clone())),
                owner.next_view_time(),
            )
        };
        let now = LiveValue::new(&env, clock).call_plain(&[])?.number()?;
        let at = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .advance_view(next, now, queue.updated_at);
        let queue = Store::project(session, queue, at);
        Ok(view(anchor, &queue, LiveValue::new(&env, state_source))?.raw())
    }
}
