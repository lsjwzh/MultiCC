//! Keep history reads and commits relative to the directories that were
//! checked. A dated subdirectory can be replaced while an overlay is closing.
use super::*;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, DirBuilder, OpenOptions},
};
use std::ffi::OsString;
use std::path::Component;

pub(super) fn root(path: &Path) -> io::Result<Dir> {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => {
            Dir::open_ambient_dir(parent, ambient_authority())?.open_dir_nofollow(name)
        }
        _ => Dir::open_ambient_dir(path, ambient_authority()),
    }
}
pub(super) fn descend(root: &Dir, relative: &Path, create: bool) -> io::Result<Dir> {
    let mut dir = root.try_clone()?;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid rollout path",
            ));
        };
        dir = match dir.open_dir_nofollow(name) {
            Ok(child) => child,
            Err(e) if create && e.kind() == io::ErrorKind::NotFound => {
                let mut builder = DirBuilder::new();
                #[cfg(unix)]
                {
                    use cap_std::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                match dir.create_dir_with(name, &builder) {
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
                    r => r?,
                }
                dir.open_dir_nofollow(name)?
            }
            Err(e) => return Err(e),
        };
    }
    Ok(dir)
}

pub(super) struct File {
    dir: Dir,
    leaf: OsString,
}
impl File {
    pub fn at(root_path: &Path, path: &Path, create_parent: bool) -> io::Result<Self> {
        let relative = path
            .strip_prefix(root_path)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid rollout path"))?;
        let leaf = relative
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing rollout name"))?;
        Ok(Self {
            dir: descend(
                &root(root_path)?,
                relative.parent().unwrap_or(Path::new("")),
                create_parent,
            )?,
            leaf: leaf.to_owned(),
        })
    }
    pub fn open(&self) -> io::Result<fs::File> {
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = self.dir.open_with(&self.leaf, &options)?.into_std();
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "rollout must be a regular file",
            ));
        }
        Ok(file)
    }
    pub fn version(&self) -> io::Result<Option<Version>> {
        // Stat first. Taking a baseline never requires permission to read an
        // unchanged historical file's contents.
        match self.dir.symlink_metadata(&self.leaf) {
            Ok(m) if m.is_file() && !m.is_symlink() => Ok(Some(Version::from_metadata(&m)?)),
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "rollout must be a regular file",
            )),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    /// The caller supplies the byte stream and the source/destination check
    /// to run after it becomes durable and immediately before publication.
    pub fn publish(
        &self,
        replace: bool,
        stage: impl FnOnce(&mut fs::File) -> Result<()>,
        check: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let temporary = format!(
            ".codex-history.{}.{}",
            std::process::id(),
            random_hex::<6>()?
        );
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = self.dir.open_with(&temporary, &options)?.into_std();
        let result = (|| {
            stage(&mut output)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                output.set_permissions(fs::Permissions::from_mode(0o600))?;
            }
            if let Err(e) = output.sync_data() {
                if !super::session::tolerated(&e, false) {
                    return Err(e.into());
                }
            }
            drop(output);
            check()?;
            if replace {
                self.dir.rename(&temporary, &self.dir, &self.leaf)?
            } else if let Err(e) = self.dir.hard_link(&temporary, &self.dir, &self.leaf) {
                return Err(if e.kind() == io::ErrorKind::AlreadyExists {
                    Error::caused(
                        "CODEX_SESSION_ROLLOUT_RACE",
                        "Codex canonical rollout appeared during migration",
                        e.into(),
                    )
                } else {
                    e.into()
                });
            }
            if let Err(e) = self
                .dir
                .try_clone()
                .and_then(|dir| dir.into_std_file().sync_all())
            {
                if !super::session::tolerated(&e, true) {
                    return Err(e.into());
                }
            }
            Ok(())
        })();
        let _ = self.dir.remove_file(&temporary);
        result
    }
}
