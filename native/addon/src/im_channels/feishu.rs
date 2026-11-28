//! Feishu SDK handles remain in V8; all message/state decisions live here.
use super::*;

fn extract(message: L<'_>) -> Result<L<'_>> {
    if let Some(value) = message.catch(|| {
        let content = json_call(
            message,
            c"parse",
            keep(message.get(c"content")?, text(message, "{}")?)?,
        )?;
        if message.get(c"message_type")?.is_string("text")? {
            let input =
                string(keep(content.get(c"text")?, text(message, "")?)?)?.coerce_string()?;
            let units = input.as_units();
            let prefix: Vec<_> = "@_user_".encode_utf16().collect();
            let mut out = Vec::new();
            let mut i = 0;
            while i < units.len() {
                if units[i..].starts_with(&prefix) {
                    let begin = i + prefix.len();
                    let mut end = begin;
                    while end < units.len() && (48..=57).contains(&units[end]) {
                        end += 1;
                    }
                    if end > begin {
                        i = end;
                        continue;
                    }
                }
                out.push(units[i]);
                i += 1;
            }
            return js(message, JsString::from_units(out).trim());
        }
        if message.get(c"message_type")?.is_string("post")? {
            let language = obj(
                message,
                keep(content.get(c"zh_cn")?, content.get(c"en_us")?)?,
            )?;
            let lines = keep(language.get(c"content")?, array(message)?)?;
            let mut out = JsString::new();
            lines.for_each(|line| {
                line.for_each(|segment| {
                    let v = segment.get(c"text")?;
                    if v.truthy()? {
                        out.push(&string(v)?.coerce_string()?);
                    }
                    Ok(())
                })?;
                out.push_str("\n");
                Ok(())
            })?;
            return js(message, out.trim());
        }
        text(message, "")
    })? {
        return Ok(value);
    }
    text(message, "")
}
fn inbound<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let pending = async_result(s, || {
        let message = obj(s, a[0].optional(c"message")?)?;
        let input = extract(message)?;
        if message.get(c"chat_id")?.truthy()? {
            s.set(c"currentChat", message.get(c"chat_id")?)?;
        }
        let t = string(input)?.coerce_string()?;
        if t.trim().is_empty() || call(s.get(c"echo")?, c"isEcho", &[input])?.truthy()? {
            return undef(s);
        }
        log(s, "in", decorate(s, "[Feishu] ", preview(input)?, "")?)?;
        if t.as_units().first() == Some(&47) {
            return command(s, input);
        }
        if !gateway(s)?.truthy()? {
            return outbound(
                s,
                text(
                    s,
                    "⚠ Feishu Gateway 未创建。请在 MultiCC 管理页面创建 Feishu Gateway。",
                )?,
            );
        }
        then(deliver(s, input)?, s, |s, _| undef(s))
    })?;
    recover(pending, s, |s, a| {
        log_text(
            s,
            "error",
            &format!("Inbound handling error: {}", err_text(a[0])?),
        )?;
        undef(s)
    })
}
pub(super) fn start(s: L<'_>) -> Result<L<'_>> {
    let config = s.get(c"config")?;
    if !config.get(c"appId")?.truthy()? || !config.get(c"appSecret")?.truthy()? {
        return fail(s, "未配置飞书应用凭证（appId/appSecret）");
    }
    if !gateway(s)?.truthy()? {
        return fail(s, "Feishu gateway 未创建，请先在管理页面创建。");
    }
    let sdk = if s.get(c"lark")?.truthy()? {
        s.get(c"lark")?
    } else {
        let Some(sdk) = s.catch(|| s.get(c"ports")?.get(c"loadLark")?.call_plain(&[]))? else {
            return fail(
                s,
                "@larksuiteoapi/node-sdk 未安装，请先 `npm install @larksuiteoapi/node-sdk`",
            );
        };
        s.set(c"lark", sdk)?;
        sdk
    };
    let http = s
        .get(c"ports")?
        .get(c"createLarkHttpInstance")?
        .call_plain(&[sdk.get(c"defaultHttpInstance")?])?;
    let domain = config.get(c"domain")?;
    let domain = if domain.is_string("lark")? {
        sdk.get(c"Domain")?.get(c"Lark")?
    } else if !domain.truthy()? || domain.is_string("feishu")? {
        sdk.get(c"Domain")?.get(c"Feishu")?
    } else {
        text(s, fold_string(domain)?.trim_end_matches('/'))?
    };
    let options = fields(
        s,
        &[
            ("appId", config.get(c"appId")?),
            ("appSecret", config.get(c"appSecret")?),
            ("httpInstance", http),
            ("appType", sdk.get(c"AppType")?.get(c"SelfBuild")?),
            ("domain", domain),
        ],
    )?;
    s.set(c"apiClient", sdk.get(c"Client")?.construct(&[options])?)?;
    let dispatcher = sdk.get(c"EventDispatcher")?.construct(&[fields(s, &[])?])?;
    let handlers = fields(
        s,
        &[(
            "im.message.receive_v1",
            function(s, "onMessage", 1, 1, inbound)?,
        )],
    )?;
    let dispatcher = call(dispatcher, c"register", &[handlers])?;
    let options = fields(
        s,
        &[
            ("appId", config.get(c"appId")?),
            ("appSecret", config.get(c"appSecret")?),
            ("httpInstance", http),
            ("domain", domain),
            ("loggerLevel", sdk.get(c"LoggerLevel")?.get(c"info")?),
            ("agent", s.get(c"ports")?.get(c"outboundAgent")?),
        ],
    )?;
    s.set(c"wsClient", sdk.get(c"WSClient")?.construct(&[options])?)?;
    s.set(c"running", flag(s, true)?)?;
    s.set(c"startTime", clock(s)?)?;
    call(s.get(c"chatWs")?, c"connect", &[])?;
    // Legacy WSClient.start is deliberately not awaited.
    call(
        s.get(c"wsClient")?,
        c"start",
        &[fields(s, &[("eventDispatcher", dispatcher)])?],
    )?;
    log_text(
        s,
        "system",
        "Feishu bridge started (WebSocket long connection)",
    )?;
    undef(s)
}
pub(super) fn stop(s: L<'_>) -> Result<()> {
    let client = s.get(c"wsClient")?;
    if client.truthy()? {
        s.catch(|| {
            let close = keep(client.get(c"close")?, client.get(c"stop")?)?;
            if !close.nullish()? {
                close.call(client, &[])?;
            }
            undef(s)
        })?;
        s.set(c"wsClient", null(s)?)?;
    }
    Ok(())
}
pub(super) fn send_message<'a>(s: L<'a>, body: L<'a>) -> Result<L<'a>> {
    let payload = fields(
        s,
        &[
            (
                "params",
                fields(s, &[("receive_id_type", text(s, "chat_id")?)])?,
            ),
            (
                "data",
                fields(
                    s,
                    &[
                        ("receive_id", s.get(c"currentChat")?),
                        ("msg_type", text(s, "text")?),
                        (
                            "content",
                            json_call(s, c"stringify", fields(s, &[("text", body)])?)?,
                        ),
                    ],
                )?,
            ),
        ],
    )?;
    call(
        s.get(c"apiClient")?.get(c"im")?.get(c"message")?,
        c"create",
        &[payload],
    )
}
