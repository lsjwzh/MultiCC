//! Per-request dedicated egress resolution. Only active lookups are coalesced;
//! the separately bounded pool reuses the Node HTTP agent for a resolved URL.
use crate::host_api::*;
use napi_derive::napi;

const NAME: &str = "Chrome 隔离出口启动器";

fn binding(row: L<'_>) -> Result<L<'_>> {
    let v = row.optional(c"egressBinding")?;
    if !object(v)? || !v.truthy()? {
        return null(row);
    }
    for k in [c"pluginId", c"profileId"] {
        let word = v.get(k)?;
        if word.string()?.is_none() || !word.truthy()? {
            return null(row);
        }
    }
    Ok(v)
}
fn failure(v: L<'_>) -> Result<L<'_>> {
    let error = fold_string(fallback(
        v.optional(c"payload")?.optional(c"error")?,
        "未知原因".into(),
    )?)?;
    let status = v.optional(c"status")?;
    let (code, message) = if status.is_number(404.)? {
        ("PLUGIN_MISSING",format!("未安装「{NAME}」插件，无法使用专用出口。请先在 Air → 资料与插件里安装它，再在插件里建一个身份（填好出口）作为这个账号的专用出口。"))
    } else if status.is_number(503.)? {
        (
            "PLUGIN_UNAVAILABLE",
            format!("「{NAME}」插件不可用：{error}"),
        )
    } else {
        ("EGRESS_UNAVAILABLE", format!("专用出口不可用：{error}"))
    };
    fields(
        v,
        &[
            ("statusCode", num(v, 400.)?),
            ("code", text(v, code)?),
            ("message", text(v, &message)?),
        ],
    )
}
fn resolve<'a>(p: L<'a>, b: L<'a>) -> Result<L<'a>> {
    let key = call(
        string(b.get(c"pluginId")?)?,
        c"concat",
        &[text(p, ":")?, string(b.get(c"profileId")?)?],
    )?;
    let flights = p.get(c"resolving")?;
    let prior = call(flights, c"get", &[key])?;
    if prior.truthy()? {
        return Ok(prior);
    }
    let ctx = fields(p, &[("p", p), ("binding", b), ("key", key)])?;
    let request = then(undef(p)?, ctx, |c, _| {
        let p = c.get(c"p")?;
        let binding = c.get(c"binding")?;
        let args = [
            binding.get(c"pluginId")?,
            text(c, "egress")?,
            fields(c, &[("id", binding.get(c"profileId")?)])?,
        ];
        let custom = p.get(c"runPluginCommand")?;
        if custom.truthy()? {
            return custom.call_plain(&args);
        }
        let host = p.get(c"host")?;
        let opts = fields(
            p,
            &[
                ("pluginsDir", host.get(c"pluginsDir")?),
                ("platform", host.get(c"process")?.get(c"platform")?),
                ("arch", host.get(c"process")?.get(c"arch")?),
                ("logger", p.get(c"logger")?),
            ],
        )?;
        let create = host.get(c"pluginsFactory")?.call_plain(&[])?;
        call(create.call_plain(&[opts])?, c"runPluginCommand", &args)
    })?;
    let url = then(request, ctx, |c, a| {
        let result = a[0];
        if result.optional(c"status")?.is_number(200.)? {
            let url = result.get(c"payload")?.optional(c"proxyUrl")?;
            if url.string()?.is_some() {
                let clean = call(url, c"trim", &[])?;
                if clean.truthy()? {
                    return Ok(clean);
                }
            }
        }
        let fail = failure(result)?;
        let err = c
            .global()?
            .get(c"Error")?
            .construct(&[fail.get(c"message")?])?;
        call(c.global()?.get(c"Object")?, c"assign", &[err, fail])?;
        Err(err.throw_error())
    })?;
    let clean = function(ctx, "settled", 0, 0, |c, _| {
        call(
            c.get(c"p")?.get(c"resolving")?,
            c"delete",
            &[c.get(c"key")?],
        )
    })?;
    let running = call(url, c"finally", &[clean])?;
    call(flights, c"set", &[key, running])?;
    Ok(running)
}
fn agent_for<'a>(p: L<'a>, url: L<'a>) -> Result<L<'a>> {
    let agents = p.get(c"agents")?;
    let prior = call(agents, c"get", &[url])?;
    if prior.truthy()? {
        return Ok(prior);
    }
    let custom = p.get(c"createAgent")?;
    let agent = if custom.truthy()? {
        custom.call_plain(&[url])?
    } else {
        let ctor = p.get(c"host")?.get(c"proxyClass")?.call_plain(&[])?;
        let get = function(url, "getProxyForUrl", 0, 0, constant)?;
        ctor.construct(&[fields(p, &[("getProxyForUrl", get)])?])?
    };
    call(agents, c"set", &[url, agent])?;
    while agents.get(c"size")?.number()? > 16. {
        let iter = call(agents, c"keys", &[])?;
        let key = call(iter, c"next", &[])?.get(c"value")?;
        let stale = call(agents, c"get", &[key])?;
        call(agents, c"delete", &[key])?;
        p.catch(|| {
            if stale.truthy()? && callable(stale.get(c"destroy")?)? {
                call(stale, c"destroy", &[])?;
            }
            Ok(())
        })?;
    }
    Ok(agent)
}
fn upstream<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let ctx = default_object(args[0])?;
        let b = binding(ctx.get(c"provider")?)?;
        if !b.truthy()? {
            return undef(p);
        }
        let op = fields(p, &[("p", p), ("ctx", ctx), ("binding", b)])?;
        let result = async_result(p, || then(resolve(p, b)?, p, |p, a| agent_for(p, a[0])))?;
        recover(result, op, |c, a| {
            let p = c.get(c"p")?;
            let err = a[0];
            let detail = fields(
                c,
                &[
                    ("providerId", c.get(c"ctx")?.get(c"providerId")?),
                    ("profileId", c.get(c"binding")?.get(c"profileId")?),
                    ("code", err.get(c"code")?),
                    ("error", err.get(c"message")?),
                ],
            )?;
            call(
                p.get(c"logger")?,
                c"warn",
                &[text(c, "claude_egress_unavailable")?, detail],
            )?;
            Err(err.throw_error())
        })
    })
}
fn create<'a>(host: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let o = default_object(a[0])?;
    let map = o.global()?.get(c"Map")?;
    let logger = o.get(c"logger")?;
    let logger = if logger.truthy()? {
        logger
    } else {
        methods(
            o,
            &[
                ("warn", 0, |p, _| undef(p)),
                ("info", 0, |p, _| undef(p)),
                ("error", 0, |p, _| undef(p)),
            ],
        )?
    };
    let p = fields(
        o,
        &[
            ("host", host),
            ("logger", logger),
            ("runPluginCommand", o.get(c"runPluginCommand")?),
            ("createAgent", o.get(c"createAgent")?),
            ("resolving", map.construct(&[])?),
            ("agents", map.construct(&[])?),
        ],
    )?;
    let upstream = function(p, "resolveUpstreamAgent", 0, 1, upstream)?;
    upstream.set(
        c"resolveProxyUrl",
        function(p, "resolveProxyUrl", 0, 1, |p, a| {
            async_result(p, || {
                let b = binding(default_object(a[0])?.get(c"provider")?)?;
                if b.truthy()? {
                    resolve(p, b)
                } else {
                    undef(p)
                }
            })
        })?,
    )?;
    fields(
        o,
        &[
            ("resolveUpstreamAgent", upstream),
            (
                "resolveProxyUrl",
                function(p, "resolveProxyUrl", 1, 1, |p, a| resolve(p, a[0]))?,
            ),
        ],
    )
}
fn guard<'a>(_p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if a[1].get(c"supported")?.truthy()? {
        return Ok(a[0]);
    }
    function(a[0], "guardedReader", 1, 1, |reader, a| {
        async_result(reader, || {
            if a[0].truthy()? && object(a[0])? && binding(a[0].get(c"provider")?)?.truthy()? {
                return fields(reader,&[("token",null(reader)?),("reason",text(reader,"这个账号绑定了专用出口，但当前 cli-provider-router 版本过旧、不支持按账号出口；请在 multicc 目录执行 npm install 后重启服务")?)]);
            }
            reader.call_plain(a)
        })
    })
}
#[napi]
pub fn claude_egress_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = defaulted_methods(
        p,
        &[
            ("createClaudeEgressAgentResolver", 0, 1, create),
            ("guardCredentialReader", 2, 2, guard),
            ("describeFailure", 1, 1, |_, a| failure(a[0])),
        ],
    )?;
    api.set(c"PLUGIN_ID", text(p, "chrome-proxy-launcher")?)?;
    api.set(c"PLUGIN_NAME", text(p, NAME)?)?;
    Ok(api.raw())
}
