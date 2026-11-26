//! Provider-bound CLI launch plans. The host only supplies live catalog and SDK ports.
use super::*;
use crate::{codex_provider_home, provider_registry};
use std::{fs, io, path::Path};

pub fn lookup(lane: &str) -> Option<&'static str> {
    match lane {
        "opencode" | "zcode" | "kimi" | "grok" => Some(""),
        _ => provider_registry::app_type_for_cli(lane),
    }
}
pub fn empty(lane: &str, bound: bool, name: &Value) -> Result<Value, String> {
    if bound {
        let label = match lane {
            "zcode" => Some("ZCode"),
            "kimi" => Some("Kimi"),
            "grok" => Some("Grok"),
            "dsh" => Some("DSH"),
            _ => None,
        };
        if let Some(label) = label {
            return Err(format!(
                "{label} Provider 不存在、协议不兼容或缺少可用的 HTTP 凭证"
            ));
        }
    }
    Ok(
        json!({"env":{},"skipDefaultModel":false,"aliasOnly":false,"providerModel":null,"providerModels":[],"providerName":name}),
    )
}
pub fn claude(row: &Value) -> Value {
    let cfg = config(row);
    let source = &cfg["env"];
    let mut env: serde_json::Map<_, _> = source
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(k, v)| k.starts_with("ANTHROPIC_") && v.is_string())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    settings::ensure_zhipu_fable_alias(&mut env);
    let routed = env.get("ANTHROPIC_BASE_URL").is_some_and(truthy);
    let aliases = [
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
    ];
    if routed && !env.get("ANTHROPIC_MODEL").is_some_and(truthy) {
        if let Some(model) = [aliases[1], aliases[0], aliases[2], aliases[3]]
            .into_iter()
            .filter_map(|key| env.get(key))
            .find(|v| truthy(v))
            .cloned()
        {
            env.insert("ANTHROPIC_MODEL".into(), model);
        }
    }
    let model = env.get("ANTHROPIC_MODEL").filter(|v| truthy(v));
    let models = settings::unique_models(
        &std::iter::once("ANTHROPIC_MODEL")
            .chain(aliases)
            .filter_map(|key| env.get(key).cloned())
            .collect::<Vec<_>>(),
    );
    let mut result = json!({"env":env,"skipDefaultModel":routed,"aliasOnly":routed&&!truthy(&source["ANTHROPIC_MODEL"]),"providerModel":model,"providerModels":models,"providerName":row["name"]});
    if let Some(tools) = source.get("MULTICC_TOOLS") {
        result["tools"] = tools.clone();
    }
    result
}
fn mirror_skills(home: &Path, global: &Path) -> io::Result<()> {
    if !global.is_dir() {
        return Ok(());
    }
    let skills = home.join("skills");
    match fs::symlink_metadata(&skills) {
        Ok(st) if st.is_symlink() => {
            if fs::canonicalize(&skills).ok() == Some(fs::canonicalize(global)?) {
                return Ok(());
            }
            #[cfg(unix)]
            fs::remove_file(&skills)?;
            #[cfg(windows)]
            {
                use std::os::windows::fs::FileTypeExt;
                if st.file_type().is_symlink_dir() {
                    fs::remove_dir(&skills)?;
                } else {
                    fs::remove_file(&skills)?;
                }
            }
        }
        Ok(st) if st.is_dir() => {
            for entry in fs::read_dir(&skills)? {
                if entry?.file_name() != ".system" {
                    return Ok(());
                }
            }
            fs::remove_dir_all(&skills)?;
        }
        Ok(_) => return Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(global, skills)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(global, skills)
    }
}
pub fn codex(
    row: &Value,
    id: &str,
    root: &Path,
    global: &Path,
    port: &str,
) -> Result<Value, String> {
    let official = provider_catalog::official_codex(row);
    let run = || {
        let home = root.join(id.trim_start_matches(std::path::is_separator));
        for dir in [&home, &home.join("sessions")] {
            super::vendor::private_dir(dir).map_err(|e| e.to_string())?;
        }
        let cfg = effective_codex(row, port);
        let mut env = if official {
            codex_provider_home::materialize_official(
                &home,
                strval(&row["id"]),
                strval(&cfg["config"]),
            )?;
            json!({})
        } else {
            codex_provider_home::materialize_direct(&home, &global.join("auth.json"), &cfg)?
        };
        let _ = mirror_skills(&home, &global.join("skills"));
        env["CODEX_HOME"] = json!(home);
        Ok(
            json!({"env":env,"skipDefaultModel":false,"aliasOnly":false,"providerModel":null,"providerModels":[],"providerName":row["name"],"codexHome":home,"codexOfficialRelay":official}),
        )
    };
    match run() {
        Err(_) if !official => empty("", false, &row["name"]),
        result => result,
    }
}

pub fn claude_route(row: &Value) -> (bool, Option<Value>) {
    let cfg = config(row);
    let env = &cfg["env"];
    let value = |k: &str| {
        if truthy(&env[k]) {
            js_string(&env[k]).trim().to_owned()
        } else {
            String::new()
        }
    };
    let auth = value("ANTHROPIC_AUTH_TOKEN");
    let key = value("ANTHROPIC_API_KEY");
    let oauth = value("CLAUDE_CODE_OAUTH_TOKEN");
    let has_token = !auth.is_empty() || !key.is_empty() || !oauth.is_empty();
    let bearer_only = auth.is_empty() && key.is_empty() && !oauth.is_empty();
    let mut view = cfg.clone();
    let implied = value("ANTHROPIC_BASE_URL").is_empty();
    if !has_token || (!implied && !bearer_only) {
        return (has_token, None);
    }
    if implied {
        view["env"]["ANTHROPIC_BASE_URL"] = "https://api.anthropic.com".into();
    }
    if bearer_only {
        view["env"]["ANTHROPIC_AUTH_TOKEN"] = oauth.into();
    }
    if row["settingsConfig"].is_string() {
        view = crate::js::serde::js_json_stringify(&view).into();
    }
    (true, Some(view))
}
