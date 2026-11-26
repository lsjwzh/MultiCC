//! Task-relation host projections over the transactional Rust store.
use crate::{
    host_methods::method,
    js_iteration::read,
    js_live::{fields, invoke, spread, LiveValue as L},
};
use multicc_core::{js::JsValue as V, task_store::RELATION_KINDS};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    sys, Env, Result,
};
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
    Ok(list(
        L::new(&env, store),
        L::new(&env, shell),
        L::new(&env, project),
    )?
    .raw())
}

fn list<'a>(store: L<'a>, shell: L<'a>, project: L<'a>) -> Result<L<'a>> {
    let rule = read(store, c"rule")?;
    let req = fields(
        store,
        &[
            ("action", store.from_value(&"relationList".into())?),
            ("shellId", shell),
        ],
    )?;
    let rows = invoke(store, rule, &[req], "store.rule")?;
    invoke(rows, read(rows, c"map")?, &[project], "store.rule(...).map")
}

#[napi]
pub fn task_relation_change(
    env: Env,
    ports: Unknown<'_>,
    shell: Unknown<'_>,
    input: Unknown<'_>,
    remove: bool,
) -> Result<sys::napi_value> {
    Ok(change(
        L::new(&env, ports),
        L::new(&env, shell),
        L::new(&env, input),
        remove,
    )?
    .raw())
}

fn change<'a>(ports: L<'a>, shell: L<'a>, input: L<'a>, remove: bool) -> Result<L<'a>> {
    let store = ports.get(c"store")?;
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
            ("input", input),
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
    Ok(output)
}

fn create<'a>(kinds: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let store = read(options, c"store")?;
    let title = read(options, c"taskTitle")?;
    let changed = read(options, c"onChanged")?;
    let now = read(options, c"now")?;
    let now = if now.undefined()? {
        kinds.global()?.get(c"Date")?.get(c"now")?
    } else {
        now
    };
    let env = Env::from_raw(kinds.env());
    let project = method(&env, title, "project", 1, 1, |title, args| {
        public_title(args[0], title)
    })?;
    let ports = fields(
        kinds,
        &[
            ("store", store),
            ("taskTitle", title),
            ("onChanged", changed),
            ("now", now),
            ("project", project),
        ],
    )?;
    let list = method(&env, ports, "list", 1, 1, |ports, args| {
        list(ports.get(c"store")?, args[0], ports.get(c"project")?)
    })?;
    let mutation = |name, remove| {
        method(&env, ports, name, 1, 2, move |ports, args| {
            let input = if args[1].undefined()? {
                fields(ports, &[])?
            } else {
                args[1]
            };
            change(ports, args[0], input, remove)
        })
    };
    let api = fields(
        kinds,
        &[
            ("list", list),
            ("create", mutation("create", false)?),
            ("remove", mutation("remove", true)?),
            ("KINDS", kinds),
        ],
    )?;
    Ok(L::from_raw(kinds.env(), api.raw()))
}

#[napi]
pub fn task_relations_api(env: Env) -> Result<sys::napi_value> {
    let anchor = L::new(&env, ().into_unknown(&env)?);
    let kinds = anchor
        .from_value(&V::Array(
            RELATION_KINDS.iter().map(|kind| V::from(*kind)).collect(),
        ))?
        .freeze()?;
    Ok(fields(
        anchor,
        &[
            (
                "createTaskRelations",
                method(&env, kinds, "createTaskRelations", 1, 1, |kinds, args| {
                    create(kinds, args[0])
                })?,
            ),
            ("RELATION_KINDS", kinds),
        ],
    )?
    .raw())
}
