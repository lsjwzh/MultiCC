use std::{path::Path, process::Command};

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|_| "无法读取 Git 提交历史".to_owned())?;
    if !output.status.success() {
        return Err("无法读取 Git 提交历史".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "Git 提交历史不是有效的 UTF-8".into())
}

/// Count remote history separately so an automatic rebase can preserve it.
pub fn count_range(cwd: &Path, range: &str) -> Result<(usize, usize), String> {
    let count = |args: &[&str]| -> Result<usize, String> {
        git(cwd, args)?
            .trim()
            .parse()
            .map_err(|_| "无法统计 Git 提交历史".into())
    };
    let checked = count(&["rev-list", "--count", "--end-of-options", range])?;
    let default_ref = Command::new("git")
        .current_dir(cwd)
        .args(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| s.starts_with("refs/remotes/origin/"));
    let candidates = default_ref.into_iter().chain([
        "refs/remotes/origin/main".to_owned(),
        "refs/remotes/origin/master".to_owned(),
    ]);
    let trusted = candidates.into_iter().find_map(|reference| {
        let output = Command::new("git")
            .current_dir(cwd)
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{reference}^{{commit}}"),
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let oid = String::from_utf8(output.stdout).ok()?.trim().to_owned();
        (!oid.is_empty() && oid.bytes().all(|b| b.is_ascii_hexdigit())).then_some(oid)
    });
    let local_checked = if let Some(oid) = trusted {
        count(&[
            "rev-list",
            "--count",
            "--end-of-options",
            range,
            &format!("^{oid}"),
        ])?
    } else {
        checked
    };
    Ok((checked, local_checked))
}
