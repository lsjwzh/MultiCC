//! Live V8 bindings for continuation delivery. Rust owns validation, metadata
//! shaping and async result policy; callbacks and mutable Set stay host values.
use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as J, session_delivery as core};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    check_status, sys, Env, Error, JsValue, Result,
};
use napi_derive::napi;
use std::{cell::Cell, ffi::CStr, ptr, rc::Rc};

fn obj(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Object(vec![]))
}
fn text<'a>(a: L<'a>, s: &str) -> Result<L<'a>> {
    a.from_value(&J::string(s))
}
fn undef(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Undefined)
}
fn call<'a>(o: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    o.get(name)?.call(o, args)
}
fn prop<'a>(o: L<'a>, name: &CStr) -> Result<L<'a>> {
    if o.nullish()? {
        let value = if o.undefined()? { "undefined" } else { "null" };
        return Err(o.type_error(&format!(
            "Cannot read properties of {value} (reading '{}')",
            name.to_string_lossy()
        )));
    }
    o.get(name)
}
fn string<'a>(a: L<'a>, v: L<'a>) -> Result<L<'a>> {
    a.global()?.get(c"String")?.call_plain(&[v])
}
fn or_empty<'a>(a: L<'a>, v: L<'a>) -> Result<L<'a>> {
    if v.truthy()? {
        Ok(v)
    } else {
        text(a, "")
    }
}
fn concat<'a>(a: L<'a>, pieces: &[L<'a>]) -> Result<L<'a>> {
    call(text(a, "")?, c"concat", pieces)
}
fn to_string_implicit(v: L<'_>) -> Result<L<'_>> {
    let s = v.coerce_string()?;
    v.from_value(&J::String(s))
}
fn arity(f: L<'_>, n: f64) -> Result<L<'_>> {
    let length = f.from_value(&J::Number(n))?;
    let d = sys::napi_property_descriptor {
        utf8name: c"length".as_ptr(),
        value: length.raw(),
        attributes: sys::PropertyAttributes::configurable,
        ..unsafe { std::mem::zeroed() }
    };
    check_status!(unsafe { sys::napi_define_properties(f.env(), f.raw(), 1, &d) })?;
    Ok(f)
}

struct Capture {
    env: sys::napi_env,
    map: sys::napi_ref,
    key: Cell<sys::napi_ref>,
}
impl Capture {
    fn new(a: L<'_>) -> Result<Rc<Self>> {
        let map = a.global()?.get(c"WeakMap")?.construct(&[])?;
        let mut r = ptr::null_mut();
        check_status!(unsafe { sys::napi_create_reference(a.env(), map.raw(), 1, &mut r) })?;
        Ok(Rc::new(Self {
            env: a.env(),
            map: r,
            key: Cell::new(ptr::null_mut()),
        }))
    }
    fn map<'a>(&self, a: L<'a>) -> Result<L<'a>> {
        let mut v = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_reference_value(self.env, self.map, &mut v) })?;
        Ok(L::from_raw(a.env(), v))
    }
    fn bind(&self, f: L<'_>, v: L<'_>) -> Result<()> {
        let mut r = ptr::null_mut();
        check_status!(unsafe { sys::napi_create_reference(self.env, f.raw(), 0, &mut r) })?;
        self.key.set(r);
        let m = self.map(f)?;
        call(m, c"set", &[f, v])?;
        Ok(())
    }
    fn read<'a>(&self, a: L<'a>) -> Result<L<'a>> {
        let mut key = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_get_reference_value(self.env, self.key.get(), &mut key)
        })?;
        if key.is_null() {
            return Err(a.type_error("session delivery callback state is unavailable"));
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

fn box_value<'a>(value: L<'a>) -> Result<L<'a>> {
    let mut boxed = ptr::null_mut();
    check_status!(unsafe { sys::napi_coerce_to_object(value.env(), value.raw(), &mut boxed) })?;
    Ok(L::from_raw(value.env(), boxed))
}
/// CopyDataProperties with the destructured `kind` and `system` keys excluded.
fn metadata<'a>(value: L<'a>) -> Result<L<'a>> {
    let out = obj(value)?;
    let source = box_value(value)?;
    let reflect = value.global()?.get(c"Reflect")?;
    let keys = call(reflect, c"ownKeys", &[source])?;
    let length = keys.get(c"length")?.number()? as u32;
    let describe = reflect.get(c"getOwnPropertyDescriptor")?;
    let get = reflect.get(c"get")?;
    for index in 0..length {
        let key = keys.element(index)?;
        if key.is_string("kind")? || key.is_string("system")? {
            continue;
        }
        let descriptor = describe.call(reflect, &[source, key])?;
        if descriptor.undefined()? || !descriptor.get(c"enumerable")?.truthy()? {
            continue;
        }
        out.define_key(key, get.call(reflect, &[source, key, source])?)?;
    }
    Ok(out)
}
fn failure(a: L<'_>) -> Result<L<'_>> {
    let out = obj(a)?;
    out.set(c"ok", a.from_value(&J::Bool(false))?)?;
    out.set(c"code", text(a, "delivery_failed")?)?;
    Ok(out)
}
fn emit_log<'a>(context: L<'a>, message: L<'a>) -> Result<()> {
    if !context.get(c"logDefault")?.is_true()? {
        let log = context.get(c"log")?;
        if log.kind()? != sys::ValueType::napi_function {
            return Err(log.type_error("log is not a function"));
        }
        log.call_plain(&[message])?;
    }
    Ok(())
}
fn error_message<'a>(context: L<'a>, error: L<'a>) -> Result<L<'a>> {
    let kind = to_string_implicit(context.get(c"kind")?)?;
    let id = to_string_implicit(context.get(c"id")?)?;
    let detail = to_string_implicit(prop(error, c"message")?)?;
    concat(
        context,
        &[
            text(context, "[session-delivery] ")?,
            kind,
            text(context, " failed for ")?,
            id,
            text(context, ": ")?,
            detail,
        ],
    )
}
fn log_failure<'a>(context: L<'a>, error: L<'a>) -> Result<L<'a>> {
    let message = error_message(context, error)?;
    emit_log(context, message)?;
    failure(context)
}
#[derive(Clone, Copy)]
enum AsyncKind {
    Resolve,
    Reject,
}
fn async_callback<'a>(env: &'a Env, context: L<'a>, kind: AsyncKind) -> Result<L<'a>> {
    let capture = Capture::new(context)?;
    let retained = Rc::clone(&capture);
    let f = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "sessionDeliveryResult",
        move |ctx| {
            let env: &Env = ctx.env;
            let base = L::new(env, ().into_unknown(env)?);
            let context = retained.read(base)?;
            let result = if ctx.length() > 0 {
                L::new(env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                base
            };
            let value = match kind {
                AsyncKind::Resolve => {
                    let result_false = result.is_false()?;
                    let ok_false = if result_false {
                        false
                    } else {
                        result.optional(c"ok")?.is_false()?
                    };
                    if core::should_log_rejection(result_false, ok_false) {
                        let kind = to_string_implicit(context.get(c"kind")?)?;
                        let id = to_string_implicit(context.get(c"id")?)?;
                        let code = result.optional(c"code")?;
                        let code = if code.truthy()? {
                            code
                        } else {
                            text(context, "not_accepted")?
                        };
                        let code = to_string_implicit(code)?;
                        let message = concat(
                            context,
                            &[
                                text(context, "[session-delivery] ")?,
                                kind,
                                text(context, " rejected for ")?,
                                id,
                                text(context, ": ")?,
                                code,
                            ],
                        )?;
                        emit_log(context, message)?;
                    }
                    result
                }
                AsyncKind::Reject => log_failure(context, result)?,
            };
            Ok(value.raw())
        },
    )?;
    let f = L::from_raw(env.raw(), f.into_unknown(env)?.raw());
    capture.bind(f, context)?;
    Ok(f)
}
fn sync_error<'a>(base: L<'a>, error: Error) -> Result<L<'a>> {
    if let Some(exception) = base.exception_value()? {
        Ok(exception)
    } else {
        let e = base
            .global()?
            .get(c"Error")?
            .construct(&[text(base, &error.reason)?])?;
        e.set(c"code", text(base, error.status.as_ref())?)?;
        Ok(e)
    }
}
fn deliver<'a>(
    env: &'a Env,
    holder: L<'a>,
    id: L<'a>,
    message: L<'a>,
    options: L<'a>,
) -> Result<L<'a>> {
    let id = string(holder, or_empty(holder, id)?)?;
    let id = call(id, c"trim", &[])?;
    let message = string(holder, or_empty(holder, message)?)?;
    if !id.truthy()? {
        return Err(holder.type_error("[session-delivery] sessionId is required"));
    }
    if !call(message, c"trim", &[])?.truthy()? {
        return Err(holder.type_error("[session-delivery] text is required"));
    }
    let options = if options.undefined()? {
        obj(holder)?
    } else {
        options
    };
    let selected = prop(options, c"kind")?;
    let kind = if selected.truthy()? {
        selected
    } else {
        text(holder, core::DEFAULT_KIND)?
    };
    let kinds = holder.get(c"kinds")?;
    if !call(kinds, c"has", &[kind])?.truthy()? {
        let kind = to_string_implicit(kind)?;
        let full = concat(
            holder,
            &[text(holder, "[session-delivery] unsupported kind: ")?, kind],
        )?;
        let error = holder.global()?.get(c"TypeError")?.construct(&[full])?;
        return Err(error.throw_error());
    }
    let _discard = prop(options, c"kind")?;
    let system = prop(options, c"system")?;
    let metadata = metadata(options)?;
    let prefixed = if system.truthy()? {
        call(
            message,
            c"startsWith",
            &[text(holder, core::SYSTEM_PREFIX)?],
        )?
        .truthy()?
    } else {
        false
    };
    let message = if core::should_prefix(system.truthy()?, prefixed) {
        concat(holder, &[text(holder, core::SYSTEM_PREFIX)?, message])?
    } else {
        message
    };
    let admission = obj(holder)?;
    admission.spread_from(metadata)?;
    admission.set(c"originContinue", holder.from_value(&J::Bool(true))?)?;
    admission.delete(c"retry")?;
    let context = obj(holder)?;
    context.set(c"id", id)?;
    context.set(c"kind", kind)?;
    context.set(c"log", holder.get(c"log")?)?;
    context.set(c"logDefault", holder.get(c"logDefault")?)?;
    let body = (|| -> Result<L<'a>> {
        let promise = holder.global()?.get(c"Promise")?;
        let resolve = promise.get(c"resolve")?;
        let result = holder
            .get(c"admit")?
            .call_plain(&[id, message, admission])?;
        let pending = resolve.call(promise, &[result])?;
        let fulfilled = async_callback(env, context, AsyncKind::Resolve)?;
        let then = call(pending, c"then", &[fulfilled])?;
        let rejected = async_callback(env, context, AsyncKind::Reject)?;
        call(then, c"catch", &[rejected])
    })();
    match body {
        Ok(value) => Ok(value),
        Err(error) => {
            let e = sync_error(holder, error)?;
            let failed = log_failure(context, e)?;
            let p = holder.global()?.get(c"Promise")?;
            call(p, c"resolve", &[failed])
        }
    }
}

#[derive(Clone, Copy)]
enum Method {
    Deliver,
    Continuation,
    System,
}
fn bind_method<'a>(env: &'a Env, holder: L<'a>, method: Method) -> Result<L<'a>> {
    let capture = Capture::new(holder)?;
    let retained = Rc::clone(&capture);
    let name = match method {
        Method::Deliver => "deliver",
        Method::Continuation => "deliverContinuation",
        Method::System => "deliverSystem",
    };
    let f =
        env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(name, move |ctx| {
            let env: &Env = ctx.env;
            let base = L::new(env, ().into_unknown(env)?);
            let holder = retained.read(base)?;
            let arg = |i| -> Result<L<'_>> {
                if i < ctx.length() {
                    Ok(L::new(env, ctx.get::<Unknown<'_>>(i)?))
                } else {
                    Ok(base)
                }
            };
            let (id, message, options) = (arg(0)?, arg(1)?, arg(2)?);
            let value = match method {
                Method::Deliver => deliver(env, holder, id, message, options)?,
                Method::Continuation | Method::System => {
                    let merged = obj(base)?;
                    merged.spread_from(options)?;
                    merged.set(c"kind", text(base, core::DEFAULT_KIND)?)?;
                    if matches!(method, Method::System) {
                        merged.set(c"system", base.from_value(&J::Bool(true))?)?;
                    }
                    holder
                        .get(c"deliverFn")?
                        .call_plain(&[id, message, merged])?
                }
            };
            Ok(value.raw())
        })?;
    let f = L::from_raw(env.raw(), f.into_unknown(env)?.raw());
    capture.bind(f, holder)?;
    arity(f, 2.0)
}
fn create_delivery<'a>(env: &'a Env, api_holder: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let options = if options.undefined()? {
        obj(api_holder)?
    } else {
        options
    };
    let admit = prop(options, c"admit")?;
    let candidate = prop(options, c"log")?;
    let log_default = candidate.kind()? != sys::ValueType::napi_function;
    let log = if log_default {
        undef(api_holder)?
    } else {
        prop(options, c"log")?
    };
    if admit.kind()? != sys::ValueType::napi_function {
        return Err(api_holder.type_error("[session-delivery] admit port is required"));
    }
    let holder = obj(api_holder)?;
    holder.set(c"admit", admit)?;
    holder.set(c"log", log)?;
    holder.set(c"logDefault", api_holder.from_value(&J::Bool(log_default))?)?;
    holder.set(c"kinds", api_holder.get(c"kinds")?)?;
    let deliver_fn = bind_method(env, holder, Method::Deliver)?;
    holder.set(c"deliverFn", deliver_fn)?;
    let result = obj(api_holder)?;
    result.set(c"deliver", deliver_fn)?;
    result.set(
        c"deliverContinuation",
        bind_method(env, holder, Method::Continuation)?,
    )?;
    result.set(c"deliverSystem", bind_method(env, holder, Method::System)?)?;
    Ok(result)
}
#[napi]
pub fn session_delivery_api(env: Env) -> Result<sys::napi_value> {
    let base = L::new(&env, ().into_unknown(&env)?);
    let api = obj(base)?;
    let holder = obj(base)?;
    let entries = base.from_value(&J::Array(vec![J::string(core::DEFAULT_KIND)]))?;
    let kinds = base.global()?.get(c"Set")?.construct(&[entries])?;
    holder.set(c"kinds", kinds)?;
    let capture = Capture::new(holder)?;
    let retained = Rc::clone(&capture);
    let factory = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "createSessionDelivery",
        move |ctx| {
            let env: &Env = ctx.env;
            let base = L::new(env, ().into_unknown(env)?);
            let holder = retained.read(base)?;
            let options = if ctx.length() > 0 {
                L::new(env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                base
            };
            Ok(create_delivery(env, holder, options)?.raw())
        },
    )?;
    let factory = L::from_raw(env.raw(), factory.into_unknown(&env)?.raw());
    capture.bind(factory, holder)?;
    arity(factory, 0.0)?;
    api.set(c"SYSTEM_PREFIX", text(base, core::SYSTEM_PREFIX)?)?;
    api.set(c"DELIVERY_KINDS", kinds)?;
    api.set(c"createSessionDelivery", factory)?;
    Ok(api.raw())
}
