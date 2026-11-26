//! Transactions execute synchronously through the injected store. Bodies are
//! copied once by the existing V8 JSON port; replay returns the stored object.
use crate::{host_methods::function, js_live::spread, route_response::*};
use napi_derive::napi;
fn failure(p: L<'_>, code: &str) -> napi::Error {
    let build = || -> Result<L<'_>> {
        let code = text(p, code)?;
        let error = p.global()?.get(c"Error")?.construct(&[code])?;
        error.set(c"code", code)?;
        Ok(error)
    };
    match build() {
        Ok(error) => error.throw_error(),
        Err(error) => error,
    }
}
fn id(p: L<'_>) -> Result<L<'_>> {
    if let Some(s) = p.string()? {
        let bytes = s.as_units();
        let alnum = |v: u16| matches!(v,48..=57|65..=90|97..=122);
        if (1..=160).contains(&bytes.len())
            && alnum(bytes[0])
            && bytes
                .iter()
                .all(|&c| alnum(c) || matches!(c, 95 | 46 | 58 | 45))
        {
            return Ok(p);
        }
    }
    Err(failure(p, "invalid_record_id"))
}
fn kind(p: L<'_>) -> Result<String> {
    let s = p.string()?.unwrap_or_default().to_string_lossy();
    if matches!(
        s.as_str(),
        "run-result" | "integration" | "writer-barrier" | "separation-application"
    ) {
        Ok(s)
    } else {
        Err(failure(p, "invalid_fact_kind"))
    }
}
fn get<'a>(p: L<'a>, kind: &str, key: L<'a>) -> Result<L<'a>> {
    call(
        p.get(c"store")?,
        c"get",
        &[text(p, &format!("task-first:{kind}"))?, id(key)?],
    )
}
fn set<'a>(p: L<'a>, kind: &str, key: L<'a>, v: L<'a>) -> Result<()> {
    call(
        p.get(c"store")?,
        c"set",
        &[text(p, &format!("task-first:{kind}"))?, key, v],
    )?;
    Ok(())
}
fn equal(p: L<'_>, a: L<'_>, b: L<'_>) -> Result<bool> {
    p.get(c"equal")?.call_plain(&[a, b])?.truthy()
}
fn in_transaction<'a>(
    p: L<'a>,
    context: L<'a>,
    op: for<'b> fn(L<'b>, L<'b>) -> Result<L<'b>>,
) -> Result<L<'a>> {
    let tx = fields(p, &[("ports", p), ("context", context)])?;
    call(
        p.get(c"store")?,
        c"transaction",
        &[function(tx, "", 0, 0, move |tx, _| {
            op(tx.get(c"ports")?, tx.get(c"context")?)
        })?],
    )
}
fn value_copy(value: L<'_>) -> Result<L<'_>> {
    let json = value.global()?.get(c"JSON")?;
    let check = function(value, "", 2, 2, |p, a| {
        use sys::ValueType::*;
        let item = a[1];
        if matches!(
            item.kind()?,
            napi_undefined | napi_function | napi_symbol | napi_bigint
        ) || item.number_value()?.is_some_and(|n| !n.is_finite())
        {
            return Err(failure(p, "invalid_record_value"));
        }
        Ok(item)
    })?;
    let result = call(json, c"stringify", &[value, check])?;
    if !result.truthy()?
        || call(value.global()?.get(c"Buffer")?, c"byteLength", &[result])?.number()? > 1048576.
    {
        return Err(failure(value, "invalid_record_value"));
    }
    call(json, c"parse", &[result])
}
fn append<'a>(p: L<'a>, a: &[L<'a>]) -> Result<L<'a>> {
    kind(a[0])?;
    let body = value_copy(a[1])?;
    id(body.optional(c"id")?)?;
    in_transaction(
        p,
        fields(p, &[("kind", a[0]), ("body", body)])?,
        |p, ctx| {
            let kind = kind(ctx.get(c"kind")?)?;
            let body = ctx.get(c"body")?;
            let key = body.get(c"id")?;
            let prev = get(p, &kind, key)?;
            if prev.truthy()? {
                if !equal(p, prev, body)? {
                    return Err(failure(p, "immutable_fact_conflict"));
                }
                Ok(prev)
            } else {
                set(p, &kind, key, body)?;
                Ok(body)
            }
        },
    )
}
fn proposal<'a>(p: L<'a>, draft: L<'a>) -> Result<L<'a>> {
    let body = value_copy(draft)?;
    for key in [c"id", c"runId", c"attemptId", c"sourceTaskId"] {
        id(body.optional(key)?)?;
    }
    in_transaction(p, body, |p, body| {
        let key = body.get(c"id")?;
        let prev = get(p, "proposal", key)?;
        if prev.truthy()? {
            if !equal(p, prev.get(c"definition")?, body)? {
                return Err(failure(p, "proposal_definition_conflict"));
            }
            return Ok(prev);
        }
        let record = fields(
            p,
            &[
                ("id", key),
                ("definition", body),
                ("state", text(p, "pending")?),
                ("version", num(p, 1.)?),
                ("evaluation", null(p)?),
            ],
        )?;
        set(p, "proposal", key, record)?;
        Ok(record)
    })
}
fn positive_integer(v: L<'_>, max: f64) -> Result<bool> {
    Ok(v.number_value()?
        .is_some_and(|n| n >= 1. && n <= max && n.fract() == 0.))
}
fn evaluate<'a>(p: L<'a>, a: &[L<'a>]) -> Result<L<'a>> {
    let key = id(a[0])?;
    let event_id = id(a[3])?;
    let version = a[1];
    if !positive_integer(version, 9007199254740991.)? {
        return Err(failure(p, "expected_version_required"));
    }
    let body = value_copy(a[2])?;
    let state = body.optional(c"state")?.string()?.unwrap_or_default();
    let ready = state == "ready";
    let valid_state = ready || state == "pending" || state == "stale" || state == "rejected";
    let valid = valid_state
        && body.get(c"eligible")?.equals(flag(p, ready)?)?
        && body.get(c"requiresAtomicRecheck")?.is_true()?
        && body.get(c"blockers")?.is_array()?;
    if !valid {
        return Err(failure(p, "invalid_evaluation"));
    }
    let blockers = body.get(c"blockers")?;
    let mut strings = true;
    blockers.for_each_while(|b| {
        strings = b.kind()? == sys::ValueType::napi_string;
        Ok(strings)
    })?;
    if !strings || ready && blockers.get(c"length")?.truthy()? {
        return Err(failure(p, "invalid_evaluation"));
    }
    let intent = fields(
        p,
        &[
            ("proposalId", key),
            ("expectedVersion", version),
            ("evaluation", body),
        ],
    )?;
    in_transaction(
        p,
        fields(p, &[("intent", intent), ("eventId", event_id)])?,
        |p, ctx| {
            let intent = ctx.get(c"intent")?;
            let event_id = ctx.get(c"eventId")?;
            let event = get(p, "event", event_id)?;
            if event.truthy()? {
                if !equal(p, event.get(c"intent")?, intent)? {
                    return Err(failure(p, "event_id_conflict"));
                }
                return event.get(c"result");
            }
            let key = intent.get(c"proposalId")?;
            let prev = get(p, "proposal", key)?;
            if !prev.truthy()? {
                return Err(failure(p, "proposal_not_found"));
            }
            let version = intent.get(c"expectedVersion")?;
            if !prev.get(c"version")?.equals(version)? {
                return Err(failure(p, "proposal_version_conflict"));
            }
            let state = prev.get(c"state")?;
            if !state.is_string("pending")? && !state.is_string("ready")? {
                return Err(failure(p, "proposal_terminal"));
            }
            let body = intent.get(c"evaluation")?;
            let record = spread(prev)?;
            for (k, v) in [
                ("state", body.get(c"state")?),
                ("evaluation", body),
                (
                    "version",
                    p.get(c"increment")?.call_plain(&[prev.get(c"version")?])?,
                ),
            ] {
                record.define_key(text(p, k)?, v)?;
            }
            set(p, "proposal", key, record)?;
            set(
                p,
                "event",
                event_id,
                fields(
                    p,
                    &[
                        ("id", event_id),
                        ("type", text(p, "attribution.evaluated")?),
                        ("delivery", text(p, "pending")?),
                        ("intent", intent),
                        ("result", record),
                    ],
                )?,
            )?;
            Ok(record)
        },
    )
}
#[napi]
pub fn task_fact_repository(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let store = p.get(c"store")?;
    for name in [c"get", c"set", c"list", c"transaction"] {
        if store.optional(name)?.kind()? != sys::ValueType::napi_function {
            return Err(p.type_error("transactional store required"));
        }
    }
    let methods = fields(
        p,
        &[
            (
                "appendFact",
                function(p, "appendFact", 2, 2, |p, a| append(p, a))?,
            ),
            (
                "createProposal",
                function(p, "createProposal", 1, 1, |p, a| proposal(p, a[0]))?,
            ),
            (
                "evaluate",
                function(p, "evaluate", 4, 4, |p, a| evaluate(p, a))?,
            ),
            (
                "pendingEvents",
                function(p, "pendingEvents", 0, 1, |p, a| {
                    let limit = if a[0].undefined()? {
                        num(p, 100.)?
                    } else {
                        a[0]
                    };
                    if !positive_integer(limit, 1000.)? {
                        return Err(failure(p, "invalid_limit"));
                    }
                    let rows = call(p.get(c"store")?, c"list", &[text(p, "task-first:event")?])?;
                    let test = function(p, "", 1, 1, |p, a| {
                        flag(p, a[0].get(c"delivery")?.is_string("pending")?)
                    })?;
                    call(
                        call(rows, c"filter", &[test])?,
                        c"slice",
                        &[num(p, 0.)?, limit],
                    )
                })?,
            ),
            (
                "acknowledge",
                function(p, "acknowledge", 1, 1, |p, a| {
                    in_transaction(p, a[0], |p, key| {
                        let event = get(p, "event", key)?;
                        if !event.truthy()? {
                            return Err(failure(p, "event_not_found"));
                        }
                        if !event.get(c"delivery")?.is_string("acknowledged")? {
                            let copy = spread(event)?;
                            copy.define_key(text(p, "delivery")?, text(p, "acknowledged")?)?;
                            set(p, "event", key, copy)?;
                        }
                        fields(p, &[("id", key), ("acknowledged", flag(p, true)?)])
                    })
                })?,
            ),
            (
                "getProposal",
                function(p, "getProposal", 1, 1, |p, a| get(p, "proposal", a[0]))?,
            ),
            (
                "getFact",
                function(p, "getFact", 2, 2, |p, a| get(p, &kind(a[0])?, a[1]))?,
            ),
        ],
    )?;
    Ok(methods.raw())
}
