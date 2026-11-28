//! Public durable wait and operation services over the selected transactional store.
use crate::{
    host_api::*,
    host_methods::{arg, env, raw},
    js_iteration::read,
    operation_admit_live::{hash, normal},
};
use napi_derive::napi;
use std::ffi::CStr;

pub(super) mod admission;
mod completion;
pub(super) mod operations;
mod queries;
mod tasks;
pub(super) mod waits;

fn join<'a>(p: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let mut units = Vec::new();
    for part in parts {
        units.extend_from_slice(part.coerce_string()?.as_units());
    }
    p.from_value(&V::String(multicc_core::js::JsString::from_units(units)))
}
fn slice<'a>(v: L<'a>, start: f64, end: Option<f64>) -> Result<L<'a>> {
    let mut limits = vec![num(v, start)?];
    if let Some(end) = end {
        limits.push(num(v, end)?);
    }
    call(string(v)?, c"slice", &limits)
}
fn at(p: L<'_>) -> Result<L<'_>> {
    num(p, now(p)?.explicit_number()?)
}
fn copy(v: L<'_>) -> Result<L<'_>> {
    json_call(v, c"parse", json_call(v, c"stringify", v)?)
}
fn write_entry<'a>(object: L<'a>, key: L<'a>, value: L<'a>) -> Result<()> {
    let wrote = call(
        object.global()?.get(c"Reflect")?,
        c"set",
        &[object, key, value, object],
    )?;
    if !wrote.truthy()? {
        return Err(object.type_error("Cannot assign to orchestration record"));
    }
    Ok(())
}
fn public<'a>(v: L<'a>, hidden: &[&CStr], deep: bool) -> Result<L<'a>> {
    if !v.truthy()? {
        return null(v);
    }
    let out = if deep { copy(v)? } else { spread(v)? };
    for key in hidden {
        out.delete(key)?;
    }
    Ok(out)
}
const WAIT_PRIVATE: &[&CStr] = &[c"callbackTokenHash", c"resolutionPayloadHash"];
const OP_PRIVATE: &[&CStr] = &[c"idempotencyKeyHash", c"requestHash", c"resultHash"];

fn transaction<'a>(p: L<'a>, args: &[(&str, L<'a>)], method: &CStr, run: Action) -> Result<L<'a>> {
    let f = fields(p, args)?;
    f.set(c"state", p)?;
    call(p.get(c"store")?, method, &[function(f, "", 1, 1, run)?])
}
fn candidates<'a>(draft: L<'a>, collection: &'static CStr, filter: L<'a>) -> Result<L<'a>> {
    if callable(draft.get(c"select")?)? {
        call(
            draft,
            c"select",
            &[
                text(draft, collection.to_str().unwrap())?,
                fields(draft, &[("where", filter)])?,
            ],
        )
    } else {
        call(
            draft.global()?.get(c"Object")?,
            c"values",
            &[draft.get(collection)?],
        )
    }
}
fn status_result<'a>(operation: L<'a>, idempotent: bool) -> Result<L<'a>> {
    fields(
        operation,
        &[
            ("ok", flag(operation, true)?),
            ("idempotent", flag(operation, idempotent)?),
            ("operation", public(operation, OP_PRIVATE, true)?),
        ],
    )
}
fn missing(s: L<'_>) -> Result<L<'_>> {
    fields(
        s,
        &[("ok", flag(s, false)?), ("code", text(s, "not_found")?)],
    )
}
fn terminal<'a>(p: L<'a>, status: L<'a>, key: &CStr) -> Result<bool> {
    call(p.get(key)?, c"has", &[status])?.truthy()
}
pub(super) fn state<'a>(ports: L<'a>, options: L<'a>, wait: bool) -> Result<L<'a>> {
    let o = default_object(options)?;
    let store = read(o, c"store")?;
    let clock = with_default(read(o, c"now")?, ports.global()?.get(c"Date")?.get(c"now")?)?;
    let crypto = with_default(read(o, c"cryptoImpl")?, ports.get(c"crypto")?)?;
    let factory = read(o, c"idFactory")?;
    let factory = if factory.undefined()? {
        function(crypto, "idFactory", 0, 0, move |crypto, _| {
            join(
                crypto,
                &[
                    text(crypto, if wait { "wait_" } else { "op_" })?,
                    call(crypto, c"randomUUID", &[])?,
                ],
            )
        })?
    } else {
        factory
    };
    let p = spread(ports)?;
    p.set(c"store", store)?;
    p.set(c"now", clock)?;
    p.set(c"cryptoImpl", crypto)?;
    p.set(c"idFactory", factory)?;
    if wait {
        let token = read(o, c"callbackTokenFactory")?;
        let token = if token.undefined()? {
            function(crypto, "callbackTokenFactory", 0, 0, |c, _| {
                call(
                    call(c, c"randomBytes", &[num(c, 32.)?])?,
                    c"toString",
                    &[text(c, "base64url")?],
                )
            })?
        } else {
            token
        };
        p.set(c"tokenFactory", token)?;
        p.set(
            c"base",
            with_default(read(o, c"callbackBaseUrl")?, text(o, "")?)?,
        )?;
        p.set(c"urlFactory", read(o, c"callbackUrlFactory")?)?;
    }
    if !store.truthy()? || !callable(store.get(c"mutate")?)? || !callable(store.get(c"read")?)? {
        return Err(o.type_error(if wait {
            "[wait-service] create requires an orchestration store"
        } else {
            "[operation-service] orchestration store is required"
        }));
    }
    Ok(p)
}
fn default_id<'a>(p: L<'a>, v: L<'a>) -> Result<L<'a>> {
    if v.undefined()? {
        p.get(c"idFactory")?.call_plain(&[])
    } else {
        Ok(v)
    }
}
fn result_outbox<'a>(
    p: L<'a>,
    draft: L<'a>,
    id: L<'a>,
    session: L<'a>,
    payload: L<'a>,
    source: L<'a>,
    time: L<'a>,
) -> Result<()> {
    crate::outbox_runtime::admit::insert(
        draft,
        id,
        session,
        payload,
        source,
        time,
        time,
        (p.get(c"crypto")?, p.get(c"outboxConflict")?),
    )?;
    Ok(())
}

#[napi]
pub fn orchestration_services_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let terminal = array(p)?;
    for s in ["completed", "failed", "interrupted", "cancelled"] {
        call(terminal, c"push", &[text(p, s)?])?;
    }
    let set = p.global()?.get(c"Set")?;
    p.set(c"TERMINAL_OPERATION_STATES", set.construct(&[terminal])?)?;
    p.set(c"TERMINAL_TASK_STATES", set.construct(&[terminal])?)?;
    let api = pick(
        p,
        &[
            c"OperationConflictError",
            c"TERMINAL_OPERATION_STATES",
            c"TERMINAL_TASK_STATES",
        ],
    )?;
    api.spread_from(defaulted_methods(
        p,
        &[
            ("createWaitService", 0, 1, waits::create),
            ("createOperationService", 0, 1, operations::create),
            ("taskRecordId", 2, 3, |p, a| {
                tasks::record_id(a[0], a[1], with_default(a[2], p.get(c"crypto")?)?)
            }),
        ],
    )?)?;
    Ok(api.raw())
}
