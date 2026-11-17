//! Live delivery provenance classification, with a stable lookup object for inherited accessors.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, check_status, sys, Env, Result};
use napi_derive::napi;
use std::ptr;

#[napi]
pub struct RustDeliveryClassifier {
    env: sys::napi_env,
    map: sys::napi_ref,
}

impl Drop for RustDeliveryClassifier {
    fn drop(&mut self) {
        unsafe { sys::napi_delete_reference(self.env, self.map) };
    }
}

#[napi]
impl RustDeliveryClassifier {
    #[napi(constructor)]
    pub fn new(env: Env, seed: Unknown<'_>) -> Result<Self> {
        let seed = L::new(&env, seed);
        let map = seed
            .from_value(&V::object(vec![
                ("task.interrupted", V::string("notice")),
                ("wait.result", V::string("continuation")),
                ("wait.callback", V::string("continuation")),
                ("wait.resolved", V::string("continuation")),
                ("detached.result", V::string("continuation")),
                ("dispatch.result", V::string("result")),
                ("dispatch.request", V::string("task")),
            ]))?
            .freeze()?;
        let mut reference = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_reference(env.raw(), map.raw(), 1, &mut reference)
        })?;
        Ok(Self {
            env: env.raw(),
            map: reference,
        })
    }

    #[napi]
    pub fn classify(&self, env: Env, item: Unknown<'_>) -> Result<sys::napi_value> {
        let item = L::new(&env, item);
        let payload = item.optional(c"payload")?;
        let payload = if payload.truthy()? {
            payload
        } else {
            item.from_value(&V::Object(vec![]))?
        };
        let mut map = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_reference_value(env.raw(), self.map, &mut map) })?;
        let map = L::from_raw(env.raw(), map);
        let explicit = map.get_key(payload.get(c"type")?)?;
        if explicit.truthy()? {
            return Ok(explicit.raw());
        }
        let value = if payload.get(c"type")?.is_string("session.work")? {
            if payload.get(c"source")?.is_string("direct")? {
                "turn"
            } else {
                "task"
            }
        } else {
            "notice"
        };
        Ok(item.from_value(&V::string(value))?.raw())
    }
}
