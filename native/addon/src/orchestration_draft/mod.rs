//! Transaction-local V8 draft. Its maps retain live keys and raw object aliases
//! until completion. The storage owner supplies the base snapshot and lazy reads.
use crate::host_api::*;
use napi_derive::napi;
use std::ffi::CStr;

mod finish;
mod proxies;

const COLLECTIONS: [&str; 5] = ["waits", "outbox", "operations", "tasks", "sessionSchedules"];

fn map(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"Map")?.construct(&[])
}
fn record_maps(p: L<'_>) -> Result<L<'_>> {
    let result = fields(p, &[])?;
    for name in COLLECTIONS {
        result.define_key(text(p, name)?, map(p)?)?;
    }
    Ok(result)
}
fn active(p: L<'_>) -> Result<()> {
    if p.get(c"active")?.truthy()? {
        Ok(())
    } else {
        Err(p.type_error("orchestration draft is no longer active"))
    }
}
fn collection(key: L<'_>) -> Result<bool> {
    for name in COLLECTIONS {
        if key.is_string(name)? {
            return Ok(true);
        }
    }
    Ok(false)
}
fn reserved(key: L<'_>) -> Result<bool> {
    Ok(collection(key)?
        || key.is_string("schemaVersion")?
        || key.is_string("revision")?
        || key.is_string("updatedAt")?
        || key.is_string("nextOutboxSequence")?)
}
fn object_call<'a>(p: L<'a>, op: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(p.global()?.get(c"Object")?, op, args)
}
fn reflect<'a>(p: L<'a>, op: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(p.global()?.get(c"Reflect")?, op, args)
}
fn has(table: L<'_>, key: L<'_>) -> Result<bool> {
    call(table, c"has", &[key])?.truthy()
}
fn entry<'a>(p: L<'a>, value: Option<L<'a>>) -> Result<L<'a>> {
    let e = fields(p, &[("deleted", flag(p, value.is_none())?)])?;
    if let Some(v) = value {
        e.set(c"value", v)?;
    }
    Ok(e)
}
fn contents(e: L<'_>) -> Result<L<'_>> {
    if e.get(c"deleted")?.truthy()? {
        undef(e)
    } else {
        e.get(c"value")
    }
}
fn changes<'a>(p: L<'a>, col: L<'a>) -> Result<L<'a>> {
    if col.is_string("extras")? {
        p.get(c"extras")
    } else {
        p.get(c"records")?.get_key(col)
    }
}
fn base_collection<'a>(p: L<'a>, col: L<'a>) -> Result<L<'a>> {
    let base = p.get(c"base")?;
    if col.is_string("extras")? {
        Ok(base)
    } else {
        base.get_key(col)
    }
}
fn current<'a>(p: L<'a>, col: L<'a>, key: L<'a>) -> Result<L<'a>> {
    active(p)?;
    let e = call(changes(p, col)?, c"get", &[key])?;
    if e.truthy()? {
        contents(e)
    } else {
        base_collection(p, col)?.get_key(key)
    }
}
fn writable<'a>(p: L<'a>, col: L<'a>, key: L<'a>) -> Result<L<'a>> {
    active(p)?;
    let table = changes(p, col)?;
    let existing = call(table, c"get", &[key])?;
    if existing.truthy()? && !existing.get(c"deleted")?.truthy()? {
        return existing.get(c"value");
    }
    if existing.truthy()? || !object(base_collection(p, col)?.get_key(key)?)? {
        let id = key.coerce_string()?.to_string_lossy();
        let msg = if col.is_string("extras")? {
            format!("cannot mutate missing orchestration extra {id}")
        } else {
            format!(
                "cannot mutate missing {} record {id}",
                col.coerce_string()?.to_string_lossy()
            )
        };
        return Err(p.type_error(&msg));
    }
    let value = call(p.get(c"native")?, c"materialize", &[col, key])?;
    call(table, c"set", &[key, entry(p, Some(value))?])?;
    Ok(value)
}
fn top<'a>(p: L<'a>, key: L<'a>) -> Result<L<'a>> {
    active(p)?;
    for table in [p.get(c"top")?, p.get(c"extras")?] {
        let e = call(table, c"get", &[key])?;
        if e.truthy()? {
            return contents(e);
        }
    }
    p.get(c"base")?.get_key(key)
}
fn assigned<'a>(p: L<'a>, value: L<'a>) -> Result<L<'a>> {
    if object(value)? && finish::contains(p, value, false, None)? {
        p.get(c"ports")?.get(c"_cloneJson")?.call_plain(&[value])
    } else {
        Ok(value)
    }
}
fn query<'a>(p: L<'a>, col: L<'a>, opts: L<'a>, op: &str) -> Result<L<'a>> {
    let pairs = array(p)?;
    changes(p, col)?.for_each(|pair| {
        let item = fields(p, &[("key", pair.element(0)?)])?;
        item.spread_from(pair.element(1)?)?;
        call(pairs, c"push", &[item])?;
        Ok(())
    })?;
    call(
        p.get(c"native")?,
        c"query",
        &[text(p, op)?, col, opts, pairs],
    )
}
fn select<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    active(p)?;
    let col = a[0];
    let opts = default_object(a[1])?;
    if opts.get(c"fields")?.truthy()? {
        return query(p, col, opts, "select");
    }
    let keys = query(p, col, opts, "selectKeys")?;
    let scope = fields(p, &[("owner", p), ("collection", col)])?;
    call(
        keys,
        c"map",
        &[function(scope, "", 1, 1, |s, a| {
            proxies::group(s.get(c"owner")?, s.get(c"collection")?)?.get_key(a[0])
        })?],
    )
}
fn count<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    active(p)?;
    query(
        p,
        a[0],
        fields(p, &[("where", default_object(a[1])?)])?,
        "count",
    )
}
fn claim_select<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    active(p)?;
    let meta = p.get(c"native")?.get(c"claimMetadata")?;
    if !meta.truthy()? {
        return null(p);
    }
    let keys = meta.get(if a[0].truthy()? {
        c"leasedKeys"
    } else {
        c"keys"
    })?;
    let result = array(p)?;
    for i in 0..keys.get(c"length")?.number()? as u32 {
        let v = proxies::group(p, text(p, "outbox")?)?.get_key(keys.element(i)?)?;
        result.set_element(i, v)?;
    }
    Ok(result)
}
fn revoke<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    p.set(c"active", flag(p, false)?)?;
    for col in COLLECTIONS {
        call(changes(p, text(p, col)?)?, c"clear", &[])?;
    }
    for key in [c"extras", c"top", c"groups", c"paths", c"extraPaths"] {
        call(p.get(key)?, c"clear", &[])?;
    }
    undef(p)
}
fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = fields(
        ports,
        &[
            ("ports", ports),
            ("base", a[0]),
            ("native", a[1]),
            ("active", flag(ports, true)?),
            ("records", record_maps(ports)?),
            ("owned", ports.global()?.get(c"WeakSet")?.construct(&[])?),
        ],
    )?;
    for key in [c"extras", c"top", c"groups", c"paths", c"extraPaths"] {
        p.set(key, map(p)?)?;
    }
    let methods = defaulted_methods(
        p,
        &[
            ("claimSelect", 1, 1, claim_select),
            ("select", 1, 2, select),
            ("count", 1, 2, count),
        ],
    )?;
    p.set(c"methods", methods)?;
    let draft = proxies::root(p)?;
    p.set(c"draft", draft)?;
    fields(
        p,
        &[
            ("draft", draft),
            ("finish", function(p, "finish", 1, 1, finish::finish)?),
            (
                "containsOwnedProxy",
                function(p, "containsOwnedProxy", 1, 2, |p, a| {
                    flag(p, finish::contains(p, a[0], false, Some(a[1]))?)
                })?,
            ),
            (
                "containsOwnedProxySafely",
                function(p, "containsOwnedProxySafely", 1, 2, |p, a| {
                    flag(p, finish::contains(p, a[0], true, Some(a[1]))?)
                })?,
            ),
            ("revoke", function(p, "revoke", 0, 0, revoke)?),
        ],
    )
}
#[napi]
pub fn orchestration_draft_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let keys = array(p)?;
    for (i, k) in COLLECTIONS.iter().enumerate() {
        keys.set_element(i as u32, text(p, k)?)?;
    }
    Ok(fields(
        p,
        &[
            ("createDraft", function(p, "createDraft", 2, 2, create)?),
            ("COLLECTIONS", keys.freeze()?),
        ],
    )?
    .raw())
}
