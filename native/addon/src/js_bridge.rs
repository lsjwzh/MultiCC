//! Lossless napi transport between JavaScript values and [`JsValue`].
//!
//! The JSON transport (`JSON.stringify` -> napi string -> `json_lenient` ->
//! `serde_json::Value`) silently rewrites values at the boundary: a lone
//! surrogate becomes U+FFFD, `NaN`/`Infinity` become `null`, `-0` becomes `0`,
//! `undefined` disappears and a `Buffer` turns into `{type:"Buffer",data}`.
//! This module reads the argument with `napi::sys` directly instead, so every
//! value keeps its identity:
//!
//! * strings travel as UTF-16 code units (`napi_get_value_string_utf16`), lone
//!   surrogates included;
//! * numbers stay `f64` (`NaN`, both infinities and `-0` survive);
//! * `undefined` is distinct from `null`;
//! * `Buffer` and `Uint8Array` become [`JsValue::Bytes`], `Date` becomes
//!   [`JsValue::Date`] (milliseconds);
//! * ordinary objects enumerate own enumerable string keys in engine order via
//!   `napi_get_all_property_names`, exactly the order `Object.keys` returns, and
//!   getters run when the property is read, exactly as `JSON.stringify` does;
//! * a non-`Date` object with a callable `toJSON` is replaced by its result, as
//!   JSON serialization specifies;
//! * `undefined` properties stay present (a missing key and an `undefined`
//!   value are different); functions and symbols are skipped in objects and
//!   become `undefined` in arrays; array holes read as `undefined`;
//! * a `BigInt` throws `TypeError`, and a cycle throws `TypeError` whose message
//!   contains `circular`. Depth is capped to keep the Rust stack bounded.
//!
//! Writing a [`JsValue`] back creates real values: UTF-16 strings with their
//! lone surrogates intact, `NaN`/`-0` numbers, `undefined`, arrays, ordered
//! objects, `Buffer`s and `Date`s.
//!
//! Diagnostic exports let tests compare this transport with JSON:
//! `jsBridgeRoundTrip(value)` returns the value after one read and one write,
//! `jsBridgeJsonView(value)` returns the string `JSON.stringify(value)` would
//! produce, and `jsBridgeJsonRoundTrip(json)` replays the old JSON transport so
//! a benchmark can time both paths on the same payload.
//!
//! # When to pay for this path
//!
//! Fidelity is not free, and it is not where the JSON path loses. On this
//! machine (`scripts/bench-js-bridge.js`, release build, p50 of a full
//! round trip, realistic nested board records over repeated runs):
//!
//! | payload | JSON path | direct |
//! |---------|-----------|--------|
//! | 1.2 KB  | 0.013 ms  | 0.021 ms |
//! | 10.9 KB | 0.11 ms   | 0.17 ms  |
//! | 104 KB  | 1.05 ms   | 1.72 ms  |
//! | 1.06 MB | 11.4 ms   | 17.7 ms  |
//!
//! JSON is roughly 1.5x faster at every size: V8's `JSON.stringify` and
//! `JSON.parse` are heavily optimized, while the direct reader issues several
//! N-API calls per property. So the rule is: use the direct bridge when the
//! semantics require it (lone surrogates, `undefined` versus a missing key,
//! `NaN`/`-0`/infinities, `Buffer`, `Date`, exact key order) or when the
//! payload is small enough that the absolute difference is noise (both paths
//! are under 25 microseconds through 10 KB). Use the JSON path for large
//! payloads that are provably plain JSON and where fidelity is already
//! guaranteed by the producer, and do not move a hot kernel here expecting a
//! speedup.
use multicc_core::js::{json_stringify, JsString, JsValue};
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result, Status};
use napi_derive::napi;
use std::ffi::CString;
use std::ptr;
use std::slice;

const MAX_DEPTH: usize = 1000;

fn status_error(status: sys::napi_status, context: &str) -> napi::Error {
    if status == sys::Status::napi_pending_exception {
        return napi::Error::new(Status::PendingException, "JavaScript exception");
    }
    napi::Error::new(
        Status::GenericFailure,
        format!("{context} failed with napi status {status}"),
    )
}

fn check(status: sys::napi_status, context: &str) -> Result<()> {
    if status == sys::Status::napi_ok {
        Ok(())
    } else {
        Err(status_error(status, context))
    }
}

fn throw_type_error(env: sys::napi_env, message: &str) -> napi::Error {
    let text = CString::new(message).unwrap_or_default();
    unsafe {
        sys::napi_throw_type_error(env, ptr::null(), text.as_ptr());
    }
    napi::Error::new(Status::PendingException, message.to_string())
}

unsafe fn type_of(env: sys::napi_env, value: sys::napi_value) -> Result<sys::napi_valuetype> {
    let mut kind = sys::ValueType::napi_undefined;
    check(
        unsafe { sys::napi_typeof(env, value, &mut kind) },
        "napi_typeof",
    )?;
    Ok(kind)
}

unsafe fn read_string(env: sys::napi_env, value: sys::napi_value) -> Result<JsString> {
    let mut length = 0usize;
    check(
        unsafe { sys::napi_get_value_string_utf16(env, value, ptr::null_mut(), 0, &mut length) },
        "napi_get_value_string_utf16",
    )?;
    let mut units = vec![0u16; length + 1];
    let mut written = 0usize;
    check(
        unsafe {
            sys::napi_get_value_string_utf16(
                env,
                value,
                units.as_mut_ptr(),
                units.len(),
                &mut written,
            )
        },
        "napi_get_value_string_utf16",
    )?;
    units.truncate(written);
    Ok(JsString::from_units(units))
}

/// `true` when `value` is already on the traversal stack.
unsafe fn is_cycle(
    env: sys::napi_env,
    value: sys::napi_value,
    seen: &[sys::napi_value],
) -> Result<bool> {
    for entry in seen {
        let mut equal = false;
        check(
            unsafe { sys::napi_strict_equals(env, *entry, value, &mut equal) },
            "napi_strict_equals",
        )?;
        if equal {
            return Ok(true);
        }
    }
    Ok(false)
}

unsafe fn read_bytes(env: sys::napi_env, value: sys::napi_value) -> Result<Option<Vec<u8>>> {
    let mut is_buffer = false;
    check(
        unsafe { sys::napi_is_buffer(env, value, &mut is_buffer) },
        "napi_is_buffer",
    )?;
    if is_buffer {
        let mut data = ptr::null_mut();
        let mut length = 0usize;
        check(
            unsafe { sys::napi_get_buffer_info(env, value, &mut data, &mut length) },
            "napi_get_buffer_info",
        )?;
        let bytes = if length == 0 {
            Vec::new()
        } else {
            unsafe { slice::from_raw_parts(data.cast::<u8>(), length) }.to_vec()
        };
        return Ok(Some(bytes));
    }
    let mut is_typed_array = false;
    check(
        unsafe { sys::napi_is_typedarray(env, value, &mut is_typed_array) },
        "napi_is_typedarray",
    )?;
    if !is_typed_array {
        return Ok(None);
    }
    let mut kind = sys::TypedarrayType::uint8_array;
    let mut length = 0usize;
    let mut data = ptr::null_mut();
    let mut array_buffer = ptr::null_mut();
    let mut byte_offset = 0usize;
    check(
        unsafe {
            sys::napi_get_typedarray_info(
                env,
                value,
                &mut kind,
                &mut length,
                &mut data,
                &mut array_buffer,
                &mut byte_offset,
            )
        },
        "napi_get_typedarray_info",
    )?;
    if kind != sys::TypedarrayType::uint8_array && kind != sys::TypedarrayType::uint8_clamped_array
    {
        // Other typed arrays serialize as index-keyed objects, like in JSON.
        return Ok(None);
    }
    let bytes = if length == 0 {
        Vec::new()
    } else {
        unsafe { slice::from_raw_parts(data.cast::<u8>(), length) }.to_vec()
    };
    Ok(Some(bytes))
}

/// Read a value without invoking `toJSON` again (the result of a `toJSON` call
/// is converted like any other value, per the JSON serialization rules).
unsafe fn read_plain(
    env: sys::napi_env,
    value: sys::napi_value,
    depth: usize,
    seen: &mut Vec<sys::napi_value>,
) -> Result<JsValue> {
    let kind = unsafe { type_of(env, value) }?;
    match kind {
        sys::ValueType::napi_undefined => Ok(JsValue::Undefined),
        sys::ValueType::napi_null => Ok(JsValue::Null),
        sys::ValueType::napi_boolean => {
            let mut flag = false;
            check(
                unsafe { sys::napi_get_value_bool(env, value, &mut flag) },
                "napi_get_value_bool",
            )?;
            Ok(JsValue::Bool(flag))
        }
        sys::ValueType::napi_number => {
            let mut number = 0.0;
            check(
                unsafe { sys::napi_get_value_double(env, value, &mut number) },
                "napi_get_value_double",
            )?;
            Ok(JsValue::Number(number))
        }
        sys::ValueType::napi_string => Ok(JsValue::String(unsafe { read_string(env, value) }?)),
        sys::ValueType::napi_bigint => Err(throw_type_error(
            env,
            "Do not know how to serialize a BigInt",
        )),
        sys::ValueType::napi_symbol
        | sys::ValueType::napi_function
        | sys::ValueType::napi_external => Ok(JsValue::Undefined),
        _ => {
            if depth > MAX_DEPTH {
                return Err(throw_type_error(env, "Maximum call stack size exceeded"));
            }
            unsafe { read_object(env, value, depth, seen) }
        }
    }
}

unsafe fn read_object(
    env: sys::napi_env,
    value: sys::napi_value,
    depth: usize,
    seen: &mut Vec<sys::napi_value>,
) -> Result<JsValue> {
    if unsafe { is_cycle(env, value, seen) }? {
        return Err(throw_type_error(
            env,
            "Converting circular structure to JSON",
        ));
    }

    let mut is_date = false;
    check(
        unsafe { sys::napi_is_date(env, value, &mut is_date) },
        "napi_is_date",
    )?;
    if is_date {
        let mut milliseconds = 0.0;
        check(
            unsafe { sys::napi_get_date_value(env, value, &mut milliseconds) },
            "napi_get_date_value",
        )?;
        return Ok(JsValue::Date(milliseconds));
    }

    if let Some(bytes) = unsafe { read_bytes(env, value) }? {
        return Ok(JsValue::Bytes(bytes));
    }

    let to_json_key = unsafe { create_string(env, &JsString::from_rust_str("toJSON")) }?;
    let mut to_json = ptr::null_mut();
    check(
        unsafe { sys::napi_get_property(env, value, to_json_key, &mut to_json) },
        "napi_get_property",
    )?;
    if unsafe { type_of(env, to_json) }? == sys::ValueType::napi_function {
        let mut replaced = ptr::null_mut();
        check(
            unsafe { sys::napi_call_function(env, value, to_json, 0, ptr::null(), &mut replaced) },
            "napi_call_function",
        )?;
        return unsafe { read_plain(env, replaced, depth + 1, seen) };
    }

    let mut is_array = false;
    check(
        unsafe { sys::napi_is_array(env, value, &mut is_array) },
        "napi_is_array",
    )?;
    seen.push(value);
    if is_array {
        let mut length = 0u32;
        check(
            unsafe { sys::napi_get_array_length(env, value, &mut length) },
            "napi_get_array_length",
        )?;
        let mut items = Vec::with_capacity(length as usize);
        for index in 0..length {
            let mut element = ptr::null_mut();
            check(
                unsafe { sys::napi_get_element(env, value, index, &mut element) },
                "napi_get_element",
            )?;
            items.push(unsafe { read_plain(env, element, depth + 1, seen) }?);
        }
        seen.pop();
        return Ok(JsValue::Array(items));
    }

    let mut names = ptr::null_mut();
    check(
        unsafe {
            sys::napi_get_all_property_names(
                env,
                value,
                sys::KeyCollectionMode::own_only,
                sys::KeyFilter::enumerable | sys::KeyFilter::skip_symbols,
                sys::KeyConversion::numbers_to_strings,
                &mut names,
            )
        },
        "napi_get_all_property_names",
    )?;
    let mut count = 0u32;
    check(
        unsafe { sys::napi_get_array_length(env, names, &mut count) },
        "napi_get_array_length",
    )?;
    let mut entries = Vec::with_capacity(count as usize);
    for index in 0..count {
        let mut name = ptr::null_mut();
        check(
            unsafe { sys::napi_get_element(env, names, index, &mut name) },
            "napi_get_element",
        )?;
        let key = unsafe { read_string(env, name) }?;
        let mut property = ptr::null_mut();
        check(
            unsafe { sys::napi_get_property(env, value, name, &mut property) },
            "napi_get_property",
        )?;
        let kind = unsafe { type_of(env, property) }?;
        if matches!(
            kind,
            sys::ValueType::napi_function | sys::ValueType::napi_symbol
        ) {
            continue;
        }
        entries.push((key, unsafe { read_plain(env, property, depth + 1, seen) }?));
    }
    seen.pop();
    Ok(JsValue::Object(entries))
}

/// JavaScript value -> [`JsValue`]. `seen` must be empty at the call site.
pub(crate) unsafe fn read_value(
    env: sys::napi_env,
    value: sys::napi_value,
    depth: usize,
    seen: &mut Vec<sys::napi_value>,
) -> Result<JsValue> {
    unsafe { read_plain(env, value, depth, seen) }
}

unsafe fn create_string(env: sys::napi_env, text: &JsString) -> Result<sys::napi_value> {
    let mut result = ptr::null_mut();
    check(
        unsafe {
            sys::napi_create_string_utf16(
                env,
                text.as_units().as_ptr(),
                text.len() as isize,
                &mut result,
            )
        },
        "napi_create_string_utf16",
    )?;
    Ok(result)
}

unsafe fn create_utf8_string(env: sys::napi_env, text: &str) -> Result<sys::napi_value> {
    unsafe { create_string(env, &JsString::from_rust_str(text)) }
}

/// [`JsValue`] -> JavaScript value.
pub(crate) unsafe fn write_value(env: sys::napi_env, value: &JsValue) -> Result<sys::napi_value> {
    match value {
        JsValue::Undefined => {
            let mut result = ptr::null_mut();
            check(
                unsafe { sys::napi_get_undefined(env, &mut result) },
                "napi_get_undefined",
            )?;
            Ok(result)
        }
        JsValue::Null => {
            let mut result = ptr::null_mut();
            check(
                unsafe { sys::napi_get_null(env, &mut result) },
                "napi_get_null",
            )?;
            Ok(result)
        }
        JsValue::Bool(flag) => {
            let mut result = ptr::null_mut();
            check(
                unsafe { sys::napi_get_boolean(env, *flag, &mut result) },
                "napi_get_boolean",
            )?;
            Ok(result)
        }
        JsValue::Number(number) => {
            let mut result = ptr::null_mut();
            check(
                unsafe { sys::napi_create_double(env, *number, &mut result) },
                "napi_create_double",
            )?;
            Ok(result)
        }
        JsValue::String(text) => unsafe { create_string(env, text) },
        JsValue::Bytes(bytes) => {
            let mut result = ptr::null_mut();
            let placeholder = [0u8; 1];
            let data = if bytes.is_empty() {
                placeholder.as_ptr()
            } else {
                bytes.as_ptr()
            };
            check(
                unsafe {
                    sys::napi_create_buffer_copy(
                        env,
                        bytes.len(),
                        data.cast(),
                        ptr::null_mut(),
                        &mut result,
                    )
                },
                "napi_create_buffer_copy",
            )?;
            Ok(result)
        }
        JsValue::Date(milliseconds) => {
            let mut result = ptr::null_mut();
            check(
                unsafe { sys::napi_create_date(env, *milliseconds, &mut result) },
                "napi_create_date",
            )?;
            Ok(result)
        }
        JsValue::Array(items) => {
            let mut result = ptr::null_mut();
            check(
                unsafe { sys::napi_create_array_with_length(env, items.len(), &mut result) },
                "napi_create_array_with_length",
            )?;
            for (index, item) in items.iter().enumerate() {
                let element = unsafe { write_value(env, item) }?;
                let key =
                    unsafe { create_string(env, &JsString::from_rust_str(&index.to_string())) }?;
                unsafe { define_value(env, result, key, element) }?;
            }
            Ok(result)
        }
        JsValue::Object(entries) => {
            let mut result = ptr::null_mut();
            check(
                unsafe { sys::napi_create_object(env, &mut result) },
                "napi_create_object",
            )?;
            for (key, item) in entries {
                let name = unsafe { create_string(env, key) }?;
                let property = unsafe { write_value(env, item) }?;
                unsafe { define_value(env, result, name, property) }?;
            }
            Ok(result)
        }
    }
}

/// CreateDataProperty semantics for objects/arrays crossing from Rust. A plain
/// assignment would invoke inherited setters or treat __proto__ as mutation.
pub(crate) unsafe fn define_value(
    env: sys::napi_env,
    object: sys::napi_value,
    key: sys::napi_value,
    value: sys::napi_value,
) -> Result<()> {
    let descriptor = sys::napi_property_descriptor {
        utf8name: ptr::null(),
        name: key,
        method: None,
        getter: None,
        setter: None,
        value,
        attributes: sys::PropertyAttributes::writable
            | sys::PropertyAttributes::enumerable
            | sys::PropertyAttributes::configurable,
        data: ptr::null_mut(),
    };
    check(
        unsafe { sys::napi_define_properties(env, object, 1, &descriptor) },
        "napi_define_properties",
    )
}

/// One lossless read and write across the boundary.
#[napi]
pub fn js_bridge_round_trip(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let raw = env.raw();
    let parsed = unsafe { read_value(raw, value.raw(), 0, &mut Vec::new()) }?;
    unsafe { write_value(raw, &parsed) }
}

/// `JSON.stringify(value)` computed from the losslessly read value.
#[napi]
pub fn js_bridge_json_view(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let raw = env.raw();
    let parsed = unsafe { read_value(raw, value.raw(), 0, &mut Vec::new()) }?;
    match json_stringify(&parsed) {
        Some(json) => unsafe { create_utf8_string(raw, &json) },
        None => {
            let mut result = ptr::null_mut();
            check(
                unsafe { sys::napi_get_undefined(raw, &mut result) },
                "napi_get_undefined",
            )?;
            Ok(result)
        }
    }
}

/// The old JSON transport: string in, `json_lenient` parse, serde, string out.
/// Exists only so the benchmark times the real legacy path.
#[napi]
pub fn js_bridge_json_round_trip(input: String) -> Result<String> {
    let value: serde_json::Value = multicc_core::json_lenient::from_str(&input)
        .map_err(|error| napi::Error::from_reason(format!("invalid JSON: {error}")))?;
    serde_json::to_string(&value)
        .map_err(|error| napi::Error::from_reason(format!("serialize failed: {error}")))
}
