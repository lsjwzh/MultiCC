//! One multiplexed private chat stream. Buffers and EventEmitter instances stay
//! in the caller's realm; the wire grammar is shared with the front door.
use crate::host_api::*;
use multicc_core::chat_bridge::{self as wire, DecodeError, ToGateway, ToNode};
use napi_derive::napi;
mod socket;
mod stream;
pub(super) fn buf(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"Buffer")
}
fn from_bytes<'a>(p: L<'a>, bytes: &[u8]) -> Result<L<'a>> {
    let mut value = std::ptr::null_mut();
    napi::check_status!(unsafe {
        sys::napi_create_buffer_copy(
            p.env(),
            bytes.len(),
            bytes.as_ptr().cast(),
            std::ptr::null_mut(),
            &mut value,
        )
    })?;
    Ok(L::from_raw(p.env(), value))
}
fn bytes(v: L<'_>) -> Result<Vec<u8>> {
    let mut ptr = std::ptr::null_mut();
    let mut length = 0usize;
    napi::check_status!(unsafe {
        sys::napi_get_buffer_info(v.env(), v.raw(), &mut ptr, &mut length)
    })?;
    if length == 0 {
        return Ok(Vec::new());
    }
    Ok(unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), length) }.to_vec())
}
fn uint(v: L<'_>) -> Result<u32> {
    let n = v.number()?;
    Ok(if n.is_finite() {
        n.trunc().rem_euclid(4294967296.) as u32
    } else {
        0
    })
}
fn frame_err<'a>(p: L<'a>, why: &str) -> Result<L<'a>> {
    Err(p
        .get(c"FrameError")?
        .construct(&[text(p, why)?])?
        .throw_error())
}
fn decode<'a>(p: L<'a>, data: &[u8], original: Option<L<'a>>) -> Result<L<'a>> {
    let Some(&kind) = data.first() else {
        return frame_err(p, "empty frame");
    };
    let conn = || num(p, u32::from_be_bytes(data[1..5].try_into().unwrap()) as f64);
    let base = || fields(p, &[("kind", num(p, kind.into())?), ("conn", conn()?)]);
    if kind == wire::KIND_OPEN {
        if data.len() < 5 {
            return frame_err(p, "truncated frame");
        }
        let Ok(json) = std::str::from_utf8(&data[5..]) else {
            return frame_err(p, "invalid UTF-8");
        };
        let Some(info) = p.catch(|| json_call(p, c"parse", text(p, without_bom(json))?))? else {
            return frame_err(p, "bad JSON");
        };
        let out = base()?;
        out.set(c"info", info)?;
        return Ok(out);
    }
    if kind == wire::KIND_MESSAGE {
        if data.len() < 6 {
            return frame_err(p, "truncated frame");
        }
        if data[5] > 1 {
            return frame_err(p, "bad flag");
        }
        let out = base()?;
        out.set(c"binary", flag(p, data[5] == 1)?)?;
        // The public decoder returns a view of its input. The stream reader
        // owns a private Vec, so its listener gets an independent Buffer.
        let payload = match original {
            Some(body) => call(body, c"subarray", &[num(p, 6.)?])?,
            None => from_bytes(p, &data[6..])?,
        };
        out.set(c"data", payload)?;
        return Ok(out);
    }
    let frame = match ToNode::decode(data) {
        Ok(value) => value,
        Err(err) => {
            return frame_err(
                p,
                &match err {
                    DecodeError::Empty => "empty frame".into(),
                    DecodeError::UnknownKind(k) => format!("unknown kind {k}"),
                    DecodeError::Truncated => "truncated frame".into(),
                    DecodeError::TrailingBytes => "trailing bytes".into(),
                    DecodeError::BadFlag => "bad flag".into(),
                    DecodeError::BadUtf8 => "invalid UTF-8".into(),
                    DecodeError::BadJson => "bad JSON".into(),
                },
            )
        }
    };
    let out = base()?;
    match frame {
        ToNode::Closed {
            code,
            received,
            sent,
            reason,
            ..
        } => {
            out.set(c"code", num(p, code.into())?)?;
            out.set(c"received", flag(p, received)?)?;
            out.set(c"sent", flag(p, sent)?)?;
            out.set(c"reason", text(p, without_bom(&reason))?)?;
        }
        ToNode::Sent { seq, error, .. } => {
            out.set(c"seq", num(p, seq.into())?)?;
            out.set(
                c"error",
                match error {
                    Some(s) => text(p, without_bom(&s))?,
                    None => null(p)?,
                },
            )?;
        }
        ToNode::Pong { .. } => {}
        _ => unreachable!(),
    }
    Ok(out)
}
fn without_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}
fn prepend<'a>(p: L<'a>, prefix: &[u8], payload: L<'a>) -> Result<L<'a>> {
    let buffers = array(p)?;
    buffers.set_element(0, from_bytes(p, prefix)?)?;
    buffers.set_element(1, payload)?;
    call(buf(p)?, c"concat", &[buffers])
}
fn encode_send<'a>(p: L<'a>, id: L<'a>, seq: L<'a>, binary: L<'a>, data: L<'a>) -> Result<L<'a>> {
    let b = buf(p)?;
    let payload = if call(b, c"isBuffer", &[data])?.truthy()? {
        data
    } else {
        call(b, c"from", &[data])?
    };
    let header = ToGateway::Send {
        conn: uint(id)?,
        seq: uint(seq)?,
        binary: binary.truthy()?,
        data: Vec::new(),
    }
    .encode();
    prepend(p, &header, payload)
}
fn encode_close<'a>(p: L<'a>, id: L<'a>, code: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    let data = call(
        buf(p)?,
        c"from",
        &[fallback(reason, "".into())?, text(p, "utf8")?],
    )?;
    let mut out = ToGateway::Close {
        conn: uint(id)?,
        code: None,
        reason: String::new(),
    }
    .encode();
    out.extend(bytes(data)?);
    let out = from_bytes(p, &out)?;
    call(
        out,
        c"writeUInt16BE",
        &[
            if code.nullish()? { num(p, 0.)? } else { code },
            num(p, 5.)?,
        ],
    )?;
    Ok(out)
}
fn simple<'a>(p: L<'a>, id: L<'a>, ping: bool) -> Result<L<'a>> {
    let conn = uint(id)?;
    let msg = if ping {
        ToGateway::Ping { conn }
    } else {
        ToGateway::Terminate { conn }
    };
    from_bytes(p, &msg.encode())
}
fn valid(code: L<'_>) -> Result<bool> {
    let n = code.number()?;
    Ok((1000. ..=1014.).contains(&n)
        && !(code.is_number(1004.)? || code.is_number(1005.)? || code.is_number(1006.)?)
        || (3000. ..=4999.).contains(&n))
}
fn sign<'a>(p: L<'a>, s: L<'a>, msg: L<'a>) -> Result<L<'a>> {
    if s.kind()? == sys::ValueType::napi_string
        && s.truthy()?
        && msg.kind()? == sys::ValueType::napi_string
    {
        return text(
            p,
            &multicc_core::auth_security::sign(&fold_string(s)?, &fold_string(msg)?),
        );
    }
    let h = call(p.get(c"crypto")?, c"createHmac", &[text(p, "sha256")?, s])?;
    call(h, c"update", &[msg])?;
    call(h, c"digest", &[text(p, "base64url")?])
}
#[napi]
pub fn gateway_chat_bridge_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    socket::install(&env, p.get(c"BridgeSocket")?.get(c"prototype")?)?;
    let api = methods(
        p,
        &[
            ("connectChatBridge", 1, stream::connect),
            ("decodeToNode", 1, |p, a| {
                decode(p, &bytes(a[0])?, Some(a[0]))
            }),
            ("encodeClose", 3, |p, a| encode_close(p, a[0], a[1], a[2])),
            ("encodeSend", 4, |p, a| {
                encode_send(p, a[0], a[1], a[2], a[3])
            }),
            ("encodePing", 1, |p, a| simple(p, a[0], true)),
            ("encodeTerminate", 1, |p, a| simple(p, a[0], false)),
            ("sign", 2, |p, a| sign(p, a[0], a[1])),
            ("validCloseCode", 1, |p, a| flag(p, valid(a[0])?)),
        ],
    )?;
    for k in [c"BridgeSocket", c"FrameError"] {
        api.set(k, p.get(k)?)?;
    }
    let kinds = fields(p, &[])?;
    for (k, n) in [
        (c"open", wire::KIND_OPEN),
        (c"message", wire::KIND_MESSAGE),
        (c"pong", wire::KIND_PONG),
        (c"closed", wire::KIND_CLOSED),
        (c"sent", wire::KIND_SENT),
        (c"send", wire::KIND_SEND),
        (c"close", wire::KIND_CLOSE),
        (c"terminate", wire::KIND_TERMINATE),
        (c"ping", wire::KIND_PING),
    ] {
        kinds.set(k, num(p, n.into())?)?;
    }
    api.set(c"KIND", kinds.freeze()?)?;
    api.set(
        c"READY",
        fields(
            p,
            &[
                ("CONNECTING", num(p, 0.)?),
                ("OPEN", num(p, 1.)?),
                ("CLOSING", num(p, 2.)?),
                ("CLOSED", num(p, 3.)?),
            ],
        )?
        .freeze()?,
    )?;
    Ok(api.raw())
}
