use super::*;
use crate::js_host_value::{Value, Values};

fn primitive(v: L<'_>) -> Result<L<'_>> {
    if matches!(
        v.kind()?,
        sys::ValueType::napi_object | sys::ValueType::napi_function
    ) {
        v.number_hint_primitive()
    } else {
        Ok(v)
    }
}

fn clock_value(v: L<'_>) -> Result<V> {
    let v = primitive(v)?;
    Ok(match v.string()? {
        Some(s) => V::String(s),
        None => V::Number(v.number()?),
    })
}

pub(super) fn echo<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let clock = function(ports, "now", 0, 0, |p, _| date_now(p))?;
    let p = defaults(
        opts,
        ports,
        &[(c"ttlMs", Some(num(ports, 60000.)?)), (c"now", Some(clock))],
    )?;
    let state = Rc::new(RefCell::new(rules::EchoStore::default()));
    let api = fields(p, &[])?;
    let s = state.clone();
    api.set(
        c"add",
        function(p, "add", 1, 1, move |p, a| {
            let key = rules::hash(&input(a[0], false)?);
            if !key.is_empty() {
                let now = p.get(c"now")?.call_plain(&[])?;
                // JS '+' concatenates if either primitive is a string; expiry is
                // converted only when a later sweep compares it with the clock.
                let ttl = p.get(c"ttlMs")?;
                let n = primitive(now)?;
                let t = primitive(ttl)?;
                let expiry = if n.kind()? == sys::ValueType::napi_string
                    || t.kind()? == sys::ValueType::napi_string
                {
                    V::String(concat(p, &[n, t])?.coerce_string()?)
                } else {
                    V::Number(n.number()? + t.number()?)
                };
                s.borrow_mut().add(key, expiry);
            }
            undef(p)
        })?,
    )?;
    let s = state.clone();
    api.set(
        c"isEcho",
        function(p, "isEcho", 1, 1, move |p, a| {
            let key = rules::hash(&input(a[0], false)?);
            if key.is_empty() {
                return flag(p, true);
            }
            let now = clock_value(p.get(c"now")?.call_plain(&[])?)?;
            let mut s = s.borrow_mut();
            s.sweep(&now);
            flag(p, s.is_echo(&key))
        })?,
    )?;
    let s = state.clone();
    api.set(
        c"_sweep",
        function(p, "_sweep", 0, 1, move |p, a| {
            let time = if a[0].undefined()? {
                date_now(p)?
            } else {
                a[0]
            };
            let time = clock_value(time)?;
            let size = s.borrow_mut().sweep(&time);
            num(p, size as f64)
        })?,
    )?;
    api.set(
        c"_size",
        function(p, "_size", 0, 0, move |p, _| {
            num(p, state.borrow().len() as f64)
        })?,
    )?;
    Ok(api)
}

struct LogState {
    entries: Vec<Value>,
    values: Values,
}

fn snapshot<'a>(p: L<'a>, state: &Rc<RefCell<LogState>>, since: L<'a>) -> Result<L<'a>> {
    let out = array(p)?;
    let filter = since.truthy()?;
    // Entries remain live host objects: mutations via a previous snapshot must
    // be observable to filterSince. No RefCell borrow crosses a host call.
    let entries = state.borrow().entries.clone();
    let mut index = 0;
    let env = crate::host_methods::env(p);
    for entry in &entries {
        let entry = state.borrow().values.read(&env, p, entry)?;
        let include = if filter {
            let ts = call(
                p.global()?.get(c"Date")?.construct(&[entry.get(c"ts")?])?,
                c"getTime",
                &[],
            )?
            .number()?;
            ts > since.number()?
        } else {
            true
        };
        if include {
            out.set_element(index, entry)?;
            index += 1;
        }
    }
    Ok(out)
}

pub(super) fn logs<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = defaults(
        default_object(a[0])?,
        ports,
        &[(c"max", Some(num(ports, 300.)?))],
    )?;
    p.set(c"clients", p.global()?.get(c"Set")?.construct(&[])?)?;
    let state = Rc::new(RefCell::new(LogState {
        entries: Vec::new(),
        values: Values::new(p)?,
    }));
    let api = fields(p, &[])?;
    let s = state.clone();
    api.set(
        c"push",
        function(p, "push", 2, 2, move |p, a| {
            let entry = fields(p, &[("type", a[0]), ("text", a[1]), ("ts", iso_now(p)?)])?;
            let env = crate::host_methods::env(p);
            let value = s.borrow().values.capture_host(&env, entry)?;
            s.borrow_mut().entries.push(value);
            let max = p.get(c"max")?.number()?;
            let length = s.borrow().entries.len();
            if length as f64 > max {
                // Array.slice(-max): max=0 and NaN keep the whole array; negative
                // limits drop a positive prefix, and fractional limits truncate.
                let start = if max.is_nan() || max == 0. {
                    0
                } else if max > 0. {
                    length.saturating_sub(max as usize)
                } else {
                    (-max) as usize
                };
                s.borrow_mut().entries.drain(..start.min(length));
            }
            s.borrow().values.drain(&env)?;
            let json = json_call(p, c"stringify", entry)?;
            let data = concat(p, &[text(p, "data: ")?, json, text(p, "\n\n")?])?;
            let clients = p.get(c"clients")?;
            clients.for_each(|res| {
                if p.catch(|| call(res, c"write", &[data]))?.is_none() {
                    call(clients, c"delete", &[res])?;
                }
                Ok(())
            })?;
            undef(p)
        })?,
    )?;
    let s = state.clone();
    api.set(
        c"snapshot",
        function(p, "snapshot", 0, 0, move |p, _| snapshot(p, &s, undef(p)?))?,
    )?;
    let s = state.clone();
    api.set(
        c"filterSince",
        function(p, "filterSince", 1, 1, move |p, a| snapshot(p, &s, a[0]))?,
    )?;
    for (key, method) in [(c"addClient", c"add"), (c"removeClient", c"delete")] {
        api.set(
            key,
            function(p, key.to_str().unwrap(), 1, 1, move |p, a| {
                call(p.get(c"clients")?, method, &[a[0]])?;
                undef(p)
            })?,
        )?;
    }
    api.set(
        c"_size",
        function(p, "_size", 0, 0, move |p, _| {
            num(p, state.borrow().entries.len() as f64)
        })?,
    )?;
    Ok(api)
}
