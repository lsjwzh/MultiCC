//! The internal HTTP port is restricted before any operation reads host state.
use super::*;

pub(super) fn public_base(v: L<'_>) -> Result<L<'_>> {
    let default = text(v, LOOPBACK)?;
    let normalized = v.catch(|| {
        let input = string(or(v, default)?)?;
        let url = v.global()?.get(c"URL")?.construct(&[input])?;
        let protocol = url.get(c"protocol")?;
        if !protocol.is_string("http:")? && !protocol.is_string("https:")? {
            return Ok(default);
        }
        url.get(c"origin")
    })?;
    Ok(normalized.unwrap_or(default))
}
pub(super) fn base(p: L<'_>) -> Result<L<'_>> {
    let get = p.get(c"getBaseUrl")?;
    if get.undefined()? {
        text(p, LOOPBACK)
    } else {
        public_base(get.call_plain(&[])?)
    }
}
fn launch(p: L<'_>) -> Result<L<'_>> {
    fields(
        p,
        &[
            ("command", p.get(c"nodePath")?),
            ("script", p.get(c"acpAgentPath")?),
            ("baseUrl", base(p)?),
        ],
    )
}
pub(super) fn as_object(v: L<'_>) -> Result<L<'_>> {
    if object(v)? && !v.is_array()? {
        Ok(v)
    } else {
        fields(v, &[])
    }
}
pub(super) fn options(body: L<'_>) -> Result<L<'_>> {
    pick(
        as_object(body.get(c"options")?)?,
        &[c"enabled", c"provider", c"commanderSessionId"],
    )
}
pub(super) fn install_flag(body: L<'_>) -> Result<L<'_>> {
    fields(
        body,
        &[(
            "installIfNeeded",
            flag(body, body.get(c"autoInstall")?.is_true()?)?,
        )],
    )
}
pub(super) fn rejected(r: L<'_>) -> Result<L<'_>> {
    fields(r, &[("ok", flag(r, false)?), ("code", r.get(c"code")?)])
}
fn directory_failure(r: L<'_>) -> Result<L<'_>> {
    let resp = rejected(r)?;
    let ids = r.get(c"gatewayIds")?;
    if ids.truthy()? {
        resp.set(c"gatewayIds", ids)?;
    }
    Ok(resp)
}
pub(super) fn thrown<'a>(res: L<'a>, e: L<'a>) -> Result<L<'a>> {
    send(
        res,
        None,
        fields(
            res,
            &[(
                "thrown",
                fields(
                    res,
                    &[
                        ("code", e.optional(c"code")?),
                        ("message", string(or(e.optional(c"message")?, e)?)?),
                    ],
                )?,
            )],
        )?,
    )
}
pub(super) fn guarded<'a>(res: L<'a>, f: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    match f() {
        Ok(v) => Ok(v),
        Err(err) => {
            let cause = match res.exception_value()? {
                Some(e) => e,
                None => error_value(res, &err.reason)?,
            };
            thrown(res, cause)
        }
    }
}
pub(super) fn ignore_rejection(v: L<'_>) -> Result<()> {
    recover(v, v, |p, _| undef(p))?;
    Ok(())
}
pub(super) fn authorized<'a>(p: L<'a>, req: L<'a>) -> Result<bool> {
    p.get(c"isLocalRequest")?.call_plain(&[req])?.truthy()
}
fn handler<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let req = a[0];
    let res = a[1];
    if !authorized(p, req)? {
        return error(res, 404, "not found", false);
    }
    let b = as_object(req.get(c"body")?)?;
    let op = b.get(c"op")?;
    let service = p.get(c"service")?;
    if op.is_string("list")? {
        return send(
            res,
            None,
            fields(
                p,
                &[
                    ("gateways", call(service, c"list", &[])?),
                    ("launch", launch(p)?),
                ],
            )?,
        );
    }
    if op.is_string("inspect")? {
        let r = call(service, c"inspect", &[b.get(c"id")?])?;
        let result = if ok(r)? {
            fields(
                p,
                &[
                    ("ok", flag(p, true)?),
                    ("gateway", r.get(c"gateway")?),
                    ("launch", launch(p)?),
                ],
            )?
        } else {
            directory_failure(r)?
        };
        return send(res, None, result);
    }
    if op.is_string("ensure")? {
        return guarded(res, || {
            let id = b.get(c"id")?;
            let r = call(service, c"ensure", &[id, options(b)?])?;
            if !ok(r)? {
                return send(res, None, directory_failure(r)?);
            }
            opt_call(p.get(c"runtime")?, c"reconcile", &[id, install_flag(b)?])?;
            send(
                res,
                None,
                fields(
                    p,
                    &[
                        ("ok", flag(p, true)?),
                        ("created", r.get(c"created")?),
                        ("gateway", r.get(c"gateway")?),
                        ("launch", launch(p)?),
                    ],
                )?,
            )
        });
    }
    if op.is_string("remove")? {
        return guarded(res, || {
            let id = b.get(c"id")?;
            let r = call(service, c"remove", &[id])?;
            if !ok(r)? {
                return send(res, None, directory_failure(r)?);
            }
            ignore_rejection(opt_call(p.get(c"runtime")?, c"stop", &[id])?)?;
            send(res, None, r)
        });
    }
    error(res, 400, "unknown host operation", false)
}
pub(super) fn mount<'a>(s: L<'a>, app: L<'a>, runtime: bool) -> Result<L<'a>> {
    if !callable(app.optional(c"post")?)? {
        return Err(s.type_error(if runtime {
            "[voice-runtime-host] Express-compatible app is required"
        } else {
            "[voice-gateway-host] Express-compatible app is required"
        }));
    }
    let (path, h) = if runtime {
        (
            RUNTIME_PATH,
            function(s, "", 2, 2, |s, a| {
                async_result(s, || runtime::handler(s, a))
            })?,
        )
    } else {
        (GATEWAY_PATH, function(s, "", 2, 2, handler)?)
    };
    call(app, c"post", &[text(s, path)?, h])?;
    undef(s)
}
pub(super) fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let persistence = opts.get(c"sessionPersistence")?;
    if !callable(persistence.optional(c"mutate")?)? {
        return Err(ports.type_error("[voice-gateway-host] sessionPersistence.mutate is required"));
    }
    let input = pick(opts, &[c"records", c"directories"])?;
    input.set(
        c"mutate",
        function(persistence, "mutate", 2, 2, |p, a| call(p, c"mutate", a))?,
    )?;
    let service = call(
        ports.get(c"domain")?,
        c"createVoiceGatewayService",
        &[input],
    )?;
    let s = pick(opts, &[c"runtime", c"getBaseUrl"])?;
    s.set(c"service", service)?;
    s.set(c"isLocalRequest", ports.get(c"isLocalRequest")?)?;
    s.set(
        c"nodePath",
        with_default(
            opts.get(c"nodePath")?,
            s.global()?.get(c"process")?.get(c"execPath")?,
        )?,
    )?;
    s.set(
        c"acpAgentPath",
        with_default(opts.get(c"acpAgentPath")?, ports.get(c"acpAgentPath")?)?,
    )?;
    let out = methods(s, &[("mountRoutes", 1, |s, a| mount(s, a[0], false))])?;
    out.set(c"service", service)?;
    out.set(c"provider", text(s, PROVIDER)?)?;
    out.freeze()
}
