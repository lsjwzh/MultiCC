//! Telegram/Discord policy, state, routes and ordered SDK effects. Node only
//! supplies the platform SDKs, Express and the shared native bridge facades.
use crate::host_api::*;
use napi_derive::napi;
mod inbound;
mod lifecycle;
mod outbound;
mod routes;

fn telegram(s: L<'_>) -> Result<bool> {
    s.get(c"platform")?.is_string("telegram")
}
fn label(s: L<'_>) -> Result<String> {
    fold_string(s.get(c"label")?)
}
fn gateway(s: L<'_>) -> Result<L<'_>> {
    call(s.get(c"gateway")?, c"get", &[])
}
fn log<'a>(s: L<'a>, kind: &str, value: L<'a>) -> Result<L<'a>> {
    call(s.get(c"logStore")?, c"push", &[text(s, kind)?, value])
}
fn log_text<'a>(s: L<'a>, kind: &str, value: &str) -> Result<L<'a>> {
    log(s, kind, text(s, value)?)
}
fn caught<'a>(s: L<'a>, e: napi::Error) -> Result<L<'a>> {
    match s.exception_value()? {
        Some(v) => Ok(v),
        None => error_value(s, &e.reason),
    }
}
fn message<'a>(value: L<'a>) -> Result<L<'a>> {
    value.get(c"message")
}
fn concat<'a>(s: L<'a>, prefix: &str, value: L<'a>) -> Result<L<'a>> {
    call(text(s, prefix)?, c"concat", &[value])
}
fn preview(v: L<'_>, max: f64) -> Result<L<'_>> {
    if v.get(c"length")?.number()? > max {
        let cut = call(v, c"slice", &[num(v, 0.)?, num(v, max)?])?;
        call(cut, c"concat", &[text(v, "…")?])
    } else {
        Ok(v)
    }
}
fn ok(res: L<'_>) -> Result<L<'_>> {
    send(res, None, fields(res, &[("ok", flag(res, true)?)])?)
}
fn load_config<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    match s.catch(|| {
        let raw = call(
            s.get(c"ports")?.get(c"fs")?,
            c"readFileSync",
            &[s.get(c"configFile")?, text(s, "utf8")?],
        )?;
        json_call(s, c"parse", raw)
    })? {
        Some(config) => Ok(config),
        None => fields(s, &[("botToken", text(s, "")?)]),
    }
}
fn init<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = a[0];
    let ports = s.get(c"ports")?;
    let core = ports.get(c"bridgeGateway")?;
    s.set(
        c"logStore",
        call(
            core,
            c"createLogStore",
            &[fields(s, &[("max", num(s, 300.)?)])?],
        )?,
    )?;
    s.set(
        c"echo",
        call(
            core,
            c"createEchoStore",
            &[fields(s, &[("ttlMs", num(s, 60000.)?)])?],
        )?,
    )?;
    // Bound callbacks resolve the latest state, matching the original repeated-init behaviour.
    let ctl = methods(
        s,
        &[
            ("disconnect", 0, |s, _| undef(s)),
            ("reconnectIfRunning", 0, |s, _| undef(s)),
        ],
    )?;
    let log_fn = function(s, "log", 2, 2, |s, a| call(s.get(c"logStore")?, c"push", a))?;
    let options = fields(
        s,
        &[
            ("sessionId", s.get(c"sessionId")?),
            ("cwd", s.get(c"cwd")?),
            (
                "label",
                call(s.get(c"label")?, c"concat", &[text(s, " Gateway")?])?,
            ),
            ("platformLabel", s.get(c"label")?),
            ("persistedSessions", opts.get(c"persistedSessions")?),
            ("chatSessions", opts.get(c"chatSessions")?),
            ("savePersistedSessions", opts.get(c"savePersistedSessions")?),
            ("clearBridgeHistory", opts.get(c"clearBridgeHistory")?),
            (
                "bridgeHistoryFile",
                ports.get(c"bridgeConfig")?.get(c"bridgeHistoryFile")?,
            ),
            ("chatWsCtl", ctl),
            ("log", log_fn),
        ],
    )?;
    s.set(
        c"gateway",
        call(core, c"createGatewayLifecycle", &[options])?,
    )?;
    let ws_options = fields(
        s,
        &[
            ("port", fallback(opts.get(c"port")?, V::Number(3000.))?),
            ("sessionId", s.get(c"sessionId")?),
            (
                "getGateway",
                function(s, "getGateway", 0, 0, |s, _| gateway(s))?,
            ),
            (
                "isRunning",
                function(s, "isRunning", 0, 0, |s, _| s.get(c"running"))?,
            ),
            ("log", log_fn),
            (
                "onTurn",
                function(s, "onTurn", 1, 1, |s, a| outbound::send_text(s, a[0]))?,
            ),
            ("hostLabel", s.get(c"label")?),
        ],
    )?;
    s.set(c"chatWs", call(core, c"createChatWsClient", &[ws_options])?)?;
    ctl.set(
        c"disconnect",
        function(s, "disconnect", 0, 0, |s, _| {
            call(s.get(c"chatWs")?, c"disconnect", &[])
        })?,
    )?;
    ctl.set(
        c"reconnectIfRunning",
        function(s, "reconnectIfRunning", 0, 0, |s, _| {
            call(s.get(c"chatWs")?, c"reconnectIfRunning", &[])
        })?,
    )?;
    undef(s)
}
#[napi]
pub fn chat_platform_bridge_api(
    env: Env,
    ports: Unknown<'_>,
    platform: String,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let title = match platform.as_str() {
        "telegram" => "Telegram",
        "discord" => "Discord",
        _ => return Err(napi::Error::from_reason("unsupported chat platform")),
    };
    let path = p.get(c"path")?;
    let name = text(p, &format!("{platform}-config.json"))?;
    let legacy = call(path, c"join", &[p.get(c"bridgeDir")?, name])?;
    let file = call(
        p.get(c"bridgeConfig")?,
        c"bridgeConfigFile",
        &[name, legacy],
    )?;
    let cwd = call(
        path,
        c"join",
        &[
            call(p.get(c"os")?, c"homedir", &[])?,
            text(p, ".multicc")?,
            text(p, &format!("{platform}-gateway"))?,
        ],
    )?;
    let s = fields(
        p,
        &[
            ("ports", p),
            ("platform", text(p, &platform)?),
            ("label", text(p, title)?),
            ("configFile", file),
            ("cwd", cwd),
            ("sessionId", text(p, &format!("__{platform}_gateway__"))?),
            ("running", flag(p, false)?),
            ("client", null(p)?),
            ("botUserId", null(p)?),
            ("target", null(p)?),
            ("startTime", null(p)?),
            ("discord", null(p)?),
            ("logStore", null(p)?),
            ("echo", null(p)?),
            ("gateway", null(p)?),
            ("chatWs", null(p)?),
        ],
    )?;
    s.set(c"config", load_config(s, &mut [])?)?;
    let router = call(p.get(c"express")?, c"Router", &[])?;
    routes::mount(s, router)?;
    let api = methods(
        s,
        &[
            ("init", 1, init),
            ("loadConfig", 0, load_config),
            ("startBridge", 0, |s, _| {
                async_result(s, || lifecycle::start(s))
            }),
            ("stopBridge", 0, |s, _| {
                if telegram(s)? {
                    async_result(s, || lifecycle::stop(s))
                } else {
                    lifecycle::stop(s)
                }
            }),
        ],
    )?;
    // Public shape is the same five fields as the retired CommonJS adapters.
    let out = fields(s, &[("router", router)])?;
    out.spread_from(api)?;
    Ok(out.raw())
}
