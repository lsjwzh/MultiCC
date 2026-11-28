//! Signal/response adapters for the unified outbound transport.
use super::{auth_refresh, *};
pub(super) const FAIL: &str = "limit_fetch_failed";

fn failure<'a>(p: L<'a>, detail: L<'a>) -> Result<L<'a>> {
    let detail = string(detail)?;
    let msg = call(text(p, "limit fetch failed: ")?, c"concat", &[detail])?;
    let err = p.global()?.get(c"Error")?.construct(&[msg])?;
    err.set(c"kind", text(p, FAIL)?)?;
    err.set(c"detail", detail)?;
    Err(err.throw_error())
}
fn snippet(r: L<'_>) -> Result<L<'_>> {
    let data = async_result(r, || call(r, c"text", &[]))?;
    let formatted = then(data, r, |r, a| {
        let s = call(string(a[0])?, c"slice", &[num(r, 0.)?, num(r, 200.)?])?;
        let re = r
            .global()?
            .get(c"RegExp")?
            .construct(&[text(r, r"\s+")?, text(r, "g")?])?;
        call(call(s, c"replace", &[re, text(r, " ")?])?, c"trim", &[])
    })?;
    recover(formatted, r, |r, _| text(r, ""))
}
fn http_response<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let res = a[0];
    if !res.truthy()? {
        return failure(ctx, text(ctx, "no response")?);
    }
    ctx.set(c"res", res)?;
    if !res.get(c"ok")?.truthy()? {
        return then(snippet(res)?, ctx, |ctx, a| {
            let msg = format!("HTTP {}", fold_string(ctx.get(c"res")?.get(c"status")?)?);
            let detail = if a[0].truthy()? {
                call(text(ctx, &msg)?, c"concat", &[text(ctx, " ")?, a[0]])?
            } else {
                text(ctx, &msg)?
            };
            failure(ctx, detail)
        });
    }
    let json = async_result(ctx, || call(res, c"json", &[]))?;
    recover(json, ctx, |ctx, a| {
        ctx.set(c"jsonError", a[0])?;
        then(snippet(ctx.get(c"res")?)?, ctx, |ctx, a| {
            if a[0].truthy()? {
                failure(
                    ctx,
                    call(text(ctx, "invalid JSON response: ")?, c"concat", &[a[0]])?,
                )
            } else {
                let message = fold_string(ctx.get(c"jsonError")?.get(c"message")?)?;
                failure(
                    ctx,
                    text(ctx, &format!("invalid JSON response ({message})"))?,
                )
            }
        })
    })
}
fn read<'a>(
    p: L<'a>,
    timeout: L<'a>,
    request: impl FnOnce(L<'a>) -> Result<L<'a>>,
) -> Result<L<'a>> {
    let g = p.global()?;
    let ctrl = g.get(c"AbortController")?.construct(&[])?;
    let ctx = fields(
        p,
        &[("ports", p), ("controller", ctrl), ("timeout", timeout)],
    )?;
    let timer = call(
        g,
        c"setTimeout",
        &[
            function(ctx, "timeout", 0, 0, |ctx, _| {
                ctx.set(c"timedOut", flag(ctx, true)?)?;
                call(ctx.get(c"controller")?, c"abort", &[])
            })?,
            timeout,
        ],
    )?;
    let response = async_result(ctx, || request(ctrl.get(c"signal")?))?;
    let data = then(response, ctx, http_response)?;
    let data = recover(data, ctx, |ctx, a| {
        if a[0].optional(c"kind")?.is_string(FAIL)? {
            return Err(a[0].throw_error());
        }
        let cause = ctx
            .get(c"ports")?
            .get(c"publicTransportError")?
            .call_plain(&[a[0]])?
            .get(c"message")?;
        let cause = if ctx.get(c"timedOut")?.truthy()? {
            let msg = text(
                ctx,
                &format!("timeout after {}ms: ", fold_string(ctx.get(c"timeout")?)?),
            )?;
            call(msg, c"concat", &[cause])?
        } else {
            cause
        };
        failure(ctx, cause)
    })?;
    call(
        data,
        c"finally",
        &[function(timer, "clearTimeout", 0, 0, |timer, _| {
            call(timer.global()?, c"clearTimeout", &[timer])
        })?],
    )
}
fn normalize<'a>(p: L<'a>, op: &str, body: L<'a>, at: Option<L<'a>>) -> Result<L<'a>> {
    let raw = p.env();
    let body = unsafe { crate::js_bridge::read_value(raw, body.raw(), 0, &mut Vec::new()) }?;
    let mut input = vec![("body".into(), body)];
    if let Some(now) = at {
        input.push(("now".into(), unsafe {
            crate::js_bridge::read_value(raw, now.raw(), 0, &mut Vec::new())
        }?));
    }
    let result = multicc_core::limit_cache_recorder::request(op, &V::Object(input));
    Ok(L::from_raw(raw, unsafe {
        crate::js_bridge::write_value(raw, &result)
    }?))
}
fn vendor<'a>(p: L<'a>, a: &mut [L<'a>], op: &'static str) -> Result<L<'a>> {
    async_result(p, || {
        let t = a[0];
        let timeout = with_default(a[2], num(p, 6000.)?)?;
        let key = t.optional(c"apiKey")?;
        let (url, method, timeout, auth) = match op {
            "pollRelay" => {
                let url = fold_string(call(
                    string(fallback(t.optional(c"relayUrl")?, "".into())?)?,
                    c"trim",
                    &[],
                )?)?;
                let key = fold_string(call(string(fallback(key, "".into())?)?, c"trim", &[])?)?;
                let lower = url.to_ascii_lowercase();
                if !(lower.starts_with("http://") || lower.starts_with("https://"))
                    || key.is_empty()
                {
                    return null(p);
                }
                (
                    format!("{}/quota", url.trim_end_matches('/')),
                    "POST",
                    call(
                        p.global()?.get(c"Math")?,
                        c"max",
                        &[timeout, num(p, 20_000.)?],
                    )?,
                    text(p, &format!("Bearer {key}"))?,
                )
            }
            "pollGlm" => (
                format!(
                    "https://{}/api/monitor/usage/quota/limit",
                    fold_string(t.get(c"host")?)?
                ),
                "GET",
                timeout,
                key,
            ),
            _ => (
                format!("https://{}/user/balance", fold_string(t.get(c"host")?)?),
                "GET",
                timeout,
                text(p, &format!("Bearer {}", fold_string(key)?))?,
            ),
        };
        let headers = fields(p, &[("Authorization", auth)])?;
        if op == "pollGlm" {
            headers.set(c"Content-Type", text(p, "application/json")?)?;
        }
        let data = read(p, timeout, |signal| {
            let options = fields(
                p,
                &[
                    ("method", text(p, method)?),
                    ("headers", headers),
                    ("signal", signal),
                ],
            )?;
            p.get(c"outboundFetch")?
                .call_plain(&[text(p, &url)?, options])
        })?;
        call(
            data,
            c"then",
            &[function(p, "normalizeQuota", 1, 1, move |p, a| {
                let out = normalize(p, op, a[0], None)?;
                if op != "pollRelay" {
                    return Ok(out);
                }
                let e = out.get(c"error")?;
                if !e.equals(null(p)?)? {
                    return failure(p, e);
                }
                out.get(c"dto")
            })?],
        )
    })
}
pub(super) fn glm<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    vendor(p, a, "pollGlm")
}
pub(super) fn deepseek<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    vendor(p, a, "pollDeepseek")
}
pub(super) fn relay<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    vendor(p, a, "pollRelay")
}
fn attempt(ctx: L<'_>) -> Result<L<'_>> {
    let p = ctx.get(c"ports")?;
    let reader = ctx.get(c"reader")?;
    let auth = if reader.truthy()? {
        reader.call_plain(&[])?
    } else {
        let path = ctx.get(c"target")?.optional(c"authFile")?;
        let f = p.get(c"readCodexAuth")?;
        if path.truthy()? {
            f.call_plain(&[path])?
        } else {
            f.call_plain(&[])?
        }
    };
    if !auth.truthy()? {
        return null(ctx);
    }
    let data = read(p, ctx.get(c"timeout")?, |signal| {
        p.get(c"requestCodexUsage")?
            .call_plain(&[auth, fields(p, &[("signal", signal)])?])
    })?;
    then(data, ctx, |ctx, a| {
        let at = ctx.get(c"now")?;
        let at = if at.undefined()? {
            call(ctx.global()?.get(c"Date")?, c"now", &[])?
        } else {
            at
        };
        normalize(ctx, "pollCodex", a[0], Some(at))
    })
}
pub(super) fn codex<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let ctx = fields(
            p,
            &[
                ("ports", p),
                ("target", a[0]),
                ("now", a[1]),
                ("timeout", with_default(a[2], num(p, 6000.)?)?),
                ("reader", a[3]),
            ],
        )?;
        let result = attempt(ctx)?;
        recover(result, ctx, |ctx, a| {
            let err = a[0];
            let detail = string(fallback(err.optional(c"detail")?, "".into())?)?;
            let re = ctx
                .global()?
                .get(c"RegExp")?
                .construct(&[text(ctx, r"HTTP 40[13]\b")?])?;
            if !call(re, c"test", &[detail])?.truthy()? {
                return Err(err.throw_error());
            }
            ctx.set(c"cause", err)?;
            let file = ctx.get(c"target")?.optional(c"authFile")?;
            let input = fields(
                ctx,
                &[("authFile", if file.truthy()? { file } else { null(ctx)? })],
            )?;
            then(auth_refresh(ctx.get(c"ports")?, input)?, ctx, |ctx, a| {
                if !a[0].truthy()? {
                    return Err(ctx.get(c"cause")?.throw_error());
                }
                attempt(ctx)
            })
        })
    })
}
