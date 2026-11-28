use super::*;
use multicc_core::js::{is_js_whitespace, JsString};

fn command<'a>(s: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let units = value.coerce_string()?;
    let head: Vec<u16> = units
        .as_units()
        .iter()
        .copied()
        .take_while(|c| !is_js_whitespace(*c))
        .collect();
    let cmd = call(
        s.from_value(&V::String(JsString::from_units(head)))?,
        c"toLowerCase",
        &[],
    )?;
    let rec = gateway(s)?;
    if cmd.is_string("/reset")? {
        // The owner must finish its durable clear before any success reaches the SDK.
        return then(
            async_result(s, || call(s.get(c"gateway")?, c"resetHistory", &[]))?,
            s,
            |s, _| command_reply(s, text(s, "✅ 已清空对话历史")?),
        );
    }
    let reply = if cmd.is_string("/help")? {
        text(
            s,
            "📋 可用命令:\n/status — 网关状态\n/reset — 清空对话历史\n/help — 显示帮助",
        )?
    } else if cmd.is_string("/status")? {
        let started = s.get(c"startTime")?;
        let uptime = if started.truthy()? {
            let now = call(s.global()?.get(c"Date")?, c"now", &[])?.number()?;
            format!("{} min", ((now - started.number()?) / 60000.).floor())
        } else {
            "N/A".into()
        };
        let running = if s.get(c"running")?.truthy()? {
            "运行中"
        } else {
            "已停止"
        };
        let configured = if s.get(c"config")?.get(c"botToken")?.truthy()? {
            "已配置"
        } else {
            "未配置"
        };
        let cli = if rec.truthy()? {
            fold_string(rec.get(c"cli")?)?
        } else {
            "未创建".into()
        };
        let connected = s.get(c"client")?.truthy()?;
        if telegram(s)? {
            text(s, &format!("🔗 桥接: {running}\n🤖 Bot: {configured} ({uptime})\n🔌 Gateway: {cli}\n📡 Polling: {}", if connected { "运行中" } else { "未启动" }))?
        } else {
            text(s, &format!("🔗 桥接: {running}\n📱 Bot Token: {configured} ({uptime})\n🤖 Gateway: {cli}\n🔌 长连接: {}", if connected { "已建立" } else { "未建立" }))?
        }
    } else {
        call(
            concat(s, "未知命令: ", cmd)?,
            c"concat",
            &[text(s, "，输入 /help 查看帮助")?],
        )?
    };
    command_reply(s, reply)
}
fn command_reply<'a>(s: L<'a>, reply: L<'a>) -> Result<L<'a>> {
    recover(send_reply(s, reply)?, s, |s, a| {
        log(s, "error", message(a[0])?)?;
        undef(s)
    })
}
fn send_reply<'a>(s: L<'a>, reply: L<'a>) -> Result<L<'a>> {
    outbound::send_text(s, reply)
}
pub(super) fn receive<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let msg = a[0];
    let handled = async_result(s, || {
        let raw = if telegram(s)? {
            let value = msg.get(c"text")?;
            if !value.truthy()? {
                return undef(s);
            }
            value
        } else {
            let author = msg.get(c"author")?;
            if author.optional(c"bot")?.truthy()? {
                return undef(s);
            }
            if s.get(c"botUserId")?.truthy()?
                && author.optional(c"id")?.equals(s.get(c"botUserId")?)?
            {
                return undef(s);
            }
            msg.get(c"content")?
        };
        let value = call(string(fallback(raw, "".into())?)?, c"trim", &[])?;
        let context = msg.get(if telegram(s)? { c"chat" } else { c"channel" })?;
        let target = if context.truthy()? {
            context.get(c"id")?
        } else {
            undef(s)?
        };
        if target.truthy()? {
            s.set(c"target", target)?;
        }
        if !value.truthy()? || call(s.get(c"echo")?, c"isEcho", &[value])?.truthy()? {
            return undef(s);
        }
        log(
            s,
            "in",
            concat(s, &format!("[{}] ", label(s)?), preview(value, 200.)?)?,
        )?;
        if call(value, c"startsWith", &[text(s, "/")?])?.truthy()? {
            return command(s, value);
        }
        if !gateway(s)?.truthy()? {
            return send_reply(
                s,
                text(
                    s,
                    &format!(
                        "⚠ {} Gateway 未创建。请在 MultiCC 管理页面创建 {} Gateway。",
                        label(s)?,
                        label(s)?
                    ),
                )?,
            );
        }
        let ws = s.get(c"chatWs")?;
        if !call(ws, c"isOpen", &[])?.truthy()? {
            call(ws, c"connect", &[])?;
        }
        let c = fields(s, &[("state", s), ("text", value)])?;
        then(call(ws, c"ensureOpen", &[num(s, 2000.)?])?, c, |c, _| {
            call(
                c.get(c"state")?.get(c"chatWs")?,
                c"sendUserMessage",
                &[c.get(c"text")?],
            )?;
            undef(c)
        })
    })?;
    recover(handled, s, |s, a| {
        log(
            s,
            "error",
            concat(s, "Inbound handling error: ", message(a[0])?)?,
        )?;
        undef(s)
    })
}
