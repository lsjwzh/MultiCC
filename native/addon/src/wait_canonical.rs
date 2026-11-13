//! Live canonicalization of untrusted orchestration payloads.
use crate::js_live::LiveValue as L;
use multicc_core::js::{JsString, JsValue};
use napi::{bindgen_prelude::Unknown, check_status, sys, Env, Result, Status};
use napi_derive::napi;
use std::{
    ffi::{c_void, CString},
    ptr,
};

fn stringify(value: L<'_>) -> Result<L<'_>> {
    let json = value.global()?.get(c"JSON")?;
    json.get(c"stringify")?.call(json, &[value])
}
fn surrounded(prefix: &str, inner: &JsString, suffix: &str) -> JsString {
    JsString::from_units(
        prefix
            .encode_utf16()
            .chain(inner.as_units().iter().copied())
            .chain(suffix.encode_utf16())
            .collect(),
    )
}
fn join_pair(left: &JsString, right: &JsString) -> JsString {
    JsString::from_units(
        left.as_units()
            .iter()
            .copied()
            .chain([b':' as u16])
            .chain(right.as_units().iter().copied())
            .collect(),
    )
}
struct MapData {
    seen: sys::napi_ref,
    object: Option<sys::napi_ref>,
}
unsafe extern "C" fn free_map(env: sys::napi_env, data: *mut c_void, _hint: *mut c_void) {
    if !data.is_null() {
        let data = unsafe { Box::from_raw(data.cast::<MapData>()) };
        unsafe {
            sys::napi_delete_reference(env, data.seen);
            if let Some(object) = data.object {
                sys::napi_delete_reference(env, object);
            }
        }
    }
}
unsafe extern "C" fn map_item(
    env: sys::napi_env,
    info: sys::napi_callback_info,
) -> sys::napi_value {
    let mut argc = 1;
    let mut item = ptr::null_mut();
    let mut data = ptr::null_mut();
    if unsafe { sys::napi_get_cb_info(env, info, &mut argc, &mut item, ptr::null_mut(), &mut data) }
        != sys::Status::napi_ok
        || data.is_null()
    {
        return ptr::null_mut();
    }
    if argc == 0 && unsafe { sys::napi_get_undefined(env, &mut item) } != sys::Status::napi_ok {
        return ptr::null_mut();
    }
    let mut seen = ptr::null_mut();
    if unsafe { sys::napi_get_reference_value(env, (*data.cast::<MapData>()).seen, &mut seen) }
        != sys::Status::napi_ok
    {
        return ptr::null_mut();
    }
    let result = std::panic::catch_unwind(|| {
        let item = L::from_raw(env, item);
        let seen = L::from_raw(env, seen);
        if let Some(reference) = unsafe { (*data.cast::<MapData>()).object } {
            let mut object = ptr::null_mut();
            check_status!(unsafe { sys::napi_get_reference_value(env, reference, &mut object) })?;
            let object = L::from_raw(env, object);
            let json = item.global()?.get(c"JSON")?;
            let key = json
                .get(c"stringify")?
                .call(json, &[item])?
                .coerce_string()?;
            let child = canonical(object.get_key(item)?, seen)?.coerce_string()?;
            item.from_value(&JsValue::String(join_pair(&key, &child)))
        } else {
            canonical(item, seen)
        }
    });
    match result {
        Ok(Ok(value)) => value.raw(),
        other => {
            let mut pending = false;
            unsafe {
                sys::napi_is_exception_pending(env, &mut pending);
            }
            if !pending {
                let text = match other {
                    Ok(Err(error)) => error.to_string(),
                    _ => "payload canonicalizer panicked".into(),
                };
                let text = CString::new(text.replace('\0', "\\0")).expect("NUL removed");
                unsafe {
                    sys::napi_throw_error(env, ptr::null(), text.as_ptr());
                }
            }
            ptr::null_mut()
        }
    }
}
fn map_callback<'a>(value: L<'a>, seen: L<'a>, object: Option<L<'a>>) -> Result<L<'a>> {
    let env = value.env();
    let mut reference = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_reference(env, seen.raw(), 1, &mut reference) })?;
    let mut object_reference = ptr::null_mut();
    if let Some(object) = object {
        let status =
            unsafe { sys::napi_create_reference(env, object.raw(), 1, &mut object_reference) };
        if status != sys::Status::napi_ok {
            unsafe { sys::napi_delete_reference(env, reference) };
            check_status!(status)?;
        }
    }
    let data = Box::into_raw(Box::new(MapData {
        seen: reference,
        object: object.map(|_| object_reference),
    }));
    let mut callback = ptr::null_mut();
    let status = unsafe {
        sys::napi_create_function(
            env,
            ptr::null(),
            0,
            Some(map_item),
            data.cast(),
            &mut callback,
        )
    };
    if status != sys::Status::napi_ok {
        unsafe { free_map(env, data.cast(), ptr::null_mut()) };
        check_status!(status)?;
    }
    let status = unsafe {
        sys::napi_add_finalizer(
            env,
            callback,
            data.cast(),
            Some(free_map),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if status != sys::Status::napi_ok {
        unsafe { free_map(env, data.cast(), ptr::null_mut()) };
        check_status!(status)?;
    }
    Ok(L::from_raw(env, callback))
}
fn with_seen<'a>(value: L<'a>, seen: L<'a>, f: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if seen.get(c"has")?.call(seen, &[value])?.truthy()? {
        return Err(value.type_error("outbox payload cannot contain cycles"));
    }
    seen.get(c"add")?.call(seen, &[value])?;
    let result = f();
    // Clear a pending exception only while executing the JS finally equivalent,
    // then rethrow the original object so the host observes the same error.
    let exception = if result.is_err() {
        value.exception_value()?
    } else {
        None
    };
    seen.get(c"delete")?.call(seen, &[value])?;
    if let Some(exception) = exception {
        check_status!(unsafe { sys::napi_throw(value.env(), exception.raw()) })?;
        return Err(napi::Error::new(
            Status::PendingException,
            "JavaScript exception",
        ));
    }
    result
}
fn canonical<'a>(value: L<'a>, seen: L<'a>) -> Result<L<'a>> {
    let kind = value.kind()?;
    if kind == sys::ValueType::napi_null {
        return value.from_value(&JsValue::string("null"));
    }
    if matches!(
        kind,
        sys::ValueType::napi_string | sys::ValueType::napi_boolean
    ) {
        return stringify(value);
    }
    if kind == sys::ValueType::napi_number {
        if !value.number()?.is_finite() {
            return Err(value.type_error("outbox payload numbers must be finite"));
        }
        return stringify(value);
    }
    if value.is_array()? {
        return with_seen(value, seen, || {
            let callback = map_callback(value, seen, None)?;
            let mapped = value.get(c"map")?.call(value, &[callback])?;
            let comma = value.from_value(&JsValue::string(","))?;
            let text = mapped
                .get(c"join")?
                .call(mapped, &[comma])?
                .coerce_string()?;
            value.from_value(&JsValue::String(surrounded("[", &text, "]")))
        });
    }
    if kind == sys::ValueType::napi_object {
        let object = value.global()?.get(c"Object")?;
        let proto = object.get(c"getPrototypeOf")?.call(object, &[value])?;
        if !proto.equals(object.get(c"prototype")?)? && !proto.nullish()? {
            return Err(value.type_error("outbox payload contains unsupported object"));
        }
        return with_seen(value, seen, || {
            let keys = object.get(c"keys")?.call(object, &[value])?;
            let sorted = keys.get(c"sort")?.call(keys, &[])?;
            let callback = map_callback(value, seen, Some(value))?;
            let mapped = sorted.get(c"map")?.call(sorted, &[callback])?;
            let comma = value.from_value(&JsValue::string(","))?;
            let text = mapped
                .get(c"join")?
                .call(mapped, &[comma])?
                .coerce_string()?;
            value.from_value(&JsValue::String(surrounded("{", &text, "}")))
        });
    }
    let name = match kind {
        sys::ValueType::napi_undefined => "undefined",
        sys::ValueType::napi_function => "function",
        sys::ValueType::napi_symbol => "symbol",
        sys::ValueType::napi_bigint => "bigint",
        _ => "object",
    };
    Err(value.type_error(&format!("outbox payload contains unsupported {name}")))
}
pub(crate) fn canonical_live(value: L<'_>) -> Result<L<'_>> {
    let constructor = value.global()?.get(c"Set")?;
    let mut seen = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_new_instance(value.env(), constructor.raw(), 0, ptr::null(), &mut seen)
    })?;
    canonical(value, L::from_raw(value.env(), seen))
}
#[napi]
pub fn wait_canonicalize(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let value = L::new(&env, value);
    Ok(canonical_live(value)?.raw())
}
#[napi]
pub fn orchestration_canonicalize(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let value = L::new(&env, value);
    Ok(canonical_live(value)?.raw())
}
