//! An instance is bound to one data root. The generation invalidates delayed
//! probes and the mutation tail serializes manual and automatic Funnel changes.
mod config;
mod ledger;
mod monitor;
mod providers;

use crate::host_methods::{async_result, default_object, function as callback};
use crate::route_response::*;
use napi_derive::napi;
use std::ffi::CStr;

const NAMES: &[&str] = &["phddns", "tailscale", "natapp", "cpolar", "sakurafrp"];
fn undef(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Undefined)
}
fn now(s: L<'_>) -> Result<f64> {
    call(s.global()?.get(c"Date")?, c"now", &[])?.number()
}
fn printable(v: L<'_>) -> Result<String> {
    Ok(string(v)?.coerce_string()?.to_string_lossy())
}
fn print(s: L<'_>, level: &CStr, msg: &str) -> Result<()> {
    call(s.global()?.get(c"console")?, level, &[text(s, msg)?])?;
    Ok(())
}
fn bind<'a>(
    s: L<'a>,
    api: L<'a>,
    key: &'static CStr,
    len: usize,
    count: usize,
    run: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<()> {
    api.set(key, callback(s, key.to_str().unwrap(), len, count, run)?)
}
fn then<'a>(
    f: L<'a>,
    v: L<'a>,
    next: impl for<'b> Fn(L<'b>, L<'b>) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let p = call(f.global()?.get(c"Promise")?, c"resolve", &[v])?;
    call(
        p,
        c"then",
        &[callback(f, "", 1, 1, move |f, a| next(f, a[0]))?],
    )
}
fn paths<'a>(s: L<'a>, data_dir: L<'a>) -> Result<L<'a>> {
    crate::app_paths::create(s.get(c"ports")?, data_dir)
}
fn availability(s: L<'_>) -> Result<L<'_>> {
    providers::availability(s)
}
fn invalidate(s: L<'_>) -> Result<()> {
    s.set(c"generation", num(s, s.get(c"generation")?.number()? + 1.)?)
}
fn clear_probe(s: L<'_>) -> Result<()> {
    let p = s.get(c"probe")?;
    if p.truthy()? {
        call(p, c"clearCache", &[])?;
    }
    Ok(())
}
fn invalidate_funnel(s: L<'_>) -> Result<()> {
    invalidate(s)?;
    config::reset_evidence(s.get(c"states")?.get(c"tailscale")?)?;
    clear_probe(s)
}
fn with_mutation<'a>(s: L<'a>, task: L<'a>) -> Result<L<'a>> {
    let work = call(s.get(c"tailscaleQueue")?, c"then", &[task, task])?;
    let drain = callback(s, "", 0, 0, |s, _| undef(s))?;
    s.set(c"tailscaleQueue", call(work, c"then", &[drain, drain])?)?;
    Ok(work)
}
fn clear_timer(s: L<'_>) -> Result<()> {
    let t = s.get(c"timer")?;
    if t.truthy()? {
        call(s.global()?, c"clearInterval", &[t])?;
        s.set(c"timer", null(s)?)?;
    }
    Ok(())
}
fn start_loop(s: L<'_>) -> Result<()> {
    invalidate(s)?;
    clear_timer(s)?;
    let cfg = s.get(c"config")?;
    let mut enabled = false;
    for name in NAMES {
        let provider = cfg.get_key(text(s, name)?)?;
        if provider.get(c"enabled")?.is_true()?
            || (*name == "tailscale" && provider.get(c"funnel")?.is_true()?)
        {
            enabled = true;
            break;
        }
    }
    if enabled {
        let sec = cfg
            .get(c"intervalSec")?
            .number_value()?
            .filter(|v| v.fract() == 0. && (10.0..=2147483.0).contains(v))
            .unwrap_or(30.);
        let tick = callback(s, "tick", 0, 0, |s, _| {
            async_result(s, || monitor::tick(s, 0))
        })?;
        let timer = call(s.global()?, c"setInterval", &[tick, num(s, sec * 1000.)?])?;
        s.set(c"timer", timer)?;
        if timer.get(c"unref")?.truthy()? {
            call(timer, c"unref", &[])?;
        }
    }
    Ok(())
}
fn init(s: L<'_>) -> Result<L<'_>> {
    config::load(s)?;
    start_loop(s)?;
    let available = availability(s)?;
    let cfg = s.get(c"config")?;
    let mut parts = Vec::new();
    for name in NAMES {
        let key = text(s, name)?;
        let enabled = cfg.get_key(key)?.get(c"enabled")?.truthy()?;
        parts.push(format!(
            "{}:{}/{}",
            name,
            if enabled { "on" } else { "off" },
            if available.get_key(key)?.truthy()? {
                "installed"
            } else {
                "missing"
            }
        ));
    }
    print(
        s,
        c"log",
        &format!("[multicc/tunnel] monitor ready ({})", parts.join(", ")),
    )?;
    undef(s)
}
#[napi]
pub fn tunnel_monitor_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let s = crate::js_live::spread(ports)?;
    s.set(c"ports", ports)?;
    let dir = s.get(c"process")?.get(c"env")?.get(c"MULTICC_DATA_DIR")?;
    let locations = paths(s, dir)?;
    s.set(c"configFile", locations.get(c"tunnelConfigFile")?)?;
    s.set(c"ledgerFile", locations.get(c"tunnelRepairLedgerFile")?)?;
    s.set(c"timer", null(s)?)?;
    s.set(c"probe", null(s)?)?;
    s.set(c"generation", num(s, 0.)?)?;
    s.set(
        c"tailscaleQueue",
        call(s.global()?.get(c"Promise")?, c"resolve", &[])?,
    )?;
    providers::prepare(s)?;
    config::initialize(s)?;
    ledger::initialize(s)?;
    let api = fields(s, &[])?;
    bind(s, api, c"init", 0, 0, |s, _| init(s))?;
    bind(s, api, c"stop", 0, 0, |s, _| {
        invalidate(s)?;
        clear_probe(s)?;
        clear_timer(s)?;
        undef(s)
    })?;
    bind(s, api, c"applyConfig", 1, 2, |s, a| {
        config::apply(s, a[0], a[1])
    })?;
    bind(s, api, c"getStatus", 0, 0, |s, _| config::status(s))?;
    bind(s, api, c"restartNow", 1, 2, |s, a| {
        async_result(s, || monitor::restart_now(s, a[0], default_object(a[1])?))
    })?;
    bind(s, api, c"checkProvider", 1, 2, |s, a| {
        async_result(s, || monitor::check(s, a[0], default_object(a[1])?))
    })?;
    providers::install(s, api)?;
    bind(s, api, c"loadConfig", 0, 0, |s, _| config::load(s))?;
    bind(s, api, c"setFailureReporter", 1, 1, |s, a| {
        config::set_reporter(s, a[0])?;
        undef(s)
    })?;
    let public = fields(s, &[])?;
    for name in [
        "init",
        "stop",
        "applyConfig",
        "getStatus",
        "restartNow",
        "checkProvider",
        "restartPhddns",
        "restartTailscale",
        "reapplyTailscaleFunnel",
        "restartNatapp",
        "restartCpolar",
        "restartSakurafrp",
        "sakuraAccess",
        "sakuraApplyPublicUrl",
        "loadConfig",
        "availability",
        "defaultFrpcDest",
        "setFunnel",
        "funnelStatus",
        "ipv6Status",
        "setFailureReporter",
    ] {
        let key = text(s, name)?;
        public.set_key(key, api.get_key(key)?)?;
    }
    Ok(public.raw())
}
