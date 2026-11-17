use multicc_core::publication::{release_notes, validate_english};
use multicc_core::publication_identity::{
    repository_policy, validate_range, validate_records, LOG_FORMAT,
};
use std::path::Path;
use std::{env, fs, process::Command};

fn git(args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .output()
        .map_err(|_| "无法运行 Git".to_owned())?;
    if !output.status.success() {
        return Err("Git 历史读取失败，无法完成英文校验".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "Git 消息不是有效的 UTF-8".into())
}

fn check_range(base: &str, head: &str) -> Result<(), String> {
    let range = format!("{base}..{head}");
    let policy = repository_policy(Path::new("."))?;
    let (checked, local) = validate_range(Path::new("."), &range, policy.as_ref())?;
    println!("已校验 {checked} 条提交消息及 {local} 条本机提交身份");
    Ok(())
}

fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("commit-message") if args.len() == 2 => {
            let text = fs::read_to_string(&args[1]).map_err(|_| "无法读取提交消息文件")?;
            validate_english("commit", &text)?;
            println!("提交消息已通过英文字符校验");
        }
        Some("commit-range") if args.len() == 3 => check_range(&args[1], &args[2])?,
        Some("ci-commits") if args.len() == 1 => {
            let head = env::var("CI_POLICY_HEAD").unwrap_or_else(|_| "HEAD".into());
            let mut base = env::var("CI_POLICY_BASE").unwrap_or_default();
            if base.is_empty() || base.bytes().all(|b| b == b'0') {
                let branch = env::var("CI_POLICY_DEFAULT_BRANCH").unwrap_or_else(|_| "main".into());
                base = git(&["merge-base", &head, &format!("origin/{branch}")])?.trim().into();
                // A first push of the default branch has no before SHA. Check
                // the tip rather than retroactively rejecting legacy history.
                if git(&["rev-parse", &head])?.trim() == base {
                    let log = git(&["log", "-1", LOG_FORMAT, &head])?;
                    validate_records(&log, None)?;
                    println!("当前提交已通过英文消息校验");
                    return Ok(());
                }
            }
            let range = format!("{base}..{head}");
            let log = git(&["log", LOG_FORMAT, "--end-of-options", &range])?;
            let checked = validate_records(&log, None)?;
            println!("已校验 {checked} 条提交消息；本机提交身份由本机提交入口校验");
        }
        Some("release-notes") if args.len() == 4 => {
            let changelog = fs::read_to_string(&args[2]).map_err(|_| "无法读取 CHANGELOG.md")?;
            let notes = release_notes(&changelog, &args[1])?;
            fs::write(&args[3], notes).map_err(|_| "无法写入发布说明文件")?;
            println!("已提取并校验当前版本的英文发布说明");
        }
        _ => return Err("用法：publication-policy commit-message 文件 | commit-range 基准 提交 | ci-commits | release-notes 版本 CHANGELOG.md 输出文件".into()),
    }
    Ok(())
}

fn main() {
    if let Err(error) = run(&env::args().skip(1).collect::<Vec<_>>()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
