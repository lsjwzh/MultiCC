//! The editor uses the injected filesystem so desktop/web hosts, failure
//! injection and custom path implementations see the same operations.
use crate::{host_methods::function, route_response::*};
use multicc_core::{
    docs_memory_routes as policy, js::JsString, memory_markdown, public_safety, token_estimate,
};
use napi_derive::napi;
use std::ffi::CStr;
mod files;
type Method = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;

fn bind<'a>(owner: L<'a>, api: L<'a>, name: &'static str, argc: usize, run: Method) -> Result<()> {
    api.define_key(text(api, name)?, function(owner, name, argc, argc, run)?)
}
fn callable(obj: L<'_>, name: &CStr) -> Result<bool> {
    Ok(obj.optional(name)?.kind()? == sys::ValueType::napi_function)
}
fn validate(deps: L<'_>) -> Result<L<'_>> {
    if deps.kind()? != sys::ValueType::napi_object {
        return Err(deps.type_error("memory browser route dependencies are required"));
    }
    for (key, methods) in [
        (
            c"fs",
            [
                c"existsSync",
                c"readFileSync",
                c"readdirSync",
                c"realpathSync",
                c"statSync",
                c"unlinkSync",
            ]
            .as_slice(),
        ),
        (
            c"path",
            [c"basename", c"dirname", c"join", c"relative", c"resolve"].as_slice(),
        ),
    ] {
        for name in methods {
            if !callable(deps.get(key)?, name)? {
                return Err(deps.type_error(&format!(
                    "memory browser dependency missing: {}.{}",
                    key.to_string_lossy(),
                    name.to_string_lossy()
                )));
            }
        }
    }
    if deps
        .get(c"memoryStoreRoot")?
        .string()?
        .is_none_or(|s| s.trim().is_empty())
    {
        return Err(deps.type_error("memory browser dependency missing: memoryStoreRoot"));
    }
    for key in [c"directories", c"persistedSessions"] {
        if !callable(deps.get(key)?, c"get")? {
            return Err(deps.type_error(&format!(
                "memory browser dependency missing: {}",
                key.to_string_lossy()
            )));
        }
    }
    for key in [c"workspaceBroadcast", c"now"] {
        if !callable(deps, key)? {
            return Err(deps.type_error(&format!(
                "memory browser dependency missing: {}",
                key.to_string_lossy()
            )));
        }
    }
    Ok(deps)
}
pub(crate) fn public_failure<'a>(prefix: L<'a>, error: L<'a>) -> Result<L<'a>> {
    let mut fallback = prefix.coerce_string()?;
    fallback.push_str(" failed");
    let mut message = fallback.clone();
    if error.truthy()? && error.get(c"message")?.kind()? == sys::ValueType::napi_string {
        message.push_str(": ");
        message.push(&error.get(c"message")?.coerce_string()?);
    }
    prefix.from_value(&V::String(public_safety::sanitize_public_live_text(
        Some(&message),
        Some(&fallback),
    )))
}
fn content(v: L<'_>) -> Result<JsString> {
    if v.nullish()? {
        Ok(JsString::new())
    } else {
        string(v)?.coerce_string()
    }
}
fn markdown<'a>(raw: L<'a>, slug: L<'a>) -> Result<L<'a>> {
    let input = content(raw)?;
    // Avoid coercing an injected slug unless the title actually falls back.
    let mut parsed = memory_markdown::parse_units(&input, &JsString::new());
    if parsed.fallback_slug {
        let key = string(fallback(slug, "".into())?)?.coerce_string()?;
        parsed = memory_markdown::parse_units(&input, &key);
        if parsed.fallback_slug && slug.kind()? != sys::ValueType::napi_string {
            return Err(slug.type_error("title.replace is not a function"));
        }
    }
    let links = fields(raw, &[])?;
    for (k, count) in parsed.links {
        let key = raw.from_value(&V::String(k))?;
        let old = links.get_key(key)?;
        if old.truthy()? {
            // Ordinary objects inherit methods such as toString; the source
            // applies JS + to that initial value. __proto__'s setter ignores it.
            let mut value = old.coerce_string()?;
            value.push_str(&"1".repeat(count as usize));
            links.set_key(key, raw.from_value(&V::String(value))?)?;
        } else {
            links.set_key(key, num(raw, count.into())?)?
        }
    }
    fields(
        raw,
        &[
            ("title", raw.from_value(&V::String(parsed.title))?),
            ("summary", raw.from_value(&V::String(parsed.summary))?),
            ("type", raw.from_value(&V::String(parsed.kind))?),
            ("links", links),
        ],
    )
}
#[napi]
pub fn memory_browser_api(env: Env, anchor: Unknown<'_>) -> Result<sys::napi_value> {
    let owner = L::new(&env, anchor);
    let api = fields(
        owner,
        &[
            (
                "MEM_GRAPH_MAX_NODES",
                num(owner, policy::MEM_GRAPH_MAX_NODES as f64)?,
            ),
            (
                "MEM_TREE_MAX_FILES",
                num(owner, policy::MEM_TREE_MAX_FILES as f64)?,
            ),
            (
                "MEMORY_FILE_MAX_CHARS",
                num(owner, policy::MEMORY_FILE_MAX_CHARS as f64)?,
            ),
        ],
    )?;
    for (name, argc, run) in [
        (
            "assertMemoryBrowserDeps",
            1,
            (|_, a| validate(a[0])) as Method,
        ),
        ("createMemoryBrowserRoutes", 1, |_, a| create(a[0])),
        ("estimateMemTokens", 1, |o, a| {
            num(
                o,
                token_estimate::estimate(content(a[0])?.into_units()) as f64,
            )
        }),
        ("memNodeKind", 2, |o, a| {
            if a[1].truthy()? {
                Ok(a[1])
            } else {
                text(
                    o,
                    &memory_markdown::node_kind(
                        &string(a[0])?.coerce_string()?.to_string_lossy(),
                        "",
                    ),
                )
            }
        }),
        ("parseMemoryMarkdown", 2, |_, a| markdown(a[0], a[1])),
        ("publicFailure", 2, |_, a| public_failure(a[0], a[1])),
    ] {
        bind(owner, api, name, argc, run)?
    }
    Ok(api.raw())
}
fn create(deps: L<'_>) -> Result<L<'_>> {
    validate(deps)?;
    let fs = deps.get(c"fs")?;
    let path = deps.get(c"path")?;
    let root = call(path, c"resolve", &[deps.get(c"memoryStoreRoot")?])?;
    let state = fields(
        deps,
        &[("deps", deps), ("fs", fs), ("path", path), ("root", root)],
    )?;
    let api = fields(state, &[])?;
    crate::memory_browser_graph::attach(api, deps, root)?;
    for (name, argc, run) in [
        (
            "resolveMemoryFilePath",
            1,
            (|s, a| files::resolve(s, a[0])) as Method,
        ),
        ("pathFacts", 1, |s, a| files::facts(s, a[0])),
        ("readMemoryFile", 1, |s, a| files::read(s, a[0])),
        ("writeMemoryFile", 2, |s, a| files::write(s, a[0], a[1])),
        ("deleteMemoryFile", 1, |s, a| files::delete(s, a[0])),
    ] {
        bind(state, api, name, argc, run)?
    }
    api.freeze()
}
