//! Bounded task context retains the latest user request and shrinks excerpts
//! before dropping rows. The rendering ports preserve JS object spread, JSON
//! serialization, and the existing CLI handoff format.
use crate::{
    host_methods::call,
    js_iteration::read,
    js_live::{fields, LiveValue as L},
};
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn tail<'a>(rows: L<'a>, count: u32) -> Result<L<'a>> {
    call(
        rows,
        c"slice",
        &[rows.from_value(&V::Number(-(count as f64)))?],
    )
}

#[napi]
pub fn bounded_context_excerpt(
    env: Env,
    handoff: bool,
    source: Unknown<'_>,
    budget: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let source = L::new(&env, source);
    let budget = L::new(&env, budget);
    let original = call(
        p,
        if handoff {
            c"renderHandoff"
        } else {
            c"renderSnapshot"
        },
        &[source],
    )?;
    let fits = |text| call(p, c"fits", &[text, budget])?.truthy();
    let result = |text, truncated, count: Option<L>| {
        let out = fields(
            p,
            &[
                ("text", text),
                ("truncated", p.from_value(&V::Bool(truncated))?),
            ],
        )?;
        if let Some(count) = count {
            out.set(c"messageCount", count)?;
        }
        Ok(out.raw())
    };
    if fits(original)? {
        let count = if handoff {
            None
        } else {
            Some(read(read(source, c"messages")?, c"length")?)
        };
        return result(original, false, count);
    }
    let checkpoint = if handoff {
        read(source, c"checkpoint")?
    } else {
        source
    };
    let task = if handoff {
        call(p, c"clipTask", &[checkpoint])?
    } else {
        p.from_value(&V::Undefined)?
    };
    let messages = || {
        if !handoff {
            return read(source, c"messages");
        }
        let rows = read(checkpoint, c"transcript")?;
        if rows.truthy()? {
            Ok(rows)
        } else {
            p.from_value(&V::Array(vec![]))
        }
    };
    let mut rows = tail(messages()?, if handoff { 4 } else { 6 })?;
    let user = p.get(c"user")?;
    let request = call(messages()?, c"findLast", &[user])?;
    if request.truthy()?
        && (!handoff || read(rows, c"length")?.truthy()?)
        && !call(rows, c"some", &[user])?.truthy()?
    {
        rows.set_element(0, request)?;
    }
    let mut size = if handoff { 300 } else { 400 };
    loop {
        let limit = p.from_value(&V::Number(size as f64))?;
        let text = if handoff {
            call(p, c"handoffText", &[source, checkpoint, task, rows, limit])?
        } else {
            call(p, c"snapshotText", &[source, rows, limit])?
        };
        if fits(text)? || (handoff && size <= 20) {
            let count = if handoff {
                None
            } else {
                Some(read(rows, c"length")?)
            };
            return result(text, true, count);
        }
        if handoff || size > 40 {
            size /= 2;
        } else if read(rows, c"length")?.number()? > 2.0 {
            rows = tail(rows, 2)?;
        } else {
            return result(original, true, None);
        }
    }
}
