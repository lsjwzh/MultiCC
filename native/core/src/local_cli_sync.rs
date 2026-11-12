//! "Sync to local terminal": write one provider's connection settings into the
//! user's own CLI config (`~/.claude/settings.json`, `~/.codex/config.toml`) so
//! a plain `claude` / `codex` started in a normal terminal uses that provider.
//!
//! This module owns the whole decision: which provider records are
//! syncable, how the local files are merged, backups, the match-back status
//! and the tiny state file that lets us undo a previous codex sync. The
//! gateway only resolves paths and turns the results into HTTP.
//!
//! Safety rules (see docs/gateway.md):
//! * every file we replace is copied to
//!   `<data_root>/local-cli-sync-backups/<timestamp>-<appType>/` first;
//! * writes are atomic and 0600;
//! * `~/.codex/auth.json` (the ChatGPT OAuth login) is never touched — the
//!   provider's API key is injected as `experimental_bearer_token` inside our
//!   own `[model_providers.multicc_sync]` table;
//! * OAuth account lines are rejected: their refresh tokens would invalidate
//!   each other when copied into the terminal.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Map, Value};
use toml_edit::{DocumentMut, Item, Table};

use crate::js::serde::js_string;
use crate::state_file;

/// Routing keys the terminal's own login must not keep when a provider is
/// synced (or when going back to the built-in official provider).
pub const ROUTING_ENV_KEYS: [&str; 9] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
];

/// The dedicated table name we write. A provider from cc-switch is usually
/// called `custom`; reusing that name would clobber an unrelated table the
/// user already has.
pub const CODEX_TABLE: &str = "multicc_sync";

const BACKUP_ROOT: &str = "local-cli-sync-backups";
const STATE_FILE: &str = "local-cli-sync-state.json";
const BACKUP_KEEP: usize = 20;

const OAUTH_MESSAGE: &str = "账号类线路的 OAuth 凭据不能复制到终端（刷新令牌会互相作废）";

static SERIAL: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl SyncError {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn not_found() -> Self {
        Self::new(404, "PROVIDER_NOT_FOUND", "供应商不存在")
    }

    fn oauth() -> Self {
        Self::new(422, "PROVIDER_UNSUPPORTED", OAUTH_MESSAGE)
    }

    fn io(what: &str, _error: &std::io::Error) -> Self {
        Self::new(500, "LOCAL_CLI_SYNC_FAILED", format!("{what}失败"))
    }
}

/// Where the two CLI config files live.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paths {
    pub claude: PathBuf,
    pub codex: PathBuf,
    pub codex_home: PathBuf,
}

/// `CLAUDE_CONFIG_DIR` replaces `~/.claude` and `CODEX_HOME` replaces
/// `~/.codex`, exactly like the CLIs themselves. Empty values fall back.
pub fn paths(home: &Path, claude_config_dir: Option<&Path>, codex_home: Option<&Path>) -> Paths {
    let claude_dir = claude_config_dir
        .filter(|path| !path.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".claude"));
    let codex_home = codex_home
        .filter(|path| !path.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".codex"));
    Paths {
        claude: claude_dir.join("settings.json"),
        codex: codex_home.join("config.toml"),
        codex_home,
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

pub fn paths_from_env(home: &Path) -> Paths {
    let claude = env_path("CLAUDE_CONFIG_DIR");
    let codex = env_path("CODEX_HOME");
    paths(home, claude.as_deref(), codex.as_deref())
}

/// `provider_store::records` is crate-private; callers outside the crate (the
/// gateway) get the same tolerant shape here. A corrupt/unreadable store means
/// "no match", never an error the page cannot render.
pub fn records_from_store(store: Option<&Value>) -> Vec<Value> {
    match store {
        None => vec![],
        Some(value) => value
            .as_array()
            .or_else(|| value.get("providers").and_then(Value::as_array))
            .cloned()
            .unwrap_or_default(),
    }
}

fn record_id(record: &Value) -> &str {
    record.get("id").and_then(Value::as_str).unwrap_or_default()
}

fn record_app_type(record: &Value) -> &str {
    record
        .get("appType")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// `settingsConfig` is usually an object but cc-switch imports sometimes keep
/// it as a JSON string; both are accepted, anything unparsable is `{}`.
fn settings_config(record: &Value) -> Map<String, Value> {
    match record.get("settingsConfig") {
        Some(Value::String(text)) => match crate::json_lenient::from_str::<Value>(text) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        },
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

fn object_of(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// String-valued `env` entries only: numbers/objects would not survive a plain
/// `KEY=value` environment and are not part of the CLI contract.
fn string_env(map: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in map {
        if let Some(text) = value.as_str() {
            out.insert(key.clone(), Value::String(text.to_string()));
        }
    }
    out
}

fn claude_env(record: &Value) -> Map<String, Value> {
    let config = settings_config(record);
    string_env(&object_of(config.get("env")))
}

fn env_text(env: &Map<String, Value>, key: &str) -> String {
    env.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn claude_credentials(env: &Map<String, Value>) -> (String, String) {
    let base = env_text(env, "ANTHROPIC_BASE_URL");
    let mut token = env_text(env, "ANTHROPIC_AUTH_TOKEN");
    if token.is_empty() {
        token = env_text(env, "ANTHROPIC_API_KEY");
    }
    (base, token)
}

fn normalized_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

fn credentials_match(
    (left_base, left_token): (&str, &str),
    (right_base, right_token): (&str, &str),
) -> bool {
    if normalized_url(left_base) != normalized_url(right_base) {
        return false;
    }
    // A provider without a credential matches on the URL alone; a provider
    // with one requires the local file to carry the exact same secret.
    right_token.is_empty() || left_token == right_token
}

enum ClaudeTarget {
    Official,
    Env(Map<String, Value>),
}

fn claude_target(records: &[Value], provider_id: &str) -> Result<ClaudeTarget, SyncError> {
    if provider_id == "claude-official" {
        return Ok(ClaudeTarget::Official);
    }
    let record = records
        .iter()
        .find(|record| record_id(record) == provider_id && record_app_type(record) == "claude")
        .ok_or_else(SyncError::not_found)?;
    let env = claude_env(record);
    let (base, token) = claude_credentials(&env);
    if base.is_empty() && token.is_empty() {
        return Err(SyncError::oauth());
    }
    let mut additions = Map::new();
    for (key, value) in env {
        if key.starts_with("MULTICC_") {
            continue;
        }
        if value.as_str().is_some_and(str::is_empty) {
            continue;
        }
        additions.insert(key, value);
    }
    Ok(ClaudeTarget::Env(additions))
}

fn parse_settings(text: &str) -> Result<Map<String, Value>, SyncError> {
    match crate::json_lenient::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(SyncError::new(
            409,
            "LOCAL_CONFIG_INVALID",
            "本地 Claude 配置不是有效的 JSON 对象，已停止同步（不会覆盖）",
        )),
    }
}

/// Strip the routing keys, then add the provider's own env. All other
/// top-level keys and non-routing env keys are preserved.
fn merge_claude_settings(
    existing: Option<&str>,
    target: &ClaudeTarget,
) -> Result<String, SyncError> {
    let mut root = match existing {
        Some(text) if !text.trim().is_empty() => parse_settings(text)?,
        _ => Map::new(),
    };
    let mut env = object_of(root.get("env"));
    for key in ROUTING_ENV_KEYS {
        env.remove(key);
    }
    if let ClaudeTarget::Env(additions) = target {
        for (key, value) in additions {
            env.insert(key.clone(), value.clone());
        }
    }
    if env.is_empty() {
        root.remove("env");
    } else {
        root.insert("env".into(), Value::Object(env));
    }
    let mut text = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|_| SyncError::new(500, "LOCAL_CLI_SYNC_FAILED", "生成 Claude 配置失败"))?;
    text.push('\n');
    Ok(text)
}

enum CodexTarget {
    Official,
    Provider { toml: String, api_key: String },
}

fn codex_target(records: &[Value], provider_id: &str) -> Result<CodexTarget, SyncError> {
    if provider_id == "codex-official" {
        return Ok(CodexTarget::Official);
    }
    let record = records
        .iter()
        .find(|record| record_id(record) == provider_id && record_app_type(record) == "codex")
        .ok_or_else(SyncError::not_found)?;
    let config = settings_config(record);
    let toml = config
        .get("config")
        .filter(|value| value.is_string())
        .map(|value| js_string(value))
        .unwrap_or_default();
    let auth = object_of(config.get("auth"));
    let api_key = auth
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let has_route = {
        match toml.parse::<DocumentMut>() {
            Ok(doc) => provider_table(&doc).is_some(),
            Err(_) => !toml.trim().is_empty(),
        }
    };
    if !has_route && api_key.is_empty() {
        return Err(SyncError::oauth());
    }
    Ok(CodexTarget::Provider { toml, api_key })
}

/// The single `[model_providers.<name>]` table of a provider config.
fn provider_table(doc: &DocumentMut) -> Option<Item> {
    let providers = doc.get("model_providers")?.as_table()?;
    let mut found = None;
    for (_, item) in providers.iter() {
        if let Some(table) = item.as_table() {
            if !table.is_empty() {
                found = Some(item.clone());
                break;
            }
        }
    }
    found
}

fn parse_codex(text: &str) -> Result<DocumentMut, SyncError> {
    if text.trim().is_empty() {
        return Ok(DocumentMut::new());
    }
    text.parse::<DocumentMut>().map_err(|_| {
        SyncError::new(
            409,
            "LOCAL_CONFIG_INVALID",
            "本地 Codex 配置不是有效的 TOML，已停止同步（不会覆盖）",
        )
    })
}

fn codex_state_path(data_root: &Path) -> PathBuf {
    data_root.join(STATE_FILE)
}

fn read_state(data_root: &Path) -> Map<String, Value> {
    let text = match fs::read_to_string(codex_state_path(data_root)) {
        Ok(text) => text,
        Err(_) => return Map::new(),
    };
    match crate::json_lenient::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn write_state(data_root: &Path, state: &Map<String, Value>) -> Result<(), SyncError> {
    let text = serde_json::to_string_pretty(&Value::Object(state.clone()))
        .map_err(|_| SyncError::new(500, "LOCAL_CLI_SYNC_FAILED", "生成同步状态失败"))?;
    state_file::write_text_atomic(
        &codex_state_path(data_root),
        &format!("{text}\n"),
        state_file::FILE_MODE,
        state_file::DIR_MODE,
    )
    .map_err(|error| SyncError::io("写入同步状态", &error))
}

/// The value a top-level key had before our sync, so official restore can put
/// it back.
fn previous_entry(doc: &DocumentMut, key: &str) -> Value {
    match doc.get(key) {
        Some(item) if !item.is_none() => {
            json!({ "present": true, "value": item.to_string().trim() })
        }
        _ => json!({ "present": false }),
    }
}

/// What we wrote for a top-level key; restore only touches a key that still
/// holds exactly this value, so later user edits survive.
fn applied_entry(doc: &DocumentMut, key: &str) -> Value {
    match doc.get(key) {
        Some(item) if !item.is_none() => Value::String(item.to_string().trim().to_string()),
        _ => Value::Null,
    }
}

/// Undo the top-level keys our previous sync wrote, unless the user edited
/// them since (comparing against what we last applied).
fn restore_previous(doc: &mut DocumentMut, entry: &Map<String, Value>) {
    let applied = object_of(entry.get("applied"));
    let previous = object_of(entry.get("previous"));
    for (key, applied_value) in &applied {
        let current = doc.get(key);
        let current_text = current
            .filter(|item| !item.is_none())
            .map(|item| item.to_string().trim().to_string());
        let matches = match (applied_value, current_text) {
            (Value::Null, None) => true,
            (Value::String(expected), Some(actual)) => expected == &actual,
            _ => false,
        };
        if !matches {
            continue;
        }
        match previous.get(key) {
            Some(Value::Object(entry)) if entry.get("present") == Some(&Value::Bool(true)) => {
                let text = entry
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Ok(value) = text.trim().parse::<toml_edit::Value>() {
                    doc[key.as_str()] = Item::Value(value);
                }
            }
            _ => {
                doc.as_table_mut().remove(key);
            }
        }
    }
}

fn remove_our_table(doc: &mut DocumentMut) {
    if let Some(providers) = doc.get_mut("model_providers").and_then(Item::as_table_mut) {
        providers.remove(CODEX_TABLE);
    }
}

fn provider_doc(text: &str) -> Result<DocumentMut, SyncError> {
    text.parse::<DocumentMut>().map_err(|_| {
        SyncError::new(
            422,
            "PROVIDER_UNSUPPORTED",
            "线路配置不是有效的 TOML，无法同步到终端",
        )
    })
}

fn apply_codex_provider(
    doc: &mut DocumentMut,
    provider_id: &str,
    provider_toml: &str,
    api_key: &str,
    codex_home: &Path,
    state: &mut Map<String, Value>,
) -> Result<(), SyncError> {
    let source = provider_doc(provider_toml)?;
    let table = provider_table(&source).ok_or_else(|| {
        SyncError::new(
            422,
            "PROVIDER_UNSUPPORTED",
            "线路配置没有 model_providers 表，无法同步到终端",
        )
    })?;

    // Copy every top-level scalar the provider sets, except the keys we own.
    let mut previous = Map::new();
    let mut applied = Map::new();
    let mut scalars = Vec::new();
    for (key, item) in source.iter() {
        if key == "model_providers" || !item.is_value() {
            continue;
        }
        if key == "model_provider" {
            continue;
        }
        if key == "model_catalog_json" {
            let catalog = item.as_str().unwrap_or_default();
            if catalog.is_empty() || !codex_home.join(catalog).is_file() {
                continue;
            }
        }
        scalars.push((key.to_string(), item.clone()));
    }
    for (key, item) in &scalars {
        previous.insert(key.clone(), previous_entry(doc, key));
        doc[key.as_str()] = item.clone();
    }
    for (key, _) in &scalars {
        applied.insert(key.clone(), applied_entry(doc, key));
    }
    // `model_provider` is owned by us: official restore removes it rather
    // than resurrecting whichever third-party name it had before.
    doc["model_provider"] = toml_edit::value(CODEX_TABLE);

    remove_our_table(doc);
    if doc.get("model_providers").is_none() {
        doc["model_providers"] = Item::Table(Table::new());
    }
    if let Some(providers) = doc.get_mut("model_providers").and_then(Item::as_table_mut) {
        providers.set_implicit(true);
    }
    let mut copied = table;
    if let Some(copied_table) = copied.as_table_mut() {
        copied_table.set_implicit(false);
        copied_table["requires_openai_auth"] = toml_edit::value(false);
        if api_key.is_empty() {
            copied_table.remove("experimental_bearer_token");
        } else {
            copied_table["experimental_bearer_token"] = toml_edit::value(api_key);
        }
    }
    if let Some(providers) = doc.get_mut("model_providers").and_then(Item::as_table_mut) {
        providers.insert(CODEX_TABLE, copied);
    }

    let mut entry = Map::new();
    entry.insert("providerId".into(), json!(provider_id));
    entry.insert("previous".into(), Value::Object(previous));
    entry.insert("applied".into(), Value::Object(applied));
    state.insert("codex".into(), Value::Object(entry));
    Ok(())
}

fn apply_codex_official(doc: &mut DocumentMut, state: &mut Map<String, Value>) {
    if let Some(Value::Object(entry)) = state.get("codex") {
        restore_previous(doc, entry);
    }
    if doc.get("model_provider").and_then(Item::as_str) == Some(CODEX_TABLE) {
        doc.as_table_mut().remove("model_provider");
    }
    remove_our_table(doc);
    state.remove("codex");
}

fn merge_codex_config(
    existing: Option<&str>,
    provider_id: &str,
    target: &CodexTarget,
    codex_home: &Path,
    data_root: &Path,
) -> Result<String, SyncError> {
    let mut doc = parse_codex(existing.unwrap_or_default())?;
    let original_state = read_state(data_root);
    let mut state = original_state.clone();
    // Always undo our previous sync first, so switching A -> B -> official
    // restores the user's own values exactly once.
    if let Some(Value::Object(entry)) = state.get("codex").cloned() {
        restore_previous(&mut doc, &entry);
    }
    match target {
        CodexTarget::Official => apply_codex_official(&mut doc, &mut state),
        CodexTarget::Provider { toml, api_key } => {
            apply_codex_provider(&mut doc, provider_id, toml, api_key, codex_home, &mut state)?
        }
    }
    if state != original_state {
        write_state(data_root, &state)?;
    }
    let mut text = doc.to_string();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    Ok(text)
}

// ── status ──────────────────────────────────────────────────────────────────

fn read_text(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn claude_status(path: &Path, records: &[Value]) -> Value {
    let mut out = Map::new();
    out.insert("configPath".into(), json!(path.to_string_lossy()));
    let Some(text) = read_text(path) else {
        out.insert("providerId".into(), json!("claude-official"));
        out.insert("state".into(), json!("official"));
        return Value::Object(out);
    };
    let env = match crate::json_lenient::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => string_env(&object_of(map.get("env"))),
        _ => {
            out.insert("providerId".into(), Value::Null);
            out.insert("state".into(), json!("unknown"));
            return Value::Object(out);
        }
    };
    let (base, token) = claude_credentials(&env);
    if base.is_empty() && token.is_empty() {
        out.insert("providerId".into(), json!("claude-official"));
        out.insert("state".into(), json!("official"));
        return Value::Object(out);
    }
    let local = (base.as_str(), token.as_str());
    let matched = records.iter().find_map(|record| {
        if record_app_type(record) != "claude" {
            return None;
        }
        let provider_env = claude_env(record);
        let provider = claude_credentials(&provider_env);
        if provider.0.is_empty() && provider.1.is_empty() {
            return None;
        }
        credentials_match(local, (provider.0.as_str(), provider.1.as_str()))
            .then(|| record_id(record).to_string())
    });
    match matched {
        Some(id) => {
            out.insert("providerId".into(), json!(id));
            out.insert("state".into(), json!("provider"));
        }
        None => {
            out.insert("providerId".into(), Value::Null);
            out.insert("state".into(), json!("unknown"));
        }
    }
    if !base.is_empty() {
        out.insert("baseUrl".into(), json!(base));
    }
    Value::Object(out)
}

fn codex_status(path: &Path, records: &[Value]) -> Value {
    let mut out = Map::new();
    out.insert("configPath".into(), json!(path.to_string_lossy()));
    let Some(text) = read_text(path) else {
        out.insert("providerId".into(), json!("codex-official"));
        out.insert("state".into(), json!("official"));
        return Value::Object(out);
    };
    let doc = match parse_codex(&text) {
        Ok(doc) => doc,
        Err(_) => {
            out.insert("providerId".into(), Value::Null);
            out.insert("state".into(), json!("unknown"));
            return Value::Object(out);
        }
    };
    let name = doc
        .get("model_provider")
        .and_then(Item::as_str)
        .unwrap_or_default();
    if name.is_empty() || name == "openai" {
        out.insert("providerId".into(), json!("codex-official"));
        out.insert("state".into(), json!("official"));
        return Value::Object(out);
    }
    let table = doc
        .get("model_providers")
        .and_then(Item::as_table)
        .and_then(|providers| providers.get(name))
        .and_then(Item::as_table);
    let base = table
        .and_then(|table| table.get("base_url"))
        .and_then(Item::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let token = table
        .and_then(|table| table.get("experimental_bearer_token"))
        .and_then(Item::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let matched = records.iter().find_map(|record| {
        if record_app_type(record) != "codex" {
            return None;
        }
        let target = codex_target(std::slice::from_ref(record), record_id(record)).ok()?;
        let CodexTarget::Provider { toml, api_key } = target else {
            return None;
        };
        let source = provider_doc(&toml).ok()?;
        let source_table = provider_table(&source)?;
        let source_table = source_table.as_table()?;
        let provider_base = source_table
            .get("base_url")
            .and_then(Item::as_str)
            .unwrap_or_default();
        if provider_base.is_empty()
            || !credentials_match(
                (base.as_str(), token.as_str()),
                (provider_base, api_key.as_str()),
            )
        {
            return None;
        }
        Some(record_id(record).to_string())
    });
    match matched {
        Some(id) => {
            out.insert("providerId".into(), json!(id));
            out.insert("state".into(), json!("provider"));
        }
        None => {
            out.insert("providerId".into(), Value::Null);
            out.insert("state".into(), json!("unknown"));
        }
    }
    if !base.is_empty() {
        out.insert("baseUrl".into(), json!(base));
    }
    Value::Object(out)
}

/// `GET /api/providers/local-cli`. Never returns credentials.
pub fn local_state(paths: &Paths, records: &[Value]) -> Value {
    json!({
        "claude": claude_status(&paths.claude, records),
        "codex": codex_status(&paths.codex, records),
    })
}

// ── sync ────────────────────────────────────────────────────────────────────

pub struct SyncRequest<'a> {
    pub data_root: &'a Path,
    pub paths: &'a Paths,
    pub records: &'a [Value],
    pub app_type: &'a str,
    pub provider_id: &'a str,
}

#[derive(Debug)]
pub struct SyncReport {
    /// Target config files (always one today). These are the files the caller
    /// should show to the user; `changed` says whether bytes were replaced.
    pub files: Vec<PathBuf>,
    pub backup_dir: Option<PathBuf>,
    pub changed: bool,
}

fn now_stamp() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ").to_string()
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

fn copy_private(source: &Path, target: &Path) -> std::io::Result<()> {
    let bytes = fs::read(source)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut handle = options.open(target)?;
    handle.write_all(&bytes)?;
    handle.sync_all()?;
    set_mode(target, 0o600)
}

/// Copy every existing file we are about to replace into a fresh 0700 backup
/// directory, then keep only the newest [`BACKUP_KEEP`] directories.
fn create_backup(
    data_root: &Path,
    app_type: &str,
    files: &[PathBuf],
) -> Result<PathBuf, SyncError> {
    let root = data_root.join(BACKUP_ROOT);
    fs::create_dir_all(&root).map_err(|error| SyncError::io("创建备份目录", &error))?;
    set_mode(&root, 0o700).map_err(|error| SyncError::io("设置备份目录权限", &error))?;
    let stamp = now_stamp();
    let mut candidate = root.join(format!("{stamp}-{app_type}"));
    let mut serial = SERIAL.fetch_add(1, Ordering::Relaxed);
    while candidate.exists() {
        candidate = root.join(format!("{stamp}-{app_type}-{serial}"));
        serial += 1;
    }
    fs::create_dir(&candidate).map_err(|error| SyncError::io("创建备份目录", &error))?;
    set_mode(&candidate, 0o700).map_err(|error| SyncError::io("设置备份目录权限", &error))?;
    let mut manifest = Vec::new();
    for file in files {
        let existed = file.is_file();
        let name = file
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("file-{}", manifest.len()));
        if existed {
            copy_private(file, &candidate.join(&name))
                .map_err(|error| SyncError::io("备份本地配置", &error))?;
        }
        manifest
            .push(json!({ "path": file.to_string_lossy(), "existed": existed, "backup": name }));
    }
    let text = serde_json::to_string_pretty(&Value::Array(manifest))
        .map_err(|_| SyncError::new(500, "LOCAL_CLI_SYNC_FAILED", "生成备份清单失败"))?;
    state_file::write_text_atomic(
        &candidate.join("manifest.json"),
        &format!("{text}\n"),
        0o600,
        0o700,
    )
    .map_err(|error| SyncError::io("写入备份清单", &error))?;
    prune_backups(&root);
    Ok(candidate)
}

fn prune_backups(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut names: Vec<std::ffi::OsString> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name())
        .collect();
    names.sort();
    if names.len() <= BACKUP_KEEP {
        return;
    }
    let drop = names.len() - BACKUP_KEEP;
    for name in names.into_iter().take(drop) {
        let _ = fs::remove_dir_all(root.join(name));
    }
}

fn write_private(path: &Path, text: &str) -> Result<(), SyncError> {
    state_file::write_text_atomic(path, text, 0o600, 0o700)
        .map_err(|error| SyncError::io("写入本地配置", &error))
}

/// `POST /api/providers/:appType/:id/sync-local`.
pub fn sync(request: &SyncRequest<'_>) -> Result<SyncReport, SyncError> {
    let paths = request.paths;
    let (path, next) = match request.app_type {
        "claude" => {
            let target = claude_target(request.records, request.provider_id)?;
            let existing = read_optional(&paths.claude)?;
            (
                paths.claude.clone(),
                merge_claude_settings(existing.as_deref(), &target)?,
            )
        }
        "codex" => {
            let target = codex_target(request.records, request.provider_id)?;
            let existing = read_optional(&paths.codex)?;
            (
                paths.codex.clone(),
                merge_codex_config(
                    existing.as_deref(),
                    request.provider_id,
                    &target,
                    &paths.codex_home,
                    request.data_root,
                )?,
            )
        }
        _ => return Err(SyncError::not_found()),
    };
    let changed = read_optional(&path)?.as_deref() != Some(next.as_str());
    let files = vec![path.clone()];
    if !changed {
        return Ok(SyncReport {
            files,
            backup_dir: None,
            changed: false,
        });
    }
    let backup_dir = create_backup(request.data_root, request.app_type, &files)?;
    write_private(&path, &next)?;
    Ok(SyncReport {
        files,
        backup_dir: Some(backup_dir),
        changed: true,
    })
}

fn read_optional(path: &Path) -> Result<Option<String>, SyncError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(SyncError::io("读取本地配置", &error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "multicc-local-cli-sync-{}-{tag}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn claude_record(id: &str, base: &str, token: &str) -> Value {
        json!({
            "id": id,
            "appType": "claude",
            "name": id,
            "settingsConfig": { "env": {
                "ANTHROPIC_BASE_URL": base,
                "ANTHROPIC_AUTH_TOKEN": token,
                "ANTHROPIC_MODEL": "claude-sonnet-5",
                "MULTICC_KEEP_OUT": "1",
                "EMPTY": ""
            }}
        })
    }

    fn codex_record(id: &str, base: &str, key: &str) -> Value {
        json!({
            "id": id,
            "appType": "codex",
            "name": id,
            "settingsConfig": {
                "auth": { "OPENAI_API_KEY": key },
                "config": format!(
                    "model_provider = \"custom\"\nmodel = \"deepseek-v4-pro\"\nmodel_catalog_json = \"cc-switch-model-catalog.json\"\n\n[model_providers.custom]\nname = \"DeepSeek\"\nbase_url = \"{base}\"\nwire_api = \"responses\"\nrequires_openai_auth = true\n"
                )
            }
        })
    }

    fn sync_at(request: &SyncRequest<'_>) -> Result<SyncReport, SyncError> {
        sync(request)
    }

    fn write_settings(home: &Path, text: &str) {
        let dir = home.join("claude-config");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("settings.json"), text).unwrap();
        let codex = home.join("codex-home");
        fs::create_dir_all(&codex).unwrap();
    }

    #[test]
    fn claude_merge_strips_routing_keeps_other_keys_and_skips_multicc() {
        let merged = merge_claude_settings(
            Some(
                r#"{"theme":"dark","env":{"ANTHROPIC_BASE_URL":"https://old","ANTHROPIC_MODEL":"old-model","ANTHROPIC_AUTH_TOKEN":"old","KEEP":"yes"},"permissions":{"allow":["Bash"]}}"#,
            ),
            &match claude_target(&[claude_record("p1", "https://new", "tok")], "p1").unwrap() {
                ClaudeTarget::Env(env) => ClaudeTarget::Env(env),
                ClaudeTarget::Official => panic!("expected a provider target"),
            },
        )
        .unwrap();
        let value: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["permissions"]["allow"][0], "Bash");
        assert_eq!(value["env"]["KEEP"], "yes");
        assert_eq!(value["env"]["ANTHROPIC_BASE_URL"], "https://new");
        assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], "tok");
        assert_eq!(value["env"]["ANTHROPIC_MODEL"], "claude-sonnet-5");
        assert!(value["env"].get("MULTICC_KEEP_OUT").is_none());
        assert!(value["env"].get("EMPTY").is_none());
    }

    #[test]
    fn claude_official_removes_the_whole_env_when_only_routing_was_left() {
        let merged = merge_claude_settings(
            Some(r#"{"env":{"ANTHROPIC_BASE_URL":"https://old","ANTHROPIC_MODEL":"m"}}"#),
            &ClaudeTarget::Official,
        )
        .unwrap();
        let value: Value = serde_json::from_str(&merged).unwrap();
        assert!(value.get("env").is_none());
        assert_eq!(value, json!({}));
    }

    #[test]
    fn claude_invalid_json_is_refused_and_file_untouched() {
        let merged = merge_claude_settings(Some("{not json"), &ClaudeTarget::Official);
        let error = merged.unwrap_err();
        assert_eq!(error.status, 409);
        assert_eq!(error.code, "LOCAL_CONFIG_INVALID");
    }

    #[test]
    fn oauth_account_lines_are_rejected_for_both_clis() {
        let claude = json!({"id":"acct","appType":"claude","settingsConfig":{"env":{"ANTHROPIC_MODEL":"m"}}});
        assert_eq!(claude_target(&[claude], "acct").err().unwrap().status, 422);
        let codex = json!({"id":"acct","appType":"codex","settingsConfig":{"auth":{},"config":""}});
        assert_eq!(codex_target(&[codex], "acct").err().unwrap().status, 422);
        assert_eq!(
            codex_target(&[], "missing").err().unwrap().code,
            "PROVIDER_NOT_FOUND"
        );
    }

    #[test]
    fn claude_api_key_only_provider_is_supported() {
        let record = json!({"id":"api","appType":"claude","settingsConfig":{"env":{"ANTHROPIC_API_KEY":"sk-ant"}}});
        match claude_target(&[record], "api").unwrap() {
            ClaudeTarget::Env(env) => assert_eq!(env["ANTHROPIC_API_KEY"], "sk-ant"),
            ClaudeTarget::Official => panic!("expected a provider target"),
        }
    }

    #[test]
    fn codex_sync_adds_our_table_and_restores_on_official() {
        let dir = temp("codex");
        let data = dir.join("data");
        fs::create_dir_all(&data).unwrap();
        let home = dir.join("home");
        fs::create_dir_all(home.join("codex-home")).unwrap();
        fs::write(
            home.join("codex-home").join("config.toml"),
            "# keep me\nmodel = \"user-model\"\n\n[projects.\"/work\"]\ntrust_level = \"trusted\"\n\n[mcp_servers.x]\ncommand = \"npx\"\n",
        )
        .unwrap();
        fs::write(
            home.join("codex-home").join("auth.json"),
            r#"{"tokens":{"access_token":"oauth"}}"#,
        )
        .unwrap();
        fs::write(
            home.join("codex-home").join("cc-switch-model-catalog.json"),
            "[]",
        )
        .unwrap();
        let records = vec![codex_record("p1", "https://api.deepseek.com", "sk-key")];

        // `paths_from_env` reads the process environment; drive the test
        // through the merge helper with explicit paths instead.
        let existing = fs::read_to_string(home.join("codex-home").join("config.toml")).unwrap();
        let target = match codex_target(&records, "p1").unwrap() {
            CodexTarget::Provider { toml, api_key } => CodexTarget::Provider { toml, api_key },
            CodexTarget::Official => unreachable!(),
        };
        let text = merge_codex_config(
            Some(&existing),
            "p1",
            &target,
            &home.join("codex-home"),
            &data,
        )
        .unwrap();
        fs::write(home.join("codex-home").join("config.toml"), &text).unwrap();
        assert!(text.contains("# keep me"));
        assert!(text.contains("[projects.\"/work\"]"));
        assert!(text.contains("[mcp_servers.x]"));
        assert!(text.contains("model_provider = \"multicc_sync\""));
        assert!(text.contains("model = \"deepseek-v4-pro\""));
        assert!(text.contains("[model_providers.multicc_sync]"));
        assert!(text.contains("requires_openai_auth = false"));
        assert!(text.contains("experimental_bearer_token = \"sk-key\""));
        assert!(text.contains("model_catalog_json = \"cc-switch-model-catalog.json\""));
        // auth.json is never part of the sync.
        assert_eq!(
            fs::read_to_string(home.join("codex-home").join("auth.json")).unwrap(),
            r#"{"tokens":{"access_token":"oauth"}}"#
        );

        let back = merge_codex_config(
            Some(&text),
            "codex-official",
            &CodexTarget::Official,
            &home.join("codex-home"),
            &data,
        )
        .unwrap();
        assert!(back.contains("# keep me"));
        assert!(back.contains("[projects.\"/work\"]"));
        assert!(!back.contains("[model_providers.multicc_sync]"));
        assert!(!back.contains("model_provider"));
        assert!(back.contains("model = \"user-model\""));
        assert!(!back.contains("model_catalog_json"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn codex_missing_catalog_file_drops_the_key() {
        let dir = temp("catalog");
        let data = dir.join("data");
        fs::create_dir_all(&data).unwrap();
        let home = dir.join("home");
        fs::create_dir_all(home.join("codex-home")).unwrap();
        let records = vec![codex_record("p1", "https://api.deepseek.com", "k")];
        let target = codex_target(&records, "p1").unwrap();
        let text = merge_codex_config(
            Some("model = \"mine\"\n"),
            "p1",
            &target,
            &home.join("codex-home"),
            &data,
        )
        .unwrap();
        assert!(!text.contains("model_catalog_json"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn codex_invalid_toml_is_refused() {
        let target = CodexTarget::Official;
        let dir = temp("bad-toml");
        let error = merge_codex_config(Some("[not closed"), "codex-official", &target, &dir, &dir)
            .unwrap_err();
        assert_eq!(error.status, 409);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn backups_are_created_private_and_pruned_to_the_newest_twenty() {
        let dir = temp("backup");
        let data = dir.join("data");
        fs::create_dir_all(&data).unwrap();
        let file = dir.join("settings.json");
        fs::write(&file, "{}").unwrap();
        for index in 0..25 {
            let dir = create_backup(&data, "claude", &[file.clone()]).unwrap();
            assert!(dir.join("settings.json").is_file());
            if index == 0 {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
                    assert_eq!(mode, 0o700);
                    let mode = fs::metadata(dir.join("settings.json"))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777;
                    assert_eq!(mode, 0o600);
                }
            }
        }
        let kept = fs::read_dir(data.join(BACKUP_ROOT)).unwrap().count();
        assert_eq!(kept, BACKUP_KEEP);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn status_matches_by_url_and_credential_without_leaking_secrets() {
        let dir = temp("status");
        let home = dir.join("home");
        write_settings(
            &home,
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://relay/","ANTHROPIC_AUTH_TOKEN":"tok"}}"#,
        );
        let records = vec![claude_record("p1", "https://relay", "tok")];
        let paths = paths(
            &home,
            Some(&home.join("claude-config")),
            Some(&home.join("codex-home")),
        );
        let state = claude_status(&paths.claude, &records);
        assert_eq!(state["state"], "provider");
        assert_eq!(state["providerId"], "p1");
        assert_eq!(state["baseUrl"], "https://relay/");
        assert!(!state.to_string().contains("tok"));

        // A different token must not match (and must not be printed).
        let records = vec![claude_record("p1", "https://relay", "other")];
        let state = claude_status(&paths.claude, &records);
        assert_eq!(state["state"], "unknown");
        assert!(state["providerId"].is_null());

        // No routing keys -> the terminal's own login.
        fs::write(
            home.join("claude-config").join("settings.json"),
            r#"{"env":{"FOO":"1"}}"#,
        )
        .unwrap();
        let state = claude_status(&paths.claude, &records);
        assert_eq!(state["state"], "official");
        assert_eq!(state["providerId"], "claude-official");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sync_writes_files_atomically_and_reports_them() {
        let dir = temp("sync");
        let data = dir.join("data");
        let home = dir.join("home");
        fs::create_dir_all(home.join("claude-config")).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(
            home.join("claude-config").join("settings.json"),
            r#"{"theme":"dark","env":{"KEEP":"1","ANTHROPIC_BASE_URL":"https://old"}}"#,
        )
        .unwrap();
        let records = vec![claude_record("p1", "https://relay", "tok")];
        let paths = paths(
            &home,
            Some(&home.join("claude-config")),
            Some(&home.join("codex-home")),
        );
        let request = SyncRequest {
            data_root: &data,
            paths: &paths,
            records: &records,
            app_type: "claude",
            provider_id: "p1",
        };
        let report = sync_at(&request).unwrap();
        assert!(report.changed);
        assert_eq!(
            report.files,
            vec![home.join("claude-config").join("settings.json")]
        );
        let written = fs::read_to_string(&report.files[0]).unwrap();
        let value: Value = serde_json::from_str(&written).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["env"]["KEEP"], "1");
        assert_eq!(value["env"]["ANTHROPIC_BASE_URL"], "https://relay");
        assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], "tok");
        let backup = report.backup_dir.unwrap();
        assert!(backup.join("settings.json").is_file());
        assert!(backup.join("manifest.json").is_file());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sync_is_idempotent_and_skips_the_backup() {
        let dir = temp("idempotent");
        let data = dir.join("data");
        let home = dir.join("home");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&home).unwrap();
        let records = vec![claude_record("p1", "https://relay", "tok")];
        let paths = Paths {
            claude: home.join("settings.json"),
            codex: home.join("config.toml"),
            codex_home: home.to_path_buf(),
        };
        let request = SyncRequest {
            data_root: &data,
            paths: &paths,
            records: &records,
            app_type: "claude",
            provider_id: "p1",
        };
        assert!(sync_at(&request).unwrap().changed);
        let second = sync_at(&request).unwrap();
        assert!(!second.changed);
        assert!(second.backup_dir.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn paths_honour_the_cli_overrides() {
        let home = Path::new("/home/u");
        let overridden = paths(
            home,
            Some(Path::new("/cfg/claude")),
            Some(Path::new("/cfg/codex")),
        );
        assert_eq!(
            overridden.claude,
            PathBuf::from("/cfg/claude/settings.json")
        );
        assert_eq!(overridden.codex, PathBuf::from("/cfg/codex/config.toml"));
        let defaults = paths(home, None, None);
        assert_eq!(
            defaults.claude,
            PathBuf::from("/home/u/.claude/settings.json")
        );
        assert_eq!(defaults.codex, PathBuf::from("/home/u/.codex/config.toml"));
    }
}
