//! Bind the relevance kernel to its JSON protocol and to live message hits.
//! Search returns the original hit objects, including their snippet references.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as J;
use multicc_core::search_diversity as kernel;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

/// Relevance order with a per-session quota and a cross-session content fold:
/// `{ candidates, limit, perRefQuota, dedupeContentHash }` in, `{ order }` out.
/// `order` holds indices into `candidates`, best first.
#[napi]
pub fn search_diversity_rerank(input: String) -> napi::Result<String> {
    kernel::rerank(&input).map_err(napi::Error::from_reason)
}

fn text(value: L<'_>) -> Result<L<'_>> {
    if !value.truthy()? {
        return value.from_value(&J::string(""));
    }
    value.global()?.get(c"String")?.call_plain(&[value])
}

fn score(value: L<'_>) -> Result<L<'_>> {
    let number = value.explicit_number()?;
    value.from_value(&J::Number(if number.is_nan() || number == 0.0 {
        0.0
    } else {
        number
    }))
}

#[napi]
pub fn search_diversity_candidate(env: Env, hit: Unknown<'_>) -> Result<sys::napi_value> {
    let hit = L::new(&env, hit);
    if hit.nullish()? {
        let message = if hit.undefined()? {
            "Cannot read properties of undefined (reading 'sessionId')"
        } else {
            "Cannot read properties of null (reading 'sessionId')"
        };
        return Err(hit.type_error(message));
    }
    let row = hit.from_value(&J::Object(vec![]))?;
    let session = hit.get(c"sessionId")?;
    let reference = if session.truthy()? {
        session
    } else {
        hit.get(c"refId")?
    };
    row.set(c"refId", text(reference)?)?;
    row.set(c"contentHash", text(hit.get(c"contentHash")?)?)?;
    row.set(c"score", score(hit.get(c"score")?)?)?;
    row.set(c"updatedAt", score(hit.get(c"updatedAt")?)?)?;
    row.set(c"taskId", text(hit.get(c"taskId")?)?)?;
    row.set(c"dirId", text(hit.get(c"dirId")?)?)?;
    Ok(row.raw())
}

#[napi]
pub fn search_diversity_pick(
    env: Env,
    hits: Unknown<'_>,
    candidates: Unknown<'_>,
    limit: f64,
    quota: Unknown<'_>,
    dedupe: Unknown<'_>,
) -> Result<sys::napi_value> {
    let hits = L::new(&env, hits);
    let request = hits.from_value(&J::Object(vec![]))?;
    request.set(c"candidates", L::new(&env, candidates))?;
    request.set(c"limit", hits.from_value(&J::Number(limit))?)?;
    request.set(c"perRefQuota", L::new(&env, quota))?;
    request.set(c"dedupeContentHash", L::new(&env, dedupe))?;
    // Caller-provided options can implement toJSON, throw, or even shrink hits.
    let json = hits.global()?.get(c"JSON")?;
    let wire = json
        .get(c"stringify")?
        .call(json, &[request])?
        .coerce_string()?
        .to_string_lossy();
    let order = kernel::rerank_order(&wire).map_err(napi::Error::from_reason)?;
    let output = hits.from_value(&J::Array(vec![]))?;
    let mut n = 0;
    for index in order {
        if (index as f64) >= hits.get(c"length")?.number()? {
            continue;
        }
        output.set_element(n, hits.element(index as u32)?)?;
        n += 1;
        if f64::from(n) >= limit {
            break;
        }
    }
    Ok(output.raw())
}
