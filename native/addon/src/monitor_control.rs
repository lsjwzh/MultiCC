//! Stream-json Monitor initialization and callback protocol over live host
//! processes. All protocol decisions and Promise callbacks are native-owned.
use crate::{host_methods::method, js_iteration::read, route_response::*};
use napi_derive::napi;
use std::ffi::CStr;

fn undefined(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Undefined)
}

fn optional<'a>(value: L<'a>, key: &CStr) -> Result<L<'a>> {
    if value.nullish()? {
        undefined(value)
    } else {
        read(value, key)
    }
}

fn callback<'a>(
    owner: L<'a>,
    name: &'static str,
    length: usize,
    count: usize,
    run: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let env = Env::from_raw(owner.env());
    let value = method(&env, owner, name, length, count, run)?;
    Ok(L::from_raw(owner.env(), value.raw()))
}

fn array<'a>(s: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    let out = s.from_value(&V::Array(vec![]))?;
    for (i, value) in values.iter().enumerate() {
        out.define_key(text(s, &i.to_string())?, *value)?;
    }
    Ok(out)
}

fn write<'a>(s: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let stdin = read(s.get(c"proc")?, c"stdin")?;
    let writer = read(stdin, c"write")?;
    let serialized = call(s.global()?.get(c"JSON")?, c"stringify", &[value])?;
    let mut line = serialized.coerce_string()?;
    line.push(&"\n".into());
    crate::js_live::invoke(
        stdin,
        writer,
        &[s.from_value(&V::String(line))?],
        "proc.stdin.write",
    )
}

fn accept<'a>(s: L<'a>, event: L<'a>) -> Result<L<'a>> {
    if read(event, c"type")?.is_string("control_response")?
        && optional(read(event, c"response")?, c"request_id")?.equals(s.get(c"requestId")?)?
    {
        if read(read(event, c"response")?, c"subtype")?.is_string("success")? {
            s.assign(c"ready", flag(s, true)?)?;
            s.get(c"resolve")?.call_plain(&[])?;
        } else {
            s.get(c"fail")?.call_plain(&[])?;
        }
        return flag(s, true);
    }
    if !read(event, c"type")?.is_string("control_request")?
        || !optional(read(event, c"request")?, c"subtype")?.is_string("hook_callback")?
        || !read(read(event, c"request")?, c"callback_id")?.equals(s.get(c"callbackId")?)?
    {
        return flag(s, false);
    }
    let state = fields(s, &[("proc", s.get(c"proc")?), ("event", event)])?;
    let reply = callback(state, "", 1, 1, |s, a| {
        let proc = s.get(c"proc")?;
        if !read(read(proc, c"stdin")?, c"destroyed")?.truthy()?
            && !read(read(proc, c"stdin")?, c"writableEnded")?.truthy()?
        {
            let response = fields(
                s,
                &[
                    ("subtype", text(s, "success")?),
                    ("request_id", read(s.get(c"event")?, c"request_id")?),
                    ("response", a[0]),
                ],
            )?;
            write(
                s,
                fields(
                    s,
                    &[
                        ("type", text(s, "control_response")?),
                        ("response", response),
                    ],
                )?,
            )?;
        }
        undefined(s)
    })?;
    let failed = callback(state, "", 0, 0, |s, _| {
        s.catch(|| {
            let response = fields(
                s,
                &[
                    ("subtype", text(s, "error")?),
                    ("request_id", read(s.get(c"event")?, c"request_id")?),
                    ("error", text(s, "Monitor admission failed")?),
                ],
            )?;
            write(
                s,
                fields(
                    s,
                    &[
                        ("type", text(s, "control_response")?),
                        ("response", response),
                    ],
                )?,
            )
        })?;
        undefined(s)
    })?;
    let pending = crate::monitor_admission::run_hook(s, read(read(event, c"request")?, c"input")?)?;
    call(call(pending, c"then", &[reply])?, c"catch", &[failed])?;
    flag(s, true)
}

#[napi]
pub fn monitor_control_api(env: Env, random_uuid: Unknown<'_>) -> Result<sys::napi_value> {
    let uuid = L::new(&env, random_uuid);
    let api = fields(
        uuid,
        &[
            ("uuid", uuid),
            (
                "callbackId",
                text(uuid, crate::monitor_admission::MONITOR_CALLBACK_ID)?,
            ),
        ],
    )?;
    let create = callback(api, "createMonitorControl", 3, 3, |api, a| {
        let request_id = api.get(c"uuid")?.call_plain(&[])?;
        let s = fields(
            api,
            &[
                ("proc", a[0]),
                ("requestId", request_id),
                ("deliver", a[1]),
                ("isOwn", a[2]),
                ("callbackId", api.get(c"callbackId")?),
                ("ready", flag(api, false)?),
            ],
        )?;
        let executor = callback(s, "", 2, 2, |s, a| {
            s.set(c"resolve", a[0])?;
            s.set(c"reject", a[1])?;
            undefined(s)
        })?;
        let initialized = s.global()?.get(c"Promise")?.construct(&[executor])?;
        let fail = callback(s, "fail", 0, 0, |s, _| {
            let error = s
                .global()?
                .get(c"Error")?
                .construct(&[text(s, "Monitor hook initialization failed")?])?;
            let error = call(
                s.global()?.get(c"Object")?,
                c"assign",
                &[
                    error,
                    fields(s, &[("code", text(s, "MONITOR_INIT_FAILED")?)])?,
                ],
            )?;
            s.get(c"reject")?.call_plain(&[error])
        })?;
        s.set(c"fail", fail)?;
        let timer = s
            .global()?
            .get(c"setTimeout")?
            .call_plain(&[fail, num(s, 10_000.0)?])?;
        s.set(c"timer", timer)?;
        call(a[0], c"once", &[text(s, "exit")?, fail])?;
        let cleanup = callback(s, "", 0, 0, |s, _| {
            s.global()?
                .get(c"clearTimeout")?
                .call_plain(&[s.get(c"timer")?])?;
            call(
                s.get(c"proc")?,
                c"removeListener",
                &[text(s, "exit")?, s.get(c"fail")?],
            )?;
            undefined(s)
        })?;
        let ignore = callback(s, "", 0, 0, |s, _| undefined(s))?;
        call(
            call(initialized, c"finally", &[cleanup])?,
            c"catch",
            &[ignore],
        )?;
        let hook_callbacks = array(
            s,
            &[fields(
                s,
                &[("hookCallbackIds", array(s, &[s.get(c"callbackId")?])?)],
            )?],
        )?;
        let request = fields(
            s,
            &[
                ("subtype", text(s, "initialize")?),
                ("hooks", fields(s, &[("UserPromptSubmit", hook_callbacks)])?),
            ],
        )?;
        write(
            s,
            fields(
                s,
                &[
                    ("type", text(s, "control_request")?),
                    ("request_id", request_id),
                    ("request", request),
                ],
            )?,
        )?;
        let out = fields(
            s,
            &[
                ("initialized", initialized),
                (
                    "accept",
                    callback(s, "accept", 1, 1, |s, a| accept(s, a[0]))?,
                ),
            ],
        )?;
        let descriptor = fields(
            s,
            &[
                (
                    "get",
                    callback(s, "get ready", 0, 0, |s, _| s.get(c"ready"))?,
                ),
                ("enumerable", flag(s, true)?),
                ("configurable", flag(s, true)?),
            ],
        )?;
        call(
            s.global()?.get(c"Object")?,
            c"defineProperty",
            &[out, text(s, "ready")?, descriptor],
        )?;
        Ok(out)
    })?;
    Ok(fields(api, &[("createMonitorControl", create)])?.raw())
}
