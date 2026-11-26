use super::*;
use std::{
    fs::OpenOptions,
    io::Write,
    sync::atomic::{AtomicU64, Ordering},
};

const MAX_BUFFER: u64 = 256 * 1024 * 1024;

pub(super) async fn collect(ctx: &mut GitContext, wt: &str, split: bool) -> Outcome {
    let mut facts = json!({"ok":true});
    if split {
        facts["head"] = json!(ctx.git(wt, &["rev-parse", "HEAD"]).await?.trim());
    }
    let opts = json!({"raw":true,"maxBuffer":MAX_BUFFER});
    let patch = ctx
        .git_opts(
            wt,
            &["diff", "--binary", "--full-index", "HEAD"],
            opts.clone(),
        )
        .await?;
    let listing = ctx
        .git_opts(
            wt,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            opts,
        )
        .await?;
    let names: Vec<_> = listing.split('\0').filter(|s| safe_relative(s)).collect();
    facts["carried"] = json!({"patch":patch,"untracked":names,"worktreePath":wt});
    if split {
        let unknown: Vec<_> = ignored(ctx, wt)
            .await
            .into_iter()
            .filter(|s| !reclaimable(s))
            .collect();
        facts["unknownIgnored"] = json!(unknown);
    }
    Ok(facts)
}

fn named_files(carried: &Value) -> impl Iterator<Item = &str> {
    carried["untracked"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

pub(super) fn has_content(carried: &Value) -> bool {
    !string(&carried["patch"]).trim().is_empty() || named_files(carried).next().is_some()
}

// In particular, a pre-existing link in the target tree may not redirect an
// untracked file copy outside the checkout.
fn contained_destination(root: &Path, relative: &str) -> io::Result<PathBuf> {
    if !safe_relative(relative) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid carry path",
        ));
    }
    let target = root.join(relative);
    let mut ancestor = target.parent();
    while let Some(path) = ancestor {
        if path == root {
            return Ok(target);
        }
        if fs::symlink_metadata(path).is_ok_and(|m| m.is_symlink()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("carry path crosses a symbolic link: {}", path.display()),
            ));
        }
        ancestor = path.parent();
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid carry destination",
    ))
}

#[cfg(unix)]
fn copy_link(from: &Path, to: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(fs::read_link(from)?, to)
}
#[cfg(windows)]
fn copy_link(from: &Path, to: &Path) -> io::Result<()> {
    let link = fs::read_link(from)?;
    if from.is_dir() {
        std::os::windows::fs::symlink_dir(link, to)
    } else {
        std::os::windows::fs::symlink_file(link, to)
    }
}

pub(super) fn copy_entry(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    let meta = fs::symlink_metadata(from)?;
    if let Ok(dest) = fs::symlink_metadata(to) {
        if !(meta.is_dir() && dest.is_dir()) {
            if meta.is_file()
                && dest.is_file()
                && meta.len() == dest.len()
                && fs::read(from)? == fs::read(to)?
            {
                return Ok(());
            }
            if meta.is_symlink() && dest.is_symlink() && fs::read_link(from)? == fs::read_link(to)?
            {
                return Ok(());
            }
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("carry destination already exists: {}", to.display()),
            ));
        }
    }
    if meta.is_symlink() {
        return copy_link(from, to);
    }
    if meta.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_entry(&entry.path(), &to.join(entry.file_name()))?;
        }
        fs::set_permissions(to, meta.permissions())?;
    } else if meta.is_file() {
        let mut dest = OpenOptions::new().write(true).create_new(true).open(to)?;
        let mut source = fs::File::open(from)?;
        io::copy(&mut source, &mut dest)?;
        fs::set_permissions(to, meta.permissions())?;
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported untracked file type",
        ));
    }
    Ok(())
}

struct PatchFile(PathBuf);
impl PatchFile {
    fn new(data: &str) -> io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        loop {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("multicc-carry-{}-{id}.patch", std::process::id()));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(mut file) => {
                    let tmp = Self(path);
                    file.write_all(data.as_bytes())?;
                    return Ok(tmp);
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
    }
}
impl Drop for PatchFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub(super) async fn apply(ctx: &mut GitContext, wt: &str, carried: &Value) -> Outcome {
    let patch = string(&carried["patch"]);
    ctx.progress("apply-patch", Value::Null).await?;
    if !patch.trim().is_empty() {
        let tmp = PatchFile::new(patch)?;
        if let Err(err) = ctx
            .git_opts(
                wt,
                &["apply", "--whitespace=nowarn", &tmp.0.to_string_lossy()],
                json!({"maxBuffer":MAX_BUFFER}),
            )
            .await
        {
            return Err(coded(
                format!(
                    "carry patch does not apply to the target repository: {}",
                    error_text(&err)
                ),
                "carry_apply_failed",
            ));
        }
    }
    let files: Vec<_> = named_files(carried).collect();
    ctx.progress("copy-untracked", json!({"count":files.len()}))
        .await?;
    for name in &files {
        copy_entry(
            &Path::new(string(&carried["worktreePath"])).join(name),
            &contained_destination(Path::new(wt), name)?,
        )?;
    }
    Ok(json!({"ok":true,"appliedFiles":files,"patchBytes":patch.len()}))
}

pub(super) async fn already_in(
    ctx: &mut GitContext,
    target: &str,
    carried: &Value,
) -> Result<bool, GitError> {
    let patch = string(&carried["patch"]);
    if !patch.trim().is_empty() {
        let tmp = PatchFile::new(patch)?;
        if ctx
            .git_opts(
                target,
                &["apply", "--reverse", "--check", &tmp.0.to_string_lossy()],
                json!({"maxBuffer":MAX_BUFFER}),
            )
            .await
            .is_err()
        {
            return Ok(false);
        }
    }
    for name in named_files(carried) {
        let source = Path::new(string(&carried["worktreePath"])).join(name);
        let dest = contained_destination(Path::new(target), name)?;
        match (fs::read(source), fs::read(dest)) {
            (Ok(a), Ok(b)) if a == b => {}
            _ => return Ok(false),
        }
    }
    Ok(true)
}
