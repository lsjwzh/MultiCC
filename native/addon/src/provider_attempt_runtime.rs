//! Per-environment provider attempt API. The private marker and the instance ports stay in V8 so
//! references survive reentrant callbacks without extending the lifetime of a Rust borrow.
use crate::host_api::*;
use crate::host_methods::{arg, env as environment, raw};
use crate::provider_attempt_identity as identity;
use crate::provider_attempt_lifecycle::{
    RustCurrentAttempts, RustMainProducers, RustNonMainProducers, RustProviderAttemptGenerations,
};
use crate::provider_attempt_route::attempt_snapshot;
use napi::bindgen_prelude::{ClassInstance, FromNapiValue, ToNapiValue};
use napi_derive::napi;
use std::ffi::CStr;

mod events;
mod proxy;
mod scrub;

fn slots<'a>(p: L<'a>) -> Result<ClassInstance<'a, RustCurrentAttempts>> {
    let v = p.get(c"currentBySession")?;
    // Only the private port constructed below can supply this instance.
    unsafe { ClassInstance::from_napi_value(v.env(), v.raw()) }
}

fn current<'a>(p: L<'a>, session: L<'a>) -> Result<L<'a>> {
    Ok(raw(p, slots(p)?.get(environment(p), arg(session)?)?))
}

// JS's reference && reference[key] also retains false, zero and the empty string.
fn member<'a>(v: L<'a>, key: &CStr) -> Result<L<'a>> {
    if v.truthy()? {
        v.get(key)
    } else {
        Ok(v)
    }
}

fn matching(record: L<'_>, reference: L<'_>) -> Result<bool> {
    Ok(record.truthy()?
        && reference.truthy()?
        && call(record.get(c"lifecycle")?, c"matches", &[reference])?.truthy()?)
}

fn begin<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let generation = p.get(c"generations")?;
    let generations: ClassInstance<'_, RustProviderAttemptGenerations> =
        unsafe { ClassInstance::from_napi_value(p.env(), generation.raw())? };
    let current = slots(p)?;
    Ok(raw(
        p,
        crate::provider_attempt_creation::provider_begin_attempt(
            environment(p),
            &current,
            &generations,
            arg(default_object(a[0])?)?,
            arg(p)?,
        )?,
    ))
}

fn finish<'a>(p: L<'a>, reference: L<'a>, facts: L<'a>) -> Result<L<'a>> {
    let current = slots(p)?;
    Ok(raw(
        p,
        crate::provider_attempt_route::provider_finish_attempt(
            environment(p),
            &current,
            arg(reference)?,
            arg(default_object(facts)?)?,
            arg(p)?,
        )?,
    ))
}

fn audit<'a>(p: L<'a>, session: L<'a>, event: L<'a>) -> Result<()> {
    let sink = p.get(c"audit")?;
    if sink.truthy()? && session.truthy()? {
        p.catch(|| {
            let payload = spread(event)?;
            payload.set(c"ts", num(p, now(p)?.explicit_number()?)?)?;
            sink.call_plain(&[session, payload.freeze()?])
        })?;
    }
    Ok(())
}

fn new_slot<'a, T: ToNapiValue>(p: L<'a>, value: T) -> Result<L<'a>> {
    Ok(raw(p, unsafe { T::to_napi_value(p.env(), value)? }))
}

fn callback<'a>(opts: L<'a>, key: &CStr) -> Result<L<'a>> {
    if callable(opts.get(key)?)? {
        opts.get(key)
    } else {
        null(opts)
    }
}

fn runtime<'a>(origin: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let now = if callable(opts.get(c"now")?)? {
        opts.get(c"now")?
    } else {
        origin.global()?.get(c"Date")?.get(c"now")?
    };
    let p = fields(
        origin,
        &[
            ("now", now),
            ("nextId", callback(opts, c"nextId")?),
            ("emit", callback(opts, c"emit")?),
            ("audit", callback(opts, c"audit")?),
            (
                "resolveProviderRevision",
                callback(opts, c"resolveProviderRevision")?,
            ),
            (
                "resolveTerminalRoute",
                callback(opts, c"resolveTerminalRoute")?,
            ),
            ("marker", origin.get(c"marker")?),
            ("ProviderAttemptError", origin.get(c"ProviderAttemptError")?),
        ],
    )?;
    let guard = if opts.get(c"quotaGuard")?.truthy()?
        && callable(opts.get(c"quotaGuard")?.get(c"check")?)?
    {
        opts.get(c"quotaGuard")?
    } else {
        null(p)?
    };
    p.set(c"quotaGuard", guard)?;
    let grace = || opts.get(c"producerStaleGraceMs")?.explicit_number();
    let ms = if grace()?.is_finite() && grace()? > 0. {
        grace()?
    } else {
        30_000.
    };
    p.set(c"producerStaleGraceMs", num(p, ms.clamp(5_000., 600_000.))?)?;
    let mut epoch = opts.get(c"runtimeEpoch")?;
    if !epoch.truthy()? {
        epoch = text(
            p,
            &crate::provider_attempt_route::provider_mint_prefixed_id("runtime".into())?,
        )?;
    }
    p.set(
        c"runtimeEpoch",
        identity::required(epoch, "runtimeEpoch", p.get(c"ProviderAttemptError")?)?,
    )?;
    p.set(
        c"currentBySession",
        new_slot(p, RustCurrentAttempts::new())?,
    )?;
    p.set(
        c"generations",
        new_slot(p, RustProviderAttemptGenerations::new())?,
    )?;
    p.set(c"proxyProducers", new_slot(p, RustMainProducers::new())?)?;
    p.set(
        c"nonMainProxyProducers",
        new_slot(p, RustNonMainProducers::new())?,
    )?;
    p.set(c"streamRedactors", p.global()?.get(c"Map")?.construct(&[])?)?;
    p.set(
        c"snapshot",
        function(p, "snapshot", 1, 1, |_, a| attempt_snapshot(a[0]))?,
    )?;
    p.set(
        c"auditOnly",
        function(p, "auditOnly", 2, 2, |p, a| {
            audit(p, a[0], a[1])?;
            undef(p)
        })?,
    )?;
    p.set(
        c"proxyContext",
        function(p, "proxyContext", 0, 1, |p, a| {
            proxy::context(p, default_object(a[0])?)
        })?,
    )?;
    p.set(
        c"poisonProxyAttempt",
        function(p, "poisonProxyAttempt", 2, 2, proxy::poison)?,
    )?;
    defaulted_methods(
        p.freeze()?,
        &[
            ("beginAttempt", 0, 1, begin),
            ("finishAttempt", 1, 2, |p, a| finish(p, a[0], a[1])),
            ("acceptEvent", 1, 1, events::accept),
            ("forceReleaseProducers", 1, 2, |p, a| {
                Ok(raw(
                    p,
                    crate::provider_producers::provider_force_release_producers(
                        environment(p),
                        arg(a[0])?,
                        arg(with_default(a[1], text(p, "force_release")?)?)?,
                        arg(p)?,
                    )?,
                ))
            }),
            ("observeEvent", 2, 2, |p, a| events::observe(p, a[0], a[1])),
            ("observeProxyDelta", 1, 2, proxy::delta),
            ("boundProxyAttempt", 0, 1, |p, a| {
                proxy::bound(p, default_object(a[0])?)
            }),
            ("scrubAttemptStructure", 2, 2, |p, a| {
                scrub::structure(p, a[0], a[1])
            }),
            ("scrubAttemptEvent", 2, 2, scrub::event),
            ("authorizeProxyRequest", 0, 1, |p, a| {
                proxy::authorize(p, default_object(a[0])?, p)
            }),
            ("authorizeProxyRequestAsync", 0, 1, proxy::authorize_async),
            ("onProxyActivity", 0, 1, |p, a| {
                let event = default_object(a[0])?;
                Ok(raw(
                    p,
                    crate::provider_producers::provider_proxy_activity(
                        environment(p),
                        arg(event)?,
                        arg(proxy::context(p, event)?)?,
                        arg(p)?,
                    )?,
                ))
            }),
            ("attributeProxyUsage", 0, 1, |p, a| {
                Ok(raw(
                    p,
                    crate::provider_outcome::provider_attribute_proxy_usage(
                        environment(p),
                        arg(default_object(a[0])?)?,
                        arg(p)?,
                    )?,
                ))
            }),
            ("observeProxyOutcome", 0, 1, |p, a| {
                Ok(raw(
                    p,
                    crate::provider_outcome::provider_observe_proxy_outcome(
                        environment(p),
                        arg(default_object(a[0])?)?,
                        arg(p)?,
                    )?,
                ))
            }),
            ("proxyFailure", 1, 2, |p, a| {
                Ok(raw(
                    p,
                    crate::provider_outcome::provider_proxy_failure(
                        environment(p),
                        arg(a[0])?,
                        arg(default_object(a[1])?)?,
                        arg(p)?,
                    )?,
                ))
            }),
            ("proxySessionId", 1, 1, proxy::session_id),
            ("resolveProxySessionId", 1, 1, |_, a| proxy::resolve(a[0])),
            ("encodeProxyRoute", 2, 2, |_, a| {
                proxy::encode(a[0].clean_text()?, a[1].clean_text()?)
            }),
            ("snapshot", 1, 1, |p, a| {
                attempt_snapshot(current(p, a[0].clean_text()?)?)
            }),
        ],
    )?
    .freeze()
}

fn attempt_fields<'a>(p: L<'a>, r: L<'a>) -> Result<L<'a>> {
    Ok(raw(
        p,
        identity::provider_attempt_fields(
            environment(p),
            arg(r)?,
            arg(p.get(c"ProviderAttemptError")?)?,
        )?,
    ))
}

#[napi]
pub fn provider_attempt_runtime_api(env: Env, error: Unknown<'_>) -> Result<sys::napi_value> {
    let error = L::new(&env, error);
    let marker = error
        .global()?
        .get(c"Symbol")?
        .call_plain(&[text(error, "multicc.hostErrorEnvelope")?])?;
    let p = fields(
        error,
        &[("marker", marker), ("ProviderAttemptError", error)],
    )?;
    let order = fields(
        p,
        &[
            ("none", num(p, 0.)?),
            ("visible_output", num(p, 1.)?),
            ("tool_intent", num(p, 2.)?),
            ("side_effect", num(p, 3.)?),
        ],
    )?
    .freeze()?;
    let api = fields(
        p,
        &[("FENCE_ORDER", order), ("ProviderAttemptError", error)],
    )?;
    let commands = defaulted_methods(
        p,
        &[
            ("createProviderRevision", 0, 1, |p, a| {
                text(
                    p,
                    &identity::revision(default_object(a[0])?, p.get(c"ProviderAttemptError")?)?,
                )
            }),
            ("createProviderAttemptRuntime", 0, 1, runtime),
            ("fenceForEvent", 1, 1, |p, a| {
                text(
                    p,
                    &crate::provider_event_policy::provider_event_fence(
                        environment(p),
                        arg(a[0])?,
                        arg(p.get(c"marker")?)?,
                    )?,
                )
            }),
            ("markHostErrorEnvelope", 1, 1, events::mark),
            ("providerAttemptFields", 1, 1, |p, a| {
                attempt_fields(p, a[0])
            }),
            ("scopeHostProviderEvent", 1, 1, events::scope),
            ("tagProviderAttemptEvent", 2, 2, events::tag),
        ],
    )?;
    api.spread_from(commands)?;
    Ok(api.raw())
}
