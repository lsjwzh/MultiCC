//! Auxiliary attribution proposals retain the original receipt and task. The
//! host provides the transactional store; duplicate proposals return its row.
use crate::{
    host_methods::{call, method},
    js_iteration::read,
    js_live::{fields, spread, LiveValue as L},
};
use multicc_core::{js::JsValue as V, task_routing::candidate_id};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn get<'a>(store: L<'a>, kind: &str, id: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    let get = read(store, c"get")?;
    get.call(store, &[store.from_value(&kind.into())?, id()?])
}
fn or_null(v: L<'_>) -> Result<L<'_>> {
    if v.truthy()? {
        Ok(v)
    } else {
        v.from_value(&V::Null)
    }
}
fn pending(row: L<'_>) -> Result<L<'_>> {
    let yes = row.from_value(&V::Bool(true))?;
    fields(row, &[("ok", yes), ("pending", yes), ("candidate", row)])
}
fn rejected<'a>(p: L<'a>, code: &str) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("ok", p.from_value(&V::Bool(false))?),
            ("code", p.from_value(&code.into())?),
        ],
    )
}
fn blockers(p: L<'_>, stale: bool) -> Result<L<'_>> {
    let names: &[&str] = if stale {
        &["view_changed"]
    } else {
        &[
            "final_run_result_required",
            "integration_receipt_required",
            "source_writer_barrier_required",
        ]
    };
    p.from_value(&V::Array(names.iter().map(|s| V::from(*s)).collect()))
}
fn commit(p: L<'_>) -> Result<L<'_>> {
    let store = p.get(c"store")?;
    let id = p.get(c"id")?;
    let old = get(store, "attribution-candidate", || Ok(id))?;
    if old.truthy()? {
        return pending(old);
    }
    let source = p.get(c"source")?;
    let attr = p.get(c"attribution")?;
    let target = p.get(c"target")?;
    let stale = p.get(c"stale")?.truthy()?;
    let title = || -> Result<L<'_>> {
        let name = read(attr, c"taskName")?;
        let value = if name.truthy()? {
            name
        } else {
            p.from_value(&"".into())?
        };
        let string = p
            .global()?
            .get(c"String")?
            .call_plain(&[value])?
            .coerce_string()?;
        p.from_value(&V::String(string.truncate_units(120)))
    };
    let row = fields(
        p,
        &[
            ("id", id),
            ("sessionId", p.get(c"sessionId")?),
            ("receiptId", p.get(c"receiptId")?),
            ("sourceTaskId", read(source, c"id")?),
            ("directoryId", read(source, c"dirId")?),
            ("turnId", read(attr, c"turnId")?),
            ("anchorMessageId", or_null(read(attr, c"anchorMessageId")?)?),
            ("targetTaskId", or_null(target.optional(c"id")?)?),
            (
                "provisionalTargetId",
                if target.truthy()? {
                    p.from_value(&V::Null)?
                } else {
                    read(attr, c"taskId")?
                },
            ),
            ("title", title()?),
            (
                "expectedCursorVersion",
                read(p.get(c"receipt")?, c"cursorVersion")?,
            ),
            (
                "state",
                p.from_value(&V::from(if stale { "stale" } else { "pending" }))?,
            ),
            ("blockers", blockers(p, stale)?),
            ("createdAt", call(p.global()?.get(c"Date")?, c"now", &[])?),
        ],
    )?;
    call(
        store,
        c"set",
        &[p.from_value(&"attribution-candidate".into())?, id, row],
    )?;
    pending(row)
}

#[napi]
pub fn task_candidate_propose(
    env: Env,
    store: Unknown<'_>,
    session: Unknown<'_>,
    receipt_id: Unknown<'_>,
    attr: Unknown<'_>,
    key_input: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(propose(
        &env,
        L::new(&env, store),
        L::new(&env, session),
        L::new(&env, receipt_id),
        L::new(&env, attr),
        Some(L::new(&env, key_input)),
    )?
    .raw())
}
fn propose<'a>(
    env: &'a Env,
    store: L<'a>,
    session: L<'a>,
    receipt_id: L<'a>,
    attr: L<'a>,
    key_input: Option<L<'a>>,
) -> Result<L<'a>> {
    let receipt = get(store, "receipt", || Ok(receipt_id))?;
    let source = if receipt.truthy()? {
        get(store, "task", || read(receipt, c"taskId"))?
    } else {
        receipt
    };
    if !source.truthy()?
        || !read(source, c"sessionId")?.equals(session)?
        || !read(attr, c"turnId")?.truthy()?
    {
        return rejected(store, "candidate_source_unverified");
    }
    if read(attr, c"taskId")?.equals(read(source, c"id")?)? {
        return fields(
            store,
            &[
                ("ok", store.from_value(&V::Bool(true))?),
                ("changed", store.from_value(&V::Bool(false))?),
            ],
        );
    }
    let shell = get(store, "shell", || read(receipt, c"shellId"))?;
    let stale = !shell
        .optional(c"cursorReceiptId")?
        .equals(read(receipt, c"id")?)?
        || !shell
            .optional(c"currentTaskId")?
            .equals(read(source, c"id")?)?
        || !shell
            .optional(c"cursorVersion")?
            .equals(read(receipt, c"cursorVersion")?)?;
    let target = get(store, "task", || read(attr, c"taskId"))?;
    if target.truthy()? && !read(target, c"dirId")?.equals(read(source, c"dirId")?)? {
        return rejected(store, "project_mismatch");
    }
    let key = if let Some(callback) = key_input {
        callback.call_plain(&[receipt_id, attr])?.coerce_string()?
    } else {
        let mut key = crate::message_composer::default_primitive(receipt_id)?.coerce_string()?;
        key.push_str("\0");
        key.push(
            &crate::message_composer::default_primitive(read(attr, c"turnId")?)?.coerce_string()?,
        );
        key
    };
    let p = fields(
        store,
        &[
            ("store", store),
            ("sessionId", session),
            ("receiptId", receipt_id),
            ("receipt", receipt),
            ("source", source),
            ("target", target),
            ("attribution", attr),
            ("stale", store.from_value(&V::Bool(stale))?),
            ("id", store.from_value(&candidate_id(&key).into())?),
        ],
    )?;
    let tx = method(&env, p, "", 0, 0, |p, _| commit(p))?;
    call(store, c"transaction", &[tx])
}

#[napi]
pub fn task_candidate_latest(
    env: Env,
    store: Unknown<'_>,
    task: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(latest(&env, L::new(&env, store), L::new(&env, task))?.raw())
}
fn latest<'a>(env: &'a Env, store: L<'a>, task: L<'a>) -> Result<L<'a>> {
    let rows = call(
        store,
        c"list",
        &[store.from_value(&"attribution-candidate".into())?],
    )?;
    let predicate = method(env, task, "", 1, 1, |task, args| {
        task.from_value(&V::Bool(read(args[0], c"sourceTaskId")?.equals(task)?))
    })?;
    let matches = call(rows, c"filter", &[predicate])?;
    let row = call(matches, c"at", &[store.from_value(&V::Number(-1.))?])?;
    if !row.truthy()? {
        return store.from_value(&V::Null);
    }
    let receipt = get(store, "receipt", || read(row, c"receiptId"))?;
    let shell = if receipt.truthy()? {
        get(store, "shell", || read(receipt, c"shellId"))?
    } else {
        receipt
    };
    if shell.truthy()?
        && read(shell, c"cursorReceiptId")?.equals(read(row, c"receiptId")?)?
        && read(shell, c"cursorVersion")?.equals(read(row, c"expectedCursorVersion")?)?
    {
        return Ok(row);
    }
    let copy = spread(row)?;
    copy.define_key(
        store.from_value(&"state".into())?,
        store.from_value(&"stale".into())?,
    )?;
    copy.define_key(
        store.from_value(&"blockers".into())?,
        blockers(store, true)?,
    )?;
    Ok(copy)
}

#[napi]
pub fn candidate_store(env: Env, store: Unknown<'_>) -> Result<sys::napi_value> {
    let store = L::new(&env, store);
    let propose = method(&env, store, "propose", 3, 3, |store, a| {
        let env = Env::from_raw(store.env());
        let out = propose(&env, store, a[0], a[1], a[2], None)?;
        Ok(L::from_raw(store.env(), out.raw()))
    })?;
    let latest = method(&env, store, "latest", 1, 1, |store, a| {
        let env = Env::from_raw(store.env());
        let out = latest(&env, store, a[0])?;
        Ok(L::from_raw(store.env(), out.raw()))
    })?;
    Ok(fields(store, &[("propose", propose), ("latest", latest)])?.raw())
}
