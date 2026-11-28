use super::*;
use serde_json::{json, Value};
use std::{cmp::Ordering, collections::HashSet};
pub struct Roots {
    pub sessions: PathBuf,
    pub providers: PathBuf,
    pub global: PathBuf,
}
fn ambig(id: &str, files: Vec<PathBuf>) -> Error {
    Error {
        sources: files,
        ..Error::new(
            "CODEX_SESSION_ROLLOUT_AMBIGUOUS",
            format!("Codex native session {id} has multiple rollout sources"),
        )
    }
}
fn copy_rollout(
    source_root: &Path,
    source: &Path,
    target_root: &Path,
    target: &Path,
    replace: bool,
) -> Result<()> {
    let source = history_file::File::at(source_root, source, false)?;
    let target = history_file::File::at(target_root, target, true)?;
    let version = |file: &history_file::File| {
        file.version().map_err(|e| {
            if e.kind() == io::ErrorKind::InvalidInput {
                Error::new(
                    "CODEX_SESSION_ROLLOUT_PATH_INVALID",
                    "Codex rollout must be a real file",
                )
            } else {
                e.into()
            }
        })
    };
    let source_before = version(&source)?;
    let destination_before = version(&target)?;
    target.publish(
        replace,
        |out| {
            io::copy(&mut source.open()?, out)?;
            Ok(())
        },
        || {
            if version(&source)? != source_before {
                return Err(Error::new(
                    "CODEX_SESSION_ROUTE_SOURCE_CHANGED",
                    "Codex route source changed during synchronization",
                ));
            }
            if replace && version(&target)? != destination_before {
                return Err(Error::new(
                    "CODEX_SESSION_ROUTE_DESTINATION_CHANGED",
                    "Codex route destination changed during synchronization",
                ));
            }
            Ok(())
        },
    )
}
pub(super) fn tolerated(e: &io::Error, dir: bool) -> bool {
    #[cfg(unix)]
    {
        let n = e.raw_os_error();
        n == Some(libc::ENOTSUP)
            || n == Some(libc::EINVAL)
            || dir
                && [libc::EISDIR, libc::EBADF, libc::EPERM]
                    .into_iter()
                    .any(|c| n == Some(c))
    }
    #[cfg(not(unix))]
    {
        matches!(
            e.kind(),
            io::ErrorKind::Unsupported | io::ErrorKind::InvalidInput
        ) || dir && e.kind() == io::ErrorKind::PermissionDenied
    }
}
fn rel<'a>(source: &'a Path, root: &Path) -> Result<&'a Path> {
    source
        .strip_prefix(root)
        .ok()
        .filter(|p| !p.as_os_str().is_empty() && !p.to_string_lossy().starts_with(".."))
        .ok_or_else(|| {
            Error::new(
                "CODEX_SESSION_ROLLOUT_PATH_INVALID",
                "Codex rollout migration path escaped its sessions root",
            )
        })
}
impl Roots {
    pub fn home(&self, id: &str) -> PathBuf {
        self.sessions.join(format!(
            "{}-{}",
            prefix(id, true, "session"),
            fingerprint(id, 20)
        ))
    }
    fn legacy(
        &self,
        compare: &mut impl FnMut(&str, &str) -> Option<Ordering>,
    ) -> Result<Vec<PathBuf>> {
        let mut bases = vec![self.global.clone()];
        if let Ok(entries) = fs::read_dir(&self.providers) {
            let mut dirs: Vec<_> = entries
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|k| k.is_dir()))
                .collect();
            let mut failed = false;
            dirs.sort_by(|a, b| {
                if failed {
                    return Ordering::Equal;
                }
                compare(
                    &a.file_name().to_string_lossy(),
                    &b.file_name().to_string_lossy(),
                )
                .unwrap_or_else(|| {
                    failed = true;
                    Ordering::Equal
                })
            });
            if failed {
                return Err(Error::new("", "Codex provider directory comparison failed"));
            }
            bases.extend(dirs.into_iter().map(|e| e.path()));
        }
        let mut seen = HashSet::new();
        Ok(bases
            .into_iter()
            .map(|r| r.join("sessions"))
            .filter(|p| {
                fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
                    && p.canonicalize().is_ok_and(|p| seen.insert(p))
            })
            .collect())
    }
    pub fn prepare(
        &self,
        logical: &str,
        native: &str,
        missing: bool,
        compare: &mut impl FnMut(&str, &str) -> Option<Ordering>,
    ) -> Result<Value> {
        let home = self.home(logical);
        let sessions = home.join("sessions");
        for p in [&self.sessions, &home, &sessions] {
            checked_dir(
                p,
                "CODEX_SESSION_HOME_INVALID",
                "Codex session home must be a real directory",
            )?
        }
        let mut out = json!({"home":home,"sessionsDir":sessions,"migratedFrom":null});
        if native.is_empty() {
            return Ok(out);
        }
        let suffix = format!("-{native}.jsonl");
        let mut inspected = 0;
        let files = scan(&sessions, &suffix, &mut inspected, false)?;
        if files.len() > 1 {
            return Err(ambig(native, files));
        }
        if let Some(file) = files.first() {
            out["rollout"] = json!(file);
            return Ok(out);
        }
        let mut sources = vec![];
        for root in self.legacy(compare)? {
            for file in scan(&root, &suffix, &mut inspected, false)? {
                sources.push((file, root.clone()))
            }
        }
        if sources.len() > 1 {
            return Err(ambig(native, sources.into_iter().map(|(f, _)| f).collect()));
        }
        let Some((file, root)) = sources.pop() else {
            if missing {
                out["rollout"] = Value::Null;
                return Ok(out);
            }
            return Err(Error::new(
                "CODEX_SESSION_ROLLOUT_NOT_FOUND",
                format!("Codex native session {native} rollout was not found"),
            ));
        };
        let dst = sessions.join(rel(&file, &root)?);
        copy_rollout(&root, &file, &sessions, &dst, false)?;
        out["rollout"] = json!(dst);
        out["migratedFrom"] = json!(file);
        Ok(out)
    }
    pub fn sync(
        &self,
        logical: &str,
        id: &str,
        from: bool,
        to: bool,
        compare: &mut impl FnMut(&str, &str) -> Option<Ordering>,
    ) -> Result<Value> {
        if from == to {
            return if from {
                self.prepare(logical, id, false, compare)
            } else {
                Ok(json!({"synchronized":false,"direction":"providerless"}))
            };
        }
        self.prepare(logical, if from { id } else { "" }, false, compare)?;
        let canonical = self.home(logical).join("sessions");
        let global = self.global.join("sessions");
        checked_dir(
            &global,
            "CODEX_SESSION_HOME_INVALID",
            "Codex session home must be a real directory",
        )?;
        let (a, b, label, direction) = if from {
            (canonical, global, "canonical", "managed-to-providerless")
        } else {
            (global, canonical, "providerless", "providerless-to-managed")
        };
        let mut count = 0;
        let mut find = |dir: &Path| -> Result<Option<PathBuf>> {
            let mut found = scan(dir, &format!("-{id}.jsonl"), &mut count, false)?;
            if found.len() > 1 {
                Err(ambig(id, found))
            } else {
                Ok(found.pop())
            }
        };
        let file = find(&a)?.ok_or_else(|| {
            Error::new(
                "CODEX_SESSION_ROUTE_SOURCE_NOT_FOUND",
                format!("Codex {label} rollout {id} was not found"),
            )
        })?;
        let target = find(&b)?.unwrap_or(b.join(rel(&file, &a)?));
        copy_rollout(&a, &file, &b, &target, true)?;
        Ok(json!({"synchronized":true,"source":file,"destination":target,"direction":direction}))
    }
}
