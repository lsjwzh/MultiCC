//! Repository queues are owned by each public RepoActor. Live JS maps keep
//! callback identities and pending Promises observable across the N-API boundary.
mod execution;
mod repository;

use crate::host_methods::{async_result, default_object, function};
use crate::js_live::spread;
use crate::route_response::*;
use napi::bindgen_prelude::ToNapiValue;
use napi_derive::napi;

const TIMEOUT: f64 = 120_000.;
const MAX_BUFFER: f64 = (32 * 1024 * 1024) as f64;

fn undef(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Undefined)
}
fn now(s: L<'_>) -> Result<L<'_>> {
    call(s.global()?.get(c"Date")?, c"now", &[])
}
fn resolved(value: L<'_>) -> Result<L<'_>> {
    call(value.global()?.get(c"Promise")?, c"resolve", &[value])
}
fn or<'e>(value: L<'e>, other: L<'e>) -> Result<L<'e>> {
    Ok(if value.truthy()? { value } else { other })
}

fn ports_key(s: L<'_>) -> Result<L<'_>> {
    call(
        s.global()?.get(c"Symbol")?,
        c"for",
        &[text(s, "multicc.repoActor.ports")?],
    )
}
fn ports(actor: L<'_>) -> Result<L<'_>> {
    actor.get_key(ports_key(actor)?)
}
fn queue<'e>(s: L<'e>, key: L<'e>) -> Result<L<'e>> {
    let queues = s.get(c"queues")?;
    let q = call(queues, c"get", &[key])?;
    if q.truthy()? {
        return Ok(q);
    }
    let q = fields(
        s,
        &[
            ("tail", resolved(undef(s)?)?),
            ("depth", num(s, 0.)?),
            ("running", null(s)?),
        ],
    )?;
    call(queues, c"set", &[key, q])?;
    Ok(q)
}

fn trim(s: L<'_>) -> Result<L<'_>> {
    let ops = s.get(c"operations")?;
    let max = s.get(c"maxOperationHistory")?.number()?;
    if ops.get(c"size")?.number()? > max {
        ops.for_each_while(|entry| {
            let (id, op) = entry.iterator_pair()?;
            let status = op.get(c"status")?;
            if !status.is_string("queued")? && !status.is_string("running")? {
                call(ops, c"delete", &[id])?;
            }
            Ok(ops.get(c"size")?.number()? > max)
        })?;
    }
    undef(s)
}

fn status<'e>(s: L<'e>, id: L<'e>) -> Result<L<'e>> {
    let op = call(s.get(c"operations")?, c"get", &[id])?;
    if !op.truthy()? {
        return null(s);
    }
    let result = spread(op)?;
    result.set(
        c"progress",
        call(s.global()?.get(c"Array")?, c"from", &[op.get(c"progress")?])?,
    )?;
    Ok(result)
}
fn depth<'e>(s: L<'e>, input: L<'e>) -> Result<L<'e>> {
    let queues = s.get(c"queues")?;
    if input.truthy()? {
        let q = call(queues, c"get", &[repository::key(ports(s)?, input)?])?;
        return fallback(q.optional(c"depth")?, V::Number(0.));
    }
    let mut sum = 0.;
    call(queues, c"values", &[])?.for_each(|q| {
        sum += q.get(c"depth")?.number()?;
        Ok(())
    })?;
    num(s, sum)
}
fn lease<'e>(s: L<'e>, id: L<'e>) -> Result<L<'e>> {
    if id.truthy()? {
        fallback(call(s.get(c"leases")?, c"get", &[id])?, V::Null)
    } else {
        null(s)
    }
}

pub(crate) use execution::{context_progress, exec_context_git, run, run_git};
pub(crate) fn uses_default_run(actor: L<'_>) -> Result<bool> {
    actor
        .get(c"run")?
        .equals(ports(actor)?.get(c"originalRun")?)
}

pub(crate) fn uses_default_run_git(actor: L<'_>) -> Result<bool> {
    actor
        .get(c"runGit")?
        .equals(ports(actor)?.get(c"originalRunGit")?)
}

fn public_methods<'e>(env: &'e Env, proto: L<'e>) -> Result<()> {
    let obj = proto.global()?.get(c"Object")?;
    for (name, length, count) in [
        ("_queue", 1, 1),
        ("_trimHistory", 0, 0),
        ("status", 1, 1),
        ("queueDepth", 1, 1),
        ("isLeased", 1, 1),
        ("run", 3, 4),
        ("runGit", 2, 3),
    ] {
        let f = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
            name,
            move |ctx| {
                let s = L::new(ctx.env, ctx.this()?);
                let mut a = Vec::with_capacity(count);
                for i in 0..count {
                    a.push(if i < ctx.length() {
                        L::new(ctx.env, ctx.get(i)?)
                    } else {
                        undef(s)?
                    });
                }
                Ok(match name {
                    "_queue" => queue(s, a[0]),
                    "_trimHistory" => trim(s),
                    "status" => status(s, a[0]),
                    "queueDepth" => depth(s, a[0]),
                    "isLeased" => lease(s, a[0]),
                    "run" => run(s, a[0], a[1], a[2], a[3]),
                    "runGit" => run_git(s, a[0], a[1], a[2]),
                    _ => unreachable!(),
                }?
                .raw())
            },
        )?;
        let f = L::new(env, f.into_unknown(env)?);
        call(
            obj,
            c"defineProperty",
            &[
                f,
                text(proto, "length")?,
                fields(proto, &[("value", num(proto, length as f64)?)])?,
            ],
        )?;
        call(
            obj,
            c"defineProperty",
            &[
                proto,
                text(proto, name)?,
                fields(
                    proto,
                    &[
                        ("value", f),
                        ("writable", flag(proto, true)?),
                        ("configurable", flag(proto, true)?),
                    ],
                )?,
            ],
        )?;
    }
    Ok(())
}

#[napi]
pub fn repo_actor_api(env: Env, host: Unknown<'_>) -> Result<sys::napi_value> {
    let h = L::new(&env, host);
    let environment = spread(h.get(c"process")?.get(c"env")?)?;
    for (key, val) in [
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_ASKPASS", "/usr/bin/false"),
        ("SSH_ASKPASS", "/usr/bin/false"),
        (
            "GIT_SSH_COMMAND",
            "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new -oConnectTimeout=10",
        ),
    ] {
        environment.set_key(text(h, key)?, text(h, val)?)?;
    }
    h.set(c"environment", environment)?;
    let init = function(h, "initializeRepoActor", 2, 2, |h, a| {
        let s = a[0];
        let options = default_object(a[1])?;
        s.set(
            c"execFile",
            or(options.get(c"execFile")?, h.get(c"execFile")?)?,
        )?;
        for key in [c"queues", c"operations", c"leases"] {
            s.set(key, s.global()?.get(c"Map")?.construct(&[])?)?;
        }
        s.set(
            c"maxOperationHistory",
            fallback(options.get(c"maxOperationHistory")?, V::Number(500.))?,
        )?;
        undef(s)
    })?;
    let class = call(h, c"makeClass", &[init])?;
    let proto = class.get(c"prototype")?;
    call(
        h.global()?.get(c"Object")?,
        c"defineProperty",
        &[proto, ports_key(h)?, fields(h, &[("value", h)])?],
    )?;
    public_methods(&env, proto)?;
    h.set(c"originalRunGit", proto.get(c"runGit")?)?;
    h.set(c"originalRun", proto.get(c"run")?)?;
    Ok(fields(
        h,
        &[
            ("RepoActor", class),
            ("defaultRepoActor", class.construct(&[])?),
            (
                "repoKeyFor",
                function(h, "repoKeyFor", 1, 1, |h, a| repository::key(h, a[0]))?,
            ),
            (
                "operationId",
                function(h, "operationId", 0, 1, |h, a| repository::id(h, a[0]))?,
            ),
            ("NONINTERACTIVE_ENV", environment),
            ("DEFAULT_TIMEOUT_MS", num(h, TIMEOUT)?),
            ("DEFAULT_MAX_BUFFER", num(h, MAX_BUFFER)?),
        ],
    )?
    .raw())
}
