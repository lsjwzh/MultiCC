//! Express is an IO port: route inventory, validation and state changes are Rust.
use super::*;

fn ok(res: L<'_>) -> Result<L<'_>> {
    send(res, None, fields(res, &[("ok", flag(res, true)?)])?)
}
fn failure<'a>(res: L<'a>, code: i32, cause: L<'a>) -> Result<L<'a>> {
    send(
        res,
        Some(code),
        fields(res, &[("error", cause.get(c"message")?)])?,
    )
}
fn caught<'a>(
    s: L<'a>,
    res: L<'a>,
    code: i32,
    run: impl FnOnce() -> Result<L<'a>>,
) -> Result<L<'a>> {
    match run() {
        Ok(v) => Ok(v),
        Err(error) => {
            let cause = match s.exception_value()? {
                Some(v) => v,
                None => error_value(s, &error.reason)?,
            };
            failure(res, code, cause)
        }
    }
}
fn reply<'a>(pending: L<'a>, s: L<'a>, res: L<'a>, code: i32) -> Result<L<'a>> {
    let f = frame(s, &[("res", res), ("errorCode", num(s, code as f64)?)])?;
    let pending = then(pending, f, |f, _| ok(f.get(c"res")?))?;
    recover(pending, f, |f, a| {
        failure(f.get(c"res")?, f.get(c"errorCode")?.number()? as i32, a[0])
    })
}
fn iso(value: L<'_>) -> Result<L<'_>> {
    if !value.truthy()? {
        return null(value);
    }
    call(
        value.global()?.get(c"Date")?.construct(&[value])?,
        c"toISOString",
        &[],
    )
}
fn configured(s: L<'_>) -> Result<L<'_>> {
    let c = s.get(c"config")?;
    flag(
        s,
        c.get(c"appId")?.truthy()? && c.get(c"appSecret")?.truthy()?,
    )
}
fn status<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let rec = gateway(s)?;
    let record = if rec.truthy()? {
        fields(
            s,
            &[
                ("id", rec.get(c"id")?),
                ("cli", rec.get(c"cli")?),
                ("cliSessionId", keep(rec.get(c"cliSessionId")?, null(s)?)?),
            ],
        )?
    } else {
        null(s)?
    };
    let out = fields(
        s,
        &[
            ("running", s.get(c"running")?),
            ("gateway", record),
            ("chatConnected", call(s.get(c"chatWs")?, c"isOpen", &[])?),
        ],
    )?;
    if wx(s)? {
        out.set(
            c"loggedIn",
            flag(s, s.get(c"config")?.get(c"botToken")?.truthy()?)?,
        )?;
        out.set(c"loginTime", iso(s.get(c"loginTime")?)?)?;
        out.set(
            c"currentUser",
            if s.get(c"currentUser")?.truthy()? {
                fields(
                    s,
                    &[("hasToken", flag(s, s.get(c"contextToken")?.truthy()?)?)],
                )?
            } else {
                null(s)?
            },
        )?;
    } else {
        out.set(c"configured", configured(s)?)?;
        out.set(
            c"domain",
            keep(s.get(c"config")?.get(c"domain")?, text(s, "feishu")?)?,
        )?;
        out.set(c"startTime", iso(s.get(c"startTime")?)?)?;
        out.set(c"wsConnected", flag(s, s.get(c"wsClient")?.truthy()?)?)?;
        out.set(
            c"currentChat",
            if s.get(c"currentChat")?.truthy()? {
                fields(s, &[("chatId", s.get(c"currentChat")?)])?
            } else {
                null(s)?
            },
        )?;
    }
    send(a[1], None, out)
}
fn config_get<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let c = s.get(c"config")?;
    let out = if wx(s)? {
        fields(
            s,
            &[
                ("outputIdle", keep(c.get(c"outputIdle")?, num(s, 5000.)?)?),
                ("loggedIn", flag(s, c.get(c"botToken")?.truthy()?)?),
            ],
        )?
    } else {
        fields(
            s,
            &[
                ("appId", keep(c.get(c"appId")?, text(s, "")?)?),
                ("domain", keep(c.get(c"domain")?, text(s, "feishu")?)?),
                ("configured", configured(s)?),
            ],
        )?
    };
    send(a[1], None, out)
}
fn idle<'a>(s: L<'a>, value: L<'a>) -> Result<()> {
    let number = s.global()?.get(c"Number")?.call_plain(&[value])?;
    s.get(c"config")?
        .set(c"outputIdle", keep(number, num(s, 5000.)?)?)?;
    Ok(())
}
fn config_post<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let body = if wx(s)? {
        a[0].get(c"body")?
    } else {
        obj(s, a[0].get(c"body")?)?
    };
    if wx(s)? {
        let value = body.get(c"outputIdle")?;
        if !value.undefined()? {
            idle(s, value)?;
        }
    } else {
        for key in [c"appId", c"appSecret", c"domain"] {
            let value = body.get(key)?;
            if !value.undefined()? {
                let v = call(string(value)?, c"trim", &[])?;
                s.get(c"config")?.set(
                    key,
                    if key == c"domain" {
                        keep(v, text(s, "feishu")?)?
                    } else {
                        v
                    },
                )?;
            }
        }
    }
    save(s)?;
    ok(a[1])
}
fn gateway_get<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    send(a[1], None, gateway(s)?)
}
fn gateway_put<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let cli = call(
        keep(a[0].get(c"body")?.get(c"cli")?, text(s, "")?)?,
        c"trim",
        &[],
    )?;
    caught(s, a[1], 400, || {
        let rec = call(
            s.get(c"gateway")?,
            if gateway(s)?.truthy()? {
                c"switchCli"
            } else {
                c"create"
            },
            &[cli],
        )?;
        send(a[1], None, rec)
    })
}
fn gateway_delete<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    caught(s, a[1], 500, || {
        call(s.get(c"gateway")?, c"destroy", &[])?;
        ok(a[1])
    })
}
fn gateway_reset<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let pending = async_result(s, || call(s.get(c"gateway")?, c"resetHistory", &[]))?;
    reply(pending, s, a[1], 500)
}
fn start_route<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let pending = async_result(s, || {
        if wx(s)? {
            let body = a[0].get(c"body")?;
            if body.truthy()? && body.get(c"outputIdle")?.truthy()? {
                idle(s, body.get(c"outputIdle")?)?;
            }
            save(s)?;
        }
        start(s, &mut [])
    })?;
    reply(pending, s, a[1], 400)
}
fn stop_route<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    stop(s, &mut [])?;
    ok(a[1])
}
fn send_route<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let res = a[1];
        let body = if wx(s)? {
            a[0].get(c"body")?
        } else {
            obj(s, a[0].get(c"body")?)?
        };
        let input = body.get(c"text")?;
        if !input.truthy()? {
            return error(res, 400, "text required", false);
        }
        if body
            .get(c"target")?
            .is_string(if wx(s)? { "wechat" } else { "feishu" })?
        {
            if wx(s)? {
                if !s.get(c"currentUser")?.truthy()? || !s.get(c"contextToken")?.truthy()? {
                    return error(res, 400, "No WeChat user attached", false);
                }
            } else {
                if body.get(c"chatId")?.truthy()? {
                    s.set(c"currentChat", body.get(c"chatId")?)?;
                }
                if !s.get(c"currentChat")?.truthy()? {
                    return error(res, 400, "No Feishu chat attached (provide chatId)", false);
                }
                if !s.get(c"apiClient")?.truthy()? {
                    return error(res, 400, "Bridge not started", false);
                }
            }
            let f = frame(s, &[("input", input)])?;
            let pending = async_result(s, || {
                call(s.get(c"echo")?, c"add", &[input])?;
                if wx(s)? {
                    then(
                        wechat::send_message(
                            s,
                            s.get(c"currentUser")?,
                            input,
                            s.get(c"contextToken")?,
                        )?,
                        f,
                        |f, _| {
                            log(state(f)?, "out", f.get(c"input")?)?;
                            undef(f)
                        },
                    )
                } else {
                    outbound(s, input)
                }
            })?;
            return reply(pending, s, res, 500);
        }
        if !gateway(s)?.truthy()? {
            return error(res, 400, "Gateway not created", false);
        }
        let f = frame(s, &[("res", res), ("input", input)])?;
        then(deliver(s, input)?, f, |f, a| {
            let res = f.get(c"res")?;
            if !a[0].truthy()? {
                return error(res, 500, "Gateway not connected", false);
            }
            log(
                state(f)?,
                "in",
                decorate(f, "[manual] ", f.get(c"input")?, "")?,
            )?;
            ok(res)
        })
    })
}
fn logs<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let since = a[0].get(c"query")?.get(c"since")?;
    let since = if since.truthy()? {
        s.global()?.get(c"Number")?.call_plain(&[since])?
    } else {
        num(s, 0.)?
    };
    send(a[1], None, call(s.get(c"logs")?, c"filterSince", &[since])?)
}
fn heartbeat<'a>(f: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    f.catch(|| call(f.get(c"res")?, c"write", &[text(f, ": heartbeat\n\n")?]))?;
    undef(f)
}
fn close_sse<'a>(f: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let s = state(f)?;
    s.get(c"ports")?
        .get(c"clearInterval")?
        .call_plain(&[f.get(c"heartbeat")?])?;
    call(s.get(c"logs")?, c"removeClient", &[f.get(c"res")?])?;
    undef(f)
}
fn events<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let res = a[1];
    for (key, value) in [
        ("Content-Type", "text/event-stream"),
        ("Cache-Control", "no-cache"),
        ("Connection", "keep-alive"),
        ("X-Accel-Buffering", "no"),
    ] {
        call(res, c"setHeader", &[text(s, key)?, text(s, value)?])?;
    }
    call(res, c"flushHeaders", &[])?;
    call(s.get(c"logs")?, c"addClient", &[res])?;
    let f = frame(s, &[("res", res)])?;
    let timer = s
        .get(c"ports")?
        .get(c"setInterval")?
        .call_plain(&[function(f, "heartbeat", 0, 0, heartbeat)?, num(s, 5000.)?])?;
    f.set(c"heartbeat", timer)?;
    call(
        a[0],
        c"on",
        &[text(s, "close")?, function(f, "close", 0, 0, close_sse)?],
    )?;
    undef(s)
}
fn qrcode<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let f = frame(s, &[("res", a[1])])?;
    let pending = async_result(s, || {
        then(wechat::qrcode(s)?, f, |f, a| {
            let s = state(f)?;
            let data = a[0];
            s.set(c"loginQrcode", data.get(c"qrcode")?)?;
            s.set(
                c"loginQrImg",
                keep(data.get(c"qrcode_img_content")?, null(s)?)?,
            )?;
            send(
                f.get(c"res")?,
                None,
                fields(
                    s,
                    &[
                        ("qrcode", data.get(c"qrcode")?),
                        ("image", s.get(c"loginQrImg")?),
                    ],
                )?,
            )
        })
    })?;
    recover(pending, f, |f, a| failure(f.get(c"res")?, 500, a[0]))
}
fn login_status<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let res = a[1];
    if !s.get(c"loginQrcode")?.truthy()? {
        return resolved(send(
            res,
            None,
            fields(s, &[("status", text(s, "no_qrcode")?)])?,
        )?);
    }
    let f = frame(s, &[("res", res)])?;
    let pending = async_result(s, || {
        then(wechat::login_status(s)?, f, |f, a| {
            let s = state(f)?;
            let data = a[0];
            let status = if data.get(c"status")?.is_string("confirmed")?
                && data.get(c"bot_token")?.truthy()?
            {
                let config = s.get(c"config")?;
                config.set(c"botToken", data.get(c"bot_token")?)?;
                config.set(
                    c"baseUrl",
                    keep(data.get(c"baseurl")?, text(s, wechat::LOGIN)?)?,
                )?;
                s.set(c"loginTime", clock(s)?)?;
                save(s)?;
                s.set(c"loginQrcode", null(s)?)?;
                s.set(c"loginQrImg", null(s)?)?;
                log_text(s, "system", "WeChat login successful")?;
                text(s, "confirmed")?
            } else {
                keep(data.get(c"status")?, text(s, "waiting")?)?
            };
            send(f.get(c"res")?, None, fields(s, &[("status", status)])?)
        })
    })?;
    recover(pending, f, |f, a| {
        send(
            f.get(c"res")?,
            None,
            fields(
                f,
                &[
                    ("status", text(f, "error")?),
                    ("error", a[0].get(c"message")?),
                ],
            )?,
        )
    })
}
fn logout<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if s.get(c"running")?.truthy()? {
        stop(s, &mut [])?;
    }
    s.get(c"config")?.set(c"botToken", text(s, "")?)?;
    s.get(c"config")?.set(c"baseUrl", text(s, "")?)?;
    s.set(c"loginTime", null(s)?)?;
    save(s)?;
    s.set(c"currentUser", null(s)?)?;
    s.set(c"contextToken", null(s)?)?;
    log_text(s, "system", "Logged out")?;
    ok(a[1])
}
pub(super) fn mount(s: L<'_>) -> Result<()> {
    let router = s.get(c"router")?;
    if wx(s)? {
        for (path, run) in [
            ("/qrcode", qrcode as Action),
            ("/login-status", login_status as Action),
        ] {
            call(
                router,
                c"get",
                &[text(s, path)?, function(s, "wechatRoute", 2, 2, run)?],
            )?;
        }
    }
    let routes: &[(&CStr, &str, Action)] = &[
        (c"get", "/status", status),
        (c"get", "/config", config_get),
        (c"post", "/config", config_post),
        (c"get", "/gateway", gateway_get),
        (c"put", "/gateway", gateway_put),
        (c"delete", "/gateway", gateway_delete),
        (c"post", "/gateway/reset", gateway_reset),
        (c"post", "/start", start_route),
        (c"post", "/stop", stop_route),
        (c"post", "/send", send_route),
        (c"get", "/log", logs),
        (c"get", "/events", events),
    ];
    for &(method, path, run) in routes {
        call(
            router,
            method,
            &[text(s, path)?, function(s, "bridgeRoute", 2, 2, run)?],
        )?;
    }
    if wx(s)? {
        call(
            router,
            c"post",
            &[
                text(s, "/logout")?,
                function(s, "wechatRoute", 2, 2, logout)?,
            ],
        )?;
    }
    Ok(())
}
