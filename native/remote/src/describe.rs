//! reason → 用户文案。
//!
//! reason 的取值集合是 Agent 契约的一部分（docs/desktop-agent-protocol.md §3），
//! 新增 reason 必须同时改这里、Web 的 ERR_KEYS 和协议文档，否则用户看到裸 code。

use serde_json::Value;

pub const REASONS: &[(&str, &str)] = &[
    ("screen-locked", "屏幕已锁定"),
    ("user-stopped", "本机按了 Esc 急停，需先「恢复」"),
    ("busy", "另一个会话正在操作电脑"),
    ("protected-app", "目标是受保护的 App（密码 / 系统设置），需本人操作"),
    ("accessibility-not-granted", "MultiCC Agent 未获辅助功能授权"),
    ("screen-recording-not-granted", "MultiCC Agent 未获屏幕录制授权"),
    ("agent-unreachable", "MultiCC Agent 未运行"),
    ("platform-unsupported", "这台机器上的桌面 Agent 还不支持远程屏幕"),
    ("no-display", "桌面 Agent 连不上这台机器的图形界面（X server）"),
    (
        "wayland-session",
        "这台 Linux 正在用 Wayland 会话，远程屏幕只支持 X11：注销后选「Xorg / X11」会话",
    ),
    ("interrupted", "操作被中途停下，可能已执行了一部分，先看一眼画面"),
];

pub fn reason_text(code: &str) -> Option<&'static str> {
    REASONS.iter().find(|(key, _)| *key == code).map(|(_, text)| *text)
}

/// JS `describe(r)`：reason/error → 文案；agent-unreachable 时补上安装命令。
pub fn describe(reply: &Value, install_hint: Option<&str>) -> String {
    let pick = |key: &str| reply.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    let code = pick("reason").or_else(|| pick("error")).unwrap_or("unknown");
    if code == "agent-unreachable" {
        if let Some(hint) = install_hint {
            let text = reason_text(code).unwrap_or(code);
            return format!("{text}：在这台机器上执行 {hint}");
        }
    }
    if let Some(text) = reason_text(code) {
        return text.to_string();
    }
    if let Some(hint) = pick("hint") {
        return hint.to_string();
    }
    if let Some(message) = pick("message") {
        return message.to_string();
    }
    code.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn known_reasons_are_translated_never_bare_codes() {
        assert_eq!(describe(&json!({"reason":"wayland-session"}), None), REASONS[9].1);
        assert_eq!(describe(&json!({"error":"interrupted"}), None), REASONS[10].1);
        assert_eq!(describe(&json!({"error":"no-display"}), None), "桌面 Agent 连不上这台机器的图形界面（X server）");
    }

    #[test]
    fn unreachable_agent_points_at_the_linux_installer() {
        assert_eq!(
            describe(&json!({"error":"agent-unreachable"}), Some("sh scripts/linux-agent/install.sh install")),
            "MultiCC Agent 未运行：在这台机器上执行 sh scripts/linux-agent/install.sh install"
        );
    }

    #[test]
    fn unknown_codes_fall_back_to_hint_message_then_code() {
        assert_eq!(describe(&json!({"error":"x","hint":"看看这台机器"}), None), "看看这台机器");
        assert_eq!(describe(&json!({"error":"x","message":"细节"}), None), "细节");
        assert_eq!(describe(&json!({"error":"x"}), None), "x");
        assert_eq!(describe(&json!({}), None), "unknown");
    }
}
