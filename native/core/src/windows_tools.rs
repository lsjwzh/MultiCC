//! Windows installer discovery. Called on a worker thread; never changes the
//! registry or the caller's environment and never launches an executable.
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, time::SystemTime};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    local_app_data: Option<String>,
    #[serde(default)]
    git_install_paths: Vec<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    codex: Option<String>,
    path_dirs: Vec<String>,
}

fn discover(input: Input) -> Discovery {
    let mut result = Discovery::default();
    for root in input.git_install_paths {
        for suffix in ["cmd", "bin"] {
            let dir = PathBuf::from(&root).join(suffix);
            if dir.join("git.exe").is_file() {
                result.path_dirs.push(dir.to_string_lossy().into_owned());
                break;
            }
        }
    }
    if let Some(local) = input.local_app_data {
        let root = PathBuf::from(local)
            .join("OpenAI")
            .join("Codex")
            .join("bin");
        let mut candidates = Vec::new();
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let version: Option<Vec<u64>> = name
                    .trim_start_matches('v')
                    .split('.')
                    .map(str::parse)
                    .collect::<Result<_, _>>()
                    .ok();
                let Some(version) = version.filter(|parts| parts.len() >= 2) else {
                    continue;
                };
                let exe = entry.path().join("codex.exe");
                if let Ok(metadata) = exe.metadata() {
                    if metadata.is_file() {
                        candidates.push((
                            version,
                            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                            exe,
                        ));
                    }
                }
            }
        }
        // Directory enumeration and install timestamps do not define versions.
        candidates.sort();
        if let Some((_, _, exe)) = candidates.pop() {
            result
                .path_dirs
                .push(exe.parent().unwrap().to_string_lossy().into_owned());
            result.codex = Some(exe.to_string_lossy().into_owned());
        }
    }
    result
}

pub fn scan(input: &str) -> Result<String, String> {
    let input =
        serde_json::from_str(input).map_err(|_| "invalid_windows_tools_input".to_string())?;
    serde_json::to_string(&discover(input)).map_err(|_| "windows_tools_encode_failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "multicc-tools-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn codex(&self, version: &str) -> PathBuf {
            let exe = self
                .0
                .join("OpenAI/Codex/bin")
                .join(version)
                .join("codex.exe");
            fs::create_dir_all(exe.parent().unwrap()).unwrap();
            fs::write(&exe, b"fixture").unwrap();
            exe
        }
        fn scan(&self) -> Discovery {
            discover(Input {
                local_app_data: Some(self.0.to_string_lossy().into_owned()),
                ..Input::default()
            })
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn discovers_install_upgrade_and_removal_without_a_path_change() {
        let fixture = Fixture::new();
        assert!(fixture.scan().codex.is_none());
        let old = fixture.codex("0.9.0");
        assert_eq!(
            fixture.scan().codex,
            Some(old.to_string_lossy().into_owned())
        );
        let new = fixture.codex("0.166.0");
        // A later write of an old version must not win over a newer version.
        fixture.codex("0.10.0");
        assert_eq!(
            fixture.scan().codex,
            Some(new.to_string_lossy().into_owned())
        );
        fs::remove_file(new).unwrap();
        assert!(fixture.scan().codex.unwrap().contains("0.10.0"));
    }

    #[test]
    fn ignores_incomplete_installs_and_non_version_directories() {
        let fixture = Fixture::new();
        fixture.codex("staging");
        fs::create_dir_all(fixture.0.join("OpenAI/Codex/bin/99.0/codex.exe")).unwrap();
        assert!(fixture.scan().codex.is_none());
    }

    #[test]
    fn discovers_git_from_custom_registry_install_paths() {
        let fixture = Fixture::new();
        let root = fixture.0.join("Custom Git");
        fs::create_dir_all(root.join("cmd")).unwrap();
        fs::write(root.join("cmd/git.exe"), b"fixture").unwrap();
        let found = discover(Input {
            git_install_paths: vec![root.to_string_lossy().into_owned()],
            ..Input::default()
        });
        assert_eq!(found.path_dirs, vec![root.join("cmd").to_string_lossy()]);
    }

    #[test]
    fn empty_or_missing_installs_are_safe() {
        assert_eq!(scan("{}").unwrap(), r#"{"codex":null,"pathDirs":[]}"#);
        assert!(scan("invalid").is_err());
    }
}
