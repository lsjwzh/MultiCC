//! Shared provider-event structure traversal. The same algorithm runs over
//! live JavaScript objects and Rust-owned JSON; only property operations differ.
//! Getter order, identity, split secrets and collision rules have one owner.
use crate::{
    exact_secret::{redact_fragments, Secrets},
    js::JsString,
    redaction,
};

const MAX_DEPTH: usize = 1000;
type ScrubResult<V, T> = Result<T, <V as ScrubValue>::Error>;

pub trait ScrubValue: Copy {
    type Error;
    fn nullish(self) -> ScrubResult<Self, bool>;
    fn string(self) -> ScrubResult<Self, Option<JsString>>;
    fn equals(self, other: Self) -> ScrubResult<Self, bool>;
    fn too_deep(self) -> Self::Error;
    fn object_like(self) -> ScrubResult<Self, bool>;
    fn is_string(self) -> ScrubResult<Self, bool>;
    fn is_array(self) -> ScrubResult<Self, bool>;
    fn array_length(self) -> ScrubResult<Self, u32>;
    fn live_string(self, text: &JsString) -> ScrubResult<Self, Self>;
    fn new_array(self) -> ScrubResult<Self, Self>;
    fn new_object(self) -> ScrubResult<Self, Self>;
    fn get_property(self, name: &JsString) -> ScrubResult<Self, Self>;
    fn get_element(self, index: u32) -> ScrubResult<Self, Self>;
    fn set_property(self, name: &JsString, value: Self) -> ScrubResult<Self, ()>;
    fn set_element(self, index: u32, value: Self) -> ScrubResult<Self, ()>;
    fn has_own(self, name: &JsString) -> ScrubResult<Self, bool>;
    fn delete_property(self, name: &JsString) -> ScrubResult<Self, ()>;
    fn define_value(self, name: &JsString, value: Self) -> ScrubResult<Self, ()>;
    fn entries(self) -> ScrubResult<Self, Vec<(JsString, Self)>>;
}

fn key(text: &str) -> JsString {
    JsString::from_rust_str(text)
}
fn too_deep<V: ScrubValue>(value: V) -> V::Error {
    value.too_deep()
}
fn object_like<V: ScrubValue>(anchor: V) -> ScrubResult<V, bool> {
    anchor.object_like()
}
fn is_string<V: ScrubValue>(anchor: V) -> ScrubResult<V, bool> {
    anchor.is_string()
}
fn is_array<V: ScrubValue>(anchor: V) -> ScrubResult<V, bool> {
    anchor.is_array()
}
fn array_length<V: ScrubValue>(anchor: V) -> ScrubResult<V, u32> {
    anchor.array_length()
}
fn live_string<V: ScrubValue>(anchor: V, text: &JsString) -> ScrubResult<V, V> {
    anchor.live_string(text)
}
fn new_array<V: ScrubValue>(anchor: V) -> ScrubResult<V, V> {
    anchor.new_array()
}
fn new_object<V: ScrubValue>(anchor: V) -> ScrubResult<V, V> {
    anchor.new_object()
}
fn get_property<V: ScrubValue>(anchor: V, name: &JsString) -> ScrubResult<V, V> {
    anchor.get_property(name)
}
fn get_element<V: ScrubValue>(anchor: V, index: u32) -> ScrubResult<V, V> {
    anchor.get_element(index)
}
fn set_property<V: ScrubValue>(anchor: V, name: &JsString, value: V) -> ScrubResult<V, ()> {
    anchor.set_property(name, value)
}
fn set_element<V: ScrubValue>(anchor: V, index: u32, value: V) -> ScrubResult<V, ()> {
    anchor.set_element(index, value)
}
fn has_own<V: ScrubValue>(anchor: V, name: &JsString) -> ScrubResult<V, bool> {
    anchor.has_own(name)
}
fn delete_property<V: ScrubValue>(anchor: V, name: &JsString) -> ScrubResult<V, ()> {
    anchor.delete_property(name)
}
fn define_value<V: ScrubValue>(anchor: V, name: &JsString, value: V) -> ScrubResult<V, ()> {
    anchor.define_value(name, value)
}
fn entries<V: ScrubValue>(anchor: V) -> ScrubResult<V, Vec<(JsString, V)>> {
    anchor.entries()
}

/// `WeakMap.prototype.get` for the identity maps below.
fn lookup<V: ScrubValue>(seen: &[(V, V)], value: V) -> ScrubResult<V, Option<V>> {
    for (original, mapped) in seen {
        if original.equals(value)? {
            return Ok(Some(*mapped));
        }
    }
    Ok(None)
}

fn mapping_contains<V: ScrubValue>(seen: &[V], value: V) -> ScrubResult<V, bool> {
    for entry in seen {
        if entry.equals(value)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `seen.set(value, mapped)`, replacing an existing entry.
fn set_mapping<V: ScrubValue>(seen: &mut Vec<(V, V)>, value: V, mapped: V) -> ScrubResult<V, ()> {
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
fn clone_structured<V: ScrubValue>(
    value: V,
    seen: &mut Vec<(V, V)>,
    depth: usize,
) -> ScrubResult<V, V> {
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
pub fn route_redact<V: ScrubValue>(
    value: V,
    seen: &mut Vec<(V, V)>,
    depth: usize,
) -> ScrubResult<V, V> {
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
fn collision_safe_key<V: ScrubValue>(output: V, requested: &JsString) -> ScrubResult<V, JsString> {
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

fn read_slot<V: ScrubValue>(parent: V, slot: &Slot) -> ScrubResult<V, V> {
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

struct Descriptor<V> {
    kind: Kind,
    parent: V,
    slot: Slot,
    value: JsString,
    redacted: JsString,
}

/// `addStringDescriptor(descriptors, parent, key)`: only a string member.
fn add_string<V: ScrubValue>(
    descriptors: &mut Vec<Descriptor<V>>,
    parent: V,
    slot: Slot,
) -> ScrubResult<V, ()> {
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
fn collect_model_controlled<V: ScrubValue>(
    node: V,
    parent: V,
    slot: Slot,
    descriptors: &mut Vec<Descriptor<V>>,
    depth: usize,
) -> ScrubResult<V, ()> {
    let mut seen = Vec::new();
    collect_model_controlled_inner(node, parent, slot, descriptors, &mut seen, depth)
}

fn collect_model_controlled_inner<V: ScrubValue>(
    node: V,
    parent: V,
    slot: Slot,
    descriptors: &mut Vec<Descriptor<V>>,
    seen: &mut Vec<V>,
    depth: usize,
) -> ScrubResult<V, ()> {
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
fn collect_tool_result_content<V: ScrubValue>(
    content: V,
    parent: V,
    slot: Slot,
    descriptors: &mut Vec<Descriptor<V>>,
    depth: usize,
) -> ScrubResult<V, ()> {
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
fn collect_block<V: ScrubValue>(
    block: V,
    parent: Option<V>,
    slot: Option<Slot>,
    descriptors: &mut Vec<Descriptor<V>>,
    depth: usize,
) -> ScrubResult<V, ()> {
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
        let field = if is_type(ty.as_ref(), "text") {
            "text"
        } else {
            "thinking"
        };
        return add_string(descriptors, block, Slot::Name(key(field)));
    }
    if is_type(ty.as_ref(), "tool_use") {
        let input = get_property(block, &key("input"))?;
        return collect_model_controlled(
            input,
            block,
            Slot::Name(key("input")),
            descriptors,
            depth + 1,
        );
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
        collect_model_controlled(
            input,
            block,
            Slot::Name(key("input")),
            descriptors,
            depth + 1,
        )?;
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
fn collect_message_content<V: ScrubValue>(
    content: V,
    descriptors: &mut Vec<Descriptor<V>>,
    content_parent: Option<V>,
    content_key: Option<Slot>,
    depth: usize,
) -> ScrubResult<V, ()> {
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
fn apply_semantic_redactions<V: ScrubValue>(
    descriptors: &mut [Descriptor<V>],
    secrets: &Secrets,
) -> ScrubResult<V, bool> {
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
fn rename_key<V: ScrubValue>(descriptor: &Descriptor<V>) -> ScrubResult<V, ()> {
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
pub fn scrub_semantic_structure<V: ScrubValue>(event: V, secrets: &Secrets) -> ScrubResult<V, V> {
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
        collect_tool_result_content(
            content,
            output,
            Slot::Name(key("content")),
            &mut descriptors,
            0,
        )?;
    }
    let changed = apply_semantic_redactions(&mut descriptors, secrets)?;
    route_redact(if changed { output } else { event }, &mut Vec::new(), 0)
}
