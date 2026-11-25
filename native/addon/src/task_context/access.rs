//! Explicit task history reads. Only ownership metadata crosses the JSON
//! planning boundary; transcript objects stay in V8 throughout selection.
use crate::{
    host_methods::{call, method},
    js_iteration::read,
    js_live::{fields, spread, LiveValue as L},
};
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn missing(id: L<'_>) -> Result<napi::Error> {
    let code = id.from_value(&"task_not_found".into())?;
    let error = id.global()?.get(c"Error")?.construct(&[code])?;
    error.set(c"code", code)?;
    error.set(c"status", id.from_value(&JsValue::Number(404.0))?)?;
    Ok(error.throw_error())
}

fn project<'a>(
    env: &'a Env,
    rows: L<'a>,
    keys: &'static [(&'static str, &'static CStr)],
) -> Result<L<'a>> {
    let mapper = method(env, rows, "", 1, 1, move |_, args| {
        let row = args[0];
        let out = fields(row, &[])?;
        for &(name, key) in keys {
            out.define_key(row.from_value(&name.into())?, read(row, key)?)?;
        }
        Ok(out)
    })?;
    call(rows, c"map", &[mapper])
}

fn metadata(value: L<'_>, run: fn(String) -> Result<String>) -> Result<L<'_>> {
    let json = value.global()?.get(c"JSON")?;
    let text = call(json, c"stringify", &[value])?
        .coerce_string()?
        .to_string_lossy();
    call(json, c"parse", &[value.from_value(&run(text)?.into())?])
}

#[napi]
pub fn related_task_history(
    env: Env,
    ports: Unknown<'_>,
    shell_records: Unknown<'_>,
) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let id = ports.get(c"targetId")?;
    let deleted = ports.get(c"isDeletedTask")?;
    if !deleted.nullish()? && deleted.call_plain(&[id])?.truthy()? {
        return Err(missing(id)?);
    }
    let store = ports.get(c"store")?;
    let kind = |s: &str| id.from_value(&s.into());
    let mut target = call(store, c"get", &[kind("task")?, id])?;
    if !target.truthy()? {
        target = ports.get(c"getTask")?.call_plain(&[id])?;
    }
    if !target.truthy()? {
        return Err(missing(id)?);
    }
    let view = fields(
        target,
        &[
            ("id", read(target, c"id")?),
            ("sessionId", read(target, c"sessionId")?),
            ("chatSessionId", read(target, c"chatSessionId")?),
            ("historySessionIds", read(target, c"historySessionIds")?),
        ],
    )?;
    let refs = read(target, c"refs")?;
    view.define_key(
        kind("refs")?,
        if refs.nullish()? {
            id.from_value(&JsValue::Undefined)?
        } else {
            project(&env, refs, &[("sessionId", c"sessionId")])?
        },
    )?;
    let list = |k: &str| call(store, c"list", &[kind(k)?]);
    let plan = metadata(
        fields(
            id,
            &[
                ("target", view),
                (
                    "links",
                    project(
                        &env,
                        list("link")?,
                        &[("shellId", c"shellId"), ("taskId", c"taskId")],
                    )?,
                ),
                (
                    "shells",
                    project(
                        &env,
                        list("shell")?,
                        &[("id", c"id"), ("sourceSessionId", c"sourceSessionId")],
                    )?,
                ),
                (
                    "tasks",
                    project(
                        &env,
                        list("task")?,
                        &[("id", c"id"), ("sessionId", c"sessionId")],
                    )?,
                ),
            ],
        )?,
        super::plan_task_context_read,
    )?;
    let get_record = ports.get(c"getRecord")?;
    let filter = method(&env, get_record, "", 1, 1, |get, args| get.call_plain(args))?;
    let ids = call(plan.get(c"sessionIds")?, c"filter", &[filter])?;
    let records = L::new(&env, shell_records).call_plain(&[
        fields(id, &[("sessionIds", ids)])?,
        ports.get(c"getHistory")?,
        ports.get(c"getLiveState")?,
    ])?;
    let binding = method(&env, get_record, "", 1, 1, |get, args| {
        fields(
            get,
            &[
                ("sessionId", args[0]),
                (
                    "taskBoundTaskId",
                    read(get.call_plain(args)?, c"taskBoundTaskId")?,
                ),
            ],
        )
    })?;
    let bindings = call(ids, c"map", &[binding])?;
    let info = method(&env, id, "", 2, 2, |_, args| {
        fields(
            args[0],
            &[
                ("index", args[1]),
                ("taskId", read(args[0], c"taskId")?),
                ("sourceSessionId", read(args[0], c"sourceSessionId")?),
            ],
        )
    })?;
    let selected = metadata(
        fields(
            id,
            &[
                ("targetId", id),
                ("bindings", bindings),
                ("records", call(records, c"map", &[info])?),
            ],
        )?,
        super::select_task_context_records,
    )?;
    let attach = method(&env, records, "", 1, 1, |records, args| {
        let index = read(args[0], c"index")?;
        let task = read(args[0], c"taskId")?;
        let row = spread(records.get_key(index)?)?;
        row.define_key(records.from_value(&"taskId".into())?, task)?;
        Ok(row)
    })?;
    Ok(call(selected, c"map", &[attach])?.raw())
}
