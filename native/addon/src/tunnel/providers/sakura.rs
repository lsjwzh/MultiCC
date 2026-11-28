use super::*;

fn token(s: L<'_>) -> Result<L<'_>> {
    let raw = config(s, "sakurafrp")?.optional(c"authtoken")?;
    let configured = call(fallback(raw, "".into())?, c"trim", &[])?;
    if configured.truthy()? {
        return Ok(configured);
    }
    fallback(
        super::super::sakura_api::launcher(s.get(c"ports")?, undefined(s)?)?.optional(c"token")?,
        V::Null,
    )
}
fn denied<'a>(s: L<'a>, reason: &str) -> Result<L<'a>> {
    fields(s, &[("ok", flag(s, false)?), ("reason", text(s, reason)?)])
}
fn api_failure<'a>(s: L<'a>, error: L<'a>) -> Result<L<'a>> {
    let msg = error.optional(c"message")?;
    let why = string(if msg.truthy()? { msg } else { error })?;
    let result = denied(s, "api_error")?;
    result.set(
        c"message",
        call(why, c"slice", &[num(s, 0.)?, num(s, 200.)?])?,
    )?;
    Ok(result)
}
fn bound_url<'a>(s: L<'a>, input: L<'a>) -> Result<Option<L<'a>>> {
    let raw = label(call(string(fallback(input, "".into())?)?, c"trim", &[])?)?;
    let lower = raw.to_ascii_lowercase();
    let stripped = if lower.starts_with("https://") {
        &raw[8..]
    } else if lower.starts_with("http://") {
        &raw[7..]
    } else {
        &raw
    };
    let host = stripped.split('/').next().unwrap_or("");
    let Some(prefix) = host
        .to_ascii_lowercase()
        .strip_suffix(".nyat.app")
        .map(str::to_owned)
    else {
        return Ok(None);
    };
    let valid = prefix
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'));
    if valid {
        Ok(Some(text(s, &format!("https://{host}"))?))
    } else {
        Ok(None)
    }
}
fn backfill<'a>(f: L<'a>, access: L<'a>) -> Result<L<'a>> {
    let s = f.get(c"owner")?;
    if !access.truthy()? {
        return denied(s, "no_tunnel");
    }
    let url = if access.get(c"needsBoundDomain")?.truthy()? {
        let Some(url) = bound_url(s, f.get(c"boundDomain")?)? else {
            return denied(s, "bound_domain_required");
        };
        url
    } else {
        let url = access.get(c"publicUrl")?;
        if !url.truthy()? {
            return denied(s, "underivable");
        }
        url
    };
    let update = fields(s, &[("sakurafrp", fields(s, &[("url", url)])?)])?;
    super::super::config::apply(s, update, fields(s, &[])?)?;
    fields(s, &[("ok", flag(s, true)?), ("url", url)])
}
pub(super) fn access<'a>(s: L<'a>, opts: L<'a>, apply: bool) -> Result<L<'a>> {
    let bound = if apply {
        opts.get(c"boundDomain")?
    } else {
        undefined(s)?
    };
    let fetch = opts.get(c"fetch")?;
    let token = token(s)?;
    if !token.truthy()? {
        return denied(s, "no_token");
    }
    let f = frame(s, &[("boundDomain", bound)])?;
    let ports = s.get(c"ports")?;
    let auth = fields(s, &[("token", token), ("fetch", fetch)])?;
    let gather = async_result(s, || {
        if apply {
            return after(
                f,
                super::super::sakura_api::discover(ports, auth)?,
                |_, v| v.get(c"access"),
            );
        }
        let user = super::super::sakura_api::user(ports, auth)?;
        let found = super::super::sakura_api::discover(ports, auth)?;
        let gathered = call(promise(s)?, c"all", &[array(s, &[user, found])?])?;
        after(s, gathered, |s, values| {
            let discovered = values.element(1)?;
            let access = fallback(discovered.get(c"access")?, V::Null)?;
            fields(
                s,
                &[
                    ("ok", flag(s, true)?),
                    ("user", values.element(0)?),
                    ("access", access),
                    (
                        "tunnelCount",
                        fallback(discovered.get(c"tunnelCount")?, V::Number(0.))?,
                    ),
                    (
                        "configUrl",
                        fallback(config(s, "sakurafrp")?.optional(c"url")?, "".into())?,
                    ),
                    (
                        "needsBoundDomain",
                        flag(s, access.optional(c"needsBoundDomain")?.truthy()?)?,
                    ),
                ],
            )
        })
    })?;
    let fail = function(s, "", 1, 1, |s, a| api_failure(s, a[0]))?;
    if apply {
        // Only the API discovery is recoverable. Persistence and publishing
        // failures remain rejections with the original host error.
        call(
            gather,
            c"then",
            &[function(f, "", 1, 1, |f, a| backfill(f, a[0]))?, fail],
        )
    } else {
        call(gather, c"catch", &[fail])
    }
}
