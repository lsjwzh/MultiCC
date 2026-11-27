//! 逻辑会话 home、旧历史迁移和 managed/providerless 精确同步。
use crate::codex_home_fs::*;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub struct Runtime {
    pub session_homes: PathBuf,
    pub provider_homes: PathBuf,
    pub global_home: PathBuf,
}
impl Runtime {
    pub fn home(&self, logical: &str) -> Result<PathBuf> {
        let id = identity(
            logical,
            "logical Codex session id",
            "CODEX_SESSION_IDENTITY_INVALID",
        )?;
        Ok(self.session_homes.join(format!(
            "{}-{}",
            prefix(&id, true, "session"),
            fingerprint(&id, 20)
        )))
    }
    fn directory(path: &Path) -> Result<()> {
        real_private_dir(
            path,
            "CODEX_SESSION_HOME_INVALID",
            "Codex session home must be a real directory",
        )
    }
    fn matches(root: &Path, native: &str, count: &mut usize) -> Result<Vec<PathBuf>> {
        Ok(scan(
            root,
            &format!("-{native}.jsonl"),
            count,
            None,
            (
                "CODEX_SESSION_ROLLOUT_SCAN_LIMIT",
                "Codex legacy rollout scan limit exceeded",
            ),
        )?
        .into_iter()
        .map(|(p, _)| p)
        .collect())
    }
    fn ambiguous(native: &str, paths: Vec<PathBuf>) -> Failure {
        let mut e = Failure::new(
            "CODEX_SESSION_ROLLOUT_AMBIGUOUS",
            format!("Codex native session {native} has multiple rollout sources"),
        );
        e.sources = Some(paths);
        e
    }
    fn legacy_roots(&self) -> Vec<PathBuf> {
        let mut roots = vec![];
        let mut seen = HashSet::new();
        let mut append = |home: &Path| {
            let sessions = home.join("sessions");
            if fs::symlink_metadata(&sessions)
                .is_ok_and(|s| s.is_dir() && !s.file_type().is_symlink())
            {
                if let Ok(real) = fs::canonicalize(&sessions) {
                    if seen.insert(real) {
                        roots.push(sessions);
                    }
                }
            }
        };
        append(&self.global_home);
        let mut entries = fs::read_dir(&self.provider_homes)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .collect::<Vec<_>>();
        let locale: icu_locale_core::Locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
            .iter()
            .find_map(|k| std::env::var(k).ok().filter(|s| !s.is_empty()))
            .unwrap_or_default()
            .split(['.', '@'])
            .next()
            .unwrap_or("")
            .replace('_', "-")
            .parse()
            .unwrap_or(icu_locale_core::locale!("en-US"));
        if let Ok(sort) = icu_collator::Collator::try_new(locale.into(), Default::default()) {
            entries.sort_by(|a, b| {
                sort.compare(
                    &a.file_name().to_string_lossy(),
                    &b.file_name().to_string_lossy(),
                )
            });
        } else {
            entries.sort_by_key(|e| e.file_name());
        }
        for entry in entries {
            if entry
                .file_type()
                .is_ok_and(|t| t.is_dir() && !t.is_symlink())
            {
                append(&entry.path());
            }
        }
        roots
    }
    pub fn prepare(&self, logical: &str, native: &str, allow_missing: bool) -> Result<Value> {
        let logical = identity(
            logical,
            "logical Codex session id",
            "CODEX_SESSION_IDENTITY_INVALID",
        )?;
        let native = crate::js::js_trim(native);
        if !native.is_empty() {
            identity(
                native,
                "native Codex session id",
                "CODEX_SESSION_IDENTITY_INVALID",
            )?;
        }
        Self::directory(&self.session_homes)?;
        let home = self.home(&logical)?;
        Self::directory(&home)?;
        let sessions = home.join("sessions");
        Self::directory(&sessions)?;
        let mut out = json!({"home":path_value(&home),"sessionsDir":path_value(&sessions),"migratedFrom":null});
        if native.is_empty() {
            return Ok(out);
        }
        let mut count = 0;
        let canonical = Self::matches(&sessions, native, &mut count)?;
        if canonical.len() > 1 {
            return Err(Self::ambiguous(native, canonical));
        }
        if let Some(file) = canonical.first() {
            out["rollout"] = path_value(file);
            return Ok(out);
        }
        let mut legacy = vec![];
        for root in self.legacy_roots() {
            for file in Self::matches(&root, native, &mut count)? {
                legacy.push((root.clone(), file));
            }
        }
        if legacy.len() > 1 {
            return Err(Self::ambiguous(
                native,
                legacy.into_iter().map(|(_, p)| p).collect(),
            ));
        }
        let Some((root, source)) = legacy.first() else {
            if allow_missing {
                out["rollout"] = Value::Null;
                return Ok(out);
            }
            return Err(Failure::new(
                "CODEX_SESSION_ROLLOUT_NOT_FOUND",
                format!("Codex native session {native} rollout was not found"),
            ));
        };
        let dest = sessions.join(relative(root, source)?);
        copy(source, &dest, false)?;
        out["rollout"] = path_value(&dest);
        out["migratedFrom"] = path_value(source);
        Ok(out)
    }
    fn one(
        root: &Path,
        native: &str,
        count: &mut usize,
        label: &str,
        required: bool,
    ) -> Result<Option<PathBuf>> {
        let mut found = Self::matches(root, native, count)?;
        if found.len() > 1 {
            return Err(Self::ambiguous(native, found));
        }
        if found.is_empty() && required {
            return Err(Failure::new(
                "CODEX_SESSION_ROUTE_SOURCE_NOT_FOUND",
                format!("Codex {label} rollout {native} was not found"),
            ));
        }
        Ok(found.pop())
    }
    pub fn synchronize(&self, logical: &str, native: &str, from: bool, to: bool) -> Result<Value> {
        let logical = identity(
            logical,
            "logical Codex session id",
            "CODEX_SESSION_IDENTITY_INVALID",
        )?;
        let native = identity(
            native,
            "native Codex session id",
            "CODEX_SESSION_IDENTITY_INVALID",
        )?;
        if from == to {
            return if from {
                self.prepare(&logical, &native, false)
            } else {
                Ok(json!({"synchronized":false,"direction":"providerless"}))
            };
        }
        let canonical = self.prepare(&logical, if from { &native } else { "" }, false)?;
        let canonical = Path::new(canonical["sessionsDir"].as_str().unwrap());
        let global = self.global_home.join("sessions");
        Self::directory(&global)?;
        let (src_root, dst_root) = if from {
            (canonical, global.as_path())
        } else {
            (global.as_path(), canonical)
        };
        let mut count = 0;
        let source = Self::one(
            src_root,
            &native,
            &mut count,
            if from { "canonical" } else { "providerless" },
            true,
        )?
        .unwrap();
        let existing = Self::one(
            dst_root,
            &native,
            &mut count,
            if from {
                "providerless destination"
            } else {
                "canonical destination"
            },
            false,
        )?;
        let rel = relative(src_root, &source)?;
        let dest = existing.unwrap_or_else(|| dst_root.join(rel));
        copy(&source, &dest, true)?;
        Ok(
            json!({"synchronized":true,"direction":if from {"managed-to-providerless"}else{"providerless-to-managed"},"source":path_value(&source),"destination":path_value(&dest)}),
        )
    }
}
fn relative<'a>(root: &Path, file: &'a Path) -> Result<&'a Path> {
    let rel = file.strip_prefix(root).ok().filter(|p| {
        !p.as_os_str().is_empty() && !p.to_string_lossy().starts_with("..") && !p.is_absolute()
    });
    rel.ok_or_else(|| {
        Failure::new(
            "CODEX_SESSION_ROLLOUT_PATH_INVALID",
            "Codex rollout migration path escaped its sessions root",
        )
    })
}
fn file_version(path: &Path) -> Result<Version> {
    version(
        path,
        "CODEX_SESSION_ROLLOUT_PATH_INVALID",
        "Codex rollout must be a real file",
    )
}
fn copy(source: &Path, dest: &Path, replace: bool) -> Result<()> {
    Runtime::directory(dest.parent().unwrap())?;
    let before = if replace {
        Some(file_version(source)?)
    } else {
        None
    };
    let dst_before = if replace && dest.exists() {
        Some(file_version(dest)?)
    } else {
        None
    };
    let temp = PathBuf::from(format!(
        "{}.{}.{}.{}",
        dest.display(),
        if replace { "sync" } else { "migrate" },
        std::process::id(),
        random_hex(6)?
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options
            .open(&temp)
            .map_err(|e| io_error(e, "copyfile", &temp))?;
        let mut input = fs::File::open(source).map_err(|e| io_error(e, "copyfile", source))?;
        std::io::copy(&mut input, &mut output).map_err(|e| io_error(e, "copyfile", source))?;
        mode(&temp, 0o600)?;
        data_sync(&output, &temp)?;
        drop(output);
        if replace {
            if before.as_ref() != Some(&file_version(source)?) {
                return Err(Failure::new(
                    "CODEX_SESSION_ROUTE_SOURCE_CHANGED",
                    "Codex route source changed during synchronization",
                ));
            }
            let now = if dest.exists() {
                Some(file_version(dest)?)
            } else {
                None
            };
            if dst_before != now {
                return Err(Failure::new(
                    "CODEX_SESSION_ROUTE_DESTINATION_CHANGED",
                    "Codex route destination changed during synchronization",
                ));
            }
            fs::rename(&temp, dest).map_err(|e| io_error(e, "rename", &temp))?;
        } else {
            fs::hard_link(&temp, dest).map_err(|e| {
                let exists = e.kind() == std::io::ErrorKind::AlreadyExists;
                let cause = io_error(e, "link", dest);
                if exists {
                    Failure::wrap(
                        "CODEX_SESSION_ROLLOUT_RACE",
                        "Codex canonical rollout appeared during migration",
                        cause,
                    )
                } else {
                    cause
                }
            })?;
        }
        mode(dest, 0o600)?;
        sync_dir(dest.parent().unwrap())
    })();
    let _ = fs::remove_file(temp);
    result
}
