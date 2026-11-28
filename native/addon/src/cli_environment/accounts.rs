use super::*;
use crate::agy_accounts as store;

fn home(v: L<'_>) -> Result<L<'_>> {
    default(v, || env(v)?.get(c"HOME"))
}
fn missing<'a>(s: L<'a>, reason: Option<L<'a>>) -> Result<napi::Error> {
    let err = error_value(
        s,
        "所选 Antigravity 账户已不存在，请在运行配置里重新选择账户",
    )?;
    err.set(c"code", text(s, "AGY_ACCOUNT_MISSING")?)?;
    if let Some(reason) = reason {
        err.set(c"cause", reason)?
    }
    Ok(err.throw_error())
}
fn injected(p: L<'_>) -> Result<L<'_>> {
    p.get(c"host")?.get(c"accountStore")
}
pub(super) fn has_remote<'a>(p: L<'a>, home: L<'a>) -> Result<bool> {
    Ok(p.catch(|| {
        if !home.truthy()? {
            return Ok(false);
        }
        let external = injected(p)?;
        if !external.undefined()? {
            return Ok(callable(external.get(c"agyHasRemoteAccount")?)?
                && call(external, c"agyHasRemoteAccount", &[string(home)?])?.truthy()?);
        }
        Ok(store::agy_has_remote_account(fold_string(home)?))
    })?
    .unwrap_or(false))
}
fn project<'a>(p: L<'a>, raw: L<'a>) -> Result<L<'a>> {
    if !raw.truthy()? {
        return null(p);
    }
    let value = json_call(p, c"parse", raw)?;
    if value.truthy()? {
        if value.get(c"kind")?.is_string("remote")? && value.get(c"remote")?.truthy()? {
            return fields(p, &[("MULTICC_AGY_REMOTE_ACCOUNT_JSON", raw)]);
        }
        if value.get(c"kind")?.is_string("local")? && value.get(c"home")?.truthy()? {
            let out = fields(p, &[("HOME", value.get(c"home")?)])?;
            let egress = value.get(c"egressBinding")?;
            if egress.truthy()? {
                out.set(
                    c"MULTICC_AGY_EGRESS_JSON",
                    json_call(p, c"stringify", egress)?,
                )?;
                out.set(c"MULTICC_PLUGINS_DIR", p.get(c"host")?.get(c"pluginsDir")?)?;
            }
            return Ok(out);
        }
    }
    null(p)
}
fn target<'a>(p: L<'a>, home: L<'a>, pin: L<'a>) -> Result<L<'a>> {
    let external = injected(p)?;
    if external.undefined()? {
        // The real process resolves through the same Rust store as the gateway.
        let pin = if pin.truthy()? {
            Some(fold_string(pin)?)
        } else {
            None
        };
        let raw = store::agy_resolve_account_target(fold_string(home)?, pin)?;
        return match raw {
            Some(raw) => project(p, text(p, &raw)?),
            None => null(p),
        };
    }
    let key = if pin.truthy()? { pin } else { null(p)? };
    if callable(external.get(c"agyResolveAccountTarget")?)? {
        return project(
            p,
            call(external, c"agyResolveAccountTarget", &[string(home)?, key])?,
        );
    }
    // Older external stores expose only the home lookup.
    let path = if callable(external.get(c"agyResolveAccountHome")?)? {
        call(external, c"agyResolveAccountHome", &[string(home)?, key])?
    } else if pin.truthy()? {
        return Err(missing(
            p,
            Some(text(p, "agyResolveAccountHome unavailable")?),
        )?);
    } else {
        call(external, c"agyAccountHome", &[string(home)?])?
    };
    if path.truthy()? {
        fields(p, &[("HOME", path)])
    } else {
        null(p)
    }
}
fn account_env<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let home = home(args[0])?;
    let pin = if args[1].nullish()? {
        text(p, "")?
    } else {
        units(p, string(args[1])?.coerce_string()?.trim())?
    };
    let explicit = pin.truthy()?;
    if !home.truthy()? {
        if explicit {
            return Err(missing(p, None)?);
        }
        return null(p);
    }
    match target(p, home, pin) {
        Err(e) if explicit => {
            let err = if let Some(err) = p.exception_value()? {
                err
            } else {
                error_value(p, &e.reason)?
            };
            if err.truthy()? && err.get(c"code")?.is_string("AGY_ACCOUNT_MISSING")? {
                return Err(err.throw_error());
            }
            Err(missing(p, if err.truthy()? { Some(err) } else { None })?)
        }
        Ok(value) if explicit && !value.truthy()? => Err(missing(p, None)?),
        result => result,
    }
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    defaulted_methods(
        p,
        &[
            ("accountEnv", 0, 2, account_env),
            ("hasAccount", 1, 2, |p, a| {
                let home = home(a[1])?;
                if !home.truthy()? {
                    return flag(p, false);
                }
                let Some(s) = a[0].string()? else {
                    return flag(p, false);
                };
                let s = s.trim();
                if s.is_empty() {
                    return flag(p, false);
                }
                let external = injected(p)?;
                let found = if external.undefined()? {
                    store::agy_has_account(fold_string(home)?, s.to_string_lossy())
                } else {
                    callable(external.get(c"agyHasAccount")?)?
                        && call(external, c"agyHasAccount", &[string(home)?, units(p, s)?])?
                            .truthy()?
                };
                flag(p, found)
            }),
            ("hasRemoteAccount", 0, 1, |p, a| {
                flag(p, has_remote(p, home(a[0])?)?)
            }),
        ],
    )
}
