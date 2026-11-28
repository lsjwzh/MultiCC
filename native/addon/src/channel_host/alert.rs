use super::*;

pub(super) fn raise(rec: L<'_>, raw: L<'_>, from_host: bool) -> Result<()> {
    let s = rec.get(c"host")?;
    let id = rec.get(c"id")?;
    let key = cap(raw.get(c"key")?, 64.)?;
    let name = fold_string(key)?;
    let mut bytes = name.bytes();
    if !bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
        || !bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Ok(());
    }
    let alerts = rec.get(c"alerts")?;
    if raw.get(c"resolved")?.is_true()? {
        if call(alerts, c"delete", &[key])?.truthy()? {
            log(
                s,
                c"info",
                "plugin_alert_resolved",
                fields(s, &[("id", id), ("key", key)])?,
            )?;
        }
        return Ok(());
    }
    if call(alerts, c"has", &[key])?.truthy()? || alerts.get(c"size")?.number()? >= 20. {
        return Ok(());
    }
    let level = text(
        s,
        if raw.get(c"level")?.is_string("critical")? {
            "critical"
        } else {
            "warn"
        },
    )?;
    let title = value_or(cap(raw.get(c"title")?, 120.)?, key)?;
    let entry = fields(
        s,
        &[
            ("key", key),
            ("level", level),
            ("title", title),
            ("body", cap(raw.get(c"body")?, 500.)?),
            ("at", clock(s)?),
            ("fromHost", flag(s, from_host)?),
        ],
    )?;
    call(alerts, c"set", &[key, entry])?;
    if raw.get(c"replay")?.is_true()? {
        return Ok(());
    }
    let cutoff = clock(s)?.number()? - 3600000.;
    let times = array(s)?;
    rec.get(c"alertTimes")?.for_each(|v| {
        if v.number()? > cutoff {
            call(times, c"push", &[v])?;
        }
        Ok(())
    })?;
    rec.set(c"alertTimes", times)?;
    if times.get(c"length")?.number()? >= 10. {
        log(
            s,
            c"warn",
            "plugin_alert_throttled",
            fields(s, &[("id", id), ("key", key)])?,
        )?;
        return Ok(());
    }
    call(times, c"push", &[clock(s)?])?;
    log(
        s,
        c"warn",
        "plugin_alert",
        fields(
            s,
            &[("id", id), ("key", key), ("level", level), ("title", title)],
        )?,
    )?;
    let send = || -> Result<()> {
        let out = fields(
            s,
            &[
                ("source", id),
                ("sourceName", value_or(rec.get(c"spec")?.get(c"name")?, id)?),
            ],
        )?;
        out.spread_from(entry)?;
        s.get(c"alert")?.call_plain(&[out])?;
        Ok(())
    };
    if let Err(e) = send() {
        let err = caught_error(s, e)?;
        log(
            s,
            c"warn",
            "plugin_alert_delivery_failed",
            fields(
                s,
                &[("id", id), ("key", key), ("error", err.get(c"message")?)],
            )?,
        )?;
    }
    Ok(())
}
pub(super) fn check<'a>(rec: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let s = rec.get(c"host")?;
    let since = rec.get(c"downSince")?;
    if s.get(c"stopped")?.truthy()?
        || rec.get(c"stopping")?.truthy()?
        || rec.get(c"ready")?.truthy()?
        || !since.truthy()?
        || clock(s)?.number()? - since.number()? < s.get(c"downAlertMs")?.number()?
    {
        return undef(s);
    }
    let name = fold_string(value_or(rec.get(c"spec")?.get(c"name")?, rec.get(c"id")?)?)?;
    let exit = rec.get(c"lastExit")?;
    let body = if exit.truthy()? {
        let sig = exit.get(c"signal")?;
        let cause = if sig.truthy()? {
            fold_string(sig)?
        } else {
            format!("退出码 {}", fold_string(exit.get(c"code")?)?)
        };
        format!("插件进程已重启 {} 次仍未恢复（最后一次退出：{}）。在 MultiCC「资料与插件 → 插件」查看。",fold_string(rec.get(c"failures")?)?,cause)
    } else {
        "插件进程启动后一直没有就绪。在 MultiCC「资料与插件 → 插件」查看。".into()
    };
    raise(
        rec,
        fields(
            s,
            &[
                ("key", text(s, "plugin-down")?),
                ("level", text(s, "critical")?),
                ("title", text(s, &format!("{name} 停止运行"))?),
                ("body", text(s, &body)?),
            ],
        )?,
        true,
    )?;
    undef(s)
}
