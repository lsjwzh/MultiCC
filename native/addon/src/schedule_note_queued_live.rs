//! Entry bookkeeping via a live host draft. The existing queue query, selector,
//! clock and display projection remain explicitly supplied host ports.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, check_status, sys, Env, Result};
use napi_derive::napi;
use std::{
    ffi::{c_void, CString},
    ptr,
};

fn ensure<'a>(draft: L<'a>, session: L<'a>, at: L<'a>) -> Result<L<'a>> {
    if !draft.get(c"sessionSchedules")?.get_key(session)?.truthy()? {
        let null = draft.from_value(&V::Null)?;
        let schedule = draft.from_value(&V::object(Vec::<(&str, V)>::new()))?;
        schedule.set(c"sessionId", session)?;
        schedule.set(c"state", draft.from_value(&V::string("idle"))?)?;
        for key in [
            c"freezeReason",
            c"awaitingRequestId",
            c"classifyState",
            c"classifyStateAt",
            c"priorityEntryId",
            c"active",
            c"lastDecision",
        ] {
            schedule.set(key, null)?;
        }
        schedule.set(c"updatedAt", at)?;
        let collection = draft.get(c"sessionSchedules")?;
        let reflect = draft.global()?.get(c"Reflect")?;
        if !reflect
            .get(c"set")?
            .call(reflect, &[collection, session, schedule, collection])?
            .truthy()?
        {
            return Err(draft.type_error("Cannot assign to read-only property"));
        }
    }
    draft.get(c"sessionSchedules")?.get_key(session)
}
struct FindData {
    holder: sys::napi_ref,
}
unsafe extern "C" fn free_find(env: sys::napi_env, data: *mut c_void, _hint: *mut c_void) {
    if !data.is_null() {
        let data = unsafe { Box::from_raw(data.cast::<FindData>()) };
        unsafe {
            sys::napi_delete_reference(env, data.holder);
        }
    }
}
unsafe extern "C" fn find_candidate(
    env: sys::napi_env,
    info: sys::napi_callback_info,
) -> sys::napi_value {
    let mut argc = 1usize;
    let mut candidate = ptr::null_mut();
    let mut data = ptr::null_mut();
    if unsafe {
        sys::napi_get_cb_info(
            env,
            info,
            &mut argc,
            &mut candidate,
            ptr::null_mut(),
            &mut data,
        )
    } != sys::Status::napi_ok
        || data.is_null()
    {
        return ptr::null_mut();
    }
    if argc == 0 && unsafe { sys::napi_get_undefined(env, &mut candidate) } != sys::Status::napi_ok
    {
        return ptr::null_mut();
    }
    let mut holder = ptr::null_mut();
    if unsafe { sys::napi_get_reference_value(env, (*data.cast::<FindData>()).holder, &mut holder) }
        != sys::Status::napi_ok
    {
        return ptr::null_mut();
    }
    let result = std::panic::catch_unwind(|| -> Result<bool> {
        let candidate = L::from_raw(env, candidate);
        let holder = L::from_raw(env, holder);
        match candidate.kind()? {
            sys::ValueType::napi_null => {
                return Err(candidate.type_error("Cannot read properties of null (reading 'id')"))
            }
            sys::ValueType::napi_undefined => {
                return Err(
                    candidate.type_error("Cannot read properties of undefined (reading 'id')")
                )
            }
            _ => {}
        }
        candidate
            .get(c"id")?
            .equals(holder.get(c"item")?.get(c"id")?)
    });
    match result {
        Ok(Ok(value)) => {
            let mut output = ptr::null_mut();
            if unsafe { sys::napi_get_boolean(env, value, &mut output) } == sys::Status::napi_ok {
                output
            } else {
                ptr::null_mut()
            }
        }
        other => {
            let mut pending = false;
            unsafe {
                sys::napi_is_exception_pending(env, &mut pending);
            }
            if !pending {
                let message = match other {
                    Ok(Err(error)) => error.to_string(),
                    _ => "queue position callback panicked".into(),
                };
                let message = CString::new(message.replace('\0', "\\0")).expect("NUL removed");
                unsafe {
                    sys::napi_throw_error(env, ptr::null(), message.as_ptr());
                }
            }
            ptr::null_mut()
        }
    }
}
fn finder<'a>(env: &Env, item: L<'a>) -> Result<L<'a>> {
    let holder = item.from_value(&V::object(Vec::<(&str, V)>::new()))?;
    holder.set(c"item", item)?;
    let mut reference = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_create_reference(env.raw(), holder.raw(), 1, &mut reference)
    })?;
    let data = Box::into_raw(Box::new(FindData { holder: reference }));
    let mut function = ptr::null_mut();
    let status = unsafe {
        sys::napi_create_function(
            env.raw(),
            ptr::null(),
            0,
            Some(find_candidate),
            data.cast(),
            &mut function,
        )
    };
    if status != sys::Status::napi_ok {
        unsafe { free_find(env.raw(), data.cast(), ptr::null_mut()) };
        check_status!(status)?;
    }
    let status = unsafe {
        sys::napi_add_finalizer(
            env.raw(),
            function,
            data.cast(),
            Some(free_find),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if status != sys::Status::napi_ok {
        unsafe { free_find(env.raw(), data.cast(), ptr::null_mut()) };
        check_status!(status)?;
    }
    Ok(L::from_raw(env.raw(), function))
}
fn primitive(value: L<'_>) -> Result<bool> {
    Ok(!matches!(
        value.kind()?,
        sys::ValueType::napi_object | sys::ValueType::napi_function
    ))
}
fn to_primitive<'a>(value: L<'a>) -> Result<L<'a>> {
    if primitive(value)? {
        return Ok(value);
    }
    let symbol = value.global()?.get(c"Symbol")?.get(c"toPrimitive")?;
    let method = value.get_key(symbol)?;
    if !method.nullish()? {
        let result = method.call(value, &[value.from_value(&V::string("default"))?])?;
        if primitive(result)? {
            return Ok(result);
        }
        return Err(value.type_error("Cannot convert object to primitive value"));
    }
    for name in [c"valueOf", c"toString"] {
        let method = value.get(name)?;
        if method.kind()? == sys::ValueType::napi_function {
            let result = method.call(value, &[])?;
            if primitive(result)? {
                return Ok(result);
            }
        }
    }
    Err(value.type_error("Cannot convert object to primitive value"))
}
pub(crate) fn plus_one<'a>(value: L<'a>) -> Result<L<'a>> {
    let value = to_primitive(value)?;
    match value.kind()? {
        sys::ValueType::napi_string => {
            let mut text = value.string()?.expect("string");
            text.push_str("1");
            value.from_value(&V::String(text))
        }
        sys::ValueType::napi_bigint => {
            Err(value.type_error("Cannot mix BigInt and other types, use explicit conversions"))
        }
        sys::ValueType::napi_symbol => {
            Err(value.type_error("Cannot convert a Symbol value to a number"))
        }
        _ => value.from_value(&V::Number(value.number()? + 1.0)),
    }
}
#[napi]
pub fn schedule_note_queued_live(
    env: Env,
    draft: Unknown<'_>,
    entry_id: Unknown<'_>,
    clock: Unknown<'_>,
    queue_port: Unknown<'_>,
    select_port: Unknown<'_>,
    project: Unknown<'_>,
) -> Result<sys::napi_value> {
    let draft = L::new(&env, draft);
    let entry = L::new(&env, entry_id);
    let clock = L::new(&env, clock);
    let queue_port = L::new(&env, queue_port);
    let select_port = L::new(&env, select_port);
    let project = L::new(&env, project);
    let item = draft.get(c"outbox")?.get_key(entry)?;
    if !item.truthy()? {
        return Ok(draft.from_value(&V::Null)?.raw());
    }
    let at = draft.from_value(&V::Number(clock.call_plain(&[])?.explicit_number()?))?;
    let schedule = ensure(draft, item.get(c"sessionId")?, at)?;
    let queue = queue_port.call_plain(&[item.get(c"sessionId")?])?;
    let selected = select_port.call_plain(&[queue, at])?;
    let json = draft.global()?.get(c"JSON")?;
    let encoded = json.get(c"stringify")?.call(json, &[item])?;
    let cloned = json.get(c"parse")?.call(json, &[encoded])?;
    let index = queue
        .get(c"findIndex")?
        .call(queue, &[finder(&env, item)?])?;
    let position = plus_one(index)?;
    let queued = !selected.optional(c"id")?.equals(item.get(c"id")?)?;
    let state = schedule.get(c"state")?;
    let public = project.call_plain(&[schedule, queue])?;
    let result = draft.from_value(&V::object(Vec::<(&str, V)>::new()))?;
    result.set(c"item", cloned)?;
    result.set(c"position", position)?;
    result.set(c"queued", draft.from_value(&V::Bool(queued))?)?;
    result.set(c"schedulerState", state)?;
    result.set(c"schedule", public)?;
    Ok(result.raw())
}
