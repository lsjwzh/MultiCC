//! 电源同意（「允许自动解锁」）的读取。
//!
//! 移植 `src/host-power-services.js` 的 `createPowerPreferences().read(true)`
//! 与 `src/powerd.js` 的 `readIntent()`，这两段此前只有 Node 实现。
//!
//! 为什么要搬：唤屏请求的同意值原先由 Node 算好、经 `x-multicc-power-consent`
//! 头传进来。那是远控最后一处「Rust 必须靠 Node 才能工作」的依赖，也是把远控
//! 整条搬上 Rust 前门的**前置件** —— 前门是另一个进程，算不出这个值。现在同意
//! 值在本进程直接读两个文件得出，那个头连同 Node 侧的计算一起删掉了。
//!
//! 为什么是「两个开关取或」：`power-settings.json` 里的 `autoUnlock` 是用户在
//! 网页全局设置里拨的；`power-intent` 是 `com.multicc.powerd` 这个 root 守护
//! 进程的意图文件（`scripts/multicc-powerd.sh`）。任一为真就算用户同意过。
//!
//! **只读不写**：设置的写入仍归电源模块（网页路由），这里从不创建或修改文件。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// powerd 的意图文件目录（Node `src/powerd.js` 的 `DATA_DIR`，无环境变量覆盖）。
const POWERD_DIR: &str = "/Library/Application Support/multicc";

/// 同意值三态。`Unreadable` 必须和「用户没同意」区分开：迁移前读失败会让 JS
/// 直接抛、唤屏接口回 503 agent-unavailable；折成 `Denied` 会变成误导性的
/// 「自动解锁未开启」200，用户会去改一个本来没问题的开关。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Consent {
    Allowed,
    Denied,
    Unreadable,
}

/// 两个开关的文件位置。进程启动时定下来，每个请求重新读内容（同意状态随时可变，
/// 不能缓存）。
#[derive(Clone, Debug)]
pub struct Power {
    settings: PathBuf,
    intent: PathBuf,
    /// 测试台用的三态注入文件（`MULTICC_REMOTE_POWER_CONSENT_FILE`）：CI 里没有
    /// 真实电源设置可读。迁移前这个开关在 Node 侧，连同计算一起搬过来，
    /// `tests/helpers/remote-screen-e2e-harness.js` 不用改。生产不设这个变量。
    injected: Option<PathBuf>,
}

impl Power {
    pub fn new(
        settings: impl Into<PathBuf>,
        intent: impl Into<PathBuf>,
        injected: Option<PathBuf>,
    ) -> Self {
        Self {
            settings: settings.into(),
            intent: intent.into(),
            injected,
        }
    }

    /// 按 `(home, env)` 推导，口径与 `host::profile_for` 一致：`MULTICC_AGENT_DIR`
    /// 优先，空串算没设置。
    pub fn from_env(home: &str, env: &HashMap<String, String>) -> Self {
        let dir = crate::host::env_value(env, "MULTICC_AGENT_DIR").unwrap_or_else(|| {
            Path::new(home)
                .join(".multicc/agent")
                .to_string_lossy()
                .into_owned()
        });
        Self::new(
            Path::new(&dir).join("power-settings.json"),
            Path::new(POWERD_DIR).join("power-intent"),
            crate::host::env_value(env, "MULTICC_REMOTE_POWER_CONSENT_FILE").map(PathBuf::from),
        )
    }

    pub fn from_process() -> Self {
        let env = crate::host::process_env();
        Self::from_env(&crate::host::home_dir(&env), &env)
    }

    /// 读一次当前同意值。`autoUnlock` 为真就**短路**，不去读意图文件 —— 与 JS 的
    /// `read(true) || readIntent() === 'on'` 同一求值顺序。
    pub fn consent(&self) -> Consent {
        if let Some(path) = &self.injected {
            return Self::injected_consent(path);
        }
        match self.auto_unlock() {
            Err(()) => Consent::Unreadable,
            Ok(true) => Consent::Allowed,
            Ok(false) => {
                if self.intent() == "on" {
                    Consent::Allowed
                } else {
                    Consent::Denied
                }
            }
        }
    }

    /// `power-settings.json` 的 `autoUnlock`。**文件不存在 = true**：迁移前
    /// `read(true)` 的 legacyEnabled 就是这么传的，用来保住老用户已有的同意
    /// （设置页没拨过开关的人不该因为升级就被关掉自动解锁）。其余读写错误
    /// （权限、坏 JSON、字段不是布尔）一律当读不出来，不猜。
    fn auto_unlock(&self) -> Result<bool, ()> {
        let text = match std::fs::read_to_string(&self.settings) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(_) => return Err(()),
        };
        match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(serde_json::Value::Bool(_)) | Err(_) => Err(()),
            Ok(value) => match value.get("autoUnlock") {
                Some(serde_json::Value::Bool(on)) => Ok(*on),
                _ => Err(()),
            },
        }
    }

    /// powerd 的意图：`on` / `off` 之外（含读不到）一律 `none`，与 JS 一致。
    fn intent(&self) -> String {
        match std::fs::read_to_string(&self.intent) {
            Ok(text) => match text.trim() {
                "on" => "on".into(),
                "off" => "off".into(),
                _ => "none".into(),
            },
            Err(_) => "none".into(),
        }
    }

    fn injected_consent(path: &Path) -> Consent {
        match std::fs::read_to_string(path) {
            Ok(text) => match text.trim() {
                "1" => Consent::Allowed,
                "0" => Consent::Denied,
                _ => Consent::Unreadable,
            },
            Err(_) => Consent::Unreadable,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Dir {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("multicc-power-{name}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn write(&self, name: &str, body: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, body).unwrap();
            path
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn either_switch_counts_as_consent_and_settings_short_circuit() {
        let dir = Dir::new("or");
        let on = dir.write("on.json", r#"{"autoUnlock":true}"#);
        let off = dir.write("off.json", r#"{"autoUnlock":false}"#);
        let intent_on = dir.write("intent-on", "on\n");
        let intent_off = dir.write("intent-off", "off\n");

        // 开关开着：同意，而且不去读意图文件（指向一个不存在的路径也照样 Allowed）。
        assert_eq!(
            Power::new(&on, dir.path("missing-intent"), None).consent(),
            Consent::Allowed
        );
        // 开关关着、意图 on：仍然算同意（powerd 那条路径）。
        assert_eq!(
            Power::new(&off, &intent_on, None).consent(),
            Consent::Allowed
        );
        // 两个都关：不同意。
        assert_eq!(
            Power::new(&off, &intent_off, None).consent(),
            Consent::Denied
        );
        // 意图文件缺失 / 内容不认识 = none，不是 on。
        assert_eq!(
            Power::new(&off, dir.path("missing-intent"), None).consent(),
            Consent::Denied
        );
        assert_eq!(
            Power::new(&off, dir.write("intent-junk", "ON"), None).consent(),
            Consent::Denied
        );
    }

    #[test]
    fn a_missing_settings_file_keeps_existing_users_consent() {
        // read(true) 的 legacyEnabled：没拨过开关的老用户不该因为升级被关掉。
        let dir = Dir::new("legacy");
        assert_eq!(
            Power::new(dir.path("nope.json"), dir.path("nope-intent"), None).consent(),
            Consent::Allowed
        );
    }

    #[test]
    fn unreadable_settings_are_not_silently_a_no() {
        let dir = Dir::new("bad");
        let intent = dir.write("intent", "off\n");
        for body in [
            "{",                       // 坏 JSON
            "{}",                      // 没有 autoUnlock
            r#"{"autoUnlock":"yes"}"#, // 有但不是布尔
            r#"{"autoUnlock":1}"#,
            "true", // 顶层不是对象
            "null",
        ] {
            let settings = dir.write("settings.json", body);
            assert_eq!(
                Power::new(&settings, &intent, None).consent(),
                Consent::Unreadable,
                "{body} 应当读不出来，而不是折成「用户没同意」"
            );
        }
    }

    #[test]
    fn the_test_injection_file_overrides_both_switches() {
        let dir = Dir::new("inject");
        let settings = dir.write("settings.json", r#"{"autoUnlock":false}"#);
        let intent = dir.write("intent", "off\n");
        for (body, want) in [
            ("1", Consent::Allowed),
            ("0", Consent::Denied),
            ("error", Consent::Unreadable),
            ("whatever", Consent::Unreadable),
        ] {
            let injected = dir.write("consent.txt", body);
            assert_eq!(
                Power::new(&settings, &intent, Some(injected)).consent(),
                want
            );
        }
        assert_eq!(
            Power::new(&settings, &intent, Some(dir.path("gone.txt"))).consent(),
            Consent::Unreadable
        );
    }

    #[test]
    fn paths_follow_the_agent_dir_env_then_home() {
        let mut env = HashMap::new();
        let power = Power::from_env("/Users/x", &env);
        assert!(power
            .settings
            .ends_with(".multicc/agent/power-settings.json"));
        assert!(power.settings.starts_with("/Users/x"));
        assert_eq!(power.intent, Path::new(POWERD_DIR).join("power-intent"));
        assert!(power.injected.is_none());

        env.insert("MULTICC_AGENT_DIR".into(), "".into()); // 空串算没设置
        assert!(Power::from_env("/Users/x", &env)
            .settings
            .starts_with("/Users/x"));

        env.insert("MULTICC_AGENT_DIR".into(), "/tmp/agent".into());
        env.insert(
            "MULTICC_REMOTE_POWER_CONSENT_FILE".into(),
            "/tmp/c.txt".into(),
        );
        let power = Power::from_env("/Users/x", &env);
        assert_eq!(power.settings, Path::new("/tmp/agent/power-settings.json"));
        assert_eq!(power.injected.as_deref(), Some(Path::new("/tmp/c.txt")));
    }
}
