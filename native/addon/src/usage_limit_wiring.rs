use crate::quota_host::*;
use napi_derive::napi;

fn session<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    call(p.get(c"persistedSessions")?, c"get", &[id])
}
fn key<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let rec = session(p, a[0])?;
    if !rec.truthy()? {
        return text(p, "");
    }
    let cli = string(fallback(rec.get(c"cli")?, "claude".into())?)?;
    let providers = p.get(c"providers")?;
    if !(cli.is_string("claude")? || cli.is_string("claude-exp")?) {
        return text(p, "");
    }
    let app = call(providers, c"appTypeForCli", &[cli])?;
    if !app.is_string("claude")? {
        return text(p, "");
    }
    let id = rec.get(c"provider")?;
    let summary = if id.truthy()? {
        p.catch(|| call(providers, c"getProviderSummary", &[app, id]))?
            .unwrap_or(null(p)?)
    } else {
        null(p)?
    };
    if summary.optional(c"baseUrl")?.truthy()? {
        return text(p, "");
    }
    let account = string(fallback(
        summary.optional(c"officialAccountId")?,
        "".into(),
    )?)?;
    if account.truthy()? {
        call(text(p, "claude:")?, c"concat", &[account])
    } else {
        p.get(c"queue")?.get(c"DEFAULT_KEY")
    }
}
fn target<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let rec = session(p, a[0])?;
    if !rec.optional(c"provider")?.truthy()? {
        return null(p);
    }
    let prov = p.get(c"providers")?;
    let app = call(
        prov,
        c"appTypeForCli",
        &[fallback(rec.get(c"cli")?, "claude".into())?],
    )?;
    if !app.truthy()? {
        return null(p);
    }
    call(
        prov,
        c"getProviderLimitTarget",
        &[app, rec.get(c"provider")?],
    )
}
fn broadcast<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (id, dto) = (a[0], a[1]);
    let routed = session(p, id)?.optional(c"cli")?.is_string("opencode")?;
    if p.get(c"recordLimit")?.truthy()? {
        ignored(p, || p.get(c"recordLimit")?.call_plain(&[id, dto]))?;
    }
    let view = p.get(c"view")?;
    let msg = if dto.get(c"kind")?.is_string("window")? {
        let info = pick(
            dto,
            &[c"rateLimitType", c"status", c"utilization", c"resetsAt"],
        )?;
        info.set(c"provider", fallback(dto.get(c"provider")?, "glm".into())?)?;
        if dto.get(c"windows")?.is_array()? {
            info.set(c"windows", dto.get(c"windows")?)?;
        }
        let norm = call(view, c"normalizeWindowEvent", &[info, now(p)?])?;
        let mut bar = null(p)?;
        if norm.truthy()? {
            if norm.get(c"provider")?.is_string("claude")? {
                let live = p.get(c"live")?;
                call(live, c"rememberClaudeLive", &[id, norm])?;
                bar = call(live, c"renderClaudeBar", &[id])?;
            } else {
                bar = call(view, c"windowEventBar", &[norm])?;
            }
            if routed && bar.truthy()? {
                bar = call(view, c"labelRoutedProvider", &[bar, norm.get(c"provider")?])?;
            }
        }
        fields(
            p,
            &[
                ("type", text(p, "rate_limit_event")?),
                ("sessionId", id),
                ("rate_limit_info", info),
                ("bar", bar),
            ],
        )?
    } else if dto.get(c"kind")?.is_string("balance")? {
        let mut bar = call(
            view,
            c"balanceBar",
            &[call(view, c"normalizeBalance", &[dto])?],
        )?;
        if routed && bar.truthy()? {
            bar = call(view, c"labelRoutedBalance", &[bar])?;
        }
        fields(
            p,
            &[
                ("type", text(p, "usage_balance_event")?),
                ("sessionId", id),
                ("balance_info", dto),
                ("bar", bar),
            ],
        )?
    } else {
        return undef(p);
    };
    p.get(c"chatBroadcast")?.call_plain(&[id, msg])?;
    undef(p)
}
#[napi]
pub fn usage_limit_wiring(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    if !p.get(c"persistedSessions")?.truthy()?
        || !p.get(c"providers")?.truthy()?
        || !callable(p.get(c"chatBroadcast")?)?
        || !callable(p.get(c"createPoller")?)?
    {
        return Err(error_value(p,"createUsageLimitWiring requires persistedSessions, providers, chatBroadcast, createPoller")?.throw_error());
    }
    call(
        p.get(c"queue")?,
        c"configureClaudeKeyResolver",
        &[function(p, "claudeSubscriptionKey", 1, 1, key)?],
    )?;
    Ok(p.get(c"createPoller")?
        .call_plain(&[methods(
            p,
            &[("resolveTarget", 1, target), ("broadcast", 2, broadcast)],
        )?])?
        .raw())
}

fn live_for<'a>(p: L<'a>, key: L<'a>, at: L<'a>) -> Result<L<'a>> {
    let map = p.get(c"entries")?;
    let live = call(map, c"get", &[key])?;
    if !live.truthy()? {
        return null(p);
    }
    let current = call(
        p,
        c"merge",
        &[fields(p, &[("previous", live), ("nowMs", at)])?],
    )?;
    if !current.undefined()? {
        if !current.truthy()? {
            call(map, c"delete", &[key])?;
        }
        return Ok(current);
    }
    let obs = live.get(c"observedAtMs")?.explicit_number()?;
    let reset = live.get(c"resetsAtMs")?.explicit_number()?;
    if (reset.is_finite() && reset > 0. && reset <= at.number()?)
        || at.number()? - (if obs.is_nan() { 0. } else { obs }) > 18_000_000.
    {
        call(map, c"delete", &[key])?;
        return null(p);
    }
    Ok(live)
}
#[napi]
pub fn claude_bar_state(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    p.set(c"entries", p.global()?.get(c"Map")?.construct(&[])?)?;
    Ok(methods(
        p,
        &[
            ("rememberClaudeLive", 2, |p, a| {
                if !a[0].truthy()? || !a[1].optional(c"provider")?.is_string("claude")? {
                    return undef(p);
                }
                let key = call(p.get(c"queue")?, c"claudeUsageKey", &[a[0]])?;
                let map = p.get(c"entries")?;
                let merged = call(
                    p,
                    c"merge",
                    &[fields(
                        p,
                        &[
                            ("previous", call(map, c"get", &[key])?),
                            ("next", a[1]),
                            ("nowMs", a[1].get(c"observedAtMs")?),
                        ],
                    )?],
                )?;
                call(
                    map,
                    c"set",
                    &[key, if merged.undefined()? { a[1] } else { merged }],
                )?;
                if map.get(c"size")?.number()? > 50. {
                    let mut oldest = None;
                    let mut at = f64::INFINITY;
                    map.for_each(|pair| {
                        let (key, row) = pair.iterator_pair()?;
                        let v = row.optional(c"observedAtMs")?.explicit_number()?;
                        let v = if v.is_nan() { 0. } else { v };
                        if v < at {
                            at = v;
                            oldest = Some(key);
                        }
                        Ok(())
                    })?;
                    if let Some(key) = oldest {
                        call(map, c"delete", &[key])?;
                    }
                }
                undef(p)
            }),
            ("readClaudeLive", 2, |p, a| {
                let at = if a[1].undefined()? { now(p)? } else { a[1] };
                live_for(p, call(p.get(c"queue")?, c"claudeUsageKey", &[a[0]])?, at)
            }),
            ("renderClaudeBar", 2, |p, a| {
                let at = if a[1].undefined()? { now(p)? } else { a[1] };
                let queue = p.get(c"queue")?;
                let key = call(queue, c"claudeUsageKey", &[a[0]])?;
                let entry = call(queue, c"readClaudeUsage", &[key])?;
                call(
                    p,
                    c"claudeBar",
                    &[
                        if entry.truthy()? {
                            entry.get(c"result")?
                        } else {
                            entry
                        },
                        live_for(p, key, at)?,
                        at,
                    ],
                )
            }),
            ("resetClaudeBarState", 0, |p, _| {
                call(p.get(c"entries")?, c"clear", &[])
            }),
        ],
    )?
    .raw())
}
