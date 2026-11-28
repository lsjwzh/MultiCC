use crate::{host_methods::function, route_response::*};
use napi_derive::napi;

fn allowlist(list: L<'_>) -> Result<L<'_>> {
    let result = list.global()?.get(c"Set")?.construct(&[])?;
    if list.is_array()? {
        list.for_each(|v| {
            if !v.nullish()? {
                let ip = call(string(v)?, c"trim", &[])?;
                if ip.truthy()? {
                    call(result, c"add", &[ip])?;
                }
            }
            Ok(())
        })?;
    }
    Ok(result)
}
fn check<'a>(ports: L<'a>, provider: L<'a>) -> Result<L<'a>> {
    let allowed = allowlist(provider.optional(c"egressIpAllowlist")?)?;
    let mut code = None;
    let mut detail = String::new();
    if allowed.get(c"size")?.number()? > 0. {
        call(ports, c"ensureMonitorStarted", &[])?;
        let cache = call(ports, c"getCachedEgressIp", &[])?;
        let ip = cache.get(c"ip")?;
        if !ip.truthy()? {
            code = Some("egress_ip_unknown");
            let error = cache.get(c"error")?;
            detail = if error.truthy()? {
                format!(
                    "出口 IP 探测失败（{}），暂不能使用该 Provider",
                    error.coerce_string()?.to_string_lossy()
                )
            } else {
                "出口 IP 尚未探测完成，暂不能使用该 Provider".into()
            };
        } else if !call(allowed, c"has", &[ip])?.truthy()? {
            code = Some("egress_ip_mismatch");
            detail=format!("当前出口 IP（{}）不在该 Provider 允许的 IP 列表内，请修改 Provider 的出口 IP 配置，或切换 VPN 后重试",ip.coerce_string()?.to_string_lossy());
        }
    }
    fields(
        ports,
        &[
            ("allowed", flag(ports, code.is_none())?),
            (
                "code",
                match code {
                    Some(v) => text(ports, v)?,
                    None => null(ports)?,
                },
            ),
            ("detail", text(ports, &detail)?),
        ],
    )
}
#[napi]
pub fn egress_ip_policy_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(fields(
        p,
        &[
            (
                "normalizeAllowlist",
                function(p, "normalizeAllowlist", 1, 1, |p, a| {
                    call(p.global()?.get(c"Array")?, c"from", &[allowlist(a[0])?])
                })?,
            ),
            (
                "egressIpRestrictionActive",
                function(p, "egressIpRestrictionActive", 1, 1, |p, a| {
                    flag(
                        p,
                        allowlist(a[0].optional(c"egressIpAllowlist")?)?
                            .get(c"size")?
                            .number()?
                            > 0.,
                    )
                })?,
            ),
            (
                "checkEgressIpAllowed",
                function(p, "checkEgressIpAllowed", 1, 1, |p, a| check(p, a[0]))?,
            ),
            (
                "assertEgressIpAllowed",
                function(p, "assertEgressIpAllowed", 1, 1, |p, a| {
                    let result = check(p, a[0])?;
                    if !result.get(c"allowed")?.truthy()? {
                        let e = p
                            .global()?
                            .get(c"Error")?
                            .construct(&[result.get(c"detail")?])?;
                        e.set(c"code", call(result.get(c"code")?, c"toUpperCase", &[])?)?;
                        return Err(e.throw_error());
                    }
                    flag(p, true)
                })?,
            ),
        ],
    )?
    .raw())
}
