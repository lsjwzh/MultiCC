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
    let mut snapshot = state.get(c"snapshot")?;
    if snapshot.undefined()? || !state.get(c"mtime")?.equals(mtime)? {
        let next = L::new(&env, read).call_plain(&[L::new(&env, file)])?;
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
    let id = model_key(L::new(&env, id))?;
    let catalog = snapshot.optional(c"catalog")?;
    let memo = snapshot.optional(c"memo")?;
    if memo.nullish()? || !L::new(&env, plain_fields).call_plain(&[id])?.truthy()? {
        return Ok(resolve(catalog, id)?.raw());
    }
    let hit = memo.get(c"get")?.call(memo, &[id])?;
    if !hit.undefined()? {
        return Ok(hit.raw());
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
    Ok(result.raw())
}
