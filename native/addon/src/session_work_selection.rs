//! Live session-work selection. Property reads stay lazy so draft proxies,
//! getters and classify callbacks preserve their original ordering.
use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as V, unattended};
use napi::{bindgen_prelude::Unknown, Env, Result};
use napi_derive::napi;
use std::cmp::Ordering;
use std::{
    ffi::{c_void, CString},
    ptr,
};

fn kind<'a>(item: L<'a>) -> Result<L<'a>> {
    let transfer = item.optional(c"turnLineage")?.optional(c"workKind")?;
    if transfer.truthy()? {
        return Ok(transfer);
    }
    let payload = item.optional(c"payload")?;
    let typ = payload.optional(c"type")?;
    if typ.is_string("session.work")? {
        let k = payload.get(c"workKind")?;
        return if k.truthy()? {
            Ok(k)
        } else {
            item.from_value(&V::string("task"))
        };
    }
    if typ.is_string("dispatch.request")? {
        let cont = payload.get(c"taskStart")?.is_false()? && payload.get(c"taskId")?.truthy()?;
        return item.from_value(&V::string(if cont { "continuation" } else { "task" }));
    }
    for value in [
        "wait.result",
        "wait.callback",
        "wait.resolved",
        "detached.result",
        "dispatch.result",
        "task.interrupted",
    ] {
        if typ.is_string(value)? {
            return item.from_value(&V::string("callback"));
        }
    }
    item.from_value(&V::string(
        if payload.optional(c"originContinue")?.is_true()? {
            "continuation"
        } else {
            "task"
        },
    ))
}
fn has(value: L<'_>, names: &[&str]) -> Result<bool> {
    for name in names {
        if value.is_string(name)? {
            return Ok(true);
        }
    }
    Ok(false)
}
fn control(item: L<'_>) -> Result<bool> {
    has(
        kind(item)?,
        &[
            "answer",
            "approval",
            "callback",
            "continuation",
            "retry",
            "resume",
        ],
    )
}
fn answer(item: L<'_>) -> Result<bool> {
    let payload = item.optional(c"payload")?;
    if !payload.optional(c"type")?.is_string("session.work")? || !kind(item)?.is_string("answer")? {
        return Ok(false);
    }
    let id = payload.optional(c"requestId")?;
    Ok(id.string()?.is_some_and(|s| !s.is_empty()))
}
pub(crate) fn replay(schedule: L<'_>, item: L<'_>) -> Result<bool> {
    if !schedule.optional(c"active")?.truthy()? || !item.truthy()? {
        return Ok(false);
    }
    let active = schedule.get(c"active")?;
    let delivery = active.get(c"deliveryId")?;
    let id = if delivery.truthy()? {
        delivery
    } else {
        schedule.get(c"active")?.get(c"entryId")?
    };
    Ok(id.truthy()? && item.get(c"id")?.equals(id)?)
}
fn related(schedule: L<'_>, item: L<'_>) -> Result<bool> {
    if !schedule.optional(c"active")?.truthy()? || !control(item)? {
        return Ok(false);
    }
    let p = item.get(c"payload")?;
    let p = if p.truthy()? {
        p
    } else {
        item.from_value(&V::Object(Vec::new()))?
    };
    if p.get(c"type")?.is_string("session.work")? {
        return Ok(true);
    }
    if p.get(c"activeEntryId")?.truthy()?
        && !p
            .get(c"activeEntryId")?
            .equals(schedule.get(c"active")?.get(c"entryId")?)?
    {
        return Ok(false);
    }
    if !p.get(c"type")?.is_string("task.interrupted")?
        && !p.get(c"type")?.is_string("dispatch.result")?
        && p.get(c"taskId")?.truthy()?
        && schedule.get(c"active")?.optional(c"taskId")?.truthy()?
        && !p
            .get(c"taskId")?
            .equals(schedule.get(c"active")?.optional(c"taskId")?)?
    {
        return Ok(false);
    }
    if kind(item)?.is_string("answer")?
        && schedule.get(c"awaitingRequestId")?.truthy()?
        && !p
            .get(c"requestId")?
            .equals(schedule.get(c"awaitingRequestId")?)?
    {
        return Ok(false);
    }
    Ok(true)
}
fn processing(cls: L<'_>) -> Result<bool> {
    Ok(cls.is_string("P")? || cls.is_string("C")?)
}
fn allowed(item: L<'_>, cls: L<'_>) -> Result<bool> {
    let k = kind(item)?;
    if item
        .optional(c"payload")?
        .optional(c"type")?
        .is_string("session.work")?
    {
        return Ok(!processing(cls)?);
    }
    if item
        .optional(c"payload")?
        .optional(c"type")?
        .is_string("dispatch.result")?
    {
        return Ok(!processing(cls)?);
    }
    if cls.is_string("W")? {
        has(k, &["answer", "approval", "continuation"])
    } else if cls.is_string("B")? {
        has(k, &["callback", "continuation"])
    } else if cls.is_string("E")? {
        has(k, &["retry", "resume"])
    } else {
        Ok(false)
    }
}
fn rank(item: L<'_>) -> Result<f64> {
    let order = item.optional(c"queueOrder")?;
    Ok(order
        .number_value()?
        .filter(|n| n.is_finite())
        .unwrap_or(f64::INFINITY))
}
fn compare(a: L<'_>, b: L<'_>, priority: L<'_>) -> Result<Ordering> {
    if a.get(c"id")?.equals(priority)? && !b.get(c"id")?.equals(priority)? {
        return Ok(Ordering::Less);
    }
    if b.get(c"id")?.equals(priority)? && !a.get(c"id")?.equals(priority)? {
        return Ok(Ordering::Greater);
    }
    let ar = rank(a)?;
    let br = rank(b)?;
    if ar != br {
        return Ok(ar.partial_cmp(&br).unwrap_or(Ordering::Equal));
    }
    Ok(
        (a.get(c"sequence")?.number()? - b.get(c"sequence")?.number()?)
            .partial_cmp(&0.0)
            .unwrap_or(Ordering::Equal),
    )
}
struct SortData {
    holder: napi::sys::napi_ref,
}

unsafe extern "C" fn free_sort(env: napi::sys::napi_env, data: *mut c_void, _hint: *mut c_void) {
    if !data.is_null() {
        let data = unsafe { Box::from_raw(data.cast::<SortData>()) };
        unsafe {
            napi::sys::napi_delete_reference(env, data.holder);
        }
    }
}

unsafe extern "C" fn sort_compare(
    env: napi::sys::napi_env,
    info: napi::sys::napi_callback_info,
) -> napi::sys::napi_value {
    let mut argc = 2usize;
    let mut args = [ptr::null_mut(); 2];
    let mut data = ptr::null_mut();
    if unsafe {
        napi::sys::napi_get_cb_info(
            env,
            info,
            &mut argc,
            args.as_mut_ptr(),
            ptr::null_mut(),
            &mut data,
        )
    } != napi::sys::Status::napi_ok
        || data.is_null()
    {
        return ptr::null_mut();
    }
    for arg in args.iter_mut().skip(argc) {
        if unsafe { napi::sys::napi_get_undefined(env, arg) } != napi::sys::Status::napi_ok {
            return ptr::null_mut();
        }
    }
    let mut holder = ptr::null_mut();
    let data = unsafe { &*data.cast::<SortData>() };
    if unsafe { napi::sys::napi_get_reference_value(env, data.holder, &mut holder) }
        != napi::sys::Status::napi_ok
    {
        return ptr::null_mut();
    }
    let run = std::panic::catch_unwind(|| -> Result<Ordering> {
        let holder = L::from_raw(env, holder);
        compare(
            L::from_raw(env, args[0]),
            L::from_raw(env, args[1]),
            holder.get(c"priority")?,
        )
    });
    match run {
        Ok(Ok(order)) => {
            let mut value = ptr::null_mut();
            let number = match order {
                Ordering::Less => -1.0,
                Ordering::Equal => 0.0,
                Ordering::Greater => 1.0,
            };
            if unsafe { napi::sys::napi_create_double(env, number, &mut value) }
                == napi::sys::Status::napi_ok
            {
                value
            } else {
                ptr::null_mut()
            }
        }
        other => {
            let mut pending = false;
            unsafe {
                napi::sys::napi_is_exception_pending(env, &mut pending);
            }
            if !pending {
                let text = match other {
                    Ok(Err(error)) => error.to_string(),
                    _ => "session selection comparator panicked".into(),
                };
                let text = CString::new(text.replace('\0', "\\0")).expect("NUL removed");
                unsafe {
                    napi::sys::napi_throw_error(env, ptr::null(), text.as_ptr());
                }
            }
            ptr::null_mut()
        }
    }
}

fn sort<'a>(items: &mut [L<'a>], priority: L<'a>) -> Result<()> {
    let array = priority.from_value(&V::Array(Vec::new()))?;
    for (index, item) in items.iter().enumerate() {
        array.set_element(index as u32, *item)?;
    }
    let holder = priority.from_value(&V::Object(Vec::new()))?;
    holder.set(c"priority", priority)?;
    let env = priority.env();
    let mut reference = ptr::null_mut();
    napi::check_status!(unsafe {
        napi::sys::napi_create_reference(env, holder.raw(), 1, &mut reference)
    })?;
    let data = Box::into_raw(Box::new(SortData { holder: reference }));
    let mut callback = ptr::null_mut();
    let status = unsafe {
        napi::sys::napi_create_function(
            env,
            ptr::null(),
            0,
            Some(sort_compare),
            data.cast(),
            &mut callback,
        )
    };
    if status != napi::sys::Status::napi_ok {
        unsafe {
            free_sort(env, data.cast(), ptr::null_mut());
        }
        napi::check_status!(status)?;
    }
    let status = unsafe {
        napi::sys::napi_add_finalizer(
            env,
            callback,
            data.cast(),
            Some(free_sort),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if status != napi::sys::Status::napi_ok {
        unsafe {
            free_sort(env, data.cast(), ptr::null_mut());
        }
        napi::check_status!(status)?;
    }
    array
        .get(c"sort")?
        .call(array, &[L::from_raw(env, callback)])?;
    for (index, item) in items.iter_mut().enumerate() {
        *item = array.element(index as u32)?;
    }
    Ok(())
}
fn classify_fallback<'a>(schedule: L<'a>) -> Result<L<'a>> {
    let state = schedule.optional(c"classifyState")?;
    if has(state, &["P", "D", "W", "B", "E"])? {
        return Ok(state);
    }
    let reason = schedule.optional(c"freezeReason")?;
    for (names, letter) in [
        (
            &["awaiting_user_input", "waiting", "classify_waiting"][..],
            "W",
        ),
        (&["awaiting_callback", "classify_background"][..], "B"),
        (
            &[
                "error",
                "classification_error",
                "unknown_interruption",
                "classify_error",
            ][..],
            "E",
        ),
    ] {
        if has(reason, names)? {
            return schedule.from_value(&V::string(letter));
        }
    }
    schedule.from_value(&V::string(if schedule.optional(c"active")?.truthy()? {
        "P"
    } else {
        "D"
    }))
}
fn classify<'a>(request: L<'a>, id: L<'a>) -> Result<L<'a>> {
    request.get(c"classify")?.call_plain(&[id])
}
fn unattended_select<'a>(
    request: L<'a>,
    items: &[L<'a>],
    schedule: L<'a>,
    pending: L<'a>,
    priority: L<'a>,
) -> Result<Option<L<'a>>> {
    let reader = request.get(c"unattended")?;
    if reader.kind()? != napi::sys::ValueType::napi_function {
        return Ok(None);
    }
    let state = reader.call_plain(&[items[0].get(c"sessionId")?])?;
    let has_active = schedule.optional(c"active")?.truthy()?
        && !schedule.optional(c"state")?.is_string("idle")?;
    let cls = classify(request, items[0].get(c"sessionId")?)?;
    let p = pending.optional(c"requestId")?;
    let p = if p.truthy()? {
        p
    } else {
        request.from_value(&V::Null)?
    };
    let mut sorted = items.to_vec();
    sort(&mut sorted, priority)?;
    let list = request.from_value(&V::Array(Vec::new()))?;
    for (i, item) in sorted.iter().enumerate() {
        let row = request.from_value(&V::Object(Vec::new()))?;
        row.set(c"id", item.get(c"id")?)?;
        row.set(c"workKind", kind(*item)?)?;
        row.set(
            c"requestId",
            item.optional(c"payload")?.optional(c"requestId")?,
        )?;
        row.set(
            c"unattendedSystem",
            item.optional(c"payload")?
                .optional(c"options")?
                .optional(c"unattendedSystem")?,
        )?;
        row.set(
            c"unattendedRecovery",
            item.optional(c"payload")?
                .optional(c"options")?
                .optional(c"unattendedRecovery")?,
        )?;
        let source = item
            .optional(c"payload")?
            .optional(c"options")?
            .optional(c"taskSource")?;
        row.set(
            c"taskSource",
            if source.truthy()? {
                source
            } else {
                item.optional(c"payload")?.optional(c"source")?
            },
        )?;
        let message = item.optional(c"payload")?.optional(c"message")?;
        let message = if message.truthy()? {
            message
        } else {
            request.from_value(&V::string(""))?
        };
        let text = request.global()?.get(c"String")?.call_plain(&[message])?;
        let slice = text.get(c"slice")?.call(
            text,
            &[
                request.from_value(&V::Number(0.0))?,
                request.from_value(&V::Number(160.0))?,
            ],
        )?;
        row.set(c"message", slice)?;
        list.set_element(i as u32, row)?;
    }
    let value = request.from_value(&V::Object(Vec::new()))?;
    value.set(c"state", state)?;
    value.set(c"now", request.get(c"now")?)?;
    value.set(c"hasActive", request.from_value(&V::Bool(has_active))?)?;
    value.set(c"classifyState", cls)?;
    value.set(c"pendingRequestId", p)?;
    value.set(c"items", list)?;
    let json = request.global()?.get(c"JSON")?;
    let raw = json
        .get(c"stringify")?
        .call(json, &[value])?
        .coerce_string()?
        .to_string_lossy();
    let result = unattended::select_queued(&raw).map_err(napi::Error::from_reason)?;
    let parsed = request.from_value(
        &multicc_core::js::json_parse(&result)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?,
    )?;
    if !parsed.get(c"handled")?.is_true()? {
        return Ok(None);
    }
    let id = parsed.get(c"entryId")?;
    for item in items {
        if item.get(c"id")?.equals(id)? {
            return Ok(Some(*item));
        }
    }
    Ok(Some(request.from_value(&V::Null)?))
}

#[napi]
pub fn session_work_select(env: Env, input: Unknown<'_>) -> Result<napi::sys::napi_value> {
    let request = L::new(&env, input);
    let list = request.get(c"items")?;
    let len = list.get(c"length")?.number()? as u32;
    if len == 0 {
        return Ok(request.from_value(&V::Null)?.raw());
    }
    let schedule = request.get(c"schedule")?;
    let pending = request.get(c"pending")?;
    let priority = request.get(c"priority")?;
    let items: Vec<_> = (0..len).map(|i| list.element(i)).collect::<Result<_>>()?;
    if let Some(item) = unattended_select(request, &items, schedule, pending, priority)? {
        return Ok(item.raw());
    }
    let mut order = Vec::new();
    for item in &items {
        let keep = if !pending.truthy()?
            || replay(schedule, *item)?
            || (answer(*item)?
                && item
                    .get(c"payload")?
                    .get(c"requestId")?
                    .equals(pending.get(c"requestId")?)?)
            || item
                .get(c"userInputOverrideId")?
                .equals(pending.get(c"requestId")?)?
        {
            true
        } else if item
            .get(c"blockedByUserInput")?
            .equals(pending.get(c"requestId")?)?
            || (schedule.optional(c"active")?.truthy()?
                && has(
                    schedule.get(c"state")?,
                    &["starting", "running", "assessing"],
                )?)
        {
            false
        } else {
            !pending.get(c"createdAt")?.truthy()?
                || item.get(c"createdAt")?.number()? > pending.get(c"createdAt")?.number()?
        };
        if keep {
            order.push(*item);
        }
    }
    sort(&mut order, priority)?;
    if !schedule.truthy()?
        || !schedule.get(c"active")?.truthy()?
        || schedule.get(c"state")?.is_string("idle")?
    {
        let cls = if schedule.truthy()? {
            let cls = classify(request, schedule.get(c"sessionId")?)?;
            if cls.truthy()? {
                cls
            } else {
                classify_fallback(schedule)?
            }
        } else {
            request.from_value(&V::string("D"))?
        };
        if !processing(cls)? {
            for item in &order {
                if item.get(c"directRun")?.truthy()? {
                    return Ok(item.raw());
                }
            }
            for item in &order {
                if control(*item)? && allowed(*item, cls)? {
                    return Ok(item.raw());
                }
            }
        }
        if !cls.is_string("D")? {
            return Ok(request.from_value(&V::Null)?.raw());
        }
        return Ok(order
            .first()
            .copied()
            .unwrap_or(request.from_value(&V::Null)?)
            .raw());
    }
    for item in &order {
        if replay(schedule, *item)? {
            return Ok(item.raw());
        }
    }
    let cls = classify(request, schedule.get(c"sessionId")?)?;
    for item in &order {
        if related(schedule, *item)? && allowed(*item, cls)? {
            return Ok(item.raw());
        }
    }
    Ok(request.from_value(&V::Null)?.raw())
}
