//! JS evaluates public argument coercions at their original points. The core
//! owns text normalization, set comparison and markdown structure.
use crate::route_response::*;
use multicc_core::{js::JsString as S, memory_distill};
use napi_derive::napi;
fn units(v: L<'_>) -> Result<S> {
    v.string()?
        .ok_or_else(|| v.type_error("expected memory text"))
}
#[napi]
pub fn clean_task_memory(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let v = L::new(&env, input);
    Ok(
        v.from_value(&memory_distill::clean(&units(v)?).map_or(V::Null, V::String))?
            .raw(),
    )
}
#[napi]
pub fn similar_task_memory(env: Env, a: Unknown<'_>, b: Unknown<'_>) -> Result<bool> {
    Ok(memory_distill::similar(
        &units(L::new(&env, a))?,
        &units(L::new(&env, b))?,
    ))
}
#[napi]
pub fn merge_task_memory(
    env: Env,
    content: Unknown<'_>,
    line: Unknown<'_>,
    candidate: Unknown<'_>,
    start: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, content);
    let (body, replaced) = memory_distill::merge(
        units(p)?.trim(),
        units(L::new(&env, line))?,
        || units(L::new(&env, candidate).call_plain(&[])?),
        || L::new(&env, start).call_plain(&[])?.number(),
    )?;
    Ok(fields(
        p,
        &[
            ("content", p.from_value(&V::String(body))?),
            ("replaced", flag(p, replaced)?),
        ],
    )?
    .raw())
}
