//! Ordered, persistent Air pins and manual todos. No state borrow crosses a
//! host call: reading the task board or reporting a store failure can reenter.
use crate::js_live::LiveValue as L;
use multicc_core::js::{serde::from_serde, JsString, JsValue as J};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;
use std::{cell::RefCell, collections::BTreeSet};

const PIN_LIMIT: u32 = 100;
const TODO_LIMIT: u32 = 500;

#[napi]
pub fn air_task_list_spec(env: Env, todo: bool) -> Result<sys::napi_value> {
    let (kind, route, limit, label, file_key, prefix) = if todo {
        (
            "air-todos",
            "/api/air/todos",
            TODO_LIMIT,
            "标记待办",
            "airTodosFile",
            "todo",
        )
    } else {
        (
            "air-pins",
            "/api/air/pins",
            PIN_LIMIT,
            " Pin",
            "airPinsFile",
            "pin",
        )
    };
    let spec = serde_json::json!({
        "kind": kind, "route": route, "limit": limit, "label": label, "fileKey": file_key,
        "codes": {"limitReached": format!("{prefix}_limit_reached"), "saveFailed": format!("{prefix}_save_failed"), "failed": format!("{prefix}_failed")}
    });
    Ok(L::new(&env, ().into_unknown(&env)?)
        .from_value(&from_serde(&spec))?
        .raw())
}

fn array<'a>(anchor: L<'a>, ids: Vec<JsString>) -> Result<L<'a>> {
    anchor.from_value(&J::Array(ids.into_iter().map(J::String).collect()))
}

fn normalize(value: L<'_>, limit: L<'_>) -> Result<Vec<JsString>> {
    let mut ids = Vec::new();
    if !value.is_array()? {
        return Ok(ids);
    }
    let numeric = limit.number_value()?;
    let mut seen = BTreeSet::new();
    value.for_each_while(|raw| {
        let Some(text) = raw.string()? else {
            return Ok(true);
        };
        let id = text.trim();
        if id.is_empty() || !seen.insert(id.clone()) {
            return Ok(true);
        }
        ids.push(id);
        // Objects can supply a different limit on each comparison, including
        // throwing. Do not coerce the limit before admitting the first ID.
        let cap = match numeric {
            Some(n) => n,
            None => limit.explicit_number()?,
        };
        Ok(cap.is_nan() || (ids.len() as f64) < cap)
    })?;
    Ok(ids)
}

#[napi]
pub fn air_normalize_task_ids(
    env: Env,
    input: Unknown<'_>,
    limit: Unknown<'_>,
) -> Result<sys::napi_value> {
    let value = L::new(&env, input);
    let limit = L::new(&env, limit);
    let cap = if limit.undefined()? {
        value.from_value(&J::Number(PIN_LIMIT.into()))?
    } else {
        limit
    };
    Ok(array(value, normalize(value, cap)?)?.raw())
}

#[napi]
pub fn air_stored_pins(env: Env, raw: Unknown<'_>) -> Result<sys::napi_value> {
    let raw = L::new(&env, raw);
    let data = raw.optional(c"data")?;
    let body = if data.truthy()? { data } else { raw };
    let ids = body.optional(c"taskIds")?;
    if !ids.is_array()? {
        let message = raw.from_value(&J::string("air pins unavailable"))?;
        return Err(raw
            .global()?
            .get(c"Error")?
            .construct(&[message])?
            .throw_error());
    }
    Ok(array(
        ids,
        normalize(ids, ids.from_value(&J::Number(PIN_LIMIT.into()))?)?,
    )?
    .raw())
}

#[napi]
#[derive(Default)]
pub struct RustAirTaskList {
    pinned: RefCell<Option<Vec<JsString>>>,
}

struct Operation<'a> {
    owner: &'a RustAirTaskList,
    ports: L<'a>,
    spec: L<'a>,
    limit: L<'a>,
}

impl<'a> Operation<'a> {
    fn call(&self, name: &std::ffi::CStr, args: &[L<'a>]) -> Result<L<'a>> {
        self.ports.get(name)?.call(self.ports, args)
    }

    fn known(&self) -> Result<Option<L<'a>>> {
        self.ports.catch(|| {
            let ids = self.call(c"listTaskIds", &[])?;
            self.ports.global()?.get(c"Set")?.construct(&[ids])
        })
    }

    fn filter(&self, ids: Vec<JsString>, known: Option<L<'a>>) -> Result<Vec<JsString>> {
        let Some(known) = known else {
            return Ok(ids);
        };
        let mut result = Vec::new();
        for id in ids {
            let value = known.from_value(&J::String(id.clone()))?;
            if known.get(c"has")?.call(known, &[value])?.truthy()? {
                result.push(id);
            }
        }
        Ok(result)
    }

    fn read(&self) -> Result<Vec<JsString>> {
        let known = self.known()?;
        let cached = self.owner.pinned.borrow().clone();
        let ids = match cached {
            Some(ids) => ids,
            None => {
                let ids = normalize(self.call(c"load", &[])?, self.limit)?;
                self.owner.pinned.replace(Some(ids.clone()));
                ids
            }
        };
        self.filter(ids, known)
    }

    fn replace(&self, value: L<'a>) -> Result<Vec<JsString>> {
        let known = self.known()?;
        let previous = self.read()?;
        let ids = self.filter(normalize(value, self.limit)?, known)?;
        let output = array(self.ports, ids.clone())?;
        self.owner.pinned.replace(Some(ids));
        if let Err(error) = self.call(c"save", &[output]) {
            self.owner.pinned.replace(Some(previous));
            return Err(error);
        }
        self.read()
    }

    fn refusal<T>(&self, status: f64, code: L<'a>, message: JsString) -> Result<T> {
        let error = self
            .ports
            .global()?
            .get(c"Error")?
            .construct(&[self.ports.from_value(&J::String(message))?])?;
        error.set(c"status", error.from_value(&J::Number(status))?)?;
        error.set(c"code", code)?;
        Err(error.throw_error())
    }

    fn toggle(&self, value: L<'a>) -> Result<Vec<JsString>> {
        let id = value.string()?.unwrap_or_default().trim();
        if id.is_empty() {
            return self.refusal(
                400.0,
                value.from_value(&J::string("task_id_required"))?,
                "taskId is required".into(),
            );
        }
        if let Some(known) = self.known()? {
            if !known
                .get(c"has")?
                .call(known, &[value.from_value(&J::String(id.clone()))?])?
                .truthy()?
            {
                return self.refusal(
                    404.0,
                    value.from_value(&J::string("task_not_found"))?,
                    "任务不存在".into(),
                );
            }
        }
        let mut current = self.read()?;
        if let Some(pos) = current.iter().position(|old| old == &id) {
            current.remove(pos);
        } else {
            if current.len() as f64 >= self.limit.explicit_number()? {
                let mut message = JsString::from_rust_str("最多只能");
                message.push(&self.spec.get(c"label")?.coerce_string()?);
                message.push_str(" ");
                message.push(&self.limit.coerce_string()?);
                message.push_str(" 个任务");
                return self.refusal(
                    409.0,
                    self.spec.get(c"codes")?.get(c"limitReached")?,
                    message,
                );
            }
            current.push(id);
        }
        self.replace(array(self.ports, current)?)
    }
}

#[napi]
impl RustAirTaskList {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn run(
        &self,
        env: Env,
        op: String,
        ports: Unknown<'_>,
        input: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let ports = L::new(&env, ports);
        let spec = ports.get(c"spec")?;
        let action = Operation {
            owner: self,
            ports,
            spec,
            limit: spec.get(c"limit")?,
        };
        let value = L::new(&env, input);
        let ids = match op.as_str() {
            "read" => action.read()?,
            "replace" => action.replace(value)?,
            "toggle" => action.toggle(value)?,
            _ => return Err(napi::Error::from_reason("unknown Air task list operation")),
        };
        Ok(array(ports, ids)?.raw())
    }
}
