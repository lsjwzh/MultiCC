//! The SDK owns the live attempt handle; one WeakMap per host tracks its exact env holder.
use super::registry::{data, get, live, port, value_string};
use crate::route_response::*;
use multicc_core::{codex_provider_home, provider_catalog, provider_routing};
use std::path::Path;

fn object(value: L<'_>) -> Result<bool> {
    Ok(!value.nullish()? && value.kind()? == sys::ValueType::napi_object)
}
fn options<'a>(source: L<'a>, overrides: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let next = fields(source, &[])?;
    next.spread_from(source)?;
    for &(key, value) in overrides {
        next.define_key(text(source, key)?, value)?;
    }
    Ok(next)
}
fn required_id(p: L<'_>) -> Result<bool> {
    let id = p.clean_text()?;
    Ok(id.truthy()? && !id.is_string("_default_")?)
}
pub(super) fn view<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let row = p.catch(|| get(p, a[0], a[1]))?.unwrap_or(null(p)?);
    if !row.truthy()? || !a[0].is_string("claude")? {
        return Ok(row);
    }
    let (_, settings) = provider_routing::spawn::claude_route(&data(row)?);
    if let Some(settings) = settings {
        options(row, &[("settingsConfig", live(p, &settings)?)])
    } else {
        Ok(row)
    }
}
pub(super) fn claude<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let env = a[0];
    let opts = a[1];
    let id = string(fallback(opts.optional(c"providerId")?, "".into())?)?;
    let route = options(opts, &[])?;
    if id.truthy()? {
        if let Some(row) = p
            .catch(|| get(p, text(p, "claude")?, id))?
            .filter(|r| r.truthy().unwrap_or(false))
        {
            let row = data(row)?;
            let cfg = provider_routing::config(&row);
            if !multicc_core::js::serde::truthy(&cfg["env"]["ANTHROPIC_BASE_URL"])
                && !provider_routing::spawn::claude_route(&row).0
            {
                if env.truthy()? {
                    env.assign(c"CLAUDE_CODE_OAUTH_TOKEN", text(p, "")?)?;
                }
                route.set(c"officialOAuth", flag(p, true)?)?;
                route.set(c"officialProviderId", id)?;
            }
        }
    }
    route.set(c"enabled", flag(p, true)?)?;
    route.set(c"getProvider", p.get(c"routeView")?)?;
    let applied = call(p.get(c"sdk")?, c"applyClaudeProxyEnv", &[env, route])?;
    let required = required_id(id)?;
    crate::provider_claude_proxy_policy::ensure_applied(p, required, applied)?;
    if required && env.truthy()? {
        for key in [
            c"CLAUDE_CODE_USE_BEDROCK",
            c"ANTHROPIC_BEDROCK_BASE_URL",
            c"CLAUDE_CODE_USE_VERTEX",
            c"ANTHROPIC_VERTEX_BASE_URL",
            c"ANTHROPIC_VERTEX_PROJECT_ID",
            c"CLAUDE_CODE_USE_FOUNDRY",
            c"ANTHROPIC_FOUNDRY_BASE_URL",
            c"ANTHROPIC_FOUNDRY_API_KEY",
            c"CLAUDE_CODE_OAUTH_TOKEN",
        ] {
            env.assign(key, text(p, "")?)?;
        }
    }
    Ok(applied)
}
pub(super) fn release<'a>(p: L<'a>, env: L<'a>) -> Result<L<'a>> {
    if !object(env)? {
        return flag(p, false);
    }
    let leases = p.get(c"leases")?;
    let lease = call(leases, c"get", &[env])?;
    if !lease.truthy()? {
        return flag(p, false);
    }
    call(leases, c"delete", &[env])?;
    let home = lease.get(c"restoreHome")?;
    if home.truthy()? {
        env.assign(c"CODEX_HOME", home)?
    } else {
        env.delete(c"CODEX_HOME")?;
    }
    if let Some(done) = p.catch(|| call(lease, c"release", &[]))? {
        return Ok(done);
    }
    warn_cleanup(p.global()?.get(c"console")?)?;
    flag(p, false)
}
fn warn_cleanup(logger: L<'_>) -> Result<()> {
    call(
        logger,
        c"warn",
        &[text(
            logger,
            "[multicc/provider] failed to scrub private Codex attempt state; orphan retained",
        )?],
    )?;
    Ok(())
}
pub(super) fn lease_env<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let lease = call(p.get(c"leases")?, c"get", &[a[1]])?;
    if lease.optional(c"containsOfficial")?.truthy()? {
        super::environment::strip_official(a[0])?;
    }
    p.from_value(&V::Undefined)
}
pub(super) fn codex<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let env = a[0];
    let opts = a[1];
    if !object(env)?
        || !env.get(c"CODEX_HOME")?.truthy()?
        || !opts.truthy()?
        || !opts.get(c"providerId")?.truthy()?
        || !opts.get(c"sessionId")?.truthy()?
        || (!opts.get(c"port")?.truthy()? && !opts.get(c"proxyBaseUrl")?.truthy()?)
    {
        return flag(p, false);
    }
    let id = opts.get(c"providerId")?.clean_text()?;
    let sub = opts.get(c"subagent")?;
    let explicit = fallback(sub.optional(c"providerId")?, "".into())?.clean_text()?;
    release(p, env)?;
    let home = env.get(c"CODEX_HOME")?;
    let mut lease = None;
    let mut stage = "session-home";
    let result = (|| -> Result<bool> {
        let logical = opts.get(c"logicalSessionId")?;
        let session = if logical.truthy()? {
            let request = fields(
                p,
                &[
                    ("logicalSessionId", logical),
                    ("nativeSessionId", opts.get(c"nativeSessionId")?),
                    (
                        "allowMissingNativeSession",
                        flag(p, opts.get(c"allowMissingNativeSession")?.is_true()?)?,
                    ),
                ],
            )?;
            port(p, c"prepareHome", &[request])?
        } else {
            null(p)?
        };
        let kind = text(p, "codex")?;
        let main = get(p, kind, id)?;
        if !main.truthy()? {
            return Ok(false);
        }
        let sub_id = if explicit.truthy()? { explicit } else { id };
        let secondary = get(p, kind, sub_id)?;
        let main_data = data(main)?;
        let main_official = provider_catalog::official_codex(&main_data);
        let sub_official = provider_catalog::official_codex(&data(secondary)?);
        let official = main_official || sub_official;
        if official {
            super::environment::strip_official(env)?;
        }
        stage = "official-relay-home";
        if main_official {
            let cfg = provider_routing::effective_codex(
                &main_data,
                &value_string(port(p, c"getPort", &[])?)?,
            );
            codex_provider_home::materialize_official(
                Path::new(&value_string(home)?),
                &value_string(main.get(c"id")?)?,
                provider_routing::strval(&cfg["config"]),
            )
            .map_err(napi::Error::from_reason)?;
        }
        stage = "attempt-home";
        let params = fields(
            p,
            &[
                ("providerId", id),
                ("sessionId", opts.get(c"sessionId")?),
                ("homesDir", p.get(c"attemptsDir")?),
                ("copyAuth", flag(p, !official)?),
            ],
        )?;
        if session.truthy()? {
            params.set(c"sessionsDir", session.get(c"sessionsDir")?)?;
        }
        let active = port(p, c"attemptHome", &[home, params])?;
        lease = Some(active);
        let attempt = active.get(c"home")?;
        env.assign(c"CODEX_HOME", attempt)?;
        let sdk = p.get(c"sdk")?;
        let capable = |row| {
            call(
                sdk,
                c"codexProviderProxyable",
                &[
                    row,
                    options(opts, &[("getProvider", p.get(c"providerLookup")?)])?,
                ],
            )?
            .truthy()
        };
        let main_ok = main_official || capable(main)?;
        let sub_ok = sub_official || capable(secondary)?;
        stage = "routing-config";
        let model = if explicit.truthy()? {
            sub.optional(c"model")?
        } else {
            opts.get(c"inheritModel")?
        };
        let applied = main_ok
            && sub_ok
            && call(
                sdk,
                c"materializeCodexRoutingHome",
                &[
                    attempt,
                    options(
                        opts,
                        &[
                            ("mainProviderId", id),
                            ("mainProxyable", flag(p, true)?),
                            ("subProviderId", sub_id),
                            ("subModel", fallback(model, "".into())?.clean_text()?),
                        ],
                    )?,
                ],
            )?
            .truthy()?;
        stage = "sanitize-official-config";
        if applied && official {
            let proxy = opts.get(c"codexProxyPath")?;
            let path = if proxy.truthy()? {
                proxy
            } else {
                fallback(opts.get(c"mountPath")?, "/codex-proxy".into())?
            };
            codex_provider_home::sanitize_official(
                Path::new(&value_string(attempt)?),
                &value_string(path)?,
            )
            .map_err(napi::Error::from_reason)?;
        }
        if !applied {
            env.assign(c"CODEX_HOME", home)?;
            call(active, c"release", &[])?;
            return Ok(false);
        }
        let held = fields(
            p,
            &[
                ("restoreHome", home),
                ("release", active.get(c"release")?),
                ("containsOfficial", flag(p, official)?),
            ],
        )?
        .freeze()?;
        call(p.get(c"leases")?, c"set", &[env, held])?;
        Ok(true)
    })();
    match result {
        Ok(done) => flag(p, done),
        Err(error) => {
            let exception = p.exception_value()?.unwrap_or(null(p)?);
            env.assign(c"CODEX_HOME", home)?;
            let supplied = opts.get(c"logger")?;
            let logger = if supplied.truthy()? {
                supplied
            } else {
                p.global()?.get(c"console")?
            };
            if let Some(active) = lease {
                if p.catch(|| call(active, c"release", &[]))?.is_none() {
                    warn_cleanup(logger)?;
                }
            }
            let mut code = exception.optional(c"code")?;
            if (code.nullish()? || code.is_string("GenericFailure")?)
                && error
                    .reason
                    .bytes()
                    .all(|c| c.is_ascii_uppercase() || c == b'_')
                && !error.reason.is_empty()
            {
                code = text(p, &error.reason)?;
            }
            let cause = exception.optional(c"cause")?.optional(c"code")?;
            let facts = fields(
                p,
                &[
                    ("providerId", id),
                    (
                        "logicalSessionId",
                        fallback(opts.get(c"logicalSessionId")?, V::Null)?,
                    ),
                    ("stage", text(p, stage)?),
                    ("code", fallback(code, V::Null)?),
                    ("causeCode", fallback(cause, V::Null)?),
                ],
            )?;
            call(
                logger,
                c"warn",
                &[
                    text(
                        p,
                        "[multicc/provider] failed to create private Codex attempt config",
                    )?,
                    facts,
                ],
            )?;
            flag(p, false)
        }
    }
}
