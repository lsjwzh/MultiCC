//! N-API transport/SDK handles for the voice owners. No executable JS source.
use crate::{host_api::*, host_methods::raw};
use napi::bindgen_prelude::{External, Float32Array, FromNapiRef, Int16Array, ToNapiValue};
use std::{cell::RefCell, ffi::CStr};

pub(super) fn install<T: 'static>(p: L<'_>, value: T) -> Result<()> {
    let value = unsafe { External::to_napi_value(p.env(), External::new(RefCell::new(value)))? };
    p.set(c"state", raw(p, value))
}
pub(super) fn state<T: 'static, R>(p: L<'_>, action: impl FnOnce(&mut T) -> R) -> Result<R> {
    let value = p.get(c"state")?;
    let cell = unsafe { External::<RefCell<T>>::from_napi_ref(p.env(), value.raw())? };
    let result = action(&mut cell.borrow_mut());
    Ok(result)
}
pub(super) fn port<'a>(p: L<'a>, name: &CStr) -> Result<L<'a>> {
    p.get(c"ports")?.get(name)
}
pub(super) fn default<'a>(v: L<'a>, other: L<'a>) -> Result<L<'a>> {
    Ok(if v.truthy()? { v } else { other })
}
pub(super) fn configured<'a>(p: L<'a>, entries: &[(&CStr, &str)]) -> Result<L<'a>> {
    let cfg = fields(p, &[])?;
    let env = port(p, c"env")?;
    for &(key, fallback) in entries {
        cfg.set(key, default(env.get(key)?, text(p, fallback)?)?)?;
    }
    Ok(cfg)
}
pub(super) fn clock(p: L<'_>) -> Result<f64> {
    let now = port(p, c"now")?;
    if callable(now)? {
        now.call_plain(&[])?.number()
    } else {
        call(p.global()?.get(c"Date")?, c"now", &[])?.number()
    }
}
pub(super) fn global_port<'a>(p: L<'a>, key: &CStr) -> Result<L<'a>> {
    with_default(port(p, key)?, p.global()?.get(key)?)
}
pub(super) fn timer<'a>(p: L<'a>, ms: f64, run: Action) -> Result<L<'a>> {
    global_port(p, c"setTimeout")?.call_plain(&[function(p, "voiceTimer", 0, 0, run)?, num(p, ms)?])
}
pub(super) fn cancel<'a>(p: L<'a>, timer: L<'a>) -> Result<L<'a>> {
    global_port(p, c"clearTimeout")?.call_plain(&[timer])
}
pub(super) fn on<'a>(p: L<'a>, socket: L<'a>, event: &str, n: usize, run: Action) -> Result<()> {
    call(
        socket,
        c"on",
        &[text(p, event)?, function(p, "voiceEvent", n, n, run)?],
    )?;
    Ok(())
}
pub(super) fn callback<'a>(p: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(p.get(c"cb")?, name, args)
}
pub(super) fn log(p: L<'_>, label: &str, message: &str) -> Result<()> {
    let logger = default(port(p, c"console")?, p.global()?.get(c"console")?)?;
    call(logger, c"error", &[text(p, label)?, text(p, message)?])?;
    Ok(())
}
pub(super) fn message(p: L<'_>, e: napi::Error) -> Result<String> {
    match p.exception_value()? {
        Some(e) => fold_string(e.optional(c"message")?),
        None => Ok(e.reason),
    }
}
pub(super) fn buffer<'a>(p: L<'a>, bytes: &[u8]) -> Result<L<'a>> {
    let mut value = std::ptr::null_mut();
    napi::check_status!(unsafe {
        sys::napi_create_buffer_copy(
            p.env(),
            bytes.len(),
            bytes.as_ptr().cast(),
            std::ptr::null_mut(),
            &mut value,
        )
    })?;
    Ok(raw(p, value))
}
pub(super) fn bytes(v: L<'_>) -> Result<Vec<u8>> {
    let mut is_buffer = false;
    napi::check_status!(unsafe { sys::napi_is_buffer(v.env(), v.raw(), &mut is_buffer) })?;
    let mut ptr = std::ptr::null_mut();
    let mut len = 0;
    if is_buffer {
        napi::check_status!(unsafe {
            sys::napi_get_buffer_info(v.env(), v.raw(), &mut ptr, &mut len)
        })?;
    } else {
        let mut typed = false;
        napi::check_status!(unsafe { sys::napi_is_typedarray(v.env(), v.raw(), &mut typed) })?;
        if !typed {
            return bytes(call(v.global()?.get(c"Buffer")?, c"from", &[v])?);
        }
        let mut kind = sys::TypedarrayType::uint8_array;
        let mut ab = std::ptr::null_mut();
        let mut offset = 0;
        napi::check_status!(unsafe {
            sys::napi_get_typedarray_info(
                v.env(),
                v.raw(),
                &mut kind,
                &mut len,
                &mut ptr,
                &mut ab,
                &mut offset,
            )
        })?;
        len *= match kind {
            sys::TypedarrayType::int8_array
            | sys::TypedarrayType::uint8_array
            | sys::TypedarrayType::uint8_clamped_array => 1,
            sys::TypedarrayType::int16_array | sys::TypedarrayType::uint16_array => 2,
            sys::TypedarrayType::int32_array
            | sys::TypedarrayType::uint32_array
            | sys::TypedarrayType::float32_array => 4,
            _ => 8,
        };
    }
    Ok(if len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), len) }.to_vec()
    })
}
pub(super) fn f32_array(p: L<'_>, values: Vec<f32>) -> Result<L<'_>> {
    Ok(raw(p, unsafe {
        Float32Array::to_napi_value(p.env(), Float32Array::new(values))
    }?))
}
pub(super) fn i16_array(p: L<'_>, values: Vec<i16>) -> Result<L<'_>> {
    Ok(raw(p, unsafe {
        Int16Array::to_napi_value(p.env(), Int16Array::new(values))
    }?))
}
pub(super) fn parse_json<'a>(p: L<'a>, raw: L<'a>) -> Result<Option<L<'a>>> {
    p.catch(|| json_call(p, c"parse", call(raw, c"toString", &[])?))
}
pub(super) fn send_json<'a>(p: L<'a>, ws: L<'a>, value: L<'a>) -> Result<L<'a>> {
    call(ws, c"send", &[json_call(p, c"stringify", value)?])
}
pub(super) fn open(ws: L<'_>) -> Result<bool> {
    ws.get(c"readyState")?.is_number(1.)
}
pub(super) fn json<'a>(p: L<'a>, value: &serde_json::Value) -> Result<L<'a>> {
    json_call(p, c"parse", text(p, &value.to_string())?)
}
pub(super) fn set_if<'a>(
    cfg: L<'a>,
    updates: L<'a>,
    from: &CStr,
    to: &CStr,
    truthy: bool,
) -> Result<()> {
    let v = updates.get(from)?;
    if if truthy { v.truthy()? } else { !v.undefined()? } {
        cfg.set(to, v)?;
    }
    Ok(())
}
