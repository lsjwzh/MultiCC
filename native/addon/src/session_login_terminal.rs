//! Asynchronous login-terminal cleanup. Live host values stay in V8 while
//! Rust owns snapshot traversal and the cascade/kill/delete/save sequence.
use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as J, session_login_terminal as core};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    check_status, sys, Env, Error, JsValue, Result,
};
use napi_derive::napi;
use std::{cell::Cell, ptr, rc::Rc};

fn obj(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Object(vec![]))
}
fn number(a: L<'_>, value: u32) -> Result<L<'_>> {
    a.from_value(&J::Number(f64::from(value)))
}
fn text<'a>(a: L<'a>, value: &str) -> Result<L<'a>> {
    a.from_value(&J::string(value))
}
fn call<'a>(target: L<'a>, key: &std::ffi::CStr, args: &[L<'a>]) -> Result<L<'a>> {
    target.get(key)?.call(target, args)
}
fn callable(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_function)
}

// An ephemeron lets the callback retain its state without making cycles
// through injected ports, records or pending promises into V8 roots.
struct Capture {
    env: sys::napi_env,
    map: sys::napi_ref,
    key: Cell<sys::napi_ref>,
}
impl Capture {
    fn new(a: L<'_>) -> Result<Rc<Self>> {
        let map = a.global()?.get(c"WeakMap")?.construct(&[])?;
        let mut reference = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_reference(a.env(), map.raw(), 1, &mut reference)
        })?;
        Ok(Rc::new(Self {
            env: a.env(),
            map: reference,
            key: Cell::new(ptr::null_mut()),
        }))
    }
    fn map<'a>(&self, a: L<'a>) -> Result<L<'a>> {
        let mut v = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_reference_value(self.env, self.map, &mut v) })?;
        Ok(L::from_raw(a.env(), v))
    }
    fn bind(&self, function: L<'_>, state: L<'_>) -> Result<()> {
        let mut key = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_reference(self.env, function.raw(), 0, &mut key)
        })?;
        self.key.set(key);
        let map = self.map(function)?;
        call(map, c"set", &[function, state])?;
        Ok(())
    }
    fn read<'a>(&self, a: L<'a>) -> Result<L<'a>> {
        let mut key = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_get_reference_value(self.env, self.key.get(), &mut key)
        })?;
        if key.is_null() {
            return Err(a.type_error("login terminal callback state is unavailable"));
        }
        let map = self.map(a)?;
        call(map, c"get", &[L::from_raw(a.env(), key)])
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            if !self.key.get().is_null() {
                sys::napi_delete_reference(self.env, self.key.get());
            }
            sys::napi_delete_reference(self.env, self.map);
        }
    }
}

/// Create intrinsic promises instead of using the mutable global Promise.
fn promise<'a>(a: L<'a>, value: L<'a>, rejected: bool) -> Result<L<'a>> {
    let mut deferred = ptr::null_mut();
    let mut result = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_promise(a.env(), &mut deferred, &mut result) })?;
    if rejected {
        check_status!(unsafe { sys::napi_reject_deferred(a.env(), deferred, value.raw()) })?;
    } else {
        check_status!(unsafe { sys::napi_resolve_deferred(a.env(), deferred, value.raw()) })?;
    }
    Ok(L::from_raw(a.env(), result))
}
fn reject<'a>(a: L<'a>, error: Error) -> Result<L<'a>> {
    let pending = a.exception_value()?;
    let reason = if let Some(v) = pending {
        v
    } else {
        let v = a
            .global()?
            .get(c"Error")?
            .construct(&[text(a, &error.reason)?])?;
        v.set(c"code", text(a, error.status.as_ref())?)?;
        v
    };
    promise(a, reason, true)
}

#[derive(Clone, Copy)]
enum Phase {
    AfterCascade,
    AfterKill,
}
fn continuation<'a>(env: &'a Env, state: L<'a>, phase: Phase) -> Result<L<'a>> {
    let capture = Capture::new(state)?;
    let retained = Rc::clone(&capture);
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "loginCleanupContinuation",
        move |ctx| {
            let env: &Env = ctx.env;
            let base = L::new(env, ().into_unknown(env)?);
            let state = retained.read(base)?;
            let value = match phase {
                Phase::AfterCascade => kill(env, state),
                Phase::AfterKill => after_kill(env, state),
            }?;
            Ok(value.raw())
        },
    )?;
    let function = L::from_raw(env.raw(), function.into_unknown(env)?.raw());
    capture.bind(function, state)?;
    Ok(function)
}
fn resume_after<'a>(env: &'a Env, state: L<'a>, value: L<'a>, phase: Phase) -> Result<L<'a>> {
    let awaited = promise(state, value, false)?;
    let ok = continuation(env, state, phase)?;
    let err = continuation(env, state, phase)?;
    call(awaited, c"then", &[ok, err])
}
fn delete_current(state: L<'_>) -> Result<()> {
    let ports = state.get(c"ports")?;
    let records = ports.get(c"persistedSessions")?;
    let record = state.get(c"record")?;
    call(records, c"delete", &[record.get(c"id")?])?;
    let count = state.get(c"count")?.number()? as u32;
    state.set(c"count", number(state, count + 1)?)?;
    Ok(())
}
fn after_kill<'a>(env: &'a Env, state: L<'a>) -> Result<L<'a>> {
    delete_current(state)?;
    advance(env, state)
}
fn try_kill<'a>(env: &'a Env, state: L<'a>) -> Result<Option<L<'a>>> {
    let ports = state.get(c"ports")?;
    let record = state.get(c"record")?;
    let result = state.catch(|| -> Result<L<'a>> {
        ports
            .get(c"tmuxKillSession")?
            .call_plain(&[record.get(c"id")?])
    })?;
    if let Some(value) = result {
        Ok(Some(resume_after(env, state, value, Phase::AfterKill)?))
    } else {
        delete_current(state)?;
        Ok(None)
    }
}
fn kill<'a>(env: &'a Env, state: L<'a>) -> Result<L<'a>> {
    if let Some(pending) = try_kill(env, state)? {
        Ok(pending)
    } else {
        advance(env, state)
    }
}
fn advance<'a>(env: &'a Env, state: L<'a>) -> Result<L<'a>> {
    let snapshot = state.get(c"snapshot")?;
    let ports = state.get(c"ports")?;
    let length = snapshot.get(c"length")?.number()? as u32;
    let mut index = state.get(c"index")?.number()? as u32;
    while index < length {
        let record = snapshot.element(index)?;
        index += 1;
        state.set(c"index", number(state, index)?)?;
        let present = record.truthy()?;
        let same = if present {
            record.get(c"loginFlow")?.equals(state.get(c"flow")?)?
        } else {
            false
        };
        if !core::should_dispose(present, same) {
            continue;
        }
        state.set(c"record", record)?;
        let cascade = ports.get(c"destroySessionCascade")?;
        if !cascade.nullish()? {
            let result = state.catch(|| -> Result<L<'a>> {
                let dir = obj(state)?;
                dir.set(c"id", record.get(c"dirId")?)?;
                let options = obj(state)?;
                options.set(c"force", state.from_value(&J::Bool(true))?)?;
                cascade.call_plain(&[record, dir, options])
            })?;
            if let Some(value) = result {
                return resume_after(env, state, value, Phase::AfterCascade);
            }
        }
        if let Some(pending) = try_kill(env, state)? {
            return Ok(pending);
        }
    }
    let count = state.get(c"count")?.number()? as u32;
    let save = ports.get(c"saveSessions")?;
    if core::should_save(count, !save.nullish()?) {
        save.call_plain(&[text(state, "runtime.login-terminal-reset")?])?;
    }
    number(state, count)
}
/// Implements array spread over the values iterator. The iterator method and
/// next are each fetched once, and malformed iterables keep V8's spread error.
fn snapshot_values<'a>(anchor: L<'a>, values: L<'a>) -> Result<L<'a>> {
    const NOT_ITERABLE: &str =
        "persistedSessions.values is not a function or its return value is not iterable";
    if values.nullish()? {
        return Err(values.type_error(NOT_ITERABLE));
    }
    let symbol = anchor.global()?.get(c"Symbol")?.get(c"iterator")?;
    let method = values.get_key(symbol)?;
    if !callable(method)? {
        return Err(values.type_error(NOT_ITERABLE));
    }
    let iterator = method.call(values, &[])?;
    if !matches!(
        iterator.kind()?,
        sys::ValueType::napi_object | sys::ValueType::napi_function
    ) {
        return Err(iterator.type_error("Result of the Symbol.iterator method is not an object"));
    }
    let next = iterator.get(c"next")?;
    if !callable(next)? {
        return Err(iterator.type_error(NOT_ITERABLE));
    }
    let snapshot = anchor.from_value(&J::Array(vec![]))?;
    let mut index = 0_u32;
    loop {
        let step = next.call(iterator, &[])?;
        if !matches!(
            step.kind()?,
            sys::ValueType::napi_object | sys::ValueType::napi_function
        ) {
            let display = anchor.global()?.get(c"String")?.call_plain(&[step])?;
            let message = format!(
                "Iterator result {} is not an object",
                display.coerce_string()?.to_string_lossy()
            );
            return Err(step.type_error(&message));
        }
        if step.get(c"done")?.truthy()? {
            break;
        }
        let item = step.get(c"value")?;
        snapshot.define_key(text(anchor, &index.to_string())?, item)?;
        index = index
            .checked_add(1)
            .ok_or_else(|| Error::from_reason("login terminal snapshot too large"))?;
    }
    Ok(snapshot)
}
fn start<'a>(env: &'a Env, ports: L<'a>, flow: L<'a>) -> Result<L<'a>> {
    let flow = if flow.truthy()? {
        flow
    } else {
        text(ports, "")?
    };
    let string = ports.global()?.get(c"String")?.call_plain(&[flow])?;
    let flow = call(string, c"trim", &[])?;
    if !flow.truthy()? {
        return number(ports, 0);
    }
    let records = ports.get(c"persistedSessions")?;
    let values = call(records, c"values", &[])?;
    let snapshot = snapshot_values(ports, values)?;
    let state = obj(ports)?;
    state.set(c"ports", ports)?;
    state.set(c"flow", flow)?;
    state.set(c"snapshot", snapshot)?;
    state.set(c"index", number(ports, 0)?)?;
    state.set(c"count", number(ports, 0)?)?;
    advance(env, state)
}

#[napi]
pub fn session_login_terminal_disposer(env: Env, deps: Unknown<'_>) -> Result<sys::napi_value> {
    let deps = L::new(&env, deps);
    if !deps.truthy()? || deps.kind()? != sys::ValueType::napi_object {
        return Err(deps.type_error("[login-terminal] dependencies are required"));
    }
    let records = deps.get(c"persistedSessions")?;
    let tmux = deps.get(c"tmuxKillSession")?;
    if !records.truthy()?
        || !callable(records.get(c"values")?)?
        || !callable(records.get(c"delete")?)?
    {
        return Err(deps.type_error("[login-terminal] persistedSessions map is required"));
    }
    if !callable(tmux)? {
        return Err(deps.type_error("[login-terminal] tmuxKillSession is required"));
    }
    let cascade = if callable(deps.get(c"destroySessionCascade")?)? {
        deps.get(c"destroySessionCascade")?
    } else {
        deps.from_value(&J::Null)?
    };
    let save = if callable(deps.get(c"saveSessions")?)? {
        deps.get(c"saveSessions")?
    } else {
        deps.from_value(&J::Null)?
    };
    let ports = obj(deps)?;
    ports.set(c"persistedSessions", records)?;
    ports.set(c"tmuxKillSession", tmux)?;
    ports.set(c"destroySessionCascade", cascade)?;
    ports.set(c"saveSessions", save)?;
    let capture = Capture::new(ports)?;
    let retained = Rc::clone(&capture);
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "disposeLoginTerminals",
        move |ctx| {
            let env: &Env = ctx.env;
            let base = L::new(env, ().into_unknown(env)?);
            let input = if ctx.length() > 0 {
                L::new(env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                base
            };
            let result = (|| -> Result<L<'_>> { start(env, retained.read(base)?, input) })();
            match result {
                Ok(value) => Ok(promise(base, value, false)?.raw()),
                Err(error) => Ok(reject(base, error)?.raw()),
            }
        },
    )?;
    let function = L::from_raw(env.raw(), function.into_unknown(&env)?.raw());
    capture.bind(function, ports)?;
    let length = number(function, 1)?;
    let descriptor = sys::napi_property_descriptor {
        utf8name: c"length".as_ptr(),
        value: length.raw(),
        attributes: sys::PropertyAttributes::configurable,
        ..unsafe { std::mem::zeroed() }
    };
    check_status!(unsafe {
        sys::napi_define_properties(env.raw(), function.raw(), 1, &descriptor)
    })?;
    Ok(function.raw())
}
