//! Hibernation reclaimer (former `src/session/hibernation-reclaimer.js`).
//! The injected ports (records, clock, eligibility, hibernate, publish, stop
//! probe) stay in V8; Rust owns candidate selection, the sequential hibernate
//! loop and the serialized capacity queue, preserving iterator-close, getter
//! order and promise-timing semantics byte-for-byte.

use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as J, session_hibernation_reclaimer as core};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    check_status, sys, Env, Error, JsValue, Result,
};
use napi_derive::napi;
use std::{cell::Cell, cmp::Ordering, ffi::CStr, ptr, rc::Rc};

fn obj(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Object(vec![]))
}
fn number(a: L<'_>, value: f64) -> Result<L<'_>> {
    a.from_value(&J::Number(value))
}
fn text<'a>(a: L<'a>, value: &str) -> Result<L<'a>> {
    a.from_value(&J::string(value))
}
fn boolean(a: L<'_>, value: bool) -> Result<L<'_>> {
    a.from_value(&J::Bool(value))
}
fn undefined(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Undefined)
}
fn call<'a>(target: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    target.get(key)?.call(target, args)
}
fn callable(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_function)
}
fn display(a: L<'_>, value: L<'_>) -> Result<String> {
    Ok(string_call(a, value)?.coerce_string()?.to_string_lossy())
}
/// `String(value)` through the global constructor.
fn string_call<'a>(a: L<'a>, value: L<'a>) -> Result<L<'a>> {
    a.global()?.get(c"String")?.call_plain(&[value])
}
/// `Number(value)`: identical to the subtraction operator's numeric coercion
/// for every non-BigInt input, including the Symbol TypeError.
fn js_number(a: L<'_>, value: L<'_>) -> Result<f64> {
    if let Some(n) = value.number_value()? {
        return Ok(n);
    }
    a.global()?.get(c"Number")?.call_plain(&[value])?.number()
}
fn not_a_function(a: L<'_>, value: L<'_>) -> Result<Error> {
    let message = match value.kind()? {
        sys::ValueType::napi_number => format!("number {} is not a function", display(a, value)?),
        sys::ValueType::napi_string => {
            format!("string \"{}\" is not a function", display(a, value)?)
        }
        sys::ValueType::napi_boolean => {
            format!("boolean {} is not a function", display(a, value)?)
        }
        _ => "object is not a function".to_string(),
    };
    Err(a.type_error(&message))
}
/// An intrinsic promise; the legacy `await` path never consults the mutable
/// global `Promise`.
fn promise<'a>(a: L<'a>, value: L<'a>, rejected: bool) -> Result<L<'a>> {
    let mut deferred = ptr::null_mut();
    let mut result = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_promise(a.env(), &mut deferred, &mut result) })?;
    if rejected {
        check_status!(unsafe { sys::napi_reject_deferred(a.env(), deferred, value.raw()) })?;
    } else {
        check_status!(unsafe { sys::napi_resolve_deferred(a.env(), deferred, value.raw()) })?;
    }
    Ok(L::from_raw(a.env(), result))
}
/// `Promise.resolve(value)` through the *global* constructor, matching the
/// legacy capacity queue and early-return literals.
fn global_resolve<'a>(a: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let ctor = a.global()?.get(c"Promise")?;
    ctor.get(c"resolve")?.call(ctor, &[value])
}
fn is_native_promise(v: L<'_>) -> Result<bool> {
    let mut result = false;
    check_status!(unsafe { sys::napi_is_promise(v.env(), v.raw(), &mut result) })?;
    Ok(result)
}

fn bigint_compare(a: L<'_>, left: L<'_>, right: L<'_>) -> Result<Ordering> {
    unsafe {
        // V8 ToWordsArray contract (Node >= 21): the word-count query needs
        // BOTH sign_bit and words null; a live sign pointer with a null words
        // buffer is rejected as napi_invalid_arg.
        let mut left_count = 0_usize;
        check_status!(sys::napi_get_value_bigint_words(
            a.env(),
            left.raw(),
            ptr::null_mut(),
            &mut left_count,
            ptr::null_mut()
        ))?;
        let mut right_count = 0_usize;
        check_status!(sys::napi_get_value_bigint_words(
            a.env(),
            right.raw(),
            ptr::null_mut(),
            &mut right_count,
            ptr::null_mut()
        ))?;
        let mut left_sign = 0;
        let mut left_words = vec![0_u64; left_count];
        check_status!(sys::napi_get_value_bigint_words(
            a.env(),
            left.raw(),
            &mut left_sign,
            &mut left_count,
            left_words.as_mut_ptr()
        ))?;
        let mut right_sign = 0;
        let mut right_words = vec![0_u64; right_count];
        check_status!(sys::napi_get_value_bigint_words(
            a.env(),
            right.raw(),
            &mut right_sign,
            &mut right_count,
            right_words.as_mut_ptr()
        ))?;
        if left_sign != right_sign {
            return Ok(if left_sign < right_sign {
                Ordering::Less
            } else {
                Ordering::Greater
            });
        }
        let mut left_words = vec![0_u64; left_count];
        let mut right_words = vec![0_u64; right_count];
        check_status!(sys::napi_get_value_bigint_words(
            a.env(),
            left.raw(),
            &mut left_sign,
            &mut left_count,
            left_words.as_mut_ptr()
        ))?;
        check_status!(sys::napi_get_value_bigint_words(
            a.env(),
            right.raw(),
            &mut right_sign,
            &mut right_count,
            right_words.as_mut_ptr()
        ))?;
        let ordering = left_count
            .cmp(&right_count)
            .then_with(|| left_words.iter().rev().cmp(right_words.iter().rev()));
        Ok(if left_sign == 1 {
            ordering.reverse()
        } else {
            ordering
        })
    }
}

enum Sub<'a> {
    Number(f64),
    /// A non-zero BigInt difference, returned as-is so V8's sort coerces it
    /// with the same TypeError the legacy comparator produced.
    BigInt(L<'a>),
}
fn js_subtract<'a>(a: L<'a>, left: L<'a>, right: L<'a>) -> Result<Sub<'a>> {
    let left_bigint = left.kind()? == sys::ValueType::napi_bigint;
    let right_bigint = right.kind()? == sys::ValueType::napi_bigint;
    if left_bigint || right_bigint {
        if left_bigint && right_bigint {
            return match bigint_compare(a, left, right)? {
                Ordering::Equal => Ok(Sub::Number(0.0)),
                _ => Ok(Sub::BigInt(left)),
            };
        }
        return Err(a.type_error("Cannot mix BigInt and other types, use explicit conversions"));
    }
    Ok(Sub::Number(js_number(a, left)? - js_number(a, right)?))
}

/// `new Set(Array.isArray(source) ? source : [source])` with the exact
/// Array.isArray proxy semantics.
fn excluded_set<'a>(a: L<'a>, source: L<'a>) -> Result<L<'a>> {
    let array_ctor = a.global()?.get(c"Array")?;
    let is_array = array_ctor
        .get(c"isArray")?
        .call(array_ctor, &[source])?
        .truthy()?;
    let iterable = if is_array {
        source
    } else {
        let wrapped = a.from_value(&J::Array(vec![]))?;
        wrapped.set_element(0, source)?;
        wrapped
    };
    a.global()?.get(c"Set")?.construct(&[iterable])
}

/// V8 folds every for..of head failure (missing/non-callable Symbol.iterator
/// on the evaluated expression) into one message derived from the source
/// text, so the call site provides it.
fn get_iterator<'a>(a: L<'a>, iterable: L<'a>, head_message: &str) -> Result<(L<'a>, L<'a>)> {
    if iterable.nullish()? {
        return Err(a.type_error(head_message));
    }
    let symbol = a.global()?.get(c"Symbol")?.get(c"iterator")?;
    let method = iterable.get_key(symbol)?;
    if method.nullish()? {
        return Err(a.type_error(head_message));
    }
    if !callable(method)? {
        return Err(a.type_error(head_message));
    }
    let iterator = method.call(iterable, &[])?;
    if !matches!(
        iterator.kind()?,
        sys::ValueType::napi_object | sys::ValueType::napi_function
    ) {
        return Err(a.type_error("Result of the Symbol.iterator method is not an object"));
    }
    let next = iterator.get(c"next")?;
    if !callable(next)? {
        return Err(not_a_function(a, next)?);
    }
    Ok((iterator, next))
}
/// One for..of step. A throwing `next()` propagates without closing.
fn iter_step<'a>(a: L<'a>, iterator: L<'a>, next: L<'a>) -> Result<Option<L<'a>>> {
    let step = next.call(iterator, &[])?;
    if !matches!(
        step.kind()?,
        sys::ValueType::napi_object | sys::ValueType::napi_function
    ) {
        let shown = display(a, step)?;
        return Err(a.type_error(&format!("Iterator result {shown} is not an object")));
    }
    if step.get(c"done")?.truthy()? {
        return Ok(None);
    }
    Ok(Some(step.get(c"value")?))
}
/// for..of IteratorClose on a normal (break) completion: errors propagate.
fn iter_close<'a>(a: L<'a>, iterator: L<'a>) -> Result<()> {
    let method = iterator.get(c"return")?;
    if method.nullish()? {
        return Ok(());
    }
    if !callable(method)? {
        return Err(not_a_function(a, method)?);
    }
    let result = method.call(iterator, &[])?;
    if !matches!(
        result.kind()?,
        sys::ValueType::napi_object | sys::ValueType::napi_function
    ) {
        let shown = display(a, result)?;
        return Err(a.type_error(&format!("Iterator result {shown} is not an object")));
    }
    Ok(())
}
/// IteratorClose after an abrupt body completion: side effects run, errors
/// are swallowed, and the original error keeps propagating.
fn iter_close_swallow(a: L<'_>, iterator: L<'_>) {
    let _ = a.catch(|| iter_close(a, iterator));
}

/// Per-factory state: the injected ports, capacity queue tail and in-flight
/// capacity count. A strong reference keeps it alive like the legacy closure
/// did for the process lifetime.
struct FacadeState {
    env: sys::napi_env,
    state: sys::napi_ref,
}
impl FacadeState {
    fn state<'a>(&self, env: &'a Env) -> Result<L<'a>> {
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_reference_value(self.env, self.state, &mut value) })?;
        Ok(L::from_raw(env.raw(), value))
    }
    fn ports<'a>(&self, env: &'a Env) -> Result<L<'a>> {
        self.state(env)?.get(c"ports")
    }
}

fn arity(function: L<'_>, length: f64) -> Result<L<'_>> {
    let value = function.from_value(&J::Number(length))?;
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

/// Destructuring an options argument with defaults: `undefined` selects every
/// default, `null` raises V8's message naming the first key, and primitives
/// wrap to an empty object.
fn destructure<'a>(options: L<'a>, first_key: &CStr) -> Result<Option<L<'a>>> {
    if options.undefined()? {
        return Ok(None);
    }
    if options.kind()? == sys::ValueType::napi_null {
        return Err(options.type_error(&format!(
            "Cannot read properties of null (reading '{}')",
            first_key.to_str().unwrap_or("dirId")
        )));
    }
    if matches!(
        options.kind()?,
        sys::ValueType::napi_object | sys::ValueType::napi_function
    ) {
        Ok(Some(options))
    } else {
        Ok(None)
    }
}

/// Property read with V8's exact null/undefined TypeError. Every read whose
/// target comes from injected ports and is not guarded by optional chaining
/// goes through this so the rejection/throw value stays byte-identical.
fn get_prop<'a>(a: L<'a>, target: L<'a>, key: &CStr) -> Result<L<'a>> {
    if target.nullish()? {
        let which = if target.kind()? == sys::ValueType::napi_null {
            "null"
        } else {
            "undefined"
        };
        return Err(a.type_error(&format!(
            "Cannot read properties of {} (reading '{}')",
            which,
            key.to_str().unwrap_or("")
        )));
    }
    target.get(key)
}
/// `[0]` element read with V8's exact null/undefined TypeError. Numbers,
/// booleans, symbols and bigints wrap to objects without indexed members.
fn element0<'a>(a: L<'a>, target: L<'a>) -> Result<L<'a>> {
    if target.nullish()? {
        let which = if target.kind()? == sys::ValueType::napi_null {
            "null"
        } else {
            "undefined"
        };
        return Err(a.type_error(&format!("Cannot read properties of {which} (reading '0')")));
    }
    match target.kind()? {
        sys::ValueType::napi_object | sys::ValueType::napi_function => target.element(0),
        sys::ValueType::napi_string => target.get(c"0"),
        _ => undefined(a),
    }
}

#[allow(clippy::too_many_arguments)]
fn candidate_body<'a>(
    a: L<'a>,
    ports: L<'a>,
    candidates: L<'a>,
    record: L<'a>,
    dir_id: L<'a>,
    dir_id_truthy: bool,
    ignore_idle: bool,
    threshold: L<'a>,
    excluded: L<'a>,
    report_skips: Option<bool>,
) -> Result<()> {
    if dir_id_truthy {
        let record_dir = if record.nullish()? {
            undefined(a)?
        } else {
            record.get(c"dirId")?
        };
        if !record_dir.equals(dir_id)? {
            return Ok(());
        }
    }
    let record_id = if record.nullish()? {
        undefined(a)?
    } else {
        record.get(c"id")?
    };
    if call(excluded, c"has", &[record_id])?.truthy()? {
        return Ok(());
    }
    let now = ports.get(c"now")?;
    if !callable(now)? {
        return Err(a.type_error("now is not a function"));
    }
    let now_ms = now.call_plain(&[])?;
    let verdict_options = obj(a)?;
    verdict_options.set(c"nowMs", now_ms)?;
    verdict_options.set(
        c"idleMs",
        if ignore_idle {
            number(a, 0.0)?
        } else {
            threshold
        },
    )?;
    let eligible = ports.get(c"eligible")?;
    if !callable(eligible)? {
        return Err(a.type_error("eligible is not a function"));
    }
    let verdict = eligible.call_plain(&[record, verdict_options])?;
    if get_prop(a, verdict, c"eligible")?.truthy()? {
        let entry = obj(a)?;
        entry.set(c"record", record)?;
        entry.set(c"lastWorkMs", get_prop(a, verdict, c"lastWorkMs")?)?;
        call(candidates, c"push", &[entry])?;
        return Ok(());
    }
    // `(reportSkips ?? !ignoreIdle) && record?.taskBoundTaskId &&
    //  record.kind === 'chat'`: the legacy short-circuit means a false
    // conjunct suppresses every later read, so they stay separate here.
    if !core::skip_gate(report_skips, ignore_idle) {
        return Ok(());
    }
    let task_bound = if record.nullish()? {
        false
    } else {
        record.get(c"taskBoundTaskId")?.truthy()?
    };
    if !task_bound {
        return Ok(());
    }
    if !record.get(c"kind")?.equals(text(a, "chat")?)? {
        return Ok(());
    }
    // Arguments evaluate left to right before the call; a non-callable
    // `publish` only raises once every argument has been read.
    let publish_id = record.get(c"id")?;
    let reason0 = element0(a, get_prop(a, verdict, c"reasons")?)?;
    let reason = if reason0.truthy()? {
        reason0
    } else {
        text(a, "ineligible")?
    };
    let publish = ports.get(c"publish")?;
    if !callable(publish)? {
        return Err(a.type_error("publish is not a function"));
    }
    publish.call_plain(&[text(a, "sweep")?, text(a, "skip")?, publish_id, reason])?;
    Ok(())
}

fn bind_comparator(env: &Env) -> Result<L<'_>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "compareHibernationCandidates",
        move |ctx| {
            let env: &Env = ctx.env;
            let base = L::new(env, ().into_unknown(env)?);
            let left = L::new(env, ctx.get::<Unknown<'_>>(0)?);
            let right = L::new(env, ctx.get::<Unknown<'_>>(1)?);
            let result = (|| -> Result<L<'_>> {
                let diff = js_subtract(
                    base,
                    get_prop(base, left, c"lastWorkMs")?,
                    get_prop(base, right, c"lastWorkMs")?,
                )?;
                let fallback = match &diff {
                    Sub::Number(n) => *n == 0.0 || n.is_nan(),
                    Sub::BigInt(_) => false,
                };
                if !fallback {
                    return match diff {
                        Sub::Number(n) => number(base, n),
                        Sub::BigInt(value) => Ok(value),
                    };
                }
                let left_id = get_prop(base, get_prop(base, left, c"record")?, c"id")?;
                let right_id = get_prop(base, get_prop(base, right, c"record")?, c"id")?;
                let method = left_id.get(c"localeCompare")?;
                if !callable(method)? {
                    return Err(base.type_error("left.record.id.localeCompare is not a function"));
                }
                method.call(left_id, &[right_id])
            })();
            result.map(|value| value.raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}

fn candidates_for<'a>(env: &'a Env, facade: &Rc<FacadeState>, options: L<'a>) -> Result<L<'a>> {
    let a = options;
    let state = facade.state(env)?;
    // Reading the factory ports object is unobservable, so it can happen
    // before the option coercion just like the legacy closure bindings.
    let ports = state.get(c"ports")?;
    let opts = destructure(options, c"dirId")?;
    let pick = |key: &CStr, default: &J| -> Result<L<'a>> {
        match opts {
            Some(o) => {
                let value = o.get(key)?;
                if value.undefined()? {
                    a.from_value(default)
                } else {
                    Ok(value)
                }
            }
            None => a.from_value(default),
        }
    };
    let dir_id = pick(c"dirId", &J::Null)?;
    let ignore_idle = pick(c"ignoreIdle", &J::Bool(false))?;
    let exclude = pick(c"excludeSessionIds", &J::Array(vec![]))?;
    let idle_override = pick(c"idleMs", &J::Null)?;
    let report_skips = pick(c"reportSkips", &J::Null)?;
    let excluded = excluded_set(a, exclude)?;
    // `idleMsOverride != null && Number.isFinite(Number(idleMsOverride))`:
    // the legacy code coerces twice when the override is accepted, and a
    // throwing coercion propagates before any record is visited.
    let threshold = if !idle_override.nullish()? {
        let first = js_number(a, idle_override)?;
        if core::use_idle_override(true, first.is_finite()) {
            number(a, js_number(a, idle_override)?)?
        } else {
            ports.get(c"idleMs")?
        }
    } else {
        ports.get(c"idleMs")?
    };
    let records = ports.get(c"records")?;
    // The legacy head is the call expression "records.values()": V8 folds a
    // missing method, a failed call lookup and a non-iterable result into the
    // same message.
    const VALUES_HEAD: &str =
        "records.values is not a function or its return value is not iterable";
    let values = get_prop(a, records, c"values")?;
    if !callable(values)? {
        return Err(a.type_error(VALUES_HEAD));
    }
    let iterable = values.call(records, &[])?;
    let (iterator, next) = get_iterator(a, iterable, VALUES_HEAD)?;
    let candidates = a.from_value(&J::Array(vec![]))?;
    let dir_id_truthy = dir_id.truthy()?;
    let ignore_idle_truthy = ignore_idle.truthy()?;
    let report_skips_choice = if report_skips.nullish()? {
        None
    } else {
        Some(report_skips.truthy()?)
    };
    loop {
        let record = match iter_step(a, iterator, next) {
            Err(error) => {
                let exception = a.exception_value()?;
                return Err(match exception {
                    Some(value) => value.throw_error(),
                    None => error,
                });
            }
            Ok(None) => break,
            Ok(Some(record)) => record,
        };
        let body = candidate_body(
            a,
            ports,
            candidates,
            record,
            dir_id,
            dir_id_truthy,
            ignore_idle_truthy,
            threshold,
            excluded,
            report_skips_choice,
        );
        if let Err(error) = body {
            let exception = a.exception_value()?;
            iter_close_swallow(a, iterator);
            return Err(match exception {
                Some(value) => value.throw_error(),
                None => error,
            });
        }
    }
    let comparator = bind_comparator(env)?;
    call(candidates, c"sort", &[comparator])?;
    Ok(candidates)
}

/// Per-call state of one `runCandidates` invocation: the candidates iterator,
/// options and counters live in a V8 object so pending continuations keep
/// them reachable. The deferred settles exactly once; the strong reference is
/// dropped when the run settles.
struct RunCtx {
    env: sys::napi_env,
    state: sys::napi_ref,
    deferred: sys::napi_deferred,
    settled: Cell<bool>,
    released: Cell<bool>,
}
impl RunCtx {
    fn state<'a>(&self, a: L<'a>) -> Result<L<'a>> {
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_reference_value(self.env, self.state, &mut value) })?;
        Ok(L::from_raw(a.env(), value))
    }
    fn release(&self) {
        if self.released.replace(true) {
            return;
        }
        unsafe {
            sys::napi_delete_reference(self.env, self.state);
        }
    }
}
impl Drop for RunCtx {
    fn drop(&mut self) {
        self.release();
    }
}

fn bump(a: L<'_>, state: L<'_>, key: &CStr) -> Result<()> {
    let current = state.get(key)?.number()?;
    state.set(key, number(a, current + 1.0)?)
}

/// `hibernated >= limit`. Relational comparison re-coerces the limit on every
/// evaluation; a BigInt limit compares mathematically instead of throwing.
fn limit_reached(a: L<'_>, hibernated: f64, limit: L<'_>) -> Result<bool> {
    if limit.kind()? == sys::ValueType::napi_bigint {
        let mut raw = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_bigint_int64(a.env(), hibernated as i64, &mut raw)
        })?;
        let left = L::from_raw(a.env(), raw);
        return Ok(matches!(
            bigint_compare(a, left, limit)?,
            Ordering::Greater | Ordering::Equal
        ));
    }
    Ok(hibernated >= js_number(a, limit)?)
}

/// `result.ok && result.hibernated` then `result.skipped || result.already`,
/// keeping the legacy short-circuit read order. Runs outside the try/catch,
/// so a throwing getter is an abrupt body completion.
fn classify(a: L<'_>, result: L<'_>) -> Result<core::RunOutcome> {
    if get_prop(a, result, c"ok")?.truthy()? && get_prop(a, result, c"hibernated")?.truthy()? {
        return Ok(core::RunOutcome::Hibernated);
    }
    if get_prop(a, result, c"skipped")?.truthy()? || get_prop(a, result, c"already")?.truthy()? {
        return Ok(core::RunOutcome::Skipped);
    }
    Ok(core::RunOutcome::Failed)
}

fn settle_resolve(env: &Env, ctx: &Rc<RunCtx>) -> Result<()> {
    if ctx.settled.replace(true) {
        return Ok(());
    }
    let a = L::new(env, ().into_unknown(env)?);
    let state = ctx.state(a)?;
    let out = obj(a)?;
    out.set(c"attempted", state.get(c"attempted")?)?;
    out.set(c"hibernated", state.get(c"hibernated")?)?;
    out.set(c"failed", state.get(c"failed")?)?;
    out.set(c"skipped", state.get(c"skipped")?)?;
    let status = unsafe { sys::napi_resolve_deferred(env.raw(), ctx.deferred, out.raw()) };
    ctx.release();
    check_status!(status)?;
    Ok(())
}
fn settle_reject(env: &Env, ctx: &Rc<RunCtx>, error: Error) -> Result<()> {
    let a = L::new(env, ().into_unknown(env)?);
    let exception = a.exception_value()?;
    settle_reject_prefetched(env, ctx, exception, error)
}
/// The pending exception must be fetched *before* any cleanup (iterator
/// close runs host calls that would otherwise clear or be poisoned by it).
fn settle_reject_prefetched(
    env: &Env,
    ctx: &Rc<RunCtx>,
    exception: Option<L<'_>>,
    error: Error,
) -> Result<()> {
    if ctx.settled.replace(true) {
        return Ok(());
    }
    let a = L::new(env, ().into_unknown(env)?);
    let reason = match exception {
        Some(value) => value,
        None => {
            let value = a
                .global()?
                .get(c"Error")?
                .construct(&[text(a, &error.reason)?])?;
            value.set(c"code", text(a, error.status.as_ref())?)?;
            value
        }
    };
    let status = unsafe { sys::napi_reject_deferred(env.raw(), ctx.deferred, reason.raw()) };
    ctx.release();
    check_status!(status)?;
    Ok(())
}
/// Abrupt body completion: capture the pending error, close the iterator
/// with errors swallowed, then reject with the original value.
fn abrupt_reject(
    env: &Env,
    ctx: &Rc<RunCtx>,
    a: L<'_>,
    iterator: L<'_>,
    error: Error,
) -> Result<()> {
    let exception = a.exception_value()?;
    iter_close_swallow(a, iterator);
    settle_reject_prefetched(env, ctx, exception, error)
}

/// `await hibernate(...)`: native promises take the continuation directly
/// (PromiseResolve passthrough); anything else goes through a deferred
/// resolve so thenables assimilate exactly like the spec.
fn suspend<'a>(env: &'a Env, ctx: &Rc<RunCtx>, value: L<'a>) -> Result<()> {
    let awaited = if is_native_promise(value)? {
        value
    } else {
        promise(value, value, false)?
    };
    let ok = fulfilled_continuation(env, Rc::clone(ctx))?;
    let err = rejected_continuation(env, Rc::clone(ctx))?;
    call(awaited, c"then", &[ok, err])?;
    Ok(())
}

fn advance(env: &Env, ctx: &Rc<RunCtx>) -> Result<()> {
    let a = L::new(env, ().into_unknown(env)?);
    let state = ctx.state(a)?;
    let iterator = state.get(c"iterator")?;
    let next = state.get(c"next")?;
    loop {
        // A throwing next() propagates without closing the iterator.
        let candidate = match iter_step(a, iterator, next) {
            Ok(Some(record)) => record,
            Ok(None) => return settle_resolve(env, ctx),
            Err(error) => return settle_reject(env, ctx, error),
        };
        // `if (hibernated >= limit) break;` is a body statement: a throwing
        // coercion closes the iterator with errors swallowed.
        let hibernated_now = state.get(c"hibernated")?.number()?;
        let limit = state.get(c"limit")?;
        match limit_reached(a, hibernated_now, limit) {
            Ok(false) => {}
            Ok(true) => {
                // break: IteratorClose errors propagate.
                if let Err(error) = iter_close(a, iterator) {
                    return settle_reject(env, ctx, error);
                }
                return settle_resolve(env, ctx);
            }
            Err(error) => {
                return abrupt_reject(env, ctx, a, iterator, error);
            }
        }
        bump(a, state, c"attempted")?;
        // `result = await hibernate(candidate.record.id, {...})` plus every
        // argument read sits inside the legacy try; any throw counts as a
        // failed attempt and the loop continues.
        let attempted = a.catch(|| -> Result<L<'_>> {
            let record = candidate.get(c"record")?;
            let id = record.get(c"id")?;
            let options = obj(a)?;
            options.set(c"eligibilityChecked", boolean(a, true)?)?;
            options.set(c"ignoreIdle", state.get(c"ignoreIdle")?)?;
            options.set(c"idleMs", state.get(c"idleMs")?)?;
            state.get(c"hibernate")?.call_plain(&[id, options])
        })?;
        match attempted {
            None => {
                bump(a, state, c"failed")?;
            }
            Some(value) => {
                return match suspend(env, ctx, value) {
                    Ok(()) => Ok(()),
                    Err(error) => abrupt_reject(env, ctx, a, iterator, error),
                };
            }
        }
    }
}

fn fulfilled_continuation(env: &Env, ctx: Rc<RunCtx>) -> Result<L<'_>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "runCandidateFulfilled",
        move |cb| {
            let env: &Env = cb.env;
            let a = L::new(env, ().into_unknown(env)?);
            let result = if cb.length() > 0 {
                L::new(env, cb.get::<Unknown<'_>>(0)?)
            } else {
                undefined(a)?
            };
            let run = (|| -> Result<()> {
                let state = ctx.state(a)?;
                let iterator = state.get(c"iterator")?;
                let outcome = match classify(a, result) {
                    Ok(outcome) => outcome,
                    Err(error) => {
                        // Classification sits outside the legacy try: an
                        // abrupt body completion closes the iterator with
                        // errors swallowed and the original error wins.
                        return abrupt_reject(env, &ctx, a, iterator, error);
                    }
                };
                let key = match outcome {
                    core::RunOutcome::Hibernated => c"hibernated",
                    core::RunOutcome::Skipped => c"skipped",
                    core::RunOutcome::Failed => c"failed",
                };
                bump(a, state, key)?;
                advance(env, &ctx)
            })();
            if let Err(error) = run {
                let _ = settle_reject(env, &ctx, error);
            }
            Ok(undefined(a)?.raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}
fn rejected_continuation(env: &Env, ctx: Rc<RunCtx>) -> Result<L<'_>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "runCandidateRejected",
        move |cb| {
            let env: &Env = cb.env;
            let a = L::new(env, ().into_unknown(env)?);
            let run = (|| -> Result<()> {
                let state = ctx.state(a)?;
                bump(a, state, c"failed")?;
                advance(env, &ctx)
            })();
            if let Err(error) = run {
                let _ = settle_reject(env, &ctx, error);
            }
            Ok(undefined(a)?.raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}

/// The async `runCandidates(candidates, options)`: it never throws
/// synchronously; parameter-binding and iterator errors reject the promise.
fn run_candidates_impl<'a>(
    env: &'a Env,
    facade: &Rc<FacadeState>,
    candidates: L<'a>,
    options: L<'a>,
) -> Result<L<'a>> {
    let a = L::new(env, ().into_unknown(env)?);
    let mut deferred = ptr::null_mut();
    let mut raw = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_promise(env.raw(), &mut deferred, &mut raw) })?;
    let result_promise = L::from_raw(env.raw(), raw);
    let setup = (|| -> Result<Rc<RunCtx>> {
        let ports = facade.ports(env)?;
        let opts = destructure(options, c"limit")?;
        let pick = |key: &CStr, default: L<'a>| -> Result<L<'a>> {
            match opts {
                Some(o) => {
                    let value = o.get(key)?;
                    if value.undefined()? {
                        Ok(default)
                    } else {
                        Ok(value)
                    }
                }
                None => Ok(default),
            }
        };
        let limit = pick(c"limit", ports.get(c"batchSize")?)?;
        let ignore_idle = pick(c"ignoreIdle", boolean(a, false)?)?;
        let idle_ms = pick(c"idleMs", a.from_value(&J::Null)?)?;
        // The legacy head is the plain identifier "candidates".
        let (iterator, next) = get_iterator(a, candidates, "candidates is not iterable")?;
        let state = obj(a)?;
        state.set(c"iterator", iterator)?;
        state.set(c"next", next)?;
        state.set(c"limit", limit)?;
        state.set(c"ignoreIdle", ignore_idle)?;
        state.set(c"idleMs", idle_ms)?;
        state.set(c"hibernate", ports.get(c"hibernate")?)?;
        state.set(c"attempted", number(a, 0.0)?)?;
        state.set(c"hibernated", number(a, 0.0)?)?;
        state.set(c"failed", number(a, 0.0)?)?;
        state.set(c"skipped", number(a, 0.0)?)?;
        let mut state_ref = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_reference(env.raw(), state.raw(), 1, &mut state_ref)
        })?;
        Ok(Rc::new(RunCtx {
            env: env.raw(),
            state: state_ref,
            deferred,
            settled: Cell::new(false),
            released: Cell::new(false),
        }))
    })();
    match setup {
        Ok(ctx) => {
            if let Err(error) = advance(env, &ctx) {
                let _ = settle_reject(env, &ctx, error);
            }
        }
        Err(error) => {
            let reason = match a.exception_value()? {
                Some(value) => value,
                None => a
                    .global()?
                    .get(c"Error")?
                    .construct(&[text(a, &error.reason)?])?,
            };
            check_status!(unsafe { sys::napi_reject_deferred(env.raw(), deferred, reason.raw()) })?;
        }
    }
    Ok(result_promise)
}

/// Per-`reclaimForCapacity` arguments retained across the capacity chain.
struct ReclaimCtx {
    env: sys::napi_env,
    state: sys::napi_ref,
    released: Cell<bool>,
}
impl ReclaimCtx {
    fn new(env: &Env, state: L<'_>) -> Result<Rc<Self>> {
        let mut reference = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_reference(env.raw(), state.raw(), 1, &mut reference)
        })?;
        Ok(Rc::new(Self {
            env: env.raw(),
            state: reference,
            released: Cell::new(false),
        }))
    }
    fn state<'a>(&self, a: L<'a>) -> Result<L<'a>> {
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_reference_value(self.env, self.state, &mut value) })?;
        Ok(L::from_raw(a.env(), value))
    }
    fn release(&self) {
        if self.released.replace(true) {
            return;
        }
        unsafe {
            sys::napi_delete_reference(self.env, self.state);
        }
    }
}
impl Drop for ReclaimCtx {
    fn drop(&mut self) {
        self.release();
    }
}

fn noop_function(env: &Env) -> Result<L<'_>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "hibernationReclaimerNoop",
        move |cb| {
            let env: &Env = cb.env;
            Ok(L::new(env, ().into_unknown(env)?).raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}

/// `() => { capacityRuns -= 1; }` attached through `finally`.
fn dec_function(env: &Env, facade: Rc<FacadeState>) -> Result<L<'_>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "hibernationCapacitySettled",
        move |cb| {
            let env: &Env = cb.env;
            let a = L::new(env, ().into_unknown(env)?);
            let run = (|| -> Result<()> {
                let state = facade.state(env)?;
                let runs = state.get(c"runs")?.number()?;
                state.set(c"runs", number(a, runs - 1.0)?)?;
                Ok(())
            })();
            run?;
            Ok(undefined(a)?.raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}

/// `{ ok: true, considered, ...counters }` once the inner run settles.
fn spread_function(env: &Env, rc: Rc<ReclaimCtx>) -> Result<L<'_>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "hibernationCapacitySpread",
        move |cb| {
            let env: &Env = cb.env;
            let a = L::new(env, ().into_unknown(env)?);
            let run = (|| -> Result<L<'_>> {
                let counters = if cb.length() > 0 {
                    L::new(env, cb.get::<Unknown<'_>>(0)?)
                } else {
                    undefined(a)?
                };
                let out = obj(a)?;
                out.set(c"ok", boolean(a, true)?)?;
                out.set(c"considered", rc.state(a)?.get(c"considered")?)?;
                out.spread_from(counters)?;
                Ok(out)
            })();
            rc.release();
            run.map(|value| value.raw())
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}
/// Releases the per-reclaim state and rethrows the inner rejection, matching
/// the legacy body that lets the failed run propagate out of the `await`.
fn rethrow_function(env: &Env, rc: Rc<ReclaimCtx>) -> Result<L<'_>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "hibernationCapacityRethrow",
        move |cb| {
            let env: &Env = cb.env;
            let a = L::new(env, ().into_unknown(env)?);
            rc.release();
            let reason = if cb.length() > 0 {
                L::new(env, cb.get::<Unknown<'_>>(0)?)
            } else {
                undefined(a)?
            };
            Err(reason.throw_error())
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}

/// The capacity body: stop probe, candidate selection, then the awaited
/// inner run whose counters spread into the result.
fn body_function(env: &Env, facade: Rc<FacadeState>, rc: Rc<ReclaimCtx>) -> Result<L<'_>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "hibernationCapacityBody",
        move |cb| {
            let env: &Env = cb.env;
            let a = L::new(env, ().into_unknown(env)?);
            let run = (|| -> Result<L<'_>> {
                let ports = facade.ports(env)?;
                let is_stopped = ports.get(c"isStopped")?;
                if !callable(is_stopped)? {
                    return Err(a.type_error("isStopped is not a function"));
                }
                if is_stopped.call_plain(&[])?.truthy()? {
                    let out = obj(a)?;
                    out.set(c"ok", boolean(a, false)?)?;
                    out.set(c"code", text(a, "hibernation_stopped")?)?;
                    out.set(c"considered", number(a, 0.0)?)?;
                    out.set(c"hibernated", number(a, 0.0)?)?;
                    rc.release();
                    // The legacy body returns through its own async promise,
                    // so the outer `then` assimilates a thenable either way.
                    return promise(a, out, false);
                }
                let rc_state = rc.state(a)?;
                let options = obj(a)?;
                options.set(c"dirId", rc_state.get(c"dirId")?)?;
                options.set(c"ignoreIdle", boolean(a, true)?)?;
                options.set(c"excludeSessionIds", rc_state.get(c"exclude")?)?;
                let candidates = candidates_for(env, &facade, options)?;
                rc_state.set(c"considered", candidates.get(c"length")?)?;
                let run_options = obj(a)?;
                run_options.set(c"limit", rc_state.get(c"limit")?)?;
                run_options.set(c"ignoreIdle", boolean(a, true)?)?;
                let inner = run_candidates_impl(env, &facade, candidates, run_options)?;
                let spread = spread_function(env, Rc::clone(&rc))?;
                let rethrow = rethrow_function(env, Rc::clone(&rc))?;
                call(inner, c"then", &[spread, rethrow])
            })();
            match run {
                Ok(value) => Ok(value.raw()),
                Err(error) => {
                    rc.release();
                    Err(error)
                }
            }
        },
    )?;
    Ok(L::from_raw(env.raw(), function.into_unknown(env)?.raw()))
}

/// `reclaimForCapacity({ dirId, excludeSessionIds = [], count = 1 } = {})`:
/// synchronous entry that serializes capacity runs on the tail promise.
fn reclaim<'a>(env: &'a Env, facade: &Rc<FacadeState>, options: L<'a>) -> Result<L<'a>> {
    let a = L::new(env, ().into_unknown(env)?);
    let state = facade.state(env)?;
    // Every destructured property is read before the `!dirId` check, exactly
    // like the legacy parameter binding.
    // "{ dirId, ... }" destructures a default-less first key, so a null
    // argument raises V8's destructure message instead of the property-read one.
    if options.kind()? == sys::ValueType::napi_null {
        return Err(a.type_error(
            "Cannot destructure property 'dirId' of '(intermediate value)(intermediate value)(intermediate value)' as it is null.",
        ));
    }
    let opts = destructure(options, c"dirId")?;
    let pick = |key: &CStr, default: &J| -> Result<L<'a>> {
        match opts {
            Some(o) => {
                let value = o.get(key)?;
                if value.undefined()? {
                    a.from_value(default)
                } else {
                    Ok(value)
                }
            }
            None => a.from_value(default),
        }
    };
    let dir_id = pick(c"dirId", &J::Undefined)?;
    let exclude = pick(c"excludeSessionIds", &J::Array(vec![]))?;
    let count = pick(c"count", &J::Number(1.0))?;
    if !dir_id.truthy()? {
        let out = obj(a)?;
        out.set(c"ok", boolean(a, false)?)?;
        out.set(c"code", text(a, "directory_required")?)?;
        out.set(c"considered", number(a, 0.0)?)?;
        out.set(c"hibernated", number(a, 0.0)?)?;
        return global_resolve(a, out);
    }
    let limit = number(a, core::capacity_limit(js_number(a, count)?))?;
    let runs = state.get(c"runs")?.number()?;
    state.set(c"runs", number(a, runs + 1.0)?)?;
    let rc_state = obj(a)?;
    rc_state.set(c"dirId", dir_id)?;
    rc_state.set(c"exclude", exclude)?;
    rc_state.set(c"limit", limit)?;
    let rc = ReclaimCtx::new(env, rc_state)?;
    let tail = state.get(c"tail")?;
    let chain = call(tail, c"catch", &[noop_function(env)?])?;
    let chain = call(
        chain,
        c"then",
        &[body_function(env, Rc::clone(facade), Rc::clone(&rc))?],
    )?;
    let run = call(chain, c"finally", &[dec_function(env, Rc::clone(facade))?])?;
    let new_tail = call(run, c"catch", &[noop_function(env)?])?;
    state.set(c"tail", new_tail)?;
    Ok(run)
}

fn candidates_for_method(env: &Env, facade: Rc<FacadeState>) -> Result<L<'_>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "candidatesFor",
        move |cb| {
            let env: &Env = cb.env;
            let options = if cb.length() > 0 {
                L::new(env, cb.get::<Unknown<'_>>(0)?)
            } else {
                L::new(env, ().into_unknown(env)?)
            };
            let value = candidates_for(env, &facade, options)?;
            Ok(value.raw())
        },
    )?;
    arity(
        L::from_raw(env.raw(), function.into_unknown(env)?.raw()),
        0.0,
    )
}
fn pending_capacity_method(env: &Env, facade: Rc<FacadeState>) -> Result<L<'_>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "pendingCapacity",
        move |cb| {
            let env: &Env = cb.env;
            let value = facade.state(env)?.get(c"runs")?;
            Ok(value.raw())
        },
    )?;
    arity(
        L::from_raw(env.raw(), function.into_unknown(env)?.raw()),
        0.0,
    )
}
fn reclaim_method(env: &Env, facade: Rc<FacadeState>) -> Result<L<'_>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "reclaimForCapacity",
        move |cb| {
            let env: &Env = cb.env;
            let options = if cb.length() > 0 {
                L::new(env, cb.get::<Unknown<'_>>(0)?)
            } else {
                L::new(env, ().into_unknown(env)?)
            };
            let value = reclaim(env, &facade, options)?;
            Ok(value.raw())
        },
    )?;
    arity(
        L::from_raw(env.raw(), function.into_unknown(env)?.raw()),
        0.0,
    )
}
fn run_candidates_method(env: &Env, facade: Rc<FacadeState>) -> Result<L<'_>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "runCandidates",
        move |cb| {
            let env: &Env = cb.env;
            let candidates = if cb.length() > 0 {
                L::new(env, cb.get::<Unknown<'_>>(0)?)
            } else {
                L::new(env, ().into_unknown(env)?)
            };
            let options = if cb.length() > 1 {
                L::new(env, cb.get::<Unknown<'_>>(1)?)
            } else {
                L::new(env, ().into_unknown(env)?)
            };
            let value = run_candidates_impl(env, &facade, candidates, options)?;
            Ok(value.raw())
        },
    )?;
    arity(
        L::from_raw(env.raw(), function.into_unknown(env)?.raw()),
        1.0,
    )
}
fn settle_capacity_method(env: &Env, facade: Rc<FacadeState>) -> Result<L<'_>> {
    let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "settleCapacity",
        move |cb| {
            let env: &Env = cb.env;
            let value = facade.state(env)?.get(c"tail")?;
            Ok(value.raw())
        },
    )?;
    arity(
        L::from_raw(env.raw(), function.into_unknown(env)?.raw()),
        0.0,
    )
}

#[napi]
pub fn session_hibernation_reclaimer_create(
    env: Env,
    deps: Unknown<'_>,
) -> Result<sys::napi_value> {
    let a = L::new(&env, ().into_unknown(&env)?);
    let deps = L::new(&env, deps);
    // Parameter destructuring raises before anything else happens; no
    // validation runs on the individual ports, matching the legacy factory.
    match deps.kind()? {
        sys::ValueType::napi_undefined => {
            return Err(a.type_error(
                "Cannot destructure property 'records' of 'undefined' as it is undefined.",
            ));
        }
        sys::ValueType::napi_null => {
            return Err(a.type_error(
                "Cannot destructure property 'records' of 'object null' as it is null.",
            ));
        }
        _ => {}
    }
    let records = deps.get(c"records")?;
    let now = deps.get(c"now")?;
    let idle_ms = deps.get(c"idleMs")?;
    let batch_size = deps.get(c"batchSize")?;
    let eligible = deps.get(c"eligible")?;
    let hibernate = deps.get(c"hibernate")?;
    let publish = deps.get(c"publish")?;
    let is_stopped = deps.get(c"isStopped")?;
    let ports = obj(a)?;
    ports.set(c"records", records)?;
    ports.set(c"now", now)?;
    ports.set(c"idleMs", idle_ms)?;
    ports.set(c"batchSize", batch_size)?;
    ports.set(c"eligible", eligible)?;
    ports.set(c"hibernate", hibernate)?;
    ports.set(c"publish", publish)?;
    ports.set(c"isStopped", is_stopped)?;
    let state = obj(a)?;
    state.set(c"ports", ports)?;
    // `let capacityTail = Promise.resolve();` reads the mutable global.
    state.set(c"tail", global_resolve(a, undefined(a)?)?)?;
    state.set(c"runs", number(a, 0.0)?)?;
    let mut state_ref = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_create_reference(env.raw(), state.raw(), 1, &mut state_ref)
    })?;
    let facade = Rc::new(FacadeState {
        env: env.raw(),
        state: state_ref,
    });
    let out = obj(a)?;
    out.set(
        c"candidatesFor",
        candidates_for_method(&env, Rc::clone(&facade))?,
    )?;
    out.set(
        c"pendingCapacity",
        pending_capacity_method(&env, Rc::clone(&facade))?,
    )?;
    out.set(
        c"reclaimForCapacity",
        reclaim_method(&env, Rc::clone(&facade))?,
    )?;
    out.set(
        c"runCandidates",
        run_candidates_method(&env, Rc::clone(&facade))?,
    )?;
    out.set(
        c"settleCapacity",
        settle_capacity_method(&env, Rc::clone(&facade))?,
    )?;
    out.freeze()?;
    Ok(out.raw())
}
