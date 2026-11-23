//! Startup validation and the synchronous related-task write path. The board is
//! the live store mirror: use its existing group rule, save and broadcast ports.
use crate::{
    js_live::LiveValue,
    task_board_host::{Host, Properties},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn invalid_deps(host: Host<'_>, message: &str) -> Result<()> {
    Err(host
        .0
        .global()?
        .get(c"Error")?
        .construct(&[host.value(message)?])?
        .throw_error())
}

#[napi]
pub fn task_board_assert_deps(env: Env, deps: Unknown<'_>) -> Result<()> {
    let deps = LiveValue::new(&env, deps);
    let host = Host(deps);
    if deps.kind()? != sys::ValueType::napi_object {
        return invalid_deps(host, "[taskboard] deps object required");
    }
    for name in [
        c"file",
        c"auxQueue",
        c"records",
        c"loadHistory",
        c"dispatchToSession",
        c"sendSessionMessage",
        c"workspaceBroadcast",
        c"atomicWriteJson",
        c"isSystemInjected",
        c"getSessionRunState",
    ] {
        // The old guard reads again for the strict null comparison.
        if deps.get(name)?.undefined()? || deps.get(name)?.equals(host.null()?)? {
            return invalid_deps(
                host,
                &format!("[taskboard] missing dep: {}", name.to_string_lossy()),
            );
        }
    }
    Ok(())
}

#[napi]
pub fn task_board_link_related(
    env: Env,
    ports: Unknown<'_>,
    task_id: Unknown<'_>,
    related_id: Unknown<'_>,
) -> Result<sys::napi_value> {
    let ports = LiveValue::new(&env, ports);
    let host = Host(ports);
    let board = host.board()?;
    // Clone just the old group metadata. Saving can fail after the group rule
    // has mutated nested arrays in place; a shallow copy cannot roll that back.
    let json = ports.global()?.get(c"JSON")?;
    let parse = json.get(c"parse")?;
    let stringify = json.get(c"stringify")?;
    let groups = board.get(c"taskGroups")?.or(|| host.object(&[]))?;
    let snapshot = stringify.call(json, &[groups])?;
    let before = parse.call(json, &[snapshot])?;
    let result = ports.get(c"groupRelatedTasks")?.call_plain(&[
        board,
        LiveValue::new(&env, task_id),
        LiveValue::new(&env, related_id),
        ports.get(c"now")?.call_plain(&[])?,
    ])?;
    if !result.get(c"ok")?.truthy()? || !result.get(c"changed")?.truthy()? {
        return Ok(result.raw());
    }
    if !ports.get(c"save")?.call_plain(&[])?.truthy()? {
        board.assign(c"taskGroups", before)?;
        return Ok(host
            .object(&[
                (c"ok", host.value(false)?),
                (c"error", host.value("persistence_failed")?),
            ])?
            .raw());
    }
    ports.get(c"notify")?.call_plain(&[
        host.null()?,
        result.get(c"taskIds")?,
        host.value("grouped")?,
    ])?;
    let out = host.object(&[])?;
    out.spread_from(result)?;
    out.set(c"revision", board.get(c"revision")?)?;
    Ok(out.raw())
}
