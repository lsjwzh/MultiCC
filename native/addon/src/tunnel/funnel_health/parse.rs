use super::*;
use multicc_core::js::js_trim;
use std::net::{IpAddr, Ipv6Addr};
pub(super) fn public(v: L<'_>) -> Result<bool> {
    let Some(value) = v.string()? else {
        return Ok(false);
    };
    let input = value.to_string_lossy();
    // Node net.isIP accepts a scoped IPv6 literal; the scope does not change its prefix.
    let ip = if let Some((raw, scope)) = input.split_once('%') {
        if scope.is_empty()
            || !scope
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b':' | b'-'))
        {
            return Ok(false);
        }
        raw.parse::<Ipv6Addr>().ok().map(IpAddr::V6)
    } else {
        input.parse::<IpAddr>().ok()
    };
    Ok(match ip {
        Some(IpAddr::V4(v)) => {
            let [a, b, c, _] = v.octets();
            !(matches!(a, 0 | 10 | 127 | 224..=255)
                || a == 100 && (64..128).contains(&b)
                || a == 169 && b == 254
                || a == 172 && (16..32).contains(&b)
                || a == 192 && (b == 168 || b == 0 && matches!(c, 0 | 2) || b == 88 && c == 99)
                || a == 198 && (matches!(b, 18 | 19) || b == 51 && c == 100)
                || a == 203 && b == 0 && c == 113)
        }
        Some(IpAddr::V6(v)) => {
            let [first, second, ..] = v.segments();
            (0x2000..0x4000).contains(&first)
                && !(first == 0x2001 && (second < 0x200 || second == 0xdb8)
                    || first == 0x2002
                    || first == 0x3fff && second < 0x1000)
        }
        None => false,
    })
}
pub(super) fn control<'a>(p: L<'a>, raw: L<'a>) -> Result<L<'a>> {
    let v = bounded(p, raw, STATUS_LIMIT)?;
    if !v.truthy()? {
        return failed(p, "tailscale_status_malformed");
    }
    if !v.get(c"BackendState")?.is_string("Running")?
        || !v.get(c"Self")?.optional(c"Online")?.is_true()?
    {
        return failed(p, "tailscale_offline");
    }
    fields(p, &[("ok", flag(p, true)?)])
}
fn hostname(raw: L<'_>) -> Result<String> {
    let s = fold_string(fallback_to(raw, text(raw, "")?)?)?;
    let s = js_trim(&s);
    Ok(s.strip_suffix('.').unwrap_or(s).to_lowercase())
}
fn valid_host(s: &str) -> bool {
    let Some(prefix) = s.strip_suffix(".ts.net") else {
        return false;
    };
    s.len() <= 253
        && !s.contains("..")
        && prefix
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && prefix
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}
fn loopback<'a>(p: L<'a>, proxy: L<'a>, port: L<'a>) -> Result<bool> {
    Ok(p.catch(|| {
        let u = p.global()?.get(c"URL")?.construct(&[proxy])?;
        if !u.get(c"protocol")?.is_string("http:")?
            || u.get(c"username")?.truthy()?
            || u.get(c"password")?.truthy()?
        {
            return Ok(false);
        }
        let h = hostname(u.get(c"hostname")?)?;
        let h = h.trim_matches(['[', ']']);
        let got = fallback_to(u.get(c"port")?, num(p, 80.)?)?.number()?;
        Ok(matches!(h, "127.0.0.1" | "localhost" | "::1") && port.is_number(got)?)
    })?
    .unwrap_or(false))
}
pub(super) fn funnel<'a>(p: L<'a>, raw: L<'a>, origin: L<'a>) -> Result<L<'a>> {
    let v = bounded(p, raw, STATUS_LIMIT)?;
    if !v.truthy()? {
        return failed(p, "funnel_status_malformed");
    }
    let obj = |k: &CStr| {
        let x = v.get(k)?;
        if object(x)? {
            Ok(x)
        } else {
            fields(p, &[])
        }
    };
    let web = obj(c"Web")?;
    let allow = obj(c"AllowFunnel")?;
    let tcp = obj(c"TCP")?;
    for auth in items(call(keys(web)?, c"sort", &[])?)? {
        let Some(url) = p.catch(|| {
            p.global()?
                .get(c"URL")?
                .construct(&[call(text(p, "https://")?, c"concat", &[auth])?])
        })?
        else {
            continue;
        };
        let h = hostname(url.get(c"hostname")?)?;
        let port = fallback_to(url.get(c"port")?, num(p, 443.)?)?.number()?;
        if !valid_host(&h)
            || port != 443.
            || !allow.get_key(auth)?.is_true()?
            || !tcp.get(c"443")?.optional(c"HTTPS")?.is_true()?
        {
            continue;
        }
        let root = web.get_key(auth)?.optional(c"Handlers")?.optional(c"/")?;
        if !root.truthy()? || !loopback(p, root.get(c"Proxy")?, origin)? {
            continue;
        }
        let target = fields(
            p,
            &[
                ("hostname", text(p, &h)?),
                ("publicPort", num(p, port)?),
                ("originPort", origin),
                ("publicUrl", text(p, &format!("https://{h}/"))?),
            ],
        )?
        .freeze()?;
        return fields(p, &[("ok", flag(p, true)?), ("target", target)]);
    }
    failed(p, "funnel_mapping_missing")
}
pub(super) fn valid<'a>(
    p: L<'a>,
    code: L<'a>,
    headers: L<'a>,
    body: L<'a>,
    expect: L<'a>,
) -> Result<bool> {
    if !code.is_number(200.)? {
        return Ok(false);
    }
    let cache = fold_string(fallback_to(
        headers.optional(c"cache-control")?,
        text(p, "")?,
    )?)?
    .to_lowercase();
    if !cache
        .split(',')
        .any(|v| js_trim(v).split('=').next() == Some("no-store"))
    {
        return Ok(false);
    }
    let data = bounded(p, body, HEALTH_LIMIT)?;
    if !data.truthy()? || !data.get(c"status")?.is_string("ok")? {
        return Ok(false);
    }
    let up = data.get(c"uptimeSeconds")?.number_value()?;
    if !up.is_some_and(|n| n.is_finite() && n >= 0. && n.fract() == 0.) {
        return Ok(false);
    }
    let id = data.get(c"requestId")?;
    Ok(id.string()?.is_some_and(|s| s.len() > 0 && s.len() <= 256)
        && (!expect.truthy()? || id.equals(expect)?))
}
