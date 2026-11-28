//! Proxy traps resolve the current row for every operation. Detached child
//! proxies therefore keep observing replacements made earlier in the transaction.
use super::*;
use multicc_core::js::JsString;

fn proxy<'a>(
    p: L<'a>,
    scope: L<'a>,
    target: L<'a>,
    traps: &[(&'static str, usize, Action)],
) -> Result<L<'a>> {
    let handler = methods(scope, traps)?;
    let value = p.global()?.get(c"Proxy")?.construct(&[target, handler])?;
    call(p.get(c"owned")?, c"add", &[value])?;
    Ok(value)
}
fn descriptor(p: L<'_>) -> Result<L<'_>> {
    let yes = flag(p, true)?;
    fields(
        p,
        &[
            ("configurable", yes),
            ("enumerable", yes),
            ("writable", yes),
            ("value", undef(p)?),
        ],
    )
}
fn keys<'a>(p: L<'a>, initial: L<'a>, updates: L<'a>) -> Result<L<'a>> {
    let set = p.global()?.get(c"Set")?.construct(&[initial])?;
    updates.for_each(|pair| {
        let op = if pair.element(1)?.get(c"deleted")?.truthy()? {
            c"delete"
        } else {
            c"add"
        };
        call(set, op, &[pair.element(0)?])?;
        Ok(())
    })?;
    call(p.global()?.get(c"Array")?, c"from", &[set])
}
pub(super) fn root(p: L<'_>) -> Result<L<'_>> {
    proxy(
        p,
        p,
        fields(p, &[])?,
        &[
            ("get", 2, |p, a| {
                active(p)?;
                let k = a[1];
                let methods = p.get(c"methods")?;
                if object_call(p, c"hasOwn", &[methods, k])?.truthy()? {
                    return methods.get_key(k);
                }
                if collection(k)? {
                    return group(p, k);
                }
                let value = top(p, k)?;
                let key = string(k)?;
                if !reserved(key)? && object(value)? {
                    path_proxy(p, text(p, "extras")?, key, array(p)?)
                } else {
                    Ok(value)
                }
            }),
            ("set", 3, |p, a| {
                active(p)?;
                let k = string(a[1])?;
                if collection(k)? {
                    return Err(p.type_error(&format!(
                        "cannot replace orchestration collection {}",
                        k.coerce_string()?.to_string_lossy()
                    )));
                }
                let table = p.get(if reserved(k)? { c"top" } else { c"extras" })?;
                call(table, c"set", &[k, entry(p, Some(assigned(p, a[2])?))?])?;
                flag(p, true)
            }),
            ("deleteProperty", 2, |p, a| {
                active(p)?;
                let k = string(a[1])?;
                if reserved(k)? {
                    return Err(p.type_error(&format!(
                        "cannot delete orchestration field {}",
                        k.coerce_string()?.to_string_lossy()
                    )));
                }
                call(p.get(c"extras")?, c"set", &[k, entry(p, None)?])?;
                flag(p, true)
            }),
            ("has", 2, |p, a| {
                flag(p, collection(a[1])? || !top(p, a[1])?.undefined()?)
            }),
            ("ownKeys", 0, |p, _| {
                keys(
                    p,
                    reflect(p, c"ownKeys", &[p.get(c"base")?])?,
                    p.get(c"extras")?,
                )
            }),
            ("getOwnPropertyDescriptor", 2, |p, a| {
                if reflect(p, c"has", &[p.get(c"draft")?, a[1]])?.truthy()? {
                    descriptor(p)
                } else {
                    undef(p)
                }
            }),
        ],
    )
}
pub(super) fn group<'a>(p: L<'a>, col: L<'a>) -> Result<L<'a>> {
    let cache = p.get(c"groups")?;
    if has(cache, col)? {
        return call(cache, c"get", &[col]);
    }
    let scope = fields(p, &[("p", p), ("col", col)])?;
    let v = proxy(
        p,
        scope,
        fields(p, &[])?,
        &[
            ("get", 2, |s, a| {
                let p = s.get(c"p")?;
                let col = s.get(c"col")?;
                let k = a[1];
                if k.kind()? == sys::ValueType::napi_symbol {
                    return base_collection(p, col)?.get_key(k);
                }
                let key = string(k)?;
                let v = current(p, col, key)?;
                if object(v)? {
                    path_proxy(p, col, key, array(p)?)
                } else {
                    Ok(v)
                }
            }),
            ("set", 3, |s, a| {
                let p = s.get(c"p")?;
                active(p)?;
                let table = changes(p, s.get(c"col")?)?;
                let key = string(a[1])?;
                call(table, c"set", &[key, entry(p, Some(assigned(p, a[2])?))?])?;
                flag(p, true)
            }),
            ("deleteProperty", 2, |s, a| {
                let p = s.get(c"p")?;
                active(p)?;
                let table = changes(p, s.get(c"col")?)?;
                call(table, c"set", &[string(a[1])?, entry(p, None)?])?;
                flag(p, true)
            }),
            ("has", 2, |s, a| {
                flag(
                    s,
                    !current(s.get(c"p")?, s.get(c"col")?, string(a[1])?)?.undefined()?,
                )
            }),
            ("ownKeys", 0, |s, _| {
                let p = s.get(c"p")?;
                let col = s.get(c"col")?;
                keys(
                    p,
                    object_call(p, c"keys", &[base_collection(p, col)?])?,
                    changes(p, col)?,
                )
            }),
            ("getOwnPropertyDescriptor", 2, |s, a| {
                let v = current(s.get(c"p")?, s.get(c"col")?, string(a[1])?)?;
                if v.undefined()? {
                    undef(s)
                } else {
                    descriptor(s)
                }
            }),
        ],
    )?;
    call(cache, c"set", &[col, v])?;
    Ok(v)
}
fn at(s: L<'_>, write: bool) -> Result<L<'_>> {
    let p = s.get(c"p")?;
    let col = s.get(c"col")?;
    let k = s.get(c"key")?;
    let mut value = if write {
        writable(p, col, k)?
    } else {
        current(p, col, k)?
    };
    s.get(c"path")?.for_each_while(|part| {
        if !object(value)? {
            value = undef(p)?;
            return Ok(false);
        }
        value = value.get_key(part)?;
        Ok(true)
    })?;
    Ok(value)
}
fn path_proxy<'a>(p: L<'a>, col: L<'a>, key: L<'a>, path: L<'a>) -> Result<L<'a>> {
    let extra = col.is_string("extras")?;
    let cache = p.get(if extra { c"extraPaths" } else { c"paths" })?;
    let mut units = Vec::new();
    if !extra {
        units.extend_from_slice(col.coerce_string()?.as_units());
        units.push(0);
    }
    units.extend_from_slice(key.coerce_string()?.as_units());
    units.push(0);
    let strings = call(path, c"map", &[p.global()?.get(c"String")?])?;
    let joined = call(strings, c"join", &[text(p, "\0")?])?;
    units.extend_from_slice(joined.coerce_string()?.as_units());
    let cache_key = p.from_value(&V::String(JsString::from_units(units)))?;
    if has(cache, cache_key)? {
        return call(cache, c"get", &[cache_key]);
    }
    let s = fields(p, &[("p", p), ("col", col), ("key", key), ("path", path)])?;
    let initial = at(s, false)?;
    let target = if initial.is_array()? {
        p.global()?
            .get(c"Array")?
            .construct(&[initial.get(c"length")?])?
    } else {
        fields(p, &[])?
    };
    let v = proxy(
        p,
        s,
        target,
        &[
            ("get", 3, |s, a| {
                let current = at(s, false)?;
                if !object(current)? {
                    return undef(s);
                }
                let value = reflect(s, c"get", &[current, a[1], a[2]])?;
                if !object(value)? {
                    return Ok(value);
                }
                let path = call(s.get(c"path")?, c"slice", &[])?;
                call(path, c"push", &[a[1]])?;
                path_proxy(s.get(c"p")?, s.get(c"col")?, s.get(c"key")?, path)
            }),
            ("set", 3, |s, a| {
                let v = at(s, true)?;
                if !object(v)? {
                    return flag(s, false);
                }
                let result = reflect(s, c"set", &[v, a[1], assigned(s.get(c"p")?, a[2])?])?;
                if result.truthy()? && a[0].is_array()? {
                    a[0].assign(c"length", v.get(c"length")?)?;
                }
                Ok(result)
            }),
            ("deleteProperty", 2, |s, a| {
                let v = at(s, true)?;
                if object(v)? {
                    reflect(s, c"deleteProperty", &[v, a[1]])
                } else {
                    flag(s, true)
                }
            }),
            ("has", 2, |s, a| {
                let v = at(s, false)?;
                if object(v)? {
                    reflect(s, c"has", &[v, a[1]])
                } else {
                    flag(s, false)
                }
            }),
            ("ownKeys", 0, |s, _| {
                let v = at(s, false)?;
                if object(v)? {
                    reflect(s, c"ownKeys", &[v])
                } else {
                    array(s)
                }
            }),
            ("getOwnPropertyDescriptor", 2, |s, a| {
                let v = at(s, false)?;
                if !object(v)? {
                    return undef(s);
                }
                let d = object_call(s, c"getOwnPropertyDescriptor", &[v, a[1]])?;
                if !d.truthy()? {
                    return undef(s);
                }
                if a[0].is_array()? && a[1].is_string("length")? {
                    a[0].assign(c"length", v.get(c"length")?)?;
                    return object_call(s, c"getOwnPropertyDescriptor", &[a[0], a[1]]);
                }
                let result = spread(d)?;
                result.set(c"configurable", flag(s, true)?)?;
                Ok(result)
            }),
            ("getPrototypeOf", 0, |s, _| {
                let v = at(s, false)?;
                if object(v)? {
                    reflect(s, c"getPrototypeOf", &[v])
                } else {
                    s.global()?.get(c"Object")?.get(c"prototype")
                }
            }),
        ],
    )?;
    call(cache, c"set", &[cache_key, v])?;
    Ok(v)
}
