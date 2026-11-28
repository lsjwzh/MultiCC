use super::*;

pub(super) fn encode<'a>(session: L<'a>, token: L<'a>) -> Result<L<'a>> {
    text(
        session,
        &identity::provider_encode_proxy_session(environment(session), arg(session)?, arg(token)?)?,
    )
}

fn decode(value: L<'_>) -> Result<L<'_>> {
    Ok(raw(
        value,
        identity::provider_decode_proxy_session(environment(value), arg(value)?)?,
    ))
}

pub(super) fn resolve(value: L<'_>) -> Result<L<'_>> {
    fallback(decode(value)?.get(c"sessionId")?, V::Null)
}

pub(super) fn context<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let decoded = decode(input.get(c"sessionId")?)?;
    let session = decoded.get(c"sessionId")?;
    let record = current(p, session)?;
    let token = decoded.get(c"token")?;
    let encoded = decoded.get(c"encoded")?;
    let exact =
        record.truthy()? && encoded.truthy()? && token.equals(record.get(c"proxyRouteToken")?)?;
    fields(
        p,
        &[
            ("sessionId", session),
            ("token", token),
            ("encoded", flag(p, encoded.is_true()?)?),
            ("record", record),
            ("exact", flag(p, exact)?),
        ],
    )
}

pub(super) fn session_id<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let record = current(p, member(a[0], c"sessionId")?.clean_text()?)?;
    if !matching(record, a[0])? {
        return Err(identity::provider_error(
            p.get(c"ProviderAttemptError")?,
            "provider attempt is not current",
            "PROVIDER_ATTEMPT_STALE",
        )?);
    }
    encode(record.get(c"sessionId")?, record.get(c"proxyRouteToken")?)
}

pub(super) fn poison<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let r = a[0];
    if r.truthy()? && call(r.get(c"lifecycle")?, c"running", &[])?.truthy()? {
        let reference = attempt_snapshot(r)?;
        let facts = fields(
            p,
            &[
                ("outcome", text(p, "failed")?),
                ("errorCategory", text(p, "adapter_configuration")?),
                ("reasonCode", a[1]),
            ],
        )?;
        finish(p, reference, facts)?;
    }
    undef(p)
}

pub(super) fn authorize<'a>(p: L<'a>, input: L<'a>, port: L<'a>) -> Result<L<'a>> {
    Ok(raw(
        p,
        crate::provider_authorization::provider_authorize_proxy_request(
            environment(p),
            arg(input)?,
            arg(context(p, input)?)?,
            arg(port)?,
        )?,
    ))
}

pub(super) fn authorize_async<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let input = default_object(args[0])?;
        let method = call(input.get(c"method")?.clean_text()?, c"toUpperCase", &[])?;
        let guard = p.get(c"quotaGuard")?;
        if !guard.truthy()?
            || (method.truthy()? && !method.is_string("POST")?)
            || !callable(guard.get(c"checkAsync")?)?
        {
            return authorize(p, input, p);
        }
        let check = guard.get(c"checkAsync")?;
        let pending = check.call(
            guard,
            &[fields(
                p,
                &[("providerId", input.get(c"providerId")?.clean_text()?)],
            )?],
        )?;
        let owner = fields(p, &[("port", p), ("input", input)])?;
        then(pending, owner, |owner, args| {
            let p = owner.get(c"port")?;
            let port = spread(p)?;
            let check = function(args[0], "check", 0, 0, constant)?;
            port.set(c"quotaGuard", fields(p, &[("check", check)])?)?;
            // Read the active attempt again after waiting on the quota store.
            authorize(p, owner.get(c"input")?, port)
        })
    })
}

pub(super) fn bound<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    crate::provider_producers::bound(input, context(p, input)?, p)
}

pub(super) fn delta<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let context = default_object(args[1])?;
    let attempt = bound(p, context)?;
    if attempt.truthy()? {
        return events::observe(
            p,
            attempt,
            fields(p, &[("type", text(p, "part_delta")?), ("delta", args[0])])?,
        );
    }
    let session = resolve(context.get(c"sessionId")?)?;
    let current_field = |key| {
        fallback(
            attempt_snapshot(current(p, session.clean_text()?)?)?.optional(key)?,
            V::Null,
        )
    };
    let event = fields(
        p,
        &[
            ("type", text(p, "provider_attempt_late_ignored")?),
            ("operation", text(p, "proxy_delta")?),
            ("runtimeEpoch", p.get(c"runtimeEpoch")?),
            ("turnId", null(p)?),
            ("routeAttemptId", null(p)?),
            ("routeGeneration", null(p)?),
            (
                "providerId",
                fallback(context.get(c"providerId")?.clean_text()?, V::Null)?,
            ),
            ("currentRouteAttemptId", current_field(c"routeAttemptId")?),
            ("currentRouteGeneration", current_field(c"routeGeneration")?),
        ],
    )?;
    audit(p, session, event)?;
    events::rejected(p, "proxy_attempt_unbound")
}
