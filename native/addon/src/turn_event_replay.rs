//! napi surface for the turn event replay kernels: `deriveToolTiming`,
//! `diffToolTiming`, `deriveOpenTasks`. Every property is read from the host
//! at the moment the frozen JavaScript source read it, so getters, short
//! circuits, exceptions, coercion order and reference identity stay
//! byte-identical, and the for-of loops run the real iterator protocol through
//! the host. Rust owns the bookkeeping: insertion-ordered SameValueZero maps,
//! the Number/BigInt comparison and the shape of the returned objects.

use crate::js_iteration::{boolean, call, is_null, is_object, read, read_property, IteratorRecord};
use crate::js_live::LiveValue;
use multicc_core::js::{JsString, JsValue};
use multicc_core::turn_event_replay::{
    is_less_than, math_abs, subtract, Numeric, OrderedMap, OrderedSet, ScalarKey,
};
use napi::bindgen_prelude::Unknown;
use napi::{check_status, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;
use std::ptr;

/// The "not iterable" text is a property of the loop-head syntax; each for-of
/// site of the frozen source has its own constant.
const TERNARY_NOT_ITERABLE: &CStr =
    c"object is not iterable (cannot read property Symbol(Symbol.iterator))";
const CONTENT_NOT_ITERABLE: &CStr =
    c"contentBlocks is not a function or its return value is not iterable";
const TASKS_NOT_ITERABLE: &CStr = c"event.tasks is not iterable";

const DEFAULT_TOLERANCE_MS: f64 = 2000.0;

/// Per-call state: interned literal strings, the well-known symbol keys and
/// the identity table behind object/symbol Map keys.
struct Host<'env> {
    any: LiveValue<'env>,
    identities: Vec<LiveValue<'env>>,
    texts: Vec<(&'static str, LiveValue<'env>)>,
    iterator_key: Option<LiveValue<'env>>,
    to_primitive_key: Option<LiveValue<'env>>,
}

impl<'env> Host<'env> {
    fn new(any: LiveValue<'env>) -> Self {
        Self {
            any,
            identities: Vec::new(),
            texts: Vec::new(),
            iterator_key: None,
            to_primitive_key: None,
        }
    }

    fn value(&self, value: &JsValue) -> Result<LiveValue<'env>> {
        Ok(self.any.from_value(value)?)
    }

    fn undefined(&self) -> Result<LiveValue<'env>> {
        self.value(&JsValue::Undefined)
    }

    fn null(&self) -> Result<LiveValue<'env>> {
        self.value(&JsValue::Null)
    }

    fn boolean(&self, flag: bool) -> Result<LiveValue<'env>> {
        self.value(&JsValue::Bool(flag))
    }

    /// A literal string, created once per call.
    fn text(&mut self, text: &'static str) -> Result<LiveValue<'env>> {
        if let Some((_, value)) = self.texts.iter().find(|(seen, _)| *seen == text) {
            return Ok(*value);
        }
        let value = self.value(&JsValue::String(JsString::from_rust_str(text)))?;
        self.texts.push((text, value));
        Ok(value)
    }

    /// `Symbol.<name>` from the global object.
    fn symbol_key(&mut self, name: &CStr) -> Result<LiveValue<'env>> {
        let slot = match name.to_bytes() {
            b"iterator" => &mut self.iterator_key,
            b"toPrimitive" => &mut self.to_primitive_key,
            _ => unreachable!("static symbol name"),
        };
        if let Some(key) = *slot {
            return Ok(key);
        }
        let key = self.any.global()?.get(c"Symbol")?.get(name)?;
        *slot = Some(key);
        Ok(key)
    }

    /// The SameValueZero identity of a value; objects and symbols get an
    /// index from a strict-equality scan, never a pointer compare.
    fn key(&mut self, value: LiveValue<'env>) -> Result<ScalarKey> {
        Ok(match value.kind()? {
            sys::ValueType::napi_undefined => ScalarKey::Undefined,
            sys::ValueType::napi_null => ScalarKey::Null,
            sys::ValueType::napi_boolean => ScalarKey::Bool(boolean(value)?),
            sys::ValueType::napi_number => {
                ScalarKey::number(value.number_value()?.unwrap_or(f64::NAN))
            }
            sys::ValueType::napi_string => ScalarKey::String(value.string()?.unwrap_or_default()),
            sys::ValueType::napi_bigint => {
                let (negative, words) = bigint_words(value)?;
                ScalarKey::bigint(negative, words)
            }
            _ => {
                let mut index = None;
                for (position, known) in self.identities.iter().enumerate() {
                    if value.equals(*known)? {
                        index = Some(position);
                        break;
                    }
                }
                let index = match index {
                    Some(index) => index,
                    None => {
                        self.identities.push(value);
                        self.identities.len() - 1
                    }
                };
                ScalarKey::Identity(index)
            }
        })
    }
}

fn bigint_words(value: LiveValue<'_>) -> Result<(bool, Vec<u64>)> {
    let env = value.env();
    let mut sign = 0;
    let mut count = 0;
    // A null words pointer is napi_invalid_arg; zero capacity only reports
    // the size (measured against the host), nothing is written.
    let mut unused = 0u64;
    check_status!(unsafe {
        sys::napi_get_value_bigint_words(env, value.raw(), &mut sign, &mut count, &mut unused)
    })?;
    let mut words = vec![0u64; count];
    check_status!(unsafe {
        sys::napi_get_value_bigint_words(
            env,
            value.raw(),
            &mut sign,
            &mut count,
            words.as_mut_ptr(),
        )
    })?;
    words.truncate(count);
    Ok((sign != 0, words))
}

/// `object.<name> = value` on an object this module created.
fn set(target: LiveValue<'_>, name: &CStr, value: LiveValue<'_>) -> Result<()> {
    check_status!(unsafe {
        sys::napi_set_named_property(target.env(), target.raw(), name.as_ptr(), value.raw())
    })
}

fn object<'env>(
    host: &Host<'env>,
    properties: &[(&CStr, LiveValue<'env>)],
) -> Result<LiveValue<'env>> {
    let env = host.any.env();
    let mut raw = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_object(env, &mut raw) })?;
    for (name, value) in properties {
        check_status!(unsafe {
            sys::napi_set_named_property(env, raw, name.as_ptr(), value.raw())
        })?;
    }
    Ok(LiveValue::from_raw(env, raw))
}

fn array<'env>(host: &Host<'env>, items: &[LiveValue<'env>]) -> Result<LiveValue<'env>> {
    let env = host.any.env();
    let mut raw = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_array_with_length(env, items.len(), &mut raw) })?;
    for (index, item) in items.iter().enumerate() {
        check_status!(unsafe { sys::napi_set_element(env, raw, index as u32, item.raw()) })?;
    }
    Ok(LiveValue::from_raw(env, raw))
}

/// A for-of loop with IteratorClose on an abrupt exit.
fn for_of<'env>(
    host: &mut Host<'env>,
    iterable: LiveValue<'env>,
    not_iterable: &CStr,
    mut body: impl FnMut(&mut Host<'env>, LiveValue<'env>) -> Result<()>,
) -> Result<()> {
    let record = IteratorRecord::open(iterable, not_iterable, || host.symbol_key(c"iterator"))?;
    record.for_each(|item| body(host, item))
}

/// `contentBlocks(event)`: the array to iterate, or None for the `[]` branch.
fn content_blocks<'env>(event: LiveValue<'env>) -> Result<Option<LiveValue<'env>>> {
    if !event.truthy()? {
        return Ok(None);
    }
    // `event.message && event.message.content` reads `message` twice.
    if !read(event, c"message")?.truthy()? {
        return Ok(None);
    }
    let content = read(read(event, c"message")?, c"content")?;
    Ok(if content.is_array()? {
        Some(content)
    } else {
        None
    })
}

/// ToPrimitive with the number hint of `-` and `>`: an exotic
/// `Symbol.toPrimitive` is called without a callable check, then valueOf and
/// toString, each only when callable and only for a primitive result.
fn to_primitive<'env>(host: &mut Host<'env>, value: LiveValue<'env>) -> Result<LiveValue<'env>> {
    if !is_object(value)? {
        return Ok(value);
    }
    let exotic = value.get_key(host.symbol_key(c"toPrimitive")?)?;
    if !exotic.nullish()? {
        let hint = host.text("number")?;
        let result = call(exotic, value, &[hint])?;
        if is_object(result)? {
            return Err(result.type_error("Cannot convert object to primitive value"));
        }
        return Ok(result);
    }
    for name in [c"valueOf", c"toString"] {
        let method = read(value, name)?;
        if method.kind()? == sys::ValueType::napi_function {
            let result = call(method, value, &[])?;
            if !is_object(result)? {
                return Ok(result);
            }
        }
    }
    Err(value.type_error("Cannot convert object to primitive value"))
}

/// ToNumeric: a BigInt stays one, a symbol throws, every other primitive is
/// ToNumber'd by the engine.
fn to_numeric<'env>(host: &mut Host<'env>, value: LiveValue<'env>) -> Result<Numeric> {
    let primitive = to_primitive(host, value)?;
    Ok(match primitive.kind()? {
        sys::ValueType::napi_bigint => {
            let (negative, words) = bigint_words(primitive)?;
            Numeric::BigInt { negative, words }
        }
        sys::ValueType::napi_symbol => {
            return Err(primitive.type_error("Cannot convert a Symbol value to a number"));
        }
        _ => Numeric::Number(primitive.number()?),
    })
}

/// `Math.abs(blob - derived) > tolerance`: the subtraction coerces both
/// operands before the type check, the comparison coerces the tolerance.
fn drifts_over<'env>(
    host: &mut Host<'env>,
    blob: LiveValue<'env>,
    derived: LiveValue<'env>,
    tolerance: LiveValue<'env>,
) -> Result<bool> {
    let left = to_numeric(host, blob)?;
    let right = to_numeric(host, derived)?;
    let difference = match subtract(&left, &right) {
        Ok(difference) => difference,
        Err(_) => {
            return Err(
                blob.type_error("Cannot mix BigInt and other types, use explicit conversions")
            );
        }
    };
    let absolute = match math_abs(difference) {
        Ok(absolute) => absolute,
        Err(_) => {
            return Err(blob.type_error("Cannot convert a BigInt value to a number"));
        }
    };
    let limit = to_numeric(host, tolerance)?;
    Ok(is_less_than(&limit, &Numeric::Number(absolute)))
}

/// `Number.isFinite(b[name]) ? b[name] : null`: the second read is the value
/// even when a getter changed it.
fn finite_or_null<'env>(
    host: &Host<'env>,
    blob: LiveValue<'env>,
    name: &CStr,
) -> Result<LiveValue<'env>> {
    let first = read(blob, name)?;
    let finite = first.kind()? == sys::ValueType::napi_number
        && first.number_value()?.unwrap_or(f64::NAN).is_finite();
    Ok(if finite {
        read(blob, name)?
    } else {
        host.null()?
    })
}

/// Look up the live method before evaluating its arguments, as in
/// `tasks.has(event.task_id)`. A getter may change either during a replay.
fn map_call<'env, const N: usize>(
    map: LiveValue<'env>,
    name: &CStr,
    args: impl FnOnce() -> Result<[LiveValue<'env>; N]>,
) -> Result<LiveValue<'env>> {
    let method = read_property(map, name)?;
    let args = args()?.map(LiveValue::raw);
    if method.kind()? != sys::ValueType::napi_function {
        let name = name.to_str().expect("static method");
        return Err(map.type_error(&format!("tasks.{name} is not a function")));
    }
    let mut result = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_call_function(
            map.env(),
            map.raw(),
            method.raw(),
            N,
            args.as_ptr(),
            &mut result,
        )
    })?;
    Ok(LiveValue::from_raw(map.env(), result))
}

/// `touch(id, fields)` of deriveOpenTasks: a new task is
/// `{ task_id: id, description: '', lastTs: null, ...fields }` and joins the
/// order; a known one is `Object.assign`ed.
fn touch<'env>(
    host: &mut Host<'env>,
    tasks: LiveValue<'env>,
    order: &mut Vec<LiveValue<'env>>,
    id: LiveValue<'env>,
    description: Option<LiveValue<'env>>,
    ts: LiveValue<'env>,
) -> Result<()> {
    if map_call(tasks, c"has", || Ok([id]))?.truthy()? {
        let task = map_call(tasks, c"get", || Ok([id]))?;
        if let Some(description) = description {
            set(task, c"description", description)?;
        }
        set(task, c"lastTs", ts)?;
        return Ok(());
    }
    let description = match description {
        Some(description) => description,
        None => host.text("")?,
    };
    map_call(tasks, c"set", || {
        let task = object(
            host,
            &[
                (c"task_id", id),
                (c"description", description),
                (c"lastTs", ts),
            ],
        )?;
        Ok([id, task])
    })?;
    order.push(id);
    Ok(())
}

/// The `!record || !record.event` guard, then `const { event, ts } = record`.
fn record_parts<'env>(
    record: LiveValue<'env>,
) -> Result<Option<(LiveValue<'env>, LiveValue<'env>)>> {
    if !record.truthy()? || !read_property(record, c"event")?.truthy()? {
        return Ok(None);
    }
    let event = read_property(record, c"event")?;
    let ts = read_property(record, c"ts")?;
    Ok(Some((event, ts)))
}

struct Tool<'env> {
    value: LiveValue<'env>,
    /// The `endedAt` property as written; `null` means no result yet.
    ended_at: LiveValue<'env>,
}

fn derive_tool_timing<'env>(host: &mut Host<'env>) -> Result<LiveValue<'env>> {
    let records = host.any;
    let mut by_id: OrderedMap<Tool<'env>> = OrderedMap::new();
    let mut order: Vec<LiveValue<'env>> = Vec::new();
    if records.is_array()? {
        let assistant = host.text("assistant")?;
        let user = host.text("user")?;
        let tool_use = host.text("tool_use")?;
        let tool_result = host.text("tool_result")?;
        let empty = host.text("")?;
        let null = host.null()?;
        let no_error = host.boolean(false)?;
        for_of(host, records, TERNARY_NOT_ITERABLE, |host, record| {
            let Some((event, ts)) = record_parts(record)? else {
                return Ok(());
            };
            if read(event, c"type")?.equals(assistant)? {
                if let Some(content) = content_blocks(event)? {
                    for_of(host, content, CONTENT_NOT_ITERABLE, |host, block| {
                        if !block.truthy()? || !read(block, c"type")?.equals(tool_use)? {
                            return Ok(());
                        }
                        if !read(block, c"id")?.truthy()? {
                            return Ok(());
                        }
                        if by_id.has(&host.key(read(block, c"id")?)?) {
                            return Ok(());
                        }
                        // byId.set(block.id, { id: block.id, name: block.name || '', ... })
                        let key = host.key(read(block, c"id")?)?;
                        let id = read(block, c"id")?;
                        let name = read(block, c"name")?;
                        let name = if name.truthy()? { name } else { empty };
                        let value = object(
                            host,
                            &[
                                (c"id", id),
                                (c"name", name),
                                (c"startedAt", ts),
                                (c"endedAt", null),
                                (c"isError", no_error),
                            ],
                        )?;
                        by_id.insert(
                            key,
                            Tool {
                                value,
                                ended_at: null,
                            },
                        );
                        order.push(read(block, c"id")?);
                        Ok(())
                    })?;
                }
            } else if read(event, c"type")?.equals(user)? {
                if let Some(content) = content_blocks(event)? {
                    for_of(host, content, CONTENT_NOT_ITERABLE, |host, block| {
                        if !block.truthy()? || !read(block, c"type")?.equals(tool_result)? {
                            return Ok(());
                        }
                        if !read(block, c"tool_use_id")?.truthy()? {
                            return Ok(());
                        }
                        let key = host.key(read(block, c"tool_use_id")?)?;
                        let Some(tool) = by_id.get_mut(&key) else {
                            return Ok(());
                        };
                        if !is_null(tool.ended_at)? {
                            return Ok(());
                        }
                        tool.ended_at = ts;
                        set(tool.value, c"endedAt", ts)?;
                        let is_error = read(block, c"is_error")?;
                        set(tool.value, c"isError", host.boolean(is_error.truthy()?)?)?;
                        Ok(())
                    })?;
                }
            }
            Ok(())
        })?;
    }
    // order.map(id => byId.get(id))
    let mut tools = Vec::with_capacity(order.len());
    let undefined = host.undefined()?;
    for id in order {
        let key = host.key(id)?;
        tools.push(match by_id.get(&key) {
            Some(tool) => tool.value,
            None => undefined,
        });
    }
    array(host, &tools)
}

fn derive_open_tasks<'env>(host: &mut Host<'env>) -> Result<LiveValue<'env>> {
    let records = host.any;
    // V8 hashes object, function and Symbol keys by identity without inspecting them.
    let tasks = records.global()?.get(c"Map")?.construct(&[])?;
    let mut order: Vec<LiveValue<'env>> = Vec::new();
    if records.is_array()? {
        let started = host.text("monitor_started")?;
        let progress = host.text("monitor_progress")?;
        let done = host.text("monitor_done")?;
        let snapshot = host.text("background_tasks")?;
        let empty = host.text("")?;
        let type_key = host.text("type")?;
        let id_key = host.text("task_id")?;
        for_of(host, records, TERNARY_NOT_ITERABLE, |host, record| {
            let Some((event, ts)) = record_parts(record)? else {
                return Ok(());
            };
            // The else-if chain reads `type` again for every condition it reaches.
            let mut matched = false;
            if read(event, c"type")?.equals(started)? {
                if event.get_key(id_key)?.truthy()? {
                    let id = event.get_key(id_key)?;
                    let description = read_property(event, c"description")?;
                    let description = if description.truthy()? {
                        description
                    } else {
                        let command = read_property(event, c"command")?;
                        if command.truthy()? {
                            command
                        } else {
                            empty
                        }
                    };
                    touch(host, tasks, &mut order, id, Some(description), ts)?;
                    matched = true;
                }
            }
            if !matched && event.get_key(type_key)?.equals(progress)? {
                if event.get_key(id_key)?.truthy()? {
                    if map_call(tasks, c"has", || Ok([event.get_key(id_key)?]))?.truthy()? {
                        let id = event.get_key(id_key)?;
                        touch(host, tasks, &mut order, id, None, ts)?;
                        matched = true;
                    }
                }
            }
            if !matched && event.get_key(type_key)?.equals(done)? {
                if event.get_key(id_key)?.truthy()? {
                    map_call(tasks, c"delete", || Ok([event.get_key(id_key)?]))?;
                    matched = true;
                }
            }
            if !matched && event.get_key(type_key)?.equals(snapshot)? {
                let listed = read_property(event, c"tasks")?;
                if listed.is_array()? {
                    let listed = read_property(event, c"tasks")?;
                    for_of(host, listed, TASKS_NOT_ITERABLE, |host, entry| {
                        let id = if !entry.truthy()? {
                            None
                        } else {
                            let own = read_property(entry, c"task_id")?;
                            Some(if own.truthy()? {
                                own
                            } else {
                                read_property(entry, c"id")?
                            })
                        };
                        let Some(id) = id else {
                            return Ok(());
                        };
                        if id.truthy()? && map_call(tasks, c"has", || Ok([id]))?.truthy()? {
                            touch(host, tasks, &mut order, id, None, ts)?;
                        }
                        Ok(())
                    })?;
                }
            }
            Ok(())
        })?;
    }
    // order.map(id => tasks.get(id)).filter(Boolean)
    let mut open = Vec::with_capacity(order.len());
    for id in order {
        let task = map_call(tasks, c"get", || Ok([id]))?;
        if task.truthy()? {
            open.push(task);
        }
    }
    array(host, &open)
}

struct BlobTool<'env> {
    /// The Map key as first inserted: `set` on an existing key keeps it.
    key_value: LiveValue<'env>,
    tool: LiveValue<'env>,
}

fn diff_tool_timing<'env>(
    host: &mut Host<'env>,
    derived: LiveValue<'env>,
    blob: LiveValue<'env>,
    options: LiveValue<'env>,
) -> Result<LiveValue<'env>> {
    let mut mismatches: Vec<LiveValue<'env>> = Vec::new();
    let mut blob_by_id: OrderedMap<BlobTool<'env>> = OrderedMap::new();
    let mut seen: OrderedSet = OrderedSet::new();
    // { toleranceMs = DEFAULT_TOLERANCE_MS } = {}
    let tolerance = if options.undefined()? {
        host.value(&JsValue::Number(DEFAULT_TOLERANCE_MS))?
    } else {
        if is_null(options)? {
            return Err(
                options.type_error("Cannot read properties of null (reading 'toleranceMs')")
            );
        }
        let tolerance = read(options, c"toleranceMs")?;
        if tolerance.undefined()? {
            host.value(&JsValue::Number(DEFAULT_TOLERANCE_MS))?
        } else {
            tolerance
        }
    };
    let missing_from_blob = host.text("missing_from_blob")?;
    let name_mismatch = host.text("name_mismatch")?;
    let started_at_drift = host.text("startedAt_drift")?;
    let fabricated = host.text("endedAt_fabricated_in_blob")?;
    let ended_at_drift = host.text("endedAt_drift")?;
    let error_mismatch = host.text("isError_mismatch")?;
    let missing_from_journal = host.text("missing_from_journal")?;
    let empty = host.text("")?;
    if blob.is_array()? {
        for_of(host, blob, TERNARY_NOT_ITERABLE, |host, tool| {
            if !tool.truthy()? || !read(tool, c"id")?.truthy()? {
                return Ok(());
            }
            let key_value = read(tool, c"id")?;
            let key = host.key(key_value)?;
            match blob_by_id.get_mut(&key) {
                Some(entry) => entry.tool = tool,
                None => blob_by_id.insert(key, BlobTool { key_value, tool }),
            }
            Ok(())
        })?;
    }
    if derived.is_array()? {
        for_of(host, derived, TERNARY_NOT_ITERABLE, |host, d| {
            seen.add(host.key(read(d, c"id")?)?);
            let lookup = host.key(read(d, c"id")?)?;
            let Some(blob_tool) = blob_by_id.get(&lookup) else {
                let id = read(d, c"id")?;
                let name = read(d, c"name")?;
                mismatches.push(object(
                    host,
                    &[(c"id", id), (c"kind", missing_from_blob), (c"name", name)],
                )?);
                return Ok(());
            };
            let b = blob_tool.tool;
            let blob_name = read(b, c"name")?;
            let blob_name = if blob_name.truthy()? {
                blob_name
            } else {
                empty
            };
            if !blob_name.equals(read(d, c"name")?)? {
                let id = read(d, c"id")?;
                let derived_name = read(d, c"name")?;
                let blob_name = read(b, c"name")?;
                mismatches.push(object(
                    host,
                    &[
                        (c"id", id),
                        (c"kind", name_mismatch),
                        (c"derived", derived_name),
                        (c"blob", blob_name),
                    ],
                )?);
            }
            let b_start = finite_or_null(host, b, c"startedAt")?;
            let b_end = finite_or_null(host, b, c"endedAt")?;
            if is_null(b_start)? || drifts_over(host, b_start, read(d, c"startedAt")?, tolerance)? {
                let id = read(d, c"id")?;
                let derived_start = read(d, c"startedAt")?;
                mismatches.push(object(
                    host,
                    &[
                        (c"id", id),
                        (c"kind", started_at_drift),
                        (c"derived", derived_start),
                        (c"blob", b_start),
                    ],
                )?);
            }
            let derived_end = read(d, c"endedAt")?;
            if is_null(derived_end)? {
                if !is_null(b_end)? {
                    let id = read(d, c"id")?;
                    mismatches.push(object(
                        host,
                        &[(c"id", id), (c"kind", fabricated), (c"blob", b_end)],
                    )?);
                }
            } else if is_null(b_end)? || drifts_over(host, b_end, read(d, c"endedAt")?, tolerance)?
            {
                let id = read(d, c"id")?;
                let derived_end = read(d, c"endedAt")?;
                mismatches.push(object(
                    host,
                    &[
                        (c"id", id),
                        (c"kind", ended_at_drift),
                        (c"derived", derived_end),
                        (c"blob", b_end),
                    ],
                )?);
            }
            let blob_flag = read(b, c"is_error")?.truthy()? || read(b, c"isError")?.truthy()?;
            let derived_flag = read(d, c"isError")?;
            let mismatch = derived_flag.kind()? != sys::ValueType::napi_boolean
                || !derived_flag.equals(host.boolean(blob_flag)?)?;
            if mismatch {
                let id = read(d, c"id")?;
                let derived_flag = read(d, c"isError")?;
                mismatches.push(object(
                    host,
                    &[
                        (c"id", id),
                        (c"kind", error_mismatch),
                        (c"derived", derived_flag),
                    ],
                )?);
            }
            Ok(())
        })?;
    }
    // for (const [id, b] of blobById) if (!seen.has(id)) ...
    let mut missing: Vec<LiveValue<'env>> = Vec::new();
    for (key, entry) in blob_by_id.iter() {
        if !seen.has(key) {
            let name = read(entry.tool, c"name")?;
            let id = entry.key_value;
            missing.push(object(
                host,
                &[
                    (c"id", id),
                    (c"kind", missing_from_journal),
                    (c"name", name),
                ],
            )?);
        }
    }
    mismatches.extend(missing);
    array(host, &mismatches)
}

#[napi]
pub fn turn_event_tool_timing(env: Env, records: Unknown<'_>) -> Result<sys::napi_value> {
    let mut host = Host::new(LiveValue::new(&env, records));
    Ok(derive_tool_timing(&mut host)?.raw())
}

#[napi]
pub fn turn_event_open_tasks(env: Env, records: Unknown<'_>) -> Result<sys::napi_value> {
    let mut host = Host::new(LiveValue::new(&env, records));
    Ok(derive_open_tasks(&mut host)?.raw())
}

#[napi]
pub fn turn_event_diff_timing(
    env: Env,
    derived: Unknown<'_>,
    blob: Unknown<'_>,
    options: Unknown<'_>,
) -> Result<sys::napi_value> {
    let mut host = Host::new(LiveValue::new(&env, derived));
    let blob = LiveValue::new(&env, blob);
    let options = LiveValue::new(&env, options);
    let derived = host.any;
    Ok(diff_tool_timing(&mut host, derived, blob, options)?.raw())
}

/// Build a fresh, frozen public interface over the same live-value kernels.
/// Constructor calls to the original functions also returned their result array.
#[napi]
pub fn turn_event_replay_api(env: Env) -> Result<sys::napi_value> {
    use crate::{host_methods::method, js_live::fields};
    let owner = LiveValue::from_raw(env.raw(), unsafe {
        crate::js_bridge::write_value(env.raw(), &JsValue::Undefined)?
    });
    let timing = method(&env, owner, "deriveToolTiming", 1, 1, |_, args| {
        derive_tool_timing(&mut Host::new(args[0]))
    })?;
    let diff = method(&env, owner, "diffToolTiming", 2, 3, |_, args| {
        let options = if args[2].undefined()? {
            fields(args[0], &[])?
        } else {
            args[2]
        };
        diff_tool_timing(&mut Host::new(args[0]), args[0], args[1], options)
    })?;
    let tasks = method(&env, owner, "deriveOpenTasks", 1, 1, |_, args| {
        derive_open_tasks(&mut Host::new(args[0]))
    })?;
    Ok(fields(
        owner,
        &[
            ("deriveToolTiming", timing),
            ("diffToolTiming", diff),
            ("deriveOpenTasks", tasks),
            (
                "DEFAULT_TOLERANCE_MS",
                owner.from_value(&JsValue::Number(DEFAULT_TOLERANCE_MS))?,
            ),
        ],
    )?
    .freeze()?
    .raw())
}
