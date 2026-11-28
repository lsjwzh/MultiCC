//! Built-in WeChat and Feishu adapters. Rust owns state, protocol envelopes,
//! ordering and route decisions; the host supplies only live SDK/IO values.
use crate::host_api::*;
use multicc_core::js::{string::is_js_whitespace, JsString};
use napi_derive::napi;
use std::ffi::CStr;
mod feishu;
mod memory;
mod routes;
mod wechat;

fn wx(s: L<'_>) -> Result<bool> {
    s.get(c"platform")?.is_string("wechat")
}
fn label(s: L<'_>) -> Result<&'static str> {
    Ok(if wx(s)? { "WeChat" } else { "Feishu" })
}
fn keep<'a>(v: L<'a>, fallback: L<'a>) -> Result<L<'a>> {
    Ok(if v.truthy()? { v } else { fallback })
}
fn obj<'a>(s: L<'a>, v: L<'a>) -> Result<L<'a>> {
    keep(v, fields(s, &[])?)
}
fn fail<'a>(s: L<'a>, message: &str) -> Result<L<'a>> {
    Err(error_value(s, message)?.throw_error())
}
fn clock(s: L<'_>) -> Result<L<'_>> {
    s.get(c"ports")?.get(c"now")?.call_plain(&[])
}
fn js<'a>(s: L<'a>, v: JsString) -> Result<L<'a>> {
    s.from_value(&V::String(v))
}
fn cut<'a>(v: L<'a>, n: usize) -> Result<L<'a>> {
    js(v, string(v)?.coerce_string()?.truncate_units(n))
}
fn decorate<'a>(s: L<'a>, prefix: &str, value: L<'a>, suffix: &str) -> Result<L<'a>> {
    let mut out = JsString::from_rust_str(prefix);
    out.push(&string(value)?.coerce_string()?);
    out.push_str(suffix);
    js(s, out)
}
fn preview(v: L<'_>) -> Result<L<'_>> {
    let t = string(v)?.coerce_string()?;
    if t.len() <= 200 {
        return Ok(v);
    }
    let mut p = t.truncate_units(200);
    p.push_str("…");
    js(v, p)
}
fn log<'a>(s: L<'a>, kind: &str, message: L<'a>) -> Result<L<'a>> {
    call(s.get(c"logs")?, c"push", &[text(s, kind)?, message])
}
fn log_text(s: L<'_>, kind: &str, message: &str) -> Result<()> {
    log(s, kind, text(s, message)?)?;
    Ok(())
}
fn err_text(e: L<'_>) -> Result<String> {
    fold_string(e.get(c"message")?)
}
fn sleep(s: L<'_>, ms: f64) -> Result<L<'_>> {
    s.get(c"ports")?.get(c"sleep")?.call_plain(&[num(s, ms)?])
}
fn frame<'a>(s: L<'a>, values: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let f = fields(s, &[("state", s)])?;
    f.spread_from(fields(s, values)?)?;
    Ok(f)
}
fn state(f: L<'_>) -> Result<L<'_>> {
    f.get(c"state")
}
// Undefined marks an independent REST/Feishu operation. Poll descendants carry
// the exact run object, never a mutable "currently running" boolean alone.
fn current<'a>(s: L<'a>, run: L<'a>) -> Result<bool> {
    if run.undefined()? {
        return Ok(true);
    }
    Ok(!run.nullish()?
        && s.get(c"running")?.truthy()?
        && s.get(c"run")?.equals(run)?
        && !run.get(c"stopped")?.truthy()?)
}
fn owned_frame<'a>(s: L<'a>, run: L<'a>, values: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let f = frame(s, values)?;
    f.set(c"run", run)?;
    Ok(f)
}
fn active(f: L<'_>) -> Result<bool> {
    current(state(f)?, f.get(c"run")?)
}
fn gateway(s: L<'_>) -> Result<L<'_>> {
    call(s.get(c"gateway")?, c"get", &[])
}
fn save(s: L<'_>) -> Result<L<'_>> {
    call(
        s.get(c"ports")?.get(c"bridgeConfig")?,
        c"saveBridgeConfig",
        &[s.get(c"configFile")?, s.get(c"config")?],
    )
}
fn load<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    if let Some(v) = s.catch(|| {
        let raw = call(
            s.get(c"ports")?.get(c"fs")?,
            c"readFileSync",
            &[s.get(c"configFile")?, text(s, "utf8")?],
        )?;
        json_call(s, c"parse", raw)
    })? {
        return Ok(v);
    }
    if wx(s)? {
        fields(
            s,
            &[
                ("outputIdle", num(s, 5000.)?),
                ("botToken", text(s, "")?),
                ("baseUrl", text(s, "")?),
            ],
        )
    } else {
        fields(
            s,
            &[
                ("appId", text(s, "")?),
                ("appSecret", text(s, "")?),
                ("domain", text(s, "feishu")?),
            ],
        )
    }
}
fn ws_disconnect<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    call(s.get(c"chatWs")?, c"disconnect", &[])
}
fn ws_reconnect<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    call(s.get(c"chatWs")?, c"reconnectIfRunning", &[])
}
fn get_gateway<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    gateway(s)
}
fn is_running<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    s.get(c"running")
}
fn log_callback<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    log(s, &fold_string(a[0])?, a[1])
}
fn lifecycle_log<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let message = if wx(s)? && a[1].string()?.is_some() {
        let v = fold_string(a[1])?;
        if let Some(tail) = v.strip_prefix("WeChat gateway ") {
            text(s, &format!("Gateway {tail}"))?
        } else {
            a[1]
        }
    } else {
        a[1]
    };
    log(s, &fold_string(a[0])?, message)
}
fn on_turn<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    outbound_owned(s, a[0], if wx(s)? { s.get(c"run")? } else { undef(s)? })
}
fn init<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let o = a[0];
    for k in [
        c"persistedSessions",
        c"chatSessions",
        c"savePersistedSessions",
        c"chatBroadcast",
    ] {
        s.set(k, o.get(k)?)?;
    }
    let core = s.get(c"ports")?.get(c"bridgeGateway")?;
    s.set(
        c"logs",
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
    let ctl = methods(
        s,
        &[
            ("disconnect", 0, ws_disconnect),
            ("reconnectIfRunning", 0, ws_reconnect),
        ],
    )?;
    let opts = fields(
        s,
        &[
            ("sessionId", s.get(c"sessionId")?),
            ("cwd", s.get(c"cwd")?),
            ("label", text(s, &format!("{} Gateway", label(s)?))?),
            ("platformLabel", text(s, label(s)?)?),
            ("persistedSessions", s.get(c"persistedSessions")?),
            ("chatSessions", s.get(c"chatSessions")?),
            ("savePersistedSessions", s.get(c"savePersistedSessions")?),
            ("clearBridgeHistory", o.get(c"clearBridgeHistory")?),
            (
                "bridgeHistoryFile",
                s.get(c"ports")?
                    .get(c"bridgeConfig")?
                    .get(c"bridgeHistoryFile")?,
            ),
            ("chatWsCtl", ctl),
            ("log", function(s, "log", 2, 2, lifecycle_log)?),
        ],
    )?;
    s.set(c"gateway", call(core, c"createGatewayLifecycle", &[opts])?)?;
    let opts = fields(
        s,
        &[
            ("port", keep(o.get(c"port")?, num(s, 3000.)?)?),
            ("sessionId", s.get(c"sessionId")?),
            ("getGateway", function(s, "getGateway", 0, 0, get_gateway)?),
            ("isRunning", function(s, "isRunning", 0, 0, is_running)?),
            ("log", function(s, "log", 2, 2, log_callback)?),
            ("onTurn", function(s, "onTurn", 1, 1, on_turn)?),
            ("hostLabel", text(s, label(s)?)?),
        ],
    )?;
    s.set(c"chatWs", call(core, c"createChatWsClient", &[opts])?)?;
    undef(s)
}
fn deliver<'a>(s: L<'a>, message: L<'a>) -> Result<L<'a>> {
    deliver_owned(s, message, undef(s)?)
}
fn deliver_owned<'a>(s: L<'a>, message: L<'a>, run: L<'a>) -> Result<L<'a>> {
    if !current(s, run)? {
        return resolved(undef(s)?);
    }
    let ws = s.get(c"chatWs")?;
    if !call(ws, c"isOpen", &[])?.truthy()? {
        call(ws, c"connect", &[])?;
    }
    let f = owned_frame(s, run, &[("message", message)])?;
    then(call(ws, c"ensureOpen", &[num(s, 2000.)?])?, f, |f, _| {
        if !active(f)? {
            return undef(f);
        }
        call(
            state(f)?.get(c"chatWs")?,
            c"sendUserMessage",
            &[f.get(c"message")?],
        )
    })
}
fn outbound<'a>(s: L<'a>, message: L<'a>) -> Result<L<'a>> {
    outbound_owned(s, message, undef(s)?)
}
fn outbound_owned<'a>(s: L<'a>, message: L<'a>, run: L<'a>) -> Result<L<'a>> {
    let pending = async_result(s, || {
        if !current(s, run)? {
            return undef(s);
        }
        let attached = if wx(s)? {
            s.get(c"currentUser")?.truthy()?
                && s.get(c"contextToken")?.truthy()?
                && s.get(c"client")?.truthy()?
        } else {
            s.get(c"currentChat")?.truthy()? && s.get(c"apiClient")?.truthy()?
        };
        if !attached {
            log(
                s,
                "system",
                decorate(
                    s,
                    &format!(
                        "Reply ready but no {} {} attached: ",
                        label(s)?,
                        if wx(s)? { "user" } else { "chat" }
                    ),
                    cut(message, 80)?,
                    "…",
                )?,
            )?;
            return undef(s);
        }
        let chunks = call(
            s.get(c"ports")?.get(c"bridgeGateway")?,
            c"chunkOutbound",
            &[message, fields(s, &[("max", num(s, 3800.)?)])?],
        )?;
        let f = owned_frame(s, run, &[("chunks", chunks), ("index", num(s, 0.)?)])?;
        send_chunk(f)
    })?;
    let f = owned_frame(s, run, &[])?;
    recover(pending, f, |f, a| {
        if !active(f)? {
            return undef(f);
        }
        Err(a[0].throw_error())
    })
}
fn send_chunk(f: L<'_>) -> Result<L<'_>> {
    if !active(f)? {
        return undef(f);
    }
    let s = state(f)?;
    let i = f.get(c"index")?.number()?;
    if i >= f.get(c"chunks")?.get(c"length")?.number()? {
        return undef(f);
    }
    let body = f.get(c"chunks")?.element(i as u32)?;
    call(s.get(c"echo")?, c"add", &[body])?;
    let pending = if wx(s)? {
        wechat::send_owned(
            s,
            s.get(c"currentUser")?,
            body,
            s.get(c"contextToken")?,
            f.get(c"run")?,
        )?
    } else {
        feishu::send_message(s, body)?
    };
    then(pending, f, |f, _| {
        if !active(f)? {
            return undef(f);
        }
        let s = state(f)?;
        let i = f.get(c"index")?.number()?;
        log(s, "out", preview(f.get(c"chunks")?.element(i as u32)?)?)?;
        f.set(c"index", num(f, i + 1.)?)?;
        if i + 1. < f.get(c"chunks")?.get(c"length")?.number()? {
            then(sleep(s, if wx(s)? { 500. } else { 400. })?, f, |f, _| {
                send_chunk(f)
            })
        } else {
            undef(f)
        }
    })
}
fn command<'a>(s: L<'a>, input: L<'a>) -> Result<L<'a>> {
    command_owned(s, input, undef(s)?)
}
fn command_owned<'a>(s: L<'a>, input: L<'a>, run: L<'a>) -> Result<L<'a>> {
    async_result(s, || {
        if !current(s, run)? {
            return undef(s);
        }
        command_body(s, input, run)
    })
}
fn command_body<'a>(s: L<'a>, input: L<'a>, run: L<'a>) -> Result<L<'a>> {
    let t = string(input)?.coerce_string()?.trim();
    let end = t
        .as_units()
        .iter()
        .position(|u| is_js_whitespace(*u))
        .unwrap_or(t.len());
    let command_units = t.slice_units(0, end).to_lowercase();
    let cmd = command_units.to_string_lossy();
    let rec = gateway(s)?;
    if cmd == "/reset" {
        let f = owned_frame(s, run, &[])?;
        return then(
            call(s.get(c"gateway")?, c"resetHistory", &[])?,
            f,
            |f, _| {
                if !active(f)? {
                    return undef(f);
                }
                command_reply(state(f)?, text(f, "✅ 已清空对话历史")?, f.get(c"run")?)
            },
        );
    }
    let reply = match cmd.as_str() {
        "/help" => {
            if wx(s)? {
                "📋 可用命令:\n/status — 网关状态\n/sessions — 列出 Gateway 可见的 chat session\n/reset — 清空当前对话历史\n/help — 显示此帮助".into()
            } else {
                "📋 可用命令:\n/status — 网关状态\n/reset — 清空对话历史\n/help — 显示帮助".into()
            }
        }
        "/sessions" if wx(s)? => String::new(),
        "/status" => {
            let time = s.get(if wx(s)? { c"loginTime" } else { c"startTime" })?;
            let uptime = if time.truthy()? {
                format!(
                    "{} min",
                    ((clock(s)?.number()? - time.number()?) / 60000.).floor()
                )
            } else {
                "N/A".into()
            };
            let running = if s.get(c"running")?.truthy()? {
                "运行中"
            } else {
                "已停止"
            };
            let cli = if rec.truthy()? {
                fold_string(rec.get(c"cli")?)?
            } else {
                "未创建".into()
            };
            if wx(s)? {
                format!("🔗 桥接: {running}\n📱 登录: {} ({uptime})\n🤖 Gateway: {cli}\n📂 可见 chat sessions: {}", if s.get(c"client")?.optional(c"botToken")?.truthy()? {"已登录"} else {"未登录"}, memory::routable(s)?.len())
            } else {
                format!(
                    "🔗 桥接: {running}\n📱 应用: {} ({uptime})\n🤖 Gateway: {cli}\n🔌 长连接: {}",
                    if s.get(c"config")?.get(c"appId")?.truthy()? {
                        "已配置"
                    } else {
                        "未配置"
                    },
                    if s.get(c"wsClient")?.truthy()? {
                        "已建立"
                    } else {
                        "未建立"
                    }
                )
            }
        }
        _ => format!("未知命令: {cmd}，输入 /help 查看帮助"),
    };
    let output = if wx(s)? && cmd == "/sessions" {
        js(s, memory::sessions(s)?)?
    } else if matches!(cmd.as_str(), "/help" | "/reset" | "/status") {
        text(s, &reply)?
    } else {
        let mut body = JsString::from_rust_str("未知命令: ");
        body.push(&command_units);
        body.push_str("，输入 /help 查看帮助");
        js(s, body)?
    };
    command_reply(s, output, run)
}
fn command_reply<'a>(s: L<'a>, output: L<'a>, run: L<'a>) -> Result<L<'a>> {
    if !current(s, run)?
        || (wx(s)? && (!s.get(c"currentUser")?.truthy()? || !s.get(c"contextToken")?.truthy()?))
    {
        return resolved(undef(s)?);
    }
    let f = owned_frame(s, run, &[])?;
    recover(outbound_owned(s, output, run)?, f, |f, a| {
        if !active(f)? {
            return undef(f);
        }
        let s = state(f)?;
        let prefix = if wx(s)? { "Reply send failed: " } else { "" };
        log_text(s, "error", &format!("{prefix}{}", err_text(a[0])?))?;
        undef(s)
    })
}
fn start<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        if s.get(c"running")?.truthy()? {
            return fail(s, "Bridge is already running");
        }
        if wx(s)? {
            wechat::start(s)
        } else {
            feishu::start(s)
        }
    })
}
fn stop<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    s.set(c"running", flag(s, false)?)?;
    if wx(s)? {
        wechat::stop(s)?;
    } else {
        feishu::stop(s)?;
    }
    call(s.get(c"chatWs")?, c"disconnect", &[])?;
    if wx(s)? {
        s.set(c"client", null(s)?)?;
    } else {
        s.set(c"apiClient", null(s)?)?;
    }
    log_text(
        s,
        "system",
        if wx(s)? {
            "Bridge stopped"
        } else {
            "Feishu bridge stopped"
        },
    )?;
    undef(s)
}
fn create<'a>(p: L<'a>, platform: &str) -> Result<L<'a>> {
    let s = fields(
        p,
        &[
            ("ports", p),
            ("platform", text(p, platform)?),
            ("running", flag(p, false)?),
        ],
    )?;
    for key in [
        c"persistedSessions",
        c"chatSessions",
        c"savePersistedSessions",
        c"chatBroadcast",
        c"logs",
        c"echo",
        c"gateway",
        c"chatWs",
        c"client",
        c"apiClient",
        c"wsClient",
        c"lark",
        c"pollAbort",
        c"run",
        c"currentUser",
        c"contextToken",
        c"currentChat",
        c"loginQrcode",
        c"loginQrImg",
        c"loginTime",
        c"startTime",
    ] {
        s.set(key, null(s)?)?;
    }
    s.set(c"memory", s.global()?.get(c"Map")?.construct(&[])?)?;
    let file = format!("{platform}-config.json");
    let legacy = call(
        p.get(c"path")?,
        c"join",
        &[p.get(c"legacyDir")?, text(p, &file)?],
    )?;
    s.set(
        c"configFile",
        call(
            p.get(c"bridgeConfig")?,
            c"bridgeConfigFile",
            &[text(p, &file)?, legacy],
        )?,
    )?;
    s.set(c"config", load(s, &mut [])?)?;
    s.set(
        c"sessionId",
        text(
            s,
            if wx(s)? {
                "__gateway__"
            } else {
                "__feishu_gateway__"
            },
        )?,
    )?;
    s.set(
        c"cwd",
        call(
            p.get(c"path")?,
            c"join",
            &[
                call(p.get(c"os")?, c"homedir", &[])?,
                text(p, ".multicc")?,
                text(p, if wx(s)? { "gateway" } else { "feishu-gateway" })?,
            ],
        )?,
    )?;
    s.set(c"router", call(p.get(c"express")?, c"Router", &[])?)?;
    routes::mount(s)?;
    let out = fields(s, &[("router", s.get(c"router")?)])?;
    out.spread_from(methods(
        s,
        &[
            ("init", 1, init),
            ("loadConfig", 0, load),
            ("startBridge", 0, start),
            ("stopBridge", 0, stop),
        ],
    )?)?;
    Ok(out)
}
#[napi]
pub fn wechat_bridge_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(create(L::new(&env, ports), "wechat")?.raw())
}
#[napi]
pub fn feishu_bridge_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(create(L::new(&env, ports), "feishu")?.raw())
}
