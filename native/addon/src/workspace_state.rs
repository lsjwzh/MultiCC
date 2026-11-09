//! Status/summary host orchestration around a single native owner. Live record
//! and persistence ports remain until their lifecycle migrates. No JS map is
//! retained, and no borrow is held while entering a host getter or callback.
use crate::{
    js_host_value::{Value, Values},
    js_live::LiveValue as L,
    session_state,
};
use multicc_core::{
    js::{self, JsString, JsValue as V},
    workspace_state::{RunState, Status, Store, Summary},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::cell::RefCell;

fn id(value: L<'_>) -> Result<JsString> {
    value
        .string()?
        .ok_or_else(|| value.type_error("[workspace] session id must be a string"))
}
fn object(anchor: L<'_>) -> Result<L<'_>> {
    anchor.from_value(&V::Object(vec![]))
}
fn get<'a>(map: L<'a>, key: L<'a>) -> Result<L<'a>> {
    map.get(c"get")?.call(map, &[key])
}
fn clock(port: L<'_>) -> Result<L<'_>> {
    port.get(c"clock")?.call_plain(&[])
}

#[napi]
pub struct RustWorkspaceState {
    state: RefCell<Store<Value>>,
    values: Values,
}
impl RustWorkspaceState {
    fn status_value<'a>(
        &self,
        env: &'a Env,
        anchor: L<'a>,
        status: &Status<Value>,
    ) -> Result<L<'a>> {
        let out = object(anchor)?;
        let raw = anchor.from_value(&status.run.value())?;
        out.set(c"status", raw.get(c"status")?)?;
        if status.hydrated {
            out.set(
                c"currentFile",
                self.values.read(env, anchor, &status.current_file)?,
            )?;
        }
        for key in [c"lastActivity", c"runStartedAt", c"runEndedAt"] {
            out.set(key, raw.get(key)?)?;
        }
        if !status.hydrated {
            out.set(
                c"currentFile",
                self.values.read(env, anchor, &status.current_file)?,
            )?;
        }
        Ok(out)
    }
    fn summary_value<'a>(
        &self,
        env: &'a Env,
        anchor: L<'a>,
        summary: &Summary<Value>,
    ) -> Result<L<'a>> {
        let out = object(anchor)?;
        out.set(c"summary", self.values.read(env, anchor, &summary.summary)?)?;
        out.set(c"ts", self.values.read(env, anchor, &summary.ts)?)?;
        Ok(out)
    }
    fn hydrate_record(
        &self,
        env: &Env,
        session: L<'_>,
        record: L<'_>,
        port: L<'_>,
        display: L<'_>,
    ) -> Result<()> {
        if !record.truthy()? {
            return Ok(());
        }
        let key = id(session)?;
        if record.get(c"summary")?.truthy()? {
            let summary = record.get(c"summary")?;
            let timestamp = record.get(c"summaryTs")?;
            let ts = if timestamp.truthy()? {
                timestamp
            } else {
                clock(port)?
            };
            let value = Summary {
                summary: self.values.capture(env, summary)?,
                ts: self.values.capture(env, ts)?,
            };
            self.state.borrow_mut().set_summary(key.clone(), value);
        }
        if record.get(c"type")?.is_string("aux")? || record.get(c"type")?.is_string("gateway")? {
            return Ok(());
        }
        let task = record.get(c"taskState")?;
        let classify = if task.truthy()? {
            record.get(c"taskState")?.get(c"classifyState")?
        } else {
            task
        };
        if !classify.truthy()? {
            return Ok(());
        }
        let entry = display.get_key(classify)?;
        let entry = if entry.truthy()? {
            entry
        } else {
            display.get(c"W")?
        };
        let status = entry.get(c"cardStatus")?.string()?;
        self.state.borrow_mut().set_status(
            key,
            Status {
                run: RunState {
                    status,
                    ..RunState::default()
                },
                current_file: Value::Native(V::Null),
                hydrated: true,
            },
        );
        Ok(())
    }
}
#[napi]
impl RustWorkspaceState {
    #[napi(constructor)]
    pub fn new(env: Env, anchor: Unknown<'_>) -> Result<Self> {
        Ok(Self {
            state: RefCell::new(Store::default()),
            values: Values::new(L::new(&env, anchor))?,
        })
    }
    #[napi]
    pub fn status(&self, env: Env, session: Unknown<'_>) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = L::new(&env, session);
        let value = anchor
            .string()?
            .and_then(|id| self.state.borrow().status(&id).cloned());
        Ok(match value {
            Some(value) => self.status_value(&env, anchor, &value)?,
            None => anchor.from_value(&V::Undefined)?,
        }
        .raw())
    }
    #[napi]
    pub fn summary(&self, env: Env, session: Unknown<'_>) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = L::new(&env, session);
        let value = anchor
            .string()?
            .and_then(|id| self.state.borrow().summary(&id).cloned());
        Ok(match value {
            Some(value) => self.summary_value(&env, anchor, &value)?,
            None => anchor.from_value(&V::Undefined)?,
        }
        .raw())
    }
    #[napi]
    pub fn has(&self, env: Env, kind: String, session: Unknown<'_>) -> Result<bool> {
        self.values.drain(&env)?;
        let key = L::new(&env, session).string()?;
        Ok(key.is_some_and(|key| {
            let state = self.state.borrow();
            if kind == "status" {
                state.status(&key).is_some()
            } else {
                state.summary(&key).is_some()
            }
        }))
    }
    #[napi]
    pub fn size(&self, kind: String) -> u32 {
        let state = self.state.borrow();
        if kind == "status" {
            state.status_len() as u32
        } else {
            state.summary_len() as u32
        }
    }
    #[napi]
    pub fn delete(&self, env: Env, kind: String, session: Unknown<'_>) -> Result<bool> {
        self.values.drain(&env)?;
        let key = L::new(&env, session).string()?;
        let removed = key.is_some_and(|key| {
            let mut state = self.state.borrow_mut();
            if kind == "status" {
                state.delete_status(&key)
            } else {
                state.delete_summary(&key)
            }
        });
        self.values.drain(&env)?;
        Ok(removed)
    }
    #[napi]
    pub fn hydrate(&self, env: Env, port: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let port = L::new(&env, port);
        let catalog = port.from_value(&js::from_serde(
            &multicc_core::classify_vocab::catalog_value(),
        ))?;
        let display = catalog.get(c"classifyDisplay")?;
        let records = port.get(c"records")?;
        records.for_each(|item| {
            let (session, record) = item.iterator_pair()?;
            self.hydrate_record(&env, session, record, port, display)?;
            Ok(())
        })?;
        self.values.drain(&env)
    }
    #[napi]
    pub fn set_summary(
        &self,
        env: Env,
        session: Unknown<'_>,
        summary: Unknown<'_>,
        port: Unknown<'_>,
    ) -> Result<bool> {
        self.values.drain(&env)?;
        let session = L::new(&env, session);
        let summary = L::new(&env, summary);
        let port = L::new(&env, port);
        if !summary.truthy()? {
            return Ok(false);
        }
        let record = get(port.get(c"records")?, session)?;
        if !record.truthy()?
            || record.get(c"type")?.is_string("aux")?
            || record.get(c"type")?.is_string("gateway")?
        {
            return Ok(false);
        }
        let ts = clock(port)?;
        let value = Summary {
            summary: self.values.capture(&env, summary)?,
            ts: self.values.capture(&env, ts)?,
        };
        self.state.borrow_mut().set_summary(id(session)?, value);
        let changed = !record.get(c"summary")?.equals(summary)?;
        if changed {
            record.assign(c"summary", summary)?;
        }
        if changed
            || !record
                .get(c"taskState")?
                .optional(c"lastSummary")?
                .equals(summary)?
        {
            let patch = object(port)?;
            patch.set(c"lastSummary", summary)?;
            patch.set(c"lastSummaryAt", ts)?;
            port.get(c"setTaskState")?.call_plain(&[
                session,
                patch,
                port.from_value(&V::object(vec![("save", V::Bool(false))]))?,
            ])?;
            port.get(c"saveBestEffort")?
                .call_plain(&[port.from_value(&V::string("runtime.session-summary"))?])?;
        }
        let broadcast = port.get(c"broadcast")?;
        let dir = record.get(c"dirId")?;
        let event = port.from_value(&V::object(vec![("type", V::string("summary"))]))?;
        event.set(c"sessionId", session)?;
        event.set(c"summary", summary)?;
        event.set(c"ts", ts)?;
        broadcast.call_plain(&[dir, event])?;
        self.values.drain(&env)?;
        Ok(true)
    }
    #[napi]
    pub fn set_status(
        &self,
        env: Env,
        session: Unknown<'_>,
        patch: Unknown<'_>,
        port: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let session = L::new(&env, session);
        let patch = L::new(&env, patch);
        let port = L::new(&env, port);
        let record = get(port.get(c"records")?, session)?;
        if !record.truthy()? || record.get(c"type")?.is_string("aux")? {
            return Ok(port.from_value(&V::Null)?.raw());
        }
        let key = id(session)?;
        let previous = self.state.borrow().status(&key).cloned().unwrap_or(Status {
            run: RunState::default(),
            current_file: Value::Native(V::Null),
            hydrated: true,
        });
        let now = clock(port)?;
        let pending = get(port.get(c"chatSessions")?, session)?
            .optional(c"currentTask")?
            .optional(c"pendingDispatches")?;
        let pending = pending.truthy()? && pending.get(c"length")?.positive()?;
        let now = if now.undefined()? {
            let date = port.global()?.get(c"Date")?;
            date.get(c"now")?.call(date, &[])?
        } else {
            now
        };
        let transition =
            session_state::calculate(&previous.run.normalized(), patch, now, pending, None)?;
        let current_file = if !patch.get(c"currentFile")?.undefined()? {
            self.values.capture(&env, patch.get(c"currentFile")?)?
        } else {
            previous.current_file.clone()
        };
        let next = Status {
            run: transition.state,
            current_file,
            hydrated: false,
        };
        self.state.borrow_mut().set_status(key, next.clone());
        let same_file = self
            .values
            .read(&env, port, &next.current_file)?
            .equals(self.values.read(&env, port, &previous.current_file)?)?;
        let result = self.status_value(&env, port, &next)?;
        if next.run.status != previous.run.status || !same_file {
            let broadcast = port.get(c"broadcast")?;
            let dir = record.get(c"dirId")?;
            let event = port.from_value(&V::object(vec![("type", V::string("status"))]))?;
            event.set(c"sessionId", session)?;
            for field in [
                c"status",
                c"currentFile",
                c"lastActivity",
                c"runStartedAt",
                c"runEndedAt",
            ] {
                event.set(field, result.get(field)?)?;
            }
            let merge = port.get(c"mergeState")?;
            let directory = get(port.get(c"directories")?, record.get(c"dirId")?)?;
            event.set(c"mergeState", merge.call_plain(&[directory, record])?)?;
            broadcast.call_plain(&[dir, event])?;
        }
        self.values.drain(&env)?;
        Ok(result.raw())
    }
}
