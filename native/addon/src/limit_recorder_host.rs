//! Connect committed database transactions and injected synchronous stores to the same core policy.
use crate::host_api::*;
use napi_derive::napi;
type Pair<'a> = (&'a str, L<'a>);
fn request<'a>(p: L<'a>, op: &str, input: &[Pair<'a>]) -> Result<L<'a>> {
    let input = fields(p, input)?;
    let value = unsafe { crate::js_bridge::read_value(p.env(), input.raw(), 0, &mut Vec::new()) }?;
    p.from_value(&multicc_core::limit_cache_recorder::request(op, &value))
}
fn identity<'a>(p: L<'a>, value: L<'a>, explicit: bool) -> Result<L<'a>> {
    let key = request(p, "identityKey", &[("value", value)])?;
    if key.nullish()? {
        return null(p);
    }
    let providers = p.get(c"providers")?;
    if explicit {
        if !callable(providers.get(c"getProvider")?)? {
            return null(p);
        }
        let Some(row) = p.catch(|| call(providers, c"getProvider", &[undef(p)?, key]))? else {
            return null(p);
        };
        request(
            p,
            "providerIdentity",
            &[
                ("requestedId", key),
                ("id", row.optional(c"id")?),
                ("appType", row.optional(c"appType")?),
                ("activeAccountId", row.optional(c"activeAccountId")?),
            ],
        )
    } else {
        let rec = call(p.get(c"persistedSessions")?, c"get", &[key])?;
        let provider = rec.optional(c"provider")?;
        let cli = request(
            p,
            "sessionCli",
            &[("provider", provider), ("cli", rec.optional(c"cli")?)],
        )?;
        if cli.nullish()? {
            return null(p);
        }
        request(
            p,
            "sessionIdentity",
            &[
                ("appType", call(providers, c"appTypeForCli", &[cli])?),
                ("provider", provider),
            ],
        )
    }
}
fn resolve<'a>(p: L<'a>, session: L<'a>, provider: L<'a>) -> Result<L<'a>> {
    if provider.truthy()? {
        identity(p, provider, true)
    } else {
        identity(p, session, false)
    }
}
fn previous<'a>(cache: L<'a>, app: L<'a>, id: L<'a>, optional: bool) -> Result<L<'a>> {
    let read = || call(cache, c"get", &[app, id]);
    if optional {
        Ok(cache.catch(read)?.unwrap_or(null(cache)?))
    } else {
        read()
    }
}
fn summary(entry: L<'_>) -> Result<L<'_>> {
    if entry.truthy()? {
        pick(entry, &[c"summary"])
    } else {
        Ok(entry)
    }
}
fn derived(cache: L<'_>) -> Result<bool> {
    callable(cache.get(c"recordDerived")?)
}
fn derive<'a>(
    cache: L<'a>,
    app: L<'a>,
    id: L<'a>,
    op: &str,
    input: &[Pair<'a>],
    at: L<'a>,
) -> Result<L<'a>> {
    call(
        cache,
        c"recordDerived",
        &[app, id, text(cache, op)?, fields(cache, input)?, at],
    )
}
fn record_dto<'a>(p: L<'a>, app: L<'a>, id: L<'a>, dto: L<'a>) -> Result<L<'a>> {
    if !request(p, "validDto", &[("dto", dto)])?.truthy()? {
        return null(p);
    }
    let at = now(p)?;
    let stage = request(p, "dtoPrepare", &[("dto", dto), ("now", at)])?;
    if !stage.truthy()? {
        return null(p);
    }
    let cache = p.get(c"cache")?;
    let mut input = vec![("dto", dto), ("now", at), ("stage", stage)];
    if derived(cache)? {
        return derive(cache, app, id, "dtoFinish", &input, now(p)?);
    }
    let mode = stage.get(c"previous")?;
    let prev = if mode.is_string("strict")? || mode.is_string("optional")? {
        previous(cache, app, id, mode.is_string("optional")?)?
    } else {
        null(p)?
    };
    input.push(("previous", summary(prev)?));
    let value = request(p, "dtoFinish", &input)?;
    if value.truthy()? {
        call(cache, c"record", &[app, id, value])
    } else {
        null(p)
    }
}
fn record_failure<'a>(
    cache: L<'a>,
    app: L<'a>,
    id: L<'a>,
    value: L<'a>,
    out: L<'a>,
) -> Result<L<'a>> {
    let recorded = call(cache, c"recordFailure", &[app, id, value])?;
    if derived(cache)? {
        then(recorded, out, constant)
    } else {
        Ok(out)
    }
}
fn rejection(r: L<'_>) -> Result<L<'_>> {
    if object(r)? && !r.is_array()? {
        pick(
            r,
            &[
                c"kind", c"scope", c"window", c"resetMs", c"code", c"model", c"source",
            ],
        )
    } else {
        null(r)
    }
}
fn refresh<'a>(p: L<'a>, app: L<'a>, id: L<'a>) -> Result<()> {
    let f = p.get(c"refresher")?;
    if callable(f)? {
        ignored(p, || f.call_plain(&[app, id]))?;
    }
    Ok(())
}
fn failure<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let input = default_object(args[0])?;
    let id = resolve(p, input.get(c"sessionId")?, input.get(c"providerId")?)?;
    if !id.truthy()? {
        return null(p);
    }
    let (app, key) = (id.get(c"appType")?, id.get(c"providerId")?);
    let cache = p.get(c"cache")?;
    let category = input.get(c"category")?;
    let status = input.get(c"httpStatus")?;
    let until = input.get(c"blockedUntilMs")?;
    let r = input.get(c"rejection")?;
    let target = || {
        let providers = p.get(c"providers")?;
        let f = providers.get(c"getProviderLimitTarget")?;
        if f.nullish()? {
            undef(p)
        } else {
            f.call(providers, &[app, key])?.optional(c"strategy")
        }
    };
    if callable(cache.get(c"transitionAvailability")?)? {
        let kind = target()?;
        let data = fields(
            p,
            &[
                ("category", category),
                ("httpStatus", status),
                ("blockedUntilMs", until),
                ("rejection", rejection(r)?),
                ("hasRejection", flag(p, r.truthy()?)?),
                ("targetKind", kind),
            ],
        )?;
        let result = call(cache, c"transitionAvailability", &[app, key, data, now(p)?])?;
        return then(
            result,
            fields(p, &[("ports", p), ("app", app), ("id", key)])?,
            |ctx, a| {
                if a[0].get(c"refresh")?.truthy()? {
                    refresh(ctx.get(c"ports")?, ctx.get(c"app")?, ctx.get(c"id")?)?;
                }
                a[0].get(c"entry")
            },
        );
    }
    let prev = previous(cache, app, key, false)?;
    let policy = request(
        p,
        "failurePolicy",
        &[
            ("httpStatus", status),
            ("targetKind", target()?),
            ("previous", summary(prev)?),
            ("now", now(p)?),
        ],
    )?;
    let park = if request(p, "isRevokedCategory", &[("category", category)])?.truthy()? {
        null(p)?
    } else {
        request(
            p,
            "rejectionPark",
            &[
                ("rejection", rejection(r)?),
                ("now", num(p, now(p)?.explicit_number()?)?),
            ],
        )?
    };
    let action = request(
        p,
        "failureCheck",
        &[
            ("category", category),
            ("previous", summary(prev)?),
            ("policy", policy),
            ("park", park),
            ("rejection", flag(p, r.truthy()?)?),
            ("blockedUntilMs", until),
        ],
    )?;
    if action.is_string("preserve")?
        || (action.is_string("checkLong")?
            && request(
                p,
                "longPark",
                &[("previous", summary(prev)?), ("now", now(p)?)],
            )?
            .truthy()?)
    {
        return Ok(prev);
    }
    let at = num(p, now(p)?.explicit_number()?)?;
    let plan = request(
        p,
        "cooldown",
        &[
            ("category", category),
            ("httpStatus", status),
            ("blockedUntilMs", until),
            ("park", park),
            ("now", at),
        ],
    )?;
    let write = || call(cache, c"record", &[app, key, plan.get(c"value")?]);
    let entry = if plan.get(c"needsPrevious")?.truthy()? {
        let current = previous(cache, app, key, false)?;
        if request(
            p,
            "keepsAccountPark",
            &[
                ("previous", summary(current)?),
                ("now", at),
                ("modelUntil", plan.get(c"until")?),
            ],
        )?
        .truthy()?
        {
            current
        } else {
            write()?
        }
    } else {
        write()?
    };
    if !policy.optional(c"refresh")?.equals(flag(p, false)?)? {
        refresh(p, app, key)?;
    }
    Ok(entry)
}
fn release<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let id = identity(p, default_object(a[0])?.get(c"providerId")?, true)?;
    if !id.truthy()? {
        return null(p);
    }
    let (app, id, cache) = (
        id.get(c"appType")?,
        id.get(c"providerId")?,
        p.get(c"cache")?,
    );
    if callable(cache.get(c"transitionAvailability")?)? {
        let result = call(
            cache,
            c"transitionAvailability",
            &[app, id, fields(p, &[("release", flag(p, true)?)])?, now(p)?],
        )?;
        return then(result, p, |p, a| {
            if a[0].get(c"write")?.truthy()? {
                a[0].get(c"entry")
            } else {
                null(p)
            }
        });
    }
    let Some(entry) = p.catch(|| previous(cache, app, id, false))? else {
        return null(p);
    };
    if !request(p, "releaseEligible", &[("entry", summary(entry)?)])?.truthy()? {
        return null(p);
    }
    call(
        cache,
        c"record",
        &[app, id, request(p, "releaseRecord", &[("now", now(p)?)])?],
    )
}
fn each_provider<'a>(p: L<'a>, mut visit: impl FnMut(L<'a>, L<'a>) -> Result<()>) -> Result<()> {
    for kind in ["claude", "codex"] {
        let app = text(p, kind)?;
        call(p.get(c"providers")?, c"listProviders", &[app])?.for_each(|row| visit(app, row))?;
    }
    Ok(())
}
fn query<'a>(p: L<'a>, kind: &str, value: L<'a>, matches: L<'a>) -> Result<L<'a>> {
    let q = request(
        p,
        "resolveQuery",
        &[("kind", text(p, kind)?), ("value", value)],
    )?;
    if !q.nullish()? {
        each_provider(p, |app, row| {
            let ok = if kind == "host" {
                let target = call(
                    p.get(c"providers")?,
                    c"getProviderLimitTarget",
                    &[app, row.get(c"id")?],
                )?;
                request(
                    p,
                    "hostMatches",
                    &[("query", q), ("host", target.optional(c"host")?)],
                )?
            } else {
                request(
                    p,
                    "baseMatches",
                    &[("query", q), ("baseUrl", row.get(c"baseUrl")?)],
                )?
            };
            if ok.truthy()? {
                call(
                    matches,
                    c"push",
                    &[fields(
                        p,
                        &[("appType", app), ("providerId", row.get(c"id")?)],
                    )?],
                )?;
            }
            Ok(())
        })?;
    }
    Ok(matches)
}
fn vendor<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let input = a[0];
    let result = input.get(c"result")?;
    let zero = num(p, 0.)?;
    if !result.truthy()? {
        return Ok(zero);
    }
    let matches = array(p)?;
    let session = input.get(c"session")?;
    if session.truthy()? {
        let id = identity(p, session, false)?;
        if id.truthy()? {
            call(matches, c"push", &[id])?;
        }
    }
    let base = with_default(input.get(c"baseUrl")?, text(p, "")?)?;
    for (name, value) in [("host", input.get(c"host")?), ("baseUrl", base)] {
        if value.truthy()? {
            query(p, name, value, matches)?;
        }
    }
    let ids = request(p, "mergeIdentities", &[("ids", matches)])?;
    let count = ids.get(c"length")?;
    if !count.truthy()? {
        return Ok(zero);
    }
    let cache = p.get(c"cache")?;
    let plan = request(p, "vendorPlan", &[("result", result)])?;
    if plan.get(c"action")?.is_string("failure")? {
        if count.number()? == 1. && session.truthy()? {
            let id = ids.element(0)?;
            return record_failure(
                cache,
                id.get(c"appType")?,
                id.get(c"providerId")?,
                plan.get(c"value")?,
                zero,
            );
        }
        return Ok(zero);
    }
    let kind = input.get(c"kind")?;
    let bar = p
        .catch(|| {
            request(
                p,
                "vendorRender",
                &[
                    ("kind", kind),
                    ("result", result),
                    ("baseUrl", base),
                    ("opts", input.get(c"opts")?),
                    ("now", now(p)?),
                ],
            )
        })?
        .unwrap_or(null(p)?);
    let reported = request(
        p,
        "vendorWindows",
        &[("kind", kind), ("result", result), ("baseUrl", base)],
    )?;
    let asynchronous = derived(cache)?;
    let pending = array(p)?;
    ids.for_each(|row| {
        let (app, id) = (row.get(c"appType")?, row.get(c"providerId")?);
        let prev = if asynchronous {
            null(p)?
        } else {
            previous(cache, app, id, true)?
        };
        let merge = if reported.get(c"length")?.truthy()? {
            now(p)?
        } else {
            undef(p)?
        };
        let stamp = if asynchronous { now(p)? } else { undef(p)? };
        let at = if result.get(c"fetchedAt")?.truthy()? {
            undef(p)?
        } else if asynchronous {
            stamp
        } else {
            now(p)?
        };
        let mut data = vec![
            ("kind", kind),
            ("result", result),
            ("bar", bar),
            ("reported", reported),
            ("mergeNow", merge),
            ("now", at),
        ];
        if asynchronous {
            call(
                pending,
                c"push",
                &[derive(cache, app, id, "vendorRecord", &data, stamp)?],
            )?;
        } else {
            data.push(("previous", summary(prev)?));
            call(
                cache,
                c"record",
                &[app, id, request(p, "vendorRecord", &data)?],
            )?;
        }
        Ok(())
    })?;
    if asynchronous {
        then(
            call(p.global()?.get(c"Promise")?, c"all", &[pending])?,
            count,
            constant,
        )
    } else {
        Ok(count)
    }
}
#[napi]
pub fn limit_recorder_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    if !p.get(c"cache")?.truthy()?
        || !p.get(c"persistedSessions")?.truthy()?
        || !p.get(c"providers")?.truthy()?
    {
        return Err(p.type_error(
            "[limit-cache-recorder] requires { cache, persistedSessions, providers }",
        ));
    }
    Ok(methods(
        p,
        &[
            ("appTypeForSession", 1, |p, a| identity(p, a[0], false)),
            ("recordSession", 3, |p, a| {
                let id = resolve(p, a[0], a[2])?;
                if id.truthy()? {
                    record_dto(p, id.get(c"appType")?, id.get(c"providerId")?, a[1])
                } else {
                    null(p)
                }
            }),
            ("recordDto", 3, |p, a| record_dto(p, a[0], a[1], a[2])),
            ("recordProvider", 3, |p, a| {
                let (app, id, r) = (a[0], a[1], a[2]);
                let cache = p.get(c"cache")?;
                let plan = request(p, "providerPlan", &[("providerId", id), ("result", r)])?;
                if !plan.truthy()? {
                    return null(p);
                }
                let action = plan.get(c"action")?;
                if action.is_string("failure")? {
                    return record_failure(cache, app, id, plan.get(c"value")?, null(p)?);
                }
                if action.is_string("dto")? {
                    return record_dto(p, app, id, r.get(c"dto")?);
                }
                let at = if plan.get(c"needsNow")?.truthy()? {
                    now(p)?
                } else {
                    undef(p)?
                };
                call(
                    cache,
                    c"record",
                    &[
                        app,
                        id,
                        request(p, "providerRecord", &[("result", r), ("now", at)])?,
                    ],
                )
            }),
            ("recordProviderFailure", 1, failure),
            ("releaseProviderFailure", 1, release),
            ("setRefresher", 1, |p, a| {
                p.set(c"refresher", a[0])?;
                undef(p)
            }),
            ("recordVendor", 1, vendor),
            ("recordClaude", 3, |p, a| {
                let id = identity(p, a[0], false)?;
                if !id.truthy()? {
                    return null(p);
                }
                let (app, key, cache, r) = (
                    id.get(c"appType")?,
                    id.get(c"providerId")?,
                    p.get(c"cache")?,
                    a[1],
                );
                let plan = request(p, "claudePlan", &[("result", r)])?;
                if plan.get(c"action")?.is_string("failure")? {
                    return record_failure(cache, app, key, plan.get(c"value")?, null(p)?);
                }
                let stamp = || {
                    if plan.get(c"needsNow")?.truthy()? {
                        now(p)
                    } else {
                        undef(p)
                    }
                };
                call(
                    cache,
                    c"record",
                    &[
                        app,
                        key,
                        request(
                            p,
                            "claudeRecord",
                            &[
                                ("result", r),
                                ("barText", a[2]),
                                ("summaryNow", stamp()?),
                                ("now", stamp()?),
                            ],
                        )?,
                    ],
                )
            }),
            ("recordOfficialWindows", 3, |p, a| {
                let (app, id, options) = (a[0], a[1], default_object(a[2])?);
                let windows = options.get(c"windows")?;
                if !request(
                    p,
                    "officialValid",
                    &[("providerId", id), ("windows", windows)],
                )?
                .truthy()?
                {
                    return null(p);
                }
                let at = options.get(c"fetchedAt")?;
                let at = if at.truthy()? { at } else { now(p)? };
                let cache = p.get(c"cache")?;
                let mut input = vec![("appType", app), ("windows", windows), ("at", at)];
                if derived(cache)? {
                    return derive(cache, app, id, "officialRecord", &input, now(p)?);
                }
                input.push(("previous", summary(previous(cache, app, id, true)?)?));
                call(
                    cache,
                    c"record",
                    &[app, id, request(p, "officialRecord", &input)?],
                )
            }),
            ("resolveByHost", 1, |p, a| query(p, "host", a[0], array(p)?)),
            ("resolveByBaseUrl", 1, |p, a| {
                query(p, "baseUrl", a[0], array(p)?)
            }),
            ("liveKeys", 0, |p, _| {
                let set = p.global()?.get(c"Set")?.construct(&[])?;
                each_provider(p, |app, row| {
                    call(
                        set,
                        c"add",
                        &[call(p.get(c"cache")?, c"key", &[app, row.get(c"id")?])?],
                    )?;
                    Ok(())
                })?;
                Ok(set)
            }),
        ],
    )?
    .freeze()?
    .raw())
}
