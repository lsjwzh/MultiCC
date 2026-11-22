//! N-API surface for public session access guards
//! (former `src/session/public-session-access.js`).
#![cfg_attr(test, allow(dead_code))]

use crate::js_live::LiveValue as L;
use multicc_core::{
    js::JsValue as V,
    public_session_access::{self as core, PublicSessionAccessDecision},
};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    check_status, sys, Env, Result,
};
use napi_derive::napi;
use std::{cell::Cell, ptr, rc::Rc};

fn new_object(anchor: L<'_>) -> Result<L<'_>> {
    anchor.from_value(&V::Object(vec![]))
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

// WeakMap ephemeron capture so guard closures never root V8 cycles.
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
            return Err(anchor.type_error("public session access guard state is unavailable"));
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

fn is_internal_slot_live(record: L<'_>) -> Result<bool> {
    if !record.truthy()? {
        return Ok(false);
    }
    record.get(c"taskExecutionSlot")?.is_true()
}

fn create_guard_live<'a>(env: &'a Env, options: L<'a>) -> Result<L<'a>> {
    let options = if options.undefined()? {
        new_object(options)?
    } else if options.kind()? == sys::ValueType::napi_null {
        return Err(options.type_error("Cannot destructure property 'records' of null"));
    } else {
        options
    };
    let records = options.get(c"records")?;
    if !records.truthy()? || records.get(c"get")?.kind()? != sys::ValueType::napi_function {
        return Err(options.type_error(core::ERR_RECORDS_REQUIRED));
    }
    let logger_raw = options.get(c"logger")?;
    let logger = if logger_raw.undefined()? {
        options.from_value(&V::Null)?
    } else {
        logger_raw
    };
    let v1_raw = options.get(c"v1NotFound")?;
    let v1_not_found = if v1_raw.undefined()? {
        options.from_value(&V::Null)?
    } else {
        v1_raw
    };

    let state = new_object(options)?;
    state.set(c"records", records)?;
    state.set(c"logger", logger)?;
    state.set(c"v1NotFound", v1_not_found)?;

    let capture = Capture::new(options)?;
    let retained = Rc::clone(&capture);

    let func = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "publicSessionAccessGuard",
        move |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let arg = |idx| -> Result<L<'_>> {
                if idx < ctx.length() {
                    Ok(L::new(ctx.env, ctx.get::<Unknown<'_>>(idx)?))
                } else {
                    Ok(absent)
                }
            };
            let req = arg(0)?;
            let res = arg(1)?;
            let next = arg(2)?;
            let captured = retained.read(absent)?;
            let records = captured.get(c"records")?;
            let logger = captured.get(c"logger")?;
            let v1_not_found = captured.get(c"v1NotFound")?;

            let id_raw = req.optional(c"params")?.optional(c"id")?;
            let id_str = if id_raw.truthy()? {
                absent.global()?.get(c"String")?.call_plain(&[id_raw])?
            } else {
                absent.from_value(&V::string(""))?
            };
            let record = records.get(c"get")?.call(records, &[id_str])?;
            let internal = is_internal_slot_live(record)?;

            let orig = req.get(c"originalUrl")?;
            let raw_url = if orig.truthy()? {
                orig
            } else {
                let u = req.get(c"url")?;
                if u.truthy()? {
                    u
                } else {
                    absent.from_value(&V::string(""))?
                }
            };
            let url_str = absent
                .global()?
                .get(c"String")?
                .call_plain(&[raw_url])?
                .coerce_string()?
                .to_string_lossy();
            let has_v1 = v1_not_found.kind()? == sys::ValueType::napi_function;

            match core::decide_access(internal, &url_str, has_v1) {
                PublicSessionAccessDecision::Allow => Ok(next.call_plain(&[])?.raw()),
                PublicSessionAccessDecision::DelegateV1NotFound => {
                    if !logger.nullish()? {
                        let warn = logger.get(c"warn")?;
                        if warn.kind()? == sys::ValueType::napi_function {
                            let meta = new_object(absent)?;
                            let method = req.get(c"method")?;
                            let method_val = if method.truthy()? {
                                method
                            } else {
                                absent.from_value(&V::Null)?
                            };
                            meta.set(c"method", method_val)?;
                            warn.call(
                                logger,
                                &[absent.from_value(&V::string(core::DENIED_LOG_EVENT))?, meta],
                            )?;
                        }
                    }
                    Ok(v1_not_found.call_plain(&[req, res])?.raw())
                }
                PublicSessionAccessDecision::Respond404Json => {
                    if !logger.nullish()? {
                        let warn = logger.get(c"warn")?;
                        if warn.kind()? == sys::ValueType::napi_function {
                            let meta = new_object(absent)?;
                            let method = req.get(c"method")?;
                            let method_val = if method.truthy()? {
                                method
                            } else {
                                absent.from_value(&V::Null)?
                            };
                            meta.set(c"method", method_val)?;
                            warn.call(
                                logger,
                                &[absent.from_value(&V::string(core::DENIED_LOG_EVENT))?, meta],
                            )?;
                        }
                    }
                    let status_res = res.get(c"status")?.call(
                        res,
                        &[absent.from_value(&V::Number(f64::from(core::NOT_FOUND_STATUS)))?],
                    )?;
                    let body = new_object(absent)?;
                    body.set(
                        c"error",
                        absent.from_value(&V::string(core::NOT_FOUND_ERROR))?,
                    )?;
                    Ok(status_res.get(c"json")?.call(status_res, &[body])?.raw())
                }
            }
        },
    )?;

    // Express inspects function.length === 3 to identify standard middleware.
    let guard = arity(L::new(env, func.into_unknown(env)?), 3.0)?;
    capture.bind(guard, state)?;
    Ok(guard)
}

fn mount_guard_live<'a>(env: &'a Env, app: L<'a>, options: L<'a>) -> Result<L<'a>> {
    if !app.truthy()? || app.get(c"use")?.kind()? != sys::ValueType::napi_function {
        return Err(app.type_error(core::ERR_APP_REQUIRED));
    }
    let guard = create_guard_live(env, options)?;
    let use_fn = app.get(c"use")?;
    for mount_path in core::PUBLIC_SESSION_MOUNT_PATHS {
        use_fn.call(app, &[app.from_value(&V::string(mount_path))?, guard])?;
    }
    app.from_value(&V::Undefined)
}

#[napi]
pub fn session_is_internal_execution_slot(env: Env, record: Option<Unknown<'_>>) -> Result<bool> {
    let absent = L::new(&env, ().into_unknown(&env)?);
    let record_val = record.map_or(absent, |v| L::new(&env, v));
    is_internal_slot_live(record_val)
}

#[napi]
pub fn session_public_access_api(env: Env) -> Result<sys::napi_value> {
    let anchor = L::new(&env, ().into_unknown(&env)?);
    let api = new_object(anchor)?;

    let is_slot_fn = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "isInternalExecutionSlot",
        |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let record = if ctx.length() > 0 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            let ok = is_internal_slot_live(record)?;
            Ok(absent.from_value(&V::Bool(ok))?.raw())
        },
    )?;
    let create_fn = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "createPublicSessionAccessGuard",
        |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let options = if ctx.length() > 0 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            Ok(create_guard_live(ctx.env, options)?.raw())
        },
    )?;
    let mount_fn = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "mountPublicSessionAccessGuard",
        |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let app = if ctx.length() > 0 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            let options = if ctx.length() > 1 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(1)?)
            } else {
                absent
            };
            Ok(mount_guard_live(ctx.env, app, options)?.raw())
        },
    )?;

    api.set(
        c"isInternalExecutionSlot",
        arity(L::new(&env, is_slot_fn.into_unknown(&env)?), 1.0)?,
    )?;
    api.set(
        c"createPublicSessionAccessGuard",
        arity(L::new(&env, create_fn.into_unknown(&env)?), 0.0)?,
    )?;
    api.set(
        c"mountPublicSessionAccessGuard",
        arity(L::new(&env, mount_fn.into_unknown(&env)?), 2.0)?,
    )?;
    Ok(api.raw())
}
