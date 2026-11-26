//! A successful external mutation is compensated if persistence fails. The
//! stored desired mapping and probe evidence change only after persistence.
use super::super::{config as settings, invalidate_funnel, start_loop, with_mutation};
use super::*;

pub(super) fn reapply<'a>(s: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let configured = opts.get(c"funnelConfig")?;
    let cfg = if configured.undefined()? {
        config(s, "tailscale")?
    } else {
        configured
    };
    if !cfg.truthy()?
        || !cfg.get(c"funnel")?.is_true()?
        || !settings::valid_port(cfg.get(c"funnelPort")?)?
    {
        return Err(failure(s, "invalid tailscale funnel config", None)?.throw_error());
    }
    let port = label(cfg.get(c"funnelPort")?)?;
    let result = run(s, opts.get(c"run")?, TAILSCALE, &["funnel", "--bg", &port])?;
    after(
        text(
            s,
            &format!("已重新应用 Tailscale Funnel（端口 {port}），等待公网复检"),
        )?,
        result,
        |msg, r| {
            if !r.get(c"ok")?.truthy()? {
                return Err(failure(
                    msg,
                    "tailscale funnel reapply failed",
                    Some(r.get(c"stderr")?),
                )?
                .throw_error());
            }
            Ok(msg)
        },
    )
}
pub(super) fn status(s: L<'_>) -> Result<L<'_>> {
    let p = run(s, undefined(s)?, TAILSCALE, &["funnel", "status"])?;
    after(s, p, |s, r| {
        if !r.get(c"ok")?.truthy()? {
            return Err(
                failure(s, "tailscale funnel status failed", Some(r.get(c"stderr")?))?
                    .throw_error(),
            );
        }
        call(fallback(r.get(c"stdout")?, "".into())?, c"trim", &[])
    })
}
fn reply<'a>(s: L<'a>, ok: bool, message: &str) -> Result<L<'a>> {
    fields(s, &[("ok", flag(s, ok)?), ("message", text(s, message)?)])
}
fn command<'a>(s: L<'a>, f: L<'a>, on: bool, port: &str) -> Result<L<'a>> {
    if on {
        run(s, f, TAILSCALE, &["funnel", "--bg", port])
    } else {
        run(s, f, TAILSCALE, &["funnel", "reset"])
    }
}
fn commit<'a>(f: L<'a>, result: L<'a>) -> Result<L<'a>> {
    let s = f.get(c"owner")?;
    if !result.get(c"ok")?.truthy()? {
        return reply(s, false, "Funnel 操作失败");
    }
    let on = f.get(c"on")?.truthy()?;
    let port = f.get(c"port")?;
    let cfg = crate::js_live::spread(s.get(c"config")?)?;
    let tailscale = crate::js_live::spread(config(s, "tailscale")?)?;
    tailscale.set(c"funnel", flag(s, on)?)?;
    tailscale.set(c"funnelPort", port)?;
    cfg.set(c"tailscale", tailscale)?;
    let persist = f.get(c"persist")?;
    let wrote = if persist.undefined()? {
        settings::save(s, cfg)
    } else {
        persist.call_plain(&[cfg]).map(|_| ())
    };
    if let Err(error) = wrote {
        let original = match s.exception_value()? {
            Some(err) => err,
            None => failure(s, &error.reason, None)?,
        };
        let previous = f.get(c"previous")?;
        let args_port = settings::port(previous.get(c"funnelPort")?)?.to_string();
        let rollback = command(
            s,
            f.get(c"run")?,
            previous.get(c"funnel")?.is_true()?,
            &args_port,
        )?;
        let f = frame(s, &[("error", original)])?;
        return after(f, rollback, |f, result| {
            let err = f.get(c"error")?;
            if !result.get(c"ok")?.truthy()? {
                let problem = failure(
                    f,
                    "tailscale funnel compensation failed",
                    Some(result.get(c"stderr")?),
                )?;
                err.assign(c"rollbackError", problem)?;
                settings::consistency_failure(f.get(c"owner")?, "funnel_compensation")?;
            }
            Err(err.throw_error())
        });
    }
    s.set(c"config", cfg)?;
    settings::replace_snapshot(s, "tailscale")?;
    start_loop(s)?;
    if on {
        reply(
            s,
            true,
            &format!("已开启 Funnel 公网访问 (端口 {})", label(port)?),
        )
    } else {
        reply(s, true, "已关闭所有 Funnel")
    }
}
pub(super) fn set<'a>(s: L<'a>, on: L<'a>, port: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    if !settings::valid_port(port)? {
        return reply(s, false, "Funnel operation failed");
    }
    invalidate_funnel(s)?;
    let f = frame(
        s,
        &[
            ("on", on),
            ("port", port),
            ("run", opts.get(c"run")?),
            ("persist", opts.get(c"persist")?),
        ],
    )?;
    let mutate = function(f, "", 0, 0, |f, _| {
        let s = f.get(c"owner")?;
        settings::reset_evidence(s.get(c"states")?.get(c"tailscale")?)?;
        f.set(
            c"previous",
            crate::js_live::spread(config(s, "tailscale")?)?,
        )?;
        let result = command(
            s,
            f.get(c"run")?,
            f.get(c"on")?.truthy()?,
            &label(f.get(c"port")?)?,
        )?;
        after(f, result, commit)
    })?;
    let result = with_mutation(s, mutate)?;
    let clear = function(s, "", 0, 0, |s, _| {
        invalidate_funnel(s)?;
        undefined(s)
    })?;
    call(result, c"finally", &[clear])
}
