use super::*;

pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let owner = fields(p, &[("officialCodex", p.get(c"officialCodex")?)])?;
    let api = methods(
        owner,
        &[
            ("createOfficialCatalog", 1, create),
            (
                "normalizeOfficialSessionReferences",
                2,
                super::references::normalize,
            ),
            ("officialId", 1, |_, a| alias(a[0])),
            ("isOfficial", 1, |p, a| flag(p, official(p, a[0])?)),
            ("accountProviderId", 2, |p, a| per_account(p, a[0], a[1])),
            ("accountIdOfProviderId", 2, |p, a| account_id(p, a[0], a[1])),
            ("isOfficialProviderId", 2, is_id),
        ],
    )?;
    owner.set(c"isOfficialId", api.get(c"isOfficialProviderId")?)?;
    Ok(api)
}
fn alias(t: L<'_>) -> Result<L<'_>> {
    cat(t, &[t, text(t, "official")?], "-")
}
fn per_account<'a>(p: L<'a>, t: L<'a>, id: L<'a>) -> Result<L<'a>> {
    cat(p, &[alias(t)?, id], "-")
}
fn account_id<'a>(p: L<'a>, t: L<'a>, v: L<'a>) -> Result<L<'a>> {
    let mut prefix = alias(t)?.coerce_string()?;
    prefix.push_unit(45);
    if let Some(id) = v.string()? {
        if let Some(rest) = id.as_units().strip_prefix(prefix.as_units()) {
            let s = S::from_units(rest.to_vec());
            if valid(&s) {
                return p.from_value(&V::String(s));
            }
        }
    }
    null(p)
}
fn is_id<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    flag(
        p,
        alias(a[0])?.equals(a[1])? || account_id(p, a[0], a[1])?.truthy()?,
    )
}
fn config(record: L<'_>) -> Result<L<'_>> {
    let maybe = record.catch(|| {
        if record.get(c"settingsConfig")?.string()?.is_some() {
            json_call(record, c"parse", record.get(c"settingsConfig")?)
        } else {
            fallback(record.get(c"settingsConfig")?, V::Object(vec![]))
        }
    })?;
    match maybe {
        Some(c) => Ok(c),
        None => fields(record, &[]),
    }
}
fn official<'a>(p: L<'a>, record: L<'a>) -> Result<bool> {
    if !record.truthy()? || !supported(record.get(c"appType")?)? {
        return Ok(false);
    }
    if record.get(c"appType")?.is_string("codex")? {
        return plain(p, c"officialCodex", &[record])?.truthy();
    }
    let env = fallback(config(record)?.get(c"env")?, V::Object(vec![]))?;
    Ok(!env.get(c"ANTHROPIC_BASE_URL")?.truthy()?
        && !env.get(c"ANTHROPIC_AUTH_TOKEN")?.truthy()?
        && !env.get(c"ANTHROPIC_API_KEY")?.truthy()?)
}
fn marker(record: L<'_>) -> Result<L<'_>> {
    let marker = config(record)?.get(c"officialAccount")?;
    if object(marker)? {
        let id = string(fallback(marker.get(c"id")?, V::string(""))?)?;
        if valid(&id.coerce_string()?) {
            return Ok(id);
        }
    }
    null(record)
}
fn create<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let ports = a[0];
    let o = fields(
        p,
        &[
            ("officialCodex", p.get(c"officialCodex")?),
            ("readRecords", ports.get(c"readRecords")?),
            ("readSelection", ports.get(c"readSelection")?),
            ("writeSelection", ports.get(c"writeSelection")?),
            (
                "listAccounts",
                with_default(
                    ports.get(c"listAccounts")?,
                    function(p, "listAccounts", 0, 0, |p, _| array(p))?,
                )?,
            ),
            (
                "deleteAccount",
                with_default(ports.get(c"deleteAccount")?, null(p)?)?,
            ),
        ],
    )?;
    let api = bind(
        o,
        &[
            ("active", 1, 1, |o, a| active(o, a[0])),
            ("provider", 1, 3, |o, a| provider(o, a[0], a[1], a[2])),
            ("normalize", 2, 2, normalize),
            ("defaultAccount", 1, 1, |o, a| default_account(o, a[0])),
            ("isOfficialId", 2, 2, is_id),
            ("list", 1, 1, list),
            ("get", 2, 2, get),
            ("select", 2, 2, select),
            ("delete", 2, 2, delete),
        ],
    )?;
    api.set(c"isOfficialId", p.get(c"isOfficialId")?)?;
    Ok(api)
}
fn accounts<'a>(o: L<'a>, t: L<'a>) -> Result<L<'a>> {
    let value = o.catch(|| {
        let list = plain(o, c"listAccounts", &[t])?;
        if !list.is_array()? {
            return array(o);
        }
        call(
            list,
            c"filter",
            &[function(o, "validAccount", 1, 1, |p, a| {
                flag(
                    p,
                    a[0].truthy()?
                        && valid(
                            &string(fallback(a[0].get(c"id")?, V::string(""))?)?.coerce_string()?,
                        ),
                )
            })?],
        )
    })?;
    match value {
        Some(v) => Ok(v),
        None => array(o),
    }
}
fn active<'a>(o: L<'a>, t: L<'a>) -> Result<L<'a>> {
    let selected = plain(o, c"readSelection", &[])?.get_key(t)?;
    if selected.nullish()? || selected.is_string("global")? {
        return text(o, "global");
    }
    if selected.string()?.is_none_or(|s| !valid(&s)) {
        return Err(error_value(o, "invalid saved official account selection")?.throw_error());
    }
    Ok(selected)
}
fn by_id<'a>(rows: L<'a>, id: L<'a>) -> Result<L<'a>> {
    call(
        rows,
        c"find",
        &[function(id, "byId", 1, 1, |id, a| {
            flag(id, a[0].get(c"id")?.equals(id)?)
        })?],
    )
}
fn logged<'a>(o: L<'a>, t: L<'a>) -> Result<L<'a>> {
    call(
        accounts(o, t)?,
        c"filter",
        &[function(o, "loggedIn", 1, 1, |_, a| a[0].get(c"loggedIn"))?],
    )
}
fn default_account<'a>(o: L<'a>, t: L<'a>) -> Result<L<'a>> {
    let selected = active(o, t)?;
    let logged = logged(o, t)?;
    if !selected.is_string("global")? && by_id(logged, selected)?.truthy()? {
        return Ok(selected);
    }
    if logged.get(c"length")?.truthy()? {
        return logged.element(0)?.get(c"id");
    }
    Ok(selected)
}
fn record<'a>(o: L<'a>, t: L<'a>, id: L<'a>, type_required: bool) -> Result<L<'a>> {
    let ctx = fields(
        o,
        &[
            ("id", id),
            ("type", t),
            ("required", flag(o, type_required)?),
        ],
    )?;
    call(
        plain(o, c"readRecords", &[])?,
        c"find",
        &[function(ctx, "matches", 1, 1, |c, v| {
            let t = c.get(c"type")?;
            flag(
                c,
                v[0].get(c"id")?.equals(c.get(c"id")?)?
                    && ((!c.get(c"required")?.truthy()? && !t.truthy()?)
                        || v[0].get(c"appType")?.equals(t)?),
            )
        })?],
    )
}
fn provider<'a>(o: L<'a>, t: L<'a>, id: L<'a>, account: L<'a>) -> Result<L<'a>> {
    let id = if id.undefined()? { alias(t)? } else { id };
    let account = with_default(account, text(o, "global")?)?;
    let over = record(o, t, id, true)?;
    let global = account.is_string("global")?;
    let row = if global {
        null(o)?
    } else {
        fallback(by_id(accounts(o, t)?, account)?, V::Null)?
    };
    let codex = t.is_string("codex")?;
    let cli = if codex { "Codex" } else { "Claude" };
    let terminal = id.equals(alias(t)?)?;
    let needs_login = !terminal && !(row.truthy()? && row.get(c"loggedIn")?.truthy()?);
    let name = if terminal {
        text(o, &format!("同 {cli} 终端"))?
    } else {
        let label = |k| -> Result<L<'a>> {
            if row.truthy()? {
                call(string(fallback(row.get(k)?, V::string(""))?)?, c"trim", &[])
            } else {
                Ok(row)
            }
        };
        let name = label(c"label")?;
        let email = label(c"email")?;
        let label = or(name, || {
            or(email, || {
                call(account, c"slice", &[num(o, 0.)?, num(o, 6.)?])
            })
        })?;
        cat(o, &[text(o, &format!("{cli} 账号 · "))?, label], "")?
    };
    let email = if row.truthy()? && row.get(c"email")?.truthy()? {
        string(row.get(c"email")?)?
    } else {
        null(o)?
    };
    let cfg = if codex {
        fields(
            o,
            &[
                ("auth", fields(o, &[("auth_mode", text(o, "chatgpt")?)])?),
                ("config", text(o, "")?),
            ],
        )?
    } else {
        fields(o, &[("env", fields(o, &[])?)])?
    };
    if !global {
        cfg.set(c"officialAccount", fields(o, &[("id", account)])?)?
    }
    let out = fields(
        o,
        &[
            ("id", id),
            ("appType", t),
            ("name", name),
            ("source", text(o, "builtin")?),
            (
                "apiFormat",
                text(
                    o,
                    if codex {
                        "openai_responses"
                    } else {
                        "anthropic"
                    },
                )?,
            ),
            ("builtinOfficial", flag(o, true)?),
            ("activeAccountId", account),
            ("needsLogin", flag(o, needs_login)?),
            ("accountEmail", email),
            (
                "subscription",
                fallback(row.optional(c"subscription")?, V::Null)?,
            ),
            ("settingsConfig", cfg),
        ],
    )?;
    if over.truthy()? {
        if over.get(c"egressIpAllowlist")?.is_array()?
            && over.get(c"egressIpAllowlist")?.get(c"length")?.truthy()?
        {
            out.set(c"egressIpAllowlist", over.get(c"egressIpAllowlist")?)?
        }
        let b = over.get(c"egressBinding")?;
        if object(b)?
            && b.get(c"pluginId")?.string()?.is_some()
            && b.get(c"pluginId")?.truthy()?
            && b.get(c"profileId")?.string()?.is_some()
            && b.get(c"profileId")?.truthy()?
        {
            out.set(c"egressBinding", pick(b, &[c"pluginId", c"profileId"])?)?
        }
    }
    Ok(out)
}
fn normalize<'a>(o: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (t, id) = (a[0], a[1]);
    if !supported(t)? {
        return fallback(id, V::Null);
    }
    if !id.truthy()? || id.is_string("_default_")? || id.equals(alias(t)?)? {
        return alias(t);
    }
    let account = account_id(o, t, id)?;
    if account.truthy()? {
        return if by_id(accounts(o, t)?, account)?.truthy()? {
            Ok(id)
        } else {
            alias(t)
        };
    }
    let old = record(o, t, id, true)?;
    if !official(o, old)? {
        return Ok(id);
    }
    let id = marker(old)?;
    if id.truthy()? && by_id(accounts(o, t)?, id)?.truthy()? {
        per_account(o, t, id)
    } else {
        alias(t)
    }
}
fn list<'a>(o: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let out = array(o)?;
    for name in ["claude", "codex"] {
        let t = text(o, name)?;
        let rows = logged(o, t)?;
        let default = default_account(o, t)?;
        push(out, provider(o, t, undef(o)?, undef(o)?)?)?;
        rows.for_each(|v| {
            let id = v.get(c"id")?;
            let p = provider(o, t, per_account(o, t, id)?, v.get(c"id")?)?;
            p.set(
                c"isDefaultOfficial",
                flag(o, v.get(c"id")?.equals(default)?)?,
            )?;
            push(out, p)
        })?;
    }
    let stored = call(
        plain(o, c"readRecords", &[])?,
        c"filter",
        &[function(o, "customProvider", 1, 1, |o, a| {
            let v = a[0];
            flag(
                o,
                !official(o, v)?
                    && !is_id(o, &mut [text(o, "claude")?, v.get(c"id")?])?.truthy()?
                    && !is_id(o, &mut [text(o, "codex")?, v.get(c"id")?])?.truthy()?,
            )
        })?],
    )?;
    stored.for_each(|v| push(out, v))?;
    let t = a[0];
    call(
        out,
        c"filter",
        &[function(t, "appType", 1, 1, |t, a| {
            flag(t, !t.truthy()? || a[0].get(c"appType")?.equals(t)?)
        })?],
    )
}
fn get<'a>(o: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (t, id) = (a[0], a[1]);
    for name in ["claude", "codex"] {
        let vendor = text(o, name)?;
        if (!t.truthy()? || t.equals(vendor)?) && id.equals(alias(vendor)?)? {
            return provider(o, vendor, id, text(o, "global")?);
        }
    }
    for name in ["claude", "codex"] {
        let vendor = text(o, name)?;
        if t.truthy()? && !t.equals(vendor)? {
            continue;
        }
        let account = account_id(o, vendor, id)?;
        if account.truthy()? {
            return if by_id(accounts(o, vendor)?, account)?.truthy()? {
                provider(o, vendor, id, account)
            } else {
                null(o)
            };
        }
    }
    let old = record(o, t, id, false)?;
    if !official(o, old)? {
        return fallback(old, V::Null);
    }
    let account = marker(old)?;
    let t = old.get(c"appType")?;
    if account.truthy()? && by_id(accounts(o, t)?, account)?.truthy()? {
        provider(o, t, id, account)
    } else {
        provider(o, t, id, text(o, "global")?)
    }
}
fn write<'a>(o: L<'a>, t: L<'a>, id: L<'a>) -> Result<()> {
    let value = spread(plain(o, c"readSelection", &[])?)?;
    value.define_key(t, id)?;
    plain(o, c"writeSelection", &[value])?;
    Ok(())
}
fn select<'a>(o: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (t, id) = (a[0], a[1]);
    let global = id.is_string("global")?;
    if !supported(t)? || (!global && !valid(&id.coerce_string()?)) {
        return Err(error_value(o, "invalid official account selection")?.throw_error());
    }
    write(o, t, id)?;
    provider(
        o,
        t,
        if global {
            alias(t)?
        } else {
            per_account(o, t, id)?
        },
        id,
    )
}
fn delete<'a>(o: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (t, id) = (a[0], a[1]);
    if !supported(t)? || id.equals(alias(t)?)? {
        return flag(o, false);
    }
    let account = account_id(o, t, id)?;
    if !account.truthy()?
        || !callable(o.get(c"deleteAccount")?)?
        || !by_id(accounts(o, t)?, account)?.truthy()?
    {
        return flag(o, false);
    }
    if active(o, t)?.equals(account)? {
        write(o, t, text(o, "global")?)?
    }
    plain(o, c"deleteAccount", &[t, account])?;
    flag(o, true)
}
