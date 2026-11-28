//! A single-use HTTP callback bound to the loopback interface.
use super::*;

const PAGE_OK: &str = r#"<!doctype html><meta charset="utf-8"><title>multicc</title><body style="font-family:system-ui;padding:2em">✅ 登录完成，可以关闭本页，回到 multicc 查看账号。<br>Login complete — you can close this tab.</body>"#;
const PAGE_ERR: &str = r#"<!doctype html><meta charset="utf-8"><title>multicc</title><body style="font-family:system-ui;padding:2em">❌ 登录失败，请回 multicc 重试。<br>Login failed — please retry from multicc.</body>"#;

fn finish<'a>(ctx: L<'a>, deliver: L<'a>, value: L<'a>) -> Result<L<'a>> {
    if ctx.get(c"settled")?.truthy()? {
        return undef(ctx);
    }
    ctx.set(c"settled", flag(ctx, true)?)?;
    call(ctx.global()?, c"clearTimeout", &[ctx.get(c"timer")?])?;
    let msg = fields(ctx, &[("action", deliver), ("value", value)])?;
    let settle = function(msg, "settle", 0, 0, |msg, _| {
        let f = msg.get(c"action")?;
        if callable(f)? {
            f.call_plain(&[msg.get(c"value")?])?;
        }
        undef(msg)
    })?;
    let s = ctx.get(c"server")?;
    if !s.truthy()? || ctx.catch(|| call(s, c"close", &[settle]))?.is_none() {
        settle.call_plain(&[])?;
    }
    undef(ctx)
}
fn query<'a>(url: L<'a>, key: &str) -> Result<L<'a>> {
    clean(call(url.get(c"searchParams")?, c"get", &[text(url, key)?])?)
}
fn response<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"ports")?;
    let req = a[0];
    let res = a[1];
    let ctor = ctx.global()?.get(c"URL")?;
    let url = ctx.catch(|| {
        ctor.construct(&[
            fallback(req.get(c"url")?, "/".into())?,
            text(ctx, "http://127.0.0.1")?,
        ])
    })?;
    let status = match url {
        None => 400.,
        Some(url) if !url.get(c"pathname")?.is_string("/callback")? => 404.,
        _ => 200.,
    };
    if status != 200. {
        call(res, c"writeHead", &[num(ctx, status)?])?;
        call(res, c"end", &[])?;
        return undef(ctx);
    }
    let url = url.expect("parsed callback");
    let err = query(url, "error")?;
    let code = query(url, "code")?;
    let state = query(url, "state")?;
    let ok = !err.truthy()? && code.truthy()?;
    let h = fields(p, &[("content-type", text(p, "text/html; charset=utf-8")?)])?;
    call(res, c"writeHead", &[num(p, 200.)?, h])?;
    call(
        res,
        c"end",
        &[text(p, if ok { PAGE_OK } else { PAGE_ERR })?],
    )?;
    if ok {
        finish(
            ctx,
            ctx.get(c"resolve")?,
            fields(ctx, &[("code", code), ("state", state)])?,
        )
    } else {
        let msg = call(
            text(p, "authorization failed: ")?,
            c"concat",
            &[fallback(err, "missing code".into())?],
        )?;
        finish(
            ctx,
            ctx.get(c"reject")?,
            oauth_err(p, msg, null(p)?, null(p)?)?,
        )
    }
}
fn address(ctx: L<'_>) -> Result<L<'_>> {
    let s = ctx.get(c"server")?;
    if s.truthy()? {
        call(s, c"address", &[])
    } else {
        null(ctx)
    }
}
fn submit<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"ports")?;
    if ctx.get(c"settled")?.truthy()? {
        return fault(p, "this sign-in is over; start it again");
    }
    let raw = if a[0].nullish()? {
        text(p, "")?
    } else {
        string(a[0])?
    };
    let raw = call(raw, c"trim", &[])?;
    if !raw.truthy()? {
        return fault(
            p,
            "paste the address the browser ended on, or the code shown",
        );
    }
    let expected = default_object(a[1])?.get(c"expectedState")?;
    let lower = fold_string(raw)?.to_ascii_lowercase();
    let (code, state) = if lower.starts_with("http://") || lower.starts_with("https://") {
        let Some(url) = p.catch(|| p.global()?.get(c"URL")?.construct(&[raw]))? else {
            return fault(p, "that address is not a valid URL");
        };
        match fold_string(url.get(c"hostname")?)?
            .to_ascii_lowercase()
            .as_str()
        {
            "localhost" | "127.0.0.1" | "::1" | "[::1]" => {}
            _ => {
                return fault(
                    p,
                    "that address is not a loopback callback for this sign-in",
                )
            }
        }
        let addr = address(ctx)?;
        let port = fallback(
            url.get(c"port")?,
            if url.get(c"protocol")?.is_string("https:")? {
                "443".into()
            } else {
                "80".into()
            },
        )?;
        if !object(addr)? || addr.nullish()? || !port.equals(string(addr.get(c"port")?)?)? {
            return fault(
                p,
                "that address is from a different sign-in (port mismatch)",
            );
        }
        if !url.get(c"pathname")?.is_string("/callback")? {
            return fault(p, "that address is not a sign-in callback");
        }
        let code = query(url, "code")?;
        if !code.truthy()? {
            return fault(p, "that callback address has no code");
        }
        (code, query(url, "state")?)
    } else {
        let index = call(raw, c"indexOf", &[text(p, "#")?])?.number()?;
        let re = p.global()?.get(c"RegExp")?.construct(&[text(p, r"\s")?])?;
        if index <= 0.
            || index == raw.coerce_string()?.len() as f64 - 1.
            || call(re, c"test", &[raw])?.truthy()?
        {
            return fault(
                p,
                "paste the whole callback address, or the code shown as code#state",
            );
        }
        (
            call(raw, c"slice", &[num(p, 0.)?, num(p, index)?])?,
            call(raw, c"slice", &[num(p, index + 1.)?])?,
        )
    };
    if expected.truthy()? {
        if !state.truthy()? {
            return fault(p, "that callback address has no state to verify");
        }
        if !state.equals(expected)?
            || !code_state(p, code, state)?
                .get(c"state")?
                .equals(expected)?
        {
            return fault(p, "state mismatch (possible CSRF) — login discarded");
        }
    }
    finish(
        ctx,
        ctx.get(c"resolve")?,
        fields(p, &[("code", code), ("state", state)])?,
    )
}
pub(super) fn wait<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let o = default_object(a[0])?;
    let ctx = fields(
        p,
        &[
            ("ports", p),
            (
                "timeout",
                with_default(o.get(c"timeoutMs")?, num(p, 300000.)?)?,
            ),
            ("port", with_default(o.get(c"port")?, num(p, PORT)?)?),
        ],
    )?;
    let executor = function(ctx, "listen", 2, 2, |ctx, a| {
        ctx.set(c"resolve", a[0])?;
        ctx.set(c"reject", a[1])?;
        let s = call(
            ctx.get(c"ports")?.get(c"http")?,
            c"createServer",
            &[function(ctx, "callback", 2, 2, response)?],
        )?;
        ctx.set(c"server", s)?;
        let failed = function(ctx, "listenError", 1, 1, |ctx, a| {
            finish(ctx, ctx.get(c"reject")?, a[0])
        })?;
        call(s, c"once", &[text(ctx, "error")?, failed])?;
        call(s, c"listen", &[ctx.get(c"port")?, text(ctx, "127.0.0.1")?])?;
        let timeout = function(ctx, "timeout", 0, 0, |ctx, _| {
            let err = oauth_err(
                ctx.get(c"ports")?,
                text(ctx, "login timed out waiting for the browser callback")?,
                null(ctx)?,
                null(ctx)?,
            )?;
            finish(ctx, ctx.get(c"reject")?, err)
        })?;
        let timer = call(
            ctx.global()?,
            c"setTimeout",
            &[timeout, ctx.get(c"timeout")?],
        )?;
        ctx.set(c"timer", timer)?;
        if callable(timer.get(c"unref")?)? {
            call(timer, c"unref", &[])?;
        }
        undef(ctx)
    })?;
    let promise = p.global()?.get(c"Promise")?.construct(&[executor])?;
    fields(
        p,
        &[
            ("promise", promise),
            (
                "cancel",
                function(ctx, "cancel", 0, 0, |ctx, _| {
                    finish(ctx, undef(ctx)?, undef(ctx)?)
                })?,
            ),
            (
                "address",
                function(ctx, "address", 0, 0, |ctx, _| address(ctx))?,
            ),
            ("submit", function(ctx, "submit", 1, 2, submit)?),
        ],
    )
}
