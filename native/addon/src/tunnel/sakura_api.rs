//! SakuraFrp v4 API, launcher credentials and public tunnel metadata.
use crate::host_api::*;
use crate::plugin_catalog_host::{items, push, strings};
use napi_derive::napi;
use std::ffi::CStr;
const BASE: &str = "https://api.natfrp.com/v4";
const LAUNCHER_PATH: &[&str] = &[
    "Library",
    "Containers",
    "com.natfrp.launcher",
    "Data",
    "Library",
    "Application Support",
    "natfrp-service",
    "config.json",
];

fn as_str(v: L<'_>) -> Result<L<'_>> {
    if v.kind()? == sys::ValueType::napi_string {
        Ok(v)
    } else {
        text(v, "")
    }
}
fn integer(v: L<'_>) -> Result<L<'_>> {
    if v.number_value()?
        .is_some_and(|x| x.is_finite() && x.fract() == 0.)
    {
        Ok(v)
    } else {
        null(v)
    }
}
fn nullish(v: L<'_>) -> Result<L<'_>> {
    if v.nullish()? {
        null(v)
    } else {
        Ok(v)
    }
}
pub(super) fn launcher<'a>(p: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let o = default_object(options)?;
    let home = o.get(c"home")?;
    let home = if home.undefined()? {
        call(p.get(c"os")?, c"homedir", &[])?
    } else {
        home
    };
    let platform = with_default(o.get(c"platform")?, p.get(c"process")?.get(c"platform")?)?;
    let read = o.get(c"readFileSync")?;
    if !platform.is_string("darwin")? {
        return null(p);
    }
    let mut parts = vec![home];
    let rel = p.get(c"launcherPath")?;
    if !rel.undefined()? {
        parts.extend(items(rel)?)
    } else {
        for n in LAUNCHER_PATH {
            parts.push(text(p, n)?)
        }
    }
    let file = call(p.get(c"path")?, c"join", &parts)?;
    let Some(cfg) = p.catch(|| {
        let read = if read.undefined()? {
            p.get(c"fs")?.get(c"readFileSync")?
        } else {
            read
        };
        json_call(p, c"parse", read.call_plain(&[file, text(p, "utf8")?])?)
    })?
    else {
        return null(p);
    };
    let token = call(as_str(cfg.get(c"token")?)?, c"trim", &[])?;
    let valid = token.string()?.is_some_and(|s| {
        s.len() >= 16
            && s.len() <= 64
            && s.as_units()
                .iter()
                .all(|&u| u <= 127 && (u as u8).is_ascii_alphanumeric())
    });
    if !valid {
        return null(p);
    }
    let tunnels = array(p)?;
    let auto = cfg.get(c"auto_start_tunnels")?;
    if auto.is_array()? {
        for id in items(auto)? {
            if !id.nullish()? {
                push(tunnels, id)?
            }
        }
    }
    fields(
        p,
        &[
            ("token", token),
            ("autoStartTunnels", tunnels),
            ("launcherVersion", as_str(cfg.get(c"version")?)?),
            ("source", file),
        ],
    )
}
fn request<'a>(p: L<'a>, endpoint: L<'a>, o: L<'a>) -> Result<L<'a>> {
    async_result(p, || {
        let o = default_object(o)?;
        let token = o.get(c"token")?;
        let fetch = with_default(o.get(c"fetch")?, p.global()?.get(c"fetch")?)?;
        let timeout = with_default(o.get(c"timeoutMs")?, num(p, 15000.)?)?;
        if !token.truthy()? || token.kind()? != sys::ValueType::napi_string {
            return Err(error_value(p, "SakuraFrp API 需要访问密钥 (token)")?.throw_error());
        }
        let slash = call(endpoint, c"startsWith", &[text(p, "/")?])?.truthy()?;
        let url = call(
            text(
                p,
                if slash {
                    BASE
                } else {
                    "https://api.natfrp.com/v4/"
                },
            )?,
            c"concat",
            &[endpoint],
        )?;
        let ctrl = p.global()?.get(c"AbortController")?.construct(&[])?;
        let timer = call(
            p.global()?,
            c"setTimeout",
            &[
                function(ctrl, "", 0, 0, |c, _| call(c, c"abort", &[]))?,
                timeout,
            ],
        )?;
        let work = async_result(p, || {
            let headers = fields(
                p,
                &[
                    (
                        "Authorization",
                        call(text(p, "Bearer ")?, c"concat", &[token])?,
                    ),
                    ("User-Agent", text(p, "multicc")?),
                ],
            )?;
            fetch.call_plain(&[
                url,
                fields(p, &[("signal", ctrl.get(c"signal")?), ("headers", headers)])?,
            ])
        })?;
        let wait = call(
            work,
            c"finally",
            &[function(timer, "", 0, 0, |t, _| {
                call(t.global()?, c"clearTimeout", &[t])
            })?],
        )?;
        then(wait, endpoint, |endpoint, a| {
            let response = a[0];
            if !response.truthy()? || !response.get(c"ok")?.truthy()? {
                let status = if response.truthy()? {
                    fold_string(response.get(c"status")?)?
                } else {
                    "无响应".to_owned()
                };
                return Err(error_value(
                    endpoint,
                    &format!("SakuraFrp {} 响应 {status}", fold_string(endpoint)?),
                )?
                .throw_error());
            }
            call(response, c"json", &[])
        })
    })
}
fn read<'a>(p: L<'a>, o: L<'a>, endpoint: &str) -> Result<L<'a>> {
    let o = default_object(o)?;
    request(p, text(p, endpoint)?, pick(o, &[c"token", c"fetch"])?)
}
pub(super) fn user<'a>(p: L<'a>, o: L<'a>) -> Result<L<'a>> {
    then(read(p, o, "/user/info")?, p, |p, a| {
        let s = if object(a[0])? { a[0] } else { fields(p, &[])? };
        let traffic = s.get(c"traffic")?;
        let traffic = if traffic.is_array()? {
            traffic
        } else {
            array(p)?
        };
        let sign = s.get(c"sign")?;
        let sign = if object(sign)? { sign } else { fields(p, &[])? };
        let group = s.get(c"group")?;
        let group = if object(group)? {
            group
        } else {
            fields(p, &[])?
        };
        fields(
            p,
            &[
                ("id", integer(s.get(c"id")?)?),
                ("name", as_str(s.get(c"name")?)?),
                ("realname", nullish(s.get(c"realname")?)?),
                ("groupName", as_str(group.get(c"name")?)?),
                ("tunnelCount", integer(s.get(c"tunnels")?)?),
                ("trafficUsed", integer(traffic.element(0)?)?),
                ("trafficTotal", integer(traffic.element(1)?)?),
                ("signed", flag(p, sign.get(c"signed")?.truthy()?)?),
                ("signDays", integer(sign.get(c"days")?)?),
            ],
        )
    })
}
fn tunnels<'a>(p: L<'a>, o: L<'a>) -> Result<L<'a>> {
    then(read(p, o, "/tunnels")?, p, |p, a| {
        if a[0].is_array()? {
            Ok(a[0])
        } else {
            array(p)
        }
    })
}
fn nodes<'a>(p: L<'a>, o: L<'a>) -> Result<L<'a>> {
    then(read(p, o, "/nodes")?, p, |p, a| {
        if object(a[0])? && !a[0].is_array()? {
            Ok(a[0])
        } else {
            fields(p, &[])
        }
    })
}
fn describe<'a>(p: L<'a>, t: L<'a>, nodes: L<'a>) -> Result<L<'a>> {
    if !object(t)? {
        return null(p);
    }
    let number_text = |k: &CStr| {
        let v = t.get(k)?;
        if v.nullish()? {
            text(p, "")
        } else {
            string(v)
        }
    };
    let remote = number_text(c"remote")?;
    let node_id = number_text(c"node")?;
    let node = if nodes.truthy()? && node_id.truthy()? {
        nodes.get_key(node_id)?
    } else {
        null(p)?
    };
    let host = as_str(node.optional(c"host")?)?;
    let extra = fold_string(as_str(t.get(c"extra")?)?)?;
    let auto = extra.to_ascii_lowercase().contains("auto_https");
    let has = remote.truthy()? && host.truthy()?;
    let authority = if has {
        call(host, c"concat", &[text(p, ":")?, remote])?
    } else {
        null(p)?
    };
    fields(
        p,
        &[
            ("tunnelId", nullish(t.get(c"id")?)?),
            ("name", as_str(t.get(c"name")?)?),
            ("type", as_str(t.get(c"type")?)?),
            ("online", flag(p, t.get(c"online")?.truthy()?)?),
            ("remote", remote),
            ("nodeId", node_id),
            ("nodeHost", host),
            ("nodeName", as_str(node.optional(c"name")?)?),
            ("autoHttps", flag(p, auto)?),
            ("authority", authority),
            (
                "publicUrl",
                if has && !auto {
                    call(text(p, "http://")?, c"concat", &[authority])?
                } else {
                    null(p)?
                },
            ),
            ("needsBoundDomain", flag(p, has && auto)?),
            (
                "reason",
                if !has {
                    text(p, "missing_remote_or_node_host")?
                } else if auto {
                    text(p, "auto_https_requires_bound_nyat_domain")?
                } else {
                    null(p)?
                },
            ),
        ],
    )
}
pub(super) fn discover<'a>(p: L<'a>, options: L<'a>) -> Result<L<'a>> {
    async_result(p, || {
        let o = default_object(options)?;
        let auth = pick(o, &[c"token", c"fetch"])?;
        let id = o.get(c"tunnelId")?;
        let all = array(p)?;
        push(all, tunnels(p, auth)?)?;
        push(all, nodes(p, auth)?)?;
        then(
            call(p.global()?.get(c"Promise")?, c"all", &[all])?,
            fields(p, &[("id", id)])?,
            |c, a| {
                let ts = a[0].element(0)?;
                let ns = a[0].element(1)?;
                let id = c.get(c"id")?;
                let mut found = None;
                for t in items(ts)? {
                    if t.truthy()?
                        && (if id.nullish()? {
                            t.get(c"online")?.truthy()?
                        } else {
                            string(t.get(c"id")?)?.equals(string(id)?)?
                        })
                    {
                        found = Some(t);
                        break;
                    }
                }
                let pick = match found {
                    Some(t) => t,
                    None if id.nullish()? => ts.element(0)?,
                    None => null(c)?,
                };
                fields(
                    c,
                    &[
                        ("found", flag(c, pick.truthy()?)?),
                        ("tunnelCount", ts.get(c"length")?),
                        (
                            "access",
                            if pick.truthy()? {
                                describe(c, pick, ns)?
                            } else {
                                null(c)?
                            },
                        ),
                    ],
                )
            },
        )
    })
}
#[napi]
pub fn sakura_frp_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let path = strings(p, LAUNCHER_PATH)?;
    p.set(c"launcherPath", path)?;
    let api = fields(
        p,
        &[
            ("API_BASE", text(p, BASE)?),
            ("LAUNCHER_CONFIG_RELPATH", path),
        ],
    )?;
    api.spread_from(defaulted_methods(
        p,
        &[
            ("readLauncherToken", 0, 1, |p, a| launcher(p, a[0])),
            ("sakuraRequest", 1, 2, |p, a| request(p, a[0], a[1])),
            ("getUserInfo", 0, 1, |p, a| {
                async_result(p, || user(p, a[0]))
            }),
            ("listTunnels", 0, 1, |p, a| {
                async_result(p, || tunnels(p, a[0]))
            }),
            ("listNodes", 0, 1, |p, a| async_result(p, || nodes(p, a[0]))),
            ("describeTunnelAccess", 2, 2, |p, a| describe(p, a[0], a[1])),
            ("discoverAccess", 0, 1, |p, a| discover(p, a[0])),
        ],
    )?)?;
    Ok(api.raw())
}
