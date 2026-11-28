//! Size-limited streamed input; every exit releases the reader and clears the transfer timer.
use super::*;

pub(super) fn pull<'a>(ctx: L<'a>, target: L<'a>, kind: L<'a>) -> Result<L<'a>> {
    async_result(ctx, || {
        let global = ctx.global()?;
        let controller = global.get(c"AbortController")?.construct(&[])?;
        let timer = global.get(c"setTimeout")?.call_plain(&[
            function(controller, "timeout", 0, 0, |c, _| {
                call(c, c"abort", &[coded(c, "relay_models_timeout")?])
            })?,
            ctx.get(c"timeout")?,
        ])?;
        if callable(timer.optional(c"unref")?)? {
            call(timer, c"unref", &[])?;
        }
        let read = async_result(ctx, || {
            let url = format!(
                "{}/models",
                fold_string(target.get(c"relayUrl")?)?.trim_end_matches('/')
            );
            let auth = format!("Bearer {}", fold_string(target.get(c"apiKey")?)?);
            let headers = fields(
                ctx,
                &[
                    ("Authorization", text(ctx, &auth)?),
                    ("Accept", text(ctx, "application/json")?),
                ],
            )?;
            let options = fields(
                ctx,
                &[
                    ("method", text(ctx, "GET")?),
                    ("headers", headers),
                    ("signal", controller.get(c"signal")?),
                ],
            )?;
            let received = ctx
                .get(c"fetch")?
                .call_plain(&[text(ctx, &url)?, options])?;
            let json = then(received, ctx, |ctx, a| read_response(ctx, a[0]))?;
            then(json, kind, catalog)
        })?;
        let checked = recover(read, controller, |c, a| {
            if c.get(c"signal")?.get(c"aborted")?.truthy()? {
                Err(coded(c, "relay_models_timeout")?.throw_error())
            } else {
                Err(a[0].throw_error())
            }
        })?;
        call(
            checked,
            c"finally",
            &[function(timer, "clear", 0, 0, |t, _| {
                t.global()?.get(c"clearTimeout")?.call_plain(&[t])
            })?],
        )
    })
}
fn read_response<'a>(ctx: L<'a>, response: L<'a>) -> Result<L<'a>> {
    if !response.optional(c"ok")?.truthy()? {
        let status = num(ctx, response.optional(c"status")?.explicit_number()?)?;
        let code = fold_string(fallback(status, V::Number(0.))?)?;
        return Err(coded(ctx, &format!("remote_http_{code}"))?.throw_error());
    }
    let headers = response.get(c"headers")?;
    if headers.truthy()? {
        let length = call(headers, c"get", &[text(ctx, "content-length")?])?.explicit_number()?;
        if length.is_finite() && length > rules::MAX_RESPONSE_BYTES as f64 {
            return Err(coded(ctx, "remote_response_too_large")?.throw_error());
        }
    }
    let body = response.get(c"body")?;
    if callable(body.optional(c"getReader")?)? {
        let reader = call(body, c"getReader", &[])?;
        if reader.truthy()? {
            let state = fields(
                ctx,
                &[
                    ("reader", reader),
                    ("chunks", array(ctx)?),
                    ("size", num(ctx, 0.)?),
                ],
            )?;
            let stream = async_result(ctx, || read(state))?;
            return call(
                stream,
                c"finally",
                &[function(reader, "release", 0, 0, |r, _| {
                    r.catch(|| call(r, c"releaseLock", &[]))?;
                    undef(r)
                })?],
            );
        }
    }
    then(call(response, c"text", &[])?, ctx, |ctx, a| {
        let s = string(a[0])?;
        if s.coerce_string()?.utf8_lossy_bytes().len() > rules::MAX_RESPONSE_BYTES {
            return Err(coded(ctx, "remote_response_too_large")?.throw_error());
        }
        parse(s)
    })
}
fn parse(s: L<'_>) -> Result<L<'_>> {
    if let Some(value) = s.catch(|| json_call(s, c"parse", s))? {
        Ok(value)
    } else {
        Err(coded(s, "invalid_remote_catalog")?.throw_error())
    }
}
fn read(state: L<'_>) -> Result<L<'_>> {
    then(call(state.get(c"reader")?, c"read", &[])?, state, |s, a| {
        let chunks = s.get(c"chunks")?;
        let buffer = s.global()?.get(c"Buffer")?;
        if a[0].get(c"done")?.truthy()? {
            let data = call(buffer, c"concat", &[chunks, s.get(c"size")?])?;
            return parse(call(data, c"toString", &[text(s, "utf8")?])?);
        }
        let raw = a[0].get(c"value")?;
        let chunk = call(
            buffer,
            c"from",
            &[if raw.truthy()? { raw } else { array(s)? }],
        )?;
        let size = s.get(c"size")?.number()? + chunk.get(c"length")?.number()?;
        if size > rules::MAX_RESPONSE_BYTES as f64 {
            let cancelled = async_result(s, || call(s.get(c"reader")?, c"cancel", &[]))?;
            let settled = recover(cancelled, s, |s, _| undef(s))?;
            return then(settled, s, |s, _| {
                Err(coded(s, "remote_response_too_large")?.throw_error())
            });
        }
        call(chunks, c"push", &[chunk])?;
        s.assign(c"size", num(s, size)?)?;
        read(s)
    })
}
fn catalog<'a>(kind: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let body = a[0];
    let models = normalize(body.optional(c"models")?)?;
    let preferred = call(
        string(fallback(body.optional(c"preferredModel")?, V::from(""))?)?,
        c"trim",
        &[],
    )?;
    if !body.optional(c"ok")?.is_true()?
        || !string(fallback(body.optional(c"appType")?, V::from(""))?)?.equals(kind)?
        || models.get(c"length")?.is_number(0.)?
        || (preferred.truthy()? && !call(models, c"includes", &[preferred])?.truthy()?)
    {
        return Err(coded(kind, "invalid_remote_catalog")?.throw_error());
    }
    let preferred = or(preferred, models.element(0)?)?;
    let rev = body.get(c"revision")?;
    let rev = if rev.truthy()? {
        string(rev)?
    } else {
        revision(preferred, models)?
    };
    fields(
        kind,
        &[
            ("models", models),
            ("preferredModel", preferred),
            (
                "revision",
                call(rev, c"slice", &[num(kind, 0.)?, num(kind, 128.)?])?,
            ),
            (
                "sourceGeneratedAt",
                fallback(
                    num(kind, body.get(c"generatedAt")?.explicit_number()?)?,
                    V::Null,
                )?,
            ),
            (
                "sourceCatalogFetchedAt",
                fallback(
                    num(kind, body.get(c"catalogFetchedAt")?.explicit_number()?)?,
                    V::Null,
                )?,
            ),
        ],
    )
}
