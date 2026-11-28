use super::run::outcome;
use super::*;
fn catalog_api(o: L<'_>) -> Result<L<'_>> {
    o.get(c"ports")?.get(c"catalog")
}
pub(super) fn payload<'a>(o: L<'a>, req: L<'a>, internal: bool) -> Result<L<'a>> {
    let ctx = fields(
        o,
        &[("owner", o), ("req", req), ("internal", flag(o, internal)?)],
    )?;
    then(discover::scan_async(o)?, ctx, |ctx, a| {
        let o = ctx.get(c"owner")?;
        let req = ctx.get(c"req")?;
        let internal = ctx.get(c"internal")?.truthy()?;
        let scan = a[0];
        let plugins = scan.get(c"plugins")?;
        let catalog = o.get(c"catalog")?;
        let snapshot = if catalog.truthy()? {
            call(catalog, c"snapshot", &[])?
        } else {
            fields(
                o,
                &[
                    ("catalog", null(o)?),
                    ("source", null(o)?),
                    ("fetchedAt", null(o)?),
                    ("updatedAt", null(o)?),
                    ("error", null(o)?),
                ],
            )?
        };
        let api = catalog_api(o)?;
        let refs = call(
            api,
            c"appsReferenced",
            &[snapshot.get(c"catalog")?, plugins],
        )?;
        let host = o.get(c"facts")?.call_plain(&[refs])?;
        let c = fields(
            o,
            &[
                ("owner", o),
                ("req", req),
                ("internal", flag(o, internal)?),
                ("snapshot", snapshot),
                ("scan", scan),
            ],
        )?;
        then(host, c, |c, a| {
            let host = a[0];
            let o = c.get(c"owner")?;
            let scan = c.get(c"scan")?;
            let snap = c.get(c"snapshot")?;
            let catalog = snap.get(c"catalog")?;
            let api = catalog_api(o)?;
            let rows = call(
                api,
                c"computeStates",
                &[fields(
                    o,
                    &[
                        ("catalog", catalog),
                        ("installed", scan.get(c"plugins")?),
                        ("host", host),
                    ],
                )?],
            )?;
            let installer = o.get(c"installer")?;
            for row in items(rows)? {
                let local = row.get(c"local")?;
                let managed = installer.truthy()?
                    && local.truthy()?
                    && local.get(c"source")?.is_string("user")?;
                row.set(c"removable", flag(o, managed)?)?;
                row.set(
                    c"rollbackVersion",
                    if managed {
                        call(installer, c"previousVersion", &[row.get(c"id")?])?
                    } else {
                        null(o)?
                    },
                )?;
            }
            let req = c.get(c"req")?;
            let allowed = installer.truthy()?
                && req.truthy()?
                && o.get(c"isLocal")?.call_plain(&[req])?.truthy()?;
            let out = fields(
                o,
                &[
                    ("pluginApi", api.get(c"PLUGIN_API_VERSION")?),
                    (
                        "host",
                        pick(
                            host,
                            &[c"os", c"arch", c"osVersion", c"multicc", c"agentBuild"],
                        )?,
                    ),
                    (
                        "catalog",
                        fields(
                            o,
                            &[
                                ("available", flag(o, catalog.truthy()?)?),
                                ("configured", flag(o, o.get(c"catalog")?.truthy()?)?),
                                ("updatedAt", snap.get(c"updatedAt")?),
                                ("fetchedAt", snap.get(c"fetchedAt")?),
                                ("source", snap.get(c"source")?),
                                ("error", snap.get(c"error")?),
                            ],
                        )?,
                    ),
                    ("conflicts", scan.get(c"conflicts")?),
                    (
                        "manage",
                        fields(
                            o,
                            &[
                                ("available", flag(o, installer.truthy()?)?),
                                ("allowed", flag(o, allowed)?),
                            ],
                        )?,
                    ),
                    ("plugins", rows),
                ],
            )?;
            if c.get(c"internal")?.truthy()? {
                out.set(c"_snapshot", snap)?;
                out.set(c"_host", host)?
            }
            Ok(out)
        })
    })
}
fn success<'a>(c: L<'a>, res: L<'a>) -> Result<L<'a>> {
    c.set(c"result", res)?;
    then(
        payload(c.get(c"owner")?, c.get(c"req")?, false)?,
        c,
        |c, a| {
            let v = fields(c, &[("ok", flag(c, true)?), ("result", c.get(c"result")?)])?;
            v.spread_from(a[0])?;
            outcome(c, 200, v)
        },
    )
}
fn find<'a>(list: L<'a>, k: &std::ffi::CStr, expected: L<'a>) -> Result<Option<L<'a>>> {
    for v in items(list)? {
        if v.get(k)?.equals(expected)? {
            return Ok(Some(v));
        }
    }
    Ok(None)
}
fn install<'a>(c: L<'a>, payload: L<'a>) -> Result<L<'a>> {
    let id = c.get(c"id")?;
    let name = fold_string(id)?;
    let row = find(payload.get(c"plugins")?, c"id", id)?;
    let reason = |status, code: &str, msg: String| {
        outcome(
            c,
            status,
            fields(c, &[("code", text(c, code)?), ("error", text(c, &msg)?)])?,
        )
    };
    let row = match row {
        Some(v)
            if v.get(c"listed")?.is_true()? && v.get(c"distribution")?.is_string("optional")? =>
        {
            v
        }
        _ => {
            return reason(
                404,
                "notListed",
                format!("插件 {name} 不在插件列表里，或者是内置插件"),
            )
        }
    };
    let state = row.get(c"state")?;
    if !state.is_string("installable")? && !state.is_string("update")? {
        return outcome(
            c,
            409,
            fields(
                c,
                &[
                    ("code", text(c, "notInstallable")?),
                    ("state", state),
                    (
                        "error",
                        text(
                            c,
                            &format!("插件 {name} 现在不能安装（{}）", fold_string(state)?),
                        )?,
                    ),
                ],
            )?,
        );
    }
    let local = row.get(c"local")?;
    if local.truthy()? && !local.get(c"source")?.is_string("user")? {
        return reason(
            409,
            "inProgramDir",
            format!("插件 {name} 放在程序目录的 plugins/ 里，先把它移走再从列表安装"),
        );
    }
    let plugins = payload
        .get(c"_snapshot")?
        .get(c"catalog")?
        .get(c"plugins")?;
    let entry = find(plugins, c"id", id)?.unwrap_or(undef(c)?);
    let release =
        find(entry.get(c"releases")?, c"version", row.get(c"candidate")?)?.unwrap_or(undef(c)?);
    let host = payload.get(c"_host")?;
    let target = text(
        c,
        &format!(
            "{}-{}",
            fold_string(host.get(c"os")?)?,
            fold_string(host.get(c"arch")?)?
        ),
    )?;
    let asset = release.get(c"assets")?.get_key(target)?;
    let req = fields(
        c,
        &[
            ("id", id),
            ("version", release.get(c"version")?),
            ("asset", asset),
        ],
    )?;
    then(
        call(c.get(c"owner")?.get(c"installer")?, c"install", &[req])?,
        c,
        |c, a| success(c, a[0]),
    )
}
pub(super) fn change<'a>(c: L<'a>, op: &std::ffi::CStr) -> Result<L<'a>> {
    let req = c.get(c"req")?;
    let id = req.get(c"params")?.get(c"id")?;
    c.set(c"id", id)?;
    let o = c.get(c"owner")?;
    if op == c"install" {
        return then(payload(o, req, true)?, c, |c, a| install(c, a[0]));
    }
    then(call(o.get(c"installer")?, op, &[id])?, c, |c, a| {
        success(c, a[0])
    })
}
