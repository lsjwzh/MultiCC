//! Proxy selection is shared by Node SDK agents and undici. The dispatcher
//! retains live sockets, handlers, errors and Request objects in its isolate.
use crate::host_api::*;
use napi_derive::napi;

fn dispatch_selected<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let dispatcher = p.get(c"dispatcher")?;
    if dispatcher.get(c"closed")?.truthy()? {
        return Err(error_value(p, "网络请求入口已关闭")?.throw_error());
    }
    let proxy = args[0];
    let mut selected = dispatcher.get(c"direct")?;
    if proxy.truthy()? {
        let proxies = dispatcher.get(c"proxies")?;
        if !call(proxies, c"has", &[proxy])?.truthy()? {
            call(
                proxies,
                c"set",
                &[proxy, p.get(c"Agent")?.construct(&[proxy])?],
            )?;
        }
        selected = call(proxies, c"get", &[proxy])?;
    }
    call(
        selected,
        c"dispatch",
        &[p.get(c"options")?, p.get(c"handler")?],
    )?;
    undef(p)
}

#[napi]
pub fn outbound_dispatch(
    env: Env,
    dispatcher: Unknown<'_>,
    options: Unknown<'_>,
    handler: Unknown<'_>,
    agent: Unknown<'_>,
) -> Result<bool> {
    let dispatcher = L::new(&env, dispatcher);
    let state = fields(
        dispatcher,
        &[
            ("dispatcher", dispatcher),
            ("options", L::new(&env, options)),
            ("handler", L::new(&env, handler)),
            ("Agent", L::new(&env, agent)),
        ],
    )?;
    let pending = then(undef(state)?, state, |s, _| {
        let policy = s.get(c"dispatcher")?.get(c"policy")?;
        let proxy = call(
            policy,
            c"proxyForUrl",
            &[string(s.get(c"options")?.get(c"origin")?)?],
        )?;
        then(proxy, s, dispatch_selected)
    })?;
    recover(pending, state, |s, a| {
        call(s.get(c"handler")?, c"onError", &[a[0]])
    })?;
    Ok(true)
}

fn send_request(s: L<'_>) -> Result<L<'_>> {
    let p = s.get(c"owner")?;
    let init = spread(s.get(c"init")?)?;
    init.set(c"dispatcher", p.get(c"dispatcher")?)?;
    p.get(c"fetch")?.call_plain(&[s.get(c"url")?, init])
}

fn annotate<'a>(state: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    if object(reason)? {
        reason.assign(c"multiccProxyMode", state.get(c"mode")?)?;
    }
    Err(reason.throw_error())
}

#[napi]
pub fn outbound_request(
    env: Env,
    owner: Unknown<'_>,
    url: Unknown<'_>,
    init: Unknown<'_>,
    signal: Unknown<'_>,
    hostname: String,
) -> Result<sys::napi_value> {
    let p = L::new(&env, owner);
    let state = fields(
        p,
        &[
            ("owner", p),
            ("url", L::new(&env, url)),
            ("init", L::new(&env, init)),
            ("mode", text(p, "proxy-discovery")?),
        ],
    )?;
    let start = || {
        if crate::outbound_proxy_host::outbound_loopback(hostname) {
            state.set(c"mode", text(p, "direct")?)?;
            return send_request(state);
        }
        let config = call(p.get(c"policy")?, c"configuration", &[])?;
        let pending = p
            .get(c"abortable")?
            .call_plain(&[config, L::new(&env, signal)])?;
        then(pending, state, |s, args| {
            s.set(c"mode", args[0].get(c"mode")?)?;
            send_request(s)
        })
    };
    Ok(async_result(p, || match start() {
        Ok(pending) => recover(pending, state, |s, args| annotate(s, args[0])),
        Err(err) => match p.exception_value()? {
            Some(reason) => annotate(state, reason),
            None => Err(err),
        },
    })?
    .raw())
}

#[napi]
pub fn outbound_child_env(
    env: Env,
    base: Unknown<'_>,
    config: Unknown<'_>,
) -> Result<sys::napi_value> {
    let base = L::new(&env, base);
    let cfg = L::new(&env, config);
    let out = spread(base)?;
    let http = cfg.get(c"httpProxy")?;
    let https = cfg.get(c"httpsProxy")?;
    let bypass = call(cfg.get(c"noProxy")?, c"join", &[text(base, ",")?])?;
    for (lower, upper, value) in [
        (c"http_proxy", c"HTTP_PROXY", http),
        (c"https_proxy", c"HTTPS_PROXY", https),
        (c"no_proxy", c"NO_PROXY", bypass),
    ] {
        out.set(lower, value)?;
        out.set(upper, value)?;
    }
    out.delete(c"all_proxy")?;
    out.delete(c"ALL_PROXY")?;
    Ok(out.raw())
}
