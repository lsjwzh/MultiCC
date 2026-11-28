//! The CLI remains the sole writer of its OAuth file. A singleflight attempt
//! verifies the on-disk result after each rung before deciding what to do next.
use crate::host_api::*;
use napi_derive::napi;
use std::ffi::CStr;
mod attempt;
mod command;

fn option<'a>(opts: L<'a>, k: &CStr, default: L<'a>) -> Result<L<'a>> {
    let v = opts.get(k)?;
    Ok(if v.truthy()? { v } else { default })
}
fn clean(v: L<'_>) -> Result<L<'_>> {
    string(fallback(v, "".into())?)
}
fn enough(v: f64, min: f64, positive: bool, default: f64) -> f64 {
    if (positive && v > min) || (!positive && v >= min) {
        v
    } else {
        default
    }
}
fn time(p: L<'_>) -> Result<f64> {
    p.get(c"now")?.call_plain(&[])?.number()
}
fn env(p: L<'_>) -> Result<L<'_>> {
    p.get(c"process")?.get(c"env")
}
fn log<'a>(p: L<'a>, level: &CStr, event: &str, detail: L<'a>) -> Result<()> {
    let logger = p.get(c"logger")?;
    if logger.truthy()? {
        call(logger, level, &[text(p, event)?, detail])?;
    }
    Ok(())
}
fn matches(v: L<'_>, narrow: bool) -> Result<bool> {
    let v = fold_string(clean(v)?)?.to_ascii_lowercase();
    Ok([
        "refresh token was already used",
        "log out and sign in",
        "not logged in",
        "no login found",
    ]
    .iter()
    .any(|x| v.contains(x))
        || (!narrow
            && ["failed to refresh token", "authentication expired"]
                .iter()
                .any(|x| v.contains(x))))
}
pub(crate) fn stripped(v: L<'_>) -> Result<L<'_>> {
    let e = spread(v)?;
    call(e.global()?.get(c"Object")?, c"keys", &[e])?.for_each(|k| {
        let key = fold_string(k)?;
        if key == "CODEX_HOME"
            || key.strip_prefix("OPENAI_").is_some_and(|r| {
                r.bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            })
        {
            call(e.global()?.get(c"Reflect")?, c"deleteProperty", &[e, k])?;
        }
        Ok(())
    })?;
    Ok(e)
}
fn rejected_credential<'a>(p: L<'a>, reason: &str) -> Result<L<'a>> {
    fields(p, &[("ok", flag(p, false)?), ("reason", text(p, reason)?)])
}
fn parse<'a>(p: L<'a>, v: L<'a>) -> Result<L<'a>> {
    let Some(data) = p.catch(|| json_call(p, c"parse", clean(v)?))? else {
        return rejected_credential(p, "unparsable");
    };
    if !data.truthy()? || !object(data)? {
        return rejected_credential(p, "unparsable");
    }
    let key = data.get(c"OPENAI_API_KEY")?;
    if key.string()?.is_some() && key.truthy()? {
        return rejected_credential(p, "api_key_mode");
    }
    let tokens = data.get(c"tokens")?;
    let refresh = tokens.optional(c"refresh_token")?;
    if refresh.string()?.is_none() || !refresh.truthy()? {
        return rejected_credential(p, "no_refresh_token");
    }
    let access = tokens.get(c"access_token")?;
    let access = if access.string()?.is_some() {
        access
    } else {
        text(p, "")?
    };
    let exp = p
        .catch(|| {
            let parts = call(access, c"split", &[text(p, ".")?])?;
            let bytes = call(
                p.global()?.get(c"Buffer")?,
                c"from",
                &[parts.element(1)?, text(p, "base64url")?],
            )?;
            let claims = json_call(p, c"parse", call(bytes, c"toString", &[text(p, "utf8")?])?)?;
            let v = if claims.truthy()? {
                claims.get(c"exp")?
            } else {
                claims
            };
            let n = v.explicit_number()?;
            Ok(if n.is_finite() { n * 1000. } else { 0. })
        })?
        .unwrap_or(0.);
    let last = call(
        p.global()?.get(c"Date")?,
        c"parse",
        &[clean(data.get(c"last_refresh")?)?],
    )?
    .number()?;
    fields(
        p,
        &[
            ("ok", flag(p, true)?),
            ("expiresAt", num(p, exp)?),
            ("accessToken", access),
            ("hasRefreshToken", flag(p, true)?),
            (
                "lastRefreshAt",
                if last.is_finite() {
                    num(p, last)?
                } else {
                    null(p)?
                },
            ),
        ],
    )
}
fn read(p: L<'_>) -> Result<L<'_>> {
    let load = async_result(p, || {
        let custom = p.get(c"readFile")?;
        if callable(custom)? {
            custom.call_plain(&[p.get(c"authFile")?])
        } else {
            call(
                p.get(c"fs")?.get(c"promises")?,
                c"readFile",
                &[p.get(c"authFile")?, text(p, "utf8")?],
            )
        }
    })?;
    let parsed = then(load, p, |p, a| {
        let cred = parse(p, a[0])?;
        cred.set(c"store", text(p, "file")?)?;
        Ok(cred)
    })?;
    recover(parsed, p, |p, _| {
        let v = rejected_credential(p, "unreadable")?;
        v.set(c"store", text(p, "file")?)?;
        Ok(v)
    })
}
fn assess<'a>(p: L<'a>, v: L<'a>, ts: f64) -> Result<L<'a>> {
    let ok = v.get(c"ok")?.truthy()?;
    let reason = v.get(c"reason")?;
    let (due, outcome, detail) = if !ok {
        (
            false,
            if reason.is_string("api_key_mode")? {
                "fresh"
            } else {
                "no-credentials"
            },
            reason,
        )
    } else if v.get(c"expiresAt")?.number()? - ts > p.get(c"bufferMs")?.number()? {
        (false, "fresh", null(p)?)
    } else {
        (true, "due", null(p)?)
    };
    fields(
        p,
        &[
            ("due", flag(p, due)?),
            ("outcome", text(p, outcome)?),
            ("detail", detail),
        ],
    )
}
fn enabled(p: L<'_>) -> Result<L<'_>> {
    let f = p.get(c"isEnabled")?;
    if callable(f)? {
        f.call_plain(&[])
    } else {
        flag(
            p,
            !env(p)?.get(c"CODEX_OAUTH_AUTO_REFRESH")?.is_string("0")?,
        )
    }
}
fn status(p: L<'_>) -> Result<L<'_>> {
    let retry = p.get(c"retryAfter")?;
    let needs = p.get(c"needsLogin")?;
    fields(
        p,
        &[
            ("enabled", enabled(p)?),
            ("lastAttemptAt", p.get(c"lastAttemptAt")?),
            ("lastSuccessAt", p.get(c"lastSuccessAt")?),
            ("lastOutcome", p.get(c"lastOutcome")?),
            ("retryAfter", fallback(retry, V::Null)?),
            ("consecutiveFailures", p.get(c"consecutiveFailures")?),
            ("refreshCount", p.get(c"refreshCount")?),
            ("inFlight", flag(p, p.get(c"inFlight")?.truthy()?)?),
            (
                "needsLogin",
                if needs.truthy()? {
                    spread(needs)?
                } else {
                    null(p)?
                },
            ),
        ],
    )
}
fn notify(p: L<'_>, key: &CStr) -> Result<()> {
    let f = p.get(key)?;
    if callable(f)? {
        p.catch(|| f.call_plain(&[status(p)?]))?;
    }
    Ok(())
}
fn cleared(p: L<'_>, how: &str) -> Result<()> {
    let needs = p.get(c"needsLogin")?;
    if needs.truthy()? {
        p.set(c"needsLogin", null(p)?)?;
        p.set(c"consecutiveFailures", num(p, 0.)?)?;
        p.set(c"retryAfter", num(p, 0.)?)?;
        log(
            p,
            c"info",
            "codex_oauth_login_recovered",
            fields(
                p,
                &[
                    ("how", text(p, how)?),
                    (
                        "downForMs",
                        num(p, time(p)? - needs.get(c"since")?.number()?)?,
                    ),
                ],
            )?,
        )?;
        notify(p, c"onRecovered")?;
    }
    Ok(())
}
fn remember<'a>(p: L<'a>, out: L<'a>) -> Result<L<'a>> {
    p.set(c"lastOutcome", out)?;
    Ok(out)
}
fn refresh<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let options = default_object(a[0])?;
    let reason = with_default(options.get(c"reason")?, text(p, "manual")?)?;
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
    let forced = options.get(c"force")?.truthy()?;
    let ctx = fields(
        p,
        &[
            ("p", p),
            ("reason", reason),
            ("ts", num(p, ts)?),
            ("hint", options.get(c"authFailureHint")?),
        ],
    )?;
    if !forced && p.get(c"needsLogin")?.truthy()? {
        return then(read(p)?, ctx, |ctx, a| {
            let p = ctx.get(c"p")?;
            let ts = ctx.get(c"ts")?;
            let reason = ctx.get(c"reason")?;
            let decision = assess(p, a[0], ts.number()?)?;
            let out = if decision.get(c"outcome")?.is_string("fresh")? {
                cleared(p, "credential-fresh")?;
                fields(
                    p,
                    &[
                        ("outcome", text(p, "fresh")?),
                        ("detail", decision.get(c"detail")?),
                        ("at", ts),
                        ("reason", reason),
                    ],
                )?
            } else {
                fields(
                    p,
                    &[
                        ("outcome", text(p, "needs_login")?),
                        ("reason", reason),
                        ("at", ts),
                        ("since", p.get(c"needsLogin")?.get(c"since")?),
                        ("loginCommand", text(p, "codex login")?),
                    ],
                )?
            };
            remember(p, out)
        });
    }
    let retry = p.get(c"retryAfter")?.number()?;
    if !forced && retry != 0. && ts < retry {
        return resolved(fields(
            p,
            &[
                ("outcome", text(p, "cooldown")?),
                ("reason", reason),
                ("retryInMs", num(p, retry - ts)?),
            ],
        )?);
    }
    let work = async_result(ctx, || attempt::start(ctx))?;
    let caught = recover(work, ctx, |c, a| {
        let p = c.get(c"p")?;
        let n = p.get(c"consecutiveFailures")?.number()? + 1.;
        p.set(c"consecutiveFailures", num(p, n)?)?;
        p.set(
            c"retryAfter",
            num(p, time(p)? + p.get(c"cooldownMs")?.number()?)?,
        )?;
        let reason = c.get(c"reason")?;
        let err = a[0].get(c"message")?;
        log(
            p,
            c"error",
            "codex_oauth_refresh_error",
            fields(p, &[("reason", reason), ("error", err)])?,
        )?;
        fields(
            p,
            &[
                ("outcome", text(p, "failed")?),
                ("reason", reason),
                ("error", err),
            ],
        )
    })?;
    let done = function(p, "settled", 0, 0, |p, _| {
        p.set(c"inFlight", null(p)?)?;
        undef(p)
    })?;
    let running = call(caught, c"finally", &[done])?;
    p.set(c"inFlight", running)?;
    Ok(running)
}
pub(crate) fn create<'a>(ports: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let o = default_object(options)?;
    let p = spread(ports)?;
    for k in [
        c"logger",
        c"run",
        c"readFile",
        c"buildEnv",
        c"isEnabled",
        c"onNeedsLogin",
        c"onRecovered",
    ] {
        p.set(k, o.get(k)?)?;
    }
    let now = o.get(c"now")?;
    p.set(
        c"now",
        if callable(now)? {
            now
        } else {
            p.global()?.get(c"Date")?.get(c"now")?
        },
    )?;
    let bin = option(
        o,
        c"codexBin",
        fallback(env(p)?.get(c"CODEX_BIN")?, "codex".into())?,
    )?;
    p.set(c"codexBin", bin)?;
    let cwd = o.get(c"cwd")?;
    p.set(
        c"cwd",
        if cwd.truthy()? {
            cwd
        } else {
            call(p.get(c"os")?, c"tmpdir", &[])?
        },
    )?;
    let file = o.get(c"authFile")?;
    p.set(
        c"authFile",
        if file.truthy()? {
            file
        } else {
            call(
                p.get(c"path")?,
                c"join",
                &[
                    call(p.get(c"os")?, c"homedir", &[])?,
                    text(p, ".codex")?,
                    text(p, "auth.json")?,
                ],
            )?
        },
    )?;
    for (k, pos, d) in [
        (c"bufferMs", true, 900000.),
        (c"probeThresholdMs", false, 120000.),
        (c"cooldownMs", false, 600000.),
        (c"deferCooldownMs", false, 90000.),
        (c"commandTimeoutMs", true, 120000.),
    ] {
        p.set(k, num(p, enough(o.get(k)?.explicit_number()?, 0., pos, d))?)?;
    }
    for k in [
        c"inFlight",
        c"lastAttemptAt",
        c"lastSuccessAt",
        c"lastOutcome",
        c"needsLogin",
    ] {
        p.set(k, null(p)?)?;
    }
    for k in [c"retryAfter", c"consecutiveFailures", c"refreshCount"] {
        p.set(k, num(p, 0.)?)?;
    }
    defaulted_methods(
        p,
        &[
            ("check", 0, 1, |p, a| {
                let opts = fields(p, &[("reason", with_default(a[0], text(p, "periodic")?)?)])?;
                refresh(p, &mut [opts])
            }),
            ("refresh", 0, 1, refresh),
            ("onApiError", 1, 1, |p, a| {
                let err = a[0].optional(c"error")?;
                if !err.truthy()? || !matches(err.get(c"sanitizedMessage")?, false)? {
                    return null(p);
                }
                let provider = err.get(c"provider")?;
                if provider.truthy()?
                    && !fold_string(provider)?
                        .to_ascii_lowercase()
                        .contains("codex")
                {
                    return null(p);
                }
                let opts = fields(
                    p,
                    &[
                        ("reason", text(p, "api-error")?),
                        ("authFailureHint", flag(p, true)?),
                    ],
                )?;
                refresh(p, &mut [opts])
            }),
            ("status", 0, 0, |p, _| status(p)),
            ("readCredentials", 0, 0, |p, _| read(p)),
            ("assess", 2, 2, |p, a| assess(p, a[0], a[1].number()?)),
        ],
    )
}
#[napi]
pub fn codex_oauth_refresh_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = defaulted_methods(
        p,
        &[
            ("createCodexOAuthRefresher", 0, 1, |p, a| create(p, a[0])),
            ("looksLikeCodexAuthFailure", 1, 1, |p, a| {
                flag(p, matches(a[0], false)?)
            }),
            ("looksLikeCodexLoginRequired", 1, 1, |p, a| {
                flag(p, matches(a[0], true)?)
            }),
            ("parseCodexAuth", 1, 1, |p, a| parse(p, a[0])),
            ("stripOpenAiEnv", 1, 1, |_, a| stripped(a[0])),
        ],
    )?;
    api.set(c"DEFAULT_CHECK_INTERVAL_MS", num(p, 120000.)?)?;
    Ok(api.raw())
}
