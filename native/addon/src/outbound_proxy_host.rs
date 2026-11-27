use crate::{js_live::spread, route_response::*};
use multicc_core::outbound_proxy as policy;
use napi_derive::napi;
#[napi]
pub fn outbound_cidr(entry: String) -> Option<String> {
    policy::cidr_to_range(&entry)
}
#[napi]
pub fn outbound_loopback(host: String) -> bool {
    let name = host.strip_prefix('[').unwrap_or(&host);
    policy::is_loopback_name(name.strip_suffix(']').unwrap_or(name))
}
#[napi]
pub fn outbound_bypass_entry(
    env: Env,
    host: Unknown<'_>,
    port: String,
    item: Unknown<'_>,
) -> Result<bool> {
    let host = L::new(&env, host).coerce_string()?;
    let item = L::new(&env, item).coerce_string()?;
    // Domain matching compares JS code units. Preserve isolated surrogates as
    // distinct non-ASCII characters while leaving the proxy grammar intact.
    let encode = |value: &multicc_core::js::JsString| -> String {
        value
            .as_units()
            .iter()
            .map(|&u| {
                if u < 128 {
                    char::from(u as u8)
                } else {
                    char::from_u32(0x10000 + u32::from(u)).unwrap()
                }
            })
            .collect()
    };
    Ok(policy::matches_proxy_entry(
        &encode(&host),
        &port,
        &encode(&item),
        policy::EntrySyntax::Node,
    ))
}
#[napi]
pub fn outbound_proxy_env(env: Env, values: Unknown<'_>) -> Result<bool> {
    let p = L::new(&env, values);
    for key in [
        c"http_proxy",
        c"HTTP_PROXY",
        c"https_proxy",
        c"HTTPS_PROXY",
        c"all_proxy",
        c"ALL_PROXY",
    ] {
        if !p.get(key)?.undefined()? {
            return Ok(true);
        }
    }
    Ok(false)
}
fn split<'a>(v: L<'a>, set: L<'a>) -> Result<()> {
    let s = string(v)?.coerce_string()?;
    for part in s
        .as_units()
        .split(|&c| c == 44 || multicc_core::js::is_js_whitespace(c))
        .filter(|p| !p.is_empty())
    {
        call(
            set,
            c"add",
            &[
                v.from_value(&V::String(multicc_core::js::JsString::from_units(
                    part.to_vec(),
                )))?,
            ],
        )?;
    }
    Ok(())
}
fn loopbacks(set: L<'_>) -> Result<()> {
    for host in policy::DIRECT_HOSTS {
        call(set, c"add", &[text(set, host)?])?;
    }
    Ok(())
}
#[napi]
pub fn outbound_merge_env(env: Env, values: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, values);
    let set = p.global()?.get(c"Set")?.construct(&[])?;
    let a = p.optional(c"no_proxy")?;
    let b = p.optional(c"NO_PROXY")?;
    for v in [a, b] {
        split(fallback(v, "".into())?, set)?;
    }
    loopbacks(set)?;
    let arr = call(p.global()?.get(c"Array")?, c"from", &[set])?;
    let merged = call(arr, c"join", &[text(p, ",")?])?;
    let out = spread(p)?;
    for k in ["no_proxy", "NO_PROXY"] {
        out.define_key(text(p, k)?, merged)?;
    }
    Ok(out.raw())
}
fn coalesce<'a>(p: L<'a>, lo: &std::ffi::CStr, hi: &std::ffi::CStr) -> Result<L<'a>> {
    let v = p.get(lo)?;
    if v.nullish()? {
        p.get(hi)
    } else {
        Ok(v)
    }
}
fn first_or_empty<'a>(p: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    for v in values {
        if !v.nullish()? {
            return Ok(*v);
        }
    }
    text(p, "")
}
#[napi]
pub fn outbound_resolve(
    env: Env,
    values: Unknown<'_>,
    system: Unknown<'_>,
    explicit: bool,
    valid: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, values);
    let s = L::new(&env, system);
    let valid = L::new(&env, valid);
    let http = coalesce(p, c"http_proxy", c"HTTP_PROXY")?;
    let https = coalesce(p, c"https_proxy", c"HTTPS_PROXY")?;
    let all = coalesce(p, c"all_proxy", c"ALL_PROXY")?;
    let (h, t) = if explicit {
        (
            first_or_empty(p, &[http, all])?,
            first_or_empty(p, &[https, http, all])?,
        )
    } else {
        (
            fallback(s.optional(c"httpProxy")?, "".into())?,
            fallback(s.optional(c"httpsProxy")?, "".into())?,
        )
    };
    let error = |msg: &str| -> Result<sys::napi_value> {
        Err(p
            .global()?
            .get(c"Error")?
            .construct(&[text(p, msg)?])?
            .throw_error())
    };
    if !explicit
        && (!h.truthy()? || !t.truthy()?)
        && (s.optional(c"socksProxy")?.truthy()? || s.optional(c"pacEnabled")?.truthy()?)
    {
        return error("系统代理仅配置了 SOCKS/PAC；请配置 HTTP(S) 代理，已阻止静默直连");
    }
    for proxy in [h, t] {
        if proxy.truthy()? && !valid.call_plain(&[proxy])?.truthy()? {
            return error("代理地址必须是 HTTP(S) proxy URL；已阻止静默直连");
        }
    }
    let exceptions = if explicit {
        null(p)?
    } else {
        s.optional(c"exceptions")?
    };
    let set = p.global()?.get(c"Set")?.construct(&[])?;
    loopbacks(set)?;
    split(
        first_or_empty(p, &[coalesce(p, c"no_proxy", c"NO_PROXY")?])?,
        set,
    )?;
    if exceptions.truthy()? {
        exceptions.for_each(|v| {
            call(set, c"add", &[v])?;
            Ok(())
        })?;
    }
    let no = call(p.global()?.get(c"Array")?, c"from", &[set])?;
    let mode = if !h.truthy()? && !t.truthy()? {
        "direct"
    } else if explicit {
        "environment-proxy"
    } else {
        "system-proxy"
    };
    Ok(fields(
        p,
        &[
            ("httpProxy", h),
            ("httpsProxy", t),
            ("noProxy", no),
            ("mode", text(p, mode)?),
        ],
    )?
    .raw())
}

#[napi]
pub fn outbound_system_proxy(input: String) -> Result<String> {
    serde_json::to_string(&policy::parse_mac_system_proxy(&input))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}
fn bypass<'a>(ports: L<'a>, url: L<'a>, entries: L<'a>) -> Result<bool> {
    let native = ports.get(c"native")?;
    let mut host = call(url.get(c"hostname")?, c"toLowerCase", &[])?;
    if call(host, c"startsWith", &[text(host, "[")?])?.truthy()? {
        host = call(host, c"slice", &[num(host, 1.)?])?;
    }
    if call(host, c"endsWith", &[text(host, "]")?])?.truthy()? {
        host = call(host, c"slice", &[num(host, 0.)?, num(host, -1.)?])?;
    }
    if call(native, c"outboundLoopback", &[host])?.truthy()? {
        return Ok(true);
    }
    let port = url.get(c"port")?;
    let port = if port.truthy()? {
        port
    } else {
        text(url, if secure(url)? { "443" } else { "80" })?
    };
    let mut direct = false;
    entries.for_each_while(|item| {
        direct = call(
            native,
            c"outboundBypassEntry",
            &[host, port, call(item, c"toLowerCase", &[])?],
        )?
        .truthy()?;
        Ok(!direct)
    })?;
    Ok(direct)
}
fn secure(url: L<'_>) -> Result<bool> {
    let protocol = url.get(c"protocol")?;
    Ok(protocol.is_string("https:")? || protocol.is_string("wss:")?)
}
fn resolve<'a>(p: L<'a>, env: L<'a>, system: L<'a>) -> Result<L<'a>> {
    let native = p.get(c"native")?;
    call(
        native,
        c"outboundResolve",
        &[
            env,
            system,
            call(native, c"outboundProxyEnv", &[env])?,
            p.get(c"valid")?,
        ],
    )
}
fn configuration(p: L<'_>) -> Result<L<'_>> {
    use crate::host_methods::{async_result, function};
    async_result(p, || {
        let ports = p.get(c"ports")?;
        let env = p.get(c"env")?;
        let resolve_now = || resolve(ports, env, p.get(c"system")?);
        if !p.get(c"platform")?.is_string("darwin")?
            || call(ports.get(c"native")?, c"outboundProxyEnv", &[env])?.truthy()?
        {
            return resolve_now();
        }
        let now = p.get(c"now")?.call_plain(&[])?.number()?;
        let interval = p.get(c"options")?.get(c"refreshMs")?;
        let interval = if interval.nullish()? {
            30000.
        } else {
            interval.number()?
        };
        if !(now - p.get(c"checkedAt")?.number()? >= interval) {
            return resolve_now();
        }
        let mut pending = p.get(c"pending")?;
        if !pending.truthy()? {
            let tick = call(p.global()?.get(c"Promise")?, c"resolve", &[])?;
            let read = call(tick, c"then", &[p.get(c"readSystem")?])?;
            let success = function(p, "systemProxyRead", 1, 1, |p, a| {
                p.set(c"system", a[0])?;
                p.set(c"checkedAt", p.get(c"now")?.call_plain(&[])?)?;
                p.from_value(&V::Undefined)
            })?;
            let failed = function(p, "systemProxyFailed", 1, 1, |p, a| {
                if !p.get(c"system")?.truthy()? {
                    return Err(a[0].throw_error());
                }
                p.set(c"checkedAt", p.get(c"now")?.call_plain(&[])?)?;
                p.from_value(&V::Undefined)
            })?;
            let clear = function(p, "systemProxySettled", 0, 0, |p, _| {
                p.set(c"pending", null(p)?)?;
                p.from_value(&V::Undefined)
            })?;
            pending = call(
                call(read, c"then", &[success, failed])?,
                c"finally",
                &[clear],
            )?;
            p.set(c"pending", pending)?;
        }
        call(
            pending,
            c"then",
            &[function(p, "resolveProxy", 0, 0, |p, _| {
                resolve(p.get(c"ports")?, p.get(c"env")?, p.get(c"system")?)
            })?],
        )
    })
}
#[napi]
pub fn outbound_bypass_url(
    env: Env,
    ports: Unknown<'_>,
    url: Unknown<'_>,
    entries: Unknown<'_>,
) -> Result<bool> {
    bypass(
        L::new(&env, ports),
        L::new(&env, url),
        L::new(&env, entries),
    )
}
#[napi]
pub fn outbound_policy_instance(
    env: Env,
    ports: Unknown<'_>,
    config: Unknown<'_>,
) -> Result<sys::napi_value> {
    use crate::host_methods::{async_result, function};
    let p = L::new(&env, config);
    p.set(c"ports", L::new(&env, ports))?;
    p.set(c"checkedAt", num(p, f64::NEG_INFINITY)?)?;
    Ok(fields(
        p,
        &[
            (
                "configuration",
                function(p, "configuration", 0, 0, |p, _| configuration(p))?,
            ),
            (
                "invalidate",
                function(p, "invalidate", 0, 0, |p, _| {
                    p.set(c"checkedAt", num(p, f64::NEG_INFINITY)?)?;
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "proxyForUrl",
                function(p, "proxyForUrl", 1, 1, |p, a| {
                    async_result(p, || {
                        let url = p.global()?.get(c"URL")?.construct(&[a[0]])?;
                        let ports = p.get(c"ports")?;
                        if call(
                            ports.get(c"native")?,
                            c"outboundLoopback",
                            &[call(url.get(c"hostname")?, c"toLowerCase", &[])?],
                        )?
                        .truthy()?
                        {
                            return text(p, "");
                        }
                        let s = fields(p, &[("ports", ports), ("url", url)])?;
                        let pick = function(s, "selectProxy", 1, 1, |s, a| {
                            let url = s.get(c"url")?;
                            if bypass(s.get(c"ports")?, url, a[0].get(c"noProxy")?)? {
                                text(s, "")
                            } else {
                                a[0].get(if secure(url)? {
                                    c"httpsProxy"
                                } else {
                                    c"httpProxy"
                                })
                            }
                        })?;
                        call(configuration(p)?, c"then", &[pick])
                    })
                })?,
            ),
        ],
    )?
    .raw())
}
