//! Select from one committed snapshot; refresh callbacks execute in bounded groups.
use crate::host_api::*;
use napi_derive::napi;
fn action<'a>(p: L<'a>, op: &str, input: L<'a>, request: L<'a>) -> Result<L<'a>> {
    let wire = json_call(p, c"stringify", input)?;
    let result = if request.truthy()? {
        call(
            request,
            if op == "select" {
                c"choose"
            } else {
                c"outcome"
            },
            &[wire],
        )?
    } else {
        let raw = wire.coerce_string()?.to_string_lossy();
        let result = match op {
            "select" => multicc_core::virtual_provider::select(&raw),
            "validate" => multicc_core::virtual_provider::validate(&raw),
            _ => multicc_core::virtual_provider::failure(&raw),
        };
        text(
            p,
            &result.map_err(|reason| napi::Error::from_reason(reason))?,
        )?
    };
    json_call(p, c"parse", result)
}
fn candidates<'a>(ctx: L<'a>, limits: L<'a>) -> Result<L<'a>> {
    let p = ctx.get(c"ports")?;
    let guard = p.get(c"guard")?;
    let committed = ctx.get(c"committed")?.truthy()?;
    let options = default_object(ctx.get(c"options")?)?;
    let provider = ctx.get(c"provider")?;
    let out = array(p)?;
    ctx.get(c"providers")?.for_each(|item| {
        let projected = spread(item)?;
        let mut allowed = call(p, c"egress", &[item])?.get(c"allowed")?;
        if allowed.truthy()? {
            let blocked = if guard.truthy()? {
                let input = fields(
                    p,
                    &[
                        ("appType", item.get(c"appType")?),
                        ("providerId", item.get(c"id")?),
                    ],
                )?;
                let v = if committed {
                    let key = call(
                        string(input.get(c"appType")?)?,
                        c"concat",
                        &[text(p, ":")?, string(input.get(c"providerId")?)?],
                    )?;
                    call(guard, c"checkEntry", &[input, limits.get_key(key)?])?
                } else {
                    call(guard, c"check", &[input])?
                };
                v.get(c"blocked")?.truthy()?
            } else {
                false
            };
            allowed = flag(p, !blocked)?;
        }
        projected.set(c"virtualGateAllowed", allowed)?;
        call(out, c"push", &[projected])?;
        Ok(())
    })?;
    let limits = if committed {
        limits
    } else {
        let cache = p.get(c"cache")?;
        let entries = if cache.truthy()? {
            call(cache, c"snapshot", &[])?.get(c"entries")?
        } else {
            undef(p)?
        };
        if entries.truthy()? {
            entries
        } else {
            fields(p, &[])?
        }
    };
    fields(
        p,
        &[
            ("providerId", provider.get(c"id")?),
            ("appType", provider.get(c"appType")?),
            ("virtual", provider.get(c"virtual")?),
            ("providers", out),
            ("limits", limits),
            (
                "subscriptions",
                call(p.get(c"subscriptions")?, c"snapshot", &[])?,
            ),
            ("model", options.get(c"model")?),
            (
                "excluded",
                with_default(options.get(c"excluded")?, array(p)?)?,
            ),
            ("now", now(p)?),
        ],
    )
}
fn prepare<'a>(
    p: L<'a>,
    provider: L<'a>,
    providers: L<'a>,
    options: L<'a>,
    committed: bool,
) -> Result<L<'a>> {
    let ctx = fields(
        p,
        &[
            ("ports", p),
            ("provider", provider),
            ("providers", providers),
            ("options", options),
            ("committed", flag(p, committed)?),
        ],
    )?;
    let cache = p.get(c"cache")?;
    if committed {
        return async_result(p, || {
            let guard = p.get(c"guard")?;
            if guard.truthy()? && !callable(guard.get(c"checkEntry")?)? {
                return Err(
                    error_value(p, "quota guard cannot evaluate a committed snapshot")?
                        .throw_error(),
                );
            }
            if cache.truthy()? {
                return then(call(cache, c"snapshot", &[])?, ctx, |ctx, a| {
                    candidates(ctx, a[0].get(c"entries")?)
                });
            }
            candidates(ctx, fields(p, &[])?)
        });
    }
    candidates(ctx, undef(p)?)
}
fn status<'a>(p: L<'a>, a: &[L<'a>], committed: bool) -> Result<L<'a>> {
    let input = prepare(p, a[0], a[1], a[2], committed)?;
    if committed {
        then(input, p, |p, a| action(p, "select", a[0], undef(p)?))
    } else {
        action(p, "select", input, undef(p)?)
    }
}
fn selected<'a>(ctx: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let p = ctx.get(c"ports")?;
    let provider = ctx.get(c"provider")?;
    let id = match action(
        p,
        "select",
        input,
        ctx.get(c"options")?.optional(c"request")?,
    ) {
        Ok(result) => result.get(c"selectedId")?,
        Err(e) => {
            let reason = p.exception_value()?;
            let exhausted = match reason {
                Some(v) => v
                    .optional(c"message")?
                    .is_string("VIRTUAL_NO_AVAILABLE_MEMBER")?,
                None => e.reason == "VIRTUAL_NO_AVAILABLE_MEMBER",
            };
            if !exhausted {
                return Err(if let Some(v) = reason {
                    v.throw_error()
                } else {
                    e
                });
            }
            undef(p)?
        }
    };
    if !id.truthy()? {
        let msg = "虚拟线路暂无可用成员，请检查余量、到期日期和模型";
        let err = error_value(p, msg)?;
        err.set(c"code", text(p, "VIRTUAL_NO_AVAILABLE_MEMBER")?)?;
        err.set(c"statusCode", num(p, 503.)?)?;
        err.set(c"safeCprMessage", text(p, msg)?)?;
        return Err(err.throw_error());
    }
    call(p, c"routingView", &[provider.get(c"appType")?, id])
}
fn resolve<'a>(p: L<'a>, a: &[L<'a>], committed: bool) -> Result<L<'a>> {
    let list = array(p)?;
    call(p, c"listProviders", &[])?.for_each(|item| {
        if !item.get(c"virtual")?.truthy()? {
            call(list, c"push", &[item])?;
        }
        Ok(())
    })?;
    let ctx = fields(p, &[("ports", p), ("provider", a[0]), ("options", a[1])])?;
    let input = prepare(p, a[0], list, a[1], committed)?;
    if committed {
        then(input, ctx, |ctx, a| selected(ctx, a[0]))
    } else {
        selected(ctx, input)
    }
}
fn outcome<'a>(p: L<'a>, a: &[L<'a>], committed: bool) -> Result<L<'a>> {
    let provider = a[0];
    let (id, app) = (provider.get(c"id")?, provider.get(c"appType")?);
    let cache = p.get(c"cache")?;
    let input = fields(
        p,
        &[
            ("providerId", id),
            ("status", a[1]),
            ("headersSent", a[2]),
            ("resetMs", a[3]),
        ],
    )?;
    if !committed {
        input.set(
            c"previous",
            if cache.truthy()? {
                call(cache, c"get", &[app, id])?.optional(c"summary")?
            } else {
                undef(p)?
            },
        )?;
    }
    let at = now(p)?;
    input.set(c"now", at)?;
    let result = action(p, "failure", input, a[4])?;
    let retry = result.get(c"retry")?;
    if cache.truthy()? {
        if committed && retry.truthy()? {
            if !callable(cache.get(c"recordVirtualFailure")?)? {
                return Err(
                    error_value(p, "atomic virtual quota update unavailable")?.throw_error()
                );
            }
            return then(
                call(cache, c"recordVirtualFailure", &[app, id, input, at])?,
                retry,
                constant,
            );
        }
        if !committed && result.get(c"record")?.truthy()? {
            call(cache, c"record", &[app, id, result.get(c"record")?])?;
        }
    }
    Ok(retry)
}
fn refresh<'a>(p: L<'a>, provider: L<'a>, committed: bool) -> Result<L<'a>> {
    let ctx = fields(
        p,
        &[
            ("ports", p),
            ("provider", provider),
            ("committed", flag(p, committed)?),
        ],
    )?;
    async_result(p, || {
        then(
            call(p.get(c"subscriptions")?, c"ready", &[])?,
            ctx,
            |ctx, _| {
                let p = ctx.get(c"ports")?;
                let provider = ctx.get(c"provider")?;
                let list = call(p, c"listProviders", &[])?;
                ctx.set(c"providers", list)?;
                then(
                    status(
                        p,
                        &[provider, list, undef(p)?],
                        ctx.get(c"committed")?.truthy()?,
                    )?,
                    ctx,
                    |ctx, a| {
                        let p = ctx.get(c"ports")?;
                        let plan = a[0];
                        let mut jobs = vec![];
                        for (key, subscription) in
                            [(c"refreshIds", false), (c"subscriptionRefreshIds", true)]
                        {
                            plan.get(key)?.for_each(|id| {
                                jobs.push(fields(
                                    p,
                                    &[("id", id), ("subscription", flag(p, subscription)?)],
                                )?);
                                Ok(())
                            })?;
                        }
                        let mut pending = resolved(undef(p)?)?;
                        for batch in jobs.chunks(4) {
                            let group = array(p)?;
                            for job in batch {
                                call(group, c"push", &[*job])?;
                            }
                            let state = fields(p, &[("ctx", ctx), ("group", group)])?;
                            pending = then(pending, state, |state, _| {
                                let ctx = state.get(c"ctx")?;
                                let p = ctx.get(c"ports")?;
                                let promises = array(p)?;
                                state.get(c"group")?.for_each(|job| {
                                    let id = job.get(c"id")?;
                                    let result = if job.get(c"subscription")?.truthy()? {
                                        let mut member = undef(p)?;
                                        ctx.get(c"providers")?.for_each_while(|v| {
                                            if v.get(c"id")?.equals(id)? {
                                                member = v;
                                                Ok(false)
                                            } else {
                                                Ok(true)
                                            }
                                        })?;
                                        call(p.get(c"subscriptions")?, c"refresh", &[member])?
                                    } else {
                                        let f = p.get(c"refresher")?;
                                        if f.nullish()? {
                                            undef(p)?
                                        } else {
                                            f.call_plain(&[
                                                ctx.get(c"provider")?.get(c"appType")?,
                                                id,
                                            ])?
                                        }
                                    };
                                    call(promises, c"push", &[result])?;
                                    Ok(())
                                })?;
                                call(p.global()?.get(c"Promise")?, c"allSettled", &[promises])
                            })?;
                        }
                        then(pending, undef(p)?, constant)
                    },
                )
            },
        )
    })
}
#[napi]
pub fn virtual_provider_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(methods(
        p,
        &[
            ("validate", 1, |p, a| action(p, "validate", a[0], undef(p)?)),
            ("configure", 1, |p, a| {
                let opts = default_object(a[0])?;
                for key in [c"cache", c"guard", c"recordDto"] {
                    p.set(key, fallback(opts.get(key)?, V::Null)?)?;
                }
                undef(p)
            }),
            ("setRefresher", 1, |p, a| {
                p.set(c"refresher", a[0])?;
                Ok(a[0])
            }),
            ("snapshot", 3, |p, a| prepare(p, a[0], a[1], a[2], false)),
            ("snapshotAsync", 3, |p, a| {
                async_result(p, || prepare(p, a[0], a[1], a[2], true))
            }),
            ("status", 3, |p, a| status(p, a, false)),
            ("statusAsync", 3, |p, a| {
                async_result(p, || status(p, a, true))
            }),
            ("resolve", 2, |p, a| resolve(p, a, false)),
            ("resolveAsync", 2, |p, a| {
                async_result(p, || resolve(p, a, true))
            }),
            ("refresh", 1, |p, a| refresh(p, a[0], false)),
            ("refreshAsync", 1, |p, a| refresh(p, a[0], true)),
            ("outcome", 5, |p, a| outcome(p, a, false)),
            ("outcomeAsync", 5, |p, a| {
                async_result(p, || outcome(p, a, true))
            }),
            ("observe", 2, |p, a| {
                let f = p.get(c"recordDto")?;
                if f.nullish()? {
                    undef(p)
                } else {
                    f.call_plain(&[a[0].get(c"appType")?, a[0].get(c"id")?, a[1]])
                }
            }),
        ],
    )?
    .raw())
}
