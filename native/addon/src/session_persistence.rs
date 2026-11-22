//! Session persistence adapter (former `src/session/persistence.js`). The
//! native session-record owner already owns snapshots, atomic saves, the
//! dirty/retry state and the durable writer; this module retires the
//! remaining JavaScript adapter — option validation order, ports assembly,
//! outcome classification and the stable `PersistenceError` surface — while
//! every host port (store seam, timers, failure/state listeners, mutator
//! functions) stays in V8.

use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as J, session_persistence as core};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    check_status, sys, Env, Error, JsValue, Result,
};
use napi_derive::napi;
use std::{cell::RefCell, ffi::CStr, ptr, rc::Rc};

fn obj(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Object(vec![]))
}
fn number(a: L<'_>, value: f64) -> Result<L<'_>> {
    a.from_value(&J::Number(value))
}
fn text<'a>(a: L<'a>, value: &str) -> Result<L<'a>> {
    a.from_value(&J::string(value))
}
fn undefined(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Undefined)
}
fn callable(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_function)
}
fn boolean(a: L<'_>, value: bool) -> Result<L<'_>> {
    a.from_value(&J::Bool(value))
}
/// Template-literal string conversion: identical to `String(value)` except
/// that a Symbol raises the `Cannot convert` TypeError instead of printing.
fn template_string(a: L<'_>, value: L<'_>) -> Result<String> {
    if value.kind()? == sys::ValueType::napi_symbol {
        return Err(a.type_error("Cannot convert a Symbol value to a string"));
    }
    let text = a.global()?.get(c"String")?.call_plain(&[value])?;
    Ok(text.coerce_string()?.to_string_lossy())
}

fn arity(function: L<'_>, length: f64) -> Result<L<'_>> {
    let value = function.from_value(&J::Number(length))?;
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

/// Per-service state. WeakMap ephemerons retain the holder while any exposed
/// callback is reachable without rooting owner/ports cycles after collection.
struct ServiceState {
    env: sys::napi_env,
    holder: sys::napi_ref,
    anchors: sys::napi_ref,
}
impl ServiceState {
    fn deref<'a>(&self, env: &'a Env, reference: sys::napi_ref) -> Result<L<'a>> {
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_reference_value(self.env, reference, &mut value) })?;
        if value.is_null() {
            return Err(Error::from_reason(
                "session persistence state is unavailable",
            ));
        }
        Ok(L::from_raw(env.raw(), value))
    }
    fn holder<'a>(&self, env: &'a Env) -> Result<L<'a>> {
        self.deref(env, self.holder)
    }
    fn owner<'a>(&self, env: &'a Env) -> Result<L<'a>> {
        self.holder(env)?.get(c"owner")
    }
    fn records<'a>(&self, env: &'a Env) -> Result<L<'a>> {
        self.holder(env)?.get(c"records")
    }
    fn anchor(&self, env: &Env, function: L<'_>, holder: L<'_>) -> Result<()> {
        let map = self.deref(env, self.anchors)?;
        map.get(c"set")?.call(map, &[function, holder])?;
        Ok(())
    }
}
impl Drop for ServiceState {
    fn drop(&mut self) {
        unsafe {
            sys::napi_delete_reference(self.env, self.holder);
            sys::napi_delete_reference(self.env, self.anchors);
        }
    }
}
struct TxState {
    service: Rc<ServiceState>,
    holder: sys::napi_ref,
    active: std::cell::Cell<bool>,
}
impl TxState {
    fn token<'a>(&self, env: &'a Env) -> Result<L<'a>> {
        self.service.deref(env, self.holder)?.get(c"token")
    }
    fn source<'a>(&self, env: &'a Env) -> Result<L<'a>> {
        self.service.deref(env, self.holder)?.get(c"source")
    }
}
impl Drop for TxState {
    fn drop(&mut self) {
        unsafe {
            sys::napi_delete_reference(self.service.env, self.holder);
        }
    }
}
fn reference(env: &Env, value: L<'_>, count: u32) -> Result<sys::napi_ref> {
    let mut reference = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_create_reference(env.raw(), value.raw(), count, &mut reference)
    })?;
    Ok(reference)
}

thread_local! {
    static ERROR_CLASS: RefCell<Option<(usize, sys::napi_ref)>> = const { RefCell::new(None) };
}

/// `super(message, cause ? { cause } : undefined)` followed by the legacy
/// constructor's own-property assignments, with the instance relinked onto
/// `PersistenceError.prototype`.
fn build_error_instance<'a>(
    a: L<'a>,
    message: L<'a>,
    source: L<'a>,
    cause: Option<L<'a>>,
    new_target: Option<L<'a>>,
) -> Result<L<'a>> {
    let error_ctor = a.global()?.get(c"Error")?;
    let base = match cause {
        Some(cause) if cause.truthy()? => {
            let options = obj(a)?;
            options.set(c"cause", cause)?;
            error_ctor.construct(&[message, options])?
        }
        _ => error_ctor.construct(&[message, undefined(a)?])?,
    };
    let target = match new_target {
        Some(target) => target,
        None => ensure_error_class(a)?,
    };
    let prototype = target.get(c"prototype")?;
    // OrdinaryCreateFromConstructor falls back to Error.prototype when the
    // supplied newTarget has a primitive prototype.
    let prototype = match prototype.kind()? {
        sys::ValueType::napi_object | sys::ValueType::napi_function => prototype,
        _ => error_ctor.get(c"prototype")?,
    };
    let object = a.global()?.get(c"Object")?;
    object
        .get(c"setPrototypeOf")?
        .call(object, &[base, prototype])?;
    base.set(c"name", text(a, core::ERROR_NAME)?)?;
    base.set(c"code", text(a, core::ERROR_CODE)?)?;
    base.set(c"status", number(a, core::ERROR_STATUS)?)?;
    base.set(c"source", source)?;
    Ok(base)
}

/// The thrown value of every adapter failure: a `PersistenceError` instance
/// with the legacy message and source (`'unknown'` when the throw site passes
/// no options, like the legacy `unexpected()` helper).
fn persistence_error(
    a: L<'_>,
    message: &str,
    source: Option<L<'_>>,
    cause: Option<L<'_>>,
) -> Result<Error> {
    // `{ source = 'unknown' }`: an absent or undefined source selects the default.
    let source = match source {
        Some(source) if !source.undefined()? => source,
        _ => text(a, core::ERROR_SOURCE_DEFAULT)?,
    };
    let instance = build_error_instance(a, text(a, message)?, source, cause, None)?;
    Ok(instance.throw_error())
}

fn unexpected_status_error(a: L<'_>, status: L<'_>) -> Result<Error> {
    persistence_error(
        a,
        &format!(
            "session persistence returned unexpected status {}",
            template_string(a, status)?
        ),
        None,
        None,
    )
}

/// The `PersistenceError` constructor, created once per environment. The
/// callback also serves plain internal calls; real `class` semantics differ
/// only in ways the host never observes (see module docs).
fn ensure_error_class<'a>(a: L<'a>) -> Result<L<'a>> {
    let key = a.env() as usize;
    if let Some(reference) = ERROR_CLASS.with(|slot| {
        slot.borrow()
            .as_ref()
            .and_then(|(stored_key, reference)| (*stored_key == key).then_some(*reference))
    }) {
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_reference_value(a.env(), reference, &mut value) })?;
        return Ok(L::from_raw(a.env(), value));
    }
    let class = create_error_class(a)?;
    let reference = keep_ref(a, class)?;
    ERROR_CLASS.with(|slot| {
        *slot.borrow_mut() = Some((key, reference));
    });
    Ok(class)
}

fn keep_ref(env_holder: L<'_>, value: L<'_>) -> Result<sys::napi_ref> {
    let mut reference = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_create_reference(env_holder.env(), value.raw(), 1, &mut reference)
    })?;
    Ok(reference)
}

fn create_error_class<'a>(a: L<'a>) -> Result<L<'a>> {
    let env_value = a.env();
    let ctor = unsafe {
        let mut function = ptr::null_mut();
        check_status!(sys::napi_create_function(
            env_value,
            c"PersistenceError".as_ptr(),
            core::ERROR_NAME.len() as isize,
            Some(persistence_error_ctor),
            ptr::null_mut(),
            &mut function,
        ))?;
        L::from_raw(env_value, function)
    };
    // `constructor(message, { source = 'unknown', cause } = {})` has length 1.
    let ctor = arity(ctor, 1.0)?;
    let error_ctor = a.global()?.get(c"Error")?;
    let object = a.global()?.get(c"Object")?;
    let set_prototype = object.get(c"setPrototypeOf")?;
    let prototype = ctor.get(c"prototype")?;
    // A class constructor has a non-writable, non-configurable prototype.
    let descriptor = sys::napi_property_descriptor {
        utf8name: c"prototype".as_ptr(),
        value: prototype.raw(),
        attributes: sys::PropertyAttributes::default,
        ..unsafe { std::mem::zeroed() }
    };
    check_status!(unsafe { sys::napi_define_properties(env_value, ctor.raw(), 1, &descriptor) })?;
    // Static and instance inheritance of the legacy `extends Error` clause.
    set_prototype.call(object, &[prototype, error_ctor.get(c"prototype")?])?;
    set_prototype.call(object, &[ctor, error_ctor])?;
    // Class body: `constructor` is a non-enumerable own property of the
    // prototype, writable and configurable.
    let descriptor = obj(a)?;
    descriptor.set(c"value", ctor)?;
    descriptor.set(c"writable", boolean(a, true)?)?;
    descriptor.set(c"enumerable", boolean(a, false)?)?;
    descriptor.set(c"configurable", boolean(a, true)?)?;
    object
        .get(c"defineProperty")?
        .call(object, &[prototype, text(a, "constructor")?, descriptor])?;
    Ok(ctor)
}

/// Raw N-API callback behind the `PersistenceError` constructor: implements
/// the legacy class body (`{ source = 'unknown', cause } = {}` destructuring,
/// `super(message, cause ? { cause } : undefined)`, four own assignments) and
/// returns the relinked instance.
unsafe extern "C" fn persistence_error_ctor(
    env: sys::napi_env,
    info: sys::napi_callback_info,
) -> sys::napi_value {
    let run = || -> Result<sys::napi_value> {
        let mut argc = 2_usize;
        let mut arguments = [ptr::null_mut(); 2];
        check_status!(sys::napi_get_cb_info(
            env,
            info,
            &mut argc,
            arguments.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        ))?;
        let mut new_target = ptr::null_mut();
        check_status!(sys::napi_get_new_target(env, info, &mut new_target))?;
        let mut holder = ptr::null_mut();
        check_status!(sys::napi_get_undefined(env, &mut holder))?;
        let a = L::from_raw(env, holder);
        if new_target.is_null() {
            return Err(
                a.type_error("Class constructor PersistenceError cannot be invoked without 'new'")
            );
        }
        let message = if argc > 0 {
            L::from_raw(env, arguments[0])
        } else {
            undefined(a)?
        };
        let options = if argc > 1 {
            L::from_raw(env, arguments[1])
        } else {
            undefined(a)?
        };
        // `{ source = 'unknown', cause } = {}`: undefined selects the empty
        // object, null raises V8's destructuring message, anything else is
        // read through property access in declaration order.
        let (source, cause) = if options.undefined()? {
            (text(a, core::ERROR_SOURCE_DEFAULT)?, undefined(a)?)
        } else if options.kind()? == sys::ValueType::napi_null {
            // A class constructor parameter pattern reports through the
            // property-read wording, unlike the factory's destructuring.
            return Err(a.type_error("Cannot read properties of null (reading 'source')"));
        } else {
            let source = options.get(c"source")?;
            let source = if source.undefined()? {
                text(a, core::ERROR_SOURCE_DEFAULT)?
            } else {
                source
            };
            let cause = options.get(c"cause")?;
            (source, cause)
        };
        let instance = build_error_instance(
            a,
            message,
            source,
            Some(cause),
            Some(L::from_raw(env, new_target)),
        )?;
        Ok(instance.raw())
    };
    match run() {
        Ok(value) => value,
        Err(_) => ptr::null_mut(),
    }
}

/// The default `() => {}` ports from the factory destructuring; each factory
/// call creates a fresh function like the legacy default expressions did.
fn noop_function<'a>(env: &'a Env, name: &'static CStr) -> Result<L<'a>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        name.to_str().unwrap_or(""),
        move |ctx| {
            let a = L::new(ctx.env, ().into_unknown(ctx.env)?);
            undefined(a).map(|value| value.raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}

/// `() => owner.retryTick()` — the owner's method is read again on every
/// call, exactly like the legacy closure body.
fn retry_tick_method<'a>(env: &'a Env, service: Rc<ServiceState>) -> Result<L<'a>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "retryTick",
        move |ctx| {
            let env: &Env = ctx.env;
            let result = (|| -> Result<L<'_>> {
                let owner = service.owner(env)?;
                owner.get(c"retryTick")?.call(owner, &[])
            })();
            result.map(|value| value.raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}

/// `value => store.save(value)` — the historical store seam receives the
/// detached JSON snapshot; `store.save` is read again on every call.
fn store_save_method<'a>(env: &'a Env, service: Rc<ServiceState>) -> Result<L<'a>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        // `ports.storeSave = value => ...` is a property assignment, so the
        // legacy arrow carries no inferred name.
        "",
        move |ctx| {
            let env: &Env = ctx.env;
            let result = (|| -> Result<L<'_>> {
                let value = if ctx.length() > 0 {
                    L::new(env, ctx.get::<Unknown<'_>>(0)?)
                } else {
                    undefined(L::new(env, ().into_unknown(env)?))?
                };
                let store = service.holder(env)?.get(c"store")?;
                store.get(c"save")?.call(store, &[value])
            })();
            result.map(|value| value.raw())
        },
    )?;
    arity(
        L::from_raw(env.raw(), function.into_unknown(env)?.raw()),
        1.0,
    )
}

fn mutate_method<'a>(env: &'a Env, service: Rc<ServiceState>) -> Result<L<'a>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "mutate",
        move |ctx| {
            let env: &Env = ctx.env;
            let a = L::new(env, ().into_unknown(env)?);
            let result = (|| -> Result<L<'_>> {
                let source = if ctx.length() > 0 {
                    L::new(env, ctx.get::<Unknown<'_>>(0)?)
                } else {
                    undefined(a)?
                };
                let mutator = if ctx.length() > 1 {
                    L::new(env, ctx.get::<Unknown<'_>>(1)?)
                } else {
                    undefined(a)?
                };
                if !callable(mutator)? {
                    return Err(a.type_error("session persistence mutate requires a function"));
                }
                let owner = service.owner(env)?;
                let outcome = owner
                    .get(c"mutate")?
                    .call(owner, &[source, service.records(env)?, mutator])?;
                let status = outcome.get(c"status")?;
                let verdict = match status.string()? {
                    Some(text) => core::classify_mutate(&text.to_string_lossy()),
                    None => core::MutateVerdict::Unexpected,
                };
                match verdict {
                    core::MutateVerdict::Value => outcome.get(c"value"),
                    core::MutateVerdict::Nested => Err(persistence_error(
                        a,
                        "nested session persistence mutation",
                        Some(source),
                        None,
                    )?),
                    core::MutateVerdict::AsyncMutator => {
                        Err(a.type_error("session persistence mutator must be synchronous"))
                    }
                    core::MutateVerdict::SnapshotPassthrough
                    | core::MutateVerdict::MutatorPassthrough => {
                        Err(outcome.get(c"error")?.throw_error())
                    }
                    core::MutateVerdict::Required => Err(persistence_error(
                        a,
                        "session state could not be persisted",
                        Some(source),
                        Some(outcome.get(c"error")?),
                    )?),
                    core::MutateVerdict::Unexpected => Err(unexpected_status_error(a, status)?),
                }
            })();
            result.map(|value| value.raw())
        },
    )?;
    arity(
        L::from_raw(env.raw(), function.into_unknown(env)?.raw()),
        2.0,
    )
}

fn begin_method<'a>(env: &'a Env, service: Rc<ServiceState>) -> Result<L<'a>> {
    let function =
        env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>("begin", move |ctx| {
            let env: &Env = ctx.env;
            let a = L::new(env, ().into_unknown(env)?);
            let result = (|| -> Result<L<'_>> {
                let source = if ctx.length() > 0 {
                    L::new(env, ctx.get::<Unknown<'_>>(0)?)
                } else {
                    undefined(a)?
                };
                let owner = service.owner(env)?;
                let opened = owner.get(c"begin")?.call(owner, &[source])?;
                let status = opened.get(c"status")?;
                let verdict = match status.string()? {
                    Some(text) => core::classify_begin(&text.to_string_lossy()),
                    None => core::BeginVerdict::Unexpected,
                };
                match verdict {
                    core::BeginVerdict::Nested => Err(persistence_error(
                        a,
                        "nested session persistence mutation",
                        Some(source),
                        None,
                    )?),
                    core::BeginVerdict::SnapshotPassthrough => {
                        Err(opened.get(c"error")?.throw_error())
                    }
                    core::BeginVerdict::Unexpected => Err(unexpected_status_error(a, status)?),
                    core::BeginVerdict::Ok => {
                        let token = opened.get(c"token")?;
                        let holder = obj(a)?;
                        holder.set(c"token", token)?;
                        holder.set(c"source", source)?;
                        holder.set(c"service", service.holder(env)?)?;
                        let tx = Rc::new(TxState {
                            service: Rc::clone(&service),
                            holder: reference(env, holder, 0)?,
                            active: std::cell::Cell::new(true),
                        });
                        let out = obj(a)?;
                        let commit = commit_method(env, Rc::clone(&tx))?;
                        let rollback = rollback_method(env, tx)?;
                        service.anchor(env, commit, holder)?;
                        service.anchor(env, rollback, holder)?;
                        out.set(c"commit", commit)?;
                        out.set(c"rollback", rollback)?;
                        out.freeze()?;
                        Ok(out)
                    }
                }
            })();
            result.map(|value| value.raw())
        })?;
    arity(
        L::from_raw(env.raw(), function.into_unknown(env)?.raw()),
        1.0,
    )
}

fn commit_method<'a>(env: &'a Env, tx: Rc<TxState>) -> Result<L<'a>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "commit",
        move |ctx| {
            let env: &Env = ctx.env;
            let a = L::new(env, ().into_unknown(env)?);
            let result = (|| -> Result<L<'_>> {
                let source = tx.source(env)?;
                if !tx.active.get() {
                    return Err(persistence_error(
                        a,
                        "session persistence transaction is closed",
                        Some(source),
                        None,
                    )?);
                }
                tx.active.set(false);
                let owner = tx.service.owner(env)?;
                let outcome = owner
                    .get(c"commit")?
                    .call(owner, &[tx.token(env)?, source])?;
                let status = outcome.get(c"status")?;
                let verdict = match status.string()? {
                    Some(text) => core::classify_commit(&text.to_string_lossy()),
                    None => core::CommitVerdict::Closed,
                };
                match verdict {
                    core::CommitVerdict::Ok => undefined(a),
                    core::CommitVerdict::Required => Err(persistence_error(
                        a,
                        "session state could not be persisted",
                        Some(source),
                        Some(outcome.get(c"error")?),
                    )?),
                    core::CommitVerdict::Closed => Err(persistence_error(
                        a,
                        "session persistence transaction is closed",
                        Some(source),
                        None,
                    )?),
                }
            })();
            result.map(|value| value.raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}

fn rollback_method<'a>(env: &'a Env, tx: Rc<TxState>) -> Result<L<'a>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "rollback",
        move |ctx| {
            let env: &Env = ctx.env;
            let a = L::new(env, ().into_unknown(env)?);
            let result = (|| -> Result<L<'_>> {
                if !tx.active.get() {
                    return undefined(a);
                }
                tx.active.set(false);
                let owner = tx.service.owner(env)?;
                owner.get(c"rollback")?.call(owner, &[tx.token(env)?])?;
                undefined(a)
            })();
            result.map(|value| value.raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}

fn best_effort_method<'a>(env: &'a Env, service: Rc<ServiceState>) -> Result<L<'a>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "bestEffort",
        move |ctx| {
            let env: &Env = ctx.env;
            let a = L::new(env, ().into_unknown(env)?);
            let result = (|| -> Result<L<'_>> {
                // `bestEffort(source = 'runtime')`: the default selects on
                // undefined only, so an explicit null passes through.
                let source = if ctx.length() > 0 {
                    let value = L::new(env, ctx.get::<Unknown<'_>>(0)?);
                    if value.undefined()? {
                        text(a, core::DEFAULT_BEST_EFFORT_SOURCE)?
                    } else {
                        value
                    }
                } else {
                    text(a, core::DEFAULT_BEST_EFFORT_SOURCE)?
                };
                let owner = service.owner(env)?;
                owner.get(c"bestEffort")?.call(owner, &[source])
            })();
            result.map(|value| value.raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}

fn status_method<'a>(env: &'a Env, service: Rc<ServiceState>) -> Result<L<'a>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "status",
        move |ctx| {
            let env: &Env = ctx.env;
            let a = L::new(env, ().into_unknown(env)?);
            let result = (|| -> Result<L<'_>> {
                let owner = service.owner(env)?;
                let snapshot = owner.get(c"status")?.call(owner, &[])?;
                let dirty = snapshot.get(c"dirty")?;
                let retry_attempt = snapshot.get(c"retryAttempt")?;
                let retry_scheduled = snapshot.get(c"retryScheduled")?;
                // `snapshot.lastFailure && { ...snapshot.lastFailure }` reads the
                // property again for the spread, so a getter runs twice.
                let last_failure = snapshot.get(c"lastFailure")?;
                let last_failure = if last_failure.truthy()? {
                    let copy = obj(a)?;
                    copy.spread_from(snapshot.get(c"lastFailure")?)?;
                    copy
                } else {
                    last_failure
                };
                let out = obj(a)?;
                out.set(c"dirty", dirty)?;
                out.set(c"retryAttempt", retry_attempt)?;
                out.set(c"retryScheduled", retry_scheduled)?;
                out.set(c"lastFailure", last_failure)?;
                out.freeze()?;
                Ok(out)
            })();
            result.map(|value| value.raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}

fn stop_method<'a>(env: &'a Env, service: Rc<ServiceState>) -> Result<L<'a>> {
    let function =
        env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>("stop", move |ctx| {
            let env: &Env = ctx.env;
            let a = L::new(env, ().into_unknown(env)?);
            let result = (|| -> Result<L<'_>> {
                let owner = service.owner(env)?;
                owner.get(c"stop")?.call(owner, &[])?;
                undefined(a)
            })();
            result.map(|value| value.raw())
        })?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}

#[napi]
pub fn session_persistence_create(
    env: Env,
    owner_of: Unknown<'_>,
    options: Unknown<'_>,
) -> Result<sys::napi_value> {
    let a = L::new(&env, ().into_unknown(&env)?);
    let owner_of = L::new(&env, owner_of);
    let options = L::new(&env, options);
    // Parameter default `= {}`: undefined selects the empty object; null
    // raises V8's destructuring message naming the first key.
    let options = if options.undefined()? {
        obj(a)?
    } else if options.kind()? == sys::ValueType::napi_null {
        return Err(a.type_error(
            "Cannot destructure property 'records' of '(intermediate value)(intermediate value)(intermediate value)' as it is null.",
        ));
    } else {
        options
    };
    // The destructuring reads every key in declaration order, defaults
    // applied in place, before any validation runs.
    let records = options.get(c"records")?;
    let store = options.get(c"store")?;
    let file = options.get(c"file")?;
    let kind = options.get(c"kind")?;
    let kind = if kind.undefined()? {
        text(a, core::DEFAULT_KIND)?
    } else {
        kind
    };
    let root = options.get(c"root")?;
    let on_failure = options.get(c"onFailure")?;
    let on_failure = if on_failure.undefined()? {
        noop_function(&env, c"onFailure")?
    } else {
        on_failure
    };
    let on_state = options.get(c"onState")?;
    let on_state = if on_state.undefined()? {
        noop_function(&env, c"onState")?
    } else {
        on_state
    };
    let retry_delay_ms = options.get(c"retryDelayMs")?;
    let retry_delay_ms = if retry_delay_ms.undefined()? {
        number(a, core::DEFAULT_RETRY_DELAY_MS)?
    } else {
        retry_delay_ms
    };
    let max_retries = options.get(c"maxRetries")?;
    let max_retries = if max_retries.undefined()? {
        number(a, core::DEFAULT_MAX_RETRIES)?
    } else {
        max_retries
    };
    let set_timeout = options.get(c"setTimeoutFn")?;
    let set_timeout = if set_timeout.undefined()? {
        a.global()?.get(c"setTimeout")?
    } else {
        set_timeout
    };
    let clear_timeout = options.get(c"clearTimeoutFn")?;
    let clear_timeout = if clear_timeout.undefined()? {
        a.global()?.get(c"clearTimeout")?
    } else {
        clear_timeout
    };
    // Validation order and messages are the legacy guard chain.
    let map_ctor = a.global()?.get(c"Map")?;
    if !records.instance_of(map_ctor)? {
        return Err(a.type_error("session persistence requires a records Map"));
    }
    // `sessionRecordsOwner(records)`: the host lookup runs only after the Map
    // check, so a rejected records value never reaches it.
    let owner = owner_of.call(a, &[records])?;
    if !owner.truthy()? {
        return Err(a.type_error("session persistence requires the native session record owner"));
    }
    if !store.undefined()? {
        if !store.truthy()? || !callable(store.get(c"save")?)? {
            return Err(a.type_error("session persistence requires store.save"));
        }
    } else {
        let is_string = file.kind()? == sys::ValueType::napi_string;
        if !is_string || file.get(c"length")?.number()? == 0.0 {
            return Err(a.type_error("session persistence requires a durable file"));
        }
    }
    // Ports object in the legacy literal order; the store seam or the file
    // coordinates are appended afterwards, never both.
    let ports = obj(a)?;
    ports.set(c"stringify", a.global()?.get(c"JSON")?.get(c"stringify")?)?;
    ports.set(c"onFailure", on_failure)?;
    ports.set(c"onState", on_state)?;
    ports.set(c"setTimeout", set_timeout)?;
    ports.set(c"clearTimeout", clear_timeout)?;
    let holder = obj(a)?;
    holder.set(c"owner", owner)?;
    holder.set(c"records", records)?;
    holder.set(c"store", store)?;
    let anchors = a.global()?.get(c"WeakMap")?.construct(&[])?;
    let service = Rc::new(ServiceState {
        env: env.raw(),
        holder: reference(&env, holder, 0)?,
        anchors: reference(&env, anchors, 1)?,
    });
    let retry_tick = retry_tick_method(&env, Rc::clone(&service))?;
    service.anchor(&env, retry_tick, holder)?;
    ports.set(c"retryTick", retry_tick)?;
    ports.set(c"retryDelayMs", retry_delay_ms)?;
    ports.set(c"maxRetries", max_retries)?;
    if !store.undefined()? {
        let save = store_save_method(&env, Rc::clone(&service))?;
        service.anchor(&env, save, holder)?;
        ports.set(c"storeSave", save)?;
    } else {
        ports.set(c"file", file)?;
        ports.set(c"kind", kind)?;
        if root.kind()? == sys::ValueType::napi_string && root.get(c"length")?.number()? > 0.0 {
            ports.set(c"root", root)?;
        }
    }
    owner.get(c"configure")?.call(owner, &[ports])?;
    let out = obj(a)?;
    let begin = begin_method(&env, Rc::clone(&service))?;
    let mutate = mutate_method(&env, Rc::clone(&service))?;
    let best_effort = best_effort_method(&env, Rc::clone(&service))?;
    let status = status_method(&env, Rc::clone(&service))?;
    let stop = stop_method(&env, Rc::clone(&service))?;
    for method in [begin, mutate, best_effort, status, stop] {
        service.anchor(&env, method, holder)?;
    }
    out.set(c"begin", begin)?;
    out.set(c"mutate", mutate)?;
    out.set(c"bestEffort", best_effort)?;
    out.set(c"status", status)?;
    out.set(c"stop", stop)?;
    out.freeze()?;
    Ok(out.raw())
}

#[napi]
pub fn session_persistence_error_class(env: Env) -> Result<sys::napi_value> {
    let a = L::new(&env, ().into_unknown(&env)?);
    Ok(ensure_error_class(a)?.raw())
}

/// Legacy `jsonClone`, including JavaScript JSON hooks and exceptions.
#[napi]
pub fn session_persistence_json_clone(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let value = L::new(&env, value);
    if value.undefined()? {
        return Ok(value.raw());
    }
    let parse_receiver = value.global()?.get(c"JSON")?;
    let parse = parse_receiver.get(c"parse")?;
    let stringify_receiver = value.global()?.get(c"JSON")?;
    let serialized = stringify_receiver
        .get(c"stringify")?
        .call(stringify_receiver, &[value])?;
    Ok(parse.call(parse_receiver, &[serialized])?.raw())
}
