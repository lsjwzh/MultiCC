use super::*;
use multicc_core::state_file;
use std::{ffi::CStr, path::Path};

const FS_METHODS: &[&CStr] = &[
    c"mkdirSync",
    c"chmodSync",
    c"openSync",
    c"writeSync",
    c"fsyncSync",
    c"closeSync",
    c"renameSync",
    c"unlinkSync",
    c"existsSync",
];

pub(super) fn capture_fs(p: L<'_>) -> Result<()> {
    p.set(c"originalFs", pick(p.get(c"fs")?, FS_METHODS)?)
}

fn unmodified(p: L<'_>) -> Result<bool> {
    let fs = p.get(c"fs")?;
    let original = p.get(c"originalFs")?;
    for &method in FS_METHODS {
        if !fs.get(method)?.equals(original.get(method)?)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn snapshot_primary<'a>(fs: L<'a>, source: L<'a>, destination: L<'a>) -> Result<()> {
    // Keep the primary readable through a failed replacement. Stage the copy
    // beside bak1 so a reader also sees only complete backup generations.
    let tmp = message(
        fs,
        "",
        &[destination, text(fs, &state_file::temporary_suffix())?],
    )?;
    let result = (|| {
        call(fs, c"copyFileSync", &[source, tmp])?;
        call(fs, c"chmodSync", &[tmp, num(fs, 0o600 as f64)?])?;
        call(fs, c"renameSync", &[tmp, destination])?;
        Ok(())
    })();
    if let Err(err) = result {
        let cause = exception(fs, err)?;
        fs.catch(|| call(fs, c"unlinkSync", &[tmp]))?;
        return Err(cause.throw_error());
    }
    Ok(())
}

fn rotate<'a>(p: L<'a>, file: L<'a>, mut index: L<'a>) -> Result<()> {
    let fs = p.get(c"fs")?;
    while index.explicit_number()? >= 1. {
        let primary = index.number_value()? == Some(1.);
        let src = if primary {
            file
        } else {
            backup_name(file, num(p, index.number()? - 1.)?)?
        };
        let dst = backup_name(file, index)?;
        let result = (|| {
            if call(fs, c"existsSync", &[src])?.truthy()? {
                if primary {
                    snapshot_primary(fs, src, dst)?;
                } else {
                    call(fs, c"renameSync", &[src, dst])?;
                    call(fs, c"chmodSync", &[dst, num(p, 0o600 as f64)?])?;
                }
            }
            Ok(())
        })();
        if let Err(err) = result {
            let cause = exception(p, err)?;
            let msg = message(
                p,
                "[multicc/state-store] backup rotate ",
                &[
                    src,
                    text(p, " → ")?,
                    dst,
                    text(p, " failed: ")?,
                    cause.get(c"message")?,
                ],
            )?;
            call(p.global()?.get(c"console")?, c"warn", &[msg])?;
        }
        index = num(p, index.number()? - 1.)?;
    }
    Ok(())
}

pub(super) fn json<'a>(p: L<'a>, file: L<'a>, data: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let count = with_default(opts.get(c"rotate")?, num(p, BACKUPS)?)?;
    let kind = with_default(opts.get(c"kind")?, text(p, "unknown")?)?;
    let version = with_default(opts.get(c"schemaVersion")?, num(p, 1.)?)?;
    let timestamp = call(
        p.global()?.get(c"Date")?.construct(&[])?,
        c"toISOString",
        &[],
    )?;
    let schema = fields(
        p,
        &[
            ("kind", kind),
            ("version", version),
            ("writtenAt", timestamp),
        ],
    )?;
    let envelope = fields(p, &[(SCHEMA, schema), ("data", data)])?;
    let body = call(
        p.global()?.get(c"JSON")?,
        c"stringify",
        &[envelope, null(p)?, num(p, 2.)?],
    )?;
    let mode = num(p, state_file::FILE_MODE as f64)?;
    let dir_mode = num(p, state_file::DIR_MODE as f64)?;
    write(p, file, body, mode, dir_mode, false, || {
        rotate(p, file, count)
    })?;
    undef(p)
}

pub(super) fn text_atomic<'a>(p: L<'a>, file: L<'a>, body: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let mode = with_default(opts.get(c"mode")?, num(p, state_file::FILE_MODE as f64)?)?;
    let dir_mode = with_default(opts.get(c"dirMode")?, num(p, state_file::DIR_MODE as f64)?)?;
    let enforce = opts.get(c"enforceDirMode")?.truthy()?;
    let hook = opts.get(c"beforeRename")?;
    write(p, file, body, mode, dir_mode, enforce, || {
        if callable(hook)? {
            hook.call_plain(&[])?;
        }
        Ok(())
    })?;
    undef(p)
}

fn notify<'a>(p: L<'a>, file: L<'a>, error: L<'a>, op: &str) -> Result<()> {
    report(
        p,
        error,
        fields(p, &[("operation", text(p, op)?), ("target", file)])?,
    )
}

fn bits(mode: L<'_>) -> Result<Option<u32>> {
    Ok(mode
        .number_value()?
        .filter(|n| n.fract() == 0. && (0. ..=0o7777 as f64).contains(n))
        .map(|n| n as u32))
}

fn write<'a>(
    p: L<'a>,
    file: L<'a>,
    body: L<'a>,
    mode: L<'a>,
    dir_mode: L<'a>,
    enforce: bool,
    hook: impl FnOnce() -> Result<()>,
) -> Result<()> {
    if !enforce {
        if let (Some(file_name), Some(body), Some(mode), Some(dir_mode)) =
            (file.string()?, body.string()?, bits(mode)?, bits(dir_mode)?)
        {
            let name = file_name.to_string_lossy();
            if !name.is_empty() && !name.contains('\0') && unmodified(p)? {
                let bytes = body.to_string_lossy();
                let mut hook_error = None;
                let res = state_file::write_bytes_atomic_traced_before_rename(
                    Path::new(&name),
                    bytes.as_bytes(),
                    mode,
                    dir_mode,
                    || {
                        hook().map_err(|err| {
                            hook_error = Some(err);
                            std::io::Error::other("state write callback failed")
                        })
                    },
                );
                if let Some(err) = hook_error {
                    let error = exception(p, err)?;
                    notify(p, file, error, "atomic_write")?;
                    return Err(error.throw_error());
                }
                if let Err(failure) = res {
                    let (mut thrown, reported, mut op) =
                        crate::node_fs_error::atomic_write_failure(p, &failure)?;
                    if failure.stage == state_file::WriteStage::ChmodDir {
                        op = "mkdir";
                        let msg = message(
                            p,
                            "[state-store] mkdir ",
                            &[
                                text(p, &failure.path.to_string_lossy())?,
                                text(p, ": ")?,
                                reported.get(c"message")?,
                            ],
                        )?;
                        thrown = p.global()?.get(c"Error")?.construct(&[msg])?;
                    }
                    notify(p, file, reported, op)?;
                    return Err(thrown.throw_error());
                }
                return Ok(());
            }
        }
    }
    // Non-string bodies, special permissions and overridden fs methods require
    // Node's argument overloads and original error objects.
    let fs = p.get(c"fs")?;
    let dir = call(p.get(c"path")?, c"dirname", &[file])?;
    let existed = call(fs, c"existsSync", &[dir])?.truthy()?;
    let mkdir = (|| {
        call(
            fs,
            c"mkdirSync",
            &[
                dir,
                fields(p, &[("recursive", flag(p, true)?), ("mode", dir_mode)])?,
            ],
        )?;
        if !existed || enforce {
            call(fs, c"chmodSync", &[dir, dir_mode])?;
        }
        Ok(())
    })();
    if let Err(err) = mkdir {
        let cause = exception(p, err)?;
        if !cause.get(c"code")?.is_string("EEXIST")? {
            notify(p, file, cause, "mkdir")?;
            let msg = message(
                p,
                "[state-store] mkdir ",
                &[dir, text(p, ": ")?, cause.get(c"message")?],
            )?;
            return Err(p.global()?.get(c"Error")?.construct(&[msg])?.throw_error());
        }
    }
    let tmp = message(p, "", &[file, text(p, &state_file::temporary_suffix())?])?;
    let mut fd = None;
    let result = (|| {
        let handle = call(fs, c"openSync", &[tmp, text(p, "w")?, mode])?;
        fd = Some(handle);
        call(fs, c"writeSync", &[handle, body])?;
        sync(fs, handle)?;
        call(fs, c"closeSync", &[handle])?;
        fd = None;
        hook()?;
        call(fs, c"renameSync", &[tmp, file])?;
        call(fs, c"chmodSync", &[file, mode])?;
        sync_dir(fs, dir)
    })();
    if let Err(err) = result {
        let cause = exception(p, err)?;
        notify(p, file, cause, "atomic_write")?;
        fs.catch(|| call(fs, c"unlinkSync", &[tmp]))?;
        if let Some(handle) = fd {
            fs.catch(|| call(fs, c"closeSync", &[handle]))?;
        }
        return Err(cause.throw_error());
    }
    Ok(())
}

fn sync<'a>(fs: L<'a>, handle: L<'a>) -> Result<()> {
    if let Err(err) = call(fs, c"fsyncSync", &[handle]) {
        let cause = exception(fs, err)?;
        let code = cause.optional(c"code")?;
        if !code.is_string("ENOTSUP")? && !code.is_string("EINVAL")? {
            return Err(cause.throw_error());
        }
    }
    Ok(())
}

fn sync_dir<'a>(fs: L<'a>, dir: L<'a>) -> Result<()> {
    let mut fd = None;
    let result = (|| {
        let handle = call(
            fs,
            c"openSync",
            &[dir, fs.get(c"constants")?.get(c"O_RDONLY")?],
        )?;
        fd = Some(handle);
        sync(fs, handle)
    })();
    let cause = match result {
        Ok(()) => None,
        Err(err) => Some(exception(fs, err)?),
    };
    if let Some(handle) = fd {
        fs.catch(|| call(fs, c"closeSync", &[handle]))?;
    }
    if let Some(cause) = cause {
        let code = cause.get(c"code")?;
        if !code.is_string("EISDIR")? && !code.is_string("EBADF")? && !code.is_string("EPERM")? {
            return Err(cause.throw_error());
        }
    }
    Ok(())
}
