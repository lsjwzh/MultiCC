//! Materializes the legacy Codex launch homes and removes credentials from
//! OAuth relay homes. The OAuth account store remains on the host.
use crate::{
    http_gate::encode_uri_component,
    js::{self, serde::js_json_stringify_indent},
    provider_writes::toml_value,
    state_file::{self, DIR_MODE, FILE_MODE},
};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read},
    path::Path,
    sync::LazyLock,
};
use toml_edit::{value, DocumentMut, Item, Table};
use url::Url;

const OFFICIAL_RELAY: &str = "multicc_official_relay";
const MAX_FILE: u64 = 16 * 1024 * 1024;

fn io_error(error: io::Error) -> String {
    let code = match error.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::NotADirectory => "ENOTDIR",
        io::ErrorKind::IsADirectory => "EISDIR",
        _ => "CODEX_PROVIDER_HOME_IO",
    };
    code.into()
}

fn read(file: &Path) -> Result<Option<Vec<u8>>, String> {
    let mut open = OpenOptions::new();
    open.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.custom_flags(libc::O_NONBLOCK);
    }
    let file = match open.open(file) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() {
        return Err("CODEX_PROVIDER_HOME_INVALID_FILE".into());
    }
    if metadata.len() > MAX_FILE {
        return Err("CODEX_PROVIDER_HOME_FILE_TOO_LARGE".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("CODEX_PROVIDER_HOME_FILE_TOO_LARGE".into());
    }
    Ok(Some(bytes))
}

fn private_write(file: &Path, bytes: &[u8]) -> Result<(), String> {
    state_file::write_bytes_atomic(file, bytes, FILE_MODE, DIR_MODE).map_err(io_error)
}

fn remove_auth(home: &Path) -> Result<(), String> {
    match fs::remove_file(home.join("auth.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

pub fn materialize_auth(
    home: &Path,
    global_auth: &Path,
    settings: &Value,
) -> Result<&'static str, String> {
    let direct = !toml_value(settings.get("config"), "base_url").is_empty();
    if !direct {
        if let Some(bytes) = read(global_auth)? {
            private_write(&home.join("auth.json"), &bytes)?;
            return Ok("global");
        }
    }
    if js::serde::truthy(&settings["auth"]) {
        let auth = js_json_stringify_indent(&settings["auth"], "  ") + "\n";
        private_write(&home.join("auth.json"), auth.as_bytes())?;
        return Ok(if direct {
            "provider"
        } else {
            "provider-fallback"
        });
    }
    remove_auth(home)?;
    Ok("none")
}

pub fn materialize_direct(
    home: &Path,
    global_auth: &Path,
    settings: &Value,
) -> Result<Value, String> {
    let api_key = &settings["auth"]["OPENAI_API_KEY"];
    let has_api_key = js::serde::truthy(api_key);
    let raw = settings["config"].as_str();
    if raw.is_none() && js::serde::truthy(&settings["config"]) {
        return Err("CODEX_PROVIDER_CONFIG_INVALID".into());
    }
    materialize_auth(home, global_auth, settings)?;
    if let Some(raw) = raw.filter(|raw| !raw.is_empty()) {
        let config = direct_config(raw, has_api_key);
        private_write(&home.join("config.toml"), config.as_bytes())?;
    }
    Ok(if has_api_key {
        json!({"OPENAI_API_KEY":api_key})
    } else {
        json!({})
    })
}

fn direct_config(raw: &str, has_api_key: bool) -> String {
    static CATALOG: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)^model_catalog_json\s*=[^\r\n\x{2028}\x{2029}]*").unwrap()
    });
    static BLANK_LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
    static EMPTY_TABLE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\[model_providers\]\s*\n\[model_providers\.custom\]").unwrap()
    });
    static ENV_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\s*env_key\s*=").unwrap());
    static ACTIVE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"model_provider\s*=\s*"([^"]+)""#).unwrap());

    let config = CATALOG.replace_all(raw, "");
    let config = BLANK_LINES.replace_all(&config, "\n\n");
    let config = EMPTY_TABLE.replace(&config, "[model_providers.custom]");
    if !has_api_key || ENV_KEY.is_match(&config) {
        return config.into_owned();
    }
    let id = ACTIVE
        .captures(&config)
        .and_then(|m| m.get(1))
        .map_or("custom", |m| m.as_str());
    let id = regex::escape(id);
    let header = Regex::new(&format!(
        r#"(?m)^\[model_providers\.(?:"{id}"|{id})\][\s\uFEFF]*$"#
    ));
    let end = header
        .ok()
        .and_then(|pattern| pattern.find(&config))
        .map(|matched| matched.end());
    let mut config = config.into_owned();
    if let Some(end) = end {
        config.insert_str(end, "\nenv_key = \"OPENAI_API_KEY\"");
    }
    config
}

fn parse_config(raw: &str) -> Result<DocumentMut, String> {
    if js::js_trim(raw).is_empty() {
        return Ok(DocumentMut::new());
    }
    raw.parse()
        .map_err(|_| "CODEX_PROVIDER_CONFIG_INVALID".into())
}

pub fn materialize_official(home: &Path, provider_id: &str, config: &str) -> Result<(), String> {
    let mut document = parse_config(config)?;
    document["model_provider"] = value(OFFICIAL_RELAY);
    if document
        .get("model_providers")
        .and_then(Item::as_table_like)
        .is_none()
    {
        document["model_providers"] = Item::Table(Table::new());
    }
    let mut relay = Table::new();
    relay["name"] = value("OpenAI Official via MultiCC host relay");
    relay["base_url"] = value(format!(
        "http://127.0.0.1:1/codex-proxy/{}/inactive/main",
        encode_uri_component(provider_id),
    ));
    relay["wire_api"] = value("responses");
    relay["requires_openai_auth"] = value(false);
    let providers = document["model_providers"].as_table_like_mut().unwrap();
    providers.insert(OFFICIAL_RELAY, Item::Table(relay));
    remove_auth(home)?;
    private_write(&home.join("config.toml"), document.to_string().as_bytes())
}

pub fn sanitize_official(home: &Path, proxy_path: &str) -> Result<(), String> {
    let config_file = home.join("config.toml");
    let raw = read(&config_file)?.ok_or("ENOENT")?;
    let raw = std::str::from_utf8(&raw).map_err(|_| "CODEX_PROVIDER_CONFIG_INVALID")?;
    let mut document = parse_config(raw)?;
    let proxy_path = format!("/{}", proxy_path.trim_matches('/'));
    let prefix = format!("{proxy_path}/");
    if let Some(providers) = document
        .get_mut("model_providers")
        .and_then(Item::as_table_like_mut)
    {
        for (_, item) in providers.iter_mut() {
            let Some(entry) = item.as_table_like_mut() else {
                continue;
            };
            let local_proxy = entry
                .get("base_url")
                .and_then(Item::as_str)
                .and_then(|base| Url::parse(base).ok())
                .is_some_and(|base| {
                    matches!(base.host_str(), Some("127.0.0.1" | "localhost"))
                        && (base.path() == proxy_path || base.path().starts_with(&prefix))
                });
            if local_proxy {
                entry.insert("requires_openai_auth", value(false));
                entry.remove("experimental_bearer_token");
                entry.remove("env_key");
            }
        }
    }
    remove_auth(home)?;
    private_write(&config_file, document.to_string().as_bytes())
}

pub fn official_env_key(key: &str) -> bool {
    key.strip_prefix("OPENAI_").is_some_and(|suffix| {
        suffix
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    })
}
