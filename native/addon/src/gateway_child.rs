//! The private streaming boundary consumes at most the PROXY v1 header.
//! Application bytes remain on the original Node socket.
use crate::{
    host_methods::{async_result, function},
    route_response::*,
};
use multicc_core::network_policy::is_ip;
use napi::bindgen_prelude::BufferSlice;
use napi_derive::napi;

const PREFIX: &[u8] = b"PROXY ";
const MAX_HEADER: usize = 107;
fn port(text: &str) -> Option<u16> {
    if text.is_empty() || text.len() > 5 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}
fn peer<'a>(p: L<'a>, line: &str) -> Result<L<'a>> {
    let mut parts = line.split(' ');
    let (
        Some("PROXY"),
        Some(protocol),
        Some(remote),
        Some(local),
        Some(source_port),
        Some(dest_port),
        None,
    ) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    )
    else {
        return null(p);
    };
    let family = match protocol {
        "TCP4" => 4,
        "TCP6" => 6,
        _ => return null(p),
    };
    if is_ip(remote) != family || is_ip(local) != family {
        return null(p);
    }
    let (Some(source_port), Some(dest_port)) = (port(source_port), port(dest_port)) else {
        return null(p);
    };
    fields(
        p,
        &[
            ("remoteAddress", text(p, remote)?),
            ("remotePort", num(p, source_port.into())?),
            (
                "remoteFamily",
                text(p, if family == 4 { "IPv4" } else { "IPv6" })?,
            ),
            ("localAddress", text(p, local)?),
            ("localPort", num(p, dest_port.into())?),
        ],
    )
}
#[napi]
pub fn gateway_proxy_peer(env: Env, line: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, line);
    Ok(peer(p, &p.coerce_string()?.to_string_lossy())?.raw())
}
#[napi]
pub fn gateway_internal_port(value: String) -> Option<u32> {
    port(&value).filter(|v| *v > 0).map(u32::from)
}
#[napi]
pub struct GatewayProxyReader {
    bytes: Vec<u8>,
}
#[napi]
impl GatewayProxyReader {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            bytes: Vec::with_capacity(MAX_HEADER),
        }
    }
    /// null means incomplete, false means refused. The returned offset refers
    /// to the current chunk; the host can unshift its suffix without copying.
    #[napi]
    pub fn feed(
        &mut self,
        env: Env,
        chunk: BufferSlice<'_>,
        anchor: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let p = L::new(&env, anchor);
        for (i, &byte) in chunk.iter().enumerate() {
            let len = self.bytes.len();
            if len >= MAX_HEADER || (len < PREFIX.len() && byte != PREFIX[len]) {
                return Ok(flag(p, false)?.raw());
            }
            self.bytes.push(byte);
            if self.bytes.ends_with(b"\r\n") {
                let line = &self.bytes[..self.bytes.len() - 2];
                let parsed = peer(p, std::str::from_utf8(line).unwrap_or(""))?;
                if parsed.nullish()? {
                    return Ok(flag(p, false)?.raw());
                }
                return Ok(
                    fields(p, &[("peer", parsed), ("offset", num(p, (i + 1) as f64)?)])?.raw(),
                );
            }
            if self.bytes.len() == MAX_HEADER {
                return Ok(flag(p, false)?.raw());
            }
        }
        Ok(null(p)?.raw())
    }
}

fn schedule(s: L<'_>) -> Result<()> {
    if s.get(c"stopped")?.truthy()? || s.get(c"timer")?.truthy()? {
        return Ok(());
    }
    let delay = s.get(c"delay")?.number()?;
    let tick = function(s, "retry", 0, 0, |s, _| {
        s.set(c"timer", null(s)?)?;
        attempt(s)
    })?;
    let timer = call(s.global()?, c"setTimeout", &[tick, num(s, delay)?])?;
    s.set(c"timer", timer)?;
    if timer.optional(c"unref")?.truthy()? {
        call(timer, c"unref", &[])?;
    }
    s.set(c"delay", num(s, (delay * 2.).min(2000.))?)
}
fn warn<'a>(s: L<'a>, kind: &str, error: L<'a>) -> Result<()> {
    let logger = s.get(c"logger")?;
    if !logger.get(c"warn")?.nullish()? {
        let message = error.optional(c"message")?;
        call(
            logger,
            c"warn",
            &[
                text(s, kind)?,
                fields(
                    s,
                    &[(
                        "error",
                        string(if message.truthy()? { message } else { error })?,
                    )],
                )?,
            ],
        )?;
    }
    Ok(())
}
fn attempt(s: L<'_>) -> Result<L<'_>> {
    let connect = async_result(s, || {
        s.get(c"connect")?.call_plain(&[s.get(c"connection")?])
    })?;
    let ready = function(s, "connected", 1, 1, |s, a| {
        if s.get(c"stopped")?.truthy()? {
            if a[0].truthy()? {
                call(a[0], c"end", &[])?;
            }
        } else {
            s.set(c"handle", a[0])?;
            s.set(c"delay", num(s, 100.)?)?;
        }
        s.from_value(&V::Undefined)
    })?;
    let failed = function(s, "failed", 1, 1, |s, a| {
        warn(s, "chat_bridge_connect_failed", a[0])?;
        schedule(s)?;
        s.from_value(&V::Undefined)
    })?;
    call(connect, c"then", &[ready, failed])?;
    s.from_value(&V::Undefined)
}
#[napi]
pub fn start_gateway_chat_bridge(env: Env, options: Unknown<'_>) -> Result<sys::napi_value> {
    let s = L::new(&env, options);
    let bootstrap = s.get(c"bootstrap")?;
    let port = bootstrap.optional(c"port")?;
    if !port
        .number_value()?
        .is_some_and(|n| n > 0. && n.fract() == 0.)
        || !bootstrap.get(c"capability")?.truthy()?
    {
        return Ok(null(s)?.raw());
    }
    let wss = s.get(c"wss")?;
    let connection = fields(
        s,
        &[
            ("port", port),
            ("capability", bootstrap.get(c"capability")?),
            ("logger", s.get(c"logger")?),
            ("wss", wss),
            (
                "onConnection",
                function(wss, "onConnection", 2, 2, |w, a| {
                    call(w, c"emit", &[text(w, "connection")?, a[0], a[1]])
                })?,
            ),
            (
                "onLost",
                function(s, "onLost", 1, 1, |s, a| {
                    warn(s, "chat_bridge_lost", a[0])?;
                    schedule(s)?;
                    s.from_value(&V::Undefined)
                })?,
            ),
        ],
    )?;
    s.set(c"connection", connection)?;
    s.set(c"delay", num(s, 100.)?)?;
    attempt(s)?;
    Ok(fields(
        s,
        &[(
            "stop",
            function(s, "stop", 0, 0, |s, _| {
                s.set(c"stopped", flag(s, true)?)?;
                if s.get(c"timer")?.truthy()? {
                    call(s.global()?, c"clearTimeout", &[s.get(c"timer")?])?;
                }
                if s.get(c"handle")?.truthy()? {
                    call(s.get(c"handle")?, c"end", &[])?;
                    s.set(c"handle", null(s)?)?;
                }
                s.from_value(&V::Undefined)
            })?,
        )],
    )?
    .raw())
}
#[napi]
pub fn gateway_lifeline(env: Env, options: Unknown<'_>) -> Result<sys::napi_value> {
    let s = L::new(&env, options);
    let fire = function(s, "fire", 0, 0, |s, _| {
        if s.get(c"hasHandler")?.call_plain(&[])?.truthy()? {
            return s.get(c"signal")?.call_plain(&[]);
        }
        let timer = call(
            s.global()?,
            c"setTimeout",
            &[s.get(c"fire")?, s.get(c"retryMs")?],
        )?;
        call(timer, c"unref", &[])?;
        s.from_value(&V::Undefined)
    })?;
    s.set(c"fire", fire)?;
    Ok(function(s, "lost", 0, 0, |s, _| {
        if !s.get(c"lost")?.truthy()? {
            s.set(c"lost", flag(s, true)?)?;
            call(
                s.get(c"logger")?,
                c"warn",
                &[
                    text(s, "gateway_lifeline_lost")?,
                    fields(s, &[("action", text(s, "graceful-shutdown")?)])?,
                ],
            )?;
            call(s, c"fire", &[])?;
        }
        s.from_value(&V::Undefined)
    })?
    .raw())
}
