//! Semantic-structure scrubbing for one provider event.
//!
//! Was `cloneStructuredValue`, the `collect*` descriptor walkers and
//! `applySemanticRedactions` in src/chat/provider-attempt-runtime.js, plus the
//! object walk of `redactProviderRouteCapability` in src/observability.js.
//! The text rules stay in `multicc_core::{exact_secret, redaction}`; this
//! adapter supplies the live property operations to the shared traversal in
//! `multicc_core::provider_scrub`. It preserves:
//!
//! * `Object.entries` order (own enumerable string keys in engine order), with
//!   getters read once, exactly like the JS;
//! * `WeakMap`/`WeakSet` identity: a shared node is visited once and a cycle
//!   terminates; unchanged sub-trees come back as the caller's own objects;
//! * `Array.isArray` (including a Proxy-wrapped array), arrays vs plain
//!   objects, `__proto__` and other own data properties, string primitives vs
//!   String objects;
//! * plain assignment for value write-back and
//!   `getOwnPropertyDescriptor` + `delete` + `defineProperty` for key renames,
//!   including the `#2`, `#3` collision suffix and the resulting key order;
//! * `outputValue !== item` uses `===`, so a NaN value makes the structure
//!   "changed" even though its text did not change, exactly as in JS.
//!
//! Depth is capped instead of overflowing the native stack; a structure deep
//! enough to matter would already throw `RangeError` in the JS engine.
use crate::{
    exact_secret::{cached_secrets, strings},
    js_live::LiveValue,
};
use multicc_core::{
    js::{JsString, JsValue},
    provider_scrub::{route_redact, scrub_semantic_structure},
};
use napi::{bindgen_prelude::Unknown, check_status, sys, Env, Result, Status};
use napi_derive::napi;
use std::ffi::CString;

/// Turn the shared depth guard into a JavaScript RangeError.
fn too_deep(value: LiveValue<'_>) -> napi::Error {
    let message = CString::new("Maximum call stack size exceeded").expect("static message");
    unsafe {
        sys::napi_throw_range_error(value.env(), std::ptr::null(), message.as_ptr());
    }
    napi::Error::new(Status::PendingException, "Maximum call stack size exceeded")
}

/// `typeof value === 'object'` (functions are not; `null` is handled by
/// [`LiveValue::nullish`] before callers get here).
fn object_like(value: LiveValue<'_>) -> Result<bool> {
    Ok(value.kind()? == sys::ValueType::napi_object)
}

fn is_string(value: LiveValue<'_>) -> Result<bool> {
    Ok(value.kind()? == sys::ValueType::napi_string)
}

/// `Array.isArray(value)`: N-API's check first, then the ECMAScript one, which
/// also sees through a Proxy.
fn is_array(value: LiveValue<'_>) -> Result<bool> {
    let mut plain = false;
    check_status!(unsafe { sys::napi_is_array(value.env(), value.raw(), &mut plain) })?;
    if plain {
        return Ok(true);
    }
    value.is_array()
}

fn array_length(value: LiveValue<'_>) -> Result<u32> {
    let mut length = 0u32;
    check_status!(unsafe { sys::napi_get_array_length(value.env(), value.raw(), &mut length) })?;
    Ok(length)
}

fn live_string<'a>(anchor: LiveValue<'a>, text: &JsString) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::String(text.clone()))
}

fn new_array<'a>(anchor: LiveValue<'a>) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::Array(Vec::new()))
}

fn new_object<'a>(anchor: LiveValue<'a>) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::Object(Vec::new()))
}

/// `object[key]` ([[Get]]), without the extra coercion `get_key` performs.
fn get_property<'a>(object: LiveValue<'a>, name: &JsString) -> Result<LiveValue<'a>> {
    get_property_value(object, live_string(object, name)?)
}

fn get_property_value<'a>(object: LiveValue<'a>, name: LiveValue<'a>) -> Result<LiveValue<'a>> {
    let mut value = std::ptr::null_mut();
    check_status!(unsafe {
        sys::napi_get_property(object.env(), object.raw(), name.raw(), &mut value)
    })?;
    Ok(LiveValue::from_raw(object.env(), value))
}

/// `object[index]` for an array.
fn get_element<'a>(object: LiveValue<'a>, index: u32) -> Result<LiveValue<'a>> {
    let mut value = std::ptr::null_mut();
    check_status!(unsafe { sys::napi_get_element(object.env(), object.raw(), index, &mut value) })?;
    Ok(LiveValue::from_raw(object.env(), value))
}

/// `object[key] = value` ([[Set]], strict-mode assignment semantics).
fn set_property(object: LiveValue<'_>, name: &JsString, value: LiveValue<'_>) -> Result<()> {
    let name = live_string(object, name)?;
    check_status!(unsafe {
        sys::napi_set_property(object.env(), object.raw(), name.raw(), value.raw())
    })?;
    Ok(())
}

fn set_element(object: LiveValue<'_>, index: u32, value: LiveValue<'_>) -> Result<()> {
    check_status!(unsafe {
        sys::napi_set_element(object.env(), object.raw(), index, value.raw())
    })?;
    Ok(())
}

/// `Object.prototype.hasOwnProperty.call(object, key)`.
fn has_own(object: LiveValue<'_>, name: &JsString) -> Result<bool> {
    let name = live_string(object, name)?;
    let mut result = false;
    check_status!(unsafe {
        sys::napi_has_own_property(object.env(), object.raw(), name.raw(), &mut result)
    })?;
    Ok(result)
}

/// `delete object[key]`; a false result is a TypeError in strict mode.
fn delete_property(object: LiveValue<'_>, name: &JsString) -> Result<()> {
    let name = live_string(object, name)?;
    let mut result = false;
    check_status!(unsafe {
        sys::napi_delete_property(object.env(), object.raw(), name.raw(), &mut result)
    })?;
    if !result {
        return Err(object.type_error("Cannot delete property"));
    }
    Ok(())
}

/// `Object.defineProperty(object, key, { value, enumerable: true,
/// configurable: true, writable: true })`.
fn define_value(object: LiveValue<'_>, name: &JsString, value: LiveValue<'_>) -> Result<()> {
    let name = live_string(object, name)?;
    unsafe { crate::js_bridge::define_value(object.env(), object.raw(), name.raw(), value.raw()) }
}

/// `Object.entries(value)`: own enumerable string keys in engine order, each
/// value read with [[Get]].
fn entries<'a>(value: LiveValue<'a>) -> Result<Vec<(JsString, LiveValue<'a>)>> {
    let mut names = std::ptr::null_mut();
    check_status!(unsafe {
        sys::napi_get_all_property_names(
            value.env(),
            value.raw(),
            sys::KeyCollectionMode::own_only,
            sys::KeyFilter::enumerable | sys::KeyFilter::skip_symbols,
            sys::KeyConversion::numbers_to_strings,
            &mut names,
        )
    })?;
    let names = LiveValue::from_raw(value.env(), names);
    let count = array_length(names)?;
    let mut out = Vec::with_capacity(count as usize);
    for index in 0..count {
        let name = get_element(names, index)?;
        let name_text = name.string()?.expect("property name is a string");
        let item = get_property_value(value, name)?;
        out.push((name_text, item));
    }
    Ok(out)
}

impl multicc_core::provider_scrub::ScrubValue for LiveValue<'_> {
    type Error = napi::Error;
    fn nullish(self) -> Result<bool> {
        LiveValue::nullish(self)
    }
    fn string(self) -> Result<Option<JsString>> {
        LiveValue::string(self)
    }
    fn equals(self, other: Self) -> Result<bool> {
        LiveValue::equals(self, other)
    }
    fn too_deep(self) -> Self::Error {
        too_deep(self)
    }
    fn object_like(self) -> Result<bool> {
        object_like(self)
    }
    fn is_string(self) -> Result<bool> {
        is_string(self)
    }
    fn is_array(self) -> Result<bool> {
        is_array(self)
    }
    fn array_length(self) -> Result<u32> {
        array_length(self)
    }
    fn live_string(self, text: &JsString) -> Result<Self> {
        live_string(self, text)
    }
    fn new_array(self) -> Result<Self> {
        new_array(self)
    }
    fn new_object(self) -> Result<Self> {
        new_object(self)
    }
    fn get_property(self, name: &JsString) -> Result<Self> {
        get_property(self, name)
    }
    fn get_element(self, index: u32) -> Result<Self> {
        get_element(self, index)
    }
    fn set_property(self, name: &JsString, value: Self) -> Result<()> {
        set_property(self, name, value)
    }
    fn set_element(self, index: u32, value: Self) -> Result<()> {
        set_element(self, index, value)
    }
    fn has_own(self, name: &JsString) -> Result<bool> {
        has_own(self, name)
    }
    fn delete_property(self, name: &JsString) -> Result<()> {
        delete_property(self, name)
    }
    fn define_value(self, name: &JsString, value: Self) -> Result<()> {
        define_value(self, name, value)
    }
    fn entries(self) -> Result<Vec<(JsString, Self)>> {
        entries(self)
    }
}

/// Redact exact secrets distributed over the model-controlled parts of one
/// provider event and then redact route capabilities anywhere in the result.
/// Returns the caller's own `event` when nothing changed.
#[napi]
pub fn provider_scrub_semantic_structure(
    env: Env,
    event: Unknown<'_>,
    secrets: Unknown<'_>,
) -> Result<sys::napi_value> {
    let secrets = cached_secrets(strings(LiveValue::new(&env, secrets))?);
    let output = scrub_semantic_structure(LiveValue::new(&env, event), &secrets)?;
    Ok(output.raw())
}

/// Original CLI wire JSON, with the same semantic walker as the live object
/// entry point. Host objects must continue using the direct value bridge.
#[napi]
pub fn provider_scrub_semantic_json(
    env: Env,
    text: String,
    secrets: Unknown<'_>,
) -> Result<String> {
    let secrets = cached_secrets(strings(LiveValue::new(&env, secrets))?);
    multicc_core::provider_scrub_json::scrub_json(&text, &secrets).map_err(napi::Error::from_reason)
}

/// `redactProviderRouteCapability(value)` for any value: strings are rewritten
/// by the core rule, objects are walked with the JS identity semantics, and
/// anything else is returned unchanged.
#[napi]
pub fn redaction_route_capability_value(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let output = route_redact(LiveValue::new(&env, value), &mut Vec::new(), 0)?;
    Ok(output.raw())
}
