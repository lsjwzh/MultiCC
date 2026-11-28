//! Rust owns task membership and insertion order. The process object is only
//! the kill(pid, 0) host port; injected probes retain their original exceptions.
use crate::host_api::*;
use multicc_core::js::JsString;
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
struct Ledger(RefCell<Vec<(JsString, Option<f64>)>>);

pub(super) fn create<'a>(process: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let options = default_object(a[0])?;
    let probe = crate::js_iteration::read(options, c"isAlive")?;
    let p = fields(process, &[("process", process), ("probe", probe)])?;
    let state = Rc::new(Ledger::default());
    let observe = {
        let state = state.clone();
        function(p, "observe", 1, 1, move |p, a| {
            let value = a[0];
            if !value.truthy()? || !value.get(c"type")?.is_string("session.updated")? {
                return flag(p, false);
            }
            let payload = value.get(c"payload")?;
            if !payload.truthy()?
                || payload.get(c"taskId")?.kind()? != sys::ValueType::napi_string
                || !payload.get(c"taskId")?.truthy()?
                || payload.get(c"status")?.kind()? != sys::ValueType::napi_string
            {
                return flag(p, false);
            }
            let before = state.0.borrow().len();
            let status = payload.get(c"status")?;
            let running = ["running", "pending", "queued", "starting"]
                .iter()
                .try_fold(false, |yes, s| {
                    Ok::<_, napi::Error>(yes || status.is_string(s)?)
                })?;
            if running {
                let integer = call(
                    p.global()?.get(c"Number")?,
                    c"isInteger",
                    &[payload.get(c"pid")?],
                )?
                .truthy()?;
                // Read every host getter before borrowing native state.
                let valid = integer && payload.get(c"pid")?.number()? > 0.0;
                let pid = if valid {
                    Some(payload.get(c"pid")?.number()?)
                } else {
                    None
                };
                let id = payload.get(c"taskId")?.string()?.unwrap_or_default();
                let mut entries = state.0.borrow_mut();
                if let Some((_, previous)) = entries.iter_mut().find(|(key, _)| key == &id) {
                    if pid.is_some() {
                        *previous = pid;
                    }
                } else {
                    entries.push((id, pid));
                }
            } else {
                let id = payload.get(c"taskId")?.string()?.unwrap_or_default();
                state.0.borrow_mut().retain(|(key, _)| key != &id);
            }
            flag(p, state.0.borrow().len() != before)
        })?
    };
    let prune = {
        let state = state.clone();
        function(p, "prune", 0, 0, move |p, _| {
            let snapshot = state.0.borrow().clone();
            let before = snapshot.len();
            for (id, pid) in snapshot {
                if let Some(pid) = pid {
                    let probe = p.get(c"probe")?;
                    let alive = if probe.undefined()? {
                        let result =
                            call(p.get(c"process")?, c"kill", &[num(p, pid)?, num(p, 0.0)?]);
                        if result.is_ok() {
                            true
                        } else if let Some(error) = p.exception_value()? {
                            // Clear only kill's exception. An error.code getter
                            // that throws is outside that catch and propagates.
                            error.truthy()? && error.get(c"code")?.is_string("EPERM")?
                        } else {
                            false
                        }
                    } else {
                        probe.call_plain(&[num(p, pid)?])?.truthy()?
                    };
                    if !alive {
                        state.0.borrow_mut().retain(|(key, _)| key != &id);
                    }
                }
            }
            flag(p, state.0.borrow().len() != before)
        })?
    };
    let api = fields(p, &[("observe", observe), ("prune", prune)])?;
    let getter = function(p, "get active", 0, 0, move |p, _| {
        num(p, state.0.borrow().len() as f64)
    })?;
    call(
        p.global()?.get(c"Object")?,
        c"defineProperty",
        &[
            api,
            text(p, "active")?,
            fields(
                p,
                &[
                    ("get", getter),
                    ("enumerable", flag(p, true)?),
                    ("configurable", flag(p, true)?),
                ],
            )?,
        ],
    )?;
    Ok(api)
}
