//! Claude official PKCE login and read-only account endpoints.
use crate::host_api::*;
use napi_derive::napi;
mod listener;

const AUTH: &str = "https://claude.ai/oauth/authorize";
const TOKEN: &str = "https://platform.claude.com/v1/oauth/token";
const PROFILE: &str = "https://api.anthropic.com/api/oauth/profile";
const USAGE: &str = "https://api.anthropic.com/api/oauth/usage";
const CLIENT: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT: &str = "http://localhost:54545/callback";
const SCOPE: &str =
    "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const PORT: f64 = 54545.;
fn date_now(p: L<'_>) -> Result<L<'_>> {
    call(p.global()?.get(c"Date")?, c"now", &[])
}
fn random(p: L<'_>, size: f64) -> Result<L<'_>> {
    let bytes = call(p.get(c"crypto")?, c"randomBytes", &[num(p, size)?])?;
    call(bytes, c"toString", &[text(p, "base64url")?])
}
fn pkce<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let verifier = random(p, 32.)?;
    let hash = call(p.get(c"crypto")?, c"createHash", &[text(p, "sha256")?])?;
    call(hash, c"update", &[verifier])?;
    fields(
        p,
        &[
            ("codeVerifier", verifier),
            (
                "codeChallenge",
                call(hash, c"digest", &[text(p, "base64url")?])?,
            ),
        ],
    )
}
fn authorize<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = a[0];
    let state = opts.get(c"state")?;
    let challenge = opts.get(c"codeChallenge")?;
    let values = fields(
        p,
        &[
            ("code", text(p, "true")?),
            ("client_id", text(p, CLIENT)?),
            ("response_type", text(p, "code")?),
            ("redirect_uri", text(p, REDIRECT)?),
            ("scope", text(p, SCOPE)?),
            ("code_challenge", challenge),
            ("code_challenge_method", text(p, "S256")?),
            ("state", state),
        ],
    )?;
    let params = p.global()?.get(c"URLSearchParams")?.construct(&[values])?;
    call(
        text(p, AUTH)?,
        c"concat",
        &[text(p, "?")?, call(params, c"toString", &[])?],
    )
}
fn clean(v: L<'_>) -> Result<L<'_>> {
    string(fallback(v, "".into())?)
}
fn code_state<'a>(p: L<'a>, code: L<'a>, state: L<'a>) -> Result<L<'a>> {
    let splits = call(clean(code)?, c"split", &[text(p, "#")?])?;
    let part = splits.element(1)?;
    fields(
        p,
        &[
            ("code", splits.element(0)?),
            ("state", if part.truthy()? { part } else { state }),
        ],
    )
}
fn oauth_err<'a>(p: L<'a>, msg: L<'a>, status: L<'a>, retry: L<'a>) -> Result<L<'a>> {
    p.get(c"ClaudeOAuthError")?.construct(&[
        msg,
        fields(p, &[("status", status), ("retryAfterMs", retry)])?,
    ])
}
fn fault<'a>(p: L<'a>, msg: &str) -> Result<L<'a>> {
    Err(oauth_err(p, text(p, msg)?, null(p)?, null(p)?)?.throw_error())
}
fn retry_ms(p: L<'_>) -> Result<L<'_>> {
    if !p.truthy()? {
        return num(p, 5000.);
    }
    let getter = p.get(c"get")?;
    for (name, seconds) in [(c"retry-after", true), (c"retry-after-ms", false)] {
        let raw = if callable(getter)? {
            getter.call(p, &[text(p, name.to_str().unwrap())?])?
        } else {
            p.get(name)?
        };
        let raw = call(clean(raw)?, c"trim", &[])?;
        if !raw.truthy()? {
            continue;
        }
        let s = fold_string(raw)?;
        let mut parts = s.split('.');
        let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        if digits(parts.next().unwrap_or(""))
            && parts.next().map(digits).unwrap_or(true)
            && parts.next().is_none()
        {
            return num(
                p,
                (raw.explicit_number()? * if seconds { 1000. } else { 1. }).clamp(5000., 300000.),
            );
        }
        if seconds {
            let ts = call(p.global()?.get(c"Date")?, c"parse", &[raw])?.number()?;
            if ts.is_finite() {
                return num(p, (ts - date_now(p)?.number()?).clamp(5000., 300000.));
            }
        }
    }
    num(p, 5000.)
}
fn request<'a>(p: L<'a>, f: L<'a>, url: &str, opts: L<'a>) -> Result<L<'a>> {
    let g = p.global()?;
    let ctrl = g.get(c"AbortController")?.construct(&[])?;
    let timer = call(
        g,
        c"setTimeout",
        &[
            function(ctrl, "abort", 0, 0, |ctrl, _| call(ctrl, c"abort", &[]))?,
            num(p, 30000.)?,
        ],
    )?;
    let response = async_result(p, || {
        opts.set(c"signal", ctrl.get(c"signal")?)?;
        f.call_plain(&[text(p, url)?, opts])
    })?;
    call(
        response,
        c"finally",
        &[function(timer, "clearTimeout", 0, 0, |timer, _| {
            call(timer.global()?, c"clearTimeout", &[timer])
        })?],
    )
}
fn headers(p: L<'_>) -> Result<L<'_>> {
    fields(
        p,
        &[
            ("Accept", text(p, "application/json, text/plain, */*")?),
            ("User-Agent", text(p, "axios/1.15.2")?),
        ],
    )
}
fn identity<'a>(value: L<'a>, out: L<'a>, email: &std::ffi::CStr) -> Result<()> {
    for (k, parent, key) in [
        (c"email", c"account", email),
        (c"account_uuid", c"account", c"uuid"),
        (c"organization_uuid", c"organization", c"uuid"),
        (c"organization_name", c"organization", c"name"),
    ] {
        out.set(k, clean(value.get(parent)?.optional(key)?)?)?;
    }
    Ok(())
}
fn stamp<'a>(p: L<'a>, now: L<'a>, extra: Option<f64>) -> Result<L<'a>> {
    let mut at = if now.undefined()? {
        date_now(p)?
    } else {
        now.call_plain(&[])?
    };
    if let Some(extra) = extra {
        at = if at.kind()? == sys::ValueType::napi_string {
            call(at, c"concat", &[num(p, extra)?])?
        } else {
            num(p, at.number()? + extra)?
        };
    }
    call(
        p.global()?.get(c"Date")?.construct(&[at])?,
        c"toISOString",
        &[],
    )
}
fn decoded<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"ports")?;
    let res = ctx.get(c"res")?;
    let status = res.get(c"status")?;
    let token = ctx.get(c"token")?.truthy()?;
    let success = if token {
        status.is_number(200.)?
    } else {
        res.get(c"ok")?.truthy()?
    };
    if !success {
        let rate = status.is_number(429.)?;
        let prefix = if token && rate {
            "token endpoint rate-limited: ".to_string()
        } else {
            format!(
                "{} HTTP {}: ",
                if token { "token endpoint" } else { "usage" },
                fold_string(status)?
            )
        };
        let msg = call(
            text(p, &prefix)?,
            c"concat",
            &[call(a[0], c"slice", &[num(p, 0.)?, num(p, 200.)?])?],
        )?;
        return Err(oauth_err(
            p,
            msg,
            status,
            if rate {
                retry_ms(res.get(c"headers")?)?
            } else {
                null(p)?
            },
        )?
        .throw_error());
    }
    let Some(json) = p.catch(|| json_call(p, c"parse", a[0]))? else {
        let msg = if token {
            "token endpoint returned non-JSON"
        } else {
            "usage endpoint returned non-JSON"
        };
        return Err(oauth_err(p, text(p, msg)?, status, null(p)?)?.throw_error());
    };
    if !token {
        return Ok(json);
    }
    let access = clean(json.get(c"access_token")?)?;
    if !access.truthy()? {
        return fault(p, "token response missing access_token");
    }
    let expires = json.get(c"expires_in")?.explicit_number()?;
    let out = fields(
        p,
        &[
            ("access_token", access),
            ("refresh_token", clean(json.get(c"refresh_token")?)?),
        ],
    )?;
    identity(json, out, c"email_address")?;
    let now = ctx.get(c"now")?;
    out.set(
        c"expired",
        stamp(
            p,
            now,
            Some(if expires.is_finite() {
                expires * 1000.
            } else {
                0.
            }),
        )?,
    )?;
    out.set(c"last_refresh", stamp(p, now, None)?)?;
    Ok(out)
}
fn read_text<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    ctx.set(c"res", a[0])?;
    then(call(a[0], c"text", &[])?, ctx, decoded)
}
fn exchange<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let opts = a[1];
        let code = code_state(p, opts.get(c"code")?, opts.get(c"state")?)?;
        let body = fields(
            p,
            &[
                ("grant_type", text(p, "authorization_code")?),
                ("code", code.get(c"code")?),
                ("redirect_uri", text(p, REDIRECT)?),
                ("client_id", text(p, CLIENT)?),
                ("code_verifier", opts.get(c"codeVerifier")?),
                ("state", code.get(c"state")?),
            ],
        )?;
        let h = headers(p)?;
        h.set(c"Content-Type", text(p, "application/json")?)?;
        let o = fields(
            p,
            &[
                ("method", text(p, "POST")?),
                ("headers", h),
                ("body", json_call(p, c"stringify", body)?),
            ],
        )?;
        let ctx = fields(
            p,
            &[
                ("ports", p),
                ("token", flag(p, true)?),
                ("now", opts.get(c"now")?),
            ],
        )?;
        then(request(p, a[0], TOKEN, o)?, ctx, read_text)
    })
}
fn get_account<'a>(p: L<'a>, a: &mut [L<'a>], profile: bool) -> Result<L<'a>> {
    async_result(p, || {
        let h = headers(p)?;
        h.set(
            c"Authorization",
            call(text(p, "Bearer ")?, c"concat", &[a[1]])?,
        )?;
        if !profile {
            h.set(c"anthropic-beta", text(p, "oauth-2025-04-20")?)?;
        }
        h.set(c"Cache-Control", text(p, "no-cache")?)?;
        let res = request(
            p,
            a[0],
            if profile { PROFILE } else { USAGE },
            fields(p, &[("headers", h)])?,
        )?;
        if !profile {
            return then(res, fields(p, &[("ports", p)])?, read_text);
        }
        then(res, p, |p, a| {
            let res = a[0];
            if !res.get(c"ok")?.truthy()? {
                let status = res.get(c"status")?;
                let msg = call(text(p, "profile HTTP ")?, c"concat", &[status])?;
                return Err(oauth_err(p, msg, status, null(p)?)?.throw_error());
            }
            then(call(res, c"json", &[])?, p, |p, a| {
                let subscription = p
                    .get(c"subscriptionFromBody")?
                    .call_plain(&[a[0], fields(p, &[("source", text(p, "profile")?)])?])?;
                let out = fields(p, &[])?;
                if subscription.truthy()? {
                    out.set(c"subscription", subscription)?;
                }
                identity(a[0], out, c"email")?;
                Ok(out)
            })
        })
    })
}
#[napi]
pub fn initialize_claude_oauth_error(
    env: Env,
    error: Unknown<'_>,
    options: Unknown<'_>,
) -> Result<()> {
    let err = L::new(&env, error);
    let opts = default_object(L::new(&env, options))?;
    err.set(c"name", text(err, "ClaudeOAuthError")?)?;
    for k in [c"status", c"retryAfterMs"] {
        err.set(k, with_default(opts.get(k)?, null(err)?)?)?;
    }
    Ok(())
}
#[napi]
pub fn claude_oauth_retryable(env: Env, error: Unknown<'_>) -> Result<bool> {
    let status = L::new(&env, error).get(c"status")?;
    Ok(status.nullish()? || status.number()? >= 500.)
}
#[napi]
pub fn claude_official_oauth_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = defaulted_methods(
        p,
        &[
            ("generatePkce", 0, 0, pkce),
            ("generateState", 0, 0, |p, _| random(p, 24.)),
            ("buildAuthorizeUrl", 1, 1, authorize),
            ("parseRetryAfterMs", 1, 1, |_, a| retry_ms(a[0])),
            ("parseCodeAndState", 2, 2, |p, a| code_state(p, a[0], a[1])),
            ("exchangeCode", 2, 2, exchange),
            ("fetchProfile", 2, 2, |p, a| get_account(p, a, true)),
            ("fetchUsage", 2, 2, |p, a| get_account(p, a, false)),
            ("waitForCallback", 0, 1, listener::wait),
        ],
    )?;
    for (name, value) in [
        (c"AUTH_URL", AUTH),
        (c"TOKEN_URL", TOKEN),
        (c"PROFILE_URL", PROFILE),
        (c"USAGE_URL", USAGE),
        (c"CLIENT_ID", CLIENT),
        (c"REDIRECT_URI", REDIRECT),
        (c"SCOPE", SCOPE),
    ] {
        api.set(name, text(p, value)?)?;
    }
    for (name, n) in [
        (c"CALLBACK_PORT", PORT),
        (c"REFRESH_MIN_BACKOFF_MS", 5000.),
        (c"REFRESH_MAX_BACKOFF_MS", 300000.),
    ] {
        api.set(name, num(p, n)?)?;
    }
    api.set(c"ClaudeOAuthError", p.get(c"ClaudeOAuthError")?)?;
    Ok(api.raw())
}
