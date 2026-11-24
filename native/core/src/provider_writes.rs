//! The provider store's write decisions, retired from `src/providers/core.js`:
//! `createProvider`, `updateProvider`, `deleteProvider` and the virtual-line
//! save they share.
//!
//! Each entry takes the current record list plus the facts the Node host had to
//! resolve for it (whether an official catalog is mounted, whether this id is an
//! official one, the virtual-line plan) and returns the *next* list together
//! with the DTO the caller returned before. Nothing here touches the filesystem:
//! the store is already Rust-owned (`provider_store`), and keeping the decision
//! pure is what lets the differential feed both implementations the same list.
//!
//! Facts that stay on the host, and why:
//!   * `official_catalog_mounted` / `official_id` / `record_is_official` --
//!     `src/providers/official-catalog.js` and `src/codex/official-relay.js` are
//!     their own cluster with other consumers; this module consumes their
//!     verdict rather than re-deriving it.
//!   * the virtual-line plan -- already Rust, reached through
//!     `validateVirtualProvider`, which needs the full provider list.

use serde_json::{json, Map, Value};

use crate::js::js_trim;
use crate::js::serde::{js_string, truthy};
use crate::provider_settings_config::{
    assert_api_format_matches_app_type, build_settings_config, normalize_api_format, SettingsInput,
};

pub const APP_TYPES: [&str; 2] = ["claude", "codex"];

/// A dedicated egress only means something for an OAuth-managed official entry.
pub const EGRESS_ONLY_ON_OFFICIAL: &str = "专用出口只能绑在 Claude 官方账号线路上";
pub const NAME_REQUIRED: &str = "name required";
pub const APP_TYPE_REQUIRED: &str = "appType must be claude or codex";
pub const PROVIDER_NOT_FOUND: &str = "provider not found";
pub const OFFICIAL_IS_OAUTH_MANAGED: &str = "请在官方账号中管理登录和切换账号";
pub const VIRTUAL_IS_NOT_CONVERTIBLE: &str = "普通线路不能直接转换成虚拟线路，请新建组合";
pub const CLI_RELAY_FLAG_INVALID: &str = "cliRelay 必须是布尔值";

/// What the caller must still do once the decision is made. The host performs
/// these in the order the retired code did.
#[derive(Debug, Clone, PartialEq)]
pub enum Commit {
    /// Persist `records` (the full next list) and answer with `result`.
    Save { records: Value, result: Value },
    /// Nothing changed; answer with `result` without writing.
    Answer { result: Value },
    /// The assembled record turned out to be the official line: answer with the
    /// catalog's own entry instead of storing a duplicate.
    OfficialCatalogEntry { app_type: String },
    /// The name check passed and the virtual-line plan is now required. The
    /// host resolves it (`virtual-provider.validate`, which needs the full
    /// provider list) and calls the same entry again with `virtualPlan` filled
    /// in. It is a second phase rather than an up-front fact because that
    /// validation can throw, and every guard that precedes it here -- the name
    /// check, and `updateProvider`'s "a normal line can't become virtual" --
    /// has to win first.
    NeedsVirtualPlan,
    /// An official id: let the catalog delete it, then drop the leftover
    /// override record from `records` when `records_changed` is true.
    OfficialDelete {
        app_type: String,
        id: String,
        records: Value,
        records_changed: bool,
    },
}

fn field<'a>(input: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    input.get(name).filter(|value| !value.is_null())
}

/// `value !== undefined` in the retired signatures: an absent key. A JSON `null`
/// arrives where JavaScript saw `null`, which those checks treated as *present*
/// (only `egressIpAllowlist` and `egressBinding` read `null` specially).
fn present<'a>(input: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    input.get(name)
}

fn text_of(input: &Map<String, Value>, name: &str) -> String {
    match field(input, name) {
        Some(value) => js_string(value),
        None => String::new(),
    }
}

fn records_of(records: &Value) -> Vec<Value> {
    records.as_array().cloned().unwrap_or_default()
}

fn record_matches(record: &Value, app_type: &str, id: &str) -> bool {
    record.get("appType").and_then(Value::as_str) == Some(app_type)
        && record.get("id").and_then(Value::as_str) == Some(id)
}

/// `normalizeEgressIpAllowlist` (= `egress-ip-policy.js`'s `normalizeAllowlist`):
/// trim, drop empties, de-duplicate. It deliberately does *not* validate the
/// addresses -- the route-level validator
/// (`provider_registry::parse_egress_ip_allowlist`) already rejected malformed
/// input with a 400, and a stored list is kept verbatim so a legacy record never
/// silently loses entries here.
pub fn normalize_egress_ip_allowlist(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        // `clean`: `value == null ? '' : String(value).trim()`, so `null` and
        // `undefined` blank out while `0`/`false` stringify and survive.
        let text = match item {
            Value::Null => String::new(),
            value => js_string(value),
        };
        let text = js_trim(&text);
        if text.is_empty() || out.iter().any(|kept| kept == text) {
            continue;
        }
        out.push(text.to_string());
    }
    out
}

/// `normalizeEgressBinding`: `undefined`/`null` pass straight through (absent
/// leaves the stored binding alone, `null` clears it), anything else must be an
/// object carrying two well-formed ids.
pub fn normalize_egress_binding(value: Option<&Value>) -> Result<Option<Value>, String> {
    let value = match value {
        None => return Ok(None),
        Some(Value::Null) => return Ok(Some(Value::Null)),
        Some(value) => value,
    };
    let Value::Object(fields) = value else {
        return Err("egressBinding must be an object".to_string());
    };
    let plugin_id = js_string(fields.get("pluginId").unwrap_or(&Value::Null));
    let plugin_id = js_trim(&plugin_id);
    let profile_id = js_string(fields.get("profileId").unwrap_or(&Value::Null));
    let profile_id = js_trim(&profile_id);
    if !is_egress_id(plugin_id) || !is_egress_id(profile_id) {
        return Err("egressBinding needs a valid pluginId and profileId".to_string());
    }
    Ok(Some(
        json!({ "pluginId": plugin_id, "profileId": profile_id }),
    ))
}

/// `EGRESS_PLUGIN_PATTERN` / `EGRESS_PROFILE_PATTERN`, both
/// `/^[a-z0-9][a-z0-9._-]*$/i`: an alphanumeric lead, then any of
/// `[a-z0-9._-]`, case-insensitive and unbounded in length.
fn is_egress_id(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// The facts the host resolves before a write decision can be made.
#[derive(Debug, Clone, Default)]
pub struct WriteFacts {
    /// `officialCatalog` is mounted at all.
    pub official_catalog_mounted: bool,
    /// `isOfficialProviderId(appType, id)` for the id as submitted.
    pub id_is_official: bool,
    /// `isOfficialProviderId(appType, officialCatalog.normalize(appType, id))`,
    /// i.e. the id resolves to an official entry through its alias.
    pub normalized_id_is_official: bool,
    /// `officialCatalog.normalize(appType, id)` -- the id the override record is
    /// keyed by when the submitted one was an alias.
    pub normalized_id: Option<String>,
    /// `require('./official-catalog').isOfficial(record)` for a record this
    /// module just assembled (create only).
    pub assembled_is_official: bool,
    /// A fresh `crypto.randomUUID()`. Supplied by the host so the decision stays
    /// pure and the differential can pin it.
    pub new_id: String,
    /// `Date.now()`, for the same reason.
    pub now_ms: f64,
    /// The loopback port `buildSettingsConfig` embeds in a Codex proxy base url.
    pub port: String,
    /// `require('./virtual-provider').validate(...)`'s plan: `{ virtual, models }`.
    /// Already Rust, but reached through the host because it needs the full
    /// provider list.
    pub virtual_plan: Option<Value>,
}

/// The record `createProvider` would assemble, with no commit attached.
///
/// The host needs it to answer one fact the decision then consumes --
/// `official-catalog.isOfficial(record)`, whose Codex half lives in
/// `src/codex/official-relay.js` -- so this is exposed separately and
/// `create_provider` is called again with the verdict filled in. Both calls are
/// pure and driven by the same `facts`, so the second assembly is identical to
/// the one the host inspected.
///
/// `Ok(None)` means the virtual branch owns this call and no record is assembled.
pub fn assemble_create_record(
    input: &Map<String, Value>,
    facts: &WriteFacts,
) -> Result<Option<Value>, String> {
    if present(input, "virtual").is_some() {
        return Ok(None);
    }
    let app_type = text_of(input, "appType");
    if !APP_TYPES.contains(&app_type.as_str()) {
        return Err(APP_TYPE_REQUIRED.to_string());
    }
    let name = field(input, "name");
    let name_text = name.map(js_string).unwrap_or_default();
    if name.is_none_or(|value| !truthy(value)) || js_trim(&name_text).is_empty() {
        return Err(NAME_REQUIRED.to_string());
    }
    // Official entries are never created here (they come from the account
    // catalog), so a brand-new provider can't own a dedicated egress.
    if present(input, "egressBinding").is_some() {
        return Err(EGRESS_ONLY_ON_OFFICIAL.to_string());
    }
    let api_format = present(input, "apiFormat");
    assert_api_format_matches_app_type(api_format, Some(&app_type))?;

    // The id is generated first so the settings builder can embed it in the
    // Codex proxy base url.
    let id = facts.new_id.clone();
    let mut config = match field(input, "settingsConfig") {
        Some(value @ Value::Object(_)) => value.clone(),
        _ => build_settings_config(
            Some(&app_type),
            &SettingsInput {
                base_url: field(input, "baseUrl"),
                auth_token: field(input, "authToken"),
                model: field(input, "model"),
                models: field(input, "models"),
                provider_id: Some(&Value::String(id.clone())),
                alias_map: field(input, "aliasMap"),
                port: facts.port.clone(),
            },
        ),
    };
    apply_cli_relay_flag(&mut config, input)?;
    let format = normalize_api_format(api_format, Some(&app_type));

    let mut record = Map::new();
    record.insert("id".to_string(), Value::String(id));
    record.insert("appType".to_string(), Value::String(app_type));
    record.insert("apiFormat".to_string(), Value::String(format.to_string()));
    record.insert(
        "name".to_string(),
        Value::String(js_trim(&name_text).to_string()),
    );
    record.insert("source".to_string(), Value::String("local".to_string()));
    record.insert("settingsConfig".to_string(), config);
    record.insert("createdAt".to_string(), json!(facts.now_ms));
    let allowlist = normalize_egress_ip_allowlist(field(input, "egressIpAllowlist"));
    if !allowlist.is_empty() {
        record.insert("egressIpAllowlist".to_string(), json!(allowlist));
    }
    Ok(Some(Value::Object(record)))
}

/// `createProvider`.
pub fn create_provider(
    records: &Value,
    input: &Map<String, Value>,
    facts: &WriteFacts,
) -> Result<Commit, String> {
    // The virtual branch comes first and returns before every other check --
    // including the appType guard, which `saveVirtualProvider` repeats only as a
    // name check.
    let Some(record) = assemble_create_record(input, facts)? else {
        return save_virtual_provider(
            records,
            &text_of(input, "appType"),
            &facts.new_id,
            field(input, "name"),
            facts.virtual_plan.as_ref(),
            facts,
        );
    };
    // A record that is indistinguishable from the official line is the official
    // line: answer with the catalog's entry instead of storing a duplicate.
    let app_type = text_of(input, "appType");
    if facts.official_catalog_mounted && facts.assembled_is_official {
        return Ok(Commit::OfficialCatalogEntry { app_type });
    }
    let id = record.get("id").cloned().unwrap_or(Value::Null);
    let name = record.get("name").cloned().unwrap_or(Value::Null);
    let mut next = records_of(records);
    next.push(record);
    Ok(Commit::Save {
        records: Value::Array(next),
        result: json!({ "id": id, "appType": app_type, "name": name }),
    })
}

/// `saveVirtualProvider`. The membership plan is validated by the host (through
/// the already-Rust `validateVirtualProvider`) because it needs the full
/// provider list; the record shape and the replace-or-append are decided here.
pub fn save_virtual_provider(
    records: &Value,
    app_type: &str,
    id: &str,
    name: Option<&Value>,
    plan: Option<&Value>,
    facts: &WriteFacts,
) -> Result<Commit, String> {
    let name_text = name.map(js_string).unwrap_or_default();
    if js_trim(&name_text).is_empty() {
        return Err(NAME_REQUIRED.to_string());
    }
    // A `null` plan is "not resolved yet" as well: it must never be persisted as
    // a member-less virtual line.
    let Some(plan) = plan.filter(|plan| !plan.is_null()) else {
        return Ok(Commit::NeedsVirtualPlan);
    };
    let plan = plan.clone();
    let models = plan
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let first_model = models
        .first()
        .cloned()
        .unwrap_or(Value::String(String::new()));

    let list = records_of(records);
    let previous = list
        .iter()
        .find(|record| record_matches(record, app_type, id));
    let created_at = previous
        .and_then(|record| record.get("createdAt"))
        .filter(|value| truthy(value))
        .cloned()
        .unwrap_or_else(|| json!(facts.now_ms));

    let mut record = Map::new();
    record.insert("id".to_string(), Value::String(id.to_string()));
    record.insert("appType".to_string(), Value::String(app_type.to_string()));
    record.insert(
        "name".to_string(),
        Value::String(js_trim(&name_text).to_string()),
    );
    record.insert("source".to_string(), Value::String("local".to_string()));
    record.insert(
        "virtual".to_string(),
        plan.get("virtual").cloned().unwrap_or(Value::Null),
    );
    record.insert(
        "apiFormat".to_string(),
        Value::String(
            if app_type == "claude" {
                "anthropic"
            } else {
                "openai_responses"
            }
            .to_string(),
        ),
    );
    record.insert("createdAt".to_string(), created_at);
    // Non-routable placeholder: only Rust CPR may resolve virtual members.
    record.insert(
        "settingsConfig".to_string(),
        build_settings_config(
            Some(app_type),
            &SettingsInput {
                base_url: Some(&Value::String("https://virtual.invalid".to_string())),
                auth_token: Some(&Value::String("multicc-virtual".to_string())),
                model: Some(&first_model),
                models: Some(&Value::Array(models)),
                provider_id: Some(&Value::String(id.to_string())),
                alias_map: None,
                port: facts.port.clone(),
            },
        ),
    );

    let name = record.get("name").cloned().unwrap_or(Value::Null);
    let mut next = list;
    match next
        .iter()
        .position(|record| record_matches(record, app_type, id))
    {
        Some(index) => next[index] = Value::Object(record),
        None => next.push(Value::Object(record)),
    }
    Ok(Commit::Save {
        records: Value::Array(next),
        result: json!({ "id": id, "appType": app_type, "name": name }),
    })
}

/// `updateProvider`. `existing_virtual` is the host's `getProvider(appType, id)`
/// summary (needed for the "is this already a virtual line" test and for the
/// name it falls back to).
pub fn update_provider(
    records: &Value,
    app_type: &str,
    id: &str,
    input: &Map<String, Value>,
    existing_virtual: Option<&Value>,
    facts: &WriteFacts,
) -> Result<Commit, String> {
    let existing_is_virtual = existing_virtual
        .and_then(|value| value.get("virtual"))
        .is_some_and(truthy);
    if present(input, "virtual").is_some() || existing_is_virtual {
        if !existing_is_virtual {
            return Err(VIRTUAL_IS_NOT_CONVERTIBLE.to_string());
        }
        // `name ?? existingVirtual.name`: only `null`/`undefined` fall back.
        let fallback = existing_virtual.and_then(|value| value.get("name"));
        let name = match input.get("name") {
            Some(Value::Null) | None => fallback,
            Some(value) => Some(value),
        };
        return save_virtual_provider(
            records,
            app_type,
            id,
            name,
            facts.virtual_plan.as_ref(),
            facts,
        );
    }

    if facts.official_catalog_mounted && (facts.id_is_official || facts.normalized_id_is_official) {
        return update_official_override(records, app_type, id, input, facts);
    }

    // A dedicated egress only means something for an OAuth-managed official
    // entry: any other line already names its own upstream, and routing it
    // through the loopback hop would need a different pipeline. Reject instead
    // of storing a binding that silently does nothing.
    if present(input, "egressBinding").is_some() {
        return Err(EGRESS_ONLY_ON_OFFICIAL.to_string());
    }
    let api_format = present(input, "apiFormat");
    assert_api_format_matches_app_type(api_format, Some(app_type))?;

    let mut list = records_of(records);
    let Some(index) = list
        .iter()
        .position(|record| record_matches(record, app_type, id))
    else {
        return Err(PROVIDER_NOT_FOUND.to_string());
    };

    let stored = list[index].clone();
    let mut config = parse_config(stored.get("settingsConfig"));
    if let Some(value @ Value::Object(_)) = field(input, "settingsConfig") {
        config = value.clone();
    } else if app_type == "claude" {
        rewrite_claude_config(&mut config, input);
    } else {
        rebuild_codex_config(&mut config, input, id, facts);
    }
    apply_cli_relay_flag(&mut config, input)?;

    let mut record = stored.as_object().cloned().unwrap_or_default();
    // `if (name)`: an empty or absent name keeps the stored one.
    if let Some(name) = field(input, "name").filter(|value| truthy(value)) {
        let name = js_string(name);
        record.insert(
            "name".to_string(),
            Value::String(js_trim(&name).to_string()),
        );
    }
    // `apiFormat || p.apiFormat`: the submitted spelling wins only when truthy.
    let effective_format = match api_format.filter(|value| truthy(value)) {
        Some(value) => Some(value.clone()),
        None => record.get("apiFormat").cloned(),
    };
    record.insert(
        "apiFormat".to_string(),
        Value::String(normalize_api_format(effective_format.as_ref(), Some(app_type)).to_string()),
    );
    record.insert("settingsConfig".to_string(), config);
    if present(input, "egressIpAllowlist").is_some() {
        let allowlist = normalize_egress_ip_allowlist(field(input, "egressIpAllowlist"));
        if allowlist.is_empty() {
            record.shift_remove("egressIpAllowlist");
        } else {
            record.insert("egressIpAllowlist".to_string(), json!(allowlist));
        }
    }
    list[index] = Value::Object(record);
    Ok(Commit::Save {
        records: Value::Array(list),
        result: json!({ "id": id, "appType": app_type }),
    })
}

/// The official-entry branch of `updateProvider`: login identity is
/// OAuth-managed and not editable here, so the only thing an official provider's
/// editor may still submit is advanced settings -- today the egress-IP allowlist
/// and the dedicated-egress binding -- persisted as a minimal override record.
fn update_official_override(
    records: &Value,
    app_type: &str,
    id: &str,
    input: &Map<String, Value>,
    facts: &WriteFacts,
) -> Result<Commit, String> {
    for key in [
        "name",
        "baseUrl",
        "authToken",
        "model",
        "models",
        "apiFormat",
        "settingsConfig",
        "aliasMap",
    ] {
        if present(input, key).is_some() {
            return Err(OFFICIAL_IS_OAUTH_MANAGED.to_string());
        }
    }
    // The override belongs to the entry being edited: the terminal alias keeps
    // its own record, each account entry gets its own -- never a vendor-wide
    // shared one (an unrestricted account must stay unrestricted).
    let target_id = if facts.id_is_official {
        id.to_string()
    } else {
        facts.normalized_id.clone().unwrap_or_default()
    };
    let allowlist = normalize_egress_ip_allowlist(field(input, "egressIpAllowlist"));
    let binding = normalize_egress_binding(present(input, "egressBinding"))?;

    let mut list = records_of(records);
    let mut index = list
        .iter()
        .position(|record| record_matches(record, app_type, &target_id));
    if index.is_none()
        && (!allowlist.is_empty() || matches!(&binding, Some(value) if truthy(value)))
    {
        list.push(json!({
            "id": target_id,
            "appType": app_type,
            "source": "builtin-override",
        }));
        index = Some(list.len() - 1);
    }
    if let Some(index) = index {
        let mut record = list[index].as_object().cloned().unwrap_or_default();
        // `undefined` = this PATCH didn't touch the allowlist (e.g. the UI only
        // sent an egress binding); only an explicit list or `[]` rewrites it.
        if present(input, "egressIpAllowlist").is_some() {
            if allowlist.is_empty() {
                record.shift_remove("egressIpAllowlist");
            } else {
                record.insert("egressIpAllowlist".to_string(), json!(allowlist));
            }
        }
        match &binding {
            Some(value) if truthy(value) => {
                record.insert("egressBinding".to_string(), value.clone());
            }
            Some(Value::Null) => {
                record.shift_remove("egressBinding");
            }
            _ => {}
        }
        // Drop the record only when it is a pure override stub; a record that
        // carries anything else (e.g. a legacy import with a name) keeps its
        // identity and just loses the settings.
        let is_stub = record.get("source").and_then(Value::as_str) == Some("builtin-override")
            && !record.get("egressIpAllowlist").is_some_and(truthy)
            && !record.get("egressBinding").is_some_and(truthy);
        if is_stub {
            list.remove(index);
        } else {
            list[index] = Value::Object(record);
        }
    }
    Ok(Commit::Save {
        records: Value::Array(list),
        result: json!({ "id": target_id, "appType": app_type }),
    })
}

/// `deleteProvider`.
pub fn delete_provider(
    records: &Value,
    app_type: &str,
    id: &str,
    facts: &WriteFacts,
) -> Result<Commit, String> {
    if facts.official_catalog_mounted && id == format!("{app_type}-official") {
        let label = if app_type == "codex" {
            "Codex"
        } else {
            "Claude"
        };
        return Err(format!("“同 {label} 终端”为内置线路，不能删除"));
    }
    let list = records_of(records);
    let next: Vec<Value> = list
        .iter()
        .filter(|record| !record_matches(record, app_type, id))
        .cloned()
        .collect();
    let changed = next.len() != list.len();

    if facts.official_catalog_mounted && facts.id_is_official {
        // The account's allowlist override record (if any) outlived its
        // synthetic provider -- drop it so store reads never see a dead entry's
        // restriction. The catalog delete itself is the host's.
        return Ok(Commit::OfficialDelete {
            app_type: app_type.to_string(),
            id: id.to_string(),
            records: Value::Array(next),
            records_changed: changed,
        });
    }
    if !changed {
        return Ok(Commit::Answer {
            result: Value::Bool(false),
        });
    }
    Ok(Commit::Save {
        records: Value::Array(next),
        result: Value::Bool(true),
    })
}

/// `parseConfig`: an object passes through, a JSON string is parsed, anything
/// unparseable degrades to `{}`.
fn parse_config(value: Option<&Value>) -> Value {
    match value {
        Some(value @ Value::Object(_)) | Some(value @ Value::Array(_)) => value.clone(),
        Some(Value::String(text)) => {
            serde_json::from_str(text).unwrap_or_else(|_| Value::Object(Map::new()))
        }
        _ => Value::Object(Map::new()),
    }
}

/// `tomlValue(toml, key)`: the first `key = "…"` on a line of its own.
pub(crate) fn toml_value(toml: Option<&Value>, key: &str) -> String {
    let Some(Value::String(text)) = toml else {
        return String::new();
    };
    for line in text.split('\n') {
        let line = line.trim_start();
        let Some(rest) = line.strip_prefix(key) else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('"') else {
            continue;
        };
        match rest.find('"') {
            // `([^"]+)` needs at least one character.
            Some(0) | None => continue,
            Some(end) => return rest[..end].to_string(),
        }
    }
    String::new()
}

/// The Claude branch of `updateProvider`: a per-field rewrite of the stored env
/// rather than a rebuild, so keys the editor didn't touch keep their value *and*
/// their position.
fn rewrite_claude_config(config: &mut Value, input: &Map<String, Value>) {
    if !config.is_object() {
        // `parseConfig` already guaranteed an object for every stored shape; an
        // array is the one JSON value that would reach here, and property
        // writes onto it would be invisible to every reader.
        *config = Value::Object(Map::new());
    }
    let object = config.as_object_mut().expect("object");
    // `cfg.env = cfg.env || {}` -- a falsy env becomes a fresh object. A truthy
    // *non-object* env (a legacy string, say) survives untouched: in JavaScript
    // every `cfg.env.X = …` and `delete cfg.env.X` against a primitive is a
    // silent no-op, so the whole env block below must be skipped rather than
    // replacing the value.
    if !object.get("env").is_some_and(truthy) {
        object.insert("env".to_string(), Value::Object(Map::new()));
    }
    let env_is_writable = object.get("env").is_some_and(Value::is_object);

    if env_is_writable {
        let env = object
            .get_mut("env")
            .and_then(Value::as_object_mut)
            .expect("env object");
        if let Some(base_url) = present(input, "baseUrl") {
            if truthy(base_url) {
                env.insert("ANTHROPIC_BASE_URL".to_string(), base_url.clone());
            } else {
                env.shift_remove("ANTHROPIC_BASE_URL");
            }
        }
        // An absent *or* empty token keeps the stored credential: the editor
        // never shows it, so an empty field means "unchanged", not "clear".
        if let Some(token) = present(input, "authToken").filter(|value| truthy(value)) {
            env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), token.clone());
        }
        if let Some(model) = present(input, "model") {
            if truthy(model) {
                env.insert("ANTHROPIC_MODEL".to_string(), model.clone());
            } else {
                env.shift_remove("ANTHROPIC_MODEL");
            }
        }
    }

    if present(input, "models").is_some() || present(input, "model").is_some() {
        // The primary is the submitted model when that key was present at all
        // (even as `null`), else whatever the env now holds -- read *after* the
        // writes above, exactly as the retired code did.
        let primary = match present(input, "model") {
            Some(value) => Some(value.clone()),
            None => object
                .get("env")
                .and_then(|env| env.get("ANTHROPIC_MODEL"))
                .cloned(),
        };
        let models = crate::provider_settings_config::parse_model_list(
            present(input, "models"),
            primary.as_ref(),
        );
        let catalog: Vec<Value> = models
            .into_iter()
            .map(|model| json!({ "model": model }))
            .collect();
        object.insert("modelCatalog".to_string(), json!({ "models": catalog }));
    }

    if env_is_writable {
        let env = object
            .get_mut("env")
            .and_then(Value::as_object_mut)
            .expect("env object");
        if present(input, "aliasMap").is_some() {
            crate::provider_settings_config::apply_alias_map_to_env(
                env,
                present(input, "aliasMap"),
            );
        }
        // Bounded Zhipu fable fill on edit-save (also fires when aliasMap is not
        // part of the update -- e.g. a legacy provider whose editor only touched
        // the model list). Never overwrites a non-empty custom fable mapping.
        crate::provider_settings_config::ensure_zhipu_fable_alias(env);
    }
}

/// The Codex branch of `updateProvider`: the TOML is rebuilt from the stored
/// values the editor didn't replace, and a stale `proxyTarget` is dropped when
/// the rebuilt config no longer needs one.
fn rebuild_codex_config(
    config: &mut Value,
    input: &Map<String, Value>,
    id: &str,
    facts: &WriteFacts,
) {
    let stored = config.as_object().cloned().unwrap_or_default();
    let proxy_target = stored.get("proxyTarget");
    let current_base_url = proxy_target
        .and_then(|value| value.get("originalBaseUrl"))
        .filter(|value| truthy(value))
        .cloned()
        .unwrap_or_else(|| Value::String(toml_value(stored.get("config"), "base_url")));
    let base_url = match present(input, "baseUrl") {
        Some(value) => value.clone(),
        None => current_base_url,
    };
    let stored_key = stored
        .get("auth")
        .and_then(|auth| auth.get("OPENAI_API_KEY"))
        .filter(|value| truthy(value))
        .cloned();
    let auth_token = match present(input, "authToken").filter(|value| truthy(value)) {
        Some(value) => value.clone(),
        None => stored_key.unwrap_or(Value::String(String::new())),
    };
    let model = match present(input, "model") {
        Some(value) => value.clone(),
        None => Value::String(toml_value(stored.get("config"), "model")),
    };
    let models = match present(input, "models") {
        Some(value) => value.clone(),
        None => {
            let stored_models = stored
                .get("modelCatalog")
                .and_then(|catalog| catalog.get("models"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            Value::Array(
                stored_models
                    .iter()
                    .map(|entry| entry.get("model").cloned().unwrap_or(Value::Null))
                    .filter(truthy)
                    .collect(),
            )
        }
    };
    let rebuilt = build_settings_config(
        Some("codex"),
        &SettingsInput {
            base_url: Some(&base_url),
            auth_token: Some(&auth_token),
            model: Some(&model),
            models: Some(&models),
            provider_id: Some(&Value::String(id.to_string())),
            alias_map: None,
            port: facts.port.clone(),
        },
    );
    // `cfg = { ...cfg, ...rebuilt }`
    let mut merged = stored;
    if let Some(fields) = rebuilt.as_object() {
        for (key, value) in fields {
            merged.insert(key.clone(), value.clone());
        }
    }
    if rebuilt.get("proxyTarget").is_none() {
        merged.shift_remove("proxyTarget");
    }
    *config = Value::Object(merged);
}

/// Apply the optional top-level `cliRelay` toggle onto `settingsConfig`:
/// `true` persists `cliRelay: true`, `false` / `null` clears both `cliRelay`
/// and the legacy `relayMode`, and omission leaves any stored setting intact.
/// Anything other than a boolean/null is rejected: silently ignoring it would
/// leave the editor claiming "on" while the runtime still routes over HTTP.
fn apply_cli_relay_flag(config: &mut Value, input: &Map<String, Value>) -> Result<(), String> {
    let Some(flag) = present(input, "cliRelay") else {
        return Ok(());
    };
    match flag {
        Value::Bool(true) | Value::Bool(false) | Value::Null => {}
        _ => return Err(CLI_RELAY_FLAG_INVALID.to_string()),
    }
    if !config.is_object() {
        *config = Value::Object(Map::new());
    }
    let Some(object) = config.as_object_mut() else {
        return Ok(());
    };
    match flag {
        Value::Bool(true) => {
            object.insert("cliRelay".to_string(), Value::Bool(true));
        }
        Value::Bool(false) | Value::Null => {
            object.shift_remove("cliRelay");
            object.shift_remove("relayMode");
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::serde::js_json_stringify;

    fn facts() -> WriteFacts {
        WriteFacts {
            new_id: "fixed-id".to_string(),
            now_ms: 1_763_000_000_000.0,
            port: "3000".to_string(),
            ..WriteFacts::default()
        }
    }

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("object")
    }

    fn saved(commit: Result<Commit, String>) -> (Value, Value) {
        match commit.expect("commit") {
            Commit::Save { records, result } => (records, result),
            other => panic!("expected Save, got {other:?}"),
        }
    }

    #[test]
    fn create_rejects_in_the_retired_order() {
        let none = json!([]);
        // appType is checked before the name.
        let err = create_provider(&none, &obj(json!({"appType": "x"})), &facts()).unwrap_err();
        assert_eq!(err, APP_TYPE_REQUIRED);
        let err = create_provider(&none, &obj(json!({"appType": "claude"})), &facts()).unwrap_err();
        assert_eq!(err, NAME_REQUIRED);
        let err = create_provider(
            &none,
            &obj(json!({"appType": "claude", "name": "   "})),
            &facts(),
        )
        .unwrap_err();
        assert_eq!(err, NAME_REQUIRED);
        // The egress binding is refused before the apiFormat conflict is looked at.
        let err = create_provider(
            &none,
            &obj(json!({"appType": "claude", "name": "n", "egressBinding": {}, "apiFormat": "openai_responses"})),
            &facts(),
        )
        .unwrap_err();
        assert_eq!(err, EGRESS_ONLY_ON_OFFICIAL);
    }

    #[test]
    fn create_appends_one_record_with_the_assembled_shape() {
        let (records, result) = saved(create_provider(
            &json!([{"id": "old", "appType": "claude"}]),
            &obj(
                json!({"appType": "claude", "name": " 新线路 ", "baseUrl": "https://a.example", "authToken": "sk"}),
            ),
            &facts(),
        ));
        assert_eq!(
            js_json_stringify(&result),
            r#"{"id":"fixed-id","appType":"claude","name":"新线路"}"#
        );
        let list = records.as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["id"], "old", "existing records are kept in place");
        assert_eq!(list[1]["source"], "local");
        assert_eq!(list[1]["apiFormat"], "anthropic");
        assert_eq!(list[1]["createdAt"], json!(1_763_000_000_000.0));
        assert_eq!(
            list[1]["settingsConfig"]["env"]["ANTHROPIC_AUTH_TOKEN"],
            "sk"
        );
    }

    #[test]
    fn create_answers_with_the_catalog_entry_instead_of_storing_the_official_line() {
        let mut f = facts();
        f.official_catalog_mounted = true;
        f.assembled_is_official = true;
        let commit = create_provider(
            &json!([]),
            &obj(json!({"appType": "codex", "name": "OAuth"})),
            &f,
        )
        .unwrap();
        assert_eq!(
            commit,
            Commit::OfficialCatalogEntry {
                app_type: "codex".to_string()
            }
        );
        // Without a mounted catalog the same record is an ordinary save.
        f.official_catalog_mounted = false;
        assert!(matches!(
            create_provider(
                &json!([]),
                &obj(json!({"appType": "codex", "name": "OAuth"})),
                &f
            ),
            Ok(Commit::Save { .. })
        ));
    }

    #[test]
    fn a_virtual_save_asks_for_the_plan_only_after_the_name_check() {
        let input = obj(json!({"appType": "claude", "name": "组合", "virtual": {"members": []}}));
        assert_eq!(
            create_provider(&json!([]), &input, &facts()).unwrap(),
            Commit::NeedsVirtualPlan
        );
        // An empty name wins over the missing plan: that validation can throw, and
        // the name guard has to come first.
        let nameless = obj(json!({"appType": "claude", "name": " ", "virtual": {"members": []}}));
        assert_eq!(
            create_provider(&json!([]), &nameless, &facts()).unwrap_err(),
            NAME_REQUIRED
        );
    }

    #[test]
    fn a_null_virtual_plan_is_treated_as_unresolved_not_as_an_empty_plan() {
        // Regression: `Some(Value::Null)` once passed for a resolved plan and
        // persisted a virtual line with no members and no models.
        let mut f = facts();
        f.virtual_plan = Some(Value::Null);
        let input = obj(json!({"appType": "claude", "name": "组合", "virtual": {"members": []}}));
        assert_eq!(
            create_provider(&json!([]), &input, &f).unwrap(),
            Commit::NeedsVirtualPlan
        );
    }

    #[test]
    fn a_virtual_save_keeps_the_original_created_at_when_replacing() {
        let mut f = facts();
        f.virtual_plan = Some(json!({"virtual": {"members": [1]}, "models": ["m1"]}));
        let existing = json!([{"id": "v1", "appType": "claude", "createdAt": 42, "name": "旧"}]);
        let (records, _) = saved(save_virtual_provider(
            &existing,
            "claude",
            "v1",
            Some(&json!("新")),
            f.virtual_plan.as_ref(),
            &f,
        ));
        let list = records.as_array().unwrap();
        assert_eq!(list.len(), 1, "replaced in place, not appended");
        assert_eq!(list[0]["createdAt"], 42);
        assert_eq!(list[0]["name"], "新");
        assert_eq!(list[0]["settingsConfig"]["env"]["ANTHROPIC_MODEL"], "m1");
    }

    #[test]
    fn update_blocks_a_normal_line_from_becoming_virtual() {
        let err = update_provider(
            &json!([]),
            "claude",
            "p",
            &obj(json!({"virtual": {"members": []}})),
            None,
            &facts(),
        )
        .unwrap_err();
        assert_eq!(err, VIRTUAL_IS_NOT_CONVERTIBLE);
    }

    #[test]
    fn update_keeps_untouched_env_keys_in_place_and_drops_cleared_ones() {
        let records = json!([{
            "id": "p", "appType": "claude", "apiFormat": "anthropic", "name": "n",
            "settingsConfig": {"env": {
                "ANTHROPIC_BASE_URL": "https://old", "ANTHROPIC_AUTH_TOKEN": "sk-old",
                "ANTHROPIC_MODEL": "m", "ANTHROPIC_DEFAULT_OPUS_MODEL": "o"
            }}
        }]);
        // An empty baseUrl clears it; the keys after it must keep their order.
        let (next, _) = saved(update_provider(
            &records,
            "claude",
            "p",
            &obj(json!({"baseUrl": ""})),
            None,
            &facts(),
        ));
        assert_eq!(
            js_json_stringify(&next[0]["settingsConfig"]["env"]),
            r#"{"ANTHROPIC_AUTH_TOKEN":"sk-old","ANTHROPIC_MODEL":"m","ANTHROPIC_DEFAULT_OPUS_MODEL":"o"}"#
        );
        // An empty token means "unchanged", not "clear".
        let (next, _) = saved(update_provider(
            &records,
            "claude",
            "p",
            &obj(json!({"authToken": ""})),
            None,
            &facts(),
        ));
        assert_eq!(
            next[0]["settingsConfig"]["env"]["ANTHROPIC_AUTH_TOKEN"],
            "sk-old"
        );
    }

    #[test]
    fn update_reports_a_missing_provider() {
        let err = update_provider(
            &json!([]),
            "claude",
            "nope",
            &obj(json!({})),
            None,
            &facts(),
        )
        .unwrap_err();
        assert_eq!(err, PROVIDER_NOT_FOUND);
    }

    #[test]
    fn an_official_entry_only_accepts_advanced_settings() {
        let mut f = facts();
        f.official_catalog_mounted = true;
        f.id_is_official = true;
        f.normalized_id = Some("claude-official-aaaaaaaaaaaaaaaa".to_string());
        for rejected in [
            "name",
            "baseUrl",
            "authToken",
            "model",
            "models",
            "apiFormat",
            "settingsConfig",
            "aliasMap",
        ] {
            let input = obj(json!({ rejected: "x" }));
            let err = update_provider(
                &json!([]),
                "claude",
                "claude-official-aaaaaaaaaaaaaaaa",
                &input,
                None,
                &f,
            )
            .unwrap_err();
            assert_eq!(err, OFFICIAL_IS_OAUTH_MANAGED, "{rejected}");
        }
    }

    #[test]
    fn an_override_stub_is_created_on_demand_and_removed_when_it_empties() {
        let mut f = facts();
        f.official_catalog_mounted = true;
        f.id_is_official = true;
        f.normalized_id = Some("claude-official-aaaaaaaaaaaaaaaa".to_string());
        let id = "claude-official-aaaaaaaaaaaaaaaa";
        let (records, _) = saved(update_provider(
            &json!([]),
            "claude",
            id,
            &obj(json!({"egressIpAllowlist": ["1.2.3.4"]})),
            None,
            &f,
        ));
        assert_eq!(records[0]["source"], "builtin-override");
        assert_eq!(records[0]["egressIpAllowlist"], json!(["1.2.3.4"]));
        // Clearing the only setting removes the whole stub.
        let (records, _) = saved(update_provider(
            &records,
            "claude",
            id,
            &obj(json!({"egressIpAllowlist": []})),
            None,
            &f,
        ));
        assert_eq!(records.as_array().unwrap().len(), 0);
        // A record that carries a name is a legacy import, not a stub: it stays.
        let named = json!([{"id": id, "appType": "claude", "source": "ccswitch", "name": "旧", "egressIpAllowlist": ["1.2.3.4"]}]);
        let (records, _) = saved(update_provider(
            &named,
            "claude",
            id,
            &obj(json!({"egressIpAllowlist": []})),
            None,
            &f,
        ));
        assert_eq!(records.as_array().unwrap().len(), 1);
        assert!(records[0].get("egressIpAllowlist").is_none());
    }

    #[test]
    fn delete_refuses_the_terminal_alias_and_reports_misses_without_saving() {
        let mut f = facts();
        f.official_catalog_mounted = true;
        let err = delete_provider(&json!([]), "codex", "codex-official", &f).unwrap_err();
        assert_eq!(err, "“同 Codex 终端”为内置线路，不能删除");
        let err = delete_provider(&json!([]), "claude", "claude-official", &f).unwrap_err();
        assert_eq!(err, "“同 Claude 终端”为内置线路，不能删除");
        f.official_catalog_mounted = false;
        assert_eq!(
            delete_provider(
                &json!([{"id": "a", "appType": "claude"}]),
                "claude",
                "missing",
                &f
            )
            .unwrap(),
            Commit::Answer {
                result: Value::Bool(false)
            }
        );
        let (records, result) = saved(delete_provider(
            &json!([{"id": "a", "appType": "claude"}, {"id": "a", "appType": "codex"}]),
            "claude",
            "a",
            &f,
        ));
        assert_eq!(result, Value::Bool(true));
        assert_eq!(
            records.as_array().unwrap().len(),
            1,
            "only the matching appType is removed"
        );
    }

    #[test]
    fn deleting_an_official_id_leaves_the_catalog_delete_to_the_host() {
        let mut f = facts();
        f.official_catalog_mounted = true;
        f.id_is_official = true;
        let id = "claude-official-aaaaaaaaaaaaaaaa";
        let commit = delete_provider(
            &json!([{"id": id, "appType": "claude", "source": "builtin-override"}]),
            "claude",
            id,
            &f,
        )
        .unwrap();
        match commit {
            Commit::OfficialDelete {
                records,
                records_changed,
                ..
            } => {
                assert!(records_changed);
                assert_eq!(records.as_array().unwrap().len(), 0);
            }
            other => panic!("expected OfficialDelete, got {other:?}"),
        }
    }

    #[test]
    fn egress_binding_ids_need_an_alphanumeric_lead() {
        assert!(
            normalize_egress_binding(Some(&json!({"pluginId": "p1", "profileId": "a.b-c_d"})))
                .is_ok()
        );
        for bad in [
            json!({"pluginId": "", "profileId": "x"}),
            json!({"pluginId": "-a", "profileId": "x"}),
            json!({"pluginId": "a b", "profileId": "x"}),
            json!([]),
        ] {
            assert!(normalize_egress_binding(Some(&bad)).is_err(), "{bad}");
        }
        assert_eq!(normalize_egress_binding(None).unwrap(), None);
        assert_eq!(
            normalize_egress_binding(Some(&Value::Null)).unwrap(),
            Some(Value::Null)
        );
    }

    #[test]
    fn the_egress_allowlist_is_trimmed_and_deduped_but_never_validated() {
        let list = normalize_egress_ip_allowlist(Some(&json!([
            " 1.2.3.4 ",
            "1.2.3.4",
            "",
            null,
            "not-an-ip",
            0
        ])));
        assert_eq!(list, vec!["1.2.3.4", "not-an-ip", "0"]);
        assert!(normalize_egress_ip_allowlist(Some(&json!("x"))).is_empty());
    }

    #[test]
    fn toml_value_reads_the_first_quoted_assignment() {
        let toml =
            Value::String("a = 1\nmodel = \"gpt-5\"\n  base_url = \"https://x\"\n".to_string());
        assert_eq!(toml_value(Some(&toml), "model"), "gpt-5");
        assert_eq!(toml_value(Some(&toml), "base_url"), "https://x");
        assert_eq!(toml_value(Some(&toml), "missing"), "");
        // `([^"]+)` needs at least one character.
        let empty = Value::String("model = \"\"\n".to_string());
        assert_eq!(toml_value(Some(&empty), "model"), "");
    }

    #[test]
    fn cli_relay_flag_rejects_non_boolean_values_instead_of_ignoring_them() {
        let input = obj(json!({
            "appType": "claude",
            "name": "Relay",
            "cliRelay": "true"
        }));
        assert_eq!(
            create_provider(&json!([]), &input, &facts()),
            Err(CLI_RELAY_FLAG_INVALID.to_string())
        );

        let created = create_provider(
            &json!([]),
            &obj(json!({
                "appType": "claude",
                "name": "Relay",
                "baseUrl": "https://host.example/claude-proxy/abc/remote",
                "authToken": "mcr1.secret"
            })),
            &facts(),
        )
        .unwrap();
        let Commit::Save { records, .. } = created else {
            panic!("expected Save");
        };
        assert_eq!(
            update_provider(
                &records,
                "claude",
                "fixed-id",
                &obj(json!({ "cliRelay": 1 })),
                None,
                &facts(),
            ),
            Err(CLI_RELAY_FLAG_INVALID.to_string())
        );
    }

    #[test]
    fn cli_relay_flag_persists_toggles_and_preserves_on_omission() {
        let f = facts();
        let created = create_provider(
            &json!([]),
            &obj(json!({
                "appType": "claude",
                "name": "Relay",
                "baseUrl": "https://host.example/claude-proxy/abc/remote",
                "authToken": "mcr1.secret",
                "cliRelay": true
            })),
            &f,
        )
        .unwrap();
        let Commit::Save { records, .. } = created else {
            panic!("expected Save");
        };
        assert_eq!(records[0]["settingsConfig"]["cliRelay"], json!(true));

        // Omitting cliRelay on unrelated edit keeps the stored toggle.
        let kept = update_provider(
            &records,
            "claude",
            "fixed-id",
            &obj(json!({ "name": "Relay Renamed" })),
            None,
            &f,
        )
        .unwrap();
        let Commit::Save { records, .. } = kept else {
            panic!("expected Save");
        };
        assert_eq!(records[0]["name"], json!("Relay Renamed"));
        assert_eq!(records[0]["settingsConfig"]["cliRelay"], json!(true));

        // Explicitly setting cliRelay: false clears both cliRelay and legacy relayMode.
        let cleared = update_provider(
            &records,
            "claude",
            "fixed-id",
            &obj(json!({ "cliRelay": false })),
            None,
            &f,
        )
        .unwrap();
        let Commit::Save { records, .. } = cleared else {
            panic!("expected Save");
        };
        assert!(records[0]["settingsConfig"].get("cliRelay").is_none());
        assert!(records[0]["settingsConfig"].get("relayMode").is_none());
    }
}
