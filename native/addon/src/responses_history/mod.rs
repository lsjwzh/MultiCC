//! Only changed request nodes are copied. Live V8 values preserve getters,
//! sparse arrays, JSON conversion errors, and references to untouched nodes.
mod hooks;
mod preprocess;
mod references;
mod repair;

use crate::{
    host_methods::{call, function},
    js_iteration::read,
    js_live::{fields, invoke, spread, LiveValue as L},
};
use multicc_core::{js::JsValue as V, responses_history::ITEM_PREFIXES};
use napi::{sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn text<'a>(a: L<'a>, s: &str) -> Result<L<'a>> {
    a.from_value(&s.into())
}
fn array<'a>(a: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    let arr = a.from_value(&V::Array(vec![]))?;
    for (i, v) in values.iter().enumerate() {
        arr.set_element(i as u32, *v)?;
    }
    Ok(arr)
}
fn push<'a>(arr: L<'a>, v: L<'a>) -> Result<()> {
    call(arr, c"push", &[v])?;
    Ok(())
}
fn has_items(v: L<'_>) -> Result<bool> {
    v.get(c"length")?.positive()
}
fn object(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_object && !v.is_array()?)
}
fn is_string(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_string)
}
fn own<'a>(v: L<'a>, k: L<'a>) -> Result<bool> {
    call(v.global()?.get(c"Object")?, c"hasOwn", &[v, k])?.truthy()
}
fn has<'a>(set: L<'a>, v: L<'a>) -> Result<bool> {
    call(set, c"has", &[v])?.truthy()
}
fn group<'a>(v: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    v.global()?.get(name)?.construct(args)
}
fn json(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"JSON")?, c"stringify", &[v])
}
fn with<'a>(obj: L<'a>, key: &CStr, v: L<'a>) -> Result<L<'a>> {
    let copy = spread(obj)?;
    copy.set(key, v)?;
    Ok(copy)
}
fn result<'a>(body: L<'a>, changes: L<'a>) -> Result<L<'a>> {
    fields(body, &[("body", body), ("changes", changes)])
}

fn record<'a>(
    changes: L<'a>,
    index: L<'a>,
    item: L<'a>,
    field: &str,
    action: &str,
    rule: &str,
) -> Result<()> {
    let mut path = multicc_core::js::JsString::from_rust_str("input[");
    path.push(&index.coerce_string()?);
    path.push_str("]");
    if !field.is_empty() {
        path.push_str(".");
        path.push_str(field);
    }
    push(
        changes,
        fields(
            item,
            &[
                ("path", item.from_value(&V::String(path))?),
                ("itemType", read(item, c"type")?),
                ("action", text(item, action)?),
                ("rule", text(item, rule)?),
            ],
        )?,
    )
}

type Visitor = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;
fn visit<'a>(
    items: L<'a>,
    kind: &CStr,
    state: L<'a>,
    visitor: Visitor,
    site: &str,
) -> Result<L<'a>> {
    let method = read(items, kind)?;
    let callback = function(state, "", 2, 2, visitor)?;
    invoke(items, method, &[callback], site)
}

#[derive(Clone, Copy)]
enum ItemPass {
    Content,
    Encrypted,
    Queries,
}

fn rewrite_item<'a>(pass: ItemPass, changes: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let item = args[0];
    let index = args[1];
    let kind = item.optional(c"type")?;
    let (field, reason) = match pass {
        ItemPass::Content
            if kind.is_string("reasoning")?
                && read(item, c"content")?.is_array()?
                && has_items(read(item, c"content")?)? =>
        {
            (c"content", "reasoning_content_not_accepted")
        }
        ItemPass::Encrypted
            if kind.is_string("reasoning")?
                && is_string(read(item, c"encrypted_content")?)?
                && read(item, c"encrypted_content")?.truthy()? =>
        {
            (c"encrypted_content", "encrypted_content_unverifiable")
        }
        ItemPass::Queries
            if kind.is_string("web_search_call")?
                && object(read(item, c"action")?)?
                && read(read(item, c"action")?, c"type")?.is_string("search")?
                && !read(read(item, c"action")?, c"queries")?.is_array()? =>
        {
            let query = || read(read(item, c"action")?, c"query");
            let query = if is_string(query()?)? && query()?.truthy()? {
                query()?
            } else {
                item.from_value(&V::Null)?
            };
            record(
                changes,
                index,
                item,
                "action.queries",
                "convert",
                "web_search_queries_required",
            )?;
            let copy = spread(item)?;
            let action = spread(read(item, c"action")?)?;
            action.set(
                c"queries",
                if query.truthy()? {
                    array(item, &[query])?
                } else {
                    array(item, &[])?
                },
            )?;
            copy.set(c"action", action)?;
            return Ok(copy);
        }
        _ => return Ok(item),
    };
    let copy = spread(item)?;
    copy.delete(field)?;
    record(
        changes,
        index,
        item,
        field.to_str().unwrap(),
        "omit",
        reason,
    )?;
    Ok(copy)
}
fn item_pass<'a>(body: L<'a>, pass: ItemPass) -> Result<L<'a>> {
    let changes = array(body, &[])?;
    if !body.optional(c"input")?.is_array()? {
        return result(body, changes);
    }
    let input = read(body, c"input")?;
    let method = read(input, c"map")?;
    let callback = function(changes, "", 2, 2, move |changes, args| {
        rewrite_item(pass, changes, args)
    })?;
    let mapped = invoke(input, method, &[callback], "body.input.map")?;
    result(
        if has_items(changes)? {
            with(body, c"input", mapped)?
        } else {
            body
        },
        changes,
    )
}

// A caller-owned Array subclass may retain a map callback and run it again.
// Snapshot each pass's diagnostics together, after the last pass has returned.
fn combined<'a>(body: L<'a>, passes: &[L<'a>]) -> Result<L<'a>> {
    let changes = array(body, &[])?;
    for pass in passes {
        pass.get(c"changes")?
            .for_each(|entry| push(changes, entry))?;
    }
    result(body, changes)
}

fn normalize<'a>(rules: L<'a>, body: L<'a>, omit_reasoning: bool) -> Result<L<'a>> {
    let prepared = preprocess::run(rules, body)?;
    let body = prepared.get(c"body")?;
    let content = if omit_reasoning {
        item_pass(body, ItemPass::Content)?
    } else {
        result(body, array(body, &[])?)?
    };
    let refs = references::run(content.get(c"body")?, array(body, &[])?)?;
    let searches = item_pass(refs.get(c"body")?, ItemPass::Queries)?;
    combined(searches.get(c"body")?, &[prepared, content, refs, searches])
}

#[napi]
pub fn responses_history_api(env: Env) -> Result<sys::napi_value> {
    let anchor = L::from_raw(env.raw(), unsafe {
        crate::js_bridge::write_value(env.raw(), &V::Undefined)?
    });
    let rules = fields(anchor, &[])?;
    for (kind, prefix) in ITEM_PREFIXES {
        rules.define_key(
            text(anchor, kind)?,
            fields(anchor, &[("prefix", text(anchor, prefix)?)])?,
        )?;
    }
    let api = fields(anchor, &[])?;
    let methods: [(&CStr, usize, Visitor); 9] = [
        (c"preprocess", 1, |r, a| preprocess::run(r, a[0])),
        (c"normalize", 2, |r, a| normalize(r, a[0], a[1].truthy()?)),
        (c"onRequest", 2, |r, a| {
            hooks::DialStage::Request.run(r, a[0], a[1])
        }),
        (c"onUpstreamRejected", 2, |r, a| {
            hooks::DialStage::Rejection.run(r, a[0], a[1])
        }),
        (c"repair", 2, |r, a| repair::run(r, a[0], a[1])),
        (c"stripContent", 1, |_, a| {
            item_pass(a[0], ItemPass::Content)
        }),
        (c"stripEncrypted", 1, |_, a| {
            item_pass(a[0], ItemPass::Encrypted)
        }),
        (c"fillQueries", 1, |_, a| item_pass(a[0], ItemPass::Queries)),
        (c"stripReferences", 2, |_, a| references::run(a[0], a[1])),
    ];
    for (name, len, run) in methods {
        api.set(
            name,
            function(rules, name.to_str().unwrap(), len, len, run)?,
        )?;
    }
    Ok(api.raw())
}
mod public_api;
