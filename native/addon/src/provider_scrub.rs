//! Semantic-structure scrubbing for one provider event.
//!
//! Was `cloneStructuredValue`, the `collect*` descriptor walkers and
//! `applySemanticRedactions` in src/chat/provider-attempt-runtime.js, plus the
//! object walk of `redactProviderRouteCapability` in src/observability.js.
//! The text rules stay in `multicc_core::{exact_secret, redaction}`; this
//! module reproduces how the JavaScript walked a live value:
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
    exact_secret::{redact_fragments, Secrets},
    js::{JsString, JsValue},
    redaction,
};
use napi::{bindgen_prelude::Unknown, check_status, sys, Env, Result, Status};
use napi_derive::napi;
use std::ffi::CString;

/// Well under the native stack limit; V8's own recursion limit is of the same
/// order, so anything this deep throws in both implementations.
const MAX_DEPTH: usize = 1000;

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

fn key(text: &str) -> JsString {
    JsString::from_rust_str(text)
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
    check_status!(unsafe { sys::napi_get_property(object.env(), object.raw(), name.raw(), &mut value) })?;
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
    check_status!(unsafe { sys::napi_set_property(object.env(), object.raw(), name.raw(), value.raw()) })?;
    Ok(())
}

fn set_element(object: LiveValue<'_>, index: u32, value: LiveValue<'_>) -> Result<()> {
    check_status!(unsafe { sys::napi_set_element(object.env(), object.raw(), index, value.raw()) })?;
    Ok(())
}

/// `Object.prototype.hasOwnProperty.call(object, key)`.
fn has_own(object: LiveValue<'_>, name: &JsString) -> Result<bool> {
    let name = live_string(object, name)?;
    let mut result = false;
    check_status!(unsafe { sys::napi_has_own_property(object.env(), object.raw(), name.raw(), &mut result) })?;
    Ok(result)
}

/// `delete object[key]`; a false result is a TypeError in strict mode.
fn delete_property(object: LiveValue<'_>, name: &JsString) -> Result<()> {
    let name = live_string(object, name)?;
    let mut result = false;
    check_status!(unsafe { sys::napi_delete_property(object.env(), object.raw(), name.raw(), &mut result) })?;
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

/// `WeakMap.prototype.get` for the identity maps below.
fn lookup<'a>(
    seen: &[(LiveValue<'a>, LiveValue<'a>)],
    value: LiveValue<'a>,
) -> Result<Option<LiveValue<'a>>> {
    for (original, mapped) in seen {
        if original.equals(value)? {
            return Ok(Some(*mapped));
        }
    }
    Ok(None)
}

fn mapping_contains<'a>(seen: &[LiveValue<'a>], value: LiveValue<'a>) -> Result<bool> {
    for entry in seen {
        if entry.equals(value)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `seen.set(value, mapped)`, replacing an existing entry.
fn set_mapping<'a>(
    seen: &mut Vec<(LiveValue<'a>, LiveValue<'a>)>,
    value: LiveValue<'a>,
    mapped: LiveValue<'a>,
) -> Result<()> {
    for entry in seen.iter_mut() {
        if entry.0.equals(value)? {
            entry.1 = mapped;
            return Ok(());
        }
    }
    seen.push((value, mapped));
    Ok(())
}

/// `cloneStructuredValue(value)`: always a fresh structure, shared nodes and
/// cycles preserved through `seen`.
fn clone_structured<'a>(
    value: LiveValue<'a>,
    seen: &mut Vec<(LiveValue<'a>, LiveValue<'a>)>,
    depth: usize,
) -> Result<LiveValue<'a>> {
    if value.nullish()? || !object_like(value)? {
        return Ok(value);
    }
    if let Some(mapped) = lookup(seen, value)? {
        return Ok(mapped);
    }
    if depth > MAX_DEPTH {
        return Err(too_deep(value));
    }
    let output = if is_array(value)? {
        new_array(value)?
    } else {
        new_object(value)?
    };
    seen.push((value, output));
    for (name, item) in entries(value)? {
        let cloned = clone_structured(item, seen, depth + 1)?;
        define_value(output, &name, cloned)?;
    }
    Ok(output)
}

/// `redactProviderRouteCapability(value)`: a fresh structure only when a key,
/// a string value or a collision actually changes; otherwise the caller's own
/// value (unchanged sub-trees included).
fn route_redact<'a>(
    value: LiveValue<'a>,
    seen: &mut Vec<(LiveValue<'a>, LiveValue<'a>)>,
    depth: usize,
) -> Result<LiveValue<'a>> {
    if is_string(value)? {
        let text = value.string()?.expect("string value");
        let redacted = redaction::redact_route_capability(&text);
        return if redacted == text {
            Ok(value)
        } else {
            live_string(value, &redacted)
        };
    }
    if value.nullish()? || !object_like(value)? {
        return Ok(value);
    }
    if let Some(mapped) = lookup(seen, value)? {
        return Ok(mapped);
    }
    if depth > MAX_DEPTH {
        return Err(too_deep(value));
    }
    let output = if is_array(value)? {
        new_array(value)?
    } else {
        new_object(value)?
    };
    seen.push((value, output));
    let mut changed = false;
    for (name, item) in entries(value)? {
        let redacted_key = redaction::redact_route_capability(&name);
        let output_key = collision_safe_key(output, &redacted_key)?;
        let output_value = route_redact(item, seen, depth + 1)?;
        define_value(output, &output_key, output_value)?;
        if output_key != name || !output_value.equals(item)? {
            changed = true;
        }
    }
    if changed {
        Ok(output)
    } else {
        set_mapping(seen, value, value)?;
        Ok(value)
    }
}

/// `collisionSafeKey(output, requested)`.
fn collision_safe_key(output: LiveValue<'_>, requested: &JsString) -> Result<JsString> {
    if !has_own(output, requested)? {
        return Ok(requested.clone());
    }
    let mut counter = 2usize;
    loop {
        let mut candidate = requested.clone();
        candidate.push_str(&format!("#{counter}"));
        if !has_own(output, &candidate)? {
            return Ok(candidate);
        }
        counter += 1;
    }
}

/// One string the semantic rules may need to rewrite.
enum Slot {
    Index(u32),
    Name(JsString),
}

impl Slot {
    fn name(&self) -> &JsString {
        match self {
            Slot::Name(name) => name,
            Slot::Index(_) => unreachable!("array elements have no property name"),
        }
    }
}

fn read_slot<'a>(parent: LiveValue<'a>, slot: &Slot) -> Result<LiveValue<'a>> {
    match slot {
        Slot::Index(index) => get_element(parent, *index),
        Slot::Name(name) => get_property(parent, name),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Value,
    Key,
}

struct Descriptor<'a> {
    kind: Kind,
    parent: LiveValue<'a>,
    slot: Slot,
    value: JsString,
    redacted: JsString,
}

/// `addStringDescriptor(descriptors, parent, key)`: only a string member.
fn add_string<'a>(
    descriptors: &mut Vec<Descriptor<'a>>,
    parent: LiveValue<'a>,
    slot: Slot,
) -> Result<()> {
    let item = read_slot(parent, &slot)?;
    if let Some(text) = item.string()? {
        descriptors.push(Descriptor {
            kind: Kind::Value,
            parent,
            slot,
            value: text.clone(),
            redacted: text,
        });
    }
    Ok(())
}

/// `collectModelControlled(node, parent, key, descriptors)`. Every JavaScript
/// call starts a fresh `WeakSet`, so a node shared across two calls is walked
/// twice.
fn collect_model_controlled<'a>(
    node: LiveValue<'a>,
    parent: LiveValue<'a>,
    slot: Slot,
    descriptors: &mut Vec<Descriptor<'a>>,
    depth: usize,
) -> Result<()> {
    let mut seen = Vec::new();
    collect_model_controlled_inner(node, parent, slot, descriptors, &mut seen, depth)
}

fn collect_model_controlled_inner<'a>(
    node: LiveValue<'a>,
    parent: LiveValue<'a>,
    slot: Slot,
    descriptors: &mut Vec<Descriptor<'a>>,
    seen: &mut Vec<LiveValue<'a>>,
    depth: usize,
) -> Result<()> {
    if is_string(node)? {
        return add_string(descriptors, parent, slot);
    }
    if node.nullish()? || !object_like(node)? {
        return Ok(());
    }
    if mapping_contains(seen, node)? {
        return Ok(());
    }
    if depth > MAX_DEPTH {
        return Err(too_deep(node));
    }
    seen.push(node);
    if is_array(node)? {
        for index in 0..array_length(node)? {
            let item = get_element(node, index)?;
            collect_model_controlled_inner(
                item,
                node,
                Slot::Index(index),
                descriptors,
                seen,
                depth + 1,
            )?;
        }
        return Ok(());
    }
    for (name, item) in entries(node)? {
        descriptors.push(Descriptor {
            kind: Kind::Key,
            parent: node,
            slot: Slot::Name(name.clone()),
            value: name.clone(),
            redacted: name.clone(),
        });
        collect_model_controlled_inner(item, node, Slot::Name(name), descriptors, seen, depth + 1)?;
    }
    Ok(())
}

/// `collectToolResultContent(content, parent, key, descriptors)`.
fn collect_tool_result_content<'a>(
    content: LiveValue<'a>,
    parent: LiveValue<'a>,
    slot: Slot,
    descriptors: &mut Vec<Descriptor<'a>>,
    depth: usize,
) -> Result<()> {
    if is_string(content)? {
        return add_string(descriptors, parent, slot);
    }
    if content.nullish()? || !object_like(content)? {
        return Ok(());
    }
    if depth > MAX_DEPTH {
        return Err(too_deep(content));
    }
    if !is_array(content)? {
        return collect_model_controlled(content, parent, slot, descriptors, depth + 1);
    }
    for index in 0..array_length(content)? {
        let block = get_element(content, index)?;
        if is_string(block)? {
            add_string(descriptors, content, Slot::Index(index))?;
        } else if !block.nullish()? && object_like(block)? {
            let text = get_property(block, &key("text"))?;
            if is_string(text)? {
                add_string(descriptors, block, Slot::Name(key("text")))?;
            } else {
                let inner = get_property(block, &key("content"))?;
                if !inner.nullish()? {
                    collect_tool_result_content(
                        inner,
                        block,
                        Slot::Name(key("content")),
                        descriptors,
                        depth + 1,
                    )?;
                } else {
                    collect_model_controlled(
                        block,
                        content,
                        Slot::Index(index),
                        descriptors,
                        depth + 1,
                    )?;
                }
            }
        } else {
            collect_model_controlled(block, content, Slot::Index(index), descriptors, depth + 1)?;
        }
    }
    Ok(())
}

/// The `type` of a block, compared against a literal.
fn is_type(ty: Option<&JsString>, text: &str) -> bool {
    ty == Some(&key(text))
}

/// One `message.content` block (or the content itself when it is not an
/// array).
fn collect_block<'a>(
    block: LiveValue<'a>,
    parent: Option<LiveValue<'a>>,
    slot: Option<Slot>,
    descriptors: &mut Vec<Descriptor<'a>>,
    depth: usize,
) -> Result<()> {
    if is_string(block)? {
        if let (Some(parent), Some(slot)) = (parent, slot) {
            add_string(descriptors, parent, slot)?;
        }
        return Ok(());
    }
    if block.nullish()? || !object_like(block)? {
        return Ok(());
    }
    if depth > MAX_DEPTH {
        return Err(too_deep(block));
    }
    let ty = get_property(block, &key("type"))?.string()?;
    if is_type(ty.as_ref(), "text") || is_type(ty.as_ref(), "thinking") {
        let field = if is_type(ty.as_ref(), "text") { "text" } else { "thinking" };
        return add_string(descriptors, block, Slot::Name(key(field)));
    }
    if is_type(ty.as_ref(), "tool_use") {
        let input = get_property(block, &key("input"))?;
        return collect_model_controlled(input, block, Slot::Name(key("input")), descriptors, depth + 1);
    }
    if is_type(ty.as_ref(), "tool_result") {
        let content = get_property(block, &key("content"))?;
        return collect_tool_result_content(
            content,
            block,
            Slot::Name(key("content")),
            descriptors,
            depth + 1,
        );
    }
    // Unknown block type: the legacy walker still treats text/thinking/input/
    // content as model-controlled.
    add_string(descriptors, block, Slot::Name(key("text")))?;
    add_string(descriptors, block, Slot::Name(key("thinking")))?;
    let input = get_property(block, &key("input"))?;
    if !input.nullish()? {
        collect_model_controlled(input, block, Slot::Name(key("input")), descriptors, depth + 1)?;
    }
    let content = get_property(block, &key("content"))?;
    if !content.nullish()? {
        collect_tool_result_content(
            content,
            block,
            Slot::Name(key("content")),
            descriptors,
            depth + 1,
        )?;
    }
    Ok(())
}

/// `collectMessageContent(content, descriptors, contentParent, contentKey)`.
fn collect_message_content<'a>(
    content: LiveValue<'a>,
    descriptors: &mut Vec<Descriptor<'a>>,
    content_parent: Option<LiveValue<'a>>,
    content_key: Option<Slot>,
    depth: usize,
) -> Result<()> {
    if is_string(content)? {
        if let (Some(parent), Some(slot)) = (content_parent, content_key) {
            add_string(descriptors, parent, slot)?;
        }
        return Ok(());
    }
    if is_array(content)? {
        for index in 0..array_length(content)? {
            collect_block(
                get_element(content, index)?,
                Some(content),
                Some(Slot::Index(index)),
                descriptors,
                depth + 1,
            )?;
        }
        return Ok(());
    }
    collect_block(content, None, None, descriptors, depth + 1)
}

/// `applySemanticRedactions(descriptors, secrets)`.
fn apply_semantic_redactions(
    descriptors: &mut [Descriptor<'_>],
    secrets: &Secrets,
) -> Result<bool> {
    for descriptor in descriptors.iter_mut() {
        descriptor.redacted = descriptor.value.clone();
    }
    // Values only, then keys only, then every descriptor together: consumers
    // flatten a structure by joining values, by enumerating keys, or by seeing
    // a key followed by its value.
    for pass in 0..3 {
        let selected: Vec<usize> = descriptors
            .iter()
            .enumerate()
            .filter(|(_, descriptor)| match pass {
                0 => descriptor.kind == Kind::Value,
                1 => descriptor.kind == Kind::Key,
                _ => true,
            })
            .map(|(index, _)| index)
            .collect();
        if selected.is_empty() {
            continue;
        }
        let parts: Vec<JsString> = selected
            .iter()
            .map(|&index| descriptors[index].redacted.clone())
            .collect();
        let redacted = redact_fragments(parts, secrets);
        for (&index, text) in selected.iter().zip(redacted) {
            descriptors[index].redacted = text;
        }
    }
    if !descriptors
        .iter()
        .any(|descriptor| descriptor.redacted != descriptor.value)
    {
        return Ok(false);
    }
    // Values move before keys: a later key rename would otherwise make a value
    // write recreate the original secret-bearing property name.
    for descriptor in descriptors.iter() {
        if descriptor.kind != Kind::Value || descriptor.redacted == descriptor.value {
            continue;
        }
        match &descriptor.slot {
            Slot::Index(index) => set_element(
                descriptor.parent,
                *index,
                live_string(descriptor.parent, &descriptor.redacted)?,
            )?,
            Slot::Name(name) => set_property(
                descriptor.parent,
                name,
                live_string(descriptor.parent, &descriptor.redacted)?,
            )?,
        }
    }
    for descriptor in descriptors.iter() {
        if descriptor.kind != Kind::Key || descriptor.redacted == descriptor.value {
            continue;
        }
        rename_key(descriptor)?;
    }
    Ok(true)
}

/// The key-rename half of `applySemanticRedactions`.
fn rename_key(descriptor: &Descriptor<'_>) -> Result<()> {
    // `Object.getOwnPropertyDescriptor(parent, key)`: every property the clone
    // created is an enumerable/configurable/writable data property, and every
    // key descriptor addresses a member of a cloned object (arrays only yield
    // value descriptors), so the value is all that has to be carried over.
    // A shared sub-tree is walked once per `collectModelControlled` call, so a
    // later descriptor can address a key an earlier rename already deleted
    // from this same object; `getOwnPropertyDescriptor` then yields undefined
    // and Node skips the rename entirely.
    if !has_own(descriptor.parent, descriptor.slot.name())? {
        return Ok(());
    }
    let value = read_slot(descriptor.parent, &descriptor.slot)?;
    let mut target = descriptor.redacted.clone();
    let mut collision = 2usize;
    loop {
        let has = has_own(descriptor.parent, &target)?;
        if !has || target == descriptor.value {
            break;
        }
        target = descriptor.redacted.clone();
        target.push_str(&format!("#{collision}"));
        collision += 1;
    }
    delete_property(descriptor.parent, descriptor.slot.name())?;
    define_value(descriptor.parent, &target, value)
}

/// `scrubProviderSemanticStructure(event, secrets)`.
fn scrub_semantic_structure<'a>(event: LiveValue<'a>, secrets: &Secrets) -> Result<LiveValue<'a>> {
    if event.nullish()? || !object_like(event)? {
        return route_redact(event, &mut Vec::new(), 0);
    }
    let output = clone_structured(event, &mut Vec::new(), 0)?;
    let mut descriptors = Vec::new();
    let ty = get_property(output, &key("type"))?.string()?;
    if is_type(ty.as_ref(), "assistant") || is_type(ty.as_ref(), "user") {
        let message = get_property(output, &key("message"))?;
        if !message.nullish()? {
            let content = get_property(message, &key("content"))?;
            if !content.nullish()? {
                collect_message_content(
                    content,
                    &mut descriptors,
                    Some(message),
                    Some(Slot::Name(key("content"))),
                    0,
                )?;
            }
        }
    } else if is_type(ty.as_ref(), "tool_start") || is_type(ty.as_ref(), "tool_update") {
        let input = get_property(output, &key("input"))?;
        collect_model_controlled(input, output, Slot::Name(key("input")), &mut descriptors, 0)?;
    } else if is_type(ty.as_ref(), "tool_result") {
        let content = get_property(output, &key("content"))?;
        collect_tool_result_content(content, output, Slot::Name(key("content")), &mut descriptors, 0)?;
    }
    let changed = apply_semantic_redactions(&mut descriptors, secrets)?;
    route_redact(if changed { output } else { event }, &mut Vec::new(), 0)
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

/// `redactProviderRouteCapability(value)` for any value: strings are rewritten
/// by the core rule, objects are walked with the JS identity semantics, and
/// anything else is returned unchanged.
#[napi]
pub fn redaction_route_capability_value(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let output = route_redact(LiveValue::new(&env, value), &mut Vec::new(), 0)?;
    Ok(output.raw())
}
