//! Read-only host interface and netcheck observations used by the tunnel UI.
use super::*;
fn addresses(s: L<'_>) -> Result<L<'_>> {
    let out = array(s, &[])?;
    let interfaces = call(s.get(c"os")?, c"networkInterfaces", &[])?;
    let entries = call(s.global()?.get(c"Object")?, c"entries", &[interfaces])?;
    entries.for_each(|entry| {
        let iface = entry.element(0)?;
        let list = entry.element(1)?;
        if list.truthy()? {
            list.for_each(|item| {
                let family = item.get(c"family")?;
                if (!family.is_string("IPv6")? && !family.is_number(6.)?)
                    || item.get(c"internal")?.truthy()?
                {
                    return Ok(());
                }
                let addr = item.get(c"address")?;
                let ip = label(call(fallback(addr, "".into())?, c"toLowerCase", &[])?)?;
                if ip.is_empty()
                    || ip == "::1"
                    || ip.starts_with("fe80")
                    || ip.starts_with("fc")
                    || ip.starts_with("fd")
                {
                    return Ok(());
                }
                call(
                    out,
                    c"push",
                    &[fields(s, &[("iface", iface), ("address", addr)])?],
                )?;
                Ok(())
            })?
        }
        Ok(())
    })?;
    Ok(out)
}
fn captures<'a>(input: L<'a>, pattern: &str) -> Result<L<'a>> {
    let regex = input
        .global()?
        .get(c"RegExp")?
        .construct(&[text(input, pattern)?, text(input, "i")?])?;
    call(regex, c"exec", &[input])
}
pub(super) fn status(s: L<'_>) -> Result<L<'_>> {
    let addresses = addresses(s)?;
    let host_v6 = flag(s, addresses.get(c"length")?.positive()?)?;
    let host = fields(s, &[("hasGlobalV6", host_v6), ("addresses", addresses)])?;
    let available = call(s.get(c"fs")?, c"existsSync", &[text(s, TAILSCALE)?])?;
    let tailscale = fields(
        s,
        &[
            ("available", available),
            ("ipv6", null(s)?),
            ("detail", text(s, "")?),
            ("nearestDerp", text(s, "")?),
        ],
    )?;
    let state = fields(
        s,
        &[
            ("host", host),
            ("tailscale", tailscale),
            ("directReady", flag(s, false)?),
        ],
    )?;
    if !available.truthy()? {
        state.set(c"directReady", host_v6)?;
        return Ok(state);
    }
    let result = run(s, undefined(s)?, TAILSCALE, &["netcheck"])?;
    after(state, result, |state, r| {
        let ts = state.get(c"tailscale")?;
        let stdout = fallback(r.get(c"stdout")?, "".into())?;
        let combined = call(
            string(stdout)?,
            c"concat",
            &[text(state, "\n")?, fallback(r.get(c"stderr")?, "".into())?],
        )?;
        let v6 = captures(combined, r"IPv6:\s*(yes|no)([^\n]*)")?;
        if !v6.nullish()? {
            let value = v6.element(1)?;
            ts.set(
                c"ipv6",
                flag(state, label(value)?.eq_ignore_ascii_case("yes"))?,
            )?;
            let detail = call(value, c"concat", &[v6.element(2)?])?;
            ts.set(c"detail", call(detail, c"trim", &[])?)?;
        }
        let derp = captures(combined, r"Nearest DERP:\s*([^\n]+)")?;
        if !derp.nullish()? {
            ts.set(c"nearestDerp", call(derp.element(1)?, c"trim", &[])?)?
        }
        state.set(
            c"directReady",
            flag(
                state,
                state.get(c"host")?.get(c"hasGlobalV6")?.is_true()?
                    && ts.get(c"ipv6")?.is_true()?,
            )?,
        )?;
        Ok(state)
    })
}
