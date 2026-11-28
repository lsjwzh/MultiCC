//! Package integrity checks and atomic plugin-directory replacement.
use crate::host_api::*;
use crate::plugin_catalog_host::{default_to, io, log, now_js, push, valid_id};
use napi_derive::napi;
use std::{
    fs,
    path::{Path, PathBuf},
};
mod download;
mod files;
const MAX_SIZE: f64 = 256. * 1024. * 1024.;
fn fail<'a>(c: L<'a>, code: &str, msg: &str) -> Result<L<'a>> {
    let class = c.get(c"owner")?.get(c"ports")?.get(c"PluginInstallError")?;
    Err(class
        .construct(&[text(c, code)?, text(c, msg)?])?
        .throw_error())
}
fn fserr(e: std::io::Error) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}
fn root(o: L<'_>) -> Result<PathBuf> {
    Ok(PathBuf::from(fold_string(o.get(c"root")?)?))
}
fn paths(c: L<'_>) -> Result<(PathBuf, PathBuf)> {
    let root = root(c.get(c"owner")?)?;
    let id = fold_string(c.get(c"id")?)?;
    Ok((root.join(&id), root.join(".previous").join(&id)))
}
fn version<'a>(p: L<'a>, path: &Path) -> Result<L<'a>> {
    match files::version(path) {
        Some(s) => text(p, &s),
        None => null(p),
    }
}
fn scratch(c: L<'_>, label: &str) -> Result<PathBuf> {
    let o = c.get(c"owner")?;
    let dir = root(o)?.join(".staging");
    fs::create_dir_all(&dir).map_err(fserr)?;
    let rand = call(
        o.get(c"ports")?.get(c"crypto")?,
        c"randomBytes",
        &[num(c, 4.)?],
    )?;
    let suffix = fold_string(call(rand, c"toString", &[text(c, "hex")?])?)?;
    Ok(dir.join(format!(
        "{}.{label}-{}-{suffix}",
        fold_string(c.get(c"id")?)?,
        std::process::id()
    )))
}
fn checked(c: L<'_>) -> Result<L<'_>> {
    let o = c.get(c"owner")?;
    let id = c.get(c"id")?;
    let want = c.get(c"version")?;
    let work = c.get(c"work")?;
    let found = o.get(c"inspect")?.call_plain(&[work, id])?;
    if !found.truthy()? {
        return fail(
            c,
            "package",
            "the package has no valid plugin.json for this id",
        );
    }
    let actual = found.get(c"manifest")?.get(c"version")?;
    if !actual.equals(want)? {
        return fail(
            c,
            "mismatch",
            &format!(
                "the package is version {}, the list says {}",
                fold_string(actual)?,
                fold_string(want)?
            ),
        );
    }
    let binary = found.get(c"binary")?;
    if !binary.truthy()? {
        return fail(
            c,
            "package",
            "the package has no engine binary for this platform",
        );
    }
    if !o.get(c"platform")?.is_string("win32")? {
        files::executable(Path::new(&fold_string(binary)?)).map_err(fserr)?;
    }
    let (current, previous) = paths(c)?;
    let replaced = version(c, &current)?;
    let incoming = PathBuf::from(fold_string(work)?).join(fold_string(id)?);
    let done = io::background(c, move || {
        files::swap(&current, &previous, &incoming).map_err(|e| e.to_string())
    })?;
    let result = fields(c, &[("id", id), ("version", want), ("replaced", replaced)])?;
    then(
        done,
        fields(c, &[("result", result), ("logger", o.get(c"logger")?)])?,
        |r, _| {
            let result = r.get(c"result")?;
            log(r.get(c"logger")?, c"info", "plugin_installed", result)?;
            Ok(result)
        },
    )
}
fn stage<'a>(c: L<'a>, buffer: L<'a>) -> Result<L<'a>> {
    let work = scratch(c, "install")?;
    c.set(c"work", text(c, &work.to_string_lossy())?)?;
    let dest = work.join(fold_string(c.get(c"id")?)?);
    let bytes = io::bytes(buffer)?;
    let unpacked = io::background(c, move || files::unpack(bytes, dest))?;
    let unpacked = recover(unpacked, c, |c, a| {
        fail(c, "package", &fold_string(a[0].get(c"message")?)?)
    })?;
    let swapped = then(unpacked, c, |c, _| checked(c))?;
    call(
        swapped,
        c"finally",
        &[function(c, "", 0, 0, |c, _| {
            let work = PathBuf::from(fold_string(c.get(c"work")?)?);
            io::background(c, move || files::remove(&work).map_err(|e| e.to_string()))
        })?],
    )
}
fn change(c: L<'_>, rollback: bool) -> Result<L<'_>> {
    let id = c.get(c"id")?;
    let name = fold_string(id)?;
    let (current, previous) = paths(c)?;
    let ver = version(c, &current)?;
    let logger = c.get(c"owner")?.get(c"logger")?;
    let (tag, detail, result, wait) = if rollback {
        if !files::exists(&previous) {
            return fail(
                c,
                "noPrevious",
                &format!("{name} has no earlier version to go back to"),
            );
        }
        let back = version(c, &previous)?;
        let parked = scratch(c, "rollback")?;
        let wait = io::background(c, move || {
            files::rollback(&current, &previous, &parked).map_err(|e| e.to_string())
        })?;
        (
            "plugin_rolled_back",
            fields(c, &[("id", id), ("from", ver), ("to", back)])?,
            fields(c, &[("id", id), ("version", back), ("replaced", ver)])?,
            wait,
        )
    } else {
        if !files::exists(&current) {
            return fail(c, "notInstalled", &format!("{name} is not installed here"));
        }
        let removing = scratch(c, "remove")?;
        let wait = io::background(c, move || {
            fs::rename(&current, &removing)
                .and_then(|_| files::remove(&removing))
                .and_then(|_| files::remove(&previous))
                .map_err(|e| e.to_string())
        })?;
        let result = fields(c, &[("id", id), ("version", ver)])?;
        ("plugin_uninstalled", result, result, wait)
    };
    then(
        wait,
        fields(
            c,
            &[
                ("tag", text(c, tag)?),
                ("detail", detail),
                ("result", result),
                ("logger", logger),
            ],
        )?,
        |c, _| {
            log(
                c.get(c"logger")?,
                c"info",
                &fold_string(c.get(c"tag")?)?,
                c.get(c"detail")?,
            )?;
            c.get(c"result")
        },
    )
}
fn exclusive<'a>(o: L<'a>, id: L<'a>, opts: L<'a>, op: &str) -> Result<L<'a>> {
    async_result(o, || {
        let c = fields(o, &[("owner", o), ("id", id)])?;
        let name = fold_string(id)?;
        if !id.truthy()? || !valid_id(&name, false) {
            return fail(c, "invalidId", &format!("invalid plugin id: {name}"));
        }
        let busy = o.get(c"busy")?;
        if call(busy, c"has", &[id])?.truthy()? {
            return fail(c, "busy", &format!("{name} is being changed already"));
        }
        call(busy, c"add", &[id])?;
        let work = async_result(c, || {
            let now = o.get(c"now")?.call_plain(&[])?.number()?;
            let dir = root(o)?.join(".staging");
            let sweep = io::background(c, move || {
                files::sweep(&dir, now);
                Ok(())
            })?;
            if op == "install" {
                c.set(c"asset", opts.get(c"asset")?)?;
                c.set(c"version", opts.get(c"version")?)?;
                fs::create_dir_all(root(o)?).map_err(fserr)?;
                let both = array(c)?;
                push(both, sweep)?;
                push(both, download::get(c)?)?;
                then(
                    call(c.global()?.get(c"Promise")?, c"all", &[both])?,
                    c,
                    |c, a| stage(c, a[0].element(1)?),
                )
            } else {
                c.set(c"rollback", flag(c, op == "rollback")?)?;
                then(sweep, c, |c, _| change(c, c.get(c"rollback")?.truthy()?))
            }
        })?;
        call(
            work,
            c"finally",
            &[function(c, "", 0, 0, |c, _| {
                call(c.get(c"owner")?.get(c"busy")?, c"delete", &[c.get(c"id")?])
            })?],
        )
    })
}
fn create<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(args[0])?;
    let root = opts.get(c"root")?;
    if !root.truthy()? {
        return Err(p.type_error("[plugin-installer] root is required"));
    }
    for (k, name) in [(c"fetch", "fetch"), (c"inspect", "inspect")] {
        if !callable(opts.get(k)?)? {
            return Err(p.type_error(&format!("[plugin-installer] {name} is required")));
        }
    }
    let o = fields(
        p,
        &[
            ("ports", p),
            ("root", root),
            ("busy", p.global()?.get(c"Set")?.construct(&[])?),
            ("fetch", opts.get(c"fetch")?),
            ("inspect", opts.get(c"inspect")?),
            (
                "platform",
                default_to(opts.get(c"platform")?, p.get(c"process")?.get(c"platform")?)?,
            ),
            (
                "logger",
                default_to(opts.get(c"logger")?, p.global()?.get(c"console")?)?,
            ),
            (
                "now",
                default_to(
                    opts.get(c"now")?,
                    function(p, "now", 0, 0, |p, _| now_js(p))?,
                )?,
            ),
            (
                "timeout",
                default_to(opts.get(c"timeoutMs")?, num(p, 600000.)?)?,
            ),
        ],
    )?;
    let out = methods(
        o,
        &[
            ("install", 1, |o, a| {
                exclusive(o, a[0].get(c"id")?, a[0], "install")
            }),
            ("rollback", 1, |o, a| exclusive(o, a[0], a[0], "rollback")),
            ("uninstall", 1, |o, a| exclusive(o, a[0], a[0], "uninstall")),
            ("previousVersion", 1, |o, a| {
                let id = fold_string(a[0])?;
                if a[0].truthy()? && valid_id(&id, false) {
                    version(
                        o,
                        &crate::plugin_installer_host::root(o)?
                            .join(".previous")
                            .join(id),
                    )
                } else {
                    null(o)
                }
            }),
            ("isBusy", 1, |o, a| call(o.get(c"busy")?, c"has", &[a[0]])),
        ],
    )?;
    out.set(c"root", root)?;
    Ok(out)
}
#[napi]
pub fn plugin_installer_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let out = defaulted_methods(p, &[("createPluginInstaller", 0, 1, create)])?;
    out.set(c"PluginInstallError", p.get(c"PluginInstallError")?)?;
    out.set(c"MAX_PACKAGE_BYTES", num(p, MAX_SIZE)?)?;
    Ok(out.raw())
}
