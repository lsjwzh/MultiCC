use super::*;

fn status<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let rec = gateway(s)?;
    let started = s.get(c"startTime")?;
    let started = if started.truthy()? {
        call(
            s.global()?.get(c"Date")?.construct(&[started])?,
            c"toISOString",
            &[],
        )?
    } else {
        null(s)?
    };
    let rec = if rec.truthy()? {
        fields(
            s,
            &[
                ("id", rec.get(c"id")?),
                ("cli", rec.get(c"cli")?),
                (
                    "cliSessionId",
                    fallback(rec.get(c"cliSessionId")?, V::Null)?,
                ),
            ],
        )?
    } else {
        null(s)?
    };
    let target = s.get(c"target")?;
    let is_tg = telegram(s)?;
    let target = if target.truthy()? {
        fields(
            s,
            &[(
                if is_tg {
                    "chatId"
                } else if is_slack(s)? {
                    "channel"
                } else {
                    "channelId"
                },
                target,
            )],
        )?
    } else {
        null(s)?
    };
    send(
        a[1],
        None,
        fields(
            s,
            &[
                ("running", s.get(c"running")?),
                ("configured", flag(s, configured(s)?)?),
                ("startTime", started),
                ("gateway", rec),
                (
                    if is_tg {
                        "polling"
                    } else if is_slack(s)? {
                        "socketConnected"
                    } else {
                        "wsConnected"
                    },
                    flag(s, s.get(c"client")?.truthy()?)?,
                ),
                ("chatConnected", call(s.get(c"chatWs")?, c"isOpen", &[])?),
                (
                    if is_tg {
                        "currentChat"
                    } else {
                        "currentChannel"
                    },
                    target,
                ),
            ],
        )?,
    )
}
fn config<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let configured = configured(s)?;
    let out = fields(s, &[])?;
    if is_slack(s)? {
        let config = s.get(c"config")?;
        out.set(c"configured", flag(s, configured)?)?;
        out.set(
            c"botTokenConfigured",
            flag(s, config.get(c"botToken")?.truthy()?)?,
        )?;
        out.set(
            c"appTokenConfigured",
            flag(s, config.get(c"appToken")?.truthy()?)?,
        )?;
    } else {
        if !telegram(s)? {
            out.set(c"botToken", text(s, if configured { "***" } else { "" })?)?;
        }
        out.set(c"configured", flag(s, configured)?)?;
    }
    send(a[1], None, out)
}
fn save_config<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let body = fallback(a[0].get(c"body")?, V::Object(vec![]))?;
    let token = body.get(c"botToken")?;
    if !token.undefined()? {
        s.get(c"config")?
            .set(c"botToken", call(string(token)?, c"trim", &[])?)?;
    }
    if is_slack(s)? {
        let app_token = body.get(c"appToken")?;
        if !app_token.undefined()? {
            s.get(c"config")?
                .set(c"appToken", call(string(app_token)?, c"trim", &[])?)?;
        }
    }
    call(
        s.get(c"ports")?.get(c"bridgeConfig")?,
        c"saveBridgeConfig",
        &[s.get(c"configFile")?, s.get(c"config")?],
    )?;
    if is_slack(s)? {
        send(
            a[1],
            None,
            fields(
                s,
                &[
                    ("ok", flag(s, true)?),
                    ("configured", flag(s, configured(s)?)?),
                ],
            )?,
        )
    } else {
        ok(a[1])
    }
}
fn local_error<'a>(s: L<'a>, res: L<'a>, code: i32, e: napi::Error) -> Result<L<'a>> {
    let cause = caught(s, e)?;
    send(res, Some(code), fields(s, &[("error", message(cause)?)])?)
}
fn put_gateway<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    // Body/trim errors precede the route-local catch in the original API.
    let cli = call(
        fallback(a[0].get(c"body")?.get(c"cli")?, "".into())?,
        c"trim",
        &[],
    )?;
    let result = (|| {
        let exists = gateway(s)?.truthy()?;
        let rec = call(
            s.get(c"gateway")?,
            if exists { c"switchCli" } else { c"create" },
            &[cli],
        )?;
        send(a[1], None, rec)
    })();
    match result {
        Ok(response) => Ok(response),
        Err(e) => local_error(s, a[1], 400, e),
    }
}
fn gateway_action<'a>(s: L<'a>, res: L<'a>, reset: bool) -> Result<L<'a>> {
    if reset {
        let c = fields(s, &[("res", res)])?;
        let cleared = async_result(s, || call(s.get(c"gateway")?, c"resetHistory", &[]))?;
        let replied = then(cleared, c, |c, _| ok(c.get(c"res")?))?;
        return recover(replied, c, |c, a| {
            send(
                c.get(c"res")?,
                Some(500),
                fields(c, &[("error", message(a[0])?)])?,
            )
        });
    }
    let result = (|| {
        call(s.get(c"gateway")?, c"destroy", &[])?;
        ok(res)
    })();
    match result {
        Ok(response) => Ok(response),
        Err(e) => local_error(s, res, 500, e),
    }
}
fn start<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let c = fields(s, &[("res", a[1])])?;
    let started = async_result(s, || lifecycle::start(s))?;
    let sent = then(started, c, |c, _| ok(c.get(c"res")?))?;
    recover(sent, c, |c, a| {
        send(
            c.get(c"res")?,
            Some(400),
            fields(c, &[("error", message(a[0])?)])?,
        )
    })
}
fn stop<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if telegram(s)? {
        let c = fields(s, &[("res", a[1])])?;
        then(async_result(s, || lifecycle::stop(s))?, c, |c, _| {
            ok(c.get(c"res")?)
        })
    } else {
        lifecycle::stop(s)?;
        ok(a[1])
    }
}
fn manual_send<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let req = a[0];
        let res = a[1];
        let body = fallback(req.get(c"body")?, V::Object(vec![]))?;
        let value = body.get(c"text")?;
        if !value.truthy()? {
            return error(res, 400, "text required", false);
        }
        if body.get(c"target")?.equals(s.get(c"platform")?)? {
            let is_tg = telegram(s)?;
            let target = if is_slack(s)? {
                let channel = body.get(c"channel")?;
                if channel.truthy()? {
                    channel
                } else {
                    body.get(c"chatId")?
                }
            } else {
                body.get(if is_tg { c"chatId" } else { c"channelId" })?
            };
            if target.truthy()? {
                let target = if is_tg {
                    let number = s.global()?.get(c"Number")?.call_plain(&[target])?;
                    if number.truthy()? {
                        number
                    } else {
                        target
                    }
                } else {
                    target
                };
                s.set(c"target", target)?;
            }
            if !s.get(c"target")?.truthy()? {
                return error(
                    res,
                    400,
                    if is_tg {
                        "No Telegram chat attached (provide chatId)"
                    } else if is_slack(s)? {
                        "No Slack channel attached (provide channel)"
                    } else {
                        "No Discord channel attached (provide channelId)"
                    },
                    false,
                );
            }
            if !s.get(c"client")?.truthy()? {
                return error(res, 400, "Bridge not started", false);
            }
            let c = fields(s, &[("res", res)])?;
            let sent = async_result(s, || {
                call(s.get(c"echo")?, c"add", &[value])?;
                outbound::send_text(s, value)
            })?;
            let sent = recover(sent, c, |c, a| {
                c.set(c"responded", flag(c, true)?)?;
                send(
                    c.get(c"res")?,
                    Some(500),
                    fields(c, &[("error", message(a[0])?)])?,
                )
            })?;
            then(sent, c, |c, _| {
                if c.get(c"responded")?.truthy()? {
                    undef(c)
                } else {
                    ok(c.get(c"res")?)
                }
            })
        } else {
            if !gateway(s)?.truthy()? {
                return error(res, 400, "Gateway not created", false);
            }
            let ws = s.get(c"chatWs")?;
            if !call(ws, c"isOpen", &[])?.truthy()? {
                call(ws, c"connect", &[])?;
            }
            let c = fields(s, &[("state", s), ("res", res), ("text", value)])?;
            then(call(ws, c"ensureOpen", &[num(s, 2000.)?])?, c, |c, _| {
                let s = c.get(c"state")?;
                let res = c.get(c"res")?;
                let value = c.get(c"text")?;
                if !call(s.get(c"chatWs")?, c"sendUserMessage", &[value])?.truthy()? {
                    return error(res, 500, "Gateway not connected", false);
                }
                log(s, "in", concat(s, "[manual] ", value)?)?;
                ok(res)
            })
        }
    })
}
fn logs<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let since = a[0].get(c"query")?.get(c"since")?;
    let since = if since.truthy()? {
        s.global()?.get(c"Number")?.call_plain(&[since])?
    } else {
        num(s, 0.)?
    };
    send(
        a[1],
        None,
        call(s.get(c"logStore")?, c"filterSince", &[since])?,
    )
}
fn events<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let res = a[1];
    for (key, val) in [
        ("Content-Type", "text/event-stream"),
        ("Cache-Control", "no-cache"),
        ("Connection", "keep-alive"),
        ("X-Accel-Buffering", "no"),
    ] {
        call(res, c"setHeader", &[text(s, key)?, text(s, val)?])?;
    }
    call(res, c"flushHeaders", &[])?;
    call(s.get(c"logStore")?, c"addClient", &[res])?;
    let c = fields(s, &[("state", s), ("res", res)])?;
    let timer = s.global()?.get(c"setInterval")?.call_plain(&[
        function(c, "heartbeat", 0, 0, |c, _| {
            c.catch(|| call(c.get(c"res")?, c"write", &[text(c, ": heartbeat\n\n")?]))?;
            undef(c)
        })?,
        num(s, 5000.)?,
    ])?;
    c.set(c"timer", timer)?;
    call(
        a[0],
        c"on",
        &[
            text(s, "close")?,
            function(c, "close", 0, 0, |c, _| {
                c.global()?
                    .get(c"clearInterval")?
                    .call_plain(&[c.get(c"timer")?])?;
                call(
                    c.get(c"state")?.get(c"logStore")?,
                    c"removeClient",
                    &[c.get(c"res")?],
                )?;
                undef(c)
            })?,
        ],
    )?;
    undef(s)
}
pub(super) fn mount<'a>(s: L<'a>, router: L<'a>) -> Result<()> {
    let rows: &[(&std::ffi::CStr, &str, Action)] = &[
        (c"get", "/status", status),
        (c"get", "/config", config),
        (c"post", "/config", save_config),
        (c"get", "/gateway", |s, a| send(a[1], None, gateway(s)?)),
        (c"put", "/gateway", put_gateway),
        (c"delete", "/gateway", |s, a| gateway_action(s, a[1], false)),
        (c"post", "/gateway/reset", |s, a| {
            gateway_action(s, a[1], true)
        }),
        (c"post", "/start", start),
        (c"post", "/stop", stop),
        (c"post", "/send", manual_send),
        (c"get", "/log", logs),
        (c"get", "/events", events),
    ];
    for &(method, path, run) in rows {
        call(
            router,
            method,
            &[text(s, path)?, function(s, "bridgeRoute", 2, 2, run)?],
        )?;
    }
    Ok(())
}
