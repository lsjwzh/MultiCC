//! A resident child pins exactly the physical home its route was baked into.
//! Retirement is driven by session changes. Reclamation is driven by close.
use crate::{
    codex_provider_home::{assert_codex_proxy_config_applied, codex_proxy_config_required},
    host_methods::{arg, default_object, env, function},
    route_response::*,
};
use napi_derive::napi;

fn clean(v: L<'_>) -> Result<L<'_>> {
    if v.nullish()? {
        text(v, "")
    } else {
        call(string(v)?, c"trim", &[])
    }
}
fn noop(p: L<'_>) -> Result<L<'_>> {
    function(p, "", 0, 0, |p, _| p.from_value(&V::Undefined))
}
fn reclaim<'a>(s: L<'a>, entry: L<'a>) -> Result<()> {
    if !entry.get(c"retired")?.truthy()? || entry.get(c"readers")?.truthy()? {
        return Ok(());
    }
    let holder = entry.get(c"holder")?;
    call(s.get(c"retired")?, c"delete", &[entry])?;
    call(s.get(c"entries")?, c"delete", &[holder.get(c"CODEX_HOME")?])?;
    if let Err(failure) = call(s.get(c"providers")?, c"releaseCodexProxyConfig", &[holder]) {
        let code = if let Some(e) = s.exception_value()? {
            fallback(e.optional(c"code")?, V::Null)?
        } else {
            let _ = failure;
            null(s)?
        };
        call(s.get(c"logger")?,c"warn",&[text(s,"[multicc/codex-resident] failed to scrub a private Codex home; orphan retained")?,fields(s,&[("code",code)])?])?;
    }
    Ok(())
}
fn retire<'a>(s: L<'a>, entry: L<'a>) -> Result<()> {
    entry.set(c"retired", flag(s, true)?)?;
    call(s.get(c"retired")?, c"add", &[entry])?;
    reclaim(s, entry)
}
fn retain<'a>(s: L<'a>, home: L<'a>) -> Result<L<'a>> {
    let entry = call(s.get(c"entries")?, c"get", &[home])?;
    if !entry.truthy()? {
        return noop(s);
    }
    entry.set(c"readers", num(s, entry.get(c"readers")?.number()? + 1.)?)?;
    let pin = fields(
        s,
        &[
            ("state", s),
            ("entry", entry),
            ("released", flag(s, false)?),
        ],
    )?;
    function(pin, "", 0, 0, |pin, _| {
        if !pin.get(c"released")?.truthy()? {
            pin.set(c"released", flag(pin, true)?)?;
            let entry = pin.get(c"entry")?;
            entry.set(c"readers", num(pin, entry.get(c"readers")?.number()? - 1.)?)?;
            reclaim(pin.get(c"state")?, entry)?;
        }
        pin.from_value(&V::Undefined)
    })
}
fn release<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let id = clean(id)?;
    let homes = s.get(c"homes")?;
    let entry = call(homes, c"get", &[id])?;
    if !entry.truthy()? {
        return flag(s, false);
    }
    call(homes, c"delete", &[id])?;
    retire(s, entry)?;
    flag(s, true)
}
fn codex<'a>(s: L<'a>, child: L<'a>, o: L<'a>) -> Result<L<'a>> {
    let id = clean(o.get(c"logicalSessionId")?)?;
    let capability = clean(o.get(c"sessionId")?)?;
    if !id.truthy()? || !capability.truthy()? {
        return flag(s, false);
    }
    let model = clean(o.get(c"inheritModel")?)?;
    let homes = s.get(c"homes")?;
    let mut entry = call(homes, c"get", &[id])?;
    if entry.truthy()?
        && (!entry.get(c"capability")?.equals(capability)?
            || !entry.get(c"model")?.equals(model)?
            || !s
                .get(c"exists")?
                .call_plain(&[entry.get(c"holder")?.get(c"CODEX_HOME")?])?
                .truthy()?)
    {
        call(homes, c"delete", &[id])?;
        retire(s, entry)?;
        entry = null(s)?;
    }
    let providers = s.get(c"providers")?;
    if !entry.truthy()? {
        let holder = fields(
            s,
            &[(
                "CODEX_HOME",
                string(fallback(child.get(c"CODEX_HOME")?, "".into())?)?,
            )],
        )?;
        if !call(providers, c"applyCodexProxyConfig", &[holder, o])?.truthy()? {
            return flag(s, false);
        }
        entry = fields(
            s,
            &[
                ("capability", capability),
                ("model", model),
                ("holder", holder),
                ("readers", num(s, 0.)?),
                ("retired", flag(s, false)?),
            ],
        )?;
        call(homes, c"set", &[id, entry])?;
        call(
            s.get(c"entries")?,
            c"set",
            &[holder.get(c"CODEX_HOME")?, entry],
        )?;
    }
    let holder = entry.get(c"holder")?;
    let apply = providers.get(c"applyCodexLeaseEnv")?;
    if !apply.nullish()? {
        apply.call(providers, &[child, holder])?;
    }
    child.assign(c"CODEX_HOME", holder.get(c"CODEX_HOME")?)?;
    flag(s, true)
}
fn prepare<'a>(s: L<'a>, child: L<'a>, o: L<'a>) -> Result<L<'a>> {
    if child.kind()? != sys::ValueType::napi_object {
        return flag(s, false);
    }
    let cli = o.get(c"cli")?;
    let cli_text = clean(cli)?.coerce_string()?.to_string_lossy();
    let family = multicc_core::cli_capability::protocol_family_of(&cli_text, true);
    if family.is_none() && cli.truthy()? {
        return flag(s, false);
    }
    if family != Some("openai_responses") {
        let opts = fields(s, &[])?;
        for k in [
            c"providerId",
            c"sessionId",
            c"subagent",
            c"port",
            c"officialOAuth",
        ] {
            opts.set(k, o.get(k)?)?;
        }
        call(s.get(c"providers")?, c"applyClaudeProxyEnv", &[child, opts])?;
        return flag(s, true);
    }
    let applied = codex(s, child, o)?;
    let sub = o.get(c"subagent")?;
    let opts = fields(
        s,
        &[
            ("providerId", o.get(c"providerId")?),
            (
                "subagentProviderId",
                if sub.truthy()? {
                    sub.get(c"providerId")?
                } else {
                    sub
                },
            ),
        ],
    )?;
    let required = codex_proxy_config_required(env(s), arg(opts)?)?;
    assert_codex_proxy_config_applied(
        env(s),
        arg(fields(
            s,
            &[("required", flag(s, required)?), ("applied", applied)],
        )?)?,
    )?;
    Ok(applied)
}
fn create<'a>(ports: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let o = default_object(options)?;
    let providers = o.get(c"providers")?;
    let logger = o.get(c"logger")?;
    for method in [
        c"applyCodexProxyConfig",
        c"releaseCodexProxyConfig",
        c"applyClaudeProxyEnv",
    ] {
        if !providers.truthy()? || providers.get(method)?.kind()? != sys::ValueType::napi_function {
            return Err(ports.type_error("[resident-route] a provider port is required"));
        }
    }
    let g = ports.global()?;
    let map = g.get(c"Map")?;
    let s = fields(
        ports,
        &[
            ("homes", map.construct(&[])?),
            ("entries", map.construct(&[])?),
            ("retired", g.get(c"Set")?.construct(&[])?),
            ("providers", providers),
            ("exists", ports.get(c"exists")?),
            (
                "logger",
                if logger.undefined()? {
                    g.get(c"console")?
                } else {
                    logger
                },
            ),
        ],
    )?;
    fields(
        s,
        &[
            (
                "prepare",
                function(s, "prepare", 1, 2, |s, a| {
                    prepare(s, a[0], default_object(a[1])?)
                })?,
            ),
            (
                "prepareCodex",
                function(s, "prepareCodex", 1, 2, |s, a| {
                    codex(s, a[0], default_object(a[1])?)
                })?,
            ),
            (
                "release",
                function(s, "release", 1, 1, |s, a| release(s, a[0]))?,
            ),
            (
                "retain",
                function(s, "retain", 1, 1, |s, a| retain(s, a[0]))?,
            ),
            (
                "stats",
                function(s, "stats", 0, 0, |s, _| {
                    fields(
                        s,
                        &[
                            ("live", s.get(c"homes")?.get(c"size")?),
                            ("retired", s.get(c"retired")?.get(c"size")?),
                        ],
                    )?
                    .freeze()
                })?,
            ),
        ],
    )?
    .freeze()
}
#[napi]
pub fn resident_provider_routes_api(e: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&e, ports);
    p.set(c"shared", null(p)?)?;
    Ok(fields(
        p,
        &[
            (
                "createCodexResidentRoutes",
                function(p, "createCodexResidentRoutes", 0, 1, |p, a| create(p, a[0]))?,
            ),
            (
                "prepareResidentChildEnv",
                function(p, "prepareResidentChildEnv", 2, 2, |p, a| {
                    let mut shared = p.get(c"shared")?;
                    if shared.nullish()? {
                        shared = create(
                            p,
                            fields(p, &[("providers", p.get(c"providers")?.call_plain(&[])?)])?,
                        )?;
                        p.set(c"shared", shared)?;
                    }
                    call(shared, c"prepare", a)
                })?,
            ),
            (
                "releaseResidentRoute",
                function(p, "releaseResidentRoute", 1, 1, |p, a| {
                    let s = p.get(c"shared")?;
                    if s.nullish()? {
                        flag(p, false)
                    } else {
                        call(s, c"release", a)
                    }
                })?,
            ),
            (
                "retainResidentRoute",
                function(p, "retainResidentRoute", 1, 1, |p, a| {
                    let s = p.get(c"shared")?;
                    if s.nullish()? {
                        noop(p)
                    } else {
                        call(s, c"retain", a)
                    }
                })?,
            ),
        ],
    )?
    .raw())
}
