//! Runtime facts for the Rust Air front door. Only the private loopback route is mounted.
use crate::host_api::*;
use napi_derive::napi;
use std::ffi::CStr;
mod archive;
mod detail;
mod lists;
mod snapshot;
mod timing;

const HOST_PATH: &str = "/api/__host/air";
fn js_or<'a>(v: L<'a>, alternative: L<'a>) -> Result<L<'a>> {
    Ok(if v.truthy()? { v } else { alternative })
}
fn nullable(v: L<'_>) -> Result<L<'_>> {
    js_or(v, null(v)?)
}
fn value_or_null(v: L<'_>) -> Result<L<'_>> {
    Ok(if v.undefined()? { null(v)? } else { v })
}
fn deps(p: L<'_>) -> Result<L<'_>> {
    p.get(c"deps")
}
fn ports(p: L<'_>) -> Result<L<'_>> {
    p.get(c"ports")
}
fn shell(p: L<'_>) -> Result<L<'_>> {
    deps(p)?.get(c"shell")
}
fn get<'a>(map: L<'a>, key: L<'a>) -> Result<L<'a>> {
    call(map, c"get", &[key])
}
fn rec<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    get(deps(p)?.get(c"records")?, id)
}
fn lookup<'a>(o: L<'a>, k: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    let f = o.optional(k)?;
    if f.nullish()? {
        undef(o)
    } else {
        f.call(o, args)
    }
}
fn values(o: L<'_>) -> Result<L<'_>> {
    call(o.global()?.get(c"Object")?, c"values", &[o])
}
fn map(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"Map")?.construct(&[])
}
fn append<'a>(arr: L<'a>, v: L<'a>) -> Result<()> {
    call(arr, c"push", &[v])?;
    Ok(())
}
fn event_session(t: L<'_>) -> Result<L<'_>> {
    let chat = t.get(c"chatSessionId")?;
    if chat.truthy()? {
        Ok(chat)
    } else {
        nullable(t.get(c"sessionId")?)
    }
}
fn now_ms(p: L<'_>) -> Result<L<'_>> {
    call(p.global()?.get(c"Date")?, c"now", &[])
}
fn domain<'a>(p: L<'a>, args: &[(&str, L<'a>)]) -> Result<L<'a>> {
    call(
        ports(p)?.get(c"domain")?,
        c"taskDomain",
        &[fields(p, args)?],
    )
}
fn env_number(p: L<'_>, key: &CStr, default: f64) -> Result<f64> {
    let value = ports(p)?
        .get(c"process")?
        .get(c"env")?
        .get(key)?
        .explicit_number()?;
    Ok(if value.is_finite() && value >= 0. {
        value
    } else {
        default
    })
}
fn refuse<'a>(p: L<'a>, message: &str, status: f64, code: &str) -> Result<L<'a>> {
    let e = error_value(p, message)?;
    e.assign(c"status", num(p, status)?)?;
    e.assign(c"code", text(p, code)?)?;
    Err(e.throw_error())
}
fn route_error<'a>(p: L<'a>, e: L<'a>) -> Result<L<'a>> {
    let out = fields(p, &[])?;
    let code = if e.truthy()? { e.get(c"code")? } else { e };
    let status = if e.truthy()? { e.get(c"status")? } else { e };
    if !code.undefined()? {
        out.set(c"code", string(code)?)?;
    }
    if !status.undefined()? {
        out.set(c"status", num(p, status.explicit_number()?)?)?;
    }
    if e.truthy()? && !e.get(c"message")?.undefined()? {
        out.set(c"message", string(e.get(c"message")?)?)?;
    }
    Ok(out)
}
fn invalidate(p: L<'_>, full: bool) -> Result<()> {
    let live = p.get(c"live")?;
    if !live.nullish()? {
        if full {
            call(live, c"invalidate", &[])?;
        } else {
            call(live, c"invalidate", &[array(p)?])?;
        }
    }
    Ok(())
}
fn invoke<'a>(p: L<'a>, b: L<'a>) -> Result<L<'a>> {
    let op = b
        .get(c"op")?
        .string()?
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    match op.as_str() {
        "archive-inactive" => archive::archive(p),
        "snapshot" => timing::snapshot_value(p, b.get(c"ifNoneMatch")?),
        "task-detail-scope" | "task-open" => detail::task(p, b.get(c"taskId")?, op == "task-open"),
        "resolve" => detail::resolve(p, b),
        "reclaim" => detail::reclaim(p, b),
        "create-task" => then(
            call(shell(p)?, c"createTask", &[b.get(c"body")?])?,
            p,
            |p, a| {
                call(
                    deps(p)?.get(c"admission")?,
                    c"identify",
                    &[a[0].get(c"sessionId")?],
                )?;
                Ok(a[0])
            },
        ),
        "reconcile" => then(
            call(
                shell(p)?,
                c"taskEntry",
                &[
                    b.get(c"taskId")?,
                    fields(p, &[("includeMessages", flag(p, false)?)])?,
                ],
            )?,
            p,
            |p, a| {
                call(
                    deps(p)?.get(c"admission")?,
                    c"recoverEvidence",
                    &[a[0].get(c"sessionId")?],
                )
            },
        ),
        "roles" => call(
            shell(p)?,
            c"updateRoleBindings",
            &[b.get(c"taskId")?, b.get(c"body")?],
        ),
        "pins-read" | "pins-replace" | "pins-toggle" | "todos-read" | "todos-replace"
        | "todos-toggle" | "todos-ignore" => lists::operation(p, b, &op),
        "sync" | "page" => {
            let live = p.get(c"live")?;
            if !live.truthy()? {
                return refuse(p, "首页摘要暂不可用，请稍后重试", 503., "air_closed");
            }
            let q = spread(b)?;
            q.delete(c"op")?;
            call(
                live,
                if op == "sync" {
                    c"syncHttp"
                } else {
                    c"pageHttp"
                },
                &[q],
            )
        }
        _ => ports(p)?.get(c"unknown"),
    }
}
fn normalized(body: L<'_>) -> Result<L<'_>> {
    if body.truthy()? && object(body)? && !body.is_array()? {
        Ok(body)
    } else {
        fields(body, &[])
    }
}
fn finish_write<'a>(ctx: L<'a>, ok: bool, v: L<'a>) -> Result<L<'a>> {
    let p = ctx.get(c"runtime")?;
    let op = ctx
        .get(c"input")?
        .get(c"op")?
        .string()?
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    if matches!(
        op.as_str(),
        "pins-replace" | "pins-toggle" | "todos-replace" | "todos-toggle" | "todos-ignore"
    ) || (ok
        && matches!(
            op.as_str(),
            "create-task" | "reclaim" | "reconcile" | "roles"
        ))
    {
        invalidate(p, false)?;
    }
    if ok {
        value_or_null(v)
    } else {
        Err(v.throw_error())
    }
}
fn handle<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let b = normalized(a[0])?;
        let ctx = fields(p, &[("runtime", p), ("input", b)])?;
        let mutating = async_result(p, || invoke(p, b))?;
        let success = then(mutating, ctx, |ctx, a| finish_write(ctx, true, a[0]))?;
        recover(success, ctx, |ctx, a| finish_write(ctx, false, a[0]))
    })
}
fn mount<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let d = deps(p)?;
    let live = p.get(c"live")?;
    if live.truthy()? {
        call(d, c"registerSync", &[live])?;
    }
    let handler = function(p, "", 2, 2, |p, a| {
        let (req, res) = (a[0], a[1]);
        let local = js_or(deps(p)?.get(c"isLocal")?, ports(p)?.get(c"local")?)?;
        if !local.call_plain(&[req])?.truthy()? {
            return call(
                call(res, c"status", &[num(p, 404.)?])?,
                c"json",
                &[fields(p, &[("error", text(p, "not found")?)])?],
            );
        }
        let ctx = fields(
            p,
            &[
                ("runtime", p),
                ("body", normalized(req.get(c"body")?)?),
                ("res", res),
            ],
        )?;
        let waiting = then(undef(p)?, ctx, |c, _| {
            handle(c.get(c"runtime")?, &mut [c.get(c"body")?])
        })?;
        let yes = function(ctx, "", 1, 1, |c, a| {
            let p = c.get(c"runtime")?;
            let r = c.get(c"res")?;
            let v = a[0];
            if v.equals(ports(p)?.get(c"unknown")?)? {
                return call(
                    call(r, c"status", &[num(p, 400.)?])?,
                    c"json",
                    &[fields(p, &[("error", text(p, "unknown host operation")?)])?],
                );
            }
            call(
                r,
                c"json",
                &[fields(
                    p,
                    &[("ok", flag(p, true)?), ("value", value_or_null(v)?)],
                )?],
            )
        })?;
        let no = function(ctx, "", 1, 1, |c, a| {
            call(
                c.get(c"res")?,
                c"json",
                &[fields(
                    c,
                    &[("ok", flag(c, false)?), ("error", route_error(c, a[0])?)],
                )?],
            )
        })?;
        call(waiting, c"then", &[yes, no])
    })?;
    call(a[0], c"post", &[text(p, HOST_PATH)?, handler])?;
    undef(p)
}
fn create<'a>(host: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let d = if a[0].truthy()? {
        a[0]
    } else {
        fields(host, &[])?
    };
    let p = fields(
        host,
        &[
            ("ports", host),
            ("deps", d),
            ("live", null(host)?),
            ("inFlight", num(host, 0.)?),
            ("lastLogAt", num(host, 0.)?),
        ],
    )?;
    let mut cache = d.get(c"cardCache")?;
    if !cache.truthy()? {
        let mode = ports(p)?
            .get(c"process")?
            .get(c"env")?
            .get(c"AIR_CARD_CACHE")?;
        let opts = fields(
            p,
            &[
                (
                    "mode",
                    js_or(
                        mode,
                        text(
                            p,
                            if d.get(c"registerSync")?.truthy()? {
                                "on"
                            } else {
                                "shadow"
                            },
                        )?,
                    )?,
                ),
                (
                    "verifyMs",
                    num(p, env_number(p, c"AIR_CARD_CACHE_VERIFY_MS", 60000.)?)?,
                ),
                (
                    "verifyBudget",
                    num(p, env_number(p, c"AIR_CARD_CACHE_VERIFY_BUDGET", 8.)?)?,
                ),
                ("logger", nullable(d.get(c"logger")?)?),
            ],
        )?;
        cache = call(host.get(c"cache")?, c"createAirCardCache", &[opts])?;
    }
    for (k, n) in [
        (c"prepareAsync", "prepareAsync"),
        (c"snapshotAsync", "snapshotAsync"),
    ] {
        if !callable(cache.get(k)?)? {
            return Err(p.type_error(&format!("[air] cardCache.{n}() is required")));
        }
    }
    p.set(c"cache", cache)?;
    timing::settings(p)?;
    if d.get(c"registerSync")?.truthy()? {
        let ctx = fields(
            p,
            &[
                ("storageNotice", d.get(c"storageNotice")?),
                (
                    "build",
                    function(p, "build", 1, 1, |p, a| timing::build(p, a[0]))?,
                ),
                ("index", d.get(c"airReadIndex")?),
                ("subscribe", d.get(c"subscribe")?),
                ("logger", d.get(c"logger")?),
                ("send", d.get(c"send")?),
                (
                    "taskIdsForSession",
                    function(p, "taskIdsForSession", 1, 1, |p, a| {
                        lists::ids_for_session(p, a[0])
                    })?,
                ),
            ],
        )?;
        p.set(c"live", host.get(c"createSync")?.call_plain(&[ctx])?)?;
    }
    fields(
        p,
        &[
            ("liveSync", p.get(c"live")?),
            ("handle", function(p, "handle", 1, 1, handle)?),
            ("mount", function(p, "mount", 1, 1, mount)?),
            (
                "airSnapshot",
                function(p, "airSnapshot", 1, 2, |p, a| {
                    snapshot::start(p, a[0], default_object(a[1])?)
                })?,
            ),
        ],
    )
}
#[napi]
pub fn air_routes_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    p.set(
        c"unknown",
        p.global()?
            .get(c"Symbol")?
            .call_plain(&[text(p, "unknown")?])?,
    )?;
    fields(
        p,
        &[
            ("HOST_PATH", text(p, HOST_PATH)?),
            (
                "createAirRuntime",
                function(p, "createAirRuntime", 1, 1, create)?,
            ),
        ],
    )
    .map(|v| v.raw())
}
