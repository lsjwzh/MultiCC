//! Async I/O is scheduled on the existing Node ports. Rust chooses endpoints,
//! validates replies and owns every continuation and cleanup decision.
use super::*;

pub(super) fn request<'a>(p: L<'a>, path: L<'a>, options: L<'a>) -> Result<L<'a>> {
    async_result(p, || {
        let controller = p.global()?.get(c"AbortController")?.construct(&[])?;
        let q = fields(p, &[("p", p), ("controller", controller)])?;
        let timer = p.get(c"ports")?.get(c"setTimeout")?.call_plain(&[
            function(q, "abortRequest", 0, 0, |q, _| {
                call(q.get(c"controller")?, c"abort", &[])
            })?,
            p.get(c"httpTimeout")?,
        ])?;
        unref(timer)?;
        q.set(c"timer", timer)?;
        let task = async_result(q, || {
            let init = spread(options)?;
            init.set(c"signal", controller.get(c"signal")?)?;
            let headers = fields(p, &[])?;
            if !options.get(c"body")?.undefined()? {
                headers.set_key(text(p, "Content-Type")?, text(p, "application/json")?)?;
            }
            if p.get(c"token")?.truthy()? {
                headers.set_key(text(p, "x-access-token")?, p.get(c"token")?)?;
            }
            headers.spread_from(options.get(c"headers")?)?;
            init.set(c"headers", headers)?;
            let mut url = p.get(c"root")?.coerce_string()?;
            url.push(&path.coerce_string()?);
            p.get(c"fetch")?.call_plain(&[js(p, url)?, init])
        })?;
        let task = then(task, q, |q, a| {
            let r = fields(q, &[("q", q), ("response", a[0])])?;
            let body = async_result(r, || call(a[0], c"json", &[]))?;
            let body = recover(body, r, |r, _| fields(r, &[]))?;
            then(body, r, |r, a| {
                let response = r.get(c"response")?;
                if !response.get(c"ok")?.truthy()? {
                    return Err(public_error(a[0], response.get(c"status")?)?.throw_error());
                }
                Ok(a[0])
            })
        })?;
        let task = recover(task, q, |q, a| {
            if a[0].optional(c"status")?.truthy()? {
                return Err(a[0].throw_error());
            }
            let aborted = q
                .get(c"controller")?
                .get(c"signal")?
                .get(c"aborted")?
                .truthy()?;
            Err(http_error(
                q,
                if aborted {
                    "multicc_request_timeout"
                } else {
                    "multicc_request_failed"
                },
                if aborted { 504. } else { 503. },
            )?
            .throw_error())
        })?;
        finish_with(task, q, |q, _| {
            q.get(c"p")?
                .get(c"ports")?
                .get(c"clearTimeout")?
                .call_plain(&[q.get(c"timer")?])
        })
    })
}
fn encoded(v: L<'_>) -> Result<String> {
    fold_string(v.global()?.get(c"encodeURIComponent")?.call_plain(&[v])?)
}
pub(super) fn gateway(p: L<'_>) -> Result<L<'_>> {
    let path = format!(
        "/api/v1/directories/{}/voice-gateway",
        encoded(p.get(c"directory")?)?
    );
    then(request(p, text(p, &path)?, fields(p, &[])?)?, p, |p, a| {
        let value = a[0].optional(c"gateway")?;
        if !value.truthy()?
            || !value.get(c"directoryId")?.equals(p.get(c"directory")?)?
            || !value.get(c"enabled")?.is_true()?
        {
            return Err(http_error(p, "voice_gateway_unavailable", 409.)?.throw_error());
        }
        if !value.optional(c"binding")?.optional(c"ready")?.truthy()?
            || clean(value.get(c"commanderSessionId")?)?.is_empty()
        {
            let code = or(
                value.optional(c"binding")?.optional(c"code")?,
                text(p, "commander_binding_invalid")?,
            )?;
            return Err(public_error(fields(p, &[("error", code)])?, num(p, 409.)?)?.throw_error());
        }
        Ok(value)
    })
}
pub(super) fn gateway_method<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || gateway(p))
}
pub(super) fn refresh<'a>(s: L<'a>, launch: L<'a>) -> Result<L<'a>> {
    let p = s.get(c"p")?;
    let result = if p.get(c"launchMode")?.truthy()? {
        let id = clean_value(launch)?;
        if !id.truthy()? {
            return Err(http_error(p, "voice_launch_required", 400.)?.throw_error());
        }
        let path = format!("/api/v1/voice-gateway/launch/{}", encoded(id)?);
        then(request(p, text(p, &path)?, fields(p, &[])?)?, s, |s, a| {
            let context = a[0].optional(c"context")?;
            if !context.truthy()? || clean(context.get(c"targetSessionId")?)?.is_empty() {
                return Err(http_error(s, "voice_launch_unresolved", 409.)?.throw_error());
            }
            let target = fields(
                s,
                &[
                    ("sessionId", context.get(c"targetSessionId")?),
                    (
                        "key",
                        text(
                            s,
                            if context.get(c"scope")?.is_string("chat")? {
                                "chat"
                            } else {
                                "global"
                            },
                        )?,
                    ),
                    ("scope", context.get(c"scope")?),
                    ("directoryId", or(context.get(c"directoryId")?, null(s)?)?),
                    (
                        "commanderSessionId",
                        or(context.get(c"commanderSessionId")?, null(s)?)?,
                    ),
                    ("display", or(context.get(c"display")?, text(s, "")?)?),
                ],
            )?;
            retarget(s, target)?;
            Ok(context)
        })?
    } else {
        then(gateway(p)?, s, |s, a| {
            s.set(c"gatewayRecord", a[0])?;
            retarget(s, fleet_target(a[0])?)?;
            undef(s)
        })?
    };
    Ok(result)
}
pub(super) fn fleet_target(g: L<'_>) -> Result<L<'_>> {
    fields(
        g,
        &[
            ("sessionId", g.get(c"commanderSessionId")?),
            ("key", g.get(c"id")?),
            ("scope", text(g, "fleet")?),
        ],
    )
}
fn retarget<'a>(s: L<'a>, next: L<'a>) -> Result<()> {
    if !s
        .get(c"target")?
        .optional(c"sessionId")?
        .equals(next.get(c"sessionId")?)?
    {
        close_socket(s)?;
    }
    s.set(c"target", next)
}
pub(super) fn cancel_queued<'a>(p: L<'a>, target: L<'a>, client: L<'a>) -> Result<L<'a>> {
    let path = format!("/api/sessions/{}/queue/action", encoded(target)?);
    let body = fields(
        p,
        &[
            ("action", text(p, "cancel_queued")?),
            (
                "entryId",
                text(
                    p,
                    &kernel::queue_entry(&target.coerce_string()?, &client.coerce_string()?),
                )?,
            ),
            ("confirm", flag(p, true)?),
            (
                "reason",
                text(p, "voice ACP session cancelled before execution")?,
            ),
        ],
    )?;
    let options = fields(
        p,
        &[
            ("method", text(p, "POST")?),
            ("body", json_call(p, c"stringify", body)?),
        ],
    )?;
    recover(request(p, text(p, &path)?, options)?, p, |p, a| {
        let status = a[0].optional(c"status")?.number_value()?;
        if status == Some(404.) || status == Some(409.) {
            return fields(p, &[("ok", flag(p, false)?), ("code", a[0].get(c"code")?)]);
        }
        Err(a[0].throw_error())
    })
}
fn ticket(p: L<'_>) -> Result<L<'_>> {
    if !p.get(c"token")?.truthy()? {
        return resolved(text(p, "")?);
    }
    let options = fields(
        p,
        &[
            ("method", text(p, "POST")?),
            ("body", text(p, r#"{"path":"/ws/chat"}"#)?),
        ],
    )?;
    then(
        request(p, text(p, "/api/auth/ws-ticket")?, options)?,
        p,
        |p, a| {
            let t = a[0].get(c"ticket")?;
            if clean(t)?.is_empty() {
                return Err(
                    error_value(p, "MultiCC did not issue a WebSocket ticket")?.throw_error()
                );
            }
            Ok(t)
        },
    )
}
fn chat_url<'a>(s: L<'a>, ticket: L<'a>) -> Result<L<'a>> {
    let p = s.get(c"p")?;
    let url = p.global()?.get(c"URL")?.construct(&[p.get(c"root")?])?;
    url.assign(
        c"protocol",
        text(
            p,
            if url.get(c"protocol")?.is_string("https:")? {
                "wss:"
            } else {
                "ws:"
            },
        )?,
    )?;
    url.assign(c"pathname", text(p, "/ws/chat")?)?;
    url.assign(c"search", text(p, "")?)?;
    call(
        url.get(c"searchParams")?,
        c"set",
        &[text(p, "session")?, s.get(c"target")?.get(c"sessionId")?],
    )?;
    if ticket.truthy()? {
        call(
            url.get(c"searchParams")?,
            c"set",
            &[text(p, "ticket")?, ticket],
        )?;
    }
    call(url, c"toString", &[])
}
pub(super) fn close_socket(s: L<'_>) -> Result<()> {
    let socket = s.get(c"socket")?;
    s.set(c"socket", null(s)?)?;
    s.set(c"openPromise", null(s)?)?;
    if socket.truthy()?
        && socket.get(c"readyState")?.number()?
            < s.get(c"p")?.get(c"WebSocket")?.get(c"CLOSING")?.number()?
    {
        s.catch(|| call(socket, c"close", &[]))?;
    }
    Ok(())
}
pub(super) fn is_open(s: L<'_>) -> Result<bool> {
    let socket = s.get(c"socket")?;
    Ok(socket.truthy()?
        && socket
            .get(c"readyState")?
            .equals(s.get(c"p")?.get(c"WebSocket")?.get(c"OPEN")?)?)
}
pub(super) fn send<'a>(s: L<'a>, body: L<'a>) -> Result<L<'a>> {
    call(
        s.get(c"socket")?,
        c"send",
        &[json_call(s, c"stringify", body)?],
    )
}
fn connect_fail(q: L<'_>) -> Result<()> {
    if !q.get(c"settled")?.truthy()? {
        q.set(c"settled", flag(q, true)?)?;
        q.get(c"s")?
            .get(c"p")?
            .get(c"ports")?
            .get(c"clearTimeout")?
            .call_plain(&[q.get(c"timer")?])?;
        q.get(c"reject")?.call_plain(&[http_error(
            q,
            "commander_transport_connect_failed",
            503.,
        )?])?;
    }
    Ok(())
}
pub(super) fn connect(s: L<'_>) -> Result<L<'_>> {
    async_result(s, || {
        if s.get(c"closed")?.truthy()? {
            return Err(error_value(
                s,
                &format!("ACP session {} is closed", fold_string(s.get(c"id")?)?),
            )?
            .throw_error());
        }
        if is_open(s)? {
            return undef(s);
        }
        if s.get(c"openPromise")?.truthy()? {
            return s.get(c"openPromise");
        }
        let promise = then(ticket(s.get(c"p")?)?, s, |s, a| {
            let q = fields(
                s,
                &[("s", s), ("ticket", a[0]), ("settled", flag(s, false)?)],
            )?;
            q.global()?.get(c"Promise")?.construct(&[function(
                q,
                "connectSocket",
                2,
                2,
                |q, a| {
                    q.set(c"resolve", a[0])?;
                    q.set(c"reject", a[1])?;
                    let s = q.get(c"s")?;
                    let p = s.get(c"p")?;
                    let socket = p
                        .get(c"WebSocket")?
                        .construct(&[chat_url(s, q.get(c"ticket")?)?])?;
                    s.set(c"socket", socket)?;
                    q.set(c"socket", socket)?;
                    let timer = p.get(c"ports")?.get(c"setTimeout")?.call_plain(&[
                        function(q, "connectTimeout", 0, 0, |q, _| {
                            connect_fail(q)?;
                            let socket = q.get(c"socket")?;
                            q.catch(|| {
                                call(
                                    socket,
                                    if callable(socket.get(c"terminate")?)? {
                                        c"terminate"
                                    } else {
                                        c"close"
                                    },
                                    &[],
                                )
                            })?;
                            undef(q)
                        })?,
                        p.get(c"socketTimeout")?,
                    ])?;
                    unref(timer)?;
                    q.set(c"timer", timer)?;
                    call(
                        socket,
                        c"once",
                        &[
                            text(q, "open")?,
                            function(q, "socketOpen", 0, 0, |q, _| {
                                if !q.get(c"settled")?.truthy()? {
                                    q.set(c"settled", flag(q, true)?)?;
                                    q.get(c"s")?
                                        .get(c"p")?
                                        .get(c"ports")?
                                        .get(c"clearTimeout")?
                                        .call_plain(&[q.get(c"timer")?])?;
                                    q.get(c"resolve")?.call_plain(&[])?;
                                }
                                undef(q)
                            })?,
                        ],
                    )?;
                    call(
                        socket,
                        c"once",
                        &[
                            text(q, "error")?,
                            function(q, "socketError", 1, 1, |q, _| {
                                connect_fail(q)?;
                                undef(q)
                            })?,
                        ],
                    )?;
                    call(
                        socket,
                        c"on",
                        &[
                            text(q, "message")?,
                            function(s, "socketMessage", 1, 1, |s, a| {
                                async_result(s, || session::message(s, a[0]))
                            })?,
                        ],
                    )?;
                    call(
                        socket,
                        c"on",
                        &[
                            text(q, "close")?,
                            function(q, "socketClose", 0, 0, |q, _| {
                                connect_fail(q)?;
                                let s = q.get(c"s")?;
                                if s.get(c"socket")?.equals(q.get(c"socket")?)? {
                                    s.set(c"socket", null(s)?)?;
                                }
                                let active = s.get(c"active")?;
                                if active.truthy()? {
                                    if active.get(c"cancelRequested")?.truthy()? {
                                        session::finish(s, active, session::stop_result(s, true)?)?;
                                    } else {
                                        session::unknown(s, active, "socket_close")?;
                                    }
                                }
                                undef(q)
                            })?,
                        ],
                    )?;
                    undef(q)
                },
            )?])
        })?;
        let promise = finish_with(promise, s, |s, _| {
            s.set(c"openPromise", null(s)?)?;
            undef(s)
        })?;
        s.set(c"openPromise", promise)?;
        Ok(promise)
    })
}
