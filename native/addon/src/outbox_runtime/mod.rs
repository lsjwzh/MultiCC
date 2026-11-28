//! Durable outbox over live store transactions, clocks, and the host crypto interface.
pub(crate) mod admit;
mod mutations;
mod queries;
use crate::{
    host_api::*,
    js_iteration::read,
    operation_admit_live::{hash, normal},
    wait_canonical::{canonical, canonical_live},
    wait_resolve_live::token_equal,
};
use napi_derive::napi;

fn safe_integer(v: L<'_>) -> Result<bool> {
    Ok(v.number_value()?
        .is_some_and(|n| n.fract() == 0. && n.abs() <= 9_007_199_254_740_991.))
}
fn finite(v: L<'_>) -> Result<bool> {
    Ok(v.number_value()?.is_some_and(f64::is_finite))
}
fn at(p: L<'_>) -> Result<L<'_>> {
    num(p, now(p)?.explicit_number()?)
}

fn retry_delay<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let value = if p.get(c"customBackoff")?.truthy()? {
        p.get(c"backoff")?.call_plain(&[a[0]])?.explicit_number()?
    } else {
        let math = p.global()?.get(c"Math")?;
        let min = math.get(c"min")?;
        let max = p.get(c"maxBackoffMs")?;
        let base = p.get(c"baseBackoffMs")?;
        let exponent =
            call(math, c"max", &[num(p, 0.)?, num(p, a[0].number()? - 1.)?])?.number()?;
        let scaled = base.number()? * 2f64.powf(exponent);
        min.call(math, &[max, num(p, scaled)?])?.explicit_number()?
    };
    if !value.is_finite() || value < 0. {
        return Err(p.type_error("[outbox] backoff must return a non-negative finite number"));
    }
    num(p, value)
}
fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let store = read(opts, c"store")?;
    let clock = read(opts, c"now")?;
    let clock = if clock.undefined()? {
        ports.global()?.get(c"Date")?.get(c"now")?
    } else {
        clock
    };
    let default_crypto = ports.get(c"crypto")?;
    let crypto = with_default(read(opts, c"cryptoImpl")?, default_crypto)?;
    let id_factory = read(opts, c"idFactory")?;
    let id_factory = if id_factory.undefined()? {
        function(crypto, "idFactory", 0, 0, |c, _| {
            let mut result = multicc_core::js::JsString::from_rust_str("outbox_");
            let uuid = call(c, c"randomUUID", &[])?.coerce_string()?;
            result = multicc_core::js::JsString::concat(&[&result, &uuid]);
            c.from_value(&V::String(result))
        })?
    } else {
        id_factory
    };
    let token_factory = read(opts, c"leaseTokenFactory")?;
    let token_factory = if token_factory.undefined()? {
        function(crypto, "leaseTokenFactory", 0, 0, |c, _| {
            let bytes = call(c, c"randomBytes", &[num(c, 24.)?])?;
            call(bytes, c"toString", &[text(c, "base64url")?])
        })?
    } else {
        token_factory
    };
    let lease = with_default(read(opts, c"leaseMs")?, num(ports, 30000.)?)?;
    let attempts = with_default(read(opts, c"maxAttempts")?, num(ports, 5.)?)?;
    let base = with_default(read(opts, c"baseBackoffMs")?, num(ports, 1000.)?)?;
    let max = with_default(read(opts, c"maxBackoffMs")?, num(ports, 60000.)?)?;
    let backoff = read(opts, c"backoff")?;
    if !store.truthy()? || !callable(store.get(c"mutate")?)? || !callable(store.get(c"read")?)? {
        return Err(ports.type_error("[outbox] create requires an orchestration store"));
    }
    if !finite(lease)? || lease.number()? <= 0. {
        return Err(ports.type_error("[outbox] leaseMs must be > 0"));
    }
    if !safe_integer(attempts)? || attempts.number()? < 1. {
        return Err(ports.type_error("[outbox] maxAttempts must be a positive integer"));
    }
    let p = fields(
        ports,
        &[
            ("store", store),
            ("crypto", default_crypto),
            ("conflict", ports.get(c"conflict")?),
            ("cryptoImpl", crypto),
            ("now", clock),
            ("idFactory", id_factory),
            ("leaseTokenFactory", token_factory),
            ("leaseMs", lease),
            ("maxAttempts", attempts),
            ("baseBackoffMs", base),
            ("maxBackoffMs", max),
            ("backoff", backoff),
            ("customBackoff", flag(ports, !backoff.undefined()?)?),
            (
                "customCrypto",
                flag(ports, !crypto.equals(default_crypto)?)?,
            ),
        ],
    )?;
    p.set(c"retryDelay", function(p, "retryDelay", 1, 1, retry_delay)?)?;
    let service = defaulted_methods(
        p,
        &[
            ("enqueue", 0, 1, mutations::enqueue),
            ("claim", 0, 1, mutations::claim),
            ("acknowledge", 2, 2, mutations::ack),
        ],
    )?;
    service.set(c"ack", service.get(c"acknowledge")?)?;
    service.spread_from(defaulted_methods(
        p,
        &[
            ("fail", 3, 4, mutations::fail),
            ("defer", 2, 4, mutations::defer),
            ("recoverExpired", 0, 0, mutations::recover),
            ("getDeliveryState", 1, 1, queries::delivery),
            ("list", 0, 1, queries::list),
            ("get", 1, 1, queries::get),
        ],
    )?)?;
    service.freeze()
}

#[napi]
pub fn outbox_runtime_api(
    env: Env,
    crypto: Unknown<'_>,
    conflict: Unknown<'_>,
) -> Result<sys::napi_value> {
    let crypto = L::new(&env, crypto);
    let ctor = L::new(&env, conflict);
    let p = fields(crypto, &[("crypto", crypto), ("conflict", ctor)])?;
    let out = fields(p, &[("OutboxConflictError", ctor)])?;
    out.spread_from(defaulted_methods(
        p,
        &[
            ("createOutbox", 0, 1, create),
            ("admitOutboxItem", 1, 2, admit::direct),
            ("canonicalize", 1, 2, |_, a| {
                if a[1].undefined()? {
                    canonical_live(a[0])
                } else {
                    canonical(a[0], a[1])
                }
            }),
            ("normalizeJson", 1, 1, |_, a| normal(a[0])),
            ("hashPayload", 1, 2, |p, a| {
                hash(a[0], with_default(a[1], p.get(c"crypto")?)?, false)
            }),
            ("hashSecret", 1, 2, |p, a| {
                hash(a[0], with_default(a[1], p.get(c"crypto")?)?, true)
            }),
            ("timingSafeHashEqual", 2, 3, |p, a| {
                token_equal(a[0], a[1], with_default(a[2], p.get(c"crypto")?)?)
            }),
        ],
    )?)?;
    Ok(out.raw())
}
