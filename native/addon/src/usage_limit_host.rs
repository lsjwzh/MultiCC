//! Active quota polling. Native state owns admission and cached DTOs. Live JS
//! handles retain the identity of each caller's clock, promise and transport.
use crate::host_api::*;
use napi_derive::napi;
mod transport;

fn key_hash(value: L<'_>, p: L<'_>) -> Result<String> {
    let hash = call(p.get(c"crypto")?, c"createHash", &[text(p, "sha256")?])?;
    let hash = call(hash, c"update", &[string(fallback(value, "".into())?)?])?;
    let hex = fold_string(call(hash, c"digest", &[text(p, "hex")?])?)?;
    Ok(hex[..16].to_string())
}
fn state<'a>(p: L<'a>, op: &str, args: &[(&str, L<'a>)]) -> Result<L<'a>> {
    call(
        p.get(c"state")?,
        c"request",
        &[text(p, op)?, fields(p, args)?],
    )
}
fn clock(p: L<'_>) -> Result<L<'_>> {
    let clock = p.get(c"now")?;
    if clock.undefined()? {
        call(p.global()?.get(c"Date")?, c"now", &[])
    } else {
        clock.call_plain(&[])
    }
}
fn finish<'a>(ctx: L<'a>, dto: L<'a>, err: L<'a>, skipped: bool) -> Result<L<'a>> {
    let p = ctx.get(c"poller")?;
    let dto = if dto.truthy()? {
        let value = spread(dto)?;
        value.set(c"fetchedAt", clock(p)?)?;
        value
    } else {
        dto
    };
    state(
        p,
        "finish",
        &[
            ("key", ctx.get(c"key")?),
            ("at", ctx.get(c"now")?),
            ("dto", dto),
            ("error", err),
            ("includeError", flag(p, skipped)?),
        ],
    )?;
    ctx.set(c"finished", flag(ctx, true)?)?;
    Ok(dto)
}
fn warn<'a>(t: L<'a>, status: &str, who: L<'a>, detail: L<'a>) -> Result<()> {
    let msg = format!(
        "[usage-limit] {} poll {} ({}): {}",
        fold_string(t.get(c"strategy")?)?,
        status,
        fold_string(who)?,
        fold_string(detail)?
    );
    call(t.global()?.get(c"console")?, c"warn", &[text(t, &msg)?])?;
    Ok(())
}
fn run<'a>(ctx: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"poller")?;
    let ports = p.get(c"ports")?;
    let t = ctx.get(c"target")?;
    let provider = t.get(c"providerId")?;
    if provider.truthy()? {
        let found = call(
            ports.get(c"providers")?,
            c"getProvider",
            &[t.get(c"appType")?, provider],
        )?;
        if found.truthy()? {
            let gate = ports.get(c"checkEgressIpAllowed")?.call_plain(&[found])?;
            if !gate.get(c"allowed")?.truthy()? {
                let detail = gate.get(c"detail")?;
                warn(t, "skipped", provider, detail)?;
                return finish(ctx, null(ctx)?, detail, true);
            }
        }
    }
    let data = async_result(ctx, || {
        ctx.get(c"adapter")?.call_plain(&[t, ctx.get(c"now")?])
    })?;
    let done = function(ctx, "finish", 1, 1, |ctx, a| {
        finish(ctx, a[0], null(ctx)?, false)
    })?;
    let failed = function(ctx, "failed", 1, 1, |ctx, a| {
        let err = a[0];
        let t = ctx.get(c"target")?;
        let detail = if err.optional(c"kind")?.is_string(transport::FAIL)? {
            err.get(c"detail")?
        } else {
            let m = err.optional(c"message")?;
            string(if m.truthy()? { m } else { err })?
        };
        let mut who = t.get(c"host")?;
        if !who.truthy()? {
            who = t.get(c"relayUrl")?;
        }
        if !who.truthy()? {
            who = t.get(c"providerId")?;
        }
        warn(t, "failed", who, detail)?;
        finish(ctx, null(ctx)?, detail, false)
    })?;
    call(data, c"then", &[done, failed])
}
fn refresh<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let t = a[0];
        let seed = t.get(c"keyHashSeed")?;
        let key = text(
            p,
            &format!(
                "{}:{}",
                fold_string(t.get(c"providerId")?)?,
                key_hash(
                    if seed.truthy()? {
                        seed
                    } else {
                        t.get(c"apiKey")?
                    },
                    p.get(c"ports")?
                )?
            ),
        )?;
        let strategy = t.get(c"strategy")?;
        let now = a[1];
        let input = [("key", key), ("strategy", strategy), ("now", now)];
        let decision = state(p, "begin", &input)?;
        let flights = p.get(c"flights")?;
        if decision.get(c"action")?.is_string("cached")? {
            return decision.get(c"dto");
        }
        if decision.get(c"action")?.is_string("join")? {
            return call(flights, c"get", &[key]);
        }
        let adapter = p.get(c"adapters")?.get_key(strategy)?;
        let mut input = input.to_vec();
        input.push(("hasAdapter", flag(p, adapter.truthy()?)?));
        if state(p, "begin", &input)?
            .get(c"action")?
            .is_string("none")?
        {
            return null(p);
        }
        let ctx = fields(
            p,
            &[
                ("poller", p),
                ("target", t),
                ("adapter", adapter),
                ("key", key),
                ("now", now),
            ],
        )?;
        let promise = then(undef(p)?, ctx, run)?;
        let finalized = call(
            promise,
            c"finally",
            &[function(ctx, "cleanup", 0, 0, |ctx, _| {
                let p = ctx.get(c"poller")?;
                let k = ctx.get(c"key")?;
                if !ctx.get(c"finished")?.truthy()? {
                    state(p, "abort", &[("key", k)])?;
                }
                let flights = p.get(c"flights")?;
                if call(flights, c"get", &[k])?.equals(ctx.get(c"promise")?)? {
                    call(flights, c"delete", &[k])?;
                }
                undef(ctx)
            })?],
        )?;
        ctx.set(c"promise", finalized)?;
        call(flights, c"set", &[key, finalized])?;
        Ok(finalized)
    })
}
fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let o = default_object(a[0])?;
    let p = fields(
        ports,
        &[
            ("ports", ports),
            ("now", o.get(c"now")?),
            (
                "adapters",
                with_default(o.get(c"adapters")?, ports.get(c"adapters")?)?,
            ),
        ],
    )?;
    for k in [c"resolveTarget", c"broadcast"] {
        let f = o.get(k)?;
        if !callable(f)? {
            return Err(
                error_value(p, &format!("{} required", k.to_string_lossy()))?.throw_error(),
            );
        }
        p.set(k, f)?;
    }
    p.set(c"state", ports.get(c"State")?.construct(&[])?)?;
    p.set(c"flights", p.global()?.get(c"Map")?.construct(&[])?)?;
    let cache = methods(
        p,
        &[
            ("get", 1, |p, a| state(p, "get", &[("key", a[0])])),
            ("has", 1, |p, a| state(p, "has", &[("key", a[0])])),
            ("clear", 0, |p, _| state(p, "clear", &[])),
        ],
    )?;
    let desc = fields(
        p,
        &[
            (
                "get",
                function(p, "get size", 0, 0, |p, _| state(p, "size", &[]))?,
            ),
            ("enumerable", flag(p, true)?),
        ],
    )?;
    call(
        p.global()?.get(c"Object")?,
        c"defineProperty",
        &[cache, text(p, "size")?, desc],
    )?;
    let api = methods(
        p,
        &[
            ("_refresh", 2, refresh),
            ("onTurnComplete", 1, |p, a| {
                let done = async_result(p, || {
                    let id = a[0];
                    let t = p.get(c"resolveTarget")?.call_plain(&[id])?;
                    if !t.truthy()? || !t.get(c"strategy")?.truthy()? {
                        return undef(p);
                    }
                    let ctx = fields(p, &[("poller", p), ("id", id)])?;
                    then(refresh(p, &mut [t, clock(p)?])?, ctx, |ctx, a| {
                        if a[0].truthy()? {
                            ctx.get(c"poller")?
                                .get(c"broadcast")?
                                .call_plain(&[ctx.get(c"id")?, a[0]])?;
                        }
                        undef(ctx)
                    })
                })?;
                recover(done, p, |p, _| undef(p))
            }),
        ],
    )?;
    api.set(c"_cache", cache.freeze()?)?;
    Ok(api)
}
fn auth_refresh<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let action = async_result(p, || {
        let f = p.get(c"refresher")?;
        if !callable(f)? {
            return flag(p, false);
        }
        let value = f.call_plain(&[if input.truthy()? {
            input
        } else {
            fields(p, &[])?
        }])?;
        then(value, p, |p, a| flag(p, a[0].truthy()?))
    })?;
    recover(action, p, |p, _| flag(p, false))
}
#[napi]
pub fn usage_limit_poller_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = defaulted_methods(
        p,
        &[
            ("createUsageLimitPoller", 0, 1, create),
            ("keyHash", 1, 1, |p, a| text(p, &key_hash(a[0], p)?)),
            ("pollCodexUsage", 2, 4, transport::codex),
            ("pollGlmMonitor", 2, 3, transport::glm),
            ("pollDeepseekBalance", 2, 3, transport::deepseek),
            ("pollRelayQuota", 2, 3, transport::relay),
            ("setCodexAuthRefresher", 1, 1, |p, a| {
                p.set(c"refresher", if callable(a[0])? { a[0] } else { null(p)? })?;
                undef(p)
            }),
            ("runCodexAuthRefresh", 1, 1, |p, a| auth_refresh(p, a[0])),
        ],
    )?;
    p.set(
        c"adapters",
        fields(
            p,
            &[
                ("glm-monitor", api.get(c"pollGlmMonitor")?),
                ("deepseek-balance", api.get(c"pollDeepseekBalance")?),
                ("codex-oauth-usage", api.get(c"pollCodexUsage")?),
                ("relay-quota", api.get(c"pollRelayQuota")?),
            ],
        )?
        .freeze()?,
    )?;
    Ok(api.raw())
}
