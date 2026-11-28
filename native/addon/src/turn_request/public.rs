//! Project just the public request fields before crossing the live value bridge.
//! Caller-owned identity, origin and route objects go back into sealed results.
use super::{deep_freeze, request, route_proof};
use crate::host_api::*;
use multicc_core::{cli_capability, turn_request};
use napi_derive::napi;
use std::ffi::CStr;

fn project<'a>(value: L<'a>, names: &[&CStr]) -> Result<L<'a>> {
    let out = fields(value, &[])?;
    for name in names {
        out.set(name, crate::js_iteration::read(value, name)?)?;
    }
    Ok(out)
}

fn reject(p: L<'_>, code: &str, message: &str) -> Result<napi::Error> {
    Ok(p.get(c"TurnRequestError")?
        .construct(&[text(p, code)?, text(p, message)?])?
        .throw_error())
}

fn normalized(p: L<'_>, input: L<'_>) -> Result<()> {
    if !input.truthy()? || !input.get(c"kind")?.is_string(turn_request::REQUEST_KIND)? {
        return Err(reject(
            p,
            "invalid_request",
            "normalizeTurnRequest must be called first",
        )?);
    }
    Ok(())
}

fn kernel<'a>(p: L<'a>, op: &str, payload: L<'a>) -> Result<L<'a>> {
    let answer = request(op, payload)?;
    if !answer.get(c"ok")?.truthy()? {
        let error = answer.get(c"error")?;
        return Err(p
            .get(c"TurnRequestError")?
            .construct(&[error.get(c"code")?, error.get(c"message")?])?
            .throw_error());
    }
    answer.get(c"value")
}

fn normalize<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let input = args[0];
    if !object(input)? || input.is_array()? {
        return Err(reject(
            p,
            "invalid_request",
            "turn request must be an object",
        )?);
    }
    let obj = input.global()?.get(c"Object")?;
    for key in turn_request::FORBIDDEN_FIELDS {
        if call(obj, c"hasOwn", &[input, text(input, key)?])?.truthy()? {
            return Err(reject(
                p,
                "secret_field_forbidden",
                &format!("{key} must not enter the turn core"),
            )?);
        }
    }
    let input = project(
        input,
        &[
            c"sessionId",
            c"text",
            c"cli",
            c"turnCount",
            c"hasNativeSession",
            c"originDispatchId",
            c"originTrigger",
            c"originContinue",
            c"deliveryId",
            c"clientMsgId",
            c"requestId",
            c"taskId",
            c"taskStart",
            c"taskSource",
            c"taskText",
            c"bgTaskIds",
            c"bgToolUseIds",
        ],
    )?;
    deep_freeze(kernel(
        p,
        "normalize",
        fields(
            p,
            &[("input", input), ("residentClis", p.get(c"residentClis")?)],
        )?,
    )?)
}

fn request_ref(v: L<'_>) -> Result<L<'_>> {
    project(v, &[c"kind", c"sessionId", c"requestId"])
}

fn admission<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let req = args[0];
    normalized(p, req)?;
    let reference = request_ref(req)?;
    let facts = project(
        default_object(args[1])?,
        &[
            c"duplicateSeen",
            c"duplicatePersisted",
            c"shuttingDown",
            c"sessionExists",
            c"runningTurn",
            c"backgroundWorkActive",
        ],
    )?;
    let out = kernel(
        p,
        "admission",
        fields(p, &[("request", reference), ("facts", facts)])?,
    )?;
    if out.get(c"decision")?.is_string("prepare")? {
        let effect = out.get(c"effects")?.element(0)?;
        effect.assign(c"identity", req.get(c"identity")?)?;
        effect.assign(c"origin", req.get(c"origin")?)?;
    }
    deep_freeze(out)
}

fn optional_fields<'a>(value: L<'a>, keys: &[&CStr]) -> Result<L<'a>> {
    if value.truthy()? {
        project(value, keys)
    } else {
        undef(value)
    }
}

fn guard<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let req = args[0];
    normalized(p, req)?;
    let proofs = default_object(args[1])?;
    let message = crate::js_iteration::read(proofs, c"message")?;
    let route = proofs.get(c"route")?;
    let runtime = proofs.get(c"runtime")?;
    let reference = project(req, &[c"kind", c"sessionId", c"cli"])?;
    reference.set(
        c"transport",
        crate::js_iteration::read(req.get(c"execution")?, c"transport")?,
    )?;
    reference.set(
        c"historyIntent",
        crate::js_iteration::read(req.get(c"execution")?, c"historyIntent")?,
    )?;
    let message = optional_fields(message, &[c"kind", c"sessionId", c"durable"])?;
    let route_facts = optional_fields(
        route,
        &[
            c"kind",
            c"sessionId",
            c"cli",
            c"transport",
            c"resolved",
            c"turnId",
            c"route",
        ],
    )?;
    let runtime = optional_fields(runtime, &[c"kind", c"sessionId", c"claimed", c"turnId"])?;
    let frozen = route.truthy()?
        && route.get(c"route")?.truthy()?
        && call(
            p.global()?.get(c"Object")?,
            c"isFrozen",
            &[route.get(c"route")?],
        )?
        .truthy()?;
    let out = kernel(
        p,
        "spawnGuard",
        fields(
            p,
            &[
                ("request", reference),
                ("message", message),
                ("route", route_facts),
                ("runtime", runtime),
                ("routeFrozen", flag(p, frozen)?),
            ],
        )?,
    )?;
    if out.get(c"ok")?.truthy()? {
        out.get(c"effect")?.assign(c"route", route.get(c"route")?)?;
    }
    deep_freeze(out)
}

#[napi]
pub fn turn_request_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let resident: Vec<_> = cli_capability::CAPABILITIES
        .iter()
        .map(|(id, _)| *id)
        .chain(cli_capability::ALIASES.iter().map(|(id, _)| *id))
        .filter(|id| cli_capability::transport_of(id) == "claude-stream")
        .map(V::from)
        .collect();
    p.set(
        c"residentClis",
        p.from_value(&V::Array(resident))?.freeze()?,
    )?;
    let api = fields(
        p,
        &[
            ("REQUEST_KIND", text(p, turn_request::REQUEST_KIND)?),
            ("TurnRequestError", p.get(c"TurnRequestError")?),
        ],
    )?;
    api.spread_from(defaulted_methods(
        p,
        &[
            ("normalizeTurnRequest", 1, 1, normalize),
            ("planTurnAdmission", 1, 2, admission),
            ("createDurableMessageProof", 1, 2, |p, a| {
                normalized(p, a[0])?;
                let reference = request_ref(a[0])?;
                let evidence = project(default_object(a[1])?, &[c"persisted"])?;
                deep_freeze(kernel(
                    p,
                    "messageProof",
                    fields(p, &[("request", reference), ("evidence", evidence)])?,
                )?)
            }),
            ("createProviderRouteProof", 1, 2, |p, a| {
                route_proof(
                    a[0],
                    default_object(a[1])?,
                    p.get(c"assertProviderBinding")?,
                    p.get(c"TurnRequestError")?,
                )
            }),
            ("evaluateSpawnGuard", 1, 2, guard),
        ],
    )?)?;
    Ok(api.raw())
}
