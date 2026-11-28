//! Permissions are established synchronously during startup, before the host
//! opens its stores. Keep Node's error objects and StateStore reporter contract.
use crate::{node_fs_error, route_response::*};
use multicc_core::state_file;
use napi::bindgen_prelude::ToNapiValue;
use napi_derive::napi;
use std::{fs, io, path::Path};

fn mode(path: &Path, bits: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(bits))
    }
    #[cfg(not(unix))]
    {
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_readonly(bits & 0o200 == 0);
        fs::set_permissions(path, permissions)
    }
}
pub(super) fn private_dir(p: L<'_>, path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|e| node_fs_error::throw(p, &e, "mkdir", Some(path), None))?;
    mode(path, 0o700).map_err(|e| node_fs_error::throw(p, &e, "chmod", Some(path), None))
}
fn secure_file(p: L<'_>, path: &Path) -> Result<()> {
    match mode(path, 0o600) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(node_fs_error::throw(p, &e, "chmod", Some(path), None)),
    }
}
#[napi]
pub fn runtime_private_path(env: Env, path: String, directory: bool) -> Result<()> {
    let p = L::new(&env, env.get_global()?.into_unknown(&env)?);
    if directory {
        private_dir(p, Path::new(&path))
    } else {
        secure_file(p, Path::new(&path))
    }
}
#[napi]
pub fn secure_runtime_paths(env: Env, paths: Unknown<'_>) -> Result<()> {
    let p = L::new(&env, paths);
    let root = p.get(c"root")?;
    for key in [
        c"root",
        c"chatHistoryDir",
        c"eventsDir",
        c"journalDir",
        c"detachedDir",
    ] {
        let dir = p.get(key)?;
        if !dir.truthy()? || (key == c"root" && root.equals(p.get(c"pkgRoot")?)?) {
            continue;
        }
        let directory = dir.coerce_string()?.to_string_lossy();
        let directory = Path::new(&directory);
        private_dir(p, directory)?;
        if let Ok(entries) = fs::read_dir(directory) {
            for entry in entries {
                let entry = entry
                    .map_err(|e| node_fs_error::throw(p, &e, "scandir", Some(directory), None))?;
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_file() {
                    secure_file(p, &entry.path())?;
                } else if kind.is_dir() && !dir.equals(root)? {
                    private_dir(p, &entry.path())?;
                }
            }
        }
    }
    call(p.global()?.get(c"Object")?, c"entries", &[p])?.for_each(|pair| {
        if !pair
            .element(0)?
            .coerce_string()?
            .to_string_lossy()
            .ends_with("File")
        {
            return Ok(());
        }
        if let Some(value) = pair.element(1)?.string()? {
            let name = value.to_string_lossy();
            if Path::new(&name).is_absolute() {
                secure_file(p, Path::new(&name))?;
                for i in 1..=3 {
                    secure_file(p, Path::new(&format!("{name}.bak{i}")))?;
                }
            }
        }
        Ok(())
    })
}
pub(super) fn atomic(
    p: L<'_>,
    target: L<'_>,
    body: &str,
    mode: u32,
    dir_mode: u32,
    reporter: L<'_>,
) -> Result<()> {
    let file = target.coerce_string()?.to_string_lossy();
    let full = std::path::absolute(Path::new(&file))
        .map_err(|e| node_fs_error::throw(p, &e, "open", Some(Path::new(&file)), None))?;
    if let Err(failure) =
        state_file::write_bytes_atomic_traced(&full, body.as_bytes(), mode, dir_mode)
    {
        let (thrown, reported, op) = node_fs_error::atomic_write_failure(p, &failure)?;
        if !reporter.undefined()? {
            p.catch(|| {
                reporter.call_plain(&[
                    reported,
                    fields(p, &[("target", target), ("operation", text(p, op)?)])?,
                ])
            })?;
        }
        return Err(thrown.throw_error());
    }
    Ok(())
}
#[napi]
pub fn runtime_atomic_text(
    env: Env,
    target: Unknown<'_>,
    body: String,
    mode: u32,
    dir_mode: u32,
    reporter: Unknown<'_>,
) -> Result<()> {
    let target = L::new(&env, target);
    atomic(
        target,
        target,
        &body,
        mode,
        dir_mode,
        L::new(&env, reporter),
    )
}
