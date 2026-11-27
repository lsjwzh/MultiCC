//! Per-tracker native buckets. V8 indexes preserve Map key identity and JS
//! property enumeration order. They contain row numbers, never token totals.
//! Host values in metadata and legacy counters are GC-traced via Values.
use crate::js_host_value::{Value, Values};
use crate::js_live::LiveValue as L;
use multicc_core::js::{JsString, JsValue as J};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet, VecDeque},
    ffi::CStr,
    rc::Rc,
};

const FIELDS: [&CStr; 4] = [c"inputTokens", c"outputTokens", c"cacheWrite", c"cacheRead"];
const EVENT_LIMIT: usize = 50_000;

fn object(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Object(vec![]))
}
fn number(a: L<'_>, n: f64) -> Result<L<'_>> {
    a.from_value(&J::Number(n))
}
fn text<'a>(a: L<'a>, s: &str) -> Result<L<'a>> {
    a.from_value(&J::string(s))
}
fn fallback<'a>(value: L<'a>, other: L<'a>) -> Result<L<'a>> {
    Ok(if value.truthy()? { value } else { other })
}
fn zero_bucket() -> J {
    J::Object(
        FIELDS
            .iter()
            .map(|key| {
                (
                    JsString::from_rust_str(key.to_str().expect("static field")),
                    J::Number(0.0),
                )
            })
            .collect(),
    )
}
#[napi]
pub fn empty_role_token_bucket(env: Env) -> Result<sys::napi_value> {
    unsafe { crate::js_bridge::write_value(env.raw(), &zero_bucket()) }
}
#[napi]
pub fn role_bucket_has_usage(env: Env, bucket: Unknown<'_>) -> Result<bool> {
    has_usage(L::new(&env, bucket))
}
#[napi]
pub fn accumulate_role_bucket(
    env: Env,
    bucket: Unknown<'_>,
    usage: Unknown<'_>,
    add: Unknown<'_>,
) -> Result<()> {
    add_fields(L::new(&env, bucket), L::new(&env, usage), L::new(&env, add))
}
fn has_usage(bucket: L<'_>) -> Result<bool> {
    if !bucket.truthy()? {
        return Ok(false);
    }
    for field in FIELDS {
        let value = bucket.get(field)?;
        if value.truthy()? {
            return value.positive();
        }
    }
    Ok(false)
}
// Ordinary counters stay numeric. Preserve JS additive coercion for legacy
// strings and caller-owned objects, including the identity of thrown errors.
fn sum<'a>(a: L<'a>, b: L<'a>, host_add: L<'a>) -> Result<L<'a>> {
    let b = fallback(b, number(b, 0.0)?)?;
    if let (Some(x), Some(y)) = (a.number_value()?, b.number_value()?) {
        number(a, x + y)
    } else {
        host_add.call_plain(&[a, b])
    }
}
fn add_fields(bucket: L<'_>, usage: L<'_>, add: L<'_>) -> Result<()> {
    for f in FIELDS {
        bucket.assign(f, sum(bucket.get(f)?, usage.get(f)?, add)?)?;
    }
    Ok(())
}

struct Bucket {
    counts: RefCell<[Value; 4]>,
}
impl Default for Bucket {
    fn default() -> Self {
        Self {
            counts: RefCell::new(std::array::from_fn(|_| Value::Native(J::Number(0.0)))),
        }
    }
}
impl Bucket {
    fn add(&self, env: &Env, values: &Values, usage: L<'_>, add: L<'_>) -> Result<()> {
        for (i, f) in FIELDS.iter().enumerate() {
            // Read the old counter before entering the getter. A reentrant
            // update has the same assignment order as JavaScript's +=.
            let old = self.counts.borrow()[i].clone();
            let increment = usage.get(f)?;
            if let Value::Native(J::Number(total)) = &old {
                let numeric = if increment.truthy()? {
                    increment.number_value()?
                } else {
                    Some(0.0)
                };
                if let Some(delta) = numeric {
                    self.counts.borrow_mut()[i] = Value::Native(J::Number(total + delta));
                    continue;
                }
            }
            let old = values.read(env, usage, &old)?;
            let next = values.capture(env, sum(old, increment, add)?)?;
            self.counts.borrow_mut()[i] = next;
        }
        Ok(())
    }
    fn copy_into(&self, env: &Env, values: &Values, obj: L<'_>) -> Result<()> {
        for (i, field) in FIELDS.iter().enumerate() {
            let value = self.counts.borrow()[i].clone();
            obj.set(field, values.read(env, obj, &value)?)?;
        }
        Ok(())
    }
}

struct Provider {
    name: RefCell<Value>,
    model: RefCell<Value>,
    bucket: Bucket,
}
struct Role {
    total: Bucket,
    index: Value,
    providers: RefCell<Vec<Rc<Provider>>>,
}
impl Role {
    fn new(env: &Env, values: &Values, anchor: L<'_>) -> Result<Self> {
        let ctor = anchor.global()?.get(c"Object")?;
        let index = ctor
            .get(c"create")?
            .call(ctor, &[anchor.from_value(&J::Null)?])?;
        Ok(Self {
            total: Bucket::default(),
            index: values.capture_host(env, index)?,
            providers: RefCell::default(),
        })
    }
    fn record(
        &self,
        env: &Env,
        values: &Values,
        info: L<'_>,
        usage: L<'_>,
        add: L<'_>,
    ) -> Result<()> {
        self.total.add(env, values, usage, add)?;
        let key = fallback(info.get(c"providerId")?, text(info, "_unknown_")?)?;
        let index = values.read(env, info, &self.index)?;
        let provider = if let Some(pos) = index.get_key(key)?.number_value()? {
            self.providers.borrow()[pos as usize].clone()
        } else {
            let row = Rc::new(Provider {
                name: RefCell::new(
                    values.capture(env, fallback(info.get(c"providerName")?, key)?)?,
                ),
                model: RefCell::new(
                    values.capture(env, fallback(info.get(c"model")?, text(info, "")?)?)?,
                ),
                bucket: Bucket::default(),
            });
            let pos = self.providers.borrow().len();
            self.providers.borrow_mut().push(row.clone());
            index.set_key(key, number(info, pos as f64)?)?;
            row
        };
        provider.bucket.add(env, values, usage, add)?;
        for (key, slot) in [
            (c"providerName", &provider.name),
            (c"model", &provider.model),
        ] {
            if info.get(key)?.truthy()? {
                let value = values.capture(env, info.get(key)?)?;
                slot.replace(value);
            }
        }
        Ok(())
    }
    fn rows<'a>(&self, env: &'a Env, values: &Values, a: L<'a>) -> Result<L<'a>> {
        let index = values.read(env, a, &self.index)?;
        let ctor = a.global()?.get(c"Object")?;
        let keys = ctor.get(c"keys")?.call(ctor, &[index])?;
        let rows = a.from_value(&J::Array(vec![]))?;
        for i in 0..keys.get(c"length")?.number()? as u32 {
            let key = keys.element(i)?;
            let pos = index.get_key(key)?.number()? as usize;
            let provider = self.providers.borrow()[pos].clone();
            let row = object(a)?;
            row.set(c"providerId", key)?;
            row.set(c"name", values.read(env, a, &provider.name.borrow())?)?;
            row.set(c"model", values.read(env, a, &provider.model.borrow())?)?;
            provider.bucket.copy_into(env, values, row)?;
            rows.set_element(i, row)?;
        }
        Ok(rows)
    }
}
struct Turn {
    main: Role,
    sub: Role,
}

#[derive(Default)]
struct Observed {
    ids: HashSet<Rc<JsString>>,
    order: VecDeque<Rc<JsString>>,
}
impl Observed {
    fn remember(&mut self, id: JsString) {
        let key = Rc::new(id);
        if self.ids.insert(key.clone()) {
            self.order.push_back(key);
            if self.order.len() > EVENT_LIMIT {
                self.ids
                    .remove(&self.order.pop_front().expect("non-empty event queue"));
            }
        }
    }
}
#[napi]
pub struct RustRoleTokenTracker {
    native_ledger: bool,
    values: Values,
    sessions: Value,
    next_id: Cell<u64>,
    turns: RefCell<HashMap<u64, Rc<Turn>>>,
    observed: RefCell<Observed>,
}
impl RustRoleTokenTracker {
    pub(crate) fn use_native_ledger(&mut self) {
        self.native_ledger = true;
    }

    fn turn(&self, env: &Env, info: L<'_>) -> Result<Rc<Turn>> {
        let index = self.values.read(env, info, &self.sessions)?;
        let session = info.get(c"sessionId")?;
        if let Some(id) = index.get(c"get")?.call(index, &[session])?.number_value()? {
            return Ok(self.turns.borrow()[&(id as u64)].clone());
        }
        let turn = Rc::new(Turn {
            main: Role::new(env, &self.values, info)?,
            sub: Role::new(env, &self.values, info)?,
        });
        let session = info.get(c"sessionId")?;
        let id = self.next_id.get();
        self.next_id.set(id + 1);
        let previous = index.get(c"get")?.call(index, &[session])?.number_value()?;
        index
            .get(c"set")?
            .call(index, &[session, number(info, id as f64)?])?;
        if let Some(old) = previous {
            self.turns.borrow_mut().remove(&(old as u64));
        }
        self.turns.borrow_mut().insert(id, turn.clone());
        Ok(turn)
    }
}
#[napi]
impl RustRoleTokenTracker {
    #[napi(constructor)]
    pub fn new(env: Env, anchor: Unknown<'_>) -> Result<Self> {
        let a = L::new(&env, anchor);
        let values = Values::new(a)?;
        let sessions = values.capture_host(&env, a.global()?.get(c"Map")?.construct(&[])?)?;
        Ok(Self {
            native_ledger: false,
            values,
            sessions,
            next_id: Cell::new(0),
            turns: RefCell::default(),
            observed: RefCell::default(),
        })
    }
    #[napi]
    pub fn accumulate(&self, env: Env, info: Unknown<'_>) -> Result<bool> {
        self.values.drain(&env)?;
        let info = L::new(&env, info);
        if !info.truthy()?
            || !info.get(c"sessionId")?.truthy()?
            || !info.get(c"usage")?.truthy()?
            || !has_usage(info.get(c"usage")?)?
        {
            return Ok(false);
        }
        let role = if info.get(c"role")?.is_string("sub")? {
            "sub"
        } else if info.get(c"role")?.is_string("aux")? {
            "aux"
        } else {
            "main"
        };
        let usage = info.get(c"usage")?;
        let anchor = self.values.anchor(&env)?;
        if role != "aux" {
            let turn = self.turn(&env, info)?;
            let bucket = if role == "sub" { &turn.sub } else { &turn.main };
            bucket.record(&env, &self.values, info, usage, anchor.get(c"add")?)?;
        }
        if self.native_ledger {
            crate::role_token_runtime::persist(anchor, info, text(info, role)?, usage)?;
        } else {
            anchor
                .get(c"persist")?
                .call_plain(&[info, text(info, role)?, usage])?;
        }
        Ok(true)
    }
    #[napi]
    pub fn snapshot(&self, env: Env, session: Unknown<'_>) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let a = L::new(&env, session);
        let index = self.values.read(&env, a, &self.sessions)?;
        let Some(id) = index.get(c"get")?.call(index, &[a])?.number_value()? else {
            return Ok(a.from_value(&J::Null)?.raw());
        };
        let turn = self.turns.borrow()[&(id as u64)].clone();
        let sub = object(a)?;
        turn.sub.total.copy_into(&env, &self.values, sub)?;
        let has_sub = has_usage(sub)?;
        let out = object(a)?;
        let main = object(a)?;
        turn.main.total.copy_into(&env, &self.values, main)?;
        out.set(c"main", main)?;
        out.set(c"mainByProvider", turn.main.rows(&env, &self.values, a)?)?;
        out.set(
            c"sub",
            if has_sub {
                sub
            } else {
                a.from_value(&J::Null)?
            },
        )?;
        out.set(
            c"subByProvider",
            if has_sub {
                turn.sub.rows(&env, &self.values, a)?
            } else {
                a.from_value(&J::Array(vec![]))?
            },
        )?;
        Ok(out.raw())
    }
    #[napi]
    pub fn reset(&self, env: Env, session: Unknown<'_>) -> Result<()> {
        let a = L::new(&env, session);
        let index = self.values.read(&env, a, &self.sessions)?;
        if let Some(id) = index.get(c"get")?.call(index, &[a])?.number_value()? {
            index.get(c"delete")?.call(index, &[a])?;
            self.turns.borrow_mut().remove(&(id as u64));
        }
        self.values.drain(&env)
    }
    #[napi]
    pub fn seen(&self, env: Env, id: Unknown<'_>) -> Result<bool> {
        let id = L::new(&env, id)
            .string()?
            .ok_or_else(|| napi::Error::from_reason("expected event ID"))?;
        Ok(self.observed.borrow().ids.contains(&id))
    }
    #[napi]
    pub fn remember(&self, env: Env, id: Unknown<'_>) -> Result<()> {
        let id = L::new(&env, id)
            .string()?
            .ok_or_else(|| napi::Error::from_reason("expected event ID"))?;
        self.observed.borrow_mut().remember(id);
        Ok(())
    }
}

fn own_value<'a>(parent: L<'a>, key: L<'a>) -> Result<L<'a>> {
    // Ledger rows came from JSON.parse. Looking up the own descriptor accesses
    // a caller-owned property key exactly once, including its JS coercion.
    let object = parent.global()?.get(c"Object")?;
    let desc = object
        .get(c"getOwnPropertyDescriptor")?
        .call(object, &[parent, key])?;
    desc.optional(c"value")
}
// Host provider keys go through ToPropertyKey (numbers, objects and symbols).
fn define_entry(parent: L<'_>, key: L<'_>, value: L<'_>) -> Result<()> {
    let ctor = parent.global()?.get(c"Object")?;
    let desc = object(parent)?;
    let yes = parent.from_value(&J::Bool(true))?;
    desc.set(c"value", value)?;
    for flag in [c"configurable", c"enumerable", c"writable"] {
        desc.set(flag, yes)?;
    }
    ctor.get(c"defineProperty")?
        .call(ctor, &[parent, key, desc])?;
    Ok(())
}
fn group<'a>(parent: L<'a>, key: L<'a>) -> Result<L<'a>> {
    let old = own_value(parent, key)?;
    if old.truthy()? {
        return Ok(old);
    }
    let next = object(parent)?;
    parent.define_key(key, next)?;
    Ok(next)
}

#[napi]
pub fn role_ledger_update(
    env: Env,
    ledger: Unknown<'_>,
    day: Unknown<'_>,
    role: Unknown<'_>,
    info: Unknown<'_>,
    usage: Unknown<'_>,
    add: Unknown<'_>,
) -> Result<()> {
    let ledger = L::new(&env, ledger);
    let info = L::new(&env, info);
    let add = L::new(&env, add);
    let by_role = group(ledger, L::new(&env, day))?;
    let by_provider = group(by_role, L::new(&env, role))?;
    let key = fallback(info.get(c"providerId")?, text(info, "_default_")?)?;
    let mut provider = own_value(by_provider, key)?;
    if !provider.truthy()? {
        provider = object(info)?;
        let mut name = info.get(c"providerName")?;
        if !name.truthy()? {
            name = fallback(info.get(c"providerId")?, text(info, "")?)?;
        }
        provider.set(c"name", name)?;
        for field in FIELDS {
            provider.set(field, number(info, 0.0)?)?;
        }
        provider.set(c"turns", number(info, 0.0)?)?;
        define_entry(by_provider, key, provider)?;
    }
    add_fields(provider, L::new(&env, usage), add)?;
    provider.assign(
        c"turns",
        sum(provider.get(c"turns")?, number(info, 1.0)?, add)?,
    )?;
    if info.get(c"providerName")?.truthy()? {
        provider.assign(c"name", info.get(c"providerName")?)?;
    }
    Ok(())
}
