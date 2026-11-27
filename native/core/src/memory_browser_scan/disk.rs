use super::Files;
use cap_std::{ambient_authority, fs::Dir};
use std::{
    convert::Infallible,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub struct NativeFiles {
    root: PathBuf,
    real: Option<(PathBuf, Dir)>,
}
impl NativeFiles {
    pub fn new(root: &Path) -> Self {
        let real = fs::canonicalize(root).ok().and_then(|path| {
            let dir = Dir::open_ambient_dir(&path, ambient_authority()).ok()?;
            Some((path, dir))
        });
        Self {
            root: root.to_owned(),
            real,
        }
    }
    // Accept absolute symlinks whose targets stay under the root. Open the
    // resolved relative path through the directory capability, so replacing
    // a component after canonicalization cannot redirect the read outside.
    fn target(&self, path: &Path) -> Option<(&Dir, PathBuf)> {
        path.strip_prefix(&self.root).ok()?;
        let (real, dir) = self.real.as_ref()?;
        let resolved = fs::canonicalize(path).ok()?;
        let rel = resolved.strip_prefix(real).ok()?;
        Some((
            dir,
            if rel.as_os_str().is_empty() {
                ".".into()
            } else {
                rel.to_owned()
            },
        ))
    }
    fn entries(&self, path: &Path, directories: bool) -> Vec<String> {
        let Some((dir, rel)) = self.target(path) else {
            return vec![];
        };
        let Ok(entries) = dir.read_dir(rel) else {
            return vec![];
        };
        let mut names: Vec<_> = entries
            .flatten()
            .filter(|e| !directories || e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.file_name())
            .collect();
        // Node's uv_fs_scandir returns names in native lexical order.
        names.sort();
        names
            .into_iter()
            .map(|n| n.to_string_lossy().into_owned())
            .collect()
    }
}
impl Files for NativeFiles {
    type Error = Infallible;
    fn directories(&self, dir: &Path) -> Vec<String> {
        self.entries(dir, true)
    }
    fn names(&self, dir: &Path) -> Vec<String> {
        self.entries(dir, false)
    }
    fn read(&self, path: &Path, timestamp: bool) -> Option<(String, Option<String>)> {
        let (dir, rel) = self.target(path)?;
        if !dir.metadata(&rel).ok()?.is_file() {
            return None;
        }
        let mut file = dir.open(rel).ok()?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).ok()?;
        let mtime = if timestamp {
            file.metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| {
                    let ms = match t.into_std().duration_since(UNIX_EPOCH) {
                        Ok(d) => d.as_secs_f64() * 1000.,
                        Err(e) => -e.duration().as_secs_f64() * 1000.,
                    };
                    crate::js::date_to_iso_string((ms + 0.5).floor())
                })
        } else {
            None
        };
        Some((String::from_utf8_lossy(&bytes).into_owned(), mtime))
    }
}
