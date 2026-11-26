//! The host supplies the Node-compatible fs/path objects, including fault
//! injection ports. Rename is the commit point for all five collections.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_ID: AtomicU64 = AtomicU64::new(0);
fn ignore_errno<T>(fs: L<'_>, result: Result<T>, codes: &[&str]) -> Result<()> {
    if let Err(error) = result {
        let cause = reason(fs, error)?;
        if cause.truthy()? {
            let code = cause.get(c"code")?;
            for expected in codes {
                if code.is_string(expected)? {
                    return Ok(());
                }
            }
        }
        return Err(cause.throw_error());
    }
    Ok(())
}
fn sync(fs: L<'_>, fd: L<'_>) -> Result<()> {
    ignore_errno(
        fs,
        call(fs, c"fsyncSync", &[fd]),
        &["ENOTSUP", "EINVAL", "EBADF"],
    )
}
fn close(fs: L<'_>, fd: L<'_>) -> Result<()> {
    if !fd.undefined()? {
        fs.catch(|| call(fs, c"closeSync", &[fd]))?;
    }
    Ok(())
}
fn sync_dir<'a>(ports: L<'a>, fs: L<'a>, dir: L<'a>) -> Result<()> {
    let mut fd = undef(fs)?;
    let res = (|| {
        let mut constants = fs.get(c"constants")?;
        if !constants.truthy()? {
            constants = ports.get(c"fs")?.get(c"constants")?;
        }
        fd = call(fs, c"openSync", &[dir, constants.get(c"O_RDONLY")?])?;
        sync(fs, fd)
    })();
    let result = ignore_errno(fs, res, &["EISDIR", "EPERM", "EINVAL", "EBADF"]);
    let error = match result {
        Err(e) => Some(reason(fs, e)?),
        Ok(()) => None,
    };
    close(fs, fd)?;
    if let Some(e) = error {
        return Err(e.throw_error());
    }
    Ok(())
}
fn hook<'a>(
    hooks: L<'a>,
    name: &CStr,
    file: L<'a>,
    temp: Option<L<'a>>,
    state: L<'a>,
) -> Result<()> {
    let f = crate::js_iteration::read(hooks, name)?;
    if func(f)? {
        let arg = fields(file, &[("file", file)])?;
        if let Some(temp) = temp {
            arg.set(c"temp", temp)?;
        }
        arg.set(c"state", state::clone_json(state)?)?;
        call(hooks, name, &[arg])?;
    }
    Ok(())
}
pub(super) fn write<'a>(ports: L<'a>, opts: L<'a>, state: L<'a>) -> Result<()> {
    let fs = opts.get(c"fsImpl")?;
    let file = opts.get(c"file")?;
    let hooks = opts.get(c"hooks")?;
    let dir = call(opts.get(c"pathImpl")?, c"dirname", &[file])?;
    let mkdir = fields(
        fs,
        &[
            ("recursive", flag(fs, true)?),
            ("mode", num(fs, 0o700 as f64)?),
        ],
    )?;
    call(fs, c"mkdirSync", &[dir, mkdir])?;
    let now = opts.get(c"now")?.call_plain(&[])?;
    let temp = join(
        file,
        &[
            file,
            text(fs, ".tmp.")?,
            num(fs, std::process::id() as f64)?,
            text(fs, ".")?,
            now,
            text(fs, ".")?,
            num(fs, (TEMP_ID.fetch_add(1, Ordering::Relaxed) + 1) as f64)?,
        ],
    )?;
    let data = join(
        fs,
        &[
            json(fs, c"stringify", &[state, null(fs)?, num(fs, 2.)?])?,
            text(fs, "\n")?,
        ],
    )?;
    let mode = num(fs, 0o600 as f64)?;
    let mut fd = undef(fs)?;
    let mut renamed = false;
    let result = (|| -> Result<()> {
        fd = call(fs, c"openSync", &[temp, text(fs, "wx")?, mode])?;
        call(
            fs,
            c"writeFileSync",
            &[fd, data, fields(fs, &[("encoding", text(fs, "utf8")?)])?],
        )?;
        sync(fs, fd)?;
        call(fs, c"closeSync", &[fd])?;
        fd = undef(fs)?;
        call(fs, c"chmodSync", &[temp, mode])?;
        hook(hooks, c"beforeRename", file, Some(temp), state)?;
        call(fs, c"renameSync", &[temp, file])?;
        renamed = true;
        call(fs, c"chmodSync", &[file, mode])?;
        sync_dir(ports, fs, dir)?;
        hook(hooks, c"afterRename", file, None, state)
    })();
    if let Err(error) = result {
        let thrown = reason(fs, error)?;
        if !renamed {
            fs.catch(|| call(fs, c"unlinkSync", &[temp]))?;
        }
        close(fs, fd)?;
        return Err(thrown.throw_error());
    }
    Ok(())
}
pub(super) fn load<'a>(ports: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let fs = opts.get(c"fsImpl")?;
    let file = opts.get(c"file")?;
    if !call(fs, c"existsSync", &[file])?.truthy()? {
        return state::initial(ports);
    }
    let wrap = |error, prefix: &str| {
        let e = reason(fs, error)?;
        let msg = join(
            fs,
            &[
                text(fs, prefix)?,
                file,
                text(fs, ": ")?,
                crate::js_iteration::read(e, c"message")?,
            ],
        )?;
        corrupt(ports, msg, file, Some(e))
    };
    let raw = call(fs, c"readFileSync", &[file, text(fs, "utf8")?])
        .or_else(|e| wrap(e, "cannot read orchestration state "))?;
    let parsed =
        json(fs, c"parse", &[raw]).or_else(|e| wrap(e, "invalid JSON in orchestration state "))?;
    let value = state::validate(ports, parsed, file)?;
    call(fs, c"chmodSync", &[file, num(fs, 0o600 as f64)?])?;
    Ok(value)
}
