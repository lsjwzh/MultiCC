//! 统一的本机 CLI 可执行文件解析器（`agy` / `claude` / `codex`）。
//!
//! 当 MultiCC 桌面端由 macOS Finder / Dock / Spotlight 或 launchd 拉起时，
//! 进程继承到的 `PATH` 通常只有 `runtime/bin:/usr/bin:/bin:/usr/sbin:/sbin`，
//! 不含 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 等用户安装目录。
//! Node 兼容层（`src/cli-adapters/commands.js`）会显式探测这些常见目录，
//! 本模块让 Rust 网关的所有本地子进程拉起（OAuth 登录、额度/模型查询、WSS 借道、
//! 出口包装执行与原生聊天）保持同一套优先级与回退策略，不再因裁剪后的 `PATH` 报 `ENOENT`。

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// 判断路径是否为可执行文件（跟随符号链接）。
pub fn is_runnable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()))
        .map(PathBuf::from)
}

fn non_empty_trimmed_env(keys: &[&str]) -> Option<OsString> {
    for key in keys {
        let Some(raw) = std::env::var_os(key) else {
            continue;
        };
        if let Some(text) = raw.to_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(OsString::from(trimmed));
            }
        } else if !raw.is_empty() {
            return Some(raw);
        }
    }
    None
}

#[cfg(windows)]
fn candidate_names_for_path(binary_name: &str, pathext: Option<&OsStr>) -> Vec<String> {
    const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";
    let raw = pathext
        .and_then(|v| v.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_PATHEXT);
    let exts: Vec<String> = raw
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.starts_with('.') {
                s.to_string()
            } else {
                format!(".{s}")
            }
        })
        .collect();
    let lower = binary_name.to_ascii_lowercase();
    if exts
        .iter()
        .any(|ext| lower.ends_with(&ext.to_ascii_lowercase()))
    {
        return vec![binary_name.to_string()];
    }
    let mut names = Vec::with_capacity(exts.len() + 1);
    for ext in exts {
        let candidate = format!("{binary_name}{ext}");
        if !names
            .iter()
            .any(|item: &String| item.eq_ignore_ascii_case(&candidate))
        {
            names.push(candidate);
        }
    }
    if names.is_empty() {
        names.push(binary_name.to_string());
    }
    names
}

#[cfg(not(windows))]
fn candidate_names_for_path(binary_name: &str, _pathext: Option<&OsStr>) -> Vec<String> {
    vec![binary_name.to_string()]
}

fn find_on_path(
    binary_name: &str,
    path_var: Option<&OsStr>,
    pathext: Option<&OsStr>,
) -> Option<PathBuf> {
    let paths = path_var?;
    let names = candidate_names_for_path(binary_name, pathext);
    for dir in std::env::split_paths(paths) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in &names {
            let candidate = dir.join(name);
            if is_runnable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn binary_with_exe_suffix(stem: &str) -> String {
    format!("{stem}{}", std::env::consts::EXE_SUFFIX)
}

fn resolve_with(
    stem: &str,
    explicit_override: Option<OsString>,
    home: Option<&Path>,
    user_rel_dirs: &[&str],
    path_var: Option<&OsStr>,
    pathext: Option<&OsStr>,
    system_dirs: &[&Path],
) -> OsString {
    if let Some(explicit) = explicit_override {
        return explicit;
    }
    let binary = binary_with_exe_suffix(stem);
    let names = candidate_names_for_path(stem, pathext);

    // 1. 用户级安装目录（如 ~/.local/bin）最优先，确保与官方安装脚本和
    //    src/cli-adapters/commands.js 顺序一致，不被旧版 Homebrew 副本遮蔽。
    if let Some(home_dir) = home {
        for rel in user_rel_dirs {
            let dir = home_dir.join(rel);
            for name in &names {
                let candidate = dir.join(name);
                if is_runnable_file(&candidate) {
                    return candidate.into_os_string();
                }
            }
        }
    }

    // 2. 当前进程 PATH（兼容终端自定义的 nvm/mise/nix/测试夹具路径）。
    if let Some(hit) = find_on_path(stem, path_var, pathext) {
        return hit.into_os_string();
    }

    // 3. 系统常见安装目录兜底（Finder / Electron / launchd 裁剪 PATH 后的回退）。
    for dir in system_dirs {
        for name in &names {
            let candidate = dir.join(name);
            if is_runnable_file(&candidate) {
                return candidate.into_os_string();
            }
        }
    }

    OsString::from(binary)
}

fn non_windows_system_dirs(dirs: &'static [&'static str]) -> Vec<&'static Path> {
    if cfg!(windows) {
        Vec::new()
    } else {
        dirs.iter().map(Path::new).collect()
    }
}

fn agy_extra_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(windows)]
    {
        if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
            dirs.push(PathBuf::from(home).join(".local/bin"));
        }
        if let Some(profile) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
            let candidate = PathBuf::from(profile).join(".local/bin");
            if !dirs.contains(&candidate) {
                dirs.push(candidate);
            }
        }
        if let Some(local_app) = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()) {
            dirs.push(PathBuf::from(local_app).join("agy/bin"));
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = user_home_dir() {
            dirs.push(home.join(".local/bin"));
        }
    }
    dirs
}

fn find_in_dirs(stem: &str, dirs: &[PathBuf], pathext: Option<&OsStr>) -> Option<PathBuf> {
    let names = candidate_names_for_path(stem, pathext);
    for dir in dirs {
        for name in &names {
            let candidate = dir.join(name);
            if is_runnable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_explicit_runnable(
    cmd: &OsStr,
    path_var: Option<&OsStr>,
    pathext: Option<&OsStr>,
) -> Option<PathBuf> {
    let cmd_path = Path::new(cmd);
    if cmd_path.components().count() > 1 {
        if is_runnable_file(cmd_path) {
            return Some(cmd_path.to_path_buf());
        }
        #[cfg(windows)]
        {
            if let Some(text) = cmd.to_str() {
                for name in candidate_names_for_path(text, pathext) {
                    let candidate = PathBuf::from(&name);
                    if is_runnable_file(&candidate) {
                        return Some(candidate);
                    }
                }
            }
        }
        return None;
    }
    let name = cmd.to_str()?;
    find_on_path(name, path_var, pathext)
}

/// 实时探测本机已安装且可执行的 `agy` 二进制路径（不缓存，安装后立即生效）。
///
/// 优先级：`MULTICC_AGY_BIN` > `AGY_CMD` > `$HOME/.local/bin`（Windows 含
/// `%USERPROFILE%\.local\bin` 与 `%LOCALAPPDATA%\agy\bin`）> `PATH` >
/// `/opt/homebrew/bin` > `/usr/local/bin`。
pub fn detect_local_agy() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH");
    let pathext = std::env::var_os("PATHEXT");
    if let Some(cmd) = non_empty_trimmed_env(&["MULTICC_AGY_BIN", "AGY_CMD"]) {
        return resolve_explicit_runnable(&cmd, path_var.as_deref(), pathext.as_deref());
    }
    let user_dirs = agy_extra_dirs();
    if let Some(hit) = find_in_dirs("agy", &user_dirs, pathext.as_deref()) {
        return Some(hit);
    }
    if let Some(hit) = find_on_path("agy", path_var.as_deref(), pathext.as_deref()) {
        return Some(hit);
    }
    let system_dirs: Vec<PathBuf> =
        non_windows_system_dirs(&["/opt/homebrew/bin", "/usr/local/bin"])
            .into_iter()
            .map(Path::to_path_buf)
            .collect();
    find_in_dirs("agy", &system_dirs, pathext.as_deref())
}

/// 解析本机 `agy` 可执行文件路径。
///
/// 优先级：`MULTICC_AGY_BIN` > `AGY_CMD` > `~/.local/bin` > `PATH` >
/// `/opt/homebrew/bin` > `/usr/local/bin` > 裸命令 `"agy"`。
pub fn resolve_agy_bin() -> OsString {
    if let Some(explicit) = non_empty_trimmed_env(&["MULTICC_AGY_BIN", "AGY_CMD"]) {
        return explicit;
    }
    detect_local_agy()
        .map(PathBuf::into_os_string)
        .unwrap_or_else(|| OsString::from(binary_with_exe_suffix("agy")))
}

/// 解析本机 `agy` 可执行文件路径（UTF-8 字符串形式，供日志与错误提示拼接）。
pub fn resolve_agy_bin_string() -> String {
    resolve_agy_bin().to_string_lossy().into_owned()
}

/// 若显式传入了具体路径或自定义命令名则原样保留；若省略或仅为裸 `"agy"` / `"agy.exe"`，
/// 则按 `resolve_agy_bin_string()` 解析，避免裁剪后的 `PATH` 下报 `ENOENT`。
pub fn resolve_agy_bin_or_explicit(explicit: Option<&str>) -> String {
    match explicit.map(str::trim).filter(|s| !s.is_empty()) {
        None => resolve_agy_bin_string(),
        Some(value) if value == "agy" || value.eq_ignore_ascii_case("agy.exe") => {
            resolve_agy_bin_string()
        }
        Some(value) => value.to_string(),
    }
}

/// 解析本机 `claude` 可执行文件路径。
///
/// 优先级：`MULTICC_CLAUDE_BIN` > `CLAUDE_CMD` >
/// `~/.local/bin` / `~/.local/share/claude/bin` / `~/.npm-global/bin` / `~/.npm/bin` >
/// `PATH` > `/opt/homebrew/bin` / `/opt/homebrew/sbin` / `/usr/local/bin` > 裸命令 `"claude"`。
pub fn resolve_claude_bin() -> OsString {
    let explicit = non_empty_trimmed_env(&["MULTICC_CLAUDE_BIN", "CLAUDE_CMD"]);
    let home = user_home_dir();
    let path_var = std::env::var_os("PATH");
    let pathext = std::env::var_os("PATHEXT");
    let system_dirs =
        non_windows_system_dirs(&["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]);
    resolve_with(
        "claude",
        explicit,
        home.as_deref(),
        &[
            ".local/bin",
            ".local/share/claude/bin",
            ".npm-global/bin",
            ".npm/bin",
        ],
        path_var.as_deref(),
        pathext.as_deref(),
        &system_dirs,
    )
}

/// 解析本机 `claude` 可执行文件路径（UTF-8 字符串形式）。
pub fn resolve_claude_bin_string() -> String {
    resolve_claude_bin().to_string_lossy().into_owned()
}

/// 解析本机 `codex` 可执行文件路径。
///
/// 优先级：`MULTICC_CODEX_BIN` > `CODEX_BIN` > `CODEX_CMD` >
/// `~/.local/bin` / `~/.cargo/bin` / `~/.npm-global/bin` / `~/.npm/bin` >
/// `PATH` > `/opt/homebrew/bin` / `/usr/local/bin` > 裸命令 `"codex"`。
pub fn resolve_codex_bin() -> OsString {
    let explicit = non_empty_trimmed_env(&["MULTICC_CODEX_BIN", "CODEX_BIN", "CODEX_CMD"]);
    let home = user_home_dir();
    let path_var = std::env::var_os("PATH");
    let pathext = std::env::var_os("PATHEXT");
    let system_dirs = non_windows_system_dirs(&["/opt/homebrew/bin", "/usr/local/bin"]);
    resolve_with(
        "codex",
        explicit,
        home.as_deref(),
        &[".local/bin", ".cargo/bin", ".npm-global/bin", ".npm/bin"],
        path_var.as_deref(),
        pathext.as_deref(),
        &system_dirs,
    )
}

/// 解析本机 `codex` 可执行文件路径（UTF-8 字符串形式）。
pub fn resolve_codex_bin_string() -> String {
    resolve_codex_bin().to_string_lossy().into_owned()
}

/// 判断已解析出的命令（绝对/相对路径或裸命令名）当前是否可执行。
pub fn is_resolved_runnable(command: &OsStr) -> bool {
    let cmd_path = Path::new(command);
    if cmd_path.components().count() > 1 {
        if is_runnable_file(cmd_path) {
            return true;
        }
        #[cfg(windows)]
        {
            if let Some(text) = command.to_str() {
                let pathext = std::env::var_os("PATHEXT");
                for name in candidate_names_for_path(text, pathext.as_deref()) {
                    if is_runnable_file(Path::new(&name)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
    let Some(name) = command.to_str() else {
        return false;
    };
    let path_var = std::env::var_os("PATH");
    let pathext = std::env::var_os("PATHEXT");
    find_on_path(name, path_var.as_deref(), pathext.as_deref()).is_some()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "multicc-cli-bin-{}-{tag}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_exec(path: &Path, executable: bool) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
        let mode = if executable { 0o755 } else { 0o644 };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn finds_local_bin_when_path_is_stripped_like_electron_finder() {
        let root = unique_dir("finder");
        let home = root.join("home");
        let local_agy = home.join(".local/bin/agy");
        write_exec(&local_agy, true);

        let stripped_path = OsString::from("/Applications/MultiCC.app/Contents/Resources/runtime/bin:/usr/bin:/bin:/usr/sbin:/sbin");
        let resolved = resolve_with(
            "agy",
            None,
            Some(&home),
            &[".local/bin"],
            Some(stripped_path.as_os_str()),
            None,
            &[],
        );
        assert_eq!(PathBuf::from(resolved), local_agy);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolves_priority_explicit_then_user_local_then_path_then_system() {
        let root = unique_dir("priority");
        let home = root.join("home");
        let path_dir = root.join("custom-path");
        let sys_dir = root.join("homebrew-bin");

        let user_bin = home.join(".local/bin/agy");
        let path_bin = path_dir.join("agy");
        let sys_bin = sys_dir.join("agy");
        write_exec(&user_bin, true);
        write_exec(&path_bin, true);
        write_exec(&sys_bin, true);

        // 1. 显式环境变量覆盖最高优先级
        let explicit = resolve_with(
            "agy",
            Some(OsString::from("/pinned/custom/agy")),
            Some(&home),
            &[".local/bin"],
            Some(path_dir.as_os_str()),
            None,
            &[sys_dir.as_path()],
        );
        assert_eq!(explicit, OsString::from("/pinned/custom/agy"));

        // 2. ~/.local/bin 优先于 PATH 与系统目录
        let user_hit = resolve_with(
            "agy",
            None,
            Some(&home),
            &[".local/bin"],
            Some(path_dir.as_os_str()),
            None,
            &[sys_dir.as_path()],
        );
        assert_eq!(PathBuf::from(user_hit), user_bin);

        // 3. 无 ~/.local/bin 时，PATH 优先于系统兜底目录
        std::fs::remove_file(&user_bin).unwrap();
        let path_hit = resolve_with(
            "agy",
            None,
            Some(&home),
            &[".local/bin"],
            Some(path_dir.as_os_str()),
            None,
            &[sys_dir.as_path()],
        );
        assert_eq!(PathBuf::from(path_hit), path_bin);

        // 4. PATH 被裁剪时，回退到系统目录（如 /opt/homebrew/bin）
        let sys_hit = resolve_with(
            "agy",
            None,
            Some(&home),
            &[".local/bin"],
            Some(OsStr::new("/usr/bin:/bin")),
            None,
            &[sys_dir.as_path()],
        );
        assert_eq!(PathBuf::from(sys_hit), sys_bin);

        // 5. 全未命中时回退裸命令名
        std::fs::remove_file(&sys_bin).unwrap();
        let fallback = resolve_with(
            "agy",
            None,
            Some(&home),
            &[".local/bin"],
            Some(OsStr::new("/usr/bin:/bin")),
            None,
            &[sys_dir.as_path()],
        );
        assert_eq!(fallback, OsString::from("agy"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_non_executable_files_and_follows_symlinks() {
        let root = unique_dir("symlink");
        let home = root.join("home");
        let sys_dir = root.join("homebrew-bin");

        // ~/.local/bin/agy 不可执行时应跳过
        let non_exec = home.join(".local/bin/agy");
        write_exec(&non_exec, false);

        // 系统目录里是指向真实可执行文件的符号链接
        let real_bin = root.join("store/agy-real");
        write_exec(&real_bin, true);
        std::fs::create_dir_all(&sys_dir).unwrap();
        let link = sys_dir.join("agy");
        symlink(&real_bin, &link).unwrap();

        let hit = resolve_with(
            "agy",
            None,
            Some(&home),
            &[".local/bin"],
            Some(OsStr::new("/usr/bin:/bin")),
            None,
            &[sys_dir.as_path()],
        );
        assert_eq!(PathBuf::from(hit), link);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn explicit_path_in_resolve_agy_bin_or_explicit_is_preserved() {
        assert_eq!(
            resolve_agy_bin_or_explicit(Some("/custom/bin/fake-agy")),
            "/custom/bin/fake-agy"
        );
        assert_eq!(
            resolve_agy_bin_or_explicit(Some("custom-agy-wrapper")),
            "custom-agy-wrapper"
        );
    }
}
