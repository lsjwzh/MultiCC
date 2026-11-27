use super::*;
fn coded<'a>(p: L<'a>, message: &str, code: &str) -> Result<L<'a>> {
    let e = error_value(p, message)?;
    e.set(c"code", text(p, code)?)?;
    Err(e.throw_error())
}
fn required<'a>(owner: L<'a>, name: &CStr, label: &str) -> Result<L<'a>> {
    if !owner.truthy()? || !callable(owner.get(name)?)? {
        return coded(
            owner,
            &format!("{label}.{} is required", name.to_string_lossy()),
            "PROVIDER_ROUTER_ADAPTER_INVALID",
        );
    }
    bind(owner.get(name)?, owner)
}
fn routing_view<'a>(providers: L<'a>, fallback: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if callable(providers.get(c"routingProviderView")?)? {
        bind(providers.get(c"routingProviderView")?, providers)
    } else {
        fallback()
    }
}
fn store<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let providers = a[0];
    let get = required(providers, c"getProvider", "providers")?;
    let view = routing_view(providers, || Ok(get))?;
    fields(
        p,
        &[
            (
                "getProvider",
                function(view, "getProvider", 2, 2, |f, a| f.call_plain(a))?,
            ),
            (
                "getProviderSummary",
                required(providers, c"getProviderSummary", "providers")?,
            ),
        ],
    )?
    .freeze()
}
fn date_now(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"Date")?.get(c"now")
}
fn observed<'a>(p: L<'a>, input: L<'a>, protocol: L<'a>, clock: L<'a>) -> Result<L<'a>> {
    let info = if object(input)? && input.truthy()? {
        input
    } else {
        fields(p, &[])?
    };
    let role = truthy_field(info, &[c"roleKind", c"role"], text(p, "main")?)?;
    let usage = truthy_field(info, &[c"tokens", c"usage"], null(p)?)?;
    let sub = role.is_string("sub")?;
    let agent = if sub {
        truthy_field(info, &[c"agentRole"], text(p, "default")?)?
    } else {
        null(p)?
    };
    let out = fields(p, &[])?;
    if info.get(c"eventId")?.truthy()? {
        out.set(c"eventId", info.get(c"eventId")?)?;
    }
    let ts = truthy_field(info, &[c"occurredAt", c"timestamp"], undef(p)?)?;
    out.set(
        c"occurredAt",
        if ts.truthy()? {
            ts
        } else {
            clock.call_plain(&[])?
        },
    )?;
    let session = info.get(c"sessionId")?;
    out.set(
        c"sessionId",
        if session.truthy()? {
            session
        } else {
            info.get(c"externalSessionId")?
        },
    )?;
    out.set(
        c"providerId",
        truthy_field(info, &[c"providerId"], text(p, "_default_")?)?,
    )?;
    out.set(
        c"providerName",
        truthy_field(info, &[c"providerName"], text(p, "")?)?,
    )?;
    out.set(c"roleKind", role)?;
    if agent.truthy()? {
        out.set(c"agentRole", agent)?;
    }
    out.set(
        c"routeName",
        if sub {
            truthy_field(info, &[c"routeName"], agent)?
        } else {
            role
        },
    )?;
    out.set(
        c"source",
        truthy_field(info, &[c"source"], text(p, "exact")?)?,
    )?;
    out.set(
        c"coverage",
        truthy_field(
            info,
            &[c"coverage"],
            text(
                p,
                if usage.truthy()? {
                    "observed"
                } else {
                    "unobservable"
                },
            )?,
        )?,
    )?;
    out.set(
        c"status",
        truthy_field(
            info,
            &[c"status"],
            text(
                p,
                if usage.truthy()? {
                    "success"
                } else {
                    "unobservable"
                },
            )?,
        )?,
    )?;
    out.set(c"protocol", truthy_field(info, &[c"protocol"], protocol)?)?;
    out.set(c"model", truthy_field(info, &[c"model"], text(p, "")?)?)?;
    if usage.truthy()? {
        out.set(c"usage", usage)?;
    }
    out.set(
        c"latencyMs",
        truthy_field(info, &[c"latencyMs"], num(p, 0.)?)?,
    )?;
    if !info.get(c"statusCode")?.nullish()? {
        out.set(c"statusCode", info.get(c"statusCode")?)?;
    }
    if info.get(c"errorCode")?.truthy()? {
        out.set(c"errorCode", info.get(c"errorCode")?)?;
    }
    Ok(out)
}
fn normalize<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let v = a[0];
    if v.truthy()?
        && v.get(c"occurredAt")?.truthy()?
        && v.get(c"source")?.truthy()?
        && v.get(c"coverage")?.truthy()?
        && v.get(c"protocol")?.truthy()?
    {
        return Ok(v);
    }
    let protocol = if v.truthy()? { v.get(c"protocol")? } else { v };
    observed(p, v, protocol, p.get(c"now")?)
}
fn mount<'a>(p: L<'a>, name: &CStr, protocol: &str, a: &mut [L<'a>]) -> Result<L<'a>> {
    let f = required(p.get(c"router")?, name, "legacy CPR compatibility")?;
    let options = default_object(a[1])?;
    let out = spread(options)?;
    if !p.get(c"nativeEvents")?.truthy()? {
        let sink = if callable(options.get(c"onUsageEvent")?)? {
            options.get(c"onUsageEvent")?
        } else {
            null(p)?
        };
        out.delete(c"onUsageEvent")?;
        if sink.truthy()? {
            let owner = fields(
                p,
                &[
                    ("sink", sink),
                    ("protocol", text(p, protocol)?),
                    ("now", p.get(c"now")?),
                ],
            )?;
            out.set(
                c"onUsage",
                function(owner, "", 1, 1, |s, a| {
                    let event = observed(s, a[0], s.get(c"protocol")?, s.get(c"now")?)?;
                    s.get(c"sink")?.call_plain(&[event])
                })?,
            )?;
        }
    }
    f.call_plain(&[a[0], out])
}
fn legacy<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let providers = opts.get(c"providers")?;
    let router = opts.get(c"router")?;
    let clock = with_default(opts.get(c"now")?, date_now(p)?)?;
    let get = routing_view(providers, || {
        required(providers, c"getProvider", "providers")
    })?;
    let summary = required(providers, c"getProviderSummary", "providers")?;
    let version = fold_string(fallback(router.optional(c"API_VERSION")?, V::from(""))?)?;
    let major = version.split_once('.').is_some_and(|(major, _)| {
        !major.is_empty()
            && major.bytes().all(|b| b.is_ascii_digit())
            && major.bytes().any(|b| b != b'0')
    });
    let native_events = major && callable(router.get(c"normalizeUsageEvent")?)?;
    let owner = fields(
        p,
        &[
            ("router", router),
            ("now", clock),
            ("nativeEvents", flag(p, native_events)?),
        ],
    )?;
    let out = fields(
        p,
        &[
            ("getProvider", get),
            ("getProviderSummary", summary),
            (
                "resolveSpawnEnv",
                required(providers, c"resolveSpawnEnv", "providers")?,
            ),
            (
                "buildChildEnv",
                required(providers, c"buildChildEnv", "providers")?,
            ),
            (
                "resolveSessionWireModel",
                required(providers, c"resolveSessionWireModel", "providers")?,
            ),
        ],
    )?;
    out.spread_from(methods(
        owner,
        &[
            ("normalizeUsageEvent", 1, normalize),
            ("mountClaudeProxy", 2, |s, a| {
                mount(s, c"mountClaudeProxy", "anthropic-messages", a)
            }),
            ("mountCodexProxy", 2, |s, a| {
                mount(s, c"mountCodexProxy", "openai-responses", a)
            }),
        ],
    )?)?;
    out.freeze()
}
fn blank_spawn(p: L<'_>) -> Result<L<'_>> {
    fields(
        p,
        &[
            ("env", fields(p, &[])?),
            ("skipDefaultModel", flag(p, false)?),
            ("aliasOnly", flag(p, false)?),
            ("providerModel", null(p)?),
            ("providerModels", array(p)?),
            ("providerName", null(p)?),
        ],
    )
}
fn shadow_spawn<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let input = a[0];
    let cli = input.get(c"cli")?;
    if !(cli.is_string("codex")? || cli.is_string("codex-exp")?) {
        return p.get(c"spawn")?.call_plain(&[input]);
    }
    if !input.get(c"providerId")?.truthy()? {
        return blank_spawn(p);
    }
    let provider = call(
        p.get(c"store")?,
        c"getProvider",
        &[text(p, "codex")?, input.get(c"providerId")?],
    )?;
    if !provider.truthy()? {
        return blank_spawn(p);
    }
    let home = p
        .get(c"join")?
        .call_plain(&[p.get(c"dir")?, input.get(c"providerId")?])?;
    let out = blank_spawn(p)?;
    out.set(c"env", fields(p, &[("CODEX_HOME", home)])?)?;
    let name = provider.get(c"name")?;
    out.set(
        c"providerName",
        if name.truthy()? {
            name
        } else {
            input.get(c"providerId")?
        },
    )?;
    out.set(c"codexHome", home)?;
    Ok(out)
}
fn forbid<'a>(p: L<'a>, name: &'static str) -> Result<L<'a>> {
    function(p, name, 0, 0, move |p, _| {
        coded(
            p,
            &format!("shadow mode forbids {name}"),
            "CPR_SHADOW_WRITE_FORBIDDEN",
        )
    })
}
fn shadow<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let router = opts.get(c"router")?;
    let store = opts.get(c"providerStore")?;
    let dir = opts.get(c"codexHomesDir")?;
    let wire = required(router, c"resolveSessionWireModel", "router")?;
    let normalize = required(router, c"normalizeUsageEvent", "router")?;
    let spawn = required(router, c"resolveSpawnEnv", "router")?;
    let owner = fields(
        p,
        &[
            ("store", store),
            ("dir", dir),
            ("spawn", spawn),
            ("join", p.get(c"pathJoin")?),
        ],
    )?;
    fields(
        p,
        &[
            ("API_VERSION", router.get(c"API_VERSION")?),
            ("CAPABILITIES", router.get(c"CAPABILITIES")?),
            (
                "resolveSpawnEnv",
                function(owner, "resolveSpawnEnv", 1, 1, shadow_spawn)?,
            ),
            ("buildChildEnv", forbid(p, "buildChildEnv")?),
            ("resolveSessionWireModel", wire),
            ("normalizeUsageEvent", normalize),
            ("mountClaudeProxy", forbid(p, "mountClaudeProxy")?),
            ("mountCodexProxy", forbid(p, "mountCodexProxy")?),
        ],
    )?
    .freeze()
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    fields(
        p,
        &[
            (
                "createLegacyProviderRouterAdapter",
                function(p, "createLegacyProviderRouterAdapter", 0, 1, legacy)?,
            ),
            (
                "createProviderStoreAdapter",
                function(p, "createProviderStoreAdapter", 1, 1, store)?,
            ),
            (
                "createReadOnlyShadowRouter",
                function(p, "createReadOnlyShadowRouter", 0, 1, shadow)?,
            ),
            (
                "legacyUsageToObservedInput",
                function(p, "legacyUsageToObservedInput", 1, 2, |p, a| {
                    let opt = default_object(a[1])?;
                    observed(
                        p,
                        a[0],
                        opt.get(c"protocol")?,
                        with_default(opt.get(c"now")?, date_now(p)?)?,
                    )
                })?,
            ),
        ],
    )
}
