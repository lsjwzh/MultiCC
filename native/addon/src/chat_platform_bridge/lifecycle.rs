use super::*;

fn timestamp(s: L<'_>) -> Result<()> {
    s.set(c"startTime", call(s.global()?.get(c"Date")?, c"now", &[])?)
}
fn telegram_started<'a>(c: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let s = c.get(c"state")?;
    s.set(c"running", flag(s, true)?)?;
    timestamp(s)?;
    call(s.get(c"chatWs")?, c"connect", &[])?;
    log_text(s, "system", "Telegram bridge started (long-polling)")?;
    undef(s)
}
fn telegram_failed<'a>(c: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let s = c.get(c"state")?;
    s.set(c"client", null(s)?)?;
    let failure = fields(c, &[("error", a[0])])?;
    let stopped = async_result(c, || call(c.get(c"client")?, c"stop", &[]))?;
    let ignored = recover(stopped, c, |c, _| undef(c))?;
    then(ignored, failure, |c, _| Err(c.get(c"error")?.throw_error()))
}
pub(super) fn start(s: L<'_>) -> Result<L<'_>> {
    if s.get(c"running")?.truthy()? {
        return Err(error_value(s, "Bridge is already running")?.throw_error());
    }
    if !s.get(c"config")?.get(c"botToken")?.truthy()? {
        return Err(error_value(s, &format!("未配置 {} Bot Token", label(s)?))?.throw_error());
    }
    if !gateway(s)?.truthy()? {
        return Err(error_value(
            s,
            &format!("{} gateway 未创建，请先在管理页面创建。", label(s)?),
        )?
        .throw_error());
    }
    if telegram(s)? {
        let opts = fields(
            s,
            &[
                ("token", s.get(c"config")?.get(c"botToken")?),
                ("transport", text(s, "polling")?),
            ],
        )?;
        let client = s
            .get(c"ports")?
            .get(c"createTelegramClient")?
            .call_plain(&[opts])?;
        s.set(c"client", client)?;
        call(
            client,
            c"onMessage",
            &[function(s, "onMessage", 1, 1, inbound::receive)?],
        )?;
        call(
            client,
            c"onPollingError",
            &[function(s, "onPollingError", 1, 1, |s, a| {
                let msg = fallback(message(a[0])?, V::Undefined)?;
                let msg = if msg.truthy()? { msg } else { a[0] };
                log(s, "error", concat(s, "Telegram polling error: ", msg)?)?;
                undef(s)
            })?],
        )?;
        let c = fields(s, &[("state", s), ("client", client)])?;
        let started = async_result(s, || call(client, c"start", &[]))?;
        recover(then(started, c, telegram_started)?, c, telegram_failed)
    } else {
        let mut sdk = s.get(c"discord")?;
        if !sdk.truthy()? {
            sdk = match s.catch(|| s.get(c"ports")?.get(c"loadDiscord")?.call_plain(&[]))? {
                Some(sdk) => sdk,
                None => {
                    return Err(
                        error_value(s, "discord.js 未安装，请先 `npm install discord.js`")?
                            .throw_error(),
                    )
                }
            };
            s.set(c"discord", sdk)?;
        }
        let bits = sdk.get(c"GatewayIntentBits")?;
        let intents = array(s)?;
        for (i, k) in [
            c"Guilds",
            c"GuildMessages",
            c"MessageContent",
            c"DirectMessages",
        ]
        .iter()
        .enumerate()
        {
            intents.set_element(i as u32, bits.get(k)?)?;
        }
        let ports = s.get(c"ports")?;
        let opts = fields(
            s,
            &[
                (
                    "rest",
                    fields(s, &[("makeRequest", ports.get(c"outboundFetch")?)])?,
                ),
                (
                    "ws",
                    fields(s, &[("buildStrategy", ports.get(c"buildDiscordStrategy")?)])?,
                ),
                ("intents", intents),
            ],
        )?;
        let client = sdk.get(c"Client")?.construct(&[opts])?;
        call(
            client,
            c"on",
            &[
                text(s, "messageCreate")?,
                function(s, "messageCreate", 1, 1, |s, a| {
                    inbound::receive(s, a)?;
                    undef(s)
                })?,
            ],
        )?;
        let c = fields(s, &[("state", s), ("client", client)])?;
        call(
            client,
            c"on",
            &[
                text(s, "ready")?,
                function(c, "ready", 0, 0, |c, _| {
                    let s = c.get(c"state")?;
                    let user = c.get(c"client")?.get(c"user")?;
                    s.set(c"botUserId", fallback(user.optional(c"id")?, V::Null)?)?;
                    log(
                        s,
                        "system",
                        concat(
                            s,
                            "Discord bot logged in as ",
                            fallback(user.optional(c"tag")?, "<unknown>".into())?,
                        )?,
                    )?;
                    undef(s)
                })?,
            ],
        )?;
        call(
            client,
            c"on",
            &[
                text(s, "error")?,
                function(s, "error", 1, 1, |s, a| {
                    log(
                        s,
                        "error",
                        concat(s, "Discord client error: ", message(a[0])?)?,
                    )
                })?,
            ],
        )?;
        call(
            client,
            c"on",
            &[
                text(s, "disconnect")?,
                function(s, "disconnect", 0, 0, |s, _| {
                    log_text(s, "system", "Discord gateway disconnected")
                })?,
            ],
        )?;
        // Discord deliberately publishes its running state before awaiting login.
        s.set(c"client", client)?;
        s.set(c"running", flag(s, true)?)?;
        timestamp(s)?;
        call(s.get(c"chatWs")?, c"connect", &[])?;
        let login = call(client, c"login", &[s.get(c"config")?.get(c"botToken")?])?;
        then(login, s, |s, _| {
            log_text(s, "system", "Discord bridge started (Gateway WebSocket)")?;
            undef(s)
        })
    }
}
pub(super) fn stop(s: L<'_>) -> Result<L<'_>> {
    s.set(c"running", flag(s, false)?)?;
    let client = s.get(c"client")?;
    if telegram(s)? {
        s.set(c"client", null(s)?)?;
        call(s.get(c"chatWs")?, c"disconnect", &[])?;
        let stopped = if client.truthy()? {
            recover(
                async_result(s, || call(client, c"stop", &[]))?,
                s,
                |s, a| {
                    let msg = message(a[0])?;
                    log(
                        s,
                        "error",
                        concat(
                            s,
                            "Telegram stop failed: ",
                            if msg.truthy()? { msg } else { a[0] },
                        )?,
                    )?;
                    undef(s)
                },
            )?
        } else {
            resolved(undef(s)?)?
        };
        then(stopped, s, |s, _| {
            log_text(s, "system", "Telegram bridge stopped")?;
            undef(s)
        })
    } else {
        if client.truthy()? {
            s.catch(|| call(client, c"destroy", &[]))?;
            s.set(c"client", null(s)?)?;
        }
        s.set(c"botUserId", null(s)?)?;
        call(s.get(c"chatWs")?, c"disconnect", &[])?;
        log_text(s, "system", "Discord bridge stopped")?;
        undef(s)
    }
}
