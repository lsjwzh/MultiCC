use super::*;
type F = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;
fn lookup<'a>(p: L<'a>, kind: L<'a>, id: L<'a>) -> Result<L<'a>> {
    reg(p, c"getProvider", &[kind, id])
}
fn summary<'a>(p: L<'a>, kind: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let r = lookup(p, kind, id)?;
    if r.truthy()? {
        reg(p, c"summarize", &[r])
    } else {
        null(p)
    }
}
fn default<'a>(v: L<'a>, instead: L<'a>) -> Result<L<'a>> {
    if v.undefined()? {
        Ok(instead)
    } else {
        Ok(v)
    }
}
fn direct<'a>(p: L<'a>, protocol: L<'a>, id: L<'a>, o: L<'a>) -> Result<L<'a>> {
    let opts = default_object(o)?;
    let row = lookup(
        p,
        text(
            p,
            if protocol.is_string("openai")? {
                "codex"
            } else {
                "claude"
            },
        )?,
        id,
    )?;
    let summary = if row.truthy()? {
        reg(p, c"summarize", &[row])?
    } else {
        row
    };
    Ok(raw(
        p,
        service::provider_aux_target(
            env(p),
            word(fallback(protocol, "".into())?)?,
            word(fallback(id, "".into())?)?,
            arg(row)?,
            arg(summary)?,
            word(fallback(opts.get(c"port")?, "".into())?)?,
            opts.get(c"claudeOfficialViaProxy")?.truthy()?,
        )?,
    ))
}
fn mapped<'a>(p: L<'a>, method: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    match reg(p, method, args) {
        Ok(v) => Ok(v),
        Err(e) => {
            let Some(error) = p.exception_value()? else {
                return Err(e);
            };
            Err(port(p, c"nativeCode", &[error])?.throw_error())
        }
    }
}
fn session_id(s: L<'_>) -> Result<L<'_>> {
    let id = s.optional(c"id")?;
    string(if id.truthy()? {
        id
    } else {
        fallback(s.optional(c"sessionId")?, "".into())?
    })
}
pub(super) fn install<'a>(p: L<'a>, api: L<'a>) -> Result<()> {
    for (name, arity, count, f) in [
        (
            "enableUnifiedOfficialProviders",
            0,
            0,
            (|p, _| enable(p)) as F,
        ),
        ("normalizeOfficialProviderId", 2, 2, |p, a| {
            let cat = p.get(c"catalog")?;
            if cat.truthy()? {
                call(cat, c"normalize", a)
            } else {
                Ok(a[1])
            }
        }),
        ("isOfficialProviderId", 2, 2, |p, a| {
            if !p.get(c"catalog")?.truthy()? {
                return flag(p, false);
            }
            call(p.get(c"official")?, c"isOfficialProviderId", a)
        }),
        ("getOfficialAccountSelection", 1, 1, |p, a| {
            let cat = p.get(c"catalog")?;
            if cat.truthy()? {
                call(cat, c"active", a)
            } else {
                null(p)
            }
        }),
        ("selectOfficialAccount", 2, 2, |p, a| {
            let cat = p.get(c"catalog")?;
            if !cat.truthy()? {
                return Err(p
                    .global()?
                    .get(c"Error")?
                    .construct(&[text(p, "unified official providers not enabled")?])?
                    .throw_error());
            }
            reg(p, c"summarize", &[call(cat, c"select", a)?])
        }),
        ("getCcSwitchStatus", 0, 0, |p, _| {
            call(p.get(c"sqlite")?, c"getStatus", &[cc_path(p)?])
        }),
        ("ccSwitchAvailable", 0, 0, |p, _| {
            call(p.get(c"sqlite")?, c"getStatus", &[cc_path(p)?])?.get(c"available")
        }),
        (
            "appTypeForCli",
            1,
            1,
            |p, a| match registry::provider_app_type_for_cli(env(p), arg(a[0])?)? {
                Some(s) => text(p, &s),
                None => null(p),
            },
        ),
        ("appTypesForCli", 1, 1, |p, a| {
            strings(p, registry::provider_app_types_for_cli(env(p), arg(a[0])?)?)
        }),
        ("providerSupportsCli", 2, 2, |p, a| {
            if !a[0].truthy()? || !a[1].truthy()? {
                return flag(p, false);
            }
            let v = if a[0].get(c"settingsConfig")?.truthy()? && !a[0].get(c"virtual")?.truthy()? {
                reg(p, c"summarize", &[a[0]])?
            } else {
                a[0]
            };
            flag(
                p,
                registry::provider_supports_cli(env(p), arg(v)?, arg(a[1])?)?,
            )
        }),
        ("normalizeApiFormat", 2, 2, |p, a| {
            text(
                p,
                &crate::provider_settings_config::provider_normalize_api_format(
                    env(p),
                    arg(fields(p, &[("apiFormat", a[0]), ("appType", a[1])])?)?,
                )?,
            )
        }),
        ("compatibleClisForFormat", 1, 1, |p, a| {
            strings(
                p,
                registry::provider_compatible_clis(crate::host_methods::typed(a[0])?, true),
            )
        }),
        ("getProviderSummary", 2, 2, |p, a| summary(p, a[0], a[1])),
        ("getProviderLimitTarget", 2, 2, |p, a| {
            let t = raw(
                p,
                service::provider_balance_target(
                    env(p),
                    arg(lookup(p, a[0], a[1])?)?,
                    word(fallback(a[1], "".into())?)?,
                )?,
            );
            if t.optional(c"strategy")?.is_string("codex-oauth-usage")?
                && t.get(c"officialAccountId")?.truthy()?
            {
                t.assign(
                    c"authFile",
                    call(
                        p.get(c"accounts")?,
                        c"codexAccountAuthFilePath",
                        &[t.get(c"officialAccountId")?],
                    )?,
                )?;
            }
            Ok(t)
        }),
        ("resolveAuxHttpTarget", 2, 3, |p, a| {
            direct(p, a[0], a[1], a[2])
        }),
        ("resolveCodexDirectHttp", 1, 1, |p, a| {
            let t = direct(p, text(p, "openai")?, a[0], und(p)?)?;
            let copy = crate::js_live::spread(t)?;
            copy.set(c"canDirect", flag(p, t.get(c"available")?.truthy()?)?)?;
            Ok(copy)
        }),
        ("applyProviderRelayModelCatalog", 1, 3, |p, a| {
            let now = if a[2].undefined()? {
                call(p.global()?.get(c"Date")?, c"now", &[])?.number()?
            } else {
                crate::host_methods::typed(a[2])?
            };
            Ok(raw(
                p,
                service::provider_apply_relay_catalog(
                    env(p),
                    arg(a[0])?,
                    arg(default_object(a[1])?)?,
                    now,
                )?,
            ))
        }),
        ("resolveSpawnEnv", 1, 1, |p, a| {
            mapped(p, c"resolveSpawnEnv", a)
        }),
        ("buildChildEnv", 2, 3, |p, a| {
            mapped(p, c"buildChildEnv", &[a[0], a[1], default_object(a[2])?])
        }),
        ("materializeCodexAuth", 2, 2, |p, a| {
            call(
                p.get(c"codexHome")?,
                c"materialize",
                &[a[0], a[1], flag(p, true)?],
            )
        }),
        ("assertClaudeProxyEnvApplied", 0, 1, |p, a| {
            flag(
                p,
                crate::provider_claude_proxy_policy::assert_claude_proxy_env_applied(
                    env(p),
                    arg(a[0])?,
                )?,
            )
        }),
        ("claudeProxyEnvRequired", 0, 1, |p, a| {
            flag(
                p,
                crate::provider_claude_proxy_policy::claude_proxy_env_required(env(p), arg(a[0])?)?,
            )
        }),
        ("codexProxyConfigRequired", 0, 1, |p, a| {
            let o = default_object(a[0])?;
            let id = call(
                string(fallback(o.get(c"providerId")?, "".into())?)?,
                c"trim",
                &[],
            )?;
            let sub = o.get(c"subagent")?;
            flag(
                p,
                crate::codex_provider_home::codex_proxy_config_required(
                    env(p),
                    arg(fields(
                        p,
                        &[
                            ("providerId", id),
                            (
                                "subagentProviderId",
                                if sub.truthy()? {
                                    sub.get(c"providerId")?
                                } else {
                                    sub
                                },
                            ),
                        ],
                    )?)?,
                )?,
            )
        }),
        ("codexProviderProxyable", 1, 1, |p, a| {
            let provider = if a[0].kind()? == sys::ValueType::napi_string {
                lookup(p, text(p, "codex")?, a[0])?
            } else {
                a[0]
            };
            if crate::codex_official_relay::official(provider)? {
                return flag(p, true);
            }
            call(
                p.get(c"sdk")?,
                c"codexProviderProxyable",
                &[
                    provider,
                    fields(
                        p,
                        &[("getProvider", p.get(c"registry")?.get(c"getProvider")?)],
                    )?,
                ],
            )
        }),
        ("resolveSessionWireModel", 1, 2, |p, a| {
            let o = default_object(a[1])?;
            let opts = fields(
                p,
                &[
                    (
                        "providerModel",
                        default(o.get(c"providerModel")?, null(p)?)?,
                    ),
                    (
                        "providerModels",
                        default(o.get(c"providerModels")?, array(p)?)?,
                    ),
                    (
                        "skipDefaultModel",
                        default(o.get(c"skipDefaultModel")?, flag(p, false)?)?,
                    ),
                    ("defaultModel", default(o.get(c"defaultModel")?, null(p)?)?),
                ],
            )?;
            Ok(raw(
                p,
                service::provider_wire_model(env(p), arg(a[0])?, arg(opts)?)?,
            ))
        }),
        ("modelValidForProvider", 4, 4, |p, a| {
            if !a[2].truthy()? {
                return flag(p, true);
            }
            let s = if !a[3].undefined()? {
                a[3]
            } else if a[1].truthy()? {
                summary(p, a[0], a[1])?
            } else {
                null(p)?
            };
            flag(
                p,
                service::provider_valid_model(
                    env(p),
                    crate::host_methods::typed(a[0])?,
                    word(string(a[2])?)?,
                    arg(s)?,
                )?,
            )
        }),
        ("readCodexOfficialModels", 1, 1, |p, a| {
            let path = if a[0].truthy()? {
                a[0]
            } else {
                join(
                    p,
                    &[
                        &word(port(p, c"homedir", &[])?)?,
                        ".codex",
                        "models_cache.json",
                    ],
                )?
            };
            reg(p, c"readOfficialModels", &[path])
        }),
        ("getRelayImportToken", 2, 2, |p, a| {
            let row = lookup(p, a[0], a[1])?;
            if !row.truthy()?
                || (p.get(c"catalog")?.truthy()? && row.get(c"builtinOfficial")?.truthy()?)
            {
                return text(p, "");
            }
            text(
                p,
                &service::provider_import_token(
                    env(p),
                    word(fallback(a[0], "".into())?)?,
                    arg(row)?,
                    word(current_port(p)?)?,
                )?,
            )
        }),
        ("resolveCliRelayTarget", 2, 2, |p, a| {
            if (!a[0].is_string("claude")? && !a[0].is_string("codex")?) || !a[1].truthy()? {
                return null(p);
            }
            let row = lookup(p, a[0], a[1])?;
            if !row.truthy()?
                || row.get(c"virtual")?.truthy()?
                || (p.get(c"catalog")?.truthy()? && row.get(c"builtinOfficial")?.truthy()?)
            {
                return null(p);
            }
            Ok(raw(
                p,
                service::provider_cli_relay(
                    env(p),
                    word(a[0])?,
                    arg(row)?,
                    forced(p)?,
                    word(current_port(p)?)?,
                )?,
            ))
        }),
        ("getProviderUsageStats", 0, 0, |p, _| {
            let map = function(p, "", 1, 1, |_, a| {
                fields(
                    a[0],
                    &[
                        ("id", a[0].get(c"id")?),
                        ("name", a[0].get(c"name")?),
                        ("appType", a[0].get(c"appType")?),
                    ],
                )
            })?;
            let rows = call(call(repo(p)?, c"read", &[])?, c"map", &[map])?;
            Ok(raw(
                p,
                service::provider_usage_stats(
                    env(p),
                    word(p.get(c"paths")?.get(c"root")?)?,
                    arg(rows)?,
                )?,
            ))
        }),
        ("readDailyWindows", 0, 0, |p, _| {
            Ok(raw(
                p,
                service::provider_daily_windows(env(p), word(p.get(c"paths")?.get(c"root")?)?)?,
            ))
        }),
    ] {
        api.define_key(text(p, name)?, function(p, name, arity, count, f)?)?;
    }
    for (name, lane) in [
        ("zcodeSessionHome", "zcode"),
        ("kimiSessionHome", "kimi"),
        ("grokSessionHome", "grok"),
    ] {
        api.define_key(
            text(p, name)?,
            function(p, name, 1, 1, move |p, a| {
                text(
                    p,
                    &service::provider_vendor_home(
                        word(p.get(c"vendorRoots")?.get_key(text(p, lane)?)?)?,
                        lane.into(),
                        word(session_id(a[0])?)?,
                    )?,
                )
            })?,
        )?;
    }
    for (name, lane) in [
        ("buildKimiCodeRoute", "kimi"),
        ("buildDshRoute", "dsh"),
        ("buildGrokRoute", "grok"),
    ] {
        api.define_key(
            text(p, name)?,
            function(p, name, 2, 2, move |p, a| {
                let identity = fields(
                    p,
                    &[
                        ("id", session_id(a[1])?),
                        ("model", a[1].optional(c"model")?),
                    ],
                )?;
                Ok(raw(
                    p,
                    service::provider_vendor_route(
                        env(p),
                        lane.into(),
                        arg(a[0])?,
                        arg(reg(p, c"summarize", &[a[0]])?)?,
                        arg(identity)?,
                        word(fallback(
                            p.get(c"vendorRoots")?.get_key(text(p, lane)?)?,
                            "".into(),
                        )?)?,
                        arg(p.get(c"modelLimits")?)?,
                    )?,
                ))
            })?,
        )?;
    }
    Ok(())
}
