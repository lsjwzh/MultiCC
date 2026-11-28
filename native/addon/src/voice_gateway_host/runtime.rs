//! Host-owned runtime facts and lifecycle effects behind the Rust public routes.
use super::routes::{
    as_object, authorized, base, guarded, ignore_rejection, install_flag, options, rejected, thrown,
};
use super::*;

fn global_put<'a>(p: L<'a>, body: L<'a>, res: L<'a>) -> Result<L<'a>> {
    let r = call(p.get(c"service")?, c"ensureGlobal", &[options(body)?])?;
    if !ok(r)? {
        return send(res, None, rejected(r)?);
    }
    let gw = r.get(c"gateway")?;
    if gw.get(c"enabled")?.is_true()? {
        let provisioned = opt_call(p.get(c"voiceRouter")?, c"ensure", &[])?;
        if provisioned.truthy()? && provisioned.get(c"ok")?.is_false()? {
            opt_call(
                p.get(c"log")?,
                c"warn",
                &[
                    text(p, "[multicc/voice] router provisioning failed")?,
                    pick(provisioned, &[c"code"])?,
                ],
            )?;
        }
    }
    opt_call(p.get(c"runtime")?, c"reconcileAll", &[install_flag(body)?])?;
    send(
        res,
        None,
        fields(
            p,
            &[
                ("ok", flag(p, true)?),
                ("created", r.get(c"created")?),
                ("gateway", gw),
            ],
        )?,
    )
}
fn finished_launch<'a>(s: L<'a>, status: L<'a>) -> Result<L<'a>> {
    let issued = s.get(c"issued")?;
    let l = issued.get(c"launch")?;
    let launch = pick(l, &[c"id", c"scope", c"expiresAt", c"display"])?;
    launch.set(
        c"sourceSessionId",
        or(l.get(c"sourceSessionId")?, null(s)?)?,
    )?;
    send(
        s.get(c"res")?,
        None,
        fields(
            s,
            &[
                ("ok", flag(s, true)?),
                ("launch", launch),
                (
                    "targetSessionId",
                    issued.get(c"context")?.get(c"targetSessionId")?,
                ),
                ("status", status),
            ],
        )?,
    )
}
fn launch_begin<'a>(p: L<'a>, b: L<'a>, res: L<'a>) -> Result<L<'a>> {
    let g = call(p.get(c"service")?, c"inspectGlobal", &[])?.get(c"gateway")?;
    if !g.get(c"configured")?.truthy()? || !g.get(c"enabled")?.is_true()? {
        return send(res, None, failure(p, "voice_gateway_not_found")?);
    }
    let source = b.get(c"sourceSessionId")?;
    if !source.truthy()? {
        let r = opt_call(p.get(c"voiceRouter")?, c"ensure", &[])?;
        if r.truthy()? && r.get(c"ok")?.is_false()? {
            let code = or(r.get(c"code")?, text(p, "voice_router_not_provisioned")?)?;
            return send(
                res,
                None,
                fields(p, &[("ok", flag(p, false)?), ("code", code)])?,
            );
        }
    }
    let issued = call(
        p.get(c"launchRegistry")?,
        c"issue",
        &[fields(p, &[("sourceSessionId", source)])?],
    )?;
    if !ok(issued)? {
        return send(res, None, rejected(issued)?);
    }
    let rt = p.get(c"runtime")?;
    let status = or(opt_call(rt, c"statusGlobal", &[])?, null(p)?)?;
    let s = fields(p, &[("res", res), ("issued", issued)])?;
    if status.truthy()? && !status.get(c"state")?.is_string("running")? {
        if let Some(start) = p.catch(|| opt_call(rt, c"startGlobal", &[]))? {
            let answer = recover(start, status, constant)?;
            let finished = then(answer, s, |s, a| finished_launch(s, a[0]))?;
            return recover(finished, res, |res, a| thrown(res, a[0]));
        }
    }
    finished_launch(s, status)
}
fn install<'a>(p: L<'a>, res: L<'a>) -> Result<L<'a>> {
    let inst = p.get(c"installer")?;
    let before = call(inst, c"status", &[])?;
    let runtime = call(inst, c"startInstall", &[])?;
    let waiting = call(inst, c"waitForInstall", &[])?;
    let finished = call(
        waiting,
        c"then",
        &[function(p, "", 0, 0, |s, _| {
            call(s.get(c"supervisor")?, c"reconcileAll", &[])
        })?],
    )?;
    call(
        finished,
        c"catch",
        &[function(p, "", 1, 1, |s, a| {
            s.catch(|| {
                opt_call(
                    s.get(c"log")?,
                    c"error",
                    &[
                        text(s, "[multicc/qwen-audio] asynchronous install failed")?,
                        fields(s, &[("error", a[0].optional(c"message")?)])?,
                    ],
                )
            })?;
            undef(s)
        })?],
    )?;
    send(
        res,
        None,
        fields(
            p,
            &[
                ("installed", before.get(c"installed")?),
                ("runtime", runtime),
            ],
        )?,
    )
}
fn restart<'a>(res: L<'a>, task: L<'a>, project: Option<bool>) -> Result<L<'a>> {
    let state = fields(res, &[("res", res)])?;
    if let Some(global) = project {
        state.set(c"projectsGlobal", flag(res, global)?)?;
    }
    let done = then(task, state, |s, a| {
        let projects = s.get(c"projectsGlobal")?;
        let body = if projects.undefined()? {
            fields(s, &[("status", or(a[0], fields(s, &[])?)?)])?
        } else {
            fields(s, &[("projectsGlobal", projects), ("status", a[0])])?
        };
        send(s.get(c"res")?, None, body)
    })?;
    recover(done, res, |r, a| thrown(r, a[0]))
}
pub(super) fn handler<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let req = a[0];
    let res = a[1];
    if !authorized(p, req)? {
        return error(res, 404, "not found", false);
    }
    let b = as_object(req.get(c"body")?)?;
    let op = b
        .get(c"op")?
        .string()?
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    let service = p.get(c"service")?;
    let rt = p.get(c"runtime")?;
    match op.as_str() {
        "globalGet" => {
            let r = call(service, c"inspectGlobal", &[])?;
            send(
                res,
                None,
                fields(
                    p,
                    &[
                        ("gateway", r.get(c"gateway")?),
                        ("legacy", r.get(c"legacy")?),
                        ("baseUrl", base(p)?),
                    ],
                )?,
            )
        }
        "globalPut" => guarded(res, || global_put(p, b, res)),
        "globalRemove" => guarded(res, || {
            let r = call(service, c"removeGlobal", &[])?;
            if !ok(r)? {
                return send(res, None, rejected(r)?);
            }
            ignore_rejection(opt_call(rt, c"stopGlobal", &[])?)?;
            send(res, None, success(p)?)
        }),
        "globalRuntime" => {
            let raw = opt_call(rt, c"statusGlobal", &[])?;
            let status = if raw.truthy()? {
                raw
            } else {
                fields(
                    p,
                    &[
                        ("scope", text(p, "global")?),
                        ("state", text(p, "stopped")?),
                        ("desired", flag(p, false)?),
                        ("url", null(p)?),
                    ],
                )?
            };
            send(res, None, fields(p, &[("status", status)])?)
        }
        "globalRestart" => guarded(res, || {
            restart(res, opt_call(rt, c"restartGlobal", &[])?, None)
        }),
        "launchBegin" => guarded(res, || launch_begin(p, b, res)),
        "launchEnd" => {
            if b.get(c"revoke")?.is_true()? {
                call(p.get(c"launchRegistry")?, c"revoke", &[b.get(c"id")?])?;
            } else {
                p.catch(|| {
                    let detail = fields(
                        p,
                        &[
                            ("scope", b.get(c"scope")?),
                            ("source", or(b.get(c"source")?, null(p)?)?),
                            ("target", b.get(c"target")?),
                        ],
                    )?;
                    opt_call(
                        p.get(c"log")?,
                        c"info",
                        &[text(p, "[multicc/voice] launch issued")?, detail],
                    )
                })?;
            }
            send(res, None, success(p)?)
        }
        "launchResolve" => {
            let r = call(
                p.get(c"launchRegistry")?,
                c"resolve",
                &[b.get(c"launchId")?],
            )?;
            let out = if ok(r)? {
                fields(
                    p,
                    &[("ok", flag(p, true)?), ("context", r.get(c"context")?)],
                )?
            } else {
                rejected(r)?
            };
            send(res, None, out)
        }
        "runtimeGet" => send(
            res,
            None,
            fields(
                p,
                &[("runtime", call(p.get(c"installer")?, c"status", &[])?)],
            )?,
        ),
        "runtimeInstall" => guarded(res, || install(p, res)),
        "fleetRuntime" => {
            let s = p.get(c"supervisor")?;
            let global = opt_call(s, c"hasGlobalGateway", &[])?.is_true()?;
            let status = if global {
                call(s, c"statusGlobal", &[])?
            } else {
                call(s, c"status", &[b.get(c"id")?])?
            };
            send(
                res,
                None,
                fields(
                    p,
                    &[("projectsGlobal", flag(p, global)?), ("status", status)],
                )?,
            )
        }
        "fleetRestart" => guarded(res, || {
            let s = p.get(c"supervisor")?;
            let global = opt_call(s, c"hasGlobalGateway", &[])?.is_true()?;
            let task = if global {
                call(s, c"restartGlobal", &[])?
            } else {
                call(s, c"restart", &[b.get(c"id")?])?
            };
            restart(res, task, Some(global))
        }),
        _ => error(res, 400, "unknown host operation", false),
    }
}
pub(super) fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let s = pick(
        opts,
        &[
            c"service",
            c"launchRegistry",
            c"voiceRouter",
            c"runtime",
            c"getBaseUrl",
            c"installer",
            c"supervisor",
            c"log",
        ],
    )?;
    for (dep, method, msg) in [
        (
            c"service",
            c"inspectGlobal",
            "global voice gateway routes require the voice gateway service",
        ),
        (
            c"launchRegistry",
            c"issue",
            "global voice gateway routes require a launch registry",
        ),
        (
            c"installer",
            c"status",
            "qwen audio runtime routes require installer",
        ),
        (
            c"installer",
            c"startInstall",
            "qwen audio runtime routes require installer",
        ),
        (
            c"supervisor",
            c"status",
            "qwen audio runtime routes require supervisor",
        ),
    ] {
        if !callable(s.get(dep)?.optional(method)?)? {
            return Err(s.type_error(msg));
        }
    }
    if s.get(c"log")?.undefined()? {
        s.set(c"log", s.global()?.get(c"console")?)?;
    }
    s.set(c"isLocalRequest", ports.get(c"isLocalRequest")?)?;
    methods(
        s,
        &[("mountRoutes", 1, |s, a| routes::mount(s, a[0], true))],
    )?
    .freeze()
}
