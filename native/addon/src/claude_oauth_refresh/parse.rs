use super::*;

pub(super) fn clean(v: L<'_>) -> Result<L<'_>> {
    string(fallback(v, "".into())?)
}
pub(super) fn expired(v: L<'_>) -> Result<bool> {
    test(
        clean(v)?,
        "official OAuth unavailable|OAuth token expired|refresh the Keychain|no OAuth credentials",
        "i",
    )
}
pub(super) fn revoked(v: L<'_>) -> Result<bool> {
    Ok(multicc_core::claude_refresh::looks_like_revoked_oauth(
        &fold_string(clean(v)?)?,
    ))
}
fn regexp<'a>(p: L<'a>, pattern: &str, flags: &str) -> Result<L<'a>> {
    p.global()?
        .get(c"RegExp")?
        .construct(&[text(p, pattern)?, text(p, flags)?])
}
fn test(v: L<'_>, pattern: &str, flags: &str) -> Result<bool> {
    call(regexp(v, pattern, flags)?, c"test", &[v])?.truthy()
}
pub(super) fn redact<'a>(v: L<'a>, limit: L<'a>) -> Result<L<'a>> {
    let cleaned = call(
        clean(v)?,
        c"replace",
        &[
            regexp(
                v,
                r"\b(sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_.-]{16,}|[A-Za-z0-9_-]{40,}={0,2})",
                "g",
            )?,
            text(v, "[REDACTED]")?,
        ],
    )?;
    let cleaned = call(
        cleaned,
        c"replace",
        &[regexp(v, r"\s+", "g")?, text(v, " ")?],
    )?;
    let cleaned = call(cleaned, c"trim", &[])?;
    let limit = with_default(limit, num(v, 400.)?)?;
    if cleaned.get(c"length")?.number()? > limit.number()? {
        return call(
            call(cleaned, c"slice", &[num(v, 0.)?, limit])?,
            c"concat",
            &[text(v, "…")?],
        );
    }
    Ok(cleaned)
}
pub(super) fn classify(steps: L<'_>) -> Result<&'static str> {
    let parts = array(steps)?;
    if steps.is_array()? {
        steps.for_each(|step| {
            if step.truthy()?
                && (step.get(c"timedOut")?.truthy()? || !step.get(c"code")?.is_number(0.)?)
            {
                let words = call(
                    clean(step.get(c"stderr")?)?,
                    c"concat",
                    &[text(step, " ")?, clean(step.get(c"stdout")?)?],
                )?;
                call(parts, c"push", &[words])?;
            }
            Ok(())
        })?;
    }
    let words = call(parts, c"join", &[text(steps, " ")?])?;
    if test(
        words,
        r"invalid_grant|access_denied|unsupported_country|not allowed|revoked|forbidden|unauthorized|authentication_error|\b401\b",
        "i",
    )? {
        Ok("rejected")
    } else if test(
        words,
        r"ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed|\bTLS\b|proxy",
        "i",
    )? {
        Ok("network")
    } else {
        Ok("unknown")
    }
}
fn invalid<'a>(p: L<'a>, reason: &str) -> Result<L<'a>> {
    fields(p, &[("ok", flag(p, false)?), ("reason", text(p, reason)?)])
}
pub(super) fn credentials(raw: L<'_>) -> Result<L<'_>> {
    let Some(data) = raw.catch(|| json_call(raw, c"parse", clean(raw)?))? else {
        return invalid(raw, "unparsable");
    };
    let oauth = if data.truthy()? && object(data)? {
        data.get(c"claudeAiOauth")?
    } else {
        null(raw)?
    };
    if !oauth.truthy()? || !object(oauth)? {
        return invalid(raw, "no_oauth_entry");
    }
    let expires = oauth.get(c"expiresAt")?.explicit_number()?;
    if !expires.is_finite() {
        return invalid(raw, "no_expiry");
    }
    let refresh = oauth.get(c"refreshTokenExpiresAt")?.explicit_number()?;
    fields(
        raw,
        &[
            ("ok", flag(raw, true)?),
            ("expiresAt", num(raw, expires)?),
            (
                "refreshExpiresAt",
                if refresh.is_finite() {
                    num(raw, refresh)?
                } else {
                    null(raw)?
                },
            ),
            (
                "hasRefreshToken",
                flag(raw, oauth.get(c"refreshToken")?.truthy()?)?,
            ),
            (
                "subscriptionType",
                fallback(clean(oauth.get(c"subscriptionType")?)?, V::Null)?,
            ),
        ],
    )
}
pub(super) fn auth(result: L<'_>) -> Result<L<'_>> {
    let raw = call(clean(result.optional(c"stdout")?)?, c"trim", &[])?;
    let Some(data) = raw.catch(|| json_call(raw, c"parse", raw))? else {
        return null(raw);
    };
    if !data.truthy()? || !object(data)? {
        return null(raw);
    }
    let logged = data.get(c"loggedIn")?;
    if logged.kind()? != sys::ValueType::napi_boolean {
        return null(raw);
    }
    fields(
        raw,
        &[
            ("loggedIn", logged),
            (
                "authMethod",
                fallback(clean(data.get(c"authMethod")?)?, V::Null)?,
            ),
        ],
    )
}
pub(super) fn fingerprint(v: L<'_>) -> Result<L<'_>> {
    if !v.truthy()? || !v.get(c"ok")?.truthy()? {
        return null(v);
    }
    call(
        string(v.get(c"expiresAt")?)?,
        c"concat",
        &[
            text(v, "|")?,
            clean(v.get(c"refreshExpiresAt")?)?,
            text(v, "|")?,
            text(
                v,
                if v.get(c"hasRefreshToken")?.truthy()? {
                    "1"
                } else {
                    "0"
                },
            )?,
        ],
    )
}
