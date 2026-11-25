//! Task-relation host projections over the transactional Rust store.
use crate::{
    js_iteration::read,
    js_live::{fields, invoke, spread, LiveValue as L},
};
use multicc_core::{js::JsValue as V, task_store::RELATION_KINDS};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn task_relation_kinds() -> Vec<&'static str> {
    RELATION_KINDS.to_vec()
}

#[napi]
pub fn task_relation_public_title(
    env: Env,
    relation: Unknown<'_>,
    title: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(public_title(L::new(&env, relation), L::new(&env, title))?.raw())
}

fn public_title<'a>(relation: L<'a>, title: L<'a>) -> Result<L<'a>> {
    let output = spread(relation)?;
    let null = relation.from_value(&V::Null)?;
    for (id, name) in [(c"fromTaskId", "fromTitle"), (c"toTaskId", "toTitle")] {
        let value = if title.nullish()? {
            null
        } else {
            invoke(
                relation.from_value(&V::Undefined)?,
                title,
                &[read(relation, id)?],
                "taskTitle",
            )?
        };
        output.define_key(
            relation.from_value(&name.into())?,
            if value.truthy()? { value } else { null },
        )?;
    }
    Ok(output)
}

#[napi]
pub fn task_relation_list(
    env: Env,
    store: Unknown<'_>,
    shell: Unknown<'_>,
    project: Unknown<'_>,
) -> Result<sys::napi_value> {
    let store = L::new(&env, store);
    let rule = read(store, c"rule")?;
    let req = fields(
        store,
        &[
            ("action", store.from_value(&"relationList".into())?),
            ("shellId", L::new(&env, shell)),
        ],
    )?;
    let rows = invoke(store, rule, &[req], "store.rule")?;
    Ok(invoke(
        rows,
        read(rows, c"map")?,
        &[L::new(&env, project)],
        "store.rule(...).map",
    )?
    .raw())
}

#[napi]
pub fn task_relation_change(
    env: Env,
    ports: Unknown<'_>,
    shell: Unknown<'_>,
    input: Unknown<'_>,
    remove: bool,
) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let store = ports.get(c"store")?;
    let shell = L::new(&env, shell);
    let rule = read(store, c"rule")?;
    let action = if remove {
        "relationRemove"
    } else {
        "relationCreate"
    };
    let now = ports.get(c"now")?;
    let time = invoke(ports.from_value(&V::Undefined)?, now, &[], "now")?;
    let request = fields(
        ports,
        &[
            ("action", ports.from_value(&action.into())?),
            ("shellId", shell),
            ("input", L::new(&env, input)),
            ("now", time),
        ],
    )?;
    let result = invoke(store, rule, &[request], "store.rule")?;
    if read(result, c"created")?.truthy()?
        || (read(result, c"removed")?.truthy()? && !read(result, c"replayed")?.truthy()?)
    {
        let changed = ports.get(c"onChanged")?;
        if !changed.nullish()? {
            ports.catch(|| changed.call_plain(&[shell]))?;
        }
    }
    let output = spread(result)?;
    let relation = public_title(read(result, c"relation")?, ports.get(c"taskTitle")?)?;
    output.define_key(ports.from_value(&"relation".into())?, relation)?;
    Ok(output.raw())
}
