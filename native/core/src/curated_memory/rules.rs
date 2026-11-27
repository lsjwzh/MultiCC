use super::{read_utf8, DELIMITER, FILE};
use crate::js::{is_js_whitespace_char, js_trim};
use std::{fs, io, path::Path};

pub const LEGACY: [&str; 3] = [
    "[规则][文档与服务登记·强制]",
    "[规则][敏感信息保险箱·强制]",
    "[规则][共享文件约定·强制]",
];
const SOURCES: [&str; 3] = [
    "multicc-artifact/references/registration-rule.md",
    "multicc-secrets/references/secret-vault-rule.md",
    "multicc-workspaces/references/shared-files-rule.md",
];
pub struct Rules(pub Vec<String>);
impl Rules {
    pub fn load(skills: &Path) -> io::Result<Self> {
        Ok(Self(
            SOURCES
                .iter()
                .map(|f| read_utf8(&skills.join(f)).map(|s| js_trim(&s).to_owned()))
                .collect::<io::Result<_>>()?,
        ))
    }
    pub fn marker(&self, i: usize) -> &str {
        self.0[i].split('\n').next().unwrap_or("")
    }
    pub fn marked(&self, body: &str, i: usize) -> bool {
        body.split('\n').any(|s| {
            let s = s.trim_start_matches(is_js_whitespace_char);
            s.starts_with(self.marker(i)) || s.starts_with(LEGACY[i])
        })
    }
    fn seeded_content(&self, file: &Path) -> io::Result<Option<String>> {
        let mut content = match fs::symlink_metadata(file) {
            Ok(meta) if !meta.is_file() => {
                return Err(io::Error::other("shared MEMORY.md must be a regular file"));
            }
            Ok(_) => read_utf8(file)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e),
        };
        let mut updated = false;
        for (i, rule) in self.0.iter().enumerate() {
            if self.marked(&content, i) {
                continue;
            }
            if !content.is_empty() {
                content.push_str(DELIMITER);
            }
            content.push_str(rule);
            content.push('\n');
            updated = true;
        }
        Ok(updated.then_some(content))
    }

    pub fn seed(&self, dir: &Path) -> io::Result<bool> {
        let file = dir.join(FILE);
        let _guard = super::EDIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(content) = self.seeded_content(&file)? else {
            return Ok(false);
        };
        super::write(&file, content.as_bytes())?;
        Ok(true)
    }

    /// A host-supplied rename can reenter the store or block while a different
    /// writer commits. Stage its rename between two private siblings. Publishing
    /// to the live pathname always uses the latest contents under the edit lock.
    pub fn seed_with_rename<E: From<io::Error>>(
        &self,
        dir: &Path,
        rename: impl FnOnce(&Path, &Path) -> Result<(), E>,
    ) -> Result<bool, E> {
        let file = dir.join(FILE);
        let candidate = {
            let _guard = super::EDIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let Some(content) = self.seeded_content(&file)? else {
                return Ok(false);
            };
            content
        };
        let source = super::TemporaryFile::create(&file, candidate.as_bytes())?;
        let staged = super::TemporaryFile::create(&file, &[])?;
        rename(&source.0, &staged.0)?;
        if fs::read(&staged.0)? != candidate.as_bytes() {
            return Err(io::Error::other(
                "shared memory rename did not preserve the staged contents",
            )
            .into());
        }

        let _guard = super::EDIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(current) = self.seeded_content(&file)? else {
            return Ok(false);
        };
        if current == candidate {
            fs::rename(&staged.0, &file)?;
        } else {
            super::write(&file, current.as_bytes())?;
        }
        Ok(true)
    }
}
