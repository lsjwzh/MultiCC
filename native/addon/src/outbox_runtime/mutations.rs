//! Enqueue, claim, and lease completion over an injected or native store.
use super::*;
use crate::{
    host_methods::{arg, env, raw},
    outbox_claim_live::{outbox_claim_live, recover_rows},
};
pub(super) fn enqueue<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let opts = default_object(a[0])?;
        let id = read(opts, c"id")?;
        let id = if id.undefined()? {
            p.get(c"idFactory")?.call_plain(&[])?
        } else {
            id
        };
        let input = fields(
            p,
            &[
                ("p", p),
                ("id", id),
                ("session", read(opts, c"sessionId")?),
                ("payload", read(opts, c"payload")?),
                ("source", with_default(read(opts, c"source")?, null(p)?)?),
                ("available", read(opts, c"availableAt")?),
            ],
        )?;
        let f = function(input, "", 1, 1, |i, a| {
            let p = i.get(c"p")?;
            let at = at(p)?;
            let available = i.get(c"available")?;
            let available = if available.undefined()? {
                at
            } else {
                num(p, available.explicit_number()?)?
            };
            let (item, existing) = admit::insert(
                a[0],
                i.get(c"id")?,
                i.get(c"session")?,
                i.get(c"payload")?,
                i.get(c"source")?,
                at,
                available,
                (p.get(c"crypto")?, p.get(c"conflict")?),
            )?;
            let copy = spread(queries::public_item(item)?)?;
            copy.set(c"idempotent", flag(p, existing)?)?;
            Ok(copy)
        })?;
        call(p.get(c"store")?, c"mutate", &[f])
    })
}
pub(super) fn claim<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let opts = default_object(a[0])?;
        let worker = read(opts, c"workerId")?;
        let limit = with_default(read(opts, c"limit")?, num(p, 1.)?)?;
        let lease = with_default(read(opts, c"leaseForMs")?, p.get(c"leaseMs")?)?;
        let selector = with_default(read(opts, c"selectSessionItem")?, null(p)?)?;
        let group = read(opts, c"sessionGroup")?;
        let group = if group.undefined()? {
            function(p, "sessionGroup", 1, 1, |_, a| Ok(a[0]))?
        } else {
            group
        };
        if !worker.truthy()? || worker.kind()? != sys::ValueType::napi_string {
            return Err(p.type_error("[outbox] claim requires workerId"));
        }
        if !safe_integer(limit)? || limit.number()? < 1. {
            return Err(p.type_error("[outbox] claim limit must be a positive integer"));
        }
        if !finite(lease)? || lease.number()? <= 0. {
            return Err(p.type_error("[outbox] leaseForMs must be > 0"));
        }
        let policy = pick(
            p,
            &[
                c"now",
                c"retryDelay",
                c"maxAttempts",
                c"leaseTokenFactory",
                c"cryptoImpl",
            ],
        )?;
        for (k, v) in [
            (c"workerId", worker),
            (c"limit", limit),
            (c"leaseForMs", lease),
            (c"selectSessionItem", selector),
            (c"sessionGroup", group),
        ] {
            policy.set(k, v)?;
        }
        let store = p.get(c"store")?;
        if callable(read(store, c"runNativeCommandSync")?)? {
            let v = call(
                store,
                c"runNativeCommandSync",
                &[text(p, "outboxClaim")?, policy],
            )?;
            then(v, p, |_, a| read(a[0], c"value"))
        } else {
            let f = function(policy, "", 1, 1, |policy, a| {
                Ok(raw(
                    policy,
                    outbox_claim_live(env(policy), arg(a[0])?, arg(a[0])?, arg(policy)?)?,
                ))
            })?;
            call(store, c"mutate", &[f])
        }
    })
}
#[derive(Clone, Copy, PartialEq)]
enum Mutation {
    Ack,
    Fail,
    Defer,
    Recover,
}
impl Mutation {
    fn name(self) -> &'static str {
        match self {
            Self::Ack => "ack",
            Self::Fail => "fail",
            Self::Defer => "defer",
            Self::Recover => "recover",
        }
    }
}
fn error_text(error: L<'_>) -> Result<L<'_>> {
    let msg = if error.instance_of(error.global()?.get(c"Error")?)? {
        read(error, c"message")?
    } else {
        string(fallback(error, V::string("delivery failed"))?)?
    };
    call(msg, c"slice", &[num(error, 0.)?, num(error, 2000.)?])
}
fn run<'a>(p: L<'a>, action: Mutation, params: L<'a>) -> Result<L<'a>> {
    let context = fields(p, &[("p", p), ("params", params)])?;
    let mutate = function(context, "mutate", 1, 1, move |c, a| {
        complete(c.get(c"p")?, action, c.get(c"params")?, a[0])
    })?;
    let store = p.get(c"store")?;
    if !callable(read(store, c"executeOutbox")?)? {
        return call(store, c"mutate", &[mutate]);
    }
    let cmd = fields(p, &[("action", text(p, action.name())?)])?;
    cmd.spread_from(params)?;
    for k in [
        c"now",
        c"customBackoff",
        c"maxAttempts",
        c"baseBackoffMs",
        c"maxBackoffMs",
        c"customCrypto",
    ] {
        cmd.set(k, p.get(k)?)?;
    }
    call(store, c"executeOutbox", &[cmd, mutate])
}
pub(super) fn ack<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        run(
            p,
            Mutation::Ack,
            fields(p, &[("id", a[0]), ("token", a[1])])?,
        )
    })
}
pub(super) fn fail<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let opts = default_object(a[3])?;
        let retryable = with_default(read(opts, c"retryable")?, flag(p, true)?)?;
        let format = function(a[2], "formatReason", 0, 0, |reason, _| error_text(reason))?;
        run(
            p,
            Mutation::Fail,
            fields(
                p,
                &[
                    ("id", a[0]),
                    ("token", a[1]),
                    ("reason", a[2]),
                    ("retryable", retryable),
                    ("formatReason", format),
                ],
            )?,
        )
    })
}
pub(super) fn defer<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let reason = with_default(a[2], text(p, "delivery deferred")?)?;
        let opts = default_object(a[3])?;
        let delay =
            with_default(read(opts, c"delayMs")?, p.get(c"baseBackoffMs")?)?.explicit_number()?;
        if !delay.is_finite() || delay < 0. {
            return Err(p.type_error("[outbox] defer delayMs must be non-negative"));
        }
        let format = function(reason, "formatReason", 0, 0, |r, _| error_text(r))?;
        run(
            p,
            Mutation::Defer,
            fields(
                p,
                &[
                    ("id", a[0]),
                    ("token", a[1]),
                    ("reason", reason),
                    ("delayMs", num(p, delay)?),
                    ("formatReason", format),
                ],
            )?,
        )
    })
}
pub(super) fn recover<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || run(p, Mutation::Recover, fields(p, &[])?))
}
fn clear(item: L<'_>) -> Result<()> {
    let nil = null(item)?;
    for k in [
        c"leasedAt",
        c"leasedUntil",
        c"leaseOwner",
        c"leaseTokenHash",
    ] {
        item.assign(k, nil)?;
    }
    Ok(())
}
fn complete<'a>(p: L<'a>, action: Mutation, params: L<'a>, draft: L<'a>) -> Result<L<'a>> {
    let at = at(p)?;
    let leased = queries::rows(draft, fields(p, &[("state", text(p, "leased")?)])?)?;
    let (recovered, dead) = recover_rows(leased, p, at)?;
    if action == Mutation::Recover {
        return fields(
            p,
            &[
                ("recovered", num(p, recovered.into())?),
                ("deadLettered", num(p, dead.into())?),
            ],
        );
    }
    let item = read(draft, c"outbox")?.get_key(params.get(c"id")?)?;
    let rejected = |reason| fields(p, &[("ok", flag(p, false)?), ("code", text(p, reason)?)]);
    if !item.truthy()? {
        return rejected("not_found");
    }
    if !read(item, c"state")?.is_string("leased")?
        || !token_equal(
            read(item, c"leaseTokenHash")?,
            params.get(c"token")?,
            p.get(c"cryptoImpl")?,
        )?
        .truthy()?
    {
        return rejected("lease_lost");
    }
    let out = fields(p, &[("ok", flag(p, true)?)])?;
    if action == Mutation::Ack {
        item.assign(c"state", text(p, "delivered")?)?;
        item.assign(c"deliveredAt", at)?;
        item.assign(c"updatedAt", at)?;
        clear(item)?;
    } else {
        item.assign(c"lastError", error_text(params.get(c"reason")?)?)?;
        item.assign(c"updatedAt", at)?;
        if action == Mutation::Defer {
            let n = item.get(c"attempts")?.number()? - 1.;
            item.assign(
                c"attempts",
                call(
                    p.global()?.get(c"Math")?,
                    c"max",
                    &[num(p, 0.)?, num(p, n)?],
                )?,
            )?;
        }
        clear(item)?;
        if action == Mutation::Defer
            || (params.get(c"retryable")?.truthy()?
                && item.get(c"attempts")?.explicit_number()? < p.get(c"maxAttempts")?.number()?)
        {
            item.assign(c"state", text(p, "pending")?)?;
            let delay = if action == Mutation::Defer {
                params.get(c"delayMs")?
            } else {
                p.get(c"retryDelay")?
                    .call_plain(&[read(item, c"attempts")?])?
            };
            item.assign(c"availableAt", num(p, at.number()? + delay.number()?)?)?;
            out.set(
                if action == Mutation::Defer {
                    c"deferred"
                } else {
                    c"retry"
                },
                flag(p, true)?,
            )?;
            out.set(c"availableAt", read(item, c"availableAt")?)?;
        } else {
            item.assign(c"state", text(p, "dead-letter")?)?;
            item.assign(c"deadLetterAt", at)?;
            out.set(c"retry", flag(p, false)?)?;
            out.set(c"deadLetter", flag(p, true)?)?;
        }
    }
    out.set(c"item", queries::public_item(item)?)?;
    Ok(out)
}
