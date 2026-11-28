use super::*;
use multicc_core::macos_agent_build;
use napi::bindgen_prelude::{Buffer, FromNapiValue};
use std::path::Path;

fn access(s: L<'_>, file: L<'_>, executable: bool) -> Result<bool> {
    Ok(s.catch(|| {
        let fs = s.get(c"fs")?;
        if executable {
            call(fs, c"accessSync", &[file, s.get(c"xOk")?])
        } else {
            call(fs, c"accessSync", &[file])
        }
    })?
    .is_some())
}
fn real<'a>(s: L<'a>, file: L<'a>) -> Result<L<'a>> {
    Ok(s.catch(|| call(s.get(c"fs")?, c"realpathSync", &[file]))?
        .unwrap_or(null(s)?))
}
fn read<'a>(s: L<'a>, file: L<'a>) -> Result<L<'a>> {
    call(s.get(c"fs")?, c"readFileSync", &[file, text(s, "utf8")?])
}
fn trimmed<'a>(s: L<'a>, file: L<'a>) -> Result<L<'a>> {
    Ok(s.catch(|| call(read(s, file)?, c"trim", &[]))?
        .unwrap_or(text(s, "")?))
}
fn json<'a>(s: L<'a>, file: L<'a>) -> Result<L<'a>> {
    Ok(s.catch(|| json_call(s, c"parse", read(s, file)?))?
        .unwrap_or(null(s)?))
}
fn safe_build<'a>(s: L<'a>, rec: L<'a>) -> Result<L<'a>> {
    let build = rec.optional(c"build")?;
    if call(s.global()?.get(c"Number")?, c"isSafeInteger", &[build])?.truthy()? {
        Ok(build)
    } else {
        null(s)
    }
}
fn other_copies<'a>(s: L<'a>, root: L<'a>) -> Result<L<'a>> {
    let path = s.get(c"path")?;
    let result = array(s)?;
    s.get(c"desktops")?.for_each(|app| {
        let server = join(path, app, &["Contents", "Resources", "app-server"])?;
        if !access(s, server, false)? {
            return Ok(());
        }
        let app_root = or(real(s, app)?, || Ok(app))?;
        let prefix = call(app_root, c"concat", &[path.get(c"sep")?])?;
        if call(root, c"startsWith", &[prefix])?.truthy()? {
            return Ok(());
        }
        let pkg = json(s, join(path, server, &["package.json"])?)?;
        let legacy = !access(
            s,
            join(
                path,
                server,
                &["scripts", "macos-agent", "agent-build.json"],
            )?,
            false,
        )?;
        let pattern = s.global()?.get(c"RegExp")?.construct(&[
            text(s, r#"^\s*MULTICC_AGENT_AUTO_INSTALL\s*=\s*['"]?0['"]?\s*$"#)?,
            text(s, "m")?,
        ])?;
        let disabled = call(pattern, c"test", &[trimmed(s, s.get(c"desktopEnv")?)?])?;
        call(
            result,
            c"push",
            &[fields(
                s,
                &[
                    ("kind", text(s, "desktop")?),
                    ("app", app),
                    ("version", or(pkg.optional(c"version")?, || null(s))?),
                    ("legacyRules", flag(s, legacy)?),
                    ("autoInstallDisabled", disabled),
                ],
            )?],
        )?;
        Ok(())
    })?;
    Ok(result)
}
fn shipped_build(s: L<'_>) -> Result<f64> {
    let dir = s.get(c"sourceDir")?;
    if !s.get(c"injectedFs")?.truthy()? {
        return Ok(macos_agent_build::shipped_build(Path::new(&fold_string(
            dir,
        )?)));
    }
    let metadata = s
        .catch(|| {
            let path = s.get(c"ports")?.get(c"path")?;
            fold_string(read(s, join(path, dir, &["agent-build.json"])?)?)
        })?
        .unwrap_or_default();
    Ok(macos_agent_build::build_number(&metadata))
}
fn shipped_hash(s: L<'_>) -> Result<String> {
    let dir = s.get(c"sourceDir")?;
    if !s.get(c"injectedFs")?.truthy()? {
        return Ok(
            macos_agent_build::shipped_hash(Path::new(&fold_string(dir)?)).unwrap_or_default(),
        );
    }
    Ok(s.catch(|| {
        macos_agent_build::hash_sources(|name| {
            let file = join(s.get(c"ports")?.get(c"path")?, dir, &[name])?;
            let value = call(s.get(c"fs")?, c"readFileSync", &[file])?;
            let buffer = s.global()?.get(c"Buffer")?;
            let data = if value.kind()? == sys::ValueType::napi_string {
                call(buffer, c"from", &[value])?
            } else if call(buffer, c"isBuffer", &[value])?.truthy()? {
                value
            } else if call(s.global()?.get(c"ArrayBuffer")?, c"isView", &[value])?.truthy()? {
                call(
                    buffer,
                    c"from",
                    &[
                        value.get(c"buffer")?,
                        value.get(c"byteOffset")?,
                        value.get(c"byteLength")?,
                    ],
                )?
            } else {
                return Err(s.type_error("Expected source text or bytes"));
            };
            Ok(unsafe { Buffer::from_napi_value(s.env(), data.raw())? }.to_vec())
        })
    })?
    .unwrap_or_default())
}
pub(super) fn inspect(s: L<'_>) -> Result<L<'_>> {
    let build = shipped_build(s)?;
    let path = s.get(c"path")?;
    let original = s.get(c"root")?;
    let root = or(real(s, original)?, || Ok(original))?;
    let pkg = json(s, join(path, original, &["package.json"])?)?;
    let kind = if call(
        root,
        c"endsWith",
        &[text(s, ".app/Contents/Resources/app-server")?],
    )?
    .truthy()?
    {
        "desktop"
    } else if access(s, join(path, root, &[".git"])?, false)? {
        "source"
    } else {
        "package"
    };
    let me = fields(
        s,
        &[
            ("kind", text(s, kind)?),
            ("version", or(pkg.optional(c"version")?, || null(s))?),
            ("root", root),
        ],
    )?;
    let bin = s.get(c"bin")?;
    let active = or(real(s, s.get(c"link")?)?, || {
        if access(s, bin, false)? {
            Ok(bin)
        } else {
            null(s)
        }
    })?;
    let app = if active.truthy()?
        && call(
            active,
            c"endsWith",
            &[text(s, ".app/Contents/MacOS/MultiCCAgent")?],
        )?
        .truthy()?
    {
        call(path, c"resolve", &[active, text(s, "../../..")?])?
    } else if access(s, bin, false)? {
        s.get(c"app")?
    } else {
        null(s)?
    };
    let stamp = if app.truthy()? {
        trimmed(
            s,
            join(path, app, &["Contents", "Resources", "source.sha256"])?,
        )?
    } else {
        text(s, "")?
    };
    let rec = json(s, s.get(c"record")?)?;
    let recorded = rec.optional(c"app")?;
    let recorded = if recorded.kind()? == sys::ValueType::napi_string {
        or(real(s, recorded)?, || Ok(recorded))?
    } else {
        null(s)?
    };
    let matches = rec.truthy()?
        && app.truthy()?
        && rec.get(c"sourceSha256")?.equals(stamp)?
        && recorded.equals(app)?;
    let digest = text(s, &shipped_hash(s)?)?;
    let installed_build = if stamp.truthy()? && stamp.equals(digest)? {
        num(s, build)?
    } else if matches {
        let n = safe_build(s, rec)?;
        if n.nullish()? {
            num(s, 0.)?
        } else {
            n
        }
    } else {
        num(s, 0.)?
    };
    let owner = if matches {
        fields(
            s,
            &[
                ("kind", or(rec.get(c"installerKind")?, || null(s))?),
                ("version", or(rec.get(c"installerVersion")?, || null(s))?),
                ("root", or(rec.get(c"installerRoot")?, || null(s))?),
                ("at", or(rec.get(c"installedAt")?, || null(s))?),
            ],
        )?
    } else {
        null(s)?
    };
    let installed = if app.truthy()? {
        fields(
            s,
            &[
                ("app", app),
                ("build", installed_build),
                ("sourceSha256", or(stamp, || null(s))?),
                ("owner", owner),
                (
                    "mine",
                    flag(s, owner.truthy()? && owner.get(c"root")?.equals(root)?)?,
                ),
            ],
        )?
    } else {
        null(s)?
    };
    let replaced = if rec.truthy()? && app.truthy()? && !matches {
        fields(
            s,
            &[
                ("app", app),
                ("previousBuild", safe_build(s, rec)?),
                ("previousApp", or(rec.get(c"app")?, || null(s))?),
            ],
        )?
    } else {
        null(s)?
    };
    fields(
        s,
        &[
            ("self", me),
            (
                "shipped",
                fields(s, &[("build", num(s, build)?), ("sourceSha256", digest)])?,
            ),
            ("installed", installed),
            ("replaced", replaced),
            ("others", other_copies(s, root)?),
        ],
    )
}
pub(super) fn decision<'a>(s: L<'a>, action: &str, reason: &str) -> Result<L<'a>> {
    fields(
        s,
        &[("action", text(s, action)?), ("reason", text(s, reason)?)],
    )
}
pub(super) fn plan<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    if !s.get(c"platform")?.is_string("darwin")? {
        return decision(s, "skip", "not-macos");
    }
    if s.get(c"env")?
        .get(c"MULTICC_AGENT_AUTO_INSTALL")?
        .is_string("0")?
    {
        return decision(s, "skip", "disabled-by-env");
    }
    let paths = s.get(c"required")?;
    for i in 0..paths.get(c"length")?.number()? as u32 {
        if !access(s, paths.element(i)?, false)? {
            return decision(s, "skip", "installer-not-shipped");
        }
    }
    let path = s.get(c"path")?;
    if access(
        s,
        join(path, s.get(c"dir")?, &["auto-install-disabled"])?,
        false,
    )? {
        return decision(s, "skip", "uninstalled-by-user");
    }
    let bin = s.get(c"bin")?;
    let link = s.get(c"link")?;
    if !access(s, bin, false)? {
        return decision(s, "install", "not-installed");
    }
    if !access(s, bin, true)? {
        return decision(s, "install", "not-executable");
    }
    if !access(s, link, true)? {
        return decision(s, "install", "client-link-missing");
    }
    let seen = inspect(s)?;
    let installed = seen.get(c"installed")?;
    let shipped = seen.get(c"shipped")?;
    let current = installed.get(c"build")?;
    let next = shipped.get(c"build")?;
    if current.number()? > next.number()? {
        let d = decision(s, "skip", "installed-newer")?;
        d.set(c"installedBuild", current)?;
        d.set(c"shippedBuild", next)?;
        return Ok(d);
    }
    let digest = shipped.get(c"sourceSha256")?;
    if current.equals(next)?
        && !installed.get(c"sourceSha256")?.equals(digest)?
        && installed.get(c"owner")?.truthy()?
        && !installed.get(c"mine")?.truthy()?
        && !opts.get(c"replace")?.truthy()?
    {
        let d = decision(s, "skip", "other-owner")?;
        d.set(c"owner", installed.get(c"owner")?)?;
        d.set(c"installedBuild", current)?;
        return Ok(d);
    }
    let fs = s.get(c"fs")?;
    if !call(fs, c"realpathSync", &[link])?.equals(call(fs, c"realpathSync", &[bin])?)? {
        return decision(s, "update", "client-location-changed");
    }
    if !trimmed(s, s.get(c"stamp")?)?.equals(digest)? {
        return decision(s, "update", "source-changed");
    }
    let icon = join(
        path,
        s.get(c"app")?,
        &["Contents", "Resources", "AgentIcon.icns"],
    )?;
    if !access(s, icon, false)?
        || !call(
            call(fs, c"readFileSync", &[s.get(c"icon")?])?,
            c"equals",
            &[call(fs, c"readFileSync", &[icon])?],
        )?
        .truthy()?
    {
        return decision(s, "update", "icon-changed");
    }
    if !access(s, s.get(c"plist")?, false)? {
        return decision(s, "update", "launch-agent-missing");
    }
    decision(s, "skip", "up-to-date")
}
