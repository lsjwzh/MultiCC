use super::*;
fn providers(p: L<'_>) -> Result<L<'_>> {
    let out = array(p)?;
    for (id, address, host, path) in [
        ("cloudflare", "1.1.1.1", "cloudflare-dns.com", "/dns-query"),
        ("google", "8.8.8.8", "dns.google", "/resolve"),
    ] {
        let base = text(p, path)?;
        let path = function(base, "path", 2, 2, |base, args| {
            let name = call(base.global()?, c"encodeURIComponent", &[args[0]])?;
            call(
                base,
                c"concat",
                &[text(base, "?name=")?, name, text(base, "&type=")?, args[1]],
            )
        })?;
        push(
            out,
            fields(
                p,
                &[
                    ("id", text(p, id)?),
                    ("address", text(p, address)?),
                    ("servername", text(p, host)?),
                    ("path", path),
                ],
            )?
            .freeze()?,
        )?;
    }
    out.freeze()
}
fn denied<'a>(p: L<'a>, why: &str) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("verdict", text(p, "indeterminate")?),
            ("reason", text(p, why)?),
        ],
    )
}
fn collect<'a>(p: L<'a>, results: L<'a>) -> Result<L<'a>> {
    let addresses = p.global()?.get(c"Set")?.construct(&[])?;
    let mut successes = 0;
    let mut saw_ip = false;
    let mut nonpublic = false;
    let mut ttl: f64 = 300.;
    for r in items(results)? {
        if !r.truthy()? || !r.get(c"ok")?.truthy()? {
            continue;
        }
        successes += 1;
        let answers = fallback_to(r.get(c"answers")?, array(p)?)?;
        for ans in items(answers)? {
            let typ = ans.get(c"type")?;
            if !typ.is_number(1.)? && !typ.is_number(28.)? {
                continue;
            }
            saw_ip = true;
            let address = call(
                string(fallback_to(ans.get(c"data")?, text(p, "")?)?)?,
                c"trim",
                &[],
            )?;
            if !parse::public(address)? {
                nonpublic = true;
                continue;
            }
            call(addresses, c"add", &[address])?;
            if let Some(v) = ans
                .get(c"TTL")?
                .number_value()?
                .filter(|n| n.is_finite() && *n > 0.)
            {
                ttl = ttl.min(v)
            }
        }
    }
    if successes == 0 {
        return denied(p, "doh_unreachable");
    }
    if nonpublic {
        return denied(p, "non_public_resolution");
    }
    let len = addresses.get(c"size")?.number()?;
    if len == 0. {
        return denied(
            p,
            if saw_ip {
                "no_public_address"
            } else {
                "dns_no_record"
            },
        );
    }
    if len > 8. {
        return denied(p, "too_many_public_addresses");
    }
    fields(
        p,
        &[
            ("verdict", text(p, "ok")?),
            (
                "addresses",
                call(p.global()?.get(c"Array")?, c"from", &[addresses])?,
            ),
            ("ttlSec", num(p, ttl.clamp(30., 300.))?),
        ],
    )
}
pub(super) fn resolve<'a>(p: L<'a>, hostname: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    async_result(p, || {
        let opts = default_object(opts)?;
        let mut list = opts.get(c"providers")?;
        if list.undefined()? {
            list = p.get(c"dohProviders")?;
            if list.undefined()? {
                list = providers(p)?;
                p.set(c"dohProviders", list)?
            }
        }
        let query = opts.get(c"dohRequest")?;
        let calls = array(p)?;
        for provider in items(list)? {
            for typ in ["A", "AAAA"] {
                let o = fields(
                    p,
                    &[
                        ("provider", provider),
                        ("hostname", hostname),
                        ("type", text(p, typ)?),
                    ],
                )?;
                let wait = if query.undefined()? {
                    transport::dns(p, o)?
                } else {
                    query.call_plain(&[o])?
                };
                push(calls, wait)?;
            }
        }
        after(all(p, calls)?, p, collect)
    })
}
