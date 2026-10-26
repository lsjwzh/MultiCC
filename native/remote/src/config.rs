//! 进程配置与就绪行（docs/remote-screen-process.md §1）。
//!
//! stdin 第一行是一个 JSON 配置，之后 stdin 保持打开：Node 退出或崩溃时
//! 管道读到 EOF，进程要在一秒内自己退掉，不能留孤儿。

use crate::error::{AppError, AppResult};
use serde_json::json;
use std::path::PathBuf;

/// 协议版本。就绪行与 `--version` 的第二段都是它。
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug)]
pub struct Config {
    /// 冻结截图目录（随数据根隔离，由 assist-snapshots 的 7 天清理兜底）。
    pub dir: PathBuf,
}

pub fn parse_config_line(line: &str) -> AppResult<Config> {
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|_| AppError::new(2, "config-line-not-json"))?;
    if value.get("v").and_then(|v| v.as_u64()) != Some(PROTOCOL_VERSION as u64) {
        return Err(AppError::new(2, "config-bad-version"));
    }
    let dir = value
        .get("dir")
        .and_then(|d| d.as_str())
        .filter(|d| !d.is_empty())
        .ok_or_else(|| AppError::new(2, "config-missing-dir"))?;
    Ok(Config { dir: PathBuf::from(dir) })
}

/// 经 stdin 交给 Node 的一行就绪 JSON。
pub fn ready_line(port: u16, secret: &str) -> String {
    json!({ "ready": true, "v": PROTOCOL_VERSION, "port": port, "secret": secret }).to_string()
}

pub fn version_line() -> String {
    format!("multicc-remote {} {}", PROTOCOL_VERSION, env!("CARGO_PKG_VERSION"))
}

/// secret 每次启动随机生成、不经 argv 和环境变量：32 字节 → 64 位十六进制。
pub fn random_secret() -> String {
    random_hex(32)
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    // 系统熵源拿不到就没什么可做的了：宁可起不来，也不能用一个可预测的 secret。
    getrandom::getrandom(&mut buf).expect("getrandom");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_is_64_hex_chars() {
        let s = random_secret();
        assert_eq!(s.len(), 64);
        assert!(s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn config_line_requires_v1_and_dir() {
        assert_eq!(parse_config_line("{\"v\":1,\"dir\":\"/tmp/x\"}").unwrap().dir, PathBuf::from("/tmp/x"));
        assert!(parse_config_line("{\"v\":2,\"dir\":\"/tmp/x\"}").is_err());
        assert!(parse_config_line("{\"v\":1}").is_err());
        assert!(parse_config_line("not json").is_err());
    }

    #[test]
    fn version_line_carries_protocol_and_crate_version() {
        assert_eq!(version_line(), format!("multicc-remote 1 {}", env!("CARGO_PKG_VERSION")));
    }
}
