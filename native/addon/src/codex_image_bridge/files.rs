use super::*;
use napi::{
    bindgen_prelude::{AsyncTask, ToNapiValue},
    Task,
};
use std::{
    cmp::Ordering,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
mod injected;

pub(super) fn signature(raw: &[u8]) -> Option<&'static str> {
    if raw.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        Some("png")
    } else if raw.starts_with(&[255, 216, 255]) {
        Some("jpg")
    } else if raw.starts_with(b"RIFF") && raw.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else {
        None
    }
}
pub(super) fn mime(ext: &str) -> &'static str {
    match ext {
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    }
}
pub(super) fn format<'a>(p: L<'a>, file: L<'a>, fs: L<'a>) -> Result<L<'a>> {
    let ext = p.catch(|| injected::signature(fs, file))?.flatten();
    if let Some(ext) = ext {
        fields(
            p,
            &[("extension", text(p, ext)?), ("mime", text(p, mime(ext))?)],
        )
    } else {
        null(p)
    }
}
pub(super) fn private(p: L<'_>, file: L<'_>, dir: bool) -> Result<()> {
    crate::runtime_security::runtime_private_path(
        crate::host_methods::env(p),
        fold_string(file)?,
        dir,
    )
}
struct Meta {
    regular: bool,
    bytes: u64,
    modified: f64,
}
enum Kind {
    Dir,
    File,
    Other,
}
trait Files {
    fn copy(&self, src: &Path, dest: &Path) -> Result<()>;
    fn secure(&self, dest: &Path, dir: bool) -> Result<()>;
    fn real(&self, path: &Path) -> Result<PathBuf>;
    fn stat(&self, path: &Path) -> Result<Meta>;
    fn kind(&self, path: &Path) -> Result<Option<&'static str>>;
    fn entries(&self, path: &Path) -> Result<Vec<(PathBuf, Kind)>>;
}
struct Disk;
fn err(e: io::Error) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}
impl Files for Disk {
    fn copy(&self, src: &Path, dest: &Path) -> Result<()> {
        fs::copy(src, dest).map(|_| ()).map_err(err)
    }
    fn secure(&self, p: &Path, dir: bool) -> Result<()> {
        if dir {
            let mut b = fs::DirBuilder::new();
            b.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                b.mode(0o700);
            }
            b.create(p).map_err(err)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                p,
                fs::Permissions::from_mode(if dir { 0o700 } else { 0o600 }),
            )
            .map_err(err)?;
        }
        Ok(())
    }
    fn real(&self, p: &Path) -> Result<PathBuf> {
        fs::canonicalize(p).map_err(err)
    }
    fn stat(&self, p: &Path) -> Result<Meta> {
        let st = fs::metadata(p).map_err(err)?;
        let modified = st
            .modified()
            .map_err(err)?
            .duration_since(UNIX_EPOCH)
            .map_or_else(|e| -e.duration().as_secs_f64(), |t| t.as_secs_f64());
        Ok(Meta {
            regular: st.is_file(),
            bytes: st.len(),
            modified,
        })
    }
    fn kind(&self, p: &Path) -> Result<Option<&'static str>> {
        let mut head = [0; 12];
        let mut f = fs::File::open(p).map_err(err)?;
        let mut used = 0;
        while used < head.len() {
            let n = f.read(&mut head[used..]).map_err(err)?;
            if n == 0 {
                break;
            }
            used += n;
        }
        Ok(signature(&head[..used]))
    }
    fn entries(&self, p: &Path) -> Result<Vec<(PathBuf, Kind)>> {
        let mut all = vec![];
        for e in fs::read_dir(p).map_err(err)?.flatten() {
            if let Ok(ty) = e.file_type() {
                all.push((
                    e.path(),
                    if ty.is_dir() {
                        Kind::Dir
                    } else if ty.is_file() {
                        Kind::File
                    } else {
                        Kind::Other
                    },
                ));
            }
        }
        Ok(all)
    }
}
#[derive(Clone)]
enum Job {
    Prepare {
        auth: PathBuf,
        run: PathBuf,
        cwd: PathBuf,
        refs: Vec<PathBuf>,
    },
    Discover {
        root: PathBuf,
    },
    Publish {
        src: PathBuf,
        dest: PathBuf,
    },
}
fn invalid(detail: &str) -> serde_json::Value {
    serde_json::json!({"error":"invalid_arguments","detail":detail})
}
fn scan(fs: &impl Files, p: &Path, depth: usize, rows: &mut Vec<(PathBuf, Meta, &'static str)>) {
    if depth > 3 || rows.len() > 64 {
        return;
    }
    if let Ok(entries) = fs.entries(p) {
        for (file, kind) in entries {
            match kind {
                Kind::Dir => scan(fs, &file, depth + 1, rows),
                Kind::File => {
                    if let Ok(st) = fs.stat(&file) {
                        if st.bytes > 0 && st.bytes <= 32 * 1024 * 1024 {
                            if let Ok(Some(ext)) = fs.kind(&file) {
                                rows.push((file, st, ext));
                            }
                        }
                    }
                }
                Kind::Other => {}
            }
        }
    }
}
impl Job {
    fn run(&self, fs: &impl Files) -> Result<serde_json::Value> {
        use serde_json::json;
        match self {
            Self::Prepare {
                auth,
                run,
                cwd,
                refs,
            } => {
                let file = run.join("codex-home").join("auth.json");
                fs.copy(auth, &file)?;
                fs.secure(&file, false)?;
                let inputs = run.join("inputs");
                let mut paths = vec![];
                if !refs.is_empty() {
                    if !cwd.is_absolute() {
                        return Ok(json!({"error":"image_generation_unavailable"}));
                    }
                    fs.secure(&inputs, true)?;
                }
                for (i, path) in refs.iter().enumerate() {
                    let (Ok(root), Ok(file)) = (fs.real(cwd), fs.real(path)) else {
                        return Ok(invalid(
                            "reference images must be inside the current workspace",
                        ));
                    };
                    if file == root || !file.starts_with(&root) {
                        return Ok(invalid(
                            "reference images must be inside the current workspace",
                        ));
                    }
                    if !fs
                        .stat(&file)
                        .is_ok_and(|s| s.regular && s.bytes > 0 && s.bytes <= 12 * 1024 * 1024)
                    {
                        return Ok(invalid("reference image is invalid or too large"));
                    }
                    let Some(ext) = fs.kind(&file).ok().flatten() else {
                        return Ok(invalid("reference image must be PNG, JPEG, or WebP"));
                    };
                    let dest = inputs.join(format!("reference-{}.{ext}", i + 1));
                    fs.copy(&file, &dest)?;
                    fs.secure(&dest, false)?;
                    paths.push(dest);
                }
                Ok(json!({"inputs":paths}))
            }
            Self::Discover { root } => {
                let mut all = vec![];
                scan(fs, root, 0, &mut all);
                all.sort_by(|a, b| {
                    b.1.modified
                        .partial_cmp(&a.1.modified)
                        .unwrap_or(Ordering::Equal)
                });
                if let Some((file, st, ext)) = all.first() {
                    Ok(json!({"file":file,"bytes":st.bytes,"ext":ext}))
                } else {
                    Ok(json!({"error":"image_generation_failed"}))
                }
            }
            Self::Publish { src, dest } => {
                if let Some(art) = dest.parent() {
                    if let Some(parent) = art.parent() {
                        fs.secure(parent, true)?;
                    }
                    fs.secure(art, true)?;
                }
                fs.copy(src, dest)?;
                fs.secure(dest, false)?;
                Ok(json!({}))
            }
        }
    }
}
impl Task for Job {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        Ok(self.run(&Disk)?.to_string())
    }
    fn resolve(&mut self, _: Env, out: String) -> Result<String> {
        Ok(out)
    }
}
fn dispatch<'a>(ctx: L<'a>, job: Job) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let result = if p.get(c"nativeFs")?.truthy()? {
        let task = AsyncTask::new(job);
        L::from_raw(ctx.env(), unsafe {
            AsyncTask::to_napi_value(ctx.env(), task)
        }?)
    } else {
        let fs = injected::Adapter {
            p,
            fs: p.get(c"fsImpl")?,
        };
        text(p, &job.run(&fs)?.to_string())?
    };
    then(result, p, |p, a| {
        let data = json_call(p, c"parse", a[0])?;
        let code = data.get(c"error")?;
        if code.truthy()? {
            let msg = data.get(c"detail")?;
            return Err(issue(p, code, msg)?.throw_error());
        }
        Ok(data)
    })
}
fn path(v: L<'_>) -> Result<PathBuf> {
    Ok(PathBuf::from(fold_string(v)?))
}
pub(super) fn prepare(ctx: L<'_>) -> Result<L<'_>> {
    let p = ctx.get(c"p")?;
    let args = ctx.get(c"args")?;
    let mut refs = vec![];
    ctx.get(c"refs")?.for_each(|v| {
        refs.push(path(v)?);
        Ok(())
    })?;
    let cwd = if refs.is_empty() {
        PathBuf::new()
    } else {
        let dir = p
            .get(c"resolveSessionCwd")?
            .call_plain(&[args.get(c"session")?])?;
        if !dir.truthy()? {
            PathBuf::new()
        } else {
            path(dir)?
        }
    };
    dispatch(
        ctx,
        Job::Prepare {
            run: path(ctx.get(c"run")?)?,
            auth: path(ctx.get(c"auth")?)?,
            cwd,
            refs,
        },
    )
}
pub(super) fn discover(ctx: L<'_>) -> Result<L<'_>> {
    dispatch(
        ctx,
        Job::Discover {
            root: path(ctx.get(c"home")?)?.join("generated_images"),
        },
    )
}
pub(super) fn publish<'a>(ctx: L<'a>, src: L<'a>, dest: L<'a>) -> Result<L<'a>> {
    dispatch(
        ctx,
        Job::Publish {
            src: path(src)?,
            dest: path(dest)?,
        },
    )
}
