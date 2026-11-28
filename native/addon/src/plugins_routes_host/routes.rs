use super::*;
use std::ffi::CStr;
fn respond<'a>(res: L<'a>, v: L<'a>) -> Result<L<'a>> {
    call(
        call(res, c"status", &[v.get(c"status")?])?,
        c"json",
        &[v.get(c"payload")?],
    )
}
fn plain_error<'a>(res: L<'a>, e: L<'a>) -> Result<L<'a>> {
    send(
        res,
        Some(500),
        fields(res, &[("error", e.get(c"message")?)])?,
    )
}
fn data<'a>(o: L<'a>, req: L<'a>, res: L<'a>, route: &str) -> Result<L<'a>> {
    let wait = async_result(o, || match route {
        "catalog" => {
            call(
                res,
                c"set",
                &[text(o, "Cache-Control")?, text(o, "no-store")?],
            )?;
            catalog::payload(o, req, false)
        }
        "refresh" => {
            let catalog = o.get(c"catalog")?;
            if !catalog.truthy()? {
                return Err(o.type_error("插件列表未配置"));
            }
            then(
                call(catalog, c"refresh", &[])?,
                fields(o, &[("owner", o), ("req", req)])?,
                |c, _| catalog::payload(c.get(c"owner")?, c.get(c"req")?, false),
            )
        }
        _ => {
            call(
                res,
                c"set",
                &[text(o, "Cache-Control")?, text(o, "no-store")?],
            )?;
            let host = o.get(c"channelHost")?;
            let rows = if host.truthy()? {
                call(host, c"targets", &[])?
            } else {
                array(o)?
            };
            then(rows, o, |o, a| fields(o, &[("channels", a[0])]))
        }
    })?;
    let written = then(wait, res, |res, a| send(res, None, a[0]))?;
    recover(written, res, |res, a| plain_error(res, a[0]))
}
fn guard<'a>(o: L<'a>, req: L<'a>, res: L<'a>) -> Result<Option<L<'a>>> {
    let reject = |status, code: &str, msg: &str| -> Result<Option<L<'a>>> {
        Ok(Some(send(
            res,
            Some(status),
            fields(o, &[("code", text(o, code)?), ("error", text(o, msg)?)])?,
        )?))
    };
    if !o.get(c"installer")?.truthy()? {
        return reject(404, "unavailable", "这个实例没有用户插件目录");
    }
    if !o.get(c"isLocal")?.call_plain(&[req])?.truthy()? {
        return reject(403, "localOnly", "请在这台电脑上安装、卸载插件");
    }
    let headers = req.get(c"headers")?;
    let origin = headers.optional(c"origin")?;
    if origin.truthy()? {
        let same = o
            .catch(|| {
                o.global()?
                    .get(c"URL")?
                    .construct(&[origin])?
                    .get(c"host")?
                    .equals(headers.get(c"host")?)
            })?
            .unwrap_or(false);
        if !same {
            return reject(
                403,
                "crossOrigin",
                "只接受 MultiCC 自己页面发来的安装、卸载请求",
            );
        }
    }
    Ok(None)
}
fn manage<'a>(o: L<'a>, req: L<'a>, res: L<'a>, op: &CStr) -> Result<L<'a>> {
    async_result(o, || {
        if let Some(v) = guard(o, req, res)? {
            return Ok(v);
        }
        let c = fields(o, &[("owner", o), ("req", req), ("res", res)])?;
        let wait = async_result(o, || catalog::change(c, op))?;
        let sent = then(wait, res, |res, a| respond(res, a[0]))?;
        recover(sent, c, |c, a| {
            let err = a[0];
            let code = err.get(c"code")?;
            let msg = err.get(c"message")?;
            let status = match fold_string(code)?.as_str() {
                "invalidId" => 400,
                "busy" | "noPrevious" => 409,
                "notInstalled" => 404,
                "download" | "size" | "checksum" => 502,
                "package" | "mismatch" => 422,
                _ => {
                    call(
                        c.get(c"owner")?.get(c"logger")?,
                        c"warn",
                        &[
                            text(c, "plugin_manage_failed")?,
                            fields(
                                c,
                                &[
                                    ("id", c.get(c"req")?.get(c"params")?.get(c"id")?),
                                    ("error", msg),
                                ],
                            )?,
                        ],
                    )?;
                    500
                }
            };
            send(
                c.get(c"res")?,
                Some(status),
                fields(
                    c,
                    &[
                        ("code", fallback_to(code, text(c, "failed")?)?),
                        ("error", msg),
                    ],
                )?,
            )
        })
    })
}
pub(super) fn mount<'a>(o: L<'a>, app: L<'a>) -> Result<L<'a>> {
    let routes: &[(&CStr, &str, Action)] = &[
        (c"get", "/api/plugins", |o, a| {
            let scan = discover::scan(o)?;
            let output = fields(
                o,
                &[
                    (
                        "pluginApi",
                        o.get(c"ports")?
                            .get(c"catalog")?
                            .get(c"PLUGIN_API_VERSION")?,
                    ),
                    ("plugins", scan.get(c"plugins")?),
                    ("conflicts", scan.get(c"conflicts")?),
                ],
            )?;
            send(a[1], None, output)?;
            undef(o)
        }),
        (c"get", "/api/plugins/catalog", |o, a| {
            data(o, a[0], a[1], "catalog")
        }),
        (c"post", "/api/plugins/catalog/refresh", |o, a| {
            if !o.get(c"catalog")?.truthy()? {
                return async_result(o, || error(a[1], 404, "插件列表未配置", false));
            }
            data(o, a[0], a[1], "refresh")
        }),
        (c"post", "/api/plugins/:id/install", |o, a| {
            manage(o, a[0], a[1], c"install")
        }),
        (c"post", "/api/plugins/:id/uninstall", |o, a| {
            manage(o, a[0], a[1], c"uninstall")
        }),
        (c"post", "/api/plugins/:id/rollback", |o, a| {
            manage(o, a[0], a[1], c"rollback")
        }),
        (c"post", "/api/plugins/:id/run", |o, a| {
            let body = a[0].get(c"body")?;
            let cmd = body.optional(c"command")?;
            if cmd.kind()? != sys::ValueType::napi_string || !cmd.truthy()? {
                return async_result(o, || error(a[1], 400, "缺少 command", false));
            }
            then(
                run::command(
                    o,
                    a[0].get(c"params")?.get(c"id")?,
                    cmd,
                    body.get(c"input")?,
                )?,
                a[1],
                |res, a| respond(res, a[0]),
            )
        }),
        (c"get", "/api/channels/targets", |o, a| {
            data(o, a[0], a[1], "targets")
        }),
    ];
    for &(method, path, action) in routes {
        call(
            app,
            method,
            &[text(o, path)?, function(o, "", 2, 2, action)?],
        )?;
    }
    let ports = o.get(c"ports")?;
    let opts = fields(
        o,
        &[
            (
                "findManifest",
                function(o, "findManifest", 1, 1, |o, a| discover::find(o, a[0]))?,
            ),
            ("channelRegistry", ports.get(c"registry")?),
            ("channelHost", o.get(c"channelHost")?),
            ("isLocalRequest", o.get(c"isLocal")?),
        ],
    )?;
    ports.get(c"mountHost")?.call_plain(&[app, opts])?;
    undef(o)
}
