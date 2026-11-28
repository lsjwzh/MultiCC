//! The ws-compatible EventEmitter prototype. Native methods take their live
//! receiver so subclass overrides and public event state remain observable.
use super::*;
use napi::bindgen_prelude::ToNapiValue;

#[napi]
pub fn initialize_gateway_bridge_socket(
    env: Env,
    socket: Unknown<'_>,
    bridge: Unknown<'_>,
    connection: Unknown<'_>,
    peer: Unknown<'_>,
) -> Result<()> {
    let s = L::new(&env, socket);
    s.set(c"_bridge", L::new(&env, bridge))?;
    s.set(c"_conn", L::new(&env, connection))?;
    s.set(c"readyState", num(s, 1.)?)?;
    for k in [c"protocol", c"extensions", c"url"] {
        s.set(k, text(s, "")?)?;
    }
    s.set(c"_pending", s.global()?.get(c"Map")?.construct(&[])?)?;
    for k in [c"_nextSeq", c"_buffered"] {
        s.set(k, num(s, 0.)?)?;
    }
    for k in [c"_closeFrameReceived", c"_closeFrameSent"] {
        s.set(k, flag(s, false)?)?;
    }
    s.set(c"_closeCode", num(s, 1006.)?)?;
    s.set(c"_closeReason", from_bytes(s, &[])?)?;
    call(
        s.global()?.get(c"Object")?,
        c"defineProperty",
        &[
            s,
            text(s, "_peer")?,
            fields(s, &[("value", L::new(&env, peer))])?,
        ],
    )?;
    Ok(())
}
fn payload(data: L<'_>) -> Result<L<'_>> {
    let b = buf(data)?;
    if call(b, c"isBuffer", &[data])?.truthy()? {
        return Ok(data);
    }
    let arr = data.global()?.get(c"ArrayBuffer")?;
    if data.kind()? == sys::ValueType::napi_string || data.instance_of(arr)? {
        return call(b, c"from", &[data]);
    }
    if call(arr, c"isView", &[data])?.truthy()? {
        return call(
            b,
            c"from",
            &[
                data.get(c"buffer")?,
                data.get(c"byteOffset")?,
                data.get(c"byteLength")?,
            ],
        );
    }
    call(b, c"from", &[string(data)?, text(data, "utf8")?])
}
fn send<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (opts, cb) = if callable(a[1])? {
        (undef(s)?, a[1])
    } else {
        (a[1], a[2])
    };
    let ready = s.get(c"readyState")?;
    if !ready.is_number(1.)? {
        if callable(cb)? {
            let name = match ready.number()? as i32 {
                0 => "CONNECTING",
                1 => "OPEN",
                2 => "CLOSING",
                3 => "CLOSED",
                _ => "undefined",
            };
            let err = error_value(
                s,
                &format!(
                    "WebSocket is not open: readyState {} ({name})",
                    fold_string(ready)?
                ),
            )?;
            call(s.global()?.get(c"process")?, c"nextTick", &[cb, err])?;
        }
        return undef(s);
    }
    let data = payload(a[0])?;
    let option = if object(opts)? {
        opts.optional(c"binary")?
    } else {
        undef(s)?
    };
    let binary = if option.undefined()? {
        flag(s, a[0].kind()? != sys::ValueType::napi_string)?
    } else {
        option
    };
    let seq = s.get(c"_nextSeq")?;
    s.set(c"_nextSeq", num(s, uint(seq)?.wrapping_add(1).into())?)?;
    let length = data.get(c"length")?;
    call(
        s.get(c"_pending")?,
        c"set",
        &[seq, fields(s, &[("callback", cb), ("bytes", length)])?],
    )?;
    s.set(
        c"_buffered",
        num(s, s.get(c"_buffered")?.number()? + length.number()?)?,
    )?;
    call(
        s.get(c"_bridge")?,
        c"_write",
        &[encode_send(s, s.get(c"_conn")?, seq, binary, data)?],
    )?;
    undef(s)
}
fn close<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let ready = s.get(c"readyState")?;
    if ready.is_number(2.)? || ready.is_number(3.)? {
        return undef(s);
    }
    if !a[0].undefined()? && !valid(a[0])? {
        return Err(s.type_error("First argument must be a valid error code number"));
    }
    let reason = if a[1].undefined()? {
        text(s, "")?
    } else {
        string(a[1])?
    };
    if call(buf(s)?, c"byteLength", &[reason])?.number()? > 123. {
        return Err(s
            .global()?
            .get(c"RangeError")?
            .construct(&[text(s, "The message must not be greater than 123 bytes")?])?
            .throw_error());
    }
    s.set(c"readyState", num(s, 2.)?)?;
    s.set(c"_closeFrameSent", flag(s, true)?)?;
    call(
        s.get(c"_bridge")?,
        c"_write",
        &[encode_close(s, s.get(c"_conn")?, a[0], reason)?],
    )?;
    undef(s)
}
fn control(s: L<'_>, ping: bool) -> Result<L<'_>> {
    let ready = s.get(c"readyState")?;
    if (ping && !ready.is_number(1.)?) || (!ping && ready.is_number(3.)?) {
        return undef(s);
    }
    if !ping {
        s.set(c"readyState", num(s, 2.)?)?;
    }
    call(
        s.get(c"_bridge")?,
        c"_write",
        &[simple(s, s.get(c"_conn")?, ping)?],
    )?;
    undef(s)
}
fn complete<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let pending = s.get(c"_pending")?;
    let entry = call(pending, c"get", &[a[0]])?;
    if entry.truthy()? {
        call(pending, c"delete", &[a[0]])?;
        s.set(
            c"_buffered",
            num(
                s,
                s.get(c"_buffered")?.number()? - entry.get(c"bytes")?.number()?,
            )?,
        )?;
        let cb = entry.get(c"callback")?;
        if callable(cb)? {
            let err = if a[1].truthy()? {
                s.global()?.get(c"Error")?.construct(&[a[1]])?
            } else {
                undef(s)?
            };
            s.catch(|| cb.call(entry, &[err]))?;
        }
    }
    undef(s)
}
fn finish<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if s.get(c"readyState")?.is_number(3.)? {
        return undef(s);
    }
    s.set(c"readyState", num(s, 3.)?)?;
    s.set(c"_closeFrameReceived", a[1])?;
    s.set(
        c"_closeFrameSent",
        if a[2].truthy()? {
            a[2]
        } else {
            s.get(c"_closeFrameSent")?
        },
    )?;
    call(s.get(c"_pending")?, c"keys", &[])?.for_each(|seq| {
        call(
            s,
            c"_complete",
            &[
                seq,
                text(s, "WebSocket is not open: readyState 3 (CLOSED)")?,
            ],
        )?;
        Ok(())
    })?;
    call(s.get(c"_bridge")?, c"_forget", &[s.get(c"_conn")?, s])?;
    let reason = call(
        buf(s)?,
        c"from",
        &[fallback(a[3], "".into())?, text(s, "utf8")?],
    )?;
    call(s, c"emit", &[text(s, "close")?, a[0], reason])?;
    undef(s)
}
pub(super) fn install<'a>(env: &'a Env, proto: L<'a>) -> Result<()> {
    let obj = proto.global()?.get(c"Object")?;
    let entries: &[(&'static str, usize, Action)] = &[
        ("send", 3, send),
        ("ping", 0, |s, _| control(s, true)),
        ("close", 2, close),
        ("terminate", 0, |s, _| control(s, false)),
        ("_complete", 2, complete),
        ("_finish", 4, finish),
        ("bufferedAmount", 0, |s, _| s.get(c"_buffered")),
    ];
    for &(name, count, run) in entries {
        let f = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
            name,
            move |ctx| {
                let s = L::new(ctx.env, ctx.this()?);
                let mut args = Vec::with_capacity(count);
                for i in 0..count {
                    args.push(if i < ctx.length() {
                        L::new(ctx.env, ctx.get(i)?)
                    } else {
                        undef(s)?
                    });
                }
                Ok(run(s, &mut args)?.raw())
            },
        )?;
        let f = L::new(env, f.into_unknown(env)?);
        call(
            obj,
            c"defineProperty",
            &[
                f,
                text(proto, "length")?,
                fields(proto, &[("value", num(proto, count as f64)?)])?,
            ],
        )?;
        let desc = fields(proto, &[("configurable", flag(proto, true)?)])?;
        if name == "bufferedAmount" {
            desc.set(c"get", f)?;
        } else {
            desc.set(c"value", f)?;
            desc.set(c"writable", flag(proto, true)?)?;
        }
        call(obj, c"defineProperty", &[proto, text(proto, name)?, desc])?;
    }
    Ok(())
}
