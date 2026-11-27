use super::*;

pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let runtime = create(p, &mut [undef(p)?])?;
    let out = bind(
        p,
        &[("createCodexAccountModelCatalogRuntime", 0, 1, create)],
    )?;
    out.set(c"defaultRuntime", runtime)?;
    out.set(
        c"startDefaultRuntime",
        function(runtime, "startDefaultRuntime", 0, 0, |r, _| {
            let work = then(undef(r)?, r, |r, _| call(r, c"hydrate", &[]))?;
            recover(work, r, |r, _| undef(r))?;
            Ok(r)
        })?,
    )?;
    Ok(out)
}
fn create<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let options = default_object(a[0])?;
    let accounts = or(options.get(c"accounts")?, || {
        plain(p, c"createAccounts", &[])
    })?;
    let global = or(options.get(c"globalHome")?, || plain(p, c"globalHome", &[]))?;
    let o = fields(
        p,
        &[
            ("ports", p),
            ("options", options),
            ("accounts", accounts),
            ("globalHome", global),
            ("invalid", map(p)?),
            ("pending", map(p)?),
            (
                "getNative",
                or(options.get(c"getNative")?, || p.get(c"getNative"))?,
            ),
            (
                "runNative",
                or(options.get(c"runNative")?, || p.get(c"runNative"))?,
            ),
        ],
    )?;
    bind(
        o,
        &[
            ("resolveProvider", 0, 1, |o, a| resolve(o, a[0])),
            ("peekProvider", 1, 1, |o, a| peek(o, a[0])),
            ("refreshProvider", 1, 2, refresh),
            ("refreshAccount", 1, 2, refresh_account),
            ("isRefreshing", 1, 1, |o, a| {
                Ok(
                    o.catch(|| call(o.get(c"pending")?, c"has", &[home(o, resolve(o, a[0])?)?]))?
                        .unwrap_or(flag(o, false)?),
                )
            }),
            ("loadProvider", 1, 1, |o, a| load(o, a[0])),
            ("hydrate", 0, 0, hydrate),
        ],
    )?
    .freeze()
}
fn providers(o: L<'_>) -> Result<L<'_>> {
    or(o.get(c"options")?.get(c"providers")?, || {
        plain(o.get(c"ports")?, c"providers", &[])
    })
}
fn resolve<'a>(o: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let v = with_default(value, text(o, "codex-official")?)?;
    if object(v)? {
        return Ok(v);
    }
    call(
        providers(o)?,
        c"getProvider",
        &[
            text(o, "codex")?,
            string(fallback(v, V::string("codex-official"))?)?,
        ],
    )
}
fn account<'a>(o: L<'a>, p: L<'a>) -> Result<L<'a>> {
    let id = plain(o.get(c"ports")?, c"accountId", &[p])?;
    if id.truthy()? {
        return Ok(id);
    }
    if p.truthy()?
        && p.get(c"activeAccountId")?.truthy()?
        && !p.get(c"activeAccountId")?.is_string("global")?
    {
        call(
            o.get(c"accounts")?,
            c"codexDir",
            &[p.get(c"activeAccountId")?],
        )?;
        return p.get(c"activeAccountId");
    }
    text(o, "global")
}
fn home<'a>(o: L<'a>, p: L<'a>) -> Result<L<'a>> {
    let id = account(o, p)?;
    if id.is_string("global")? {
        o.get(c"globalHome")
    } else {
        call(o.get(c"accounts")?, c"codexDir", &[id])
    }
}
fn official<'a>(o: L<'a>, p: L<'a>) -> Result<bool> {
    plain(o.get(c"ports")?, c"officialCodex", &[p])?.truthy()
}
fn unavailable<'a>(o: L<'a>, code: &str) -> Result<L<'a>> {
    fields(
        o,
        &[
            ("models", array(o)?),
            ("fetchedAt", num(o, 0.)?),
            ("cliVersion", text(o, "")?),
            ("stale", flag(o, true)?),
            (
                "diagnostic",
                fields(
                    o,
                    &[
                        ("code", text(o, code)?),
                        ("message", text(o, "模型目录暂不可用，请稍后重试")?),
                    ],
                )?,
            ),
            ("source", text(o, "unavailable")?),
        ],
    )
}
fn peek<'a>(o: L<'a>, v: L<'a>) -> Result<L<'a>> {
    let read = o.catch(|| {
        let p = resolve(o, v)?;
        if !official(o, p)? {
            return unavailable(o, "not_official");
        }
        let home = home(o, p)?;
        if call(o.get(c"invalid")?, c"has", &[home])?.truthy()? {
            let r = unavailable(o, "refreshing")?;
            r.set(c"source", text(o, "loading")?)?;
            return Ok(r);
        }
        json_call(
            o,
            c"parse",
            call(plain(o, c"getNative", &[])?, c"codexModelsPeek", &[home])?,
        )
    })?;
    match read {
        Some(v) => Ok(v),
        None => unavailable(o, "native_unavailable"),
    }
}
fn load<'a>(o: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let promise = async_result(o, || {
        let p = resolve(o, value)?;
        if !official(o, p)? {
            return unavailable(o, "not_official");
        }
        let home = home(o, p)?;
        if call(o.get(c"invalid")?, c"has", &[home])?.truthy()? {
            return peek(o, p);
        }
        let ctx = fields(
            o,
            &[
                ("o", o),
                ("provider", p),
                ("home", home),
                ("addon", plain(o, c"getNative", &[])?),
            ],
        )?;
        let op = function(ctx, "load", 0, 0, |c, _| {
            call(c.get(c"addon")?, c"codexModelsLoad", &[c.get(c"home")?])
        })?;
        then(plain(o, c"runNative", &[op])?, ctx, |c, _| {
            peek(c.get(c"o")?, c.get(c"provider")?)
        })
    })?;
    recover(promise, o, |o, _| unavailable(o, "native_unavailable"))
}
fn child_env(c: L<'_>) -> Result<L<'_>> {
    let o = c.get(c"o")?;
    let options = o.get(c"options")?;
    let ports = o.get(c"ports")?;
    let base = if callable(options.get(c"env")?)? {
        call(options, c"env", &[])?
    } else {
        or(options.get(c"env")?, || plain(ports, c"env", &[]))?
    };
    let proxy_env = or(options.get(c"getChildProxyEnv")?, || {
        ports.get(c"childProxyEnv")
    })?;
    let base = plain(ports, c"stripEnv", &[base])?;
    then(proxy_env.call_plain(&[base])?, c, |c, a| {
        let o = c.get(c"o")?;
        let opts = o.get(c"options")?;
        let env = plain(o.get(c"ports")?, c"stripEnv", &[a[0]])?;
        env.delete(c"CODEX_API_KEY")?;
        env.set(c"CODEX_HOME", c.get(c"home")?)?;
        c.set(c"env", env)?;
        let p = c.get(c"provider")?;
        if !p.optional(c"egressBinding")?.truthy()? {
            return Ok(env);
        }
        let fun = opts.get(c"resolveProxyUrl")?;
        let binding = p.get(c"egressBinding")?;
        let value = if fun.truthy()? {
            fun.call_plain(&[binding])?
        } else {
            let resolver = or(o.get(c"egress")?, || {
                let r = plain(o.get(c"ports")?, c"createEgress", &[])?;
                o.set(c"egress", r)?;
                Ok(r)
            })?;
            call(resolver, c"resolveProxyUrl", &[binding])?
        };
        then(value, c, |c, a| {
            if !a[0].truthy()? {
                return Err(error_value(c, "egress_unavailable")?.throw_error());
            }
            let env = c.get(c"env")?;
            for k in [
                c"HTTP_PROXY",
                c"http_proxy",
                c"HTTPS_PROXY",
                c"https_proxy",
                c"ALL_PROXY",
                c"all_proxy",
            ] {
                env.set(k, a[0])?
            }
            let local = text(c, "localhost,127.0.0.1,::1")?;
            env.set(c"no_proxy", local)?;
            env.set(c"NO_PROXY", local)?;
            Ok(env)
        })
    })
}
fn refresh<'a>(o: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[1])?;
    let pair = o.catch(|| {
        let p = resolve(o, a[0])?;
        if official(o, p)? {
            Ok(Some((p, home(o, p)?)))
        } else {
            Ok(None)
        }
    })?;
    let (p, home) = match pair {
        Some(Some(pair)) => pair,
        Some(None) => return resolved(unavailable(o, "not_official")?),
        None => return resolved(unavailable(o, "account_unavailable")?),
    };
    let explicit = opts.get(c"force")?.is_true()?;
    let invalid = o.get(c"invalid")?;
    let ticket = or(opts.get(c"_ticket")?, || {
        if explicit {
            o.global()?
                .get(c"Symbol")?
                .call_plain(&[text(o, "login-refresh")?])
        } else {
            call(invalid, c"get", &[home])
        }
    })?;
    if explicit && !opts.get(c"_ticket")?.truthy()? {
        call(invalid, c"set", &[home, ticket])?;
    }
    let force = explicit || call(invalid, c"has", &[home])?.truthy()?;
    let requested = opts.get(c"refresh")?.is_true()?;
    let pending = o.get(c"pending")?;
    let active = call(pending, c"get", &[home])?;
    let c = fields(
        o,
        &[
            ("o", o),
            ("provider", p),
            ("options", opts),
            ("home", home),
            ("ticket", ticket),
            ("force", flag(o, force)?),
            ("refresh", flag(o, requested)?),
        ],
    )?;
    if active.truthy()? {
        if explicit
            || (requested
                && !active.get(c"refresh")?.truthy()?
                && !active.get(c"force")?.truthy()?)
        {
            return then(active.get(c"promise")?, c, |c, _| {
                let opts = spread(c.get(c"options")?)?;
                opts.set(c"_ticket", c.get(c"ticket")?)?;
                refresh(c.get(c"o")?, &mut [c.get(c"provider")?, opts])
            });
        }
        return active.get(c"promise");
    }
    let work = then(undef(o)?, c, |c, _| {
        c.set(c"addon", plain(c.get(c"o")?, c"getNative", &[])?)?;
        then(child_env(c)?, c, |c, a| {
            let o = c.get(c"o")?;
            let env = a[0];
            let cli = or(o.get(c"options")?.get(c"cliBin")?, || {
                let logger = methods(
                    o,
                    &[("log", 0, |p, _| undef(p)), ("warn", 0, |p, _| undef(p))],
                )?;
                plain(
                    o.get(c"ports")?,
                    c"commands",
                    &[fields(o, &[("env", env), ("logger", logger)])?],
                )?
                .get(c"codex")
            })?;
            c.set(c"cliBin", cli)?;
            let op = function(c, "refresh", 0, 0, |c, _| {
                let input = fields(
                    c,
                    &[
                        ("home", c.get(c"home")?),
                        ("cliBin", c.get(c"cliBin")?),
                        ("env", c.get(c"env")?),
                        ("force", c.get(c"force")?),
                        ("refresh", c.get(c"refresh")?),
                    ],
                )?;
                call(
                    c.get(c"addon")?,
                    c"codexModelsRefresh",
                    &[json_call(c, c"stringify", input)?],
                )
            })?;
            then(plain(o, c"runNative", &[op])?, c, |c, a| {
                let result = json_call(c, c"parse", a[0])?;
                c.set(c"completed", flag(c, true)?)?;
                Ok(result)
            })
        })
    })?;
    let caught = recover(work, c, |c, _| {
        let r = spread(peek(c.get(c"o")?, c.get(c"provider")?)?)?;
        r.set(c"stale", flag(c, true)?)?;
        r.set(
            c"diagnostic",
            fields(
                c,
                &[
                    ("code", text(c, "refresh_unavailable")?),
                    ("message", text(c, "模型刷新失败，保留上次目录")?),
                ],
            )?,
        )?;
        Ok(r)
    })?;
    let promise = call(
        caught,
        c"finally",
        &[function(c, "settled", 0, 0, |c, _| {
            let o = c.get(c"o")?;
            let home = c.get(c"home")?;
            call(o.get(c"pending")?, c"delete", &[home])?;
            if c.get(c"force")?.truthy()? && c.get(c"completed")?.truthy()? {
                let invalid = o.get(c"invalid")?;
                if call(invalid, c"get", &[home])?.equals(c.get(c"ticket")?)? {
                    call(invalid, c"delete", &[home])?;
                }
            }
            undef(c)
        })?],
    )?;
    call(
        pending,
        c"set",
        &[
            home,
            fields(
                o,
                &[
                    ("promise", promise),
                    ("force", c.get(c"force")?),
                    ("refresh", c.get(c"refresh")?),
                ],
            )?,
        ],
    )?;
    Ok(promise)
}
fn hydrate<'a>(o: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(o, || {
        let records = call(providers(o)?, c"listProviders", &[text(o, "codex")?])?;
        let (it, next) = records.iterator()?;
        let c = fields(o, &[("o", o), ("it", it), ("next", next)])?;
        next_load(c, &mut [])
    })
}
fn next_load<'a>(c: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let it = c.get(c"it")?;
    let Some(row) = it.iterator_step(c.get(c"next")?)? else {
        return undef(c);
    };
    let r = (|| {
        let o = c.get(c"o")?;
        let p = load(o, row.get(c"id")?)?;
        then(p, c, next_load)
    })();
    if let Err(e) = r {
        let exception = c.exception_value()?;
        c.catch(|| it.iterator_close())?;
        return Err(if let Some(ex) = exception {
            ex.throw_error()
        } else {
            e
        });
    }
    r
}
fn refresh_account<'a>(o: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let id = a[0];
    let opts = default_object(a[1])?;
    let found = o.catch(|| {
        let rows = call(providers(o)?, c"listProviders", &[text(o, "codex")?])?;
        let records = call(
            rows,
            c"map",
            &[function(o, "record", 1, 1, |o, a| {
                call(
                    providers(o)?,
                    c"getProvider",
                    &[text(o, "codex")?, a[0].get(c"id")?],
                )
            })?],
        )?;
        call(
            records,
            c"find",
            &[function(
                fields(o, &[("o", o), ("id", id)])?,
                "matches",
                1,
                1,
                |c, a| {
                    let o = c.get(c"o")?;
                    flag(
                        c,
                        a[0].truthy()?
                            && account(o, a[0])?.equals(c.get(c"id")?)?
                            && official(o, a[0])?,
                    )
                },
            )?],
        )
    })?;
    let Some(found) = found else {
        return resolved(unavailable(o, "account_unavailable")?);
    };
    let p = or(found, || {
        let cfg = fields(
            o,
            &[
                ("auth", fields(o, &[("auth_mode", text(o, "chatgpt")?)])?),
                ("config", text(o, "")?),
            ],
        )?;
        if !id.is_string("global")? {
            cfg.set(c"officialAccount", fields(o, &[("id", id)])?)?
        }
        fields(
            o,
            &[
                ("appType", text(o, "codex")?),
                ("activeAccountId", id),
                ("settingsConfig", cfg),
            ],
        )
    })?;
    refresh(o, &mut [p, opts])
}
