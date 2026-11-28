//! agy 1.5.18 的 help 和官方 Headless mode 协议约定（1.1.15 起支持）。
//! https://antigravity.google/docs/cli/headless#stream-prompts-from-stdin
//! stdin 每行一个 user 消息，同一会话只有一次 init，每轮以 result 结束。
//! result.usage 是会话累计值。模型、强度和恢复 ID 是启动选项。
//! 协议没有承诺单轮中断，宿主取消时关闭进程，下一轮用已捕获的 ID 恢复。
//! 本机只实测到资格检查错误的 result，成功路径由模拟 CLI 覆盖。
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};

pub fn user_line(prompt: &str) -> String {
    format!("{}\n", json!({"event":"user","message":{"content":prompt}}))
}

pub fn advertises_input(help: &str) -> bool {
    help.lines().any(|line| {
        let line = line.trim_start();
        line.split_whitespace().next() == Some("--input-format") && line.contains("stream-json")
    })
}

/// 只比较实际启动配置。恢复 ID 由宿主单独检查，prompt 从未进入配置或进程列表。
pub fn base_args(args: &[String]) -> Vec<String> {
    let mut args = args.iter();
    let mut out = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--conversation" => {
                args.next();
            }
            "-p" => break,
            _ => out.push(arg.clone()),
        }
    }
    out
}

pub fn config_key(
    args: &[String],
    cwd: &str,
    env: &BTreeMap<String, String>,
    selection: &[String],
) -> std::io::Result<String> {
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(&(args, cwd, env, selection))?);
    if let Some(home) = env.get("HOME").or_else(|| env.get("USERPROFILE")) {
        match fs::read(Path::new(home).join(".gemini/config/mcp_config.json")) {
            Ok(bytes) => {
                hash.update([1]);
                hash.update(bytes);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    #[test]
    fn 投递和配置失效() {
        let message = "第一行\n引号\"";
        let line = user_line(message);
        assert_eq!(line.lines().count(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap()["message"]["content"],
            message
        );
        let base = ["--model", "m", "--conversation", "c", "-p"].map(String::from);
        assert_eq!(base_args(&base), ["--model", "m"]);
        let mut env = BTreeMap::new();
        let key = config_key(&base, ".", &env, &[]).unwrap();
        assert_ne!(key, config_key(&base, "..", &env, &[]).unwrap());
        assert_ne!(
            key,
            config_key(&base, ".", &env, &["另一个账号".into()]).unwrap()
        );
        env.insert("MULTICC_DIR_ID".into(), "另一个目录".into());
        assert_ne!(key, config_key(&base, ".", &env, &[]).unwrap());
    }
    #[test]
    fn 帮助探测不会混淆输入和输出() {
        assert!(advertises_input(
            "  --input-format   format (text, stream-json)"
        ));
        assert!(!advertises_input("--output-format stream-json"));
        assert!(!advertises_input("--input-format text"));
    }
}
