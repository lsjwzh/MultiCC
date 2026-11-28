use super::*;

fn record<'a>(s: L<'a>, row: L<'a>) -> Result<()> {
    ignored(s, || port(s, c"recordProviderFailure", &[row]))
}
fn park<'a>(s: L<'a>, ctx: L<'a>, id: L<'a>, d: L<'a>, vendor: L<'a>) -> Result<()> {
    if !s.get(c"recordProviderFailure")?.truthy()? {
        return Ok(());
    }
    let e = d.get(c"error")?;
    let category = e.get(c"category")?;
    let provider = id.get(c"providerId")?;
    if !provider.truthy()? || provider.is_string("_default_")? {
        return Ok(());
    }
    if category.is_string("authentication_permission")? {
        if !vendor.truthy()? {
            let cause = e.get(c"rootCause")?;
            let v = if cause.truthy()? {
                cause
            } else {
                e.get(c"sanitizedMessage")?
            };
            if multicc_core::claude_refresh::looks_like_revoked_oauth(&fold_string(otherwise(
                v,
                text(s, "")?,
            )?)?) {
                record(
                    s,
                    fields(s, &[("providerId", provider), ("category", category)])?,
                )?;
            }
        }
        return Ok(());
    }
    if !category.is_string("rate_limit")? && !category.is_string("billing_quota")? {
        return Ok(());
    }
    if e.get(c"httpStatus")?.explicit_number()? != 429. && !e.get(c"rejection")?.truthy()? {
        return Ok(());
    }
    let runner = ctx.get(c"runner")?;
    let attempt = runner.optional(c"providerAttempt")?;
    if object(attempt)? && s.get(c"proxyFailureForAttempt")?.truthy()? {
        if let Some(failure) = s.catch(|| port(s, c"proxyFailureForAttempt", &[attempt]))? {
            if failure.truthy()? && failure.get(c"httpStatus")?.explicit_number()? == 429. {
                return Ok(());
            }
        }
    }
    let data = fields(
        s,
        &[
            ("sessionId", ctx.get(c"sessionName")?),
            ("providerId", provider),
            ("category", category),
            ("httpStatus", num(s, 429.)?),
        ],
    )?;
    if e.get(c"rejection")?.truthy()? {
        data.set(c"rejection", e.get(c"rejection")?)?;
    }
    if object(runner.optional(c"providerAttempt")?)? {
        let model = identity::clean(runner.get(c"providerAttempt")?.get(c"model")?)?;
        if model.truthy()? {
            data.set(c"model", model)?;
        }
    }
    record(s, data)
}
pub(super) fn publish<'a>(s: L<'a>, ctx: L<'a>, id: L<'a>, d: L<'a>, safe: L<'a>) -> Result<()> {
    let ports = s.get(c"ports")?;
    let cli = id.get(c"cli")?;
    let e = d.get(c"error")?;
    let separate = cli.is_string("commandcode")?
        && ctx
            .get(c"persisted")?
            .optional(c"cliAccounts")?
            .optional(c"commandcode")?
            .truthy()?;
    let vendor = if e.get(c"category")?.is_string("authentication_permission")? && !separate {
        port(ports, c"vendorLoginForCli", &[cli])?
    } else {
        null(s)?
    };
    park(s, ctx, id, d, vendor)?;
    let action = if vendor.truthy()? {
        let out = fields(
            s,
            &[
                ("kind", text(s, "vendor_login_terminal")?),
                ("cli", cli),
                ("label", vendor.get(c"label")?),
                ("loginCommand", vendor.get(c"loginCommand")?),
            ],
        )?;
        if vendor.get(c"autoStart")?.truthy()? {
            out.set(c"autoStart", flag(s, true)?)?;
        }
        Some(out)
    } else {
        None
    };
    let mut notice = raw(
        s,
        crate::api_error_policy::api_error_retry_notice(env(s), arg(d)?)?,
    );
    if vendor.truthy()? {
        let hint = if vendor.get(c"autoStart")?.truthy()? {
            text(s, "按提示完成浏览器授权")?
        } else {
            call(
                text(s, "输入 ")?,
                c"concat",
                &[vendor.get(c"loginCommand")?, text(s, " 完成登录")?],
            )?
        };
        notice = call(
            notice,
            c"concat",
            &[
                text(s, " ")?,
                vendor.get(c"label")?,
                text(s, " 使用厂商独立账号：点下方按钮打开登录终端，")?,
                hint,
                text(s, "后再重新发送。")?,
            ],
        )?;
    }
    let cause = e.get(c"rootCause")?;
    let detail = if cause.truthy()? {
        cause
    } else {
        e.get(c"sanitizedMessage")?
    };
    let hint = port(
        ports,
        c"systemProxyHijackHint",
        &[fields(
            s,
            &[
                ("cli", cli),
                ("httpStatus", e.get(c"httpStatus")?),
                ("detail", detail),
            ],
        )?],
    )?;
    if hint.truthy()? {
        notice = call(notice, c"concat", &[text(s, " ")?, hint])?;
    }
    let session = ctx.get(c"sessionName")?;
    let state = if d.get(c"action")?.is_string("retry")? {
        "retry_wait"
    } else {
        "failed"
    };
    let event = fields(
        s,
        &[
            ("type", text(s, "api_error_policy")?),
            ("state", text(s, state)?),
            ("message", notice),
        ],
    )?;
    event.spread_from(safe)?;
    if let Some(action) = action {
        event.set(c"authAction", action)?;
    }
    port(s, c"chatBroadcast", &[session, event])?;
    if !ctx.get(c"deferNotice")?.truthy()? {
        let warning = fields(
            s,
            &[
                ("type", text(s, "system")?),
                ("subtype", text(s, "warning")?),
                ("message", notice),
            ],
        )?;
        if let Some(action) = action {
            warning.set(c"authAction", action)?;
        }
        port(s, c"chatBroadcast", &[session, warning])?;
    }
    Ok(())
}
