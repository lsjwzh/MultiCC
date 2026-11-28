use super::*;

fn summary<'a>(c: L<'a>, changes: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let empty = text(c, "")?;
    let zero = num(c, 0.)?;
    let no = flag(c, false)?;
    let out = fields(
        c,
        &[
            ("mode", text(c, "tailscale_funnel_public")?),
            ("verdict", text(c, "indeterminate")?),
            ("healthy", no),
            ("repairEligible", no),
            ("error", empty),
            ("httpCode", zero),
            ("originHttpCode", zero),
            ("publicUrl", empty),
            ("resolvedAddressCount", zero),
            ("edgeSuccessCount", zero),
        ],
    )?;
    for (k, v) in changes {
        out.define_key(text(c, k)?, *v)?
    }
    Ok(out)
}
fn clock(o: L<'_>) -> Result<L<'_>> {
    o.get(c"now")?.call_plain(&[])
}
fn edge_results<'a>(c: L<'a>, results: L<'a>) -> Result<L<'a>> {
    let rows = items(results)?;
    let mut healthy = Vec::new();
    for &result in &rows {
        if result.truthy()? && result.get(c"verdict")?.is_string("healthy")? {
            healthy.push(result);
        }
    }
    let count = healthy.len();
    let (verdict, why, http_code, repair) = if let Some(&first) = healthy.first() {
        let (verdict, why) = if count == rows.len() {
            ("healthy", "")
        } else {
            ("degraded", "partial_edge_failure")
        };
        (
            verdict,
            why,
            fallback_to(first.get(c"httpCode")?, num(c, 200.)?)?,
            false,
        )
    } else {
        c.get(c"owner")?.set(c"cache", null(c)?)?;
        let mut down = !rows.is_empty();
        for &result in &rows {
            if !result.truthy()? || !result.get(c"verdict")?.is_string("unhealthy")? {
                down = false;
                break;
            }
            let reason = result.get(c"reason")?;
            if !reason.is_string("edge_tls_unreachable")?
                && !reason.is_string("edge_http_unreachable")?
            {
                down = false;
                break;
            }
        }
        let mut codes = vec![num(c, 0.)?];
        for &result in &rows {
            codes.push(fallback_to(result.optional(c"httpCode")?, num(c, 0.)?)?);
        }
        let (verdict, why) = if down {
            ("unhealthy", "public_data_plane_down")
        } else {
            ("indeterminate", "edge_identity_unverified")
        };
        (
            verdict,
            why,
            call(c.global()?.get(c"Math")?, c"max", &codes)?,
            down,
        )
    };
    summary(
        c,
        &[
            ("verdict", text(c, verdict)?),
            ("healthy", flag(c, verdict == "healthy")?),
            ("repairEligible", flag(c, repair)?),
            ("error", text(c, why)?),
            ("httpCode", http_code),
            ("originHttpCode", c.get(c"originCode")?),
            ("publicUrl", c.get(c"target")?.get(c"publicUrl")?),
            (
                "resolvedAddressCount",
                c.get(c"resolution")?.get(c"addresses")?.get(c"length")?,
            ),
            ("edgeSuccessCount", num(c, count as f64)?),
        ],
    )
}
fn edges<'a>(c: L<'a>, resolution: L<'a>) -> Result<L<'a>> {
    let o = c.get(c"owner")?;
    let target = c.get(c"target")?;
    if !resolution.get(c"verdict")?.is_string("ok")? {
        return summary(
            c,
            &[
                ("error", resolution.get(c"reason")?),
                ("originHttpCode", c.get(c"originCode")?),
                ("publicUrl", target.get(c"publicUrl")?),
            ],
        );
    }
    c.set(c"resolution", resolution)?;
    let calls = array(c)?;
    let injected = o.get(c"edgeRequest")?;
    for address in items(resolution.get(c"addresses")?)? {
        let path = c.get(c"path")?;
        let id = c.get(c"id")?;
        let r = if injected.undefined()? {
            transport::health(
                o.get(c"ports")?,
                fields(
                    c,
                    &[
                        ("protocol", text(c, "https:")?),
                        ("address", address),
                        ("hostname", target.get(c"hostname")?),
                        ("port", target.get(c"publicPort")?),
                        ("path", path),
                        ("requestId", id),
                    ],
                )?,
            )?
        } else {
            injected.call_plain(&[fields(
                c,
                &[
                    ("address", address),
                    ("target", target),
                    ("path", path),
                    ("requestId", id),
                ],
            )?])?
        };
        push(calls, r)?;
    }
    after(all(c, calls)?, c, edge_results)
}
fn mapped<'a>(c: L<'a>, parsed: L<'a>) -> Result<L<'a>> {
    let code = c.get(c"originCode")?;
    if parsed.nullish()? {
        return summary(
            c,
            &[
                ("error", text(c, "funnel_status_unavailable")?),
                ("originHttpCode", code),
            ],
        );
    }
    if !parsed.get(c"ok")?.truthy()? {
        return summary(
            c,
            &[("error", parsed.get(c"reason")?), ("originHttpCode", code)],
        );
    }
    let target = parsed.get(c"target")?;
    c.set(c"target", target)?;
    let o = c.get(c"owner")?;
    let host = target.get(c"hostname")?;
    let cache = o.get(c"cache")?;
    if cache.truthy()?
        && cache.get(c"hostname")?.equals(host)?
        && cache.get(c"expiresAt")?.number()? > clock(o)?.number()?
    {
        return edges(
            c,
            fields(
                c,
                &[
                    ("verdict", text(c, "ok")?),
                    ("addresses", cache.get(c"addresses")?),
                    ("ttlSec", cache.get(c"ttlSec")?),
                ],
            )?,
        );
    }
    let resolution = resolve::resolve(
        o.get(c"ports")?,
        host,
        fields(c, &[("dohRequest", o.get(c"dohRequest")?)])?,
    )?;
    after(resolution, c, |c, r| {
        if r.get(c"verdict")?.is_string("ok")? {
            let o = c.get(c"owner")?;
            let ttl = r.get(c"ttlSec")?;
            o.set(
                c"cache",
                fields(
                    c,
                    &[
                        ("hostname", c.get(c"target")?.get(c"hostname")?),
                        ("addresses", r.get(c"addresses")?),
                        ("ttlSec", ttl),
                        (
                            "expiresAt",
                            num(c, clock(o)?.number()? + ttl.number()? * 1000.)?,
                        ),
                    ],
                )?,
            )?;
        }
        edges(c, r)
    })
}
fn origin<'a>(c: L<'a>, r: L<'a>) -> Result<L<'a>> {
    if !r.truthy()? || !r.get(c"verdict")?.is_string("healthy")? {
        return summary(
            c,
            &[
                ("verdict", text(c, "unhealthy")?),
                ("error", text(c, "local_origin_down")?),
                (
                    "originHttpCode",
                    fallback_to(r.optional(c"httpCode")?, num(c, 0.)?)?,
                ),
            ],
        );
    }
    c.set(c"originCode", r.get(c"httpCode")?)?;
    after(command(c, true, false)?, c, mapped)
}
fn online<'a>(c: L<'a>, parsed: L<'a>) -> Result<L<'a>> {
    if parsed.nullish()? {
        return summary(c, &[("error", text(c, "tailscale_status_unavailable")?)]);
    }
    if !parsed.get(c"ok")?.truthy()? {
        return summary(c, &[("error", parsed.get(c"reason")?)]);
    }
    let o = c.get(c"owner")?;
    let p = o.get(c"ports")?;
    let nonce = o.get(c"nonce")?;
    let id = if nonce.undefined()? {
        call(
            call(p.get(c"crypto")?, c"randomBytes", &[num(c, 8.)?])?,
            c"toString",
            &[text(c, "hex")?],
        )?
    } else {
        nonce.call_plain(&[])?
    };
    let path = call(text(c, "/healthz?probe=")?, c"concat", &[id])?;
    c.set(c"id", id)?;
    c.set(c"path", path)?;
    let port = c.get(c"port")?;
    let injected = o.get(c"originRequest")?;
    let pending = if injected.undefined()? {
        transport::health(
            p,
            fields(
                c,
                &[
                    ("protocol", text(c, "http:")?),
                    ("address", text(c, "127.0.0.1")?),
                    (
                        "hostname",
                        call(text(c, "127.0.0.1:")?, c"concat", &[port])?,
                    ),
                    ("port", port),
                    ("path", path),
                    ("requestId", id),
                ],
            )?,
        )?
    } else {
        injected.call_plain(&[fields(
            c,
            &[("port", port), ("path", path), ("requestId", id)],
        )?])?
    };
    after(pending, c, origin)
}
fn command(c: L<'_>, funnel: bool, retry: bool) -> Result<L<'_>> {
    let args: &[&str] = match (funnel, retry) {
        (false, false) => &["status", "--json", "--peers=false"],
        (false, true) => &["status", "--json"],
        (true, false) => &["funnel", "status", "--json"],
        (true, true) => &["serve", "status", "--json"],
    };
    let o = c.get(c"owner")?;
    let result = o
        .get(c"run")?
        .call_plain(&[o.get(c"tailscaleBin")?, strings(c, args)?])?;
    after(result, c, move |c, r| {
        let parsed = if r.get(c"ok")?.truthy()? {
            let raw = r.get(c"stdout")?;
            if funnel {
                parse::funnel(c, raw, c.get(c"port")?)?
            } else {
                parse::control(c, raw)?
            }
        } else {
            null(c)?
        };
        if !retry
            && (!parsed.truthy()?
                || fold_string(fallback_to(parsed.optional(c"reason")?, text(c, "")?)?)?
                    .ends_with("_malformed"))
        {
            return command(c, funnel, true);
        }
        Ok(parsed)
    })
}
pub(crate) fn owner<'a>(p: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let opts = default_object(options)?;
    let o = pick(
        opts,
        &[
            c"run",
            c"tailscaleBin",
            c"dohRequest",
            c"originRequest",
            c"edgeRequest",
            c"now",
            c"nonce",
        ],
    )?;
    if !callable(o.get(c"run")?)? {
        return Err(p.type_error("createTailscaleFunnelProbe requires run()"));
    }
    o.set(
        c"now",
        default_to(o.get(c"now")?, p.global()?.get(c"Date")?.get(c"now")?)?,
    )?;
    o.set(c"ports", p)?;
    o.set(c"cache", null(o)?)?;
    Ok(o)
}
pub(crate) fn run<'a>(o: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    async_result(o, || {
        let c = fields(o, &[("owner", o), ("port", opts.get(c"originPort")?)])?;
        after(command(c, false, false)?, c, online)
    })
}
pub(crate) fn clear(o: L<'_>) -> Result<L<'_>> {
    o.set(c"cache", null(o)?)?;
    undef(o)
}
pub(super) fn create<'a>(p: L<'a>, options: L<'a>) -> Result<L<'a>> {
    methods(
        owner(p, options)?,
        &[
            ("probe", 1, |o, a| run(o, a[0])),
            ("clearCache", 0, |o, _| clear(o)),
        ],
    )
}
