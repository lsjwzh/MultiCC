use super::*;

fn perform(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    let injected = f.get(c"restarter")?;
    if !injected.undefined()? {
        if injected.kind()? != sys::ValueType::napi_function {
            return Err(f.type_error("restarter is not a function"));
        }
        return injected.call_plain(&[]);
    }
    if f.get(c"funnel")?.is_true()? {
        let target = fields(
            s,
            &[("funnel", flag(s, true)?), ("funnelPort", f.get(c"port")?)],
        )?;
        return providers::reapply(s, fields(s, &[("funnelConfig", target)])?);
    }
    providers::restart(s, &printable(f.get(c"name")?)?, fields(s, &[])?)
}
fn append_time<'a>(st: L<'a>, key: &CStr, at: L<'a>) -> Result<()> {
    let entries = call(st.get(key)?, c"slice", &[num(st, -99.)?])?;
    call(entries, c"push", &[at])?;
    st.set(key, entries)
}
fn outcome<'a>(
    f: L<'a>,
    on_success: for<'b> fn(L<'b>, L<'b>) -> Result<L<'b>>,
    on_failure: for<'b> fn(L<'b>, L<'b>) -> Result<L<'b>>,
) -> Result<L<'a>> {
    let p = async_result(f, || perform(f))?;
    let handled = then(f, p, on_success)?;
    call(
        handled,
        c"catch",
        &[callback(f, "", 1, 1, move |f, a| on_failure(f, a[0]))?],
    )
}
pub(super) fn manual(f: L<'_>) -> Result<L<'_>> {
    let st = f.get(c"st")?;
    config::reset_evidence(st)?;
    let at = now(st)?;
    config::prune(st, at)?;
    let at = num(st, at)?;
    st.set(c"lastAttemptAt", at)?;
    append_time(st, c"attemptTimes", at)?;
    outcome(
        f,
        |f, msg| {
            let st = f.get(c"st")?;
            st.set(c"lastAction", msg)?;
            let t = now(st)?;
            config::prune(st, t)?;
            let t = num(st, t)?;
            append_time(st, c"restartTimes", t)?;
            st.set(c"lastRestartAt", t)?;
            fields(st, &[("ok", flag(st, true)?), ("message", msg)])
        },
        |f, err| {
            let s = f.get(c"s")?;
            let name = printable(f.get(c"name")?)?;
            let msg = if name == "tailscale" {
                text(s, "Tailscale 控制面重连失败")?
            } else {
                providers::redact(s, &name, err)?
            };
            f.get(c"st")?.set(
                c"lastAction",
                call(text(s, "重启失败: ")?, c"concat", &[msg])?,
            )?;
            print(
                s,
                c"error",
                &format!("[multicc/tunnel] manual {name} restart failed"),
            )?;
            fields(
                s,
                &[
                    ("ok", flag(s, false)?),
                    ("error", text(s, "restart_failed")?),
                    ("message", msg),
                ],
            )
        },
    )
}
pub(super) fn automatic<'a>(f: L<'a>, probe: &Observation<'a>) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    let st = f.get(c"st")?;
    let cfg = s.get(c"config")?;
    let at = now(s)?;
    let cooldown = cfg
        .get(c"restartCooldownSec")?
        .number_value()?
        .filter(|n| n.fract() == 0. && *n >= 0.)
        .unwrap_or(120.);
    let last = st.get(c"lastAttemptAt")?.number()?;
    if last != 0. && at - last < cooldown * 1000. {
        return note(
            st,
            &format!(
                "等待冷却（{}s）",
                ((cooldown * 1000. - (at - last)) / 1000.).ceil()
            ),
        );
    }
    config::prune(st, at)?;
    let limit = cfg
        .get(c"maxRestartsPerHour")?
        .number_value()?
        .filter(|n| n.fract() == 0. && *n >= 1.)
        .unwrap_or(5.)
        .min(100.);
    let mut n = 0;
    st.get(c"attemptTimes")?.for_each(|v| {
        if at - v.number()? < 3600000. {
            n += 1;
        }
        Ok(())
    })?;
    if n as f64 >= limit {
        return note(st, &format!("已达每小时重启尝试上限（{limit}），暂停重启"));
    }
    let stamp = num(s, at)?;
    f.set(c"at", stamp)?;
    st.set(c"lastAttemptAt", stamp)?;
    append_time(st, c"attemptTimes", stamp)?;
    let name = printable(f.get(c"name")?)?;
    let reason = if probe.error.is_empty() {
        format!("HTTP {}", probe.http)
    } else {
        probe.error.clone()
    };
    print(
        s,
        c"warn",
        &format!("[multicc/tunnel] {name} unhealthy ({reason}), repairing..."),
    )?;
    let work = outcome(
        f,
        |f, action| {
            let st = f.get(c"st")?;
            let at = f.get(c"at")?;
            st.set(c"lastAction", action)?;
            append_time(st, c"restartTimes", at)?;
            st.set(c"lastRestartAt", at)?;
            undef(st)
        },
        |f, e| {
            let name = printable(f.get(c"name")?)?;
            let msg = providers::redact(f.get(c"s")?, &name, e)?;
            f.get(c"st")?.set(
                c"lastAction",
                call(text(f, "重启失败: ")?, c"concat", &[msg])?,
            )?;
            print(
                f,
                c"error",
                &format!("[multicc/tunnel] {name} restart command failed"),
            )?;
            undef(f)
        },
    )?;
    then(f, work, |f, _| {
        print(
            f,
            c"log",
            &format!(
                "[multicc/tunnel] {}: {}",
                printable(f.get(c"name")?)?,
                printable(f.get(c"st")?.get(c"lastAction")?)?
            ),
        )?;
        undef(f)
    })
}
pub(super) fn funnel(f: L<'_>) -> Result<L<'_>> {
    if !current(f)? {
        return undef(f);
    }
    let s = f.get(c"s")?;
    let st = f.get(c"st")?;
    let pc = s.get(c"config")?.get(c"tailscale")?;
    if !pc.get(c"funnel")?.is_true()?
        || !pc.get(c"enabled")?.is_true()?
        || !pc.get(c"monitorOnly")?.is_false()?
        || !pc.get(c"funnelPort")?.equals(f.get(c"port")?)?
    {
        return undef(f);
    }
    let at = now(s)?;
    let guard = ledger::guard(s, at)?;
    if !guard.get(c"ok")?.truthy()? {
        st.set(c"repairableFailStreak", num(st, 0.)?)?;
        let message = match printable(guard.get(c"reason")?)?.as_str() {
            "ledger_unavailable" => "Funnel 修复账本不可用，未执行自动修复".into(),
            "cooldown" => format!(
                "Funnel 自动修复等待冷却（{}s）",
                printable(guard.get(c"waitSec")?)?
            ),
            "hour_cap" => "已达 Funnel 每小时修复上限（2）".into(),
            "day_cap" => "已达 Funnel 每日修复上限（4）".into(),
            _ => "Funnel 自动修复受保护规则抑制".into(),
        };
        return note(st, &message);
    }
    let Some(reservation) = s.catch(|| ledger::reserve(s, at))? else {
        st.set(c"repairableFailStreak", num(st, 0.)?)?;
        return note(st, "Funnel 修复账本写入失败，未执行自动修复");
    };
    let stamp = num(s, at)?;
    f.set(c"at", stamp)?;
    f.set(c"reservation", num(s, reservation)?)?;
    st.set(c"lastAttemptAt", stamp)?;
    config::prune(st, at)?;
    call(st.get(c"attemptTimes")?, c"push", &[stamp])?;
    config::reset_evidence(st)?;
    print(
        s,
        c"warn",
        "[multicc/tunnel] tailscale confirmed public data plane down; reapplying Funnel mapping",
    )?;
    let work = outcome(
        f,
        |f, value| {
            let s = f.get(c"s")?;
            ledger::settle(s, f.get(c"reservation")?.number()?, "command_succeeded")?;
            if current(f)?
                && s.get(c"config")?
                    .get(c"tailscale")?
                    .get(c"funnelPort")?
                    .equals(f.get(c"port")?)?
            {
                let st = f.get(c"st")?;
                let at = f.get(c"at")?;
                st.set(c"lastAction", value)?;
                append_time(st, c"restartTimes", at)?;
                st.set(c"lastRestartAt", at)?;
            }
            undef(f)
        },
        |f, _| {
            let s = f.get(c"s")?;
            ledger::settle(s, f.get(c"reservation")?.number()?, "command_failed")?;
            if current(f)? {
                note(f.get(c"st")?, "修复失败: tailscale_funnel_reapply_failed")?;
                print(
                    s,
                    c"error",
                    "[multicc/tunnel] tailscale Funnel repair command failed",
                )?;
            }
            undef(f)
        },
    )?;
    then(f, work, |f, _| {
        if current(f)? {
            print(
                f,
                c"log",
                &format!(
                    "[multicc/tunnel] tailscale: {}",
                    printable(f.get(c"st")?.get(c"lastAction")?)?
                ),
            )?;
        }
        undef(f)
    })
}
