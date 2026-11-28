//! Event-loop orchestration for the CLI-owned Claude OAuth credential.
//! Each refresher retains its own state and Promise; the CLI remains the writer.
use crate::host_api::*;
use crate::plugin_catalog_host::{push, strings};
use napi_derive::napi;
use std::ffi::CStr;

mod attempt;
mod command;
mod outcome;
mod parse;
mod state;

fn time(p: L<'_>) -> Result<f64> {
    now(p)?.number()
}
fn iso(p: L<'_>, ts: f64) -> Result<L<'_>> {
    call(
        p.global()?.get(c"Date")?.construct(&[num(p, ts)?])?,
        c"toISOString",
        &[],
    )
}
fn log<'a>(p: L<'a>, level: &CStr, event: &str, data: L<'a>) -> Result<()> {
    let logger = p.get(c"logger")?;
    if logger.truthy()? {
        call(logger, level, &[text(p, event)?, data])?;
    }
    Ok(())
}
fn enabled(p: L<'_>) -> Result<L<'_>> {
    let f = p.get(c"isEnabled")?;
    if callable(f)? {
        f.call_plain(&[])
    } else {
        flag(
            p,
            !p.get(c"process")?
                .get(c"env")?
                .get(c"CLAUDE_OAUTH_AUTO_REFRESH")?
                .is_string("0")?,
        )
    }
}
fn assessed<'a>(p: L<'a>, cred: L<'a>, ts: f64) -> Result<L<'a>> {
    let (outcome, detail) = if !cred.get(c"ok")?.truthy()? {
        ("no-credentials", cred.get(c"reason")?)
    } else {
        let refresh = cred.get(c"refreshExpiresAt")?;
        if refresh.truthy()? && refresh.number()? <= ts {
            ("needs-login", text(p, "refresh_token_expired")?)
        } else if !cred.get(c"hasRefreshToken")?.truthy()? {
            ("needs-login", text(p, "no_refresh_token")?)
        } else if cred.get(c"expiresAt")?.number()? - ts > p.get(c"bufferMs")?.number()? {
            ("fresh", null(p)?)
        } else {
            ("due", null(p)?)
        }
    };
    fields(
        p,
        &[
            ("due", flag(p, outcome == "due")?),
            ("outcome", text(p, outcome)?),
            ("detail", detail),
        ],
    )
}
fn status(p: L<'_>) -> Result<L<'_>> {
    let out = fields(p, &[("enabled", enabled(p)?)])?;
    for k in [c"lastAttemptAt", c"lastSuccessAt", c"lastOutcome"] {
        out.set(k, p.get(k)?)?;
    }
    out.set(c"retryAfter", fallback(p.get(c"retryAfter")?, V::Null)?)?;
    for k in [
        c"consecutiveFailures",
        c"refreshCount",
        c"failureClass",
        c"lastFailure",
        c"parked",
        c"postExpiryAttempt",
        c"maxProbesPerWindow",
    ] {
        out.set(k, p.get(k)?)?;
    }
    let win = p.get(c"window")?;
    out.set(
        c"window",
        if win.truthy()? {
            spread(win)?
        } else {
            null(p)?
        },
    )?;
    out.set(c"inFlight", flag(p, p.get(c"inFlight")?.truthy()?)?)?;
    Ok(out)
}
fn remember<'a>(p: L<'a>, value: L<'a>) -> Result<L<'a>> {
    p.set(c"lastOutcome", value)?;
    Ok(value)
}
fn refresh<'a>(p: L<'a>, reason: L<'a>, force: bool) -> Result<L<'a>> {
    if !enabled(p)?.truthy()? {
        return resolved(fields(
            p,
            &[("outcome", text(p, "disabled")?), ("reason", reason)],
        )?);
    }
    let current = p.get(c"inFlight")?;
    if current.truthy()? {
        return Ok(current);
    }
    let ts = time(p)?;
    let retry = p.get(c"retryAfter")?.number()?;
    if !force && ts < retry && retry != 0. {
        return resolved(fields(
            p,
            &[
                ("outcome", text(p, "cooldown")?),
                ("reason", reason),
                ("retryInMs", num(p, retry - ts)?),
            ],
        )?);
    }
    let ctx = fields(
        p,
        &[("p", p), ("reason", reason), ("force", flag(p, force)?)],
    )?;
    let work = async_result(ctx, || {
        let start = now(p)?;
        ctx.set(c"started", start)?;
        p.set(c"lastAttemptAt", start)?;
        then(command::read(p)?, ctx, attempt::begin)
    })?;
    let caught = recover(work, ctx, outcome::harness_error)?;
    let cleanup = function(p, "settled", 0, 0, |p, _| {
        p.set(c"inFlight", null(p)?)?;
        undef(p)
    })?;
    let running = call(caught, c"finally", &[cleanup])?;
    p.set(c"inFlight", running)?;
    Ok(running)
}
fn api_error<'a>(p: L<'a>, decision: L<'a>) -> Result<L<'a>> {
    let error = decision.optional(c"error")?;
    if !error.truthy()? {
        return null(p);
    }
    if parse::revoked(error.get(c"sanitizedMessage")?)? {
        let read = recover(command::read(p)?, p, |p, _| {
            fields(p, &[("ok", flag(p, false)?)])
        })?;
        return then(read, p, |p, a| {
            let reason = text(p, "api-error")?;
            let detail = text(p, "token_revoked")?;
            p.set(c"failureClass", text(p, "rejected")?)?;
            state::park(p, a[0], time(p)?, reason, "rejected")?;
            log(p,c"error","claude_oauth_refresh_parked",fields(p,&[
                ("reason",reason),("failureClass",text(p,"rejected")?),("detail",detail),
                ("action",text(p,"credential rejected by the server — log in again; refreshes are suspended until the credential changes")?)
            ])?)?;
            state::persist_fingerprint(p, a[0])?;
            fields(
                p,
                &[
                    ("outcome", text(p, "needs-login")?),
                    ("detail", detail),
                    ("reason", reason),
                ],
            )
        });
    }
    if parse::expired(error.get(c"sanitizedMessage")?)? {
        refresh(p, text(p, "api-error")?, false)
    } else {
        null(p)
    }
}
fn create<'a>(ports: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let o = default_object(args[0])?;
    let p = spread(ports)?;
    p.set(c"options", o)?;
    for k in [c"logger", c"isEnabled", c"healthKey"] {
        p.set(k, o.get(k)?)?;
    }
    let health = o.get(c"health")?;
    if health.truthy()? && callable(health.get(c"read")?)? {
        p.set(c"health", health)?;
    }
    for (k, default) in [
        (c"now", p.global()?.get(c"Date")?.get(c"now")?),
        (c"run", ports.get(c"defaultRun")?),
        (c"readFile", ports.get(c"defaultRead")?),
    ] {
        let v = o.get(k)?;
        p.set(k, if callable(v)? { v } else { default })?;
    }
    let process = p.get(c"process")?;
    let env = process.get(c"env")?;
    for (k, env_key, default) in [
        (c"claudeBin", c"CLAUDE_BIN", "claude"),
        (c"model", c"CLAUDE_OAUTH_REFRESH_MODEL", "haiku"),
    ] {
        let v = o.get(k)?;
        p.set(
            k,
            if v.truthy()? {
                v
            } else {
                fallback(env.get(env_key)?, default.into())?
            },
        )?;
    }
    let platform = o.get(c"platform")?;
    p.set(
        c"platform",
        if platform.truthy()? {
            platform
        } else {
            process.get(c"platform")?
        },
    )?;
    p.set(
        c"keychainService",
        fallback(o.get(c"keychainService")?, "Claude Code-credentials".into())?,
    )?;
    for (k, f) in [(c"cwd", c"tmpdir"), (c"credentialsFile", c"defaultFile")] {
        let v = o.get(k)?;
        p.set(
            k,
            if v.truthy()? {
                v
            } else {
                ports.get(f)?.call_plain(&[])?
            },
        )?;
    }
    for (k, default, allow_zero) in [
        (c"bufferMs", 900_000., false),
        (c"probeThresholdMs", 120_000., true),
        (c"cooldownMs", 600_000., true),
        (c"deferCooldownMs", 90_000., true),
        (c"commandTimeoutMs", 120_000., false),
        (c"maxCooldownMs", 21_600_000., false),
        (c"parkAfterFailures", 6., false),
        (c"maxDeclinesPerWindow", 2., false),
        (c"maxProbesPerWindow", 2., false),
    ] {
        let n = o.get(k)?.explicit_number()?;
        let selected = if n > 0. || (allow_zero && n == 0.) {
            o.get(k)?.explicit_number()?
        } else {
            default
        };
        p.set(k, num(p, selected)?)?;
    }
    for k in [
        c"inFlight",
        c"lastAttemptAt",
        c"lastSuccessAt",
        c"lastOutcome",
        c"failureClass",
        c"lastFailure",
        c"parked",
        c"postExpiryAttempt",
        c"lastProbeFailure",
        c"window",
    ] {
        p.set(k, null(p)?)?;
    }
    for k in [c"retryAfter", c"consecutiveFailures", c"refreshCount"] {
        p.set(k, num(p, 0.)?)?;
    }
    state::restore(p)?;
    defaulted_methods(
        p,
        &[
            ("check", 0, 1, |p, a| {
                refresh(p, with_default(a[0], text(p, "periodic")?)?, false)
            }),
            ("refresh", 0, 1, |p, a| {
                let o = default_object(a[0])?;
                refresh(
                    p,
                    with_default(o.get(c"reason")?, text(p, "manual")?)?,
                    o.get(c"force")?.truthy()?,
                )
            }),
            ("onApiError", 1, 1, |p, a| api_error(p, a[0])),
            ("status", 0, 0, |p, _| status(p)),
            ("readCredentials", 0, 0, |p, _| command::read(p)),
            ("assess", 2, 2, |p, a| assessed(p, a[0], a[1].number()?)),
        ],
    )
}

#[napi]
pub fn claude_oauth_refresh_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = defaulted_methods(
        p,
        &[
            ("createClaudeOAuthRefresher", 0, 1, create),
            ("looksLikeExpiredOAuth", 1, 1, |p, a| {
                flag(p, parse::expired(a[0])?)
            }),
            ("looksLikeRevokedOAuth", 1, 1, |p, a| {
                flag(p, parse::revoked(a[0])?)
            }),
            ("parseCredentials", 1, 1, |_, a| parse::credentials(a[0])),
            ("parseAuthStatus", 1, 1, |_, a| parse::auth(a[0])),
            ("classifyFailure", 1, 1, |p, a| {
                text(p, parse::classify(a[0])?)
            }),
            ("credentialFingerprint", 1, 1, |_, a| {
                parse::fingerprint(a[0])
            }),
            ("redactCliOutput", 1, 2, |_, a| parse::redact(a[0], a[1])),
        ],
    )?;
    api.set(c"KEYCHAIN_SERVICE", text(p, "Claude Code-credentials")?)?;
    for (key, value) in [
        (c"DEFAULT_CHECK_INTERVAL_MS", 120_000.),
        (c"DEFAULT_MAX_COOLDOWN_MS", 21_600_000.),
        (c"DEFAULT_PARK_AFTER_FAILURES", 6.),
        (c"DEFAULT_MAX_PROBES_PER_WINDOW", 2.),
    ] {
        api.set(key, num(p, value)?)?;
    }
    Ok(api.raw())
}
