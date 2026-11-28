//! Host I/O adapters and provider commands. All user and automatic Funnel
//! writes share the monitor's serialized mutation queue.
use crate::host_methods::{async_result, default_object, function};
use crate::route_response::*;
use std::ffi::CStr;

mod cli;
mod funnel;
mod ipv6;
mod sakura;

const TAILSCALE: &str = "/usr/local/bin/tailscale";
const PHDDNS: &str = "/Applications/PhDDNS.app";
const SAKURA_START: &str = "frpc -f {authtoken}";

fn undefined(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Undefined)
}
fn label(v: L<'_>) -> Result<String> {
    Ok(v.coerce_string()?.to_string_lossy())
}
fn array<'a>(s: L<'a>, args: &[L<'a>]) -> Result<L<'a>> {
    let out = s.from_value(&V::Array(vec![]))?;
    for (i, v) in args.iter().enumerate() {
        out.set_element(i as u32, *v)?;
    }
    Ok(out)
}
fn strings<'a>(s: L<'a>, args: &[&str]) -> Result<L<'a>> {
    let values = args
        .iter()
        .map(|v| text(s, v))
        .collect::<Result<Vec<_>>>()?;
    array(s, &values)
}
fn frame<'a>(s: L<'a>, args: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let state = fields(s, args)?;
    state.set(c"owner", s)?;
    Ok(state)
}
fn option<'a>(options: L<'a>, name: &CStr, default: L<'a>) -> Result<L<'a>> {
    let value = options.get(name)?;
    Ok(if value.undefined()? { default } else { value })
}
fn promise(s: L<'_>) -> Result<L<'_>> {
    s.global()?.get(c"Promise")
}
fn after<'a>(
    f: L<'a>,
    v: L<'a>,
    next: impl for<'b> Fn(L<'b>, L<'b>) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let p = call(promise(f)?, c"resolve", &[v])?;
    call(
        p,
        c"then",
        &[function(f, "", 1, 1, move |f, a| next(f, a[0]))?],
    )
}
fn failure<'a>(s: L<'a>, message: &str, cause: Option<L<'a>>) -> Result<L<'a>> {
    let err = s.global()?.get(c"Error")?.construct(&[text(s, message)?])?;
    if let Some(cause) = cause {
        err.set(c"cause", fallback(cause, "unknown error".into())?)?
    }
    Ok(err)
}
fn config<'a>(s: L<'a>, name: &str) -> Result<L<'a>> {
    s.get(c"config")?.get_key(text(s, name)?)
}
fn checked<'a>(s: L<'a>, result: L<'a>, message: &str, success: &str) -> Result<L<'a>> {
    if !result.get(c"ok")?.truthy()? {
        return Err(failure(s, message, Some(result.get(c"stderr")?))?.throw_error());
    }
    text(s, success)
}
fn exec<'a>(s: L<'a>, cmd: L<'a>, args: L<'a>) -> Result<L<'a>> {
    let f = frame(s, &[("cmd", cmd), ("args", args)])?;
    let operation = function(f, "", 1, 1, |f, a| {
        let complete = function(a[0], "", 3, 3, |resolve, a| {
            let err = a[0];
            let stderr = a[2];
            let stderr = if stderr.truthy()? {
                stderr
            } else {
                fallback(err.optional(c"message")?, "".into())?
            };
            resolve.call_plain(&[fields(
                resolve,
                &[
                    ("ok", flag(resolve, !err.truthy()?)?),
                    (
                        "code",
                        if err.truthy()? {
                            err.get(c"code")?
                        } else {
                            num(resolve, 0.)?
                        },
                    ),
                    ("stdout", fallback(a[1], "".into())?),
                    ("stderr", stderr),
                ],
            )?])
        })?;
        let opt = fields(
            f,
            &[
                ("windowsHide", flag(f, true)?),
                ("timeout", num(f, 20_000.)?),
            ],
        )?;
        f.get(c"owner")?.get(c"execFile")?.call_plain(&[
            f.get(c"cmd")?,
            f.get(c"args")?,
            opt,
            complete,
        ])
    })?;
    promise(s)?.construct(&[operation])
}
fn run<'a>(s: L<'a>, run: L<'a>, cmd: &str, args: &[&str]) -> Result<L<'a>> {
    let args = strings(s, args)?;
    if run.undefined()? {
        exec(s, text(s, cmd)?, args)
    } else {
        run.call_plain(&[text(s, cmd)?, args])
    }
}
pub(super) fn prepare(s: L<'_>) -> Result<()> {
    let data = s.get(c"process")?.get(c"env")?.get(c"MULTICC_DATA_DIR")?;
    s.set(
        c"frpcDest",
        cli::frpc_dest(s, fields(s, &[("dataDir", data)])?)?,
    )?;
    s.set(
        c"execShell",
        function(s, "execShell", 2, 2, |s, a| exec(s, a[0], a[1]))?,
    )
}
pub(super) fn availability(s: L<'_>) -> Result<L<'_>> {
    cli::available(s)
}
pub(super) fn probe<'a>(s: L<'a>, url: L<'a>) -> Result<L<'a>> {
    let f = frame(s, &[("url", url)])?;
    let operation = function(f, "", 1, 1, |f, a| {
        let resolve = a[0];
        let url = f.get(c"url")?;
        if !url.truthy()? {
            return resolve.call_plain(&[num(f, 0.)?]);
        }
        let module = f.catch(|| {
            let https = call(url, c"startsWith", &[text(f, "https")?])?.truthy()?;
            f.get(c"owner")?.get(if https { c"https" } else { c"http" })
        })?;
        let Some(module) = module else {
            return resolve.call_plain(&[num(f, 0.)?]);
        };
        let response = function(resolve, "", 1, 1, |resolve, a| {
            call(a[0], c"resume", &[])?;
            resolve.call_plain(&[fallback(a[0].get(c"statusCode")?, V::Number(0.))?])
        })?;
        let opt = fields(
            f,
            &[
                ("timeout", num(f, 12_000.)?),
                ("rejectUnauthorized", flag(f, false)?),
            ],
        )?;
        let req = call(module, c"get", &[url, opt, response])?;
        let state = fields(f, &[("req", req), ("resolve", resolve)])?;
        let timeout = function(state, "", 0, 0, |state, _| {
            call(state.get(c"req")?, c"destroy", &[])?;
            state.get(c"resolve")?.call_plain(&[num(state, 0.)?])
        })?;
        let fail = function(resolve, "", 0, 0, |resolve, _| {
            resolve.call_plain(&[num(resolve, 0.)?])
        })?;
        call(req, c"on", &[text(f, "timeout")?, timeout])?;
        call(req, c"on", &[text(f, "error")?, fail])
    })?;
    promise(s)?.construct(&[operation])
}
pub(super) fn funnel_probe(s: L<'_>) -> Result<L<'_>> {
    let current = s.get(c"probe")?;
    if current.truthy()? {
        return Ok(current);
    }
    let made = super::funnel_health::owner(
        s.get(c"ports")?,
        fields(
            s,
            &[
                ("run", s.get(c"execShell")?),
                ("tailscaleBin", text(s, TAILSCALE)?),
            ],
        )?,
    )?;
    s.set(c"probe", made)?;
    Ok(made)
}
pub(super) fn restart<'a>(s: L<'a>, name: &str, options: L<'a>) -> Result<L<'a>> {
    async_result(s, || {
        let opts = default_object(options)?;
        match name {
            "phddns" => cli::phddns(s, opts),
            "tailscale" => {
                let v = run(s, opts.get(c"run")?, TAILSCALE, &["up"])?;
                after(s, v, |s, v| {
                    checked(s, v, "tailscale restart failed", "已执行 tailscale up")
                })
            }
            "natapp" | "cpolar" | "sakurafrp" => cli::restart(s, name),
            _ => Err(failure(s, "unknown provider", None)?.throw_error()),
        }
    })
}
pub(super) fn reapply<'a>(s: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    async_result(s, || funnel::reapply(s, default_object(opts)?))
}
pub(super) fn redact<'a>(s: L<'a>, name: &str, error: L<'a>) -> Result<L<'a>> {
    let mut message = fallback(error.optional(c"message")?, "unknown error".into())?;
    let cause = error.optional(c"cause")?;
    if cause.truthy()? {
        message = call(message, c"concat", &[text(s, ": ")?, cause])?;
    }
    let secret = config(s, name)?.optional(c"authtoken")?;
    if secret.truthy()? {
        message = call(
            call(message, c"split", &[secret])?,
            c"join",
            &[text(s, "***")?],
        )?;
    }
    if message.get(c"length")?.number()? > 300. {
        message = call(
            call(message, c"slice", &[num(s, 0.)?, num(s, 300.)?])?,
            c"concat",
            &[text(s, "…")?],
        )?;
    }
    Ok(message)
}
pub(super) fn install<'a>(s: L<'a>, api: L<'a>) -> Result<()> {
    for (key, provider) in [
        (c"restartPhddns".as_ref(), "phddns"),
        (c"restartTailscale", "tailscale"),
        (c"restartNatapp", "natapp"),
        (c"restartCpolar", "cpolar"),
        (c"restartSakurafrp", "sakurafrp"),
    ] {
        api.set(
            key,
            function(s, key.to_str().unwrap(), 0, 1, move |s, a| {
                restart(s, provider, a[0])
            })?,
        )?;
    }
    api.set(
        c"reapplyTailscaleFunnel",
        function(s, "reapplyTailscaleFunnel", 0, 1, |s, a| reapply(s, a[0]))?,
    )?;
    api.set(
        c"availability",
        function(s, "availability", 0, 0, |s, _| availability(s))?,
    )?;
    api.set(
        c"defaultFrpcDest",
        function(s, "defaultFrpcDest", 0, 1, |s, a| {
            cli::frpc_dest(s, default_object(a[0])?)
        })?,
    )?;
    api.set(
        c"funnelStatus",
        function(s, "funnelStatus", 0, 0, |s, _| {
            async_result(s, || funnel::status(s))
        })?,
    )?;
    api.set(
        c"setFunnel",
        function(s, "setFunnel", 2, 3, |s, a| {
            async_result(s, || funnel::set(s, a[0], a[1], default_object(a[2])?))
        })?,
    )?;
    api.set(
        c"ipv6Status",
        function(s, "ipv6Status", 0, 0, |s, _| {
            async_result(s, || ipv6::status(s))
        })?,
    )?;
    for (key, apply) in [
        (c"sakuraAccess".as_ref(), false),
        (c"sakuraApplyPublicUrl", true),
    ] {
        api.set(
            key,
            function(s, key.to_str().unwrap(), 0, 1, move |s, a| {
                async_result(s, || sakura::access(s, default_object(a[0])?, apply))
            })?,
        )?;
    }
    Ok(())
}
