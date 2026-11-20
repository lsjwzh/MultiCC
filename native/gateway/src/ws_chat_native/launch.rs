use super::{optional_text, Session};
use crate::app::App;
use multicc_core::{claude_lane::LaunchInput, claude_process::StartInput};
use serde_json::{Map, Value};
use std::path::Path;

pub(super) fn launch_options(app: &App, state: &Session) -> StartInput {
    let record = &state.stored.record;
    let env = std::env::vars()
        .filter(|(key, _)| {
            key.starts_with("ANTHROPIC_")
                || key.starts_with("CLAUDE_CODE_")
                || matches!(
                    key.as_str(),
                    "PATH"
                        | "HOME"
                        | "USERPROFILE"
                        | "LANG"
                        | "LC_ALL"
                        | "TMPDIR"
                        | "TMP"
                        | "TEMP"
                        | "SystemRoot"
                        | "SYSTEMROOT"
                        | "ComSpec"
                        | "PATHEXT"
                        | "CLAUDE_CONFIG_DIR"
                        | "HTTPS_PROXY"
                        | "HTTP_PROXY"
                        | "NO_PROXY"
                        | "https_proxy"
                        | "http_proxy"
                        | "no_proxy"
                )
        })
        .map(|(key, value)| (key, Value::String(value)))
        .collect::<Map<_, _>>();
    StartInput {
        binary: claude_binary(&app.package_root),
        cwd: Some(state.stored.cwd.to_string_lossy().into_owned()),
        launch: LaunchInput {
            session_id: state.stored.native_id.clone(),
            resume: state.native_started,
            model: optional_text(record, "model"),
            effort: optional_text(record, "effort"),
            agent: optional_text(record, "agent"),
            system_prompt_append: optional_text(record, "rolePrompt"),
            env,
            include_partial_messages: true,
            permission_mode: Some("bypassPermissions".into()),
            allow_dangerously_skip_permissions: true,
            ..Default::default()
        },
        ..Default::default()
    }
}

fn claude_binary(package: &Path) -> String {
    if let Ok(command) = std::env::var("MULTICC_CLAUDE_BIN") {
        if !command.trim().is_empty() {
            return command;
        }
    }
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    let executable = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let root = package.join("node_modules/@anthropic-ai");
    for suffix in ["", "-musl"] {
        let binary = root
            .join(format!("claude-agent-sdk-{os}-{arch}{suffix}"))
            .join(executable);
        if binary.is_file() {
            return binary.to_string_lossy().into_owned();
        }
    }
    executable.into()
}
