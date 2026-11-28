//! Lifecycle and NDJSON control plane for resident plugins attached to the Node host.
use crate::host_api::*;
use napi_derive::napi;
use std::ffi::CStr;
mod alert;
mod lifecycle;
mod protocol;
mod view;

fn value_or<'a>(value: L<'a>, other: L<'a>) -> Result<L<'a>> {
    Ok(if value.truthy()? { value } else { other })
}
fn cap(v: L<'_>, limit: f64) -> Result<L<'_>> {
    if v.string()?.is_some() {
        call(v, c"slice", &[num(v, 0.)?, num(v, limit)?])
    } else {
        text(v, "")
    }
}
fn normalize<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let v = a[0];
    if !v.truthy()? || !object(v)? || v.is_array()? {
        return null(p);
    }
    let label = cap(v.get(c"label")?, 40.)?;
    if !label.truthy()? {
        return null(p);
    }
    let platforms = v.get(c"platforms")?;
    let accepted = array(p)?;
    if platforms.is_array()? {
        platforms.for_each(|v| {
            if v.string()?.is_some() {
                call(accepted, c"push", &[v])?;
            }
            Ok(())
        })?;
    }
    fields(
        p,
        &[
            ("label", label),
            ("labelEn", fallback(cap(v.get(c"labelEn")?, 40.)?, V::Null)?),
            (
                "platforms",
                if accepted.get(c"length")?.truthy()? {
                    accepted
                } else {
                    null(p)?
                },
            ),
        ],
    )
}
fn unsupported<'a>(spec: L<'a>, platform: L<'a>) -> Result<L<'a>> {
    if !spec.get(c"binary")?.truthy()? {
        return text(spec, "binary-missing");
    }
    let channel = spec.get(c"channel")?.optional(c"platforms")?;
    if channel.truthy()? && !call(channel, c"includes", &[platform])?.truthy()? {
        return text(spec, "platform");
    }
    let required = spec.get(c"requires")?.optional(c"platforms")?;
    if required.is_array()? && required.get(c"length")?.truthy()? {
        let mut found = false;
        required.for_each_while(|row| {
            found = row.truthy()? && row.get(c"os")?.equals(platform)?;
            Ok(!found)
        })?;
        if !found {
            return text(spec, "platform");
        }
    }
    null(spec)
}
fn map(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"Map")?.construct(&[])
}
fn get<'a>(m: L<'a>, id: L<'a>) -> Result<L<'a>> {
    call(m, c"get", &[id])
}
fn clock(p: L<'_>) -> Result<L<'_>> {
    p.get(c"now")?.call_plain(&[])
}
fn log<'a>(p: L<'a>, level: &CStr, name: &str, detail: L<'a>) -> Result<()> {
    call(p.get(c"logger")?, level, &[text(p, name)?, detail])?;
    Ok(())
}
fn timeout<'a>(ctx: L<'a>, ms: L<'a>, act: Action) -> Result<L<'a>> {
    timer(ctx, c"setTimeout", ms, act)
}
fn timer<'a>(ctx: L<'a>, method: &CStr, ms: L<'a>, act: Action) -> Result<L<'a>> {
    let cb = function(ctx, "", 0, 0, act)?;
    let t = ctx.global()?.get(method)?.call_plain(&[cb, ms])?;
    let unref = t.optional(c"unref")?;
    if callable(unref)? {
        unref.call(t, &[])?;
    }
    Ok(t)
}
fn clear(p: L<'_>, key: &CStr) -> Result<()> {
    p.global()?
        .get(c"clearTimeout")?
        .call_plain(&[p.get(key)?])?;
    Ok(())
}
fn caught_error<'a>(p: L<'a>, error: napi::Error) -> Result<L<'a>> {
    if let Some(cause) = p.exception_value()? {
        Ok(cause)
    } else {
        error_value(p, &error.reason)
    }
}
fn to_array(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Array")?, c"from", &[v])
}
fn empty<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    undef(p)
}
fn start<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    if s.get(c"stopped")?.truthy()? {
        s.set(c"stopped", flag(s, false)?)?;
        lifecycle::reconcile(s)?;
        s.set(
            c"rescanTimer",
            timer(s, c"setInterval", s.get(c"rescanMs")?, |s, _| {
                lifecycle::reconcile(s)
            })?,
        )?;
    }
    undef(s)
}
fn stop<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    if !s.get(c"stopped")?.truthy()? {
        s.set(c"stopped", flag(s, true)?)?;
        s.global()?
            .get(c"clearInterval")?
            .call_plain(&[s.get(c"rescanTimer")?])?;
        let records = s.get(c"records")?;
        call(records, c"values", &[])?.for_each(lifecycle::stop_record)?;
        call(records, c"clear", &[])?;
    }
    undef(s)
}
fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let o = a[0];
    for k in [c"discover", c"dataDir", c"logger"] {
        if !o.truthy()? || !o.get(k)?.truthy()? {
            return Err(ports.type_error(&format!(
                "[channel-host] {} is required",
                k.to_string_lossy()
            )));
        }
    }
    let s = fields(
        ports,
        &[
            ("process", ports.get(c"process")?),
            ("path", ports.get(c"path")?),
            ("records", map(ports)?),
            ("skipped", map(ports)?),
            ("stopped", flag(ports, true)?),
            ("rescanTimer", null(ports)?),
            ("nextRequestId", num(ports, 1.)?),
        ],
    )?;
    for k in [c"discover", c"dataDir", c"logger"] {
        s.set(k, o.get(k)?)?;
    }
    for (key, default) in [
        (c"platform", ports.get(c"process")?.get(c"platform")?),
        (c"spawn", ports.get(c"spawn")?),
        (c"now", ports.global()?.get(c"Date")?.get(c"now")?),
        (c"alert", function(ports, "alert", 0, 0, empty)?),
        (c"baseUrl", null(ports)?),
        (c"backoffMs", ports.get(c"backoff")?),
        (c"rescanMs", num(s, 30000.)?),
        (c"healthyAfterMs", num(s, 60000.)?),
        (c"downAlertMs", num(s, 60000.)?),
        (c"requestTimeoutMs", num(s, 20000.)?),
        (c"stopGraceMs", num(s, 3000.)?),
    ] {
        s.set(key, with_default(o.get(key)?, default)?)?;
    }
    methods(
        s,
        &[
            ("start", 0, start),
            ("stop", 0, stop),
            ("reconcile", 0, |s, _| lifecycle::reconcile(s)),
            ("run", 3, protocol::run),
            ("isResident", 1, |s, a| {
                flag(
                    s,
                    call(s.get(c"records")?, c"has", &[a[0]])?.truthy()?
                        || call(s.get(c"skipped")?, c"has", &[a[0]])?.truthy()?,
                )
            }),
            ("status", 0, |s, _| view::status(s)),
            ("targets", 0, view::targets),
            ("deliver", 2, protocol::deliver),
            ("checkTarget", 2, view::check_target),
        ],
    )
}
#[napi]
pub fn channel_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let backoff = array(p)?;
    for (i, n) in [1000., 5000., 30000., 300000.].iter().enumerate() {
        backoff.set_element(i as u32, num(p, *n)?)?;
    }
    p.set(c"backoff", backoff.freeze()?)?;
    let out = fields(p, &[("PROTOCOL", num(p, 1.)?), ("BACKOFF_MS", backoff)])?;
    out.spread_from(methods(
        p,
        &[
            ("createChannelHost", 1, create),
            ("normalizeChannel", 1, normalize),
            ("unsupportedReason", 2, |_, a| unsupported(a[0], a[1])),
        ],
    )?)?;
    Ok(out.raw())
}
