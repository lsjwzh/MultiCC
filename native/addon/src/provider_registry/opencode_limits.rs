//! Exact model limits in generated custom-provider configurations. The
//! rotation reader also tries a provider-stripped model name, unlike this API.
use super::L;
use multicc_core::{
    js::JsValue as V,
    opencode_context::{valid_config_limit, FALLBACK_CONTEXT, FALLBACK_OUTPUT},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

// Keep the validation read distinct from the value read. A host getter can
// return a different value on each access, even after passing Number.isInteger.
fn minimum<'a>(current: L<'a>, limit: L<'a>, key: &CStr) -> Result<L<'a>> {
    if !valid_config_limit(limit.get(key)?.number_value()?) {
        return Ok(current);
    }
    if current.kind()? == sys::ValueType::napi_null {
        return limit.get(key);
    }
    let math = limit.global()?.get(c"Math")?;
    math.get(c"min")?.call(math, &[current, limit.get(key)?])
}

fn resolve<'a>(catalog: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let null = catalog.from_value(&V::Null)?;
    let empty = catalog.from_value(&V::Object(vec![]))?;
    let (mut context, mut output, mut matched) = (null, null, 0usize);
    if id.truthy()? && catalog.kind()? == sys::ValueType::napi_object {
        let object = catalog.global()?.get(c"Object")?;
        let providers = object.get(c"values")?.call(object, &[catalog])?;
        providers.for_each(|provider| {
            if !provider.truthy()? {
                return Ok(());
            }
            let models = provider.get(c"models")?;
            if models.kind()? != sys::ValueType::napi_object {
                return Ok(());
            }
            let entry = models.get_key(id)?;
            if entry.kind()? != sys::ValueType::napi_object {
                return Ok(());
            }
            let limit = entry.get(c"limit")?;
            let limit = if limit.truthy()? { limit } else { empty };
            if valid_config_limit(limit.get(c"context")?.number_value()?)
                || valid_config_limit(limit.get(c"output")?.number_value()?)
            {
                matched += 1;
                context = minimum(context, limit, c"context")?;
                output = minimum(output, limit, c"output")?;
            }
            Ok(())
        })?;
    }
    let has_context = !context.equals(null)?;
    let has_output = !output.equals(null)?;
    let known = has_context || has_output;
    let record = catalog.from_value(&V::Object(vec![]))?;
    record.set(
        c"context",
        if has_context {
            context
        } else {
            catalog.from_value(&V::Number(FALLBACK_CONTEXT as f64))?
        },
    )?;
    record.set(
        c"output",
        if has_output {
            output
        } else {
            catalog.from_value(&V::Number(FALLBACK_OUTPUT as f64))?
        },
    )?;
    record.set(
        c"source",
        catalog.from_value(&V::string(if known { "models.dev" } else { "fallback" }))?,
    )?;
    record.set(
        c"matched",
        catalog.from_value(&V::Number(if known { matched as f64 } else { 0.0 }))?,
    )?;
    Ok(record)
}

fn model_key(value: L<'_>) -> Result<L<'_>> {
    if value.truthy()? {
        value.clean_text()
    } else {
        value.from_value(&V::string(""))
    }
}

#[napi]
pub fn open_code_model_limit(
    env: Env,
    catalog: Unknown<'_>,
    id: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(resolve(L::new(&env, catalog), model_key(L::new(&env, id))?)?.raw())
}

// The synchronous spawn API supplies its filesystem and JSON.parse ports.
// A failed stat bypasses this function. A failed read advances the mtime but
// retains the last good snapshot, including one installed by a reentrant read.
#[napi]
pub fn open_code_cached_model_limit(
    env: Env,
    state: Unknown<'_>,
    mtime: Unknown<'_>,
    file: Unknown<'_>,
    read: Unknown<'_>,
    id: Unknown<'_>,
    plain_fields: Unknown<'_>,
) -> Result<sys::napi_value> {
    let state = L::new(&env, state);
    let mtime = L::new(&env, mtime);
    Ok(cached(
        state,
        mtime,
        L::new(&env, id),
        || L::new(&env, read).call_plain(&[L::new(&env, file)]),
        |id| L::new(&env, plain_fields).call_plain(&[id])?.truthy(),
    )?
    .raw())
}
fn cached<'a>(
    state: L<'a>,
    mtime: L<'a>,
    id: L<'a>,
    read: impl FnOnce() -> Result<L<'a>>,
    plain: impl FnOnce(L<'a>) -> Result<bool>,
) -> Result<L<'a>> {
    let mut snapshot = state.get(c"snapshot")?;
    if snapshot.undefined()? || !state.get(c"mtime")?.equals(mtime)? {
        let next = read()?;
        snapshot = if next.undefined()? {
            state.get(c"snapshot")?
        } else if next.get(c"catalog")?.kind()? != sys::ValueType::napi_object {
            state.from_value(&V::Null)?
        } else {
            next
        };
        if snapshot.undefined()? {
            snapshot = state.from_value(&V::Null)?;
        }
        state.set(c"snapshot", snapshot)?;
        state.set(c"mtime", mtime)?;
    }
    // Model coercion can reset or replace the cache. This lookup still
    // belongs to the file snapshot selected before that coercion.
    let id = model_key(id)?;
    let catalog = snapshot.optional(c"catalog")?;
    let memo = snapshot.optional(c"memo")?;
    if memo.nullish()? || !plain(id)? {
        return resolve(catalog, id);
    }
    let hit = memo.get(c"get")?.call(memo, &[id])?;
    if !hit.undefined()? {
        return Ok(hit);
    }
    let result = resolve(catalog, id)?;
    // Unknown model names are unbounded. Limit the answers retained by each
    // file snapshot; eviction only causes the next lookup to scan again.
    if memo.get(c"size")?.number()? >= 256.0 {
        let keys = memo.get(c"keys")?.call(memo, &[])?;
        let oldest = keys.get(c"next")?.call(keys, &[])?.get(c"value")?;
        memo.get(c"delete")?.call(memo, &[oldest])?;
    }
    memo.get(c"set")?.call(memo, &[id, result])?;
    Ok(result)
}

use crate::{
    host_methods::{call, method},
    js_live::{fields, spread},
    route_response::{num, text},
};
use napi::bindgen_prelude::ToNapiValue;

fn plain<'a>(intrinsics: L<'a>, id: L<'a>) -> Result<bool> {
    let global = intrinsics.global()?;
    let o = global.get(c"Object")?;
    let array = global.get(c"Array")?.get(c"prototype")?;
    let iterator = global.get(c"Symbol")?.get(c"iterator")?;
    if !o.get(c"values")?.equals(intrinsics.get(c"values")?)?
        || !array
            .get_key(iterator)?
            .equals(intrinsics.get(c"iterator")?)?
        || !global
            .get(c"Math")?
            .get(c"min")?
            .equals(intrinsics.get(c"min")?)?
    {
        return Ok(false);
    }
    let reflect = global.get(c"Reflect")?;
    for name in [c"Object", c"Array", c"String", c"Number", c"Boolean"] {
        let proto = global.get(name)?.get(c"prototype")?;
        if (name == c"Object" || name == c"Array")
            && call(reflect, c"has", &[proto, id])?.truthy()?
        {
            return Ok(false);
        }
        for key in [c"models", c"limit", c"context", c"output"] {
            if proto.has(key)? {
                return Ok(false);
            }
        }
    }
    Ok(true)
}
fn file_limit<'a>(state: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let deps = state.get(c"deps")?;
    let file = if state.get(c"customPath")?.truthy()? {
        deps.get(c"cachePath")?
    } else {
        state.get(c"defaultPath")?.call_plain(&[])?
    };
    let fs = state.get(c"fs")?;
    let stat = state.catch(|| call(fs, c"statSync", &[file]))?;
    let Some(stat) = stat else {
        return resolve(state.from_value(&V::Null)?, model_key(id)?);
    };
    let intrinsics = state.get(c"intrinsics")?;
    let read = || {
        let snapshot = state.catch(|| {
            let json = state.global()?.get(c"JSON")?;
            let parse = json.get(c"parse")?;
            let contents = call(fs, c"readFileSync", &[file, text(state, "utf8")?])?;
            let catalog = parse.call(json, &[contents])?;
            let memo = if parse.equals(intrinsics.get(c"parse")?)? {
                state.global()?.get(c"Map")?.construct(&[])?
            } else {
                state.from_value(&V::Null)?
            };
            fields(state, &[("catalog", catalog), ("memo", memo)])
        })?;
        snapshot
            .map(Ok)
            .unwrap_or_else(|| state.from_value(&V::Undefined))
    };
    spread(cached(state, stat.get(c"mtimeMs")?, id, read, |id| {
        plain(intrinsics, id)
    })?)
}
#[napi]
pub fn create_opencode_limit_resolver(
    env: Env,
    deps: Unknown<'_>,
    fs: Unknown<'_>,
    default_path: Unknown<'_>,
    intrinsics: Unknown<'_>,
) -> Result<sys::napi_value> {
    let deps = L::new(&env, deps);
    let fs_impl = deps.get(c"fsImpl")?;
    let state = fields(
        deps,
        &[
            ("deps", deps),
            (
                "fs",
                if fs_impl.truthy()? {
                    fs_impl
                } else {
                    L::new(&env, fs)
                },
            ),
            ("customPath", deps.get(c"cachePath")?),
            ("defaultPath", L::new(&env, default_path)),
            ("intrinsics", L::new(&env, intrinsics)),
            ("snapshot", deps.from_value(&V::Undefined)?),
            ("mtime", num(deps, -1.)?),
        ],
    )?;
    // resolveLimit is deliberately generic; callers may borrow it and substitute this.resolve.
    let resolve_limit = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "resolveLimit",
        |ctx| {
            let this = L::new(ctx.env, ctx.this()?);
            let id = if ctx.length() == 0 {
                this.from_value(&V::Undefined)?
            } else {
                L::new(ctx.env, ctx.get(0)?)
            };
            let row = call(this, c"resolve", &[id])?;
            Ok(fields(
                this,
                &[
                    ("context", row.get(c"context")?),
                    ("output", row.get(c"output")?),
                ],
            )?
            .freeze()?
            .raw())
        },
    )?;
    Ok(fields(
        state,
        &[
            (
                "resolve",
                method(&env, state, "resolve", 1, 1, |s, a| file_limit(s, a[0]))?,
            ),
            (
                "resolveLimit",
                L::new(&env, resolve_limit.into_unknown(&env)?),
            ),
            (
                "resetCache",
                method(&env, state, "resetCache", 0, 0, |s, _| {
                    s.set(c"snapshot", s.from_value(&V::Undefined)?)?;
                    s.set(c"mtime", num(s, -1.)?)?;
                    s.from_value(&V::Undefined)
                })?,
            ),
        ],
    )?
    .freeze()?
    .raw())
}

#[napi]
pub fn open_code_fallback_limit(env: Env) -> Result<sys::napi_value> {
    let anchor = L::new(&env, ().into_unknown(&env)?);
    Ok(fields(
        anchor,
        &[
            ("context", num(anchor, FALLBACK_CONTEXT as f64)?),
            ("output", num(anchor, FALLBACK_OUTPUT as f64)?),
        ],
    )?
    .freeze()?
    .raw())
}
