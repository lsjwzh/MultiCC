//! Read power intent, observed sleep policy and Agent authorization independently.
use serde_json::{json, Value};
use std::path::Path;

#[cfg(not(target_os = "macos"))]
pub(super) async fn settings(_home: &Path, _can_edit: bool) -> Result<Value, ()> {
    Ok(json!({"available":false,"enabled":false}))
}

#[cfg(target_os = "macos")]
pub(super) async fn settings(home: &Path, can_edit: bool) -> Result<Value, ()> {
    use std::{env, path::PathBuf, process::Stdio, time::Duration};
    use tokio::{process::Command, time::timeout};

    let policy = timeout(
        Duration::from_secs(5),
        Command::new("/usr/bin/pmset")
            .arg("-g")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    if !policy.status.success() {
        return Err(());
    }
    let observed = sleep_disabled(&String::from_utf8_lossy(&policy.stdout));
    let enabled = tokio::fs::read_to_string("/Library/Application Support/multicc/power-intent")
        .await
        .is_ok_and(|text| text.trim() == "on");
    // Query item attributes only. Discard both output streams, including
    // account metadata. Exit 44 is errSecItemNotFound.
    let account = match env::var("USER").ok().filter(|s| !s.is_empty()) {
        Some(account) => Some(account),
        None => timeout(
            Duration::from_secs(3),
            Command::new("/usr/bin/id")
                .arg("-un")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty()),
    };
    let set = match account {
        Some(account) => timeout(
            Duration::from_secs(8),
            Command::new("/usr/bin/security")
                .args([
                    "find-generic-password",
                    "-s",
                    "com.multicc.agent.unlock",
                    "-a",
                    &account,
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .status(),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(|status| match status.code() {
            Some(0) => Some(true),
            Some(44) => Some(false),
            _ => None,
        }),
        None => None,
    };
    let agent_dir = env::var_os("MULTICC_AGENT_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".multicc/agent"));
    let mut unlock = json!({"available":true,"set":false,"canEdit":can_edit,"error":"read-failed"});
    if let Some(set) = set {
        let requested = match tokio::fs::read(agent_dir.join("power-settings.json")).await {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|p| p["autoUnlock"].as_bool()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Some(set),
            Err(_) => None,
        };
        if let Some(requested) = requested {
            let active = set && (requested || enabled);
            unlock = json!({"available":true,"set":set,"canEdit":can_edit,"requested":requested,"enabled":active,"requiredByLid":enabled});
            if active {
                let agent = env::var_os("MULTICC_AGENT_BIN")
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".multicc/bin/multicc-agent"));
                let reply = timeout(
                    Duration::from_secs(3),
                    Command::new(agent)
                        .arg("status")
                        .kill_on_drop(true)
                        .output(),
                )
                .await;
                let authorization = match reply {
                    Ok(Ok(out)) if out.status.success() => agent_permissions(&out.stdout),
                    Ok(Err(err)) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                        json!({"state":"unavailable","detail":"agent-not-executable"})
                    }
                    Ok(Err(err)) if err.kind() == std::io::ErrorKind::NotFound => {
                        json!({"state":"unavailable","detail":"agent-not-installed"})
                    }
                    _ => json!({"state":"unavailable","detail":"agent-error"}),
                };
                if authorization["state"] != "authorized" {
                    unlock["enabled"] = json!(false);
                    unlock["authorization"] = authorization;
                }
            }
        }
    }
    // The standalone gateway has no battery-guard timer. This is the
    // NEVER_GUARDED_STATUS contract, not a claim about a running watchdog.
    Ok(
        json!({"available":true,"enabled":enabled,"systemSleepDisabled":observed,
        "batteryGuard":{"running":false,"intervalMs":0,"thresholds":{"trigger":0,"rearm":0},
        "sleepPrevention":false,"latched":false,"triggerCount":0,"lastCheckTs":0,"lastBattery":null,"lastSleepResult":null,"error":null},
        "unlockPassword":unlock}),
    )
}

#[cfg(any(test, target_os = "macos"))]
fn sleep_disabled(output: &str) -> bool {
    let mut values = Vec::new();
    for line in output.lines() {
        let mut fields = line.split_whitespace();
        let (Some(key), Some(raw), None) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        if !raw.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        if key.eq_ignore_ascii_case("SleepDisabled") {
            return raw.parse::<u64>() == Ok(1);
        }
        if key == "disablesleep" {
            values.push(raw.parse::<u64>() == Ok(1));
        }
    }
    !values.is_empty() && values.into_iter().all(|v| v)
}

#[cfg(any(test, target_os = "macos"))]
fn agent_permissions(bytes: &[u8]) -> Value {
    let data: Value = serde_json::from_slice(bytes).unwrap_or_default();
    if data["ok"] != true {
        return json!({"state":"unavailable","detail":"bad-reply"});
    }
    let accessibility = data["accessibility"] == true;
    let screen = data["screenRecording"] == true;
    if accessibility && screen {
        return json!({"state":"authorized"});
    }
    json!({"state":"permissions-required","permissions":{"accessibility":accessibility,"screenRecording":screen},
        "message":"请先在这台 Mac 的系统设置中，为 MultiCC Agent 开启辅助功能和屏幕录制权限；这两项是自动解锁的前置条件。"})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn power_and_authorization_preserve_distinct_states() {
        assert!(!sleep_disabled("disablesleep 1\n SleepDisabled 0"));
        assert!(sleep_disabled("SleepDisabled 1"));
        assert!(!sleep_disabled("disablesleep 1\ndisablesleep 0"));
        assert!(!sleep_disabled(""));
        assert_eq!(
            agent_permissions(br#"{"ok":true,"accessibility":true,"screenRecording":true}"#)
                ["state"],
            "authorized"
        );
        assert_eq!(
            agent_permissions(br#"{"ok":true,"screenRecording":true}"#)["permissions"]
                ["accessibility"],
            false
        );
        assert_eq!(agent_permissions(b"invalid")["detail"], "bad-reply");
    }
}
