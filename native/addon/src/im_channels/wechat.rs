//! iLink protocol and long-poll continuation chain. No Node-side protocol code.
use super::*;
pub(super) const LOGIN: &str = "https://ilinkai.weixin.qq.com";
fn base_info(s: L<'_>) -> Result<L<'_>> {
    fields(s, &[("channel_version", text(s, "1.0.2")?)])
}
fn timeout(s: L<'_>, ms: f64) -> Result<L<'_>> {
    call(
        s.get(c"ports")?.get(c"AbortSignal")?,
        c"timeout",
        &[num(s, ms)?],
    )
}
fn headers(s: L<'_>) -> Result<L<'_>> {
    let bytes = call(
        s.get(c"ports")?.get(c"crypto")?,
        c"randomBytes",
        &[num(s, 4.)?],
    )?;
    let uin = call(bytes, c"readUInt32BE", &[num(s, 0.)?])?;
    let uin = call(uin, c"toString", &[])?;
    let encoded = call(s.global()?.get(c"Buffer")?, c"from", &[uin])?;
    let encoded = call(encoded, c"toString", &[text(s, "base64")?])?;
    fields(
        s,
        &[
            ("Content-Type", text(s, "application/json")?),
            ("AuthorizationType", text(s, "ilink_bot_token")?),
            (
                "Authorization",
                text(
                    s,
                    &format!(
                        "Bearer {}",
                        fold_string(s.get(c"client")?.get(c"botToken")?)?
                    ),
                )?,
            ),
            ("X-WECHAT-UIN", encoded),
        ],
    )
}
fn response<'a>(f: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let res = a[0];
    if f.get(c"typing")?.truthy()? {
        return Ok(res);
    }
    if res.get(c"ok")?.truthy()? {
        return call(res, c"json", &[]);
    }
    f.set(c"status", res.get(c"status")?)?;
    if f.get(c"errorBody")?.truthy()? {
        let pending = recover(call(res, c"text", &[])?, f, |f, _| text(f, ""))?;
        return then(pending, f, |f, a| {
            fail(
                f,
                &format!(
                    "{} {}: {}",
                    fold_string(f.get(c"operation")?)?,
                    fold_string(f.get(c"status")?)?,
                    fold_string(cut(a[0], 200)?)?
                ),
            )
        });
    }
    fail(
        f,
        &format!(
            "{}: {}",
            fold_string(f.get(c"operation")?)?,
            fold_string(f.get(c"status")?)?
        ),
    )
}
fn request<'a>(
    s: L<'a>,
    url: &str,
    options: L<'a>,
    operation: &str,
    error_body: bool,
    typing: bool,
) -> Result<L<'a>> {
    async_result(s, || {
        let f = frame(
            s,
            &[
                ("operation", text(s, operation)?),
                ("errorBody", flag(s, error_body)?),
                ("typing", flag(s, typing)?),
            ],
        )?;
        then(
            s.get(c"ports")?
                .get(c"fetch")?
                .call_plain(&[text(s, url)?, options])?,
            f,
            response,
        )
    })
}
pub(super) fn qrcode(s: L<'_>) -> Result<L<'_>> {
    request(
        s,
        &format!("{LOGIN}/ilink/bot/get_bot_qrcode?bot_type=3"),
        fields(s, &[("signal", timeout(s, 15000.)?)])?,
        "QR code request failed",
        false,
        false,
    )
}
pub(super) fn login_status(s: L<'_>) -> Result<L<'_>> {
    let encoded = s
        .global()?
        .get(c"encodeURIComponent")?
        .call_plain(&[s.get(c"loginQrcode")?])?;
    request(
        s,
        &format!(
            "{LOGIN}/ilink/bot/get_qrcode_status?qrcode={}",
            fold_string(encoded)?
        ),
        fields(s, &[("signal", timeout(s, 40000.)?)])?,
        "Login poll failed",
        false,
        false,
    )
}
fn post<'a>(
    s: L<'a>,
    endpoint: &str,
    body: L<'a>,
    signal: L<'a>,
    operation: &str,
    typing: bool,
) -> Result<L<'a>> {
    let url = format!(
        "{}/ilink/bot/{endpoint}",
        fold_string(s.get(c"client")?.get(c"baseUrl")?)?
    );
    let options = fields(
        s,
        &[
            ("method", text(s, "POST")?),
            ("headers", headers(s)?),
            ("body", json_call(s, c"stringify", body)?),
            ("signal", signal),
        ],
    )?;
    request(s, &url, options, operation, true, typing)
}
pub(super) fn send_message<'a>(
    s: L<'a>,
    user: L<'a>,
    input: L<'a>,
    context: L<'a>,
) -> Result<L<'a>> {
    async_result(s, || {
        let random = call(s.global()?.get(c"Math")?, c"random", &[])?;
        let random = call(random, c"toString", &[num(s, 36.)?])?;
        let random = call(random, c"slice", &[num(s, 2.)?, num(s, 8.)?])?;
        let id = format!(
            "multicc_{}_{}",
            fold_string(clock(s)?)?,
            fold_string(random)?
        );
        let items = array(s)?;
        items.set_element(
            0,
            fields(
                s,
                &[
                    ("type", num(s, 1.)?),
                    ("text_item", fields(s, &[("text", input)])?),
                ],
            )?,
        )?;
        let message = fields(
            s,
            &[
                ("from_user_id", text(s, "")?),
                ("to_user_id", user),
                ("client_id", text(s, &id)?),
                ("message_type", num(s, 2.)?),
                ("message_state", num(s, 2.)?),
                ("item_list", items),
                ("context_token", context),
            ],
        )?;
        let body = fields(s, &[("msg", message), ("base_info", base_info(s)?)])?;
        post(
            s,
            "sendmessage",
            body,
            timeout(s, 15000.)?,
            "sendMessage",
            false,
        )
    })
}
fn typing<'a>(s: L<'a>, context: L<'a>) -> Result<L<'a>> {
    async_result(s, || {
        post(
            s,
            "sendtyping",
            fields(
                s,
                &[("context_token", context), ("base_info", base_info(s)?)],
            )?,
            timeout(s, 5000.)?,
            "sendTyping",
            true,
        )
    })
}
fn extract(message: L<'_>) -> Result<L<'_>> {
    if !message.truthy()? || !message.get(c"item_list")?.truthy()? {
        return text(message, "");
    }
    let mut out = text(message, "")?;
    message.get(c"item_list")?.for_each_while(|item| {
        if item.get(c"type")?.is_number(1.)? && item.get(c"text_item")?.truthy()? {
            out = keep(item.get(c"text_item")?.get(c"text")?, text(message, "")?)?;
            return Ok(false);
        }
        Ok(true)
    })?;
    Ok(out)
}
fn batch(f: L<'_>) -> Result<L<'_>> {
    let s = state(f)?;
    let messages = f.get(c"messages")?;
    loop {
        let i = f.get(c"index")?.number()?;
        if i >= messages.get(c"length")?.number()? {
            return undef(f);
        }
        let message = messages.element(i as u32)?;
        f.set(c"index", num(f, i + 1.)?)?;
        let input = extract(message)?;
        let context = message.get(c"context_token")?;
        if context.truthy()? {
            s.set(c"currentUser", message.get(c"from_user_id")?)?;
            s.set(c"contextToken", context)?;
        }
        if call(input, c"trim", &[])?.get(c"length")?.is_number(0.)?
            || call(s.get(c"echo")?, c"isEcho", &[input])?.truthy()?
        {
            continue;
        }
        log(s, "in", decorate(s, "[WeChat] ", preview(input)?, "")?)?;
        let pending = if call(input, c"startsWith", &[text(s, "/")?])?.truthy()? {
            command(s, input)?
        } else if !gateway(s)?.truthy()? {
            if !context.truthy()? {
                continue;
            }
            recover(
                send_message(
                    s,
                    message.get(c"from_user_id")?,
                    text(
                        s,
                        "⚠ Gateway 未创建。请在 MultiCC 管理页面创建 WeChat Gateway。",
                    )?,
                    context,
                )?,
                s,
                |s, _| undef(s),
            )?
        } else {
            if context.truthy()? {
                ignored(s, || typing(s, context))?;
            }
            deliver(s, input)?
        };
        return then(pending, f, |f, _| batch(f));
    }
}
fn cycle(s: L<'_>) -> Result<L<'_>> {
    let client = s.get(c"client")?;
    let abort = s.get(c"ports")?.get(c"AbortController")?.construct(&[])?;
    s.set(c"pollAbort", abort)?;
    let body = fields(
        s,
        &[
            ("get_updates_buf", client.get(c"cursor")?),
            ("base_info", base_info(s)?),
        ],
    )?;
    let f = frame(s, &[("pollClient", client)])?;
    then(
        post(
            s,
            "getupdates",
            body,
            abort.get(c"signal")?,
            "getUpdates",
            false,
        )?,
        f,
        |f, a| {
            let s = state(f)?;
            let data = a[0];
            if data.get(c"get_updates_buf")?.truthy()? {
                f.get(c"pollClient")?
                    .set(c"cursor", data.get(c"get_updates_buf")?)?;
            }
            let next = frame(
                s,
                &[
                    ("messages", keep(data.get(c"msgs")?, array(s)?)?),
                    ("index", num(s, 0.)?),
                ],
            )?;
            batch(next)
        },
    )
}
fn poll(s: L<'_>) -> Result<L<'_>> {
    if !s.get(c"running")?.truthy()? || !s.get(c"client")?.truthy()? {
        return resolved(undef(s)?);
    }
    let pending = async_result(s, || cycle(s))?;
    let iteration = recover(pending, s, |s, a| {
        if a[0].get(c"name")?.is_string("AbortError")? {
            return undef(s);
        }
        log_text(s, "error", &format!("Poll error: {}", err_text(a[0])?))?;
        sleep(s, 3000.)
    })?;
    // Each completed poll releases its Promise chain. Adopting the recursive
    // poll Promise would retain every earlier iteration until bridge stop.
    then(iteration, s, |s, _| {
        poll(s)?;
        undef(s)
    })
}
pub(super) fn start(s: L<'_>) -> Result<L<'_>> {
    let config = s.get(c"config")?;
    if !config.get(c"botToken")?.truthy()? {
        return fail(s, "Not logged in. Please scan QR code first.");
    }
    if !gateway(s)?.truthy()? {
        return fail(
            s,
            "Gateway not created. Create it in the management page first.",
        );
    }
    s.set(
        c"client",
        fields(
            s,
            &[
                ("botToken", config.get(c"botToken")?),
                ("baseUrl", keep(config.get(c"baseUrl")?, text(s, LOGIN)?)?),
                ("cursor", text(s, "")?),
            ],
        )?,
    )?;
    s.set(c"running", flag(s, true)?)?;
    log_text(s, "system", "Bridge started")?;
    call(s.get(c"chatWs")?, c"connect", &[])?;
    poll(s)?;
    undef(s)
}
pub(super) fn stop(s: L<'_>) -> Result<()> {
    let abort = s.get(c"pollAbort")?;
    if abort.truthy()? {
        call(abort, c"abort", &[])?;
        s.set(c"pollAbort", null(s)?)?;
    }
    Ok(())
}
