use crate::publication::validate_english;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path, process::Command};

pub const LOG_FORMAT: &str = "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Identity {
    pub name: String,
    pub email: String,
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|_| "无法读取 Git 提交身份配置".to_owned())?;
    if !output.status.success() {
        return Err("无法读取 Git 提交身份配置，请设置 user.name 和 user.email".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "Git 身份配置不是有效的 UTF-8".into())
}

// Used when the user never configured an identity. Asking a first-time user to
// run `git config --global user.name …` before MultiCC can create a single
// worktree is a chore with no upside: these commits live in their own
// repositories, and a configured identity (or commit-policy.json) always wins.
pub const FALLBACK_NAME: &str = "multicc";
pub const FALLBACK_EMAIL: &str = "multicc@local";

// `git config --get` exits 1 for "not set" — the one case that falls back. Any
// other failure (a corrupt config file, git not runnable) stays an error, since
// silently committing as someone else would hide it.
fn git_config(cwd: &Path, key: &str, env: &[(&str, &Path)]) -> Result<Option<String>, String> {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(["config", "--get", key])
        .envs(env.iter().copied())
        .output()
        .map_err(|_| "无法读取 Git 提交身份配置".to_owned())?;
    match output.status.code() {
        Some(0) => {
            let value = String::from_utf8(output.stdout)
                .map_err(|_| "Git 身份配置不是有效的 UTF-8".to_owned())?;
            let value = value.trim();
            Ok((!value.is_empty()).then(|| value.to_owned()))
        }
        Some(1) => Ok(None),
        _ => Err("无法读取 Git 提交身份配置，请检查 Git 配置文件".into()),
    }
}

fn with_fallback(name: Option<String>, email: Option<String>) -> Identity {
    Identity {
        name: name.unwrap_or_else(|| FALLBACK_NAME.into()),
        email: email.unwrap_or_else(|| FALLBACK_EMAIL.into()),
    }
}

fn validate(identity: Identity) -> Result<Identity, String> {
    if identity.name.trim().is_empty()
        || identity.email.trim().is_empty()
        || [&identity.name, &identity.email]
            .iter()
            .any(|s| s.chars().any(|c| c.is_control() || "<>".contains(c)))
        || !identity.email.contains('@')
    {
        return Err("Git 提交身份配置无效，请设置有效的姓名与邮箱".into());
    }
    Ok(identity)
}

pub fn repository_policy(cwd: &Path) -> Result<Option<Identity>, String> {
    let root = git(cwd, &["rev-parse", "--show-toplevel"])?;
    let file = Path::new(root.trim()).join("commit-policy.json");
    match fs::read(file) {
        Ok(bytes) => {
            if bytes.len() > 16 * 1024 {
                return Err("commit-policy.json 超过大小限制".into());
            }
            let identity: Identity =
                serde_json::from_slice(&bytes).map_err(|_| "commit-policy.json 格式无效")?;
            Ok(Some(validate(identity)?))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("无法读取 commit-policy.json".into()),
    }
}

pub fn configured_identity(cwd: &Path) -> Result<Identity, String> {
    if let Some(identity) = repository_policy(cwd)? {
        return Ok(identity);
    }
    config_identity(cwd, &[])
}

fn config_identity(cwd: &Path, env: &[(&str, &Path)]) -> Result<Identity, String> {
    validate(with_fallback(
        git_config(cwd, "user.name", env)?,
        git_config(cwd, "user.email", env)?,
    ))
}

fn creates_commit(args: &[String]) -> bool {
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if matches!(
            arg,
            "-c" | "-C" | "--git-dir" | "--work-tree" | "--config-env"
        ) {
            i += 2;
            continue;
        }
        if arg.starts_with('-') {
            i += 1;
            continue;
        }
        return matches!(arg, "commit" | "merge" | "cherry-pick" | "rebase")
            && !args[i + 1..]
                .iter()
                .any(|a| matches!(a.as_str(), "--abort" | "--quit" | "--ff-only"));
    }
    false
}

pub fn command_environment(
    cwd: &Path,
    args: &[String],
) -> Result<BTreeMap<String, String>, String> {
    if !creates_commit(args) {
        return Ok(BTreeMap::new());
    }
    let identity = configured_identity(cwd)?;
    Ok(BTreeMap::from([
        ("GIT_AUTHOR_NAME".into(), identity.name.clone()),
        ("GIT_AUTHOR_EMAIL".into(), identity.email.clone()),
        ("GIT_COMMITTER_NAME".into(), identity.name),
        ("GIT_COMMITTER_EMAIL".into(), identity.email),
    ]))
}

pub fn validate_records(log: &str, policy: Option<&Identity>) -> Result<usize, String> {
    let mut fields = log.split('\0');
    let mut checked = 0;
    while let Some(hash) = fields.next() {
        let hash = hash.trim();
        if hash.is_empty() {
            continue;
        }
        let mut next = || fields.next().ok_or("提交记录格式无效".to_owned());
        let author_name = next()?;
        let author_email = next()?;
        let committer_name = next()?;
        let committer_email = next()?;
        let message = next()?;
        validate_english("commit", message).map_err(|e| format!("提交 {hash}：{e}"))?;
        if let Some(expected) = policy {
            if author_name != expected.name
                || author_email != expected.email
                || committer_name != expected.name
                || committer_email != expected.email
            {
                return Err(format!(
                    "提交 {hash} 的作者与提交者必须统一为 {} <{}>，请修正新增提交身份后重试",
                    expected.name, expected.email
                ));
            }
        }
        checked += 1;
    }
    Ok(checked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_identity_validates_author_and_committer_separately() {
        let expected = Identity {
            name: "account".into(),
            email: "account@example.invalid".into(),
        };
        let valid = "hash\0account\0account@example.invalid\0account\0account@example.invalid\0fix: restore delivery\0\n";
        assert_eq!(validate_records(valid, Some(&expected)).unwrap(), 1);
        assert!(
            validate_records(&valid.replacen("account\0", "bot\0", 1), Some(&expected)).is_err()
        );
        assert!(validate_records(
            &valid.replace("account@example.invalid\0fix", "bot@local\0fix"),
            Some(&expected)
        )
        .is_err());
        assert!(validate_records("hash\0account\0", Some(&expected)).is_err());
    }

    #[test]
    fn publication_identity_falls_back_per_field_when_unset() {
        assert_eq!(
            with_fallback(None, None),
            Identity { name: "multicc".into(), email: "multicc@local".into() }
        );
        assert_eq!(
            with_fallback(Some("Ada".into()), None),
            Identity { name: "Ada".into(), email: "multicc@local".into() }
        );
        assert!(validate(with_fallback(None, None)).is_ok());
    }

    #[test]
    fn publication_identity_unset_config_commits_as_multicc() {
        let dir = std::env::temp_dir().join(format!("multicc-identity-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let empty = dir.join("empty-gitconfig");
        fs::write(&empty, "").unwrap();
        // Isolated from the developer's own ~/.gitconfig and /etc/gitconfig.
        let isolated: [(&str, &Path); 2] = [
            ("GIT_CONFIG_GLOBAL", &empty),
            ("GIT_CONFIG_SYSTEM", &empty),
        ];
        let run = |args: &[&str]| {
            Command::new("git")
                .current_dir(&dir)
                .args(args)
                .envs(isolated.iter().copied())
                .output()
                .unwrap()
        };
        assert!(run(&["init", "-q"]).status.success());
        let unset = config_identity(&dir, &isolated);
        assert!(run(&["config", "user.name", "Ada"]).status.success());
        let partial = config_identity(&dir, &isolated);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(unset.unwrap(), with_fallback(None, None));
        assert_eq!(partial.unwrap(), with_fallback(Some("Ada".into()), None));
    }

    #[test]
    fn publication_identity_keeps_read_and_recovery_commands_available() {
        for args in [
            vec!["status"],
            vec!["merge", "--abort"],
            vec!["merge", "--ff-only", "main"],
            vec!["rebase", "--quit"],
        ] {
            assert!(!creates_commit(
                &args.into_iter().map(String::from).collect::<Vec<_>>()
            ));
        }
        for args in [
            vec!["commit", "-m", "fix: restore delivery"],
            vec!["-c", "user.name=bot", "merge", "topic"],
            vec!["rebase", "--continue"],
        ] {
            assert!(creates_commit(
                &args.into_iter().map(String::from).collect::<Vec<_>>()
            ));
        }
    }
}
