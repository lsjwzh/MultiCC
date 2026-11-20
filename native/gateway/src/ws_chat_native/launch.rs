use super::{optional_text, Session};
use crate::app::App;
use multicc_core::{claude_lane::LaunchInput, claude_process::StartInput};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub(super) fn launch_options(state: &Session) -> StartInput {
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
        binary: claude_binary(),
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

fn claude_binary() -> String {
    if let Ok(command) = std::env::var("MULTICC_CLAUDE_BIN") {
        if !command.trim().is_empty() {
            return command;
        }
    }
    if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    }
    .into()
}

pub(super) async fn init_facts(
    app: &App,
    record: &multicc_core::js::JsValue,
) -> (Option<String>, Value) {
    let effort = optional_text(record, "effort");
    let claude = super::store::is_claude(record);
    let home = app.home_dir.clone();
    tokio::task::spawn_blocking(move || {
        let effort = if claude {
            effort
                .or_else(|| {
                    ["settings.local.json", "settings.json"]
                        .iter()
                        .find_map(|name| {
                            let raw =
                                std::fs::read_to_string(home.join(".claude").join(name)).ok()?;
                            let settings = serde_json::from_str::<Value>(&raw).ok()?;
                            settings["effort"]
                                .as_str()
                                .or_else(|| settings["thinkingEffort"].as_str())
                                .map(str::trim)
                                .filter(|value| !value.is_empty())
                                .map(str::to_ascii_lowercase)
                        })
                })
                .or_else(|| Some("medium".into()))
        } else {
            effort
        };
        let binary = claude_binary();
        let path = Path::new(&binary);
        let available = if path.components().count() > 1 {
            path.is_file()
        } else {
            std::env::var_os("PATH").is_some_and(|paths| {
                std::env::split_paths(&paths).any(|entry: PathBuf| entry.join(path).is_file())
            })
        };
        (effort, json!({"claude":{"available":available}}))
    })
    .await
    .unwrap_or_default()
}
