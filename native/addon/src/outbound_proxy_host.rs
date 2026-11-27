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
