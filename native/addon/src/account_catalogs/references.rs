use super::*;

/// Older records have both a top-level route and per-CLI routes. Retain the
/// first live candidate (including unrecognized fields) when identities merge.
pub(super) fn normalize<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let s = a[0];
    if !s.truthy()? || s.get(c"loginFlow")?.truthy()? {
        return flag(p, false);
    }
    let before = json_call(p, c"stringify", s)?;
    route(s, s.get(c"cli")?, a[1])?;
    for k in [c"claude", c"codex"] {
        route(
            s.get(c"cliStates")?.optional(k)?,
            text(p, k.to_str().unwrap())?,
            a[1],
        )?
    }
    flag(p, !before.equals(json_call(p, c"stringify", s)?)?)
}
fn route<'a>(v: L<'a>, cli: L<'a>, normalize: L<'a>) -> Result<()> {
    if !v.truthy()? || !supported(cli)? {
        return Ok(());
    }
    v.set(
        c"provider",
        normalize.call_plain(&[cli, v.get(c"provider")?])?,
    )?;
    if v.get(c"subagent")?.optional(c"providerId")?.truthy()? {
        let agent = v.get(c"subagent")?;
        agent.set(
            c"providerId",
            normalize.call_plain(&[cli, v.get(c"subagent")?.get(c"providerId")?])?,
        )?
    }
    let candidates = v.get(c"providerSelection")?.optional(c"candidates")?;
    if !candidates.is_array()? {
        return Ok(());
    }
    let seen = map(v)?;
    candidates.for_each(|c| {
        c.set(
            c"providerId",
            normalize.call_plain(&[cli, c.get(c"providerId")?])?,
        )?;
        let key = cat(
            v,
            &[
                c.get(c"providerId")?,
                fallback(c.get(c"model")?, V::string(""))?,
            ],
            ":",
        )?;
        let first = call(seen, c"get", &[key])?;
        if first.truthy()? {
            first.set(
                c"enabled",
                or(first.get(c"enabled")?, || c.get(c"enabled"))?,
            )?
        } else {
            call(seen, c"set", &[key, c])?;
        }
        Ok(())
    })?;
    let known = call(
        v.global()?.get(c"Array")?,
        c"from",
        &[call(seen, c"values", &[])?],
    )?;
    v.get(c"providerSelection")?.set(c"candidates", known)?;
    let enabled = call(
        v.get(c"providerSelection")?.get(c"candidates")?,
        c"filter",
        &[function(v, "enabled", 1, 1, |p, a| {
            flag(p, !a[0].get(c"enabled")?.is_false()?)
        })?],
    )?;
    if seen.get(c"size")?.number()? < candidates.get(c"length")?.number()?
        && enabled.get(c"length")?.is_number(1.)?
    {
        v.set(c"provider", enabled.element(0)?.get(c"providerId")?)?;
        v.set(
            c"model",
            fallback(enabled.element(0)?.get(c"model")?, V::Null)?,
        )?;
        v.set(c"providerSelection", null(v)?)?
    }
    Ok(())
}
