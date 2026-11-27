use super::*;
use std::cell::Cell;

fn fs<'a>(s: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(s.get(c"fs")?, key, args)
}
fn path<'a>(s: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(s.get(c"path")?, key, args)
}
fn exists<'a>(s: L<'a>, v: L<'a>) -> Result<bool> {
    fs(s, c"existsSync", &[v])?.truthy()
}
fn real_root(s: L<'_>) -> Result<L<'_>> {
    let root = s.get(c"root")?;
    Ok(s.catch(|| {
        if exists(s, root)? {
            fs(s, c"realpathSync", &[root])
        } else {
            null(s)
        }
    })?
    .unwrap_or(null(s)?))
}
fn inside<'a>(s: L<'a>, base: L<'a>, v: L<'a>) -> Result<bool> {
    if v.equals(base)? {
        return Ok(true);
    }
    let mut prefix = base.coerce_string()?;
    prefix.push(&s.get(c"path")?.get(c"sep")?.coerce_string()?);
    Ok(v.coerce_string()?.as_units().starts_with(prefix.as_units()))
}
fn ancestor<'a>(s: L<'a>, mut current: L<'a>) -> Result<L<'a>> {
    let root = s.get(c"root")?;
    while !exists(s, current)? {
        let parent = path(s, c"dirname", &[current])?;
        if parent.equals(current)? || !inside(s, root, parent)? {
            return null(s);
        }
        current = parent;
    }
    Ok(s.catch(|| fs(s, c"realpathSync", &[current]))?
        .unwrap_or(null(s)?))
}
pub(super) fn facts<'a>(s: L<'a>, rel: L<'a>) -> Result<L<'a>> {
    let root = s.get(c"root")?;
    let value = if rel.nullish()? {
        text(s, "")?
    } else {
        string(rel)?
    };
    let resolved = path(s, c"resolve", &[root, value])?;
    let real = real_root(s)?;
    let near = if real.truthy()? {
        ancestor(s, resolved)?
    } else {
        null(s)?
    };
    fields(
        s,
        &[
            ("root", root),
            ("resolved", resolved),
            ("rootReal", real),
            ("ancestorReal", near),
            ("exists", fs(s, c"existsSync", &[resolved])?),
            (
                "parentExists",
                fs(s, c"existsSync", &[path(s, c"dirname", &[resolved])?])?,
            ),
            ("name", path(s, c"basename", &[resolved])?),
        ],
    )
}
pub(super) fn resolve<'a>(s: L<'a>, rel: L<'a>) -> Result<L<'a>> {
    let Some(relative) = rel.string()? else {
        return null(s);
    };
    if !policy::memory_rel_valid(&relative.to_string_lossy()) {
        return null(s);
    }
    let root = s.get(c"root")?;
    let target = path(s, c"resolve", &[root, rel])?;
    if !inside(s, root, target)? || target.equals(root)? {
        return null(s);
    }
    let real = real_root(s)?;
    if !real.truthy()? {
        return null(s);
    }
    let near = ancestor(s, target)?;
    if !near.truthy()? || !inside(s, real, near)? {
        return null(s);
    }
    Ok(target)
}
fn mtime<'a>(s: L<'a>, abs: L<'a>) -> Result<L<'a>> {
    Ok(s.catch(|| {
        call(
            fs(s, c"statSync", &[abs])?.get(c"mtime")?,
            c"toISOString",
            &[],
        )
    })?
    .unwrap_or(null(s)?))
}
fn thrown<'a>(s: L<'a>, error: napi::Error) -> Result<L<'a>> {
    if let Some(e) = s.exception_value()? {
        Ok(e)
    } else {
        s.global()?
            .get(c"Error")?
            .construct(&[text(s, &error.reason)?])
    }
}
pub(super) fn read<'a>(s: L<'a>, rel: L<'a>) -> Result<L<'a>> {
    let abs = resolve(s, rel)?;
    if !abs.truthy()? {
        return fields(s, &[("valid", flag(s, false)?)]);
    }
    let found = fs(s, c"existsSync", &[abs])?.truthy()?;
    let out = fields(
        s,
        &[
            ("valid", flag(s, true)?),
            ("exists", flag(s, found)?),
            ("abs", abs),
        ],
    )?;
    if !found {
        return Ok(out);
    }
    match fs(s, c"readFileSync", &[abs, text(s, "utf8")?]) {
        Ok(value) => {
            let time = mtime(s, abs)?;
            out.set(c"name", path(s, c"basename", &[abs])?)?;
            out.set(c"content", value)?;
            out.set(c"mtime", time)?;
        }
        Err(error) => {
            let error = thrown(s, error)?;
            out.set(c"name", path(s, c"basename", &[abs])?)?;
            out.set(c"error", public_failure(text(s, "read")?, error)?)?;
        }
    }
    Ok(out)
}
fn broadcast<'a>(s: L<'a>, rel: L<'a>) -> Result<()> {
    let value = string(rel)?.coerce_string()?.to_string_lossy();
    let top = value.split('/').next().unwrap_or_default();
    if top.is_empty() {
        return Ok(());
    }
    let scope = if value.starts_with("_machine/") {
        "machine"
    } else if value.starts_with("_cli/") {
        "cli"
    } else if value.contains("/_shared/") {
        "shared"
    } else if value.contains("/tasks/") {
        "task"
    } else if value.contains("/skills/") {
        "skill"
    } else {
        "own"
    };
    let deps = s.get(c"deps")?;
    s.catch(|| {
        let notify = |id| -> Result<()> {
            let event = fields(
                s,
                &[
                    ("type", text(s, "memory")?),
                    ("rel", rel),
                    ("scope", text(s, scope)?),
                ],
            )?;
            call(deps, c"workspaceBroadcast", &[id, event])?;
            Ok(())
        };
        if matches!(scope, "machine" | "cli") {
            let dirs = deps.get(c"directories")?;
            if callable(dirs, c"keys")? {
                call(dirs, c"keys", &[])?.for_each(notify)?;
            }
        } else {
            let units = rel.coerce_string()?;
            let end = units
                .as_units()
                .iter()
                .position(|u| *u == 47)
                .unwrap_or(units.len());
            notify(s.from_value(&V::String(units.truncate_units(end)))?)?;
        }
        Ok(())
    })?;
    Ok(())
}
thread_local! {static COUNTER:Cell<u64>=const{Cell::new(0)};}
fn atomic_write<'a>(s: L<'a>, target: L<'a>, content: L<'a>) -> Result<()> {
    let deps = s.get(c"deps")?;
    if callable(deps, c"atomicWriteText")? {
        let opts = fields(
            s,
            &[
                ("mode", num(s, 0o600 as f64)?),
                ("dirMode", num(s, 0o700 as f64)?),
            ],
        )?;
        call(deps, c"atomicWriteText", &[target, content, opts])?;
        return Ok(());
    }
    let filesystem = s.get(c"fs")?;
    for key in [
        c"openSync",
        c"writeFileSync",
        c"fsyncSync",
        c"closeSync",
        c"renameSync",
    ] {
        if !callable(filesystem, key)? {
            return Err(s.type_error(&format!(
                "atomic memory write requires fs.{}",
                key.to_string_lossy()
            )));
        }
    }
    let mut temp_name = target.coerce_string()?;
    temp_name.push_str(".tmp.");
    temp_name.push(&s.global()?.get(c"process")?.get(c"pid")?.coerce_string()?);
    temp_name.push_str(".");
    temp_name.push(&call(deps, c"now", &[])?.coerce_string()?);
    temp_name.push_str(".");
    let n = COUNTER.with(|c| {
        let i = c.get();
        c.set(i.wrapping_add(1));
        i
    });
    temp_name.push_str(&n.to_string());
    let temp = s.from_value(&V::String(temp_name))?;
    let mut open = None;
    let commit = (|| {
        let fd = fs(
            s,
            c"openSync",
            &[temp, text(s, "wx")?, num(s, 0o600 as f64)?],
        )?;
        open = Some(fd);
        fs(
            s,
            c"writeFileSync",
            &[fd, content, fields(s, &[("encoding", text(s, "utf8")?)])?],
        )?;
        fs(s, c"fsyncSync", &[fd])?;
        fs(s, c"closeSync", &[fd])?;
        open = None;
        fs(s, c"renameSync", &[temp, target])?;
        if callable(filesystem, c"chmodSync")? {
            fs(s, c"chmodSync", &[target, num(s, 0o600 as f64)?])?;
        }
        sync_dir(s, target)
    })();
    if let Err(error) = commit {
        let e = thrown(s, error)?;
        s.catch(|| fs(s, c"unlinkSync", &[temp]))?;
        if let Some(fd) = open {
            s.catch(|| fs(s, c"closeSync", &[fd]))?;
        }
        return Err(e.throw_error());
    }
    Ok(())
}
fn sync_dir<'a>(s: L<'a>, target: L<'a>) -> Result<()> {
    let mut fd = None;
    let result = (|| {
        let dir_fd = fs(
            s,
            c"openSync",
            &[path(s, c"dirname", &[target])?, text(s, "r")?],
        )?;
        fd = Some(dir_fd);
        fs(s, c"fsyncSync", &[dir_fd])?;
        Ok(())
    })();
    let error = match result {
        Err(e) => Some(thrown(s, e)?),
        Ok(()) => None,
    };
    if let Some(fd) = fd {
        s.catch(|| fs(s, c"closeSync", &[fd]))?;
    }
    if let Some(error) = error {
        let code = error
            .optional(c"code")?
            .string()?
            .unwrap_or_default()
            .to_string_lossy();
        if !matches!(
            code.as_str(),
            "EINVAL" | "ENOTSUP" | "EISDIR" | "EBADF" | "EPERM"
        ) {
            return Err(error.throw_error());
        }
    }
    Ok(())
}
pub(super) fn write<'a>(s: L<'a>, rel: L<'a>, content: L<'a>) -> Result<L<'a>> {
    let abs = resolve(s, rel)?;
    if !abs.truthy()? {
        return fields(s, &[("valid", flag(s, false)?)]);
    }
    let missing = !exists(s, path(s, c"dirname", &[abs])?)?;
    let out = fields(
        s,
        &[
            ("valid", flag(s, true)?),
            ("parentMissing", flag(s, missing)?),
            ("abs", abs),
        ],
    )?;
    if missing {
        return Ok(out);
    }
    match atomic_write(s, abs, content) {
        Ok(()) => {
            let time = mtime(s, abs)?;
            broadcast(s, rel)?;
            out.set(c"mtime", time)?
        }
        Err(e) => {
            let err = thrown(s, e)?;
            out.set(c"error", public_failure(text(s, "write")?, err)?)?
        }
    }
    Ok(out)
}
pub(super) fn delete<'a>(s: L<'a>, rel: L<'a>) -> Result<L<'a>> {
    let abs = resolve(s, rel)?;
    if !abs.truthy()? {
        return fields(s, &[("valid", flag(s, false)?)]);
    }
    let out = fields(s, &[("valid", flag(s, true)?)])?;
    if let Err(e) = fs(s, c"unlinkSync", &[abs]) {
        let err = thrown(s, e)?;
        if !err.get(c"code")?.is_string("ENOENT")? {
            out.set(c"error", public_failure(text(s, "delete")?, err)?)?;
            return Ok(out);
        }
    }
    broadcast(s, rel)?;
    Ok(out)
}
