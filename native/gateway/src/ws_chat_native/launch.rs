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

pub(super) async fn prepare_history(app: &App, options: &StartInput) {
    let home = app.home_dir.clone();
    let session = options.launch.session_id.clone();
    let _ = tokio::task::spawn_blocking(move || {
        multicc_core::claude_adapter::sanitize_history(&home, &session)
    })
    .await;
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
    effective_model: Option<&str>,
) -> (Option<String>, Value) {
    let effort = optional_text(record, "effort");
    let model = effective_model.map(str::to_owned);
    let claude = super::store::is_claude(record);
    let codex = super::store::is_codex(record);
    let cli = optional_text(record, "cli").unwrap_or_else(|| "claude".into());
    let home = app.home_dir.clone();
    tokio::task::spawn_blocking(move || {
        let effort = if claude {
            let allowed = |s: &String| {
                multicc_core::cli_capability::supports_effort(
                    &cli,
                    model.as_deref().unwrap_or(""),
                    s,
                )
            };
            effort
                .filter(allowed)
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
                                .filter(allowed)
                        })
                })
                .or_else(|| {
                    multicc_core::cli_capability::effort_of(&cli)
                        .map(|s| s.default)
                        .filter(allowed)
                })
        } else if codex {
            codex_effort(&cli, &home, effort.as_deref(), model.as_deref())
        } else {
            effort
        };
        let mut availability =
            json!({"claude":{"available":available(Path::new(&claude_binary()))}});
        if codex {
            let available = available(Path::new(&super::codex::binary()));
            availability["codex-exp"] = json!({"available":available});
            availability["codex"] = json!({"available":available});
        }
        (effort, availability)
    })
    .await
    .unwrap_or_default()
}

pub(super) fn codex_effort(
    cli: &str,
    home: &Path,
    effort: Option<&str>,
    model: Option<&str>,
) -> Option<String> {
    use multicc_core::codex_provider_home::{home_reasoning_level, reasoning_level};
    effort
        .and_then(|effort| reasoning_level(cli, effort, model))
        .or_else(|| {
            std::env::var_os("CODEX_HOME")
                .filter(|path| !path.is_empty())
                .and_then(|path| home_reasoning_level(cli, Path::new(&path), model))
        })
        .or_else(|| home_reasoning_level(cli, &home.join(".codex"), model))
        .or_else(|| multicc_core::cli_capability::effort_of(cli).map(|spec| spec.default))
        .filter(|v| {
            !v.is_empty()
                && multicc_core::cli_capability::supports_effort(cli, model.unwrap_or(""), v)
        })
}

fn available(path: &Path) -> bool {
    if path.components().count() > 1 {
        path.is_file()
    } else {
        std::env::var_os("PATH").is_some_and(|paths| {
            std::env::split_paths(&paths).any(|entry: PathBuf| entry.join(path).is_file())
        })
    }
}
