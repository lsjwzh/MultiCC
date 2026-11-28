//! Framed loopback stream, handshake, and shared socket lifecycle.
use super::*;
use std::{cell::RefCell, rc::Rc};

/// A split prefix only ever buffers four bytes. A declared length is charged
/// as data arrives, so idle connections with a large prefix allocate no body.
#[derive(Default)]
struct Reader {
    header: [u8; 4],
    used: usize,
    size: usize,
    body: Vec<u8>,
}
impl Reader {
    fn next(
        &mut self,
        chunk: &mut &[u8],
        limit: usize,
    ) -> std::result::Result<Option<Vec<u8>>, ()> {
        if self.used < 4 {
            let n = (4 - self.used).min(chunk.len());
            self.header[self.used..self.used + n].copy_from_slice(&chunk[..n]);
            *chunk = &chunk[n..];
            self.used += n;
            if self.used < 4 {
                return Ok(None);
            }
            self.size = u32::from_be_bytes(self.header) as usize;
            if self.size == 0 || self.size > limit {
                return Err(());
            }
        }
        let n = (self.size - self.body.len()).min(chunk.len());
        self.body.extend_from_slice(&chunk[..n]);
        *chunk = &chunk[n..];
        if self.body.len() < self.size {
            return Ok(None);
        }
        self.used = 0;
        Ok(Some(std::mem::take(&mut self.body)))
    }
}
fn pending<'a>(p: L<'a>, error: napi::Error) -> Result<L<'a>> {
    match p.exception_value()? {
        Some(e) => Ok(e),
        None => error_value(p, &error.reason),
    }
}
fn guarded<'a>(ctx: L<'a>, ws: L<'a>, work: impl FnOnce() -> Result<L<'a>>) -> Result<()> {
    if let Err(error) = work() {
        let e = pending(ctx, error)?;
        let msg = e.optional(c"message")?;
        let msg = string(if msg.truthy()? { msg } else { e })?;
        ctx.catch(|| log(ctx, "chat_bridge_listener_failed", msg))?;
        ctx.catch(|| call(ws, c"terminate", &[]))?;
    }
    Ok(())
}
fn log<'a>(ctx: L<'a>, event: &str, msg: L<'a>) -> Result<L<'a>> {
    let logger = ctx.get(c"logger")?;
    let f = logger.get(c"error")?;
    if !f.nullish()? {
        f.call(
            logger,
            &[text(ctx, event)?, fields(ctx, &[("message", msg)])?],
        )?;
    }
    undef(ctx)
}
fn clients(ctx: L<'_>) -> Result<L<'_>> {
    let wss = ctx.get(c"wss")?;
    if wss.truthy()? {
        wss.get(c"clients")
    } else {
        undef(ctx)
    }
}
fn peer<'a>(p: L<'a>, info: L<'a>) -> Result<L<'a>> {
    let raw = array(p)?;
    let headers = call(p.global()?.get(c"Object")?, c"create", &[null(p)?])?;
    info.get(c"headers")?.for_each(|item| {
        let (name, value) = item.iterator_pair()?;
        headers.set_key(name, value)?;
        call(raw, c"push", &[name, value])?;
        Ok(())
    })?;
    let remote = info.get(c"remoteAddress")?;
    let family = call(p.get(c"net")?, c"isIP", &[remote])?;
    let socket = fields(
        p,
        &[
            ("remoteAddress", remote),
            ("remotePort", info.get(c"remotePort")?),
            (
                "remoteFamily",
                text(
                    p,
                    if family.is_number(6.)? {
                        "IPv6"
                    } else {
                        "IPv4"
                    },
                )?,
            ),
            ("localAddress", info.get(c"localAddress")?),
            ("localPort", info.get(c"localPort")?),
            ("encrypted", flag(p, false)?),
        ],
    )?;
    fields(
        p,
        &[
            ("method", text(p, "GET")?),
            ("url", info.get(c"url")?),
            ("httpVersion", text(p, "1.1")?),
            ("headers", headers),
            ("rawHeaders", raw),
            ("socket", socket),
            ("connection", socket),
        ],
    )
}
fn dispatch<'a>(ctx: L<'a>, fr: L<'a>) -> Result<()> {
    let p = ctx.get(c"ports")?;
    let sockets = ctx.get(c"sockets")?;
    let id = fr.get(c"conn")?;
    let kind = fr.get(c"kind")?.number()? as u8;
    if kind == wire::KIND_OPEN {
        if call(sockets, c"has", &[id])?.truthy()? {
            frame_err(p, "duplicate connection id")?;
        }
        let info = fr.get(c"info")?;
        let ws = p
            .get(c"BridgeSocket")?
            .construct(&[ctx.get(c"bridge")?, id, info])?;
        call(sockets, c"set", &[id, ws])?;
        let list = clients(ctx)?;
        if list.truthy()? {
            call(list, c"add", &[ws])?;
        }
        let req = peer(p, info)?;
        guarded(ctx, ws, || ctx.get(c"onConnection")?.call_plain(&[ws, req]))?;
        return Ok(());
    }
    let ws = call(sockets, c"get", &[id])?;
    if !ws.truthy()? {
        return Ok(());
    }
    match kind {
        wire::KIND_MESSAGE => guarded(ctx, ws, || {
            call(
                ws,
                c"emit",
                &[text(p, "message")?, fr.get(c"data")?, fr.get(c"binary")?],
            )
        })?,
        wire::KIND_PONG => guarded(ctx, ws, || {
            call(ws, c"emit", &[text(p, "pong")?, from_bytes(p, &[])?])
        })?,
        wire::KIND_SENT => {
            call(ws, c"_complete", &[fr.get(c"seq")?, fr.get(c"error")?])?;
        }
        wire::KIND_CLOSED => guarded(ctx, ws, || {
            call(
                ws,
                c"_finish",
                &[
                    fr.get(c"code")?,
                    fr.get(c"received")?,
                    fr.get(c"sent")?,
                    fr.get(c"reason")?,
                ],
            )
        })?,
        _ => {
            frame_err(p, "unexpected kind")?;
        }
    }
    Ok(())
}
fn lose<'a>(ctx: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    if ctx.get(c"lost")?.truthy()? {
        return undef(ctx);
    }
    ctx.set(c"lost", flag(ctx, true)?)?;
    call(ctx.global()?, c"clearTimeout", &[ctx.get(c"timer")?])?;
    call(ctx.get(c"socket")?, c"destroy", &[])?;
    if !ctx.get(c"live")?.truthy()? {
        ctx.get(c"reject")?.call_plain(&[reason])?;
        return undef(ctx);
    }
    let sockets = ctx.get(c"sockets")?;
    let values = call(
        ctx.global()?.get(c"Array")?,
        c"from",
        &[call(sockets, c"values", &[])?],
    )?;
    values.for_each(|ws| {
        guarded(ctx, ws, || {
            call(
                ws,
                c"_finish",
                &[
                    num(ctx, 1006.)?,
                    flag(ctx, false)?,
                    flag(ctx, false)?,
                    text(ctx, "")?,
                ],
            )
        })
    })?;
    call(sockets, c"clear", &[])?;
    let lost = ctx.get(c"onLost")?;
    if callable(lost)? {
        lost.call_plain(&[reason])?;
    }
    undef(ctx)
}
fn write<'a>(ctx: L<'a>, body: &[u8]) -> Result<L<'a>> {
    call(
        ctx.get(c"socket")?,
        c"write",
        &[from_bytes(ctx, &wire::frame(body))?],
    )
}
fn live(ctx: L<'_>) -> Result<()> {
    ctx.set(c"live", flag(ctx, true)?)?;
    call(ctx.global()?, c"clearTimeout", &[ctx.get(c"timer")?])?;
    let bridge = methods(
        ctx,
        &[
            ("_write", 1, |ctx, a| {
                if !ctx.get(c"lost")?.truthy()?
                    && !ctx.get(c"socket")?.get(c"destroyed")?.truthy()?
                {
                    let body = a[0];
                    let length = uint(body.get(c"length")?)?;
                    let packet = prepend(ctx, &length.to_be_bytes(), body)?;
                    call(ctx.get(c"socket")?, c"write", &[packet])?;
                }
                undef(ctx)
            }),
            ("_forget", 2, |ctx, a| {
                let sockets = ctx.get(c"sockets")?;
                if call(sockets, c"get", &[a[0]])?.equals(a[1])? {
                    call(sockets, c"delete", &[a[0]])?;
                }
                let list = clients(ctx)?;
                if list.truthy()? {
                    call(list, c"delete", &[a[1]])?;
                }
                undef(ctx)
            }),
        ],
    )?;
    ctx.set(c"bridge", bridge)?;
    let handle = methods(
        ctx,
        &[
            ("sockets", 0, |ctx, _| ctx.get(c"sockets")?.get(c"size")),
            ("end", 0, |ctx, _| {
                lose(ctx, error_value(ctx, "chat bridge ended")?)
            }),
        ],
    )?;
    let desc = fields(
        ctx,
        &[
            ("enumerable", flag(ctx, true)?),
            ("configurable", flag(ctx, true)?),
            (
                "get",
                function(ctx, "get lost", 0, 0, |ctx, _| ctx.get(c"lost"))?,
            ),
        ],
    )?;
    call(
        ctx.global()?.get(c"Object")?,
        c"defineProperty",
        &[handle, text(ctx, "lost")?, desc],
    )?;
    ctx.get(c"resolve")?.call_plain(&[handle])?;
    Ok(())
}
fn handshake<'a>(ctx: L<'a>, body: &[u8]) -> Result<()> {
    let p = ctx.get(c"ports")?;
    let s = String::from_utf8_lossy(body);
    let json = json_call(p, c"parse", text(p, &s)?)?;
    let nonce = ctx.get(c"nonce")?;
    let cap = ctx.get(c"capability")?;
    if nonce.undefined()? {
        if !json.string()?.is_some_and(|v| v.len() == 32) {
            return Err(error_value(p, "bad nonce")?.throw_error());
        }
        ctx.set(c"nonce", json)?;
        let proof = sign(p, cap, call(text(p, "child:")?, c"concat", &[json])?)?;
        let raw = fold_string(json_call(p, c"stringify", proof)?)?;
        write(ctx, raw.as_bytes())?;
        return Ok(());
    }
    let expected = sign(p, cap, call(text(p, "parent:")?, c"concat", &[nonce])?)?;
    if !multicc_core::auth_security::timing_safe_equal_text(
        &fold_string(json)?,
        &fold_string(expected)?,
    ) {
        return Err(error_value(p, "front door failed the capability proof")?.throw_error());
    }
    live(ctx)
}
fn feed<'a>(ctx: L<'a>, reader: &RefCell<Reader>, chunk: L<'a>) -> Result<L<'a>> {
    let result = (|| -> Result<()> {
        let chunk = bytes(chunk)?;
        let mut rest = chunk.as_slice();
        while !rest.is_empty() && !ctx.get(c"lost")?.truthy()? {
            let live = ctx.get(c"live")?.truthy()?;
            let next = reader.borrow_mut().next(
                &mut rest,
                if live {
                    wire::MAX_BODY
                } else {
                    multicc_core::auth_control::MAX_FRAME
                },
            );
            let body = match next {
                Ok(Some(body)) => body,
                Ok(None) => break,
                Err(()) if live => {
                    frame_err(ctx.get(c"ports")?, "bad frame length")?;
                    unreachable!()
                }
                Err(()) => return Err(error_value(ctx, "bad handshake frame")?.throw_error()),
            };
            if live {
                let p = ctx.get(c"ports")?;
                dispatch(ctx, decode(p, &body, None)?)?;
            } else {
                handshake(ctx, &body)?;
            }
        }
        Ok(())
    })();
    if let Err(err) = result {
        let e = pending(ctx, err)?;
        if ctx.get(c"live")?.truthy()? {
            ctx.catch(|| log(ctx, "chat_bridge_protocol_error", e.optional(c"message")?))?;
        }
        return lose(ctx, e);
    }
    undef(ctx)
}
pub(super) fn connect<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let o = a[0];
        let ctx = fields(
            p,
            &[
                ("ports", p),
                ("capability", o.get(c"capability")?),
                ("onConnection", o.get(c"onConnection")?),
                ("onLost", o.get(c"onLost")?),
                ("wss", o.get(c"wss")?),
                (
                    "logger",
                    with_default(o.get(c"logger")?, p.global()?.get(c"console")?)?,
                ),
                ("lost", flag(p, false)?),
                ("sockets", p.global()?.get(c"Map")?.construct(&[])?),
            ],
        )?;
        let socket = call(
            p.get(c"net")?,
            c"connect",
            &[fields(
                p,
                &[("host", text(p, "127.0.0.1")?), ("port", o.get(c"port")?)],
            )?],
        )?;
        ctx.set(c"socket", socket)?;
        call(socket, c"setNoDelay", &[flag(p, true)?])?;
        let executor = function(ctx, "connected", 2, 2, |ctx, a| {
            ctx.set(c"resolve", a[0])?;
            ctx.set(c"reject", a[1])?;
            let r = Rc::new(RefCell::new(Reader::default()));
            let socket = ctx.get(c"socket")?;
            let on_data = function(ctx, "feed", 1, 1, move |ctx, a| feed(ctx, &r, a[0]))?;
            let on_close = function(ctx, "closed", 0, 0, |ctx, _| {
                let msg = if ctx.get(c"live")?.truthy()? {
                    "chat bridge closed"
                } else {
                    "stream closed"
                };
                lose(ctx, error_value(ctx, msg)?)
            })?;
            let on_end = function(ctx, "ended", 0, 0, |ctx, _| {
                if ctx.get(c"live")?.truthy()? {
                    return undef(ctx);
                }
                lose(ctx, error_value(ctx, "stream ended")?)
            })?;
            let on_error = function(ctx, "error", 1, 1, |ctx, a| lose(ctx, a[0]))?;
            for (name, cb) in [
                ("data", on_data),
                ("close", on_close),
                ("end", on_end),
                ("error", on_error),
            ] {
                call(socket, c"on", &[text(ctx, name)?, cb])?;
            }
            let timeout = function(ctx, "handshakeTimeout", 0, 0, |ctx, _| {
                lose(ctx, error_value(ctx, "chat bridge handshake timed out")?)
            })?;
            let ms = multicc_core::auth_control::TIMEOUT.as_millis() as f64;
            ctx.set(
                c"timer",
                call(ctx.global()?, c"setTimeout", &[timeout, num(ctx, ms)?])?,
            )?;
            undef(ctx)
        })?;
        p.global()?.get(c"Promise")?.construct(&[executor])
    })
}
