//! MultiCC 托管版 Mutagen 运行时解析与官方 Release 下载元信息（CLI 无关，供 agy / Claude 等远程 VPS 车道共用）。
//!
//! 约定：
//! - 托管安装目录：`<home>/.multicc/bin/mutagen/`
//!   - 主二进制：`mutagen`（Windows 为 `mutagen.exe`）
//!   - 配套远端代理包：`mutagen-agents.tar.gz`（Mutagen 强制要求与主程序同目录）
//! - 查找优先级：`MULTICC_MUTAGEN_BIN` 环境变量 → 托管版 `~/.multicc/bin/mutagen/mutagen` → 系统 `PATH` 中的 `mutagen`。
//! - 不随 MultiCC 安装包分发 Mutagen 二进制（规避 ~97MB 体积膨胀与 SSPL 随包分发风险），改为按需下载。

use std::path::{Path, PathBuf};

pub const MUTAGEN_VERSION: &str = "v0.18.1";
pub const MUTAGEN_RELEASE_BASE: &str =
    "https://github.com/mutagen-io/mutagen/releases/download/v0.18.1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutagenReleaseAsset {
    pub version: &'static str,
    pub filename: &'static str,
    pub is_zip: bool,
}

impl MutagenReleaseAsset {
    pub fn download_url(&self, base_override: Option<&str>) -> String {
        let base = base_override
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(MUTAGEN_RELEASE_BASE)
            .trim_end_matches('/');
        format!("{base}/{}", self.filename)
    }
}

/// 根据目标操作系统和 CPU 架构返回 Mutagen 官方 Release 资产名。
pub fn release_asset_for(os: &str, arch: &str) -> Result<MutagenReleaseAsset, String> {
    let (filename, is_zip) = match (os, arch) {
        ("macos", "aarch64") => ("mutagen_darwin_arm64_v0.18.1.tar.gz", false),
        ("macos", "x86_64") => ("mutagen_darwin_amd64_v0.18.1.tar.gz", false),
        ("linux", "x86_64") => ("mutagen_linux_amd64_v0.18.1.tar.gz", false),
        ("linux", "aarch64") => ("mutagen_linux_arm64_v0.18.1.tar.gz", false),
        ("windows", "x86_64") => ("mutagen_windows_amd64_v0.18.1.zip", true),
        ("windows", "aarch64") => ("mutagen_windows_arm64_v0.18.1.zip", true),
        _ => {
            return Err(format!(
                "暂不支持自动下载 Mutagen 的平台：{os}/{arch}，请手动安装 mutagen 并加入 PATH"
            ))
        }
    };
    Ok(MutagenReleaseAsset {
        version: MUTAGEN_VERSION,
        filename,
        is_zip,
    })
}

pub fn executable_name(is_windows: bool) -> &'static str {
    if is_windows {
        "mutagen.exe"
    } else {
        "mutagen"
    }
}

/// `<home>/.multicc/bin/mutagen`
pub fn managed_mutagen_dir(home: &Path) -> PathBuf {
    home.join(".multicc").join("bin").join("mutagen")
}

/// `<home>/.multicc/bin/mutagen/mutagen(.exe)`
pub fn managed_mutagen_bin(home: &Path) -> PathBuf {
    managed_mutagen_dir(home).join(executable_name(cfg!(windows)))
}

/// `<home>/.multicc/bin/mutagen/mutagen-agents.tar.gz`
pub fn managed_mutagen_agents(home: &Path) -> PathBuf {
    managed_mutagen_dir(home).join("mutagen-agents.tar.gz")
}

/// 托管目录中主程序与 `mutagen-agents.tar.gz` 均齐备时才视为托管安装完整。
pub fn has_complete_managed_install(home: &Path) -> bool {
    managed_mutagen_bin(home).is_file() && managed_mutagen_agents(home).is_file()
}

/// 按优先级解析本机应调用的 `mutagen` 路径：
/// 1. `MULTICC_MUTAGEN_BIN` 显式覆盖；
/// 2. `<home>/.multicc/bin/mutagen/mutagen(.exe)`（需同时存在 `mutagen-agents.tar.gz`）；
/// 3. 回退到系统 `PATH` 中的 `"mutagen"`。
pub fn resolve_mutagen_bin_with_env(env_override: Option<&str>, home: Option<&Path>) -> String {
    if let Some(bin) = env_override.map(str::trim).filter(|s| !s.is_empty()) {
        return bin.to_string();
    }
    if let Some(h) = home {
        if has_complete_managed_install(h) {
            return managed_mutagen_bin(h).to_string_lossy().into_owned();
        }
    }
    executable_name(cfg!(windows)).to_string()
}

pub fn resolve_mutagen_bin(home: Option<&Path>) -> String {
    let env_override = std::env::var("MULTICC_MUTAGEN_BIN").ok();
    resolve_mutagen_bin_with_env(env_override.as_deref(), home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn release_assets_map_supported_platforms_and_reject_unknown() {
        let mac = release_asset_for("macos", "aarch64").unwrap();
        assert_eq!(mac.filename, "mutagen_darwin_arm64_v0.18.1.tar.gz");
        assert!(!mac.is_zip);
        assert_eq!(
            mac.download_url(None),
            "https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/mutagen_darwin_arm64_v0.18.1.tar.gz"
        );
        assert_eq!(
            mac.download_url(Some("http://127.0.0.1:9999/")),
            "http://127.0.0.1:9999/mutagen_darwin_arm64_v0.18.1.tar.gz"
        );

        let win = release_asset_for("windows", "x86_64").unwrap();
        assert!(win.is_zip);
        assert_eq!(win.filename, "mutagen_windows_amd64_v0.18.1.zip");

        assert!(release_asset_for("freebsd", "riscv64").is_err());
    }

    #[test]
    fn resolve_mutagen_bin_prefers_env_then_complete_managed_then_path() {
        let dir = std::env::temp_dir().join(format!(
            "multicc-mutagen-rt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(managed_mutagen_dir(&dir)).unwrap();

        // Missing both files -> falls back to PATH binary name
        assert_eq!(
            resolve_mutagen_bin_with_env(None, Some(&dir)),
            executable_name(cfg!(windows))
        );

        // Only binary without agents bundle -> still falls back
        fs::write(managed_mutagen_bin(&dir), b"bin").unwrap();
        assert_eq!(
            resolve_mutagen_bin_with_env(None, Some(&dir)),
            executable_name(cfg!(windows))
        );

        // Complete install -> picks managed binary
        fs::write(managed_mutagen_agents(&dir), b"agents").unwrap();
        assert_eq!(
            resolve_mutagen_bin_with_env(None, Some(&dir)),
            managed_mutagen_bin(&dir).to_string_lossy()
        );

        // Explicit env override always wins
        assert_eq!(
            resolve_mutagen_bin_with_env(Some("/custom/mutagen"), Some(&dir)),
            "/custom/mutagen"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
