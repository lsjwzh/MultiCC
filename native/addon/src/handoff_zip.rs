//! N-API bridge for the Rust ZIP container (former `src/session/handoff-zip.js`).
// napi registration is absent in Rust test builds; Node exercises this API.
#![cfg_attr(test, allow(dead_code))]

use crate::js_live::LiveValue as L;
use multicc_core::{
    handoff_zip::{
        self as core, ZipInputEntry, ZipOptions, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_TOTAL_BYTES,
    },
    js::JsValue as V,
};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    check_status, sys, Env, Error, Result,
};
use napi_derive::napi;
use std::ptr;

fn is_buffer(value: L<'_>) -> Result<bool> {
    let mut result = false;
    check_status!(unsafe { sys::napi_is_buffer(value.env(), value.raw(), &mut result) })?;
    Ok(result)
}

fn buffer_bytes(value: L<'_>) -> Result<Vec<u8>> {
    let mut data = ptr::null_mut();
    let mut len = 0usize;
    check_status!(unsafe {
        sys::napi_get_buffer_info(value.env(), value.raw(), &mut data, &mut len)
    })?;
    if len == 0 || data.is_null() {
        return Ok(Vec::new());
    }
    let slice = unsafe { std::slice::from_raw_parts(data as *const u8, len) };
    Ok(slice.to_vec())
}

fn create_buffer<'a>(anchor: L<'a>, bytes: &[u8]) -> Result<L<'a>> {
    let mut raw = ptr::null_mut();
    let mut copied = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_create_buffer_copy(
            anchor.env(),
            bytes.len(),
            bytes.as_ptr().cast(),
            &mut copied,
            &mut raw,
        )
    })?;
    Ok(L::from_raw(anchor.env(), raw))
}

fn js_string_utf8(value: L<'_>) -> Result<String> {
    let mut len = 0usize;
    check_status!(unsafe {
        sys::napi_get_value_string_utf8(value.env(), value.raw(), ptr::null_mut(), 0, &mut len)
    })?;
    let mut buf = vec![0u8; len + 1];
    let mut written = 0usize;
    check_status!(unsafe {
        sys::napi_get_value_string_utf8(
            value.env(),
            value.raw(),
            buf.as_mut_ptr().cast(),
            buf.len(),
            &mut written,
        )
    })?;
    buf.truncate(written);
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn parse_limit(value: L<'_>, default_value: usize) -> Result<usize> {
    if !value.truthy()? {
        return Ok(default_value);
    }
    let n = value.number()?;
    if !n.is_finite() || n <= 0.0 {
        return Ok(0);
    }
    if n >= usize::MAX as f64 {
        return Ok(usize::MAX);
    }
    Ok(n as usize)
}

fn parse_options(options: L<'_>, defaults: ZipOptions) -> Result<ZipOptions> {
    if options.undefined()? {
        return Ok(defaults);
    }
    if options.kind()? == sys::ValueType::napi_null {
        return Err(options.type_error("Cannot read properties of null (reading 'maxEntries')"));
    }
    let max_entries_val = options.get(c"maxEntries")?;
    let max_entries = if max_entries_val.undefined()? {
        defaults.max_entries
    } else {
        parse_limit(max_entries_val, DEFAULT_MAX_ENTRIES)?
    };
    let max_total_val = options.get(c"maxTotalBytes")?;
    let max_total_bytes = if max_total_val.undefined()? {
        defaults.max_total_bytes
    } else {
        parse_limit(max_total_val, DEFAULT_MAX_TOTAL_BYTES)?
    };
    Ok(ZipOptions {
        max_entries,
        max_total_bytes,
    })
}

fn parse_optional_mode(value: L<'_>) -> Result<Option<u16>> {
    if value.kind()? != sys::ValueType::napi_number {
        return Ok(None);
    }
    let Some(n) = value.number_value()? else {
        return Ok(None);
    };
    if !n.is_finite() || n.fract() != 0.0 {
        return Ok(None);
    }
    Ok(Some(((n as i64 as u32) & 0xffff) as u16))
}

fn run_create_zip<'a>(
    entries_val: L<'a>,
    options_val: L<'a>,
    defaults: ZipOptions,
) -> Result<L<'a>> {
    if !entries_val.is_array()? {
        return Err(Error::from_reason(
            "createZip requires a non-empty entries array",
        ));
    }
    let mut len = 0u32;
    check_status!(unsafe {
        sys::napi_get_array_length(entries_val.env(), entries_val.raw(), &mut len)
    })?;
    if len == 0 {
        return Err(Error::from_reason(
            "createZip requires a non-empty entries array",
        ));
    }
    let opts = parse_options(options_val, defaults)?;
    if (len as usize) > opts.max_entries {
        return Err(Error::from_reason(format!(
            "too many zip entries ({len} > {})",
            opts.max_entries
        )));
    }

    let mut entries = Vec::with_capacity(len as usize);
    let string_ctor = entries_val.global()?.get(c"String")?;
    for i in 0..len {
        let entry = entries_val.element(i)?;
        if entry.nullish()? {
            return Err(entry.type_error("Cannot read properties of nullish (reading 'name')"));
        }
        let name_val = entry.get(c"name")?;
        if name_val.kind()? != sys::ValueType::napi_string {
            return Err(Error::from_reason(
                "zip entry name must be a non-empty string",
            ));
        }
        let name = js_string_utf8(name_val)?;
        let data_val = entry.get(c"data")?;
        let data = if is_buffer(data_val)? {
            buffer_bytes(data_val)?
        } else {
            let coerced = string_ctor.call_plain(&[data_val])?;
            js_string_utf8(coerced)?.into_bytes()
        };
        let mode = parse_optional_mode(entry.get(c"mode")?)?;
        entries.push(ZipInputEntry { name, data, mode });
    }

    let archive = core::create_zip(&entries, opts).map_err(Error::from_reason)?;
    create_buffer(entries_val, &archive)
}

fn run_read_zip<'a>(buf_val: L<'a>, options_val: L<'a>, defaults: ZipOptions) -> Result<L<'a>> {
    if !is_buffer(buf_val)? {
        return Err(Error::from_reason("not a zip archive (too short)"));
    }
    let bytes = buffer_bytes(buf_val)?;
    if bytes.len() < 22 {
        return Err(Error::from_reason("not a zip archive (too short)"));
    }
    if !core::looks_like_zip(&bytes) {
        return Err(Error::from_reason(
            "not a zip archive (missing local header signature)",
        ));
    }
    let opts = parse_options(options_val, defaults)?;
    let entries = core::read_zip(&bytes, opts).map_err(Error::from_reason)?;

    let mut array_raw = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_create_array_with_length(buf_val.env(), entries.len(), &mut array_raw)
    })?;
    let array = L::from_raw(buf_val.env(), array_raw);
    for (idx, item) in entries.into_iter().enumerate() {
        let obj = buf_val.from_value(&V::Object(vec![]))?;
        obj.set(c"name", buf_val.from_value(&V::string(&item.name))?)?;
        obj.set(c"data", create_buffer(buf_val, &item.data)?)?;
        let mode_val = match item.mode {
            Some(m) => buf_val.from_value(&V::Number(m as f64))?,
            None => buf_val.from_value(&V::Null)?,
        };
        obj.set(c"mode", mode_val)?;
        array.set_element(idx as u32, obj)?;
    }
    Ok(array)
}

fn run_looks_like_zip(buf_val: L<'_>) -> Result<bool> {
    if !is_buffer(buf_val)? {
        return Ok(false);
    }
    let bytes = buffer_bytes(buf_val)?;
    Ok(core::looks_like_zip(&bytes))
}

fn run_crc32(buf_val: L<'_>) -> Result<u32> {
    if is_buffer(buf_val)? {
        let bytes = buffer_bytes(buf_val)?;
        return Ok(core::crc32(&bytes));
    }
    let mut is_typed = false;
    check_status!(unsafe { sys::napi_is_typedarray(buf_val.env(), buf_val.raw(), &mut is_typed) })?;
    if is_typed {
        let mut ta_type = sys::TypedarrayType::uint8_array;
        let mut length = 0usize;
        let mut data = ptr::null_mut();
        let mut arraybuffer = ptr::null_mut();
        let mut byte_offset = 0usize;
        check_status!(unsafe {
            sys::napi_get_typedarray_info(
                buf_val.env(),
                buf_val.raw(),
                &mut ta_type,
                &mut length,
                &mut data,
                &mut arraybuffer,
                &mut byte_offset,
            )
        })?;
        if matches!(
            ta_type,
            sys::TypedarrayType::uint8_array | sys::TypedarrayType::uint8_clamped_array
        ) {
            if length == 0 || data.is_null() {
                return Ok(core::crc32(&[]));
            }
            let slice = unsafe { std::slice::from_raw_parts(data as *const u8, length) };
            return Ok(core::crc32(slice));
        }
    }
    if buf_val.nullish()? {
        return Err(buf_val.type_error("Cannot read properties of nullish (reading 'length')"));
    }
    let len = buf_val.get(c"length")?.number()? as usize;
    let mut bytes = Vec::with_capacity(len);
    for i in 0..len {
        let b = buf_val.element(i as u32)?.number()? as u32 as u8;
        bytes.push(b);
    }
    Ok(core::crc32(&bytes))
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

fn make_create_zip_fn<'a>(env: &'a Env, defaults: ZipOptions) -> Result<L<'a>> {
    let func = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "createZip",
        move |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let entries = if ctx.length() > 0 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            let options = if ctx.length() > 1 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(1)?)
            } else {
                absent
            };
            Ok(run_create_zip(entries, options, defaults)?.raw())
        },
    )?;
    arity(L::new(env, func.into_unknown(env)?), 1.0)
}

fn make_read_zip_fn<'a>(env: &'a Env, defaults: ZipOptions) -> Result<L<'a>> {
    let func = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "readZip",
        move |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let buf = if ctx.length() > 0 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            let options = if ctx.length() > 1 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(1)?)
            } else {
                absent
            };
            Ok(run_read_zip(buf, options, defaults)?.raw())
        },
    )?;
    arity(L::new(env, func.into_unknown(env)?), 1.0)
}

fn make_looks_like_zip_fn<'a>(env: &'a Env) -> Result<L<'a>> {
    let func = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "looksLikeZip",
        move |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let buf = if ctx.length() > 0 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            let ok = run_looks_like_zip(buf)?;
            Ok(absent.from_value(&V::Bool(ok))?.raw())
        },
    )?;
    arity(L::new(env, func.into_unknown(env)?), 1.0)
}

fn make_crc32_fn<'a>(env: &'a Env) -> Result<L<'a>> {
    let func =
        env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>("crc32", move |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let buf = if ctx.length() > 0 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            let sum = run_crc32(buf)?;
            Ok(absent.from_value(&V::Number(sum as f64))?.raw())
        })?;
    arity(L::new(env, func.into_unknown(env)?), 1.0)
}

fn make_service<'a>(env: &'a Env, options_val: L<'a>) -> Result<L<'a>> {
    let defaults = parse_options(options_val, ZipOptions::default())?;
    let service = options_val.from_value(&V::Object(vec![]))?;
    service.set(c"createZip", make_create_zip_fn(env, defaults)?)?;
    service.set(c"readZip", make_read_zip_fn(env, defaults)?)?;
    service.set(c"looksLikeZip", make_looks_like_zip_fn(env)?)?;
    Ok(service)
}

#[napi]
pub fn handoff_zip_create(
    env: Env,
    entries: Unknown<'_>,
    options: Option<Unknown<'_>>,
) -> Result<sys::napi_value> {
    let absent = L::new(&env, ().into_unknown(&env)?);
    let entries_val = L::new(&env, entries);
    let options_val = options.map_or(absent, |opt| L::new(&env, opt));
    Ok(run_create_zip(entries_val, options_val, ZipOptions::default())?.raw())
}

#[napi]
pub fn handoff_zip_read(
    env: Env,
    buf: Unknown<'_>,
    options: Option<Unknown<'_>>,
) -> Result<sys::napi_value> {
    let absent = L::new(&env, ().into_unknown(&env)?);
    let buf_val = L::new(&env, buf);
    let options_val = options.map_or(absent, |opt| L::new(&env, opt));
    Ok(run_read_zip(buf_val, options_val, ZipOptions::default())?.raw())
}

#[napi]
pub fn handoff_zip_looks_like(env: Env, buf: Unknown<'_>) -> Result<bool> {
    run_looks_like_zip(L::new(&env, buf))
}

#[napi]
pub fn handoff_zip_crc32(env: Env, buf: Unknown<'_>) -> Result<u32> {
    run_crc32(L::new(&env, buf))
}

/// Full namespace mirroring the retired `src/session/handoff-zip.js` exports.
#[napi]
pub fn handoff_zip_api(env: Env) -> Result<sys::napi_value> {
    let anchor = L::new(&env, ().into_unknown(&env)?);
    let api = anchor.from_value(&V::Object(vec![]))?;
    api.set(
        c"createZip",
        make_create_zip_fn(&env, ZipOptions::default())?,
    )?;
    api.set(c"readZip", make_read_zip_fn(&env, ZipOptions::default())?)?;
    api.set(c"looksLikeZip", make_looks_like_zip_fn(&env)?)?;
    api.set(c"crc32", make_crc32_fn(&env)?)?;
    let factory = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "createHandoffZipService",
        move |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let options = if ctx.length() > 0 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            Ok(make_service(ctx.env, options)?.raw())
        },
    )?;
    api.set(
        c"createHandoffZipService",
        arity(L::new(&env, factory.into_unknown(&env)?), 0.0)?,
    )?;
    Ok(api.raw())
}
