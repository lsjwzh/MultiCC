//! The compatibility host's live vault. Rust owns the ordered store; opaque V8
//! handles preserve the documented reveal/entry identity. Only audit and the
//! established durable writer cross the host boundary.
use crate::{
    host_api::*,
    js_host_value::{Value as HostValue, Values},
};
use multicc_core::{js::JsString, vault_store as model};
use napi::bindgen_prelude::{External, FromNapiRef, ToNapiValue};
use napi_derive::napi;
use std::cell::RefCell;

struct Owner {
    entries: RefCell<model::Store<HostValue>>,
    values: Values,
}
fn owner<'a>(p: L<'a>) -> Result<&'a Owner> {
    let value = p.get(c"owner")?;
    Ok(unsafe { External::<Owner>::from_napi_ref(p.env(), value.raw())? })
}
fn entries(p: L<'_>) -> Result<Vec<(JsString, HostValue)>> {
    owner(p)?.values.drain(&crate::host_methods::env(p))?;
    Ok(owner(p)?.entries.borrow().entries())
}
fn entry<'a>(p: L<'a>, name: &JsString) -> Result<Option<L<'a>>> {
    let value = owner(p)?.entries.borrow().get(name);
    value
        .map(|v| {
            owner(p)?
                .values
                .read(&crate::host_methods::env(p), p, &v)
                .map(|v| L::from_raw(p.env(), v.raw()))
        })
        .transpose()
}
fn insert(p: L<'_>, name: JsString, value: L<'_>) -> Result<()> {
    owner(p)?.values.drain(&crate::host_methods::env(p))?;
    let v = owner(p)?
        .values
        .capture(&crate::host_methods::env(p), value)?;
    owner(p)?.entries.borrow_mut().insert(name, v);
    Ok(())
}
fn matches(p: L<'_>, key: &std::ffi::CStr, name: L<'_>) -> Result<bool> {
    call(p.get(key)?, c"test", &[name])?.truthy()
}
fn clean(p: L<'_>, v: L<'_>, strict: bool) -> Result<Option<JsString>> {
    if v.kind()? != sys::ValueType::napi_string {
        return Ok(None);
    }
    let n = v.string()?.expect("string").trim();
    let value = p.from_value(&V::String(n.clone()))?;
    Ok(matches(
        p,
        if strict {
            c"NAME_RE"
        } else {
            c"LEGACY_NAME_RE"
        },
        value,
    )?
    .then_some(n))
}
fn failure<'a>(p: L<'a>, message: &str, status: f64) -> Result<L<'a>> {
    fields(
        p,
        &[("error", text(p, message)?), ("status", num(p, status)?)],
    )
}
fn value_or<'a>(v: L<'a>, default: L<'a>) -> Result<L<'a>> {
    Ok(if v.truthy()? { v } else { default })
}
fn cut<'a>(v: L<'a>, max: usize, trim: bool) -> Result<L<'a>> {
    let s = v.string()?.expect("validated string");
    let s = if trim { s.trim() } else { s };
    v.from_value(&V::String(s.truncate_units(max)))
}
fn meta(v: L<'_>) -> Result<L<'_>> {
    let out = fields(
        v,
        &[
            ("name", v.get(c"name")?),
            ("description", fallback(v.get(c"description")?, "".into())?),
            ("source", fallback(v.get(c"source")?, "user".into())?),
            ("createdAt", fallback(v.get(c"createdAt")?, V::Null)?),
            ("updatedAt", fallback(v.get(c"updatedAt")?, V::Null)?),
        ],
    )?;
    if v.get(c"updatedBy")?.truthy()? {
        out.set(c"updatedBy", v.get(c"updatedBy")?)?;
    }
    Ok(out)
}
fn values(p: L<'_>) -> Result<L<'_>> {
    let out = array(p)?;
    for (i, (_, value)) in entries(p)?.iter().enumerate() {
        let env = crate::host_methods::env(p);
        let value = owner(p)?.values.read(&env, p, value)?;
        out.set_element(i as u32, value)?;
    }
    Ok(out)
}
fn save(p: L<'_>) -> Result<L<'_>> {
    p.get(c"write")?
        .call_plain(&[p.get(c"STORE")?, values(p)?])?;
    undef(p)
}
fn load(p: L<'_>) -> Result<L<'_>> {
    owner(p)?.entries.borrow_mut().clear();
    owner(p)?.values.drain(&crate::host_methods::env(p))?;
    p.catch(|| -> Result<()> {
        let file = p.get(c"STORE")?.coerce_string()?.to_string_lossy();
        let bytes = std::fs::read(file).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let raw = json_call(p, c"parse", text(p, &String::from_utf8_lossy(&bytes))?)?;
        if !raw.is_array()? {
            return Ok(());
        }
        raw.for_each(|item| {
            if !item.truthy()? || !object(item)? {
                return Ok(());
            }
            let name = string(fallback(item.get(c"name")?, "".into())?)?;
            if !matches(p, c"LEGACY_NAME_RE", name)?
                || item.get(c"value")?.kind()? != sys::ValueType::napi_string
            {
                return Ok(());
            }
            let description = item.get(c"description")?;
            let source = item.get(c"source")?;
            let row = fields(
                p,
                &[
                    ("name", name),
                    ("value", item.get(c"value")?),
                    (
                        "description",
                        if description.kind()? == sys::ValueType::napi_string {
                            cut(description, 500, false)?
                        } else {
                            text(p, "")?
                        },
                    ),
                    (
                        "source",
                        if source.kind()? == sys::ValueType::napi_string {
                            cut(source, 64, false)?
                        } else {
                            text(p, "user")?
                        },
                    ),
                    ("createdAt", fallback(item.get(c"createdAt")?, V::Null)?),
                    ("updatedAt", fallback(item.get(c"updatedAt")?, V::Null)?),
                ],
            )?;
            let by = item.get(c"updatedBy")?;
            if by.kind()? == sys::ValueType::napi_string {
                row.set(c"updatedBy", cut(by, 128, false)?)?;
            }
            insert(p, name.string()?.expect("String"), row)
        })
    })?;
    undef(p)
}
fn date(p: L<'_>) -> Result<L<'_>> {
    call(
        p.global()?.get(c"Date")?.construct(&[])?,
        c"toISOString",
        &[],
    )
}
fn upsert<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let input = default_object(input)?;
    // Destructuring happens before validation, including throwing accessors.
    let (name, value, description, source, session) = (
        input.get(c"name")?,
        input.get(c"value")?,
        input.get(c"description")?,
        input.get(c"source")?,
        input.get(c"sessionId")?,
    );
    let Some(name) = clean(p, name, true)? else {
        return failure(p, model::NAME_RULE, 400.);
    };
    if value.kind()? != sys::ValueType::napi_string
        || !value.truthy()?
        || value.string()?.expect("string").len() > model::MAX_VALUE
    {
        return failure(
            p,
            "value is required and cannot exceed 65536 characters",
            400.,
        );
    }
    let at = date(p)?;
    let old = entry(p, &name)?;
    if old.is_none() && owner(p)?.entries.borrow().len() >= model::MAX_ENTRIES {
        return failure(p, "vault is full", 409.);
    }
    let desc = if description.kind()? == sys::ValueType::napi_string {
        cut(description, 500, true)?
    } else if let Some(old) = old {
        fallback(old.get(c"description")?, "".into())?
    } else {
        text(p, "")?
    };
    let source =
        if source.kind()? == sys::ValueType::napi_string && call(source, c"trim", &[])?.truthy()? {
            call(source, c"trim", &[])?
        } else {
            text(p, "user")?
        };
    let created = match old {
        Some(old) => value_or(old.get(c"createdAt")?, at)?,
        None => at,
    };
    let row = fields(
        p,
        &[
            ("name", p.from_value(&V::String(name.clone()))?),
            ("value", value),
            ("description", desc),
            ("source", cut(source, 64, false)?),
            ("createdAt", created),
            ("updatedAt", at),
        ],
    )?;
    if session.truthy()? {
        row.set(c"updatedBy", cut(string(session)?, 128, false)?)?;
    }
    insert(p, name, row)?; // Legacy ordering: no rollback after a failed write.
    save(p)?;
    fields(p, &[("entry", row), ("created", flag(p, old.is_none())?)])
}
fn mutate<'a>(p: L<'a>, op: &str, args: L<'a>) -> Result<L<'a>> {
    let from = args.element(0)?;
    let Some(name) = clean(p, from, false)? else {
        return failure(p, "entry not found", 404.);
    };
    let Some(row) = entry(p, &name)? else {
        return failure(p, "entry not found", 404.);
    };
    match op {
        "reveal" => fields(p, &[("entry", row)]),
        "remove" => {
            owner(p)?.entries.borrow_mut().remove(&name);
            save(p)?;
            fields(p, &[("ok", flag(p, true)?)])
        }
        _ => {
            let Some(to) = clean(p, args.element(1)?, true)? else {
                return failure(p, model::NAME_RULE, 400.);
            };
            if to == name {
                return fields(p, &[("entry", row), ("unchanged", flag(p, true)?)]);
            }
            if entry(p, &to)?.is_some() {
                return failure(p, "target name already exists", 409.);
            }
            let next = spread(row)?;
            next.set(c"name", p.from_value(&V::String(to.clone()))?)?;
            next.set(c"updatedAt", date(p)?)?;
            owner(p)?.entries.borrow_mut().remove(&name);
            insert(p, to, next)?;
            save(p)?;
            fields(p, &[("entry", next)])
        }
    }
}
fn overlay(p: L<'_>) -> Result<L<'_>> {
    let out = fields(p, &[])?;
    let mut cursor = 0;
    loop {
        let next = owner(p)?.entries.borrow().next_after(cursor);
        let Some((serial, name, value)) = next else {
            break;
        };
        cursor = serial;
        let key = p.from_value(&V::String(name.clone()))?;
        if !matches(p, c"ENV_RE", key)? {
            continue;
        }
        let prefix_context = fields(p, &[("name", key)])?;
        let prefix_test = function(prefix_context, "excludedPrefix", 1, 1, |s, a| {
            call(s.get(c"name")?, c"startsWith", &[a[0]])
        })?;
        if call(p.get(c"ENV_EXCLUDED_PREFIXES")?, c"some", &[prefix_test])?.truthy()? {
            continue;
        }
        let env = crate::host_methods::env(p);
        let row = owner(p)?.values.read(&env, p, &value)?;
        out.set_key(key, row.get(c"value")?)?;
    }
    Ok(out)
}
fn keys(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Object")?, c"keys", &[v])
}
fn run<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let p = s.get(c"owner")?;
    let args = s.get(c"args")?;
    let op = s.get(c"op")?.coerce_string()?.to_string_lossy();
    match op.as_str() {
        "list" => {
            let rows = values(p)?;
            let compare = function(p, "compareVaultNames", 2, 2, |_, a| {
                call(a[0].get(c"name")?, c"localeCompare", &[a[1].get(c"name")?])
            })?;
            call(rows, c"sort", &[compare])?;
            let out = array(p)?;
            for i in 0..rows.get(c"length")?.number()? as u32 {
                out.set_element(i, meta(rows.element(i)?)?)?;
            }
            Ok(out)
        }
        "upsert" => upsert(p, args.element(0)?),
        "env_overlay" => overlay(p),
        "env_inject" => {
            let env = s.get(c"env")?;
            let vars = s.get(c"overlay")?;
            s.get(c"names")?
                .for_each(|key| env.set_key(key, vars.get_key(key)?))?;
            Ok(env)
        }
        _ => mutate(p, &op, args),
    }
}
fn audited<'a>(
    p: L<'a>,
    op: &str,
    context: L<'a>,
    names: L<'a>,
    args: L<'a>,
    extra: Option<L<'a>>,
) -> Result<L<'a>> {
    let s = fields(p, &[("owner", p), ("op", text(p, op)?), ("args", args)])?;
    if let Some(extra) = extra {
        s.spread_from(extra)?;
    }
    call(
        p.get(c"audit")?,
        c"call",
        &[
            text(p, op)?,
            context,
            names,
            function(s, "vaultAction", 0, 0, run)?,
        ],
    )
}
fn arg_list<'a>(p: L<'a>, args: &[L<'a>]) -> Result<L<'a>> {
    let a = array(p)?;
    for (i, v) in args.iter().enumerate() {
        a.set_element(i as u32, *v)?;
    }
    Ok(a)
}
#[napi]
pub fn secrets_vault_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let state = Owner {
        entries: RefCell::default(),
        values: Values::new(p)?,
    };
    let external = unsafe { External::to_napi_value(p.env(), External::new(state))? };
    p.set(c"owner", L::from_raw(p.env(), external))?;
    for (key, pattern) in [
        (c"NAME_RE", model::NAME),
        (c"LEGACY_NAME_RE", model::LEGACY_NAME),
        (c"ENV_RE", "^[A-Za-z_][A-Za-z0-9_]*$"),
    ] {
        p.set(
            key,
            p.global()?
                .get(c"RegExp")?
                .construct(&[text(p, pattern)?])?,
        )?;
    }
    p.set(
        c"ENV_EXCLUDED_PREFIXES",
        p.from_value(&V::Array(
            model::EXCLUDED.iter().map(|s| V::from(*s)).collect(),
        ))?,
    )?;
    load(p)?;
    let api = fields(
        p,
        &[
            ("STORE", p.get(c"STORE")?),
            ("NAME_RE", p.get(c"NAME_RE")?),
            ("LEGACY_NAME_RE", p.get(c"LEGACY_NAME_RE")?),
        ],
    )?;
    for (name, op, argc, ctx) in [
        ("list", "list", 1, 0),
        ("upsert", "upsert", 2, 1),
        ("remove", "remove", 2, 1),
        ("rename", "rename", 3, 2),
        ("reveal", "reveal", 2, 1),
    ] {
        api.define_key(
            text(p, name)?,
            function(p, name, argc, argc, move |p, a| {
                let names = match op {
                    "list" => array(p)?,
                    "upsert" => arg_list(p, &[a[0].optional(c"name")?])?,
                    "rename" => arg_list(p, &[a[0], a[1]])?,
                    _ => arg_list(p, &[a[0]])?,
                };
                audited(p, op, a[ctx], names, arg_list(p, a)?, None)
            })?,
        )?;
    }
    api.set(
        c"has",
        function(p, "has", 1, 1, |p, a| {
            flag(
                p,
                match clean(p, a[0], false)? {
                    Some(n) => entry(p, &n)?.is_some(),
                    None => false,
                },
            )
        })?,
    )?;
    api.set(
        c"envOverlay",
        function(p, "envOverlay", 1, 1, |p, a| {
            audited(p, "env_overlay", a[0], keys(overlay(p)?)?, array(p)?, None)
        })?,
    )?;
    api.set(
        c"envDigest",
        function(p, "envDigest", 1, 1, |p, a| {
            let names = call(keys(overlay(p)?)?, c"sort", &[])?;
            let mut parts = Vec::new();
            names.for_each(|name| {
                let value = if object(a[0])? && a[0].truthy()? {
                    a[0].get_key(name)?
                } else {
                    undef(p)?
                };
                let value = if value.kind()? == sys::ValueType::napi_string {
                    a[0].get_key(name)?
                        .string()?
                        .ok_or_else(|| a[0].type_error("The data argument must be a string"))?
                } else {
                    JsString::new()
                };
                parts.push((name.string()?.expect("key"), value));
                Ok(())
            })?;
            text(p, &model::digest(&parts))
        })?,
    )?;
    api.set(
        c"applyEnvOverlay",
        function(p, "applyEnvOverlay", 1, 2, |p, a| {
            let env = a[0];
            if !env.truthy()? || !object(env)? {
                return Ok(env);
            }
            let vars = overlay(p)?;
            let names = array(p)?;
            keys(vars)?.for_each(|key| {
                let reflect = p.global()?.get(c"Reflect")?;
                if !call(reflect, c"has", &[env, key])?.truthy()? {
                    call(names, c"push", &[key])?;
                }
                Ok(())
            })?;
            let context = fields(
                p,
                &[
                    ("source", text(p, "child_env")?),
                    ("sessionId", env.get(c"MULTICC_SESSION_ID")?),
                ],
            )?;
            context.spread_from(default_object(a[1])?)?;
            let extra = fields(p, &[("env", env), ("overlay", vars), ("names", names)])?;
            audited(p, "env_inject", context, names, array(p)?, Some(extra))
        })?,
    )?;
    let prefixes = p.get(c"ENV_EXCLUDED_PREFIXES")?;
    p.set(c"ENV_EXCLUDED_PREFIXES", prefixes)?;
    api.set(c"ENV_EXCLUDED_PREFIXES", prefixes)?;
    api.set(
        c"_resetForTests",
        function(p, "_resetForTests", 0, 0, |p, _| {
            owner(p)?.entries.borrow_mut().clear();
            owner(p)?.values.drain(&crate::host_methods::env(p))?;
            undef(p)
        })?,
    )?;
    api.set(c"_saveForTests", function(p, "save", 0, 0, |p, _| save(p))?)?;
    api.set(c"_loadForTests", function(p, "load", 0, 0, |p, _| load(p))?)?;
    Ok(api.raw())
}
