//! One published snapshot per Node environment. A failed discovery leaves the
//! last successful configuration available to synchronous child-process setup.
use crate::{
    host_methods::{async_result, default_object, function},
    route_response::*,
};
use napi_derive::napi;
fn proxy_env(c: L<'_>) -> Result<L<'_>> {
    let http = c.get(c"httpProxy")?;
    let https = c.get(c"httpsProxy")?;
    if !http.truthy()? && !https.truthy()? {
        return null(c);
    }
    fields(
        c,
        &[
            ("HTTP_PROXY", http),
            ("HTTPS_PROXY", https),
            (
                "NO_PROXY",
                call(c.get(c"noProxy")?, c"join", &[text(c, ",")?])?,
            ),
        ],
    )
}
fn publish<'a>(p: L<'a>, config: L<'a>) -> Result<L<'a>> {
    let vars = proxy_env(config)?;
    let owner = p.get(c"owner")?;
    owner.set(
        c"latest",
        fields(p, &[("env", vars), ("mode", config.get(c"mode")?)])?,
    )?;
    let key = call(p.global()?.get(c"JSON")?, c"stringify", &[vars])?;
    if !key.equals(p.get(c"lastKey")?)? {
        p.set(c"lastKey", key)?;
        let opts = p.get(c"options")?;
        if !opts.get(c"apply")?.nullish()? {
            call(opts, c"apply", &[vars])?;
        }
        let message = if vars.truthy()? {
            "出站请求已使用统一代理配置"
        } else {
            "出站请求未配置代理"
        };
        p.get(c"log")?.call_plain(&[text(p, message)?])?;
    }
    Ok(vars)
}
fn refresh(p: L<'_>) -> Result<L<'_>> {
    async_result(p, || {
        let policy = p.get(c"policy")?;
        call(policy, c"invalidate", &[])?;
        let pending = call(
            p.global()?.get(c"Promise")?,
            c"resolve",
            &[call(policy, c"configuration", &[])?],
        )?;
        call(
            pending,
            c"then",
            &[function(p, "publish", 1, 1, |p, a| publish(p, a[0]))?],
        )
    })
}
fn install<'a>(p: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let options = default_object(options)?;
    let ports = p.get(c"ports")?;
    let shared = call(ports, c"outbound", &[options])?;
    let mut log = options.get(c"log")?;
    if !log.truthy()? {
        log = ports.get(c"log")?;
    }
    let state = fields(
        p,
        &[
            ("options", options),
            ("shared", shared),
            ("policy", shared.get(c"policy")?),
            ("owner", p),
            ("log", log),
        ],
    )?;
    let previous = call(ports, c"agents", &[])?;
    state.set(c"previous", previous)?;
    if !options.get(c"apply")?.truthy()? {
        call(ports, c"installAgents", &[shared])?;
    }
    let report = function(state, "report", 1, 1, |s, a| {
        let error = a[0].get(c"message")?.coerce_string()?.to_string_lossy();
        s.get(c"log")?.call_plain(&[text(
            s,
            &format!("代理配置读取失败，外部请求将拒绝发送：{error}"),
        )?])?;
        null(s)
    })?;
    state.set(c"report", report)?;
    let ready = call(refresh(state)?, c"catch", &[report])?;
    if !options.get(c"refresh")?.is_false()? {
        let tick = function(state, "tick", 0, 0, |s, _| {
            call(refresh(s)?, c"catch", &[s.get(c"report")?])?;
            s.from_value(&V::Undefined)
        })?;
        let timer = call(
            p.global()?,
            c"setInterval",
            &[
                tick,
                fallback(options.get(c"refreshMs")?, V::Number(60000.))?,
            ],
        )?;
        if !timer.optional(c"unref")?.nullish()? {
            call(timer, c"unref", &[])?;
        }
        state.set(c"timer", timer)?;
    }
    fields(
        p,
        &[
            ("ready", ready),
            (
                "refresh",
                function(state, "refresh", 0, 0, |s, _| refresh(s))?,
            ),
            (
                "stop",
                function(state, "stop", 0, 0, |s, _| {
                    call(s.global()?, c"clearInterval", &[s.get(c"timer")?])?;
                    if !s.get(c"options")?.get(c"apply")?.truthy()? {
                        call(
                            s.get(c"owner")?.get(c"ports")?,
                            c"restoreAgents",
                            &[s.get(c"shared")?, s.get(c"previous")?],
                        )?;
                    }
                    s.from_value(&V::Undefined)
                })?,
            ),
        ],
    )
}
const HINT: &str = concat!(
    "疑似系统代理劫持：codex 会直接读取 macOS 系统代理，发往本地网关 127.0.0.1 的请求",
    "被代理转发到远端节点后无法回连本机（表现为 502/空响应）。请在代理软件的系统代理",
    "例外（bypass）列表加入 127.0.0.1 与 localhost，或在规则最前面加 ",
    "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve 与 IP-CIDR6,::1/128,DIRECT,no-resolve；",
    "关闭系统代理后重试也可立即恢复。"
);
#[napi]
pub fn global_proxy_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let p = fields(ports, &[("ports", ports), ("latest", null(ports)?)])?;
    Ok(fields(
        p,
        &[
            (
                "installGlobalProxy",
                function(p, "installGlobalProxy", 0, 1, |p, a| install(p, a[0]))?,
            ),
            (
                "resolveProxyEnv",
                function(ports, "resolveProxyEnv", 2, 2, |p, a| {
                    proxy_env(call(p, c"resolveProxyConfig", a)?)
                })?,
            ),
            ("parseMacSystemProxy", ports.get(c"parseMacSystemProxy")?),
            ("cidrToRange", ports.get(c"cidrToRange")?),
            (
                "latestChildProxyEnv",
                function(p, "latestChildProxyEnv", 0, 0, |p, _| {
                    let latest = p.get(c"latest")?;
                    if latest.nullish()? {
                        null(p)
                    } else {
                        latest.get(c"env")
                    }
                })?,
            ),
            (
                "latestProxyMode",
                function(p, "latestProxyMode", 0, 0, |p, _| {
                    let latest = p.get(c"latest")?;
                    if latest.nullish()? {
                        text(p, "direct")
                    } else {
                        latest.get(c"mode")
                    }
                })?,
            ),
            (
                "resetLatestForTests",
                function(p, "resetLatestForTests", 0, 0, |p, _| {
                    p.set(c"latest", null(p)?)?;
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "systemProxyHijackHint",
                function(p, "systemProxyHijackHint", 0, 1, |p, a| {
                    let opts = default_object(a[0])?;
                    if !opts.get(c"cli")?.is_string("codex")?
                        || !p
                            .get(c"latest")?
                            .optional(c"mode")?
                            .is_string("system-proxy")?
                    {
                        return null(p);
                    }
                    let msg = opts.get(c"detail")?;
                    let msg = if msg.nullish()? {
                        String::new()
                    } else {
                        msg.coerce_string()?.to_string_lossy().to_ascii_lowercase()
                    };
                    if opts.get(c"httpStatus")?.is_number(502.)?
                        || ["502", "unknown error", "empty body", "empty response"]
                            .iter()
                            .any(|s| msg.contains(s))
                    {
                        text(p, HINT)
                    } else {
                        null(p)
                    }
                })?,
            ),
        ],
    )?
    .raw())
}
