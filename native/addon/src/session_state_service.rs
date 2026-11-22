//! The former session-state binding surface, including live host callbacks.
// napi registration is absent in Rust test builds; Node exercises this API.
#![cfg_attr(test, allow(dead_code))]
use crate::{js_live::LiveValue as L, session_state};
use multicc_core::{js::JsValue as V, workspace_state as core};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    check_status, sys, Env, Result,
};
use napi_derive::napi;
use std::{cell::Cell, ptr, rc::Rc};

fn object(anchor: L<'_>) -> Result<L<'_>> {
    anchor.from_value(&V::Object(vec![]))
}

fn default_object<'a>(value: L<'a>, first_key: &str) -> Result<L<'a>> {
    if value.undefined()? {
        object(value)
    } else if value.kind()? == sys::ValueType::napi_null {
        Err(value.type_error(&format!(
            "Cannot read properties of null (reading '{first_key}')"
        )))
    } else {
        Ok(value)
    }
}

fn default_now(value: L<'_>) -> Result<L<'_>> {
    if value.undefined()? {
        let date = value.global()?.get(c"Date")?;
        date.get(c"now")?.call(date, &[])
    } else {
        Ok(value)
    }
}

fn transition<'a>(prior: L<'a>, patch: L<'a>, now: L<'a>, pending: L<'a>) -> Result<L<'a>> {
    let (previous, raw_previous) = session_state::previous(prior)?;
    let value =
        session_state::calculate(&previous, patch, now, pending.truthy()?, Some(raw_previous))?;
    session_state::result(prior, &value)
}

fn arity(function: L<'_>, length: f64) -> Result<L<'_>> {
    let value = function.from_value(&V::Number(length))?;
    let descriptor = sys::napi_property_descriptor {
        utf8name: c"length".as_ptr(),
        value: value.raw(),
        attributes: sys::PropertyAttributes::configurable,
        ..unsafe { std::mem::zeroed() }
    };
    check_status!(unsafe {
        sys::napi_define_properties(function.env(), function.raw(), 1, &descriptor)
    })?;
    Ok(function)
}

// A strong reference to a callback would root callback -> service -> callback
// cycles outside V8's tracing graph. A private WeakMap uses the native function
// as an ephemeron key; only its weak N-API reference is held by the Rust closure.
struct Capture {
    env: sys::napi_env,
    map: sys::napi_ref,
    key: Cell<sys::napi_ref>,
}

impl Capture {
    fn new(anchor: L<'_>) -> Result<Rc<Self>> {
        let map = anchor.global()?.get(c"WeakMap")?.construct(&[])?;
        let mut reference = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_reference(anchor.env(), map.raw(), 1, &mut reference)
        })?;
        Ok(Rc::new(Self {
            env: anchor.env(),
            map: reference,
            key: Cell::new(ptr::null_mut()),
        }))
    }

    fn map<'a>(&self, anchor: L<'a>) -> Result<L<'a>> {
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_reference_value(self.env, self.map, &mut value) })?;
        Ok(L::from_raw(anchor.env(), value))
    }

    fn bind(&self, function: L<'_>, value: L<'_>) -> Result<()> {
        let mut reference = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_reference(self.env, function.raw(), 0, &mut reference)
        })?;
        self.key.set(reference);
        let map = self.map(function)?;
        map.get(c"set")?.call(map, &[function, value])?;
        Ok(())
    }

    fn read<'a>(&self, anchor: L<'a>) -> Result<L<'a>> {
        let mut key = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_get_reference_value(self.env, self.key.get(), &mut key)
        })?;
        if key.is_null() {
            return Err(anchor.type_error("session state callback is no longer available"));
        }
        let map = self.map(anchor)?;
        map.get(c"get")?
            .call(map, &[L::from_raw(anchor.env(), key)])
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if !self.env.is_null() {
            unsafe {
                if !self.key.get().is_null() {
                    sys::napi_delete_reference(self.env, self.key.get());
                }
                sys::napi_delete_reference(self.env, self.map);
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Plain {
    Initial,
    Running,
    Transition,
}

fn plain<'a>(env: &'a Env, name: &str, length: f64, op: Plain) -> Result<L<'a>> {
    let function =
        env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(name, move |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let arg = |index| -> Result<L<'_>> {
                if index < ctx.length() {
                    Ok(L::new(ctx.env, ctx.get::<Unknown<'_>>(index)?))
                } else {
                    Ok(absent)
                }
            };
            let value = match op {
                Plain::Initial => session_state::initial(absent)?,
                Plain::Running => {
                    let running = arg(0)?
                        .string()?
                        .is_some_and(|status| core::running(&status));
                    absent.from_value(&V::Bool(running))?
                }
                Plain::Transition => {
                    let prior = arg(0)?;
                    let patch = if arg(1)?.undefined()? {
                        object(absent)?
                    } else {
                        arg(1)?
                    };
                    let options = default_object(arg(2)?, "now")?;
                    let now = default_now(options.get(c"now")?)?;
                    let pending = options.get(c"pendingWork")?;
                    transition(prior, patch, now, pending)?
                }
            };
            Ok(value.raw())
        })?;
    arity(L::new(env, function.into_unknown(env)?), length)
}

#[derive(Clone, Copy)]
enum Bound {
    Factory,
    Transition,
}

fn bound<'a>(
    env: &'a Env,
    anchor: L<'a>,
    name: &str,
    length: f64,
    op: Bound,
    state: L<'a>,
) -> Result<L<'a>> {
    let capture = Capture::new(anchor)?;
    let retained = Rc::clone(&capture);
    let function =
        env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(name, move |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let arg = |index| -> Result<L<'_>> {
                if index < ctx.length() {
                    Ok(L::new(ctx.env, ctx.get::<Unknown<'_>>(index)?))
                } else {
                    Ok(absent)
                }
            };
            let state = retained.read(absent)?;
            let value = match op {
                Bound::Factory => service(ctx.env, arg(0)?, state.get(c"initial")?)?,
                Bound::Transition => {
                    let now = state.get(c"clock")?.call_plain(&[])?;
                    let pending = state.get(c"pending")?;
                    let pending = if pending.undefined()? {
                        false
                    } else {
                        pending.call_plain(&[arg(0)?])?.truthy()?
                    };
                    let patch = if arg(2)?.undefined()? {
                        object(absent)?
                    } else {
                        arg(2)?
                    };
                    // An injected clock returning undefined triggers Date.now only
                    // after pendingWork, just like the former nested JS call.
                    transition(
                        arg(1)?,
                        patch,
                        default_now(now)?,
                        absent.from_value(&V::Bool(pending))?,
                    )?
                }
            };
            Ok(value.raw())
        })?;
    let function = arity(L::new(env, function.into_unknown(env)?), length)?;
    capture.bind(function, state)?;
    Ok(function)
}

fn service<'a>(env: &'a Env, options: L<'a>, initial: L<'a>) -> Result<L<'a>> {
    let options = default_object(options, "clock")?;
    let mut clock = options.get(c"clock")?;
    if clock.undefined()? {
        clock = options.global()?.get(c"Date")?.get(c"now")?;
    }
    let pending = options.get(c"hasPendingWork")?;
    if clock.kind()? != sys::ValueType::napi_function
        || (!pending.undefined()? && pending.kind()? != sys::ValueType::napi_function)
    {
        return Err(options.type_error("[session] clock and hasPendingWork must be functions"));
    }
    let ports = object(options)?;
    ports.set(c"clock", clock)?;
    ports.set(c"pending", pending)?;
    let value = object(options)?;
    value.set(c"initial", initial)?;
    value.set(
        c"transition",
        bound(env, options, "transition", 3.0, Bound::Transition, ports)?,
    )?;
    value.freeze()
}

fn status_set<'a>(anchor: L<'a>, values: &[&str]) -> Result<L<'a>> {
    let values = anchor.from_value(&V::Array(
        values.iter().map(|value| V::string(value)).collect(),
    ))?;
    anchor.global()?.get(c"Set")?.construct(&[values])
}

/// A caller-owned namespace replaces the old module's binding surface. There
/// is no eager initialization or additional Node facade in shared runtime.
#[napi]
pub fn session_state_api(env: Env) -> Result<sys::napi_value> {
    let anchor = L::new(&env, ().into_unknown(&env)?);
    let value = object(anchor)?;
    value.set(
        c"RUNNING_STATUSES",
        status_set(anchor, &core::RUNNING_STATUSES)?,
    )?;
    value.set(
        c"SESSION_STATUSES",
        status_set(anchor, &core::SESSION_STATUSES)?,
    )?;
    let initial = plain(&env, "initialSessionState", 0.0, Plain::Initial)?;
    let state = object(anchor)?;
    state.set(c"initial", initial)?;
    value.set(
        c"createSessionStateService",
        bound(
            &env,
            anchor,
            "createSessionStateService",
            0.0,
            Bound::Factory,
            state,
        )?,
    )?;
    value.set(c"initialSessionState", initial)?;
    value.set(
        c"isRunningStatus",
        plain(&env, "isRunningStatus", 1.0, Plain::Running)?,
    )?;
    value.set(
        c"transitionSessionState",
        plain(&env, "transitionSessionState", 1.0, Plain::Transition)?,
    )?;
    Ok(value.raw())
}
