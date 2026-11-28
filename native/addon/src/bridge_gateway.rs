//! IM shared gateway owner. Node supplies SDK/IO handles only; policy, state,
//! lifecycle order and asynchronous continuations execute here.
use crate::host_api::*;
use multicc_core::{bridge_gateway as rules, js::JsString};
use napi_derive::napi;
use std::{cell::RefCell, rc::Rc};
mod chat;
mod lifecycle;
mod stores;

fn js_text<'a>(p: L<'a>, value: &JsString) -> Result<L<'a>> {
    p.from_value(&V::String(value.clone()))
}
fn input(v: L<'_>, falsy_empty: bool) -> Result<JsString> {
    string(if falsy_empty {
        fallback(v, "".into())?
    } else {
        v
    })?
    .coerce_string()
}
fn defaults<'a>(
    options: L<'a>,
    ports: L<'a>,
    keys: &[(&std::ffi::CStr, Option<L<'a>>)],
) -> Result<L<'a>> {
    let p = fields(ports, &[("ports", ports)])?;
    for &(key, default) in keys {
        let v = options.get(key)?;
        p.set(
            key,
            match default {
                Some(other) => with_default(v, other)?,
                None => v,
            },
        )?;
    }
    Ok(p)
}
fn date_now(p: L<'_>) -> Result<L<'_>> {
    call(p.global()?.get(c"Date")?, c"now", &[])
}
fn iso_now(p: L<'_>) -> Result<L<'_>> {
    call(
        p.global()?.get(c"Date")?.construct(&[])?,
        c"toISOString",
        &[],
    )
}
fn log<'a>(p: L<'a>, kind: &str, message: L<'a>) -> Result<L<'a>> {
    p.get(c"log")?.call_plain(&[text(p, kind)?, message])
}
fn concat<'a>(p: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let mut out = JsString::new();
    for part in parts {
        out.push(&part.coerce_string()?);
    }
    js_text(p, &out)
}
fn fail<'a>(p: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    Err(p
        .global()?
        .get(c"Error")?
        .construct(&[concat(p, parts)?])?
        .throw_error())
}
fn chunk<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[1])?;
    let max = opts.get(c"max")?;
    let prefix = opts.get(c"continuationPrefix")?;
    if !max.truthy()? || max.number()? < 1. {
        return Err(p.type_error("chunkOutbound: max chunk length required"));
    }
    let bodies = rules::chunks(&input(a[0], true)?, max.number()?);
    let out = array(p)?;
    for (i, body) in bodies.iter().enumerate() {
        let body = js_text(p, body)?;
        let value = if i == 0 {
            body
        } else {
            let prefix = if prefix.undefined()? {
                text(p, &format!("(续{}) ", i + 1))?
            } else {
                prefix.call_plain(&[num(p, i as f64)?])?
            };
            concat(p, &[prefix, body])?
        };
        out.set_element(i as u32, value)?;
    }
    Ok(out)
}

#[napi]
pub fn bridge_gateway_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = fields(
        p,
        &[(
            "DISPATCH_MARKER_RE",
            p.global()?
                .get(c"RegExp")?
                .construct(&[text(p, rules::DISPATCH_PATTERN)?, text(p, "g")?])?,
        )],
    )?;
    let functions = defaulted_methods(
        p,
        &[
            ("stripDispatchMarkers", 1, 1, |p, a| {
                js_text(p, &rules::strip(&input(a[0], true)?))
            }),
            ("hashText", 1, 1, |p, a| {
                js_text(p, &rules::hash(&input(a[0], false)?))
            }),
            ("createEchoStore", 0, 1, stores::echo),
            ("createLogStore", 0, 1, stores::logs),
            ("createGatewayLifecycle", 1, 1, lifecycle::create),
            ("createChatWsClient", 0, 1, chat::create),
            ("chunkOutbound", 1, 2, chunk),
        ],
    )?;
    api.spread_from(functions)?;
    api.set(
        c"deps",
        fields(
            p,
            &[
                ("fs", p.get(c"fs")?),
                ("path", p.get(c"path")?),
                ("os", p.get(c"os")?),
                ("crypto", p.get(c"crypto")?),
            ],
        )?,
    )?;
    Ok(api.raw())
}
