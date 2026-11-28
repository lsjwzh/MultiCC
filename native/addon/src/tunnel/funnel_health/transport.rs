use super::*;
fn listen<'a>(emitter: L<'a>, event: &str, cb: L<'a>) -> Result<()> {
    call(emitter, c"on", &[text(emitter, event)?, cb])?;
    Ok(())
}
fn health_bad(c: L<'_>) -> Result<L<'_>> {
    status(
        c,
        "indeterminate",
        "health_response_invalid",
        fallback_to(c.get(c"response")?.get(c"statusCode")?, num(c, 0.)?)?,
    )
}
fn transfer<'a>(c: L<'a>, res: L<'a>, doh: bool) -> Result<L<'a>> {
    if doh && !res.get(c"statusCode")?.is_number(200.)? {
        call(res, c"resume", &[])?;
        return settle(c, failed(c, "doh_http_error")?);
    }
    c.set(c"response", res)?;
    c.set(c"chunks", array(c)?)?;
    c.set(c"received", num(c, 0.)?)?;
    listen(
        res,
        "data",
        function(c, "", 1, 1, move |c, a| {
            let size = c.get(c"received")?.number()? + a[0].get(c"length")?.number()?;
            c.set(c"received", num(c, size)?)?;
            if size > (if doh { DNS_LIMIT } else { HEALTH_LIMIT }) as f64 {
                call(c.get(c"response")?, c"destroy", &[])?;
                return settle(
                    c,
                    if doh {
                        failed(c, "doh_malformed")?
                    } else {
                        health_bad(c)?
                    },
                );
            }
            push(c.get(c"chunks")?, a[0])?;
            undef(c)
        })?,
    )?;
    listen(
        res,
        "end",
        function(c, "", 0, 0, move |c, _| {
            let bytes = call(c.global()?.get(c"Buffer")?, c"concat", &[c.get(c"chunks")?])?;
            let body = call(bytes, c"toString", &[text(c, "utf8")?])?;
            let result = if doh {
                let data = bounded(c, body, DNS_LIMIT)?;
                if !data.truthy()?
                    || !data.get(c"Status")?.is_number(0.)?
                    || !data.get(c"Answer")?.is_array()?
                {
                    failed(c, "doh_malformed")?
                } else {
                    fields(
                        c,
                        &[("ok", flag(c, true)?), ("answers", data.get(c"Answer")?)],
                    )?
                }
            } else {
                let res = c.get(c"response")?;
                let code = fallback_to(res.get(c"statusCode")?, num(c, 0.)?)?;
                if parse::valid(c, code, res.get(c"headers")?, body, c.get(c"id")?)? {
                    status(c, "healthy", "", code)?
                } else {
                    health_bad(c)?
                }
            };
            settle(c, result)
        })?,
    )?;
    listen(
        res,
        "error",
        function(c, "", 0, 0, move |c, _| {
            settle(
                c,
                if doh {
                    failed(c, "doh_malformed")?
                } else {
                    health_bad(c)?
                },
            )
        })?,
    )?;
    undef(c)
}
fn unreachable(c: L<'_>) -> Result<L<'_>> {
    status(
        c,
        "unhealthy",
        if c.get(c"secure")?.truthy()? {
            "edge_http_unreachable"
        } else {
            "edge_tls_unreachable"
        },
        num(c, 0.)?,
    )
}
fn certificate(code: &str) -> bool {
    let key = code.to_ascii_uppercase();
    [
        "CERT",
        "HOSTNAME",
        "SELF_SIGNED",
        "UNABLE_TO_VERIFY",
        "INVALID_CA",
        "CRL_",
    ]
    .iter()
    .any(|part| key.contains(part))
}
fn is_transport(code: &str) -> bool {
    matches!(
        code,
        "ECONNRESET"
            | "ECONNREFUSED"
            | "ECONNABORTED"
            | "ETIMEDOUT"
            | "ESOCKETTIMEDOUT"
            | "EHOSTUNREACH"
            | "EHOSTDOWN"
            | "ENETUNREACH"
            | "ENETDOWN"
            | "ENETRESET"
            | "EPIPE"
    )
}
fn request<'a>(
    p: L<'a>,
    module: L<'a>,
    options: L<'a>,
    id: L<'a>,
    tls: bool,
    doh: bool,
) -> Result<L<'a>> {
    let c = fields(
        p,
        &[
            ("module", module),
            ("opts", options),
            ("secure", flag(p, !tls)?),
            ("id", id),
        ],
    )?;
    p.global()?
        .get(c"Promise")?
        .construct(&[function(c, "", 2, 2, move |c, a| {
            c.set(c"resolve", a[0])?;
            let response = function(c, "", 1, 1, move |c, a| transfer(c, a[0], doh))?;
            let req = call(c.get(c"module")?, c"get", &[c.get(c"opts")?, response])?;
            c.set(c"request", req)?;
            if !doh {
                listen(
                    req,
                    "socket",
                    function(c, "", 1, 1, move |c, a| {
                        if tls {
                            call(
                                a[0],
                                c"once",
                                &[
                                    text(c, "secureConnect")?,
                                    function(c, "", 0, 0, |c, _| {
                                        c.set(c"secure", flag(c, true)?)?;
                                        undef(c)
                                    })?,
                                ],
                            )?;
                        }
                        undef(c)
                    })?,
                )?;
            }
            listen(
                req,
                "timeout",
                function(c, "", 0, 0, move |c, _| {
                    settle(
                        c,
                        if doh {
                            failed(c, "doh_unreachable")?
                        } else {
                            unreachable(c)?
                        },
                    )?;
                    call(c.get(c"request")?, c"destroy", &[])
                })?,
            )?;
            listen(
                req,
                "error",
                function(c, "", 1, 1, move |c, a| {
                    if doh {
                        return settle(c, failed(c, "doh_unreachable")?);
                    }
                    let code = fold_string(fallback_to(a[0].optional(c"code")?, text(c, "")?)?)?;
                    let result = if certificate(&code) {
                        status(c, "indeterminate", "certificate_invalid", num(c, 0.)?)?
                    } else if is_transport(&code) {
                        unreachable(c)?
                    } else {
                        status(c, "indeterminate", "edge_error_unclassified", num(c, 0.)?)?
                    };
                    settle(c, result)
                })?,
            )?;
            undef(c)
        })?])
}
pub(super) fn health<'a>(p: L<'a>, o: L<'a>) -> Result<L<'a>> {
    let tls = o.get(c"protocol")?.is_string("https:")?;
    let name = o.get(c"hostname")?;
    let id = default_to(o.get(c"requestId")?, text(p, "")?)?;
    let headers = fields(
        p,
        &[
            ("Host", name),
            ("Accept", text(p, "application/json")?),
            ("Cache-Control", text(p, "no-cache")?),
        ],
    )?;
    if id.truthy()? {
        headers.set(c"X-Request-ID", id)?
    };
    let opts = fields(
        p,
        &[
            ("hostname", o.get(c"address")?),
            ("port", o.get(c"port")?),
            ("path", o.get(c"path")?),
            ("method", text(p, "GET")?),
            ("headers", headers),
            ("agent", flag(p, false)?),
            (
                "timeout",
                default_to(o.get(c"timeoutMs")?, num(p, TIMEOUT)?)?,
            ),
        ],
    )?;
    if tls {
        opts.set(c"servername", name)?;
        opts.set(c"rejectUnauthorized", flag(p, true)?)?
    }
    request(
        p,
        p.get(if tls { c"https" } else { c"http" })?,
        opts,
        id,
        tls,
        false,
    )
}
pub(super) fn dns<'a>(p: L<'a>, o: L<'a>) -> Result<L<'a>> {
    async_result(p, || {
        let provider = o.get(c"provider")?;
        let name = provider.get(c"servername")?;
        let opts = fields(
            p,
            &[
                ("hostname", provider.get(c"address")?),
                ("port", num(p, 443.)?),
                ("servername", name),
                (
                    "path",
                    call(provider, c"path", &[o.get(c"hostname")?, o.get(c"type")?])?,
                ),
                ("method", text(p, "GET")?),
                (
                    "headers",
                    fields(
                        p,
                        &[("Host", name), ("Accept", text(p, "application/dns-json")?)],
                    )?,
                ),
                ("rejectUnauthorized", flag(p, true)?),
                ("agent", flag(p, false)?),
                (
                    "timeout",
                    default_to(o.get(c"timeoutMs")?, num(p, TIMEOUT)?)?,
                ),
            ],
        )?;
        request(p, p.get(c"https")?, opts, undef(p)?, true, true)
    })
}
