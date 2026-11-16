//! Provider route rules retired from `src/routes/providers.js`: egress
//! validation, probe candidate/result shaping, the `mcrelay1.` share code, the
//! delete/reassign decision trees, provider-defaults merging and the
//! `GET /api/providers` response shape.
//!
//! Every branch, status and public string here is the Node route's, in the
//! same order. The HTTP plumbing lives in `native/gateway/src/app/providers.rs`;
//! Node-only facts (store, session table, relay store) come back through that
//! module's host port.

use std::collections::HashSet;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::claude_models;
use crate::http_gate::encode_uri_component;
use crate::js::serde::{js_json_stringify, js_string, truthy, value_or_empty};
use crate::js::{js_trim, utf16_len};
use crate::public_safety::{public_error, public_text, safe_code};

pub const MAX_PROBE_CANDIDATES: usize = 20;
pub const MAX_PROBE_CANDIDATE_LENGTH: usize = 200;
pub const MAX_RELAY_MODELS: usize = 100;
pub const MAX_RELAY_MODEL_LENGTH: usize = 256;
pub const RELAY_CODE_PREFIX: &str = "mcrelay1.";
pub const RELAY_FALLBACK_ID: &str = "mcr1";

/// Deferred native-line checks for the synchronous provider validator.
/// Zero means the host must continue to the next lookup, one accepts and two rejects.
pub fn native_provider_line(
    cli: Option<&str>,
    id: &str,
    phase: u32,
    vendors: &[String],
    suffix: &str,
    prefix: &str,
) -> u32 {
    if phase == 1 {
        if let Some(at) = id.find(suffix).filter(|at| *at > 0) {
            let vendor = &id[..at];
            if vendors.iter().any(|candidate| candidate == vendor) {
                return if cli == Some(vendor) { 1 } else { 2 };
            }
        }
    } else if phase == 2 {
        if let Some(native) = id.strip_prefix(prefix) {
            let bytes = native.as_bytes();
            let valid = !bytes.is_empty()
                && bytes.len() <= 64
                && bytes[0].is_ascii_alphanumeric()
                && bytes
                    .iter()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'.' | b'_' | b'-'));
            return if cli == Some("opencode") && valid {
                1
            } else {
                2
            };
        }
    }
    0
}

// ── provider id validation (retired from `src/providers/core.js`) ────────────
//
// `validProviderId(cli, id)` used to live in Node: `appTypeForCli`, the
// `compatibleClisForFormat` / `CREDENTIAL_GATED_CLIS` table and
// `providerSupportsCli` are now only here. Both the addon validator
// (`providerValidateId`) and the gateway's provider-defaults route call these
// functions; Node keeps just the two facts the rules cannot know, the official
// catalog normalizer and the provider-store summary.

/// Lanes that own a vendor catalog, so their native line id `<cli>-native:<id>`
/// is structural. Mirrors `VENDOR_NATIVE_CLIS` in `src/providers/native-vendor.js`.
pub const VENDOR_NATIVE_CLIS: [&str; 7] = [
    "qoder",
    "codebuddy",
    "gemini",
    "pi",
    "commandcode",
    "dsh",
    "grok",
];
/// Mirrors `NATIVE_VENDOR_SUFFIX` in `src/providers/native-vendor.js`.
pub const NATIVE_VENDOR_SUFFIX: &str = "-native:";
/// Mirrors `NATIVE_OPENCODE_PREFIX` in `src/providers/native-opencode.js`.
pub const NATIVE_OPENCODE_PREFIX: &str = "opencode-native:";

/// The Anthropic pool, in the retired table's order.
const ANTHROPIC_COMPATIBLE_CLIS: [&str; 6] =
    ["claude", "claude-exp", "opencode", "zcode", "dsh", "grok"];
/// The OpenAI pool, in the retired table's order.
const OPENAI_COMPATIBLE_CLIS: [&str; 6] =
    ["codex", "codex-exp", "opencode", "zcode", "kimi", "grok"];

/// CLIs that replay a provider over plain HTTP: an OAuth-subscription entry has
/// no credential they can use, so they only appear on providers with a real
/// baseUrl+token.
pub const CREDENTIAL_GATED_CLIS: [&str; 4] = ["zcode", "kimi", "dsh", "grok"];

/// `compatibleClisForFormat`: the pool a normalized API format draws from.
pub fn compatible_clis_for_format(api_format: &str) -> &'static [&'static str] {
    if api_format == crate::provider_settings_config::API_FORMAT_ANTHROPIC {
        &ANTHROPIC_COMPATIBLE_CLIS
    } else {
        &OPENAI_COMPATIBLE_CLIS
    }
}

/// `summary.compatibleClis`: the pool minus the credential-gated lanes the
/// provider has no credentials for.
pub fn compatible_clis(api_format: &str, has_credentials: bool) -> Vec<&'static str> {
    compatible_clis_for_format(api_format)
        .iter()
        .copied()
        .filter(|cli| has_credentials || !CREDENTIAL_GATED_CLIS.contains(cli))
        .collect()
}

/// `appTypeForCli`: the pool a session's cli draws its provider from. Non-string
/// clis are folded to `None` by the caller (JavaScript's `===` never matches).
/// Qoder CN owns its provider configuration in its vendor client, so it has no
/// pool; OpenCode/ZCode/Kimi/Grok resolve globally by provider id.
pub fn app_type_for_cli(cli: &str) -> Option<&'static str> {
    match cli {
        "codex" | "codex-exp" => Some("codex"),
        "claude" | "claude-exp" | "opencode" => Some("claude"),
        // DSH speaks only Anthropic Messages, so its pool is the claude one.
        "dsh" => Some("claude"),
        _ => None,
    }
}

/// `appTypesForCli`: the pools a cli may bind a provider from, in the retired
/// order. OpenCode/ZCode/Kimi/Grok span both stored pools.
pub fn app_types_for_cli(cli: &str) -> Vec<&'static str> {
    if matches!(cli, "opencode" | "zcode" | "kimi" | "grok") {
        return vec!["claude", "codex"];
    }
    app_type_for_cli(cli)
        .map(|app_type| vec![app_type])
        .unwrap_or_default()
}

/// The provider facts `providerSupportsCli` reads. Node turns its provider
/// summary into this structure (or the addon reads the live object); the rules
/// below never look at a provider object again.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProviderCliFacts {
    pub app_type: Option<String>,
    pub virtual_truthy: bool,
    /// `apiFormat` when truthy; `None` for an absent/empty value.
    pub api_format: Option<String>,
    /// `protocol` when truthy, used only when `api_format` is absent.
    pub protocol: Option<String>,
    pub base_url_truthy: bool,
    pub has_token_truthy: bool,
}

/// `provider.cli === 'claude-exp' ? 'claude' : ...`: the cli handed to the
/// official-catalog normalizer. Every other value passes through unchanged.
pub fn folded_cli_for_normalize(cli: Option<&str>) -> Option<&str> {
    match cli {
        Some("codex-exp") => Some("codex"),
        Some("claude-exp") => Some("claude"),
        other => other,
    }
}

/// `providerSupportsCli`: whether one provider can serve `cli`. `None` facts is
/// a falsy provider; `None` cli is a falsy cli. A virtual provider only serves
/// its own `appType` and `<appType>-exp`; everyone else goes through the format
/// table and the credential gate.
pub fn provider_supports_cli(facts: Option<&ProviderCliFacts>, cli: Option<&str>) -> bool {
    let (Some(facts), Some(cli)) = (facts, cli) else {
        return false;
    };
    if facts.virtual_truthy {
        // `[provider.appType, `${provider.appType}-exp`].includes(String(cli))`.
        // Only a string appType can equal a cli through `===`; a non-string one
        // is recorded as `None` by the fact builders.
        return facts
            .app_type
            .as_deref()
            .is_some_and(|app_type| cli == app_type || cli == format!("{app_type}-exp"));
    }
    let asked = facts
        .api_format
        .clone()
        .or_else(|| facts.protocol.clone())
        .map(Value::String);
    let format = crate::provider_settings_config::normalize_api_format(
        asked.as_ref(),
        facts.app_type.as_deref(),
    );
    if !compatible_clis_for_format(format).contains(&cli) {
        return false;
    }
    if !CREDENTIAL_GATED_CLIS.contains(&cli) {
        return true;
    }
    facts.base_url_truthy && facts.has_token_truthy
}

/// A truthy JSON member read as JavaScript `String(value)`, or `None`.
fn json_truthy_text(value: Option<&Value>) -> Option<String> {
    value.filter(|value| truthy(value)).map(js_string)
}

/// Reads the six facts out of a provider summary object. A falsy summary is
/// `None`; a truthy non-object reads every member as `undefined`, exactly like
/// JavaScript property access on a primitive.
pub fn provider_cli_facts_from_json(summary: Option<&Value>) -> Option<ProviderCliFacts> {
    let summary = summary.filter(|value| truthy(value))?;
    let object = summary.as_object();
    let member = |key: &str| object.and_then(|object| object.get(key));
    Some(ProviderCliFacts {
        app_type: member("appType")
            .and_then(Value::as_str)
            .map(str::to_string),
        virtual_truthy: member("virtual").is_some_and(truthy),
        api_format: json_truthy_text(member("apiFormat")),
        protocol: json_truthy_text(member("protocol")),
        base_url_truthy: member("baseUrl").is_some_and(truthy),
        has_token_truthy: member("hasToken").is_some_and(truthy),
    })
}

/// What the validator can decide before any provider lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderIdStep {
    /// `id == null || id === ''`: accepted with a `null` value.
    Empty,
    /// Rejected without touching the provider store.
    Rejected,
    /// A vendor-native or opencode-native id: accepted as `String(id)`.
    Native(String),
    /// Rules ①-④ passed; the caller must fetch `getProviderSummary(pool, id)`
    /// next. `pool` is `None` when the cli spans both pools (`undefined`).
    Lookup { pool: Option<String>, id: String },
}

/// Rules ①-④ of the retired validator plus the `appTypesForCli` gate. `id` is
/// the normalized id (`None` for a JavaScript nullish result).
pub fn provider_id_step(
    cli: Option<&str>,
    id: Option<String>,
    vendors: &[String],
    suffix: &str,
    prefix: &str,
) -> ProviderIdStep {
    let id = match id {
        Some(id) if !id.is_empty() => id,
        _ => return ProviderIdStep::Empty,
    };
    for phase in [1, 2] {
        match native_provider_line(cli, &id, phase, vendors, suffix, prefix) {
            1 => return ProviderIdStep::Native(id),
            2 => return ProviderIdStep::Rejected,
            _ => {}
        }
    }
    let app_types = cli.map(app_types_for_cli).unwrap_or_default();
    if app_types.is_empty() {
        return ProviderIdStep::Rejected;
    }
    // `appTypes.length > 1 ? undefined : appType`
    let pool = if app_types.len() > 1 {
        None
    } else {
        cli.and_then(app_type_for_cli).map(str::to_string)
    };
    ProviderIdStep::Lookup { pool, id }
}

/// The validator's answer. `ok` with no `value` is the empty pass-through
/// (`{ ok: true, value: null }`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedProviderId {
    pub ok: bool,
    pub value: Option<String>,
}

/// `{ ok: false }`.
pub fn rejected_provider_id() -> ValidatedProviderId {
    ValidatedProviderId {
        ok: false,
        value: None,
    }
}

/// `{ ok: true, value: null }`.
pub fn empty_provider_id() -> ValidatedProviderId {
    ValidatedProviderId {
        ok: true,
        value: None,
    }
}

/// The final step: the summary decides, and an accepted id is `String(id)`.
pub fn finish_provider_lookup(
    cli: Option<&str>,
    id: &str,
    facts: Option<&ProviderCliFacts>,
) -> ValidatedProviderId {
    if provider_supports_cli(facts, cli) {
        ValidatedProviderId {
            ok: true,
            value: Some(id.to_string()),
        }
    } else {
        rejected_provider_id()
    }
}

/// The two lazy facts the validator cannot compute itself. `Raw` is the
/// caller's id as it arrived (a live JavaScript value for the addon, JSON for
/// the gateway); the core never inspects it.
///
/// `normalize` is only called when `can_normalize` is true, and `summary` only
/// when rules ①-④ fall through to the provider lookup, so the host call counts
/// stay the retired implementation's.
pub trait ProviderIdQueries {
    type Raw: ?Sized;
    type Error;
    /// `typeof deps.providers.normalizeOfficialProviderId === 'function'`.
    fn can_normalize(&self) -> Result<bool, Self::Error>;
    /// `normalizeOfficialProviderId(cli, id)`. `None` is a JavaScript nullish.
    fn normalize(
        &mut self,
        cli: Option<&str>,
        id: &Self::Raw,
    ) -> Result<Option<String>, Self::Error>;
    /// `String(id)`, used when no normalizer is installed. `None` is nullish.
    fn stringify(&mut self, id: &Self::Raw) -> Result<Option<String>, Self::Error>;
    /// `getProviderSummary(appType, id)`.
    fn summary(
        &mut self,
        app_type: Option<&str>,
        id: &str,
    ) -> Result<Option<ProviderCliFacts>, Self::Error>;
}

/// `validProviderId`: the whole retired validator, with the lookup facts coming
/// back through [`ProviderIdQueries`] lazily and in the legacy order.
pub fn validate_provider_id<Q: ProviderIdQueries>(
    queries: &mut Q,
    cli: Option<&str>,
    id: &Q::Raw,
    vendors: &[String],
    suffix: &str,
    prefix: &str,
) -> Result<ValidatedProviderId, Q::Error> {
    let normalized = if queries.can_normalize()? {
        queries.normalize(folded_cli_for_normalize(cli), id)?
    } else {
        queries.stringify(id)?
    };
    match provider_id_step(cli, normalized, vendors, suffix, prefix) {
        ProviderIdStep::Empty => Ok(empty_provider_id()),
        ProviderIdStep::Rejected => Ok(rejected_provider_id()),
        ProviderIdStep::Native(id) => Ok(ValidatedProviderId {
            ok: true,
            value: Some(id),
        }),
        ProviderIdStep::Lookup { pool, id } => {
            let facts = queries.summary(pool.as_deref(), &id)?;
            Ok(finish_provider_lookup(cli, &id, facts.as_ref()))
        }
    }
}

/// `isValidIp` from `src/providers/egress-ip.js`: a bare IPv4 address with
/// every octet in 0..255, or anything made only of hex digits and colons that
/// contains a colon (the module never demanded a valid IPv6 literal there).
pub fn is_valid_ip(value: &str) -> bool {
    let value = js_trim(value);
    if value.is_empty() {
        return false;
    }
    let bytes = value.as_bytes();
    let mut dots = 0;
    for byte in bytes {
        if *byte == b'.' {
            dots += 1;
        } else if !byte.is_ascii_digit() {
            dots = -1;
            break;
        }
    }
    if dots == 3 && bytes.len() >= 7 {
        // `/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/`
        let parts: Vec<&str> = value.split('.').collect();
        let shaped = parts.len() == 4
            && parts.iter().all(|part| {
                (1..=3).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit())
            });
        if shaped {
            return parts
                .iter()
                .all(|part| part.parse::<u32>().is_ok_and(|octet| octet <= 255));
        }
    }
    let colon = value.contains(':');
    let hex = value
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() || byte == b':');
    colon && hex
}

/// `parseEgressIpAllowlist`: absent leaves the stored value alone (`None`),
/// `null` clears it, and anything that is not an array of IP strings is a
/// rejected configuration.
pub fn parse_egress_ip_allowlist(
    body: Option<&Map<String, Value>>,
) -> Result<Option<Vec<String>>, String> {
    let value = body.and_then(|object| object.get("egressIpAllowlist"));
    let value = match value {
        None => return Ok(None),
        Some(Value::Null) => return Ok(Some(Vec::new())),
        Some(array @ Value::Array(_)) => array,
        Some(_) => {
            return Err("egressIpAllowlist must be an array of IP addresses".to_string());
        }
    };
    let items = value.as_array().expect("array");
    let mut list = Vec::with_capacity(items.len());
    for item in items {
        let text = js_string(item);
        let text = js_trim(&text);
        if !text.is_empty() {
            list.push(text.to_string());
        }
    }
    if let Some(invalid) = list.iter().find(|ip| !is_valid_ip(ip)) {
        return Err(format!(
            "egressIpAllowlist contains an invalid IP address: {invalid}"
        ));
    }
    Ok(Some(list))
}

/// `parseEgressBinding`: absent leaves the stored binding alone (`None`),
/// `null` clears it, and the JSON envelope is narrowed to the two ids (shape
/// validation itself happens in the provider store).
pub fn parse_egress_binding(body: Option<&Map<String, Value>>) -> Result<Option<Value>, String> {
    let value = body.and_then(|object| object.get("egressBinding"));
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(Value::Null)),
        Some(Value::Object(object)) => {
            let mut out = Map::new();
            if let Some(plugin_id) = object.get("pluginId") {
                out.insert("pluginId".into(), plugin_id.clone());
            }
            if let Some(profile_id) = object.get("profileId") {
                out.insert("profileId".into(), profile_id.clone());
            }
            Ok(Some(Value::Object(out)))
        }
        Some(_) => Err("egressBinding must be an object with pluginId and profileId".to_string()),
    }
}

/// Both parsers in their original order: the allowlist is evaluated first, so
/// an invalid IP wins over a malformed binding.
pub fn validate_egress(body: Option<&Map<String, Value>>) -> Result<(), String> {
    parse_egress_ip_allowlist(body)?;
    parse_egress_binding(body)?;
    Ok(())
}

/// `(value || '').trim()` from the create route: a truthy non-string has no
/// `.trim`, which the retired handler surfaced as a caught `TypeError`.
fn js_trim_property(value: Option<&Value>, expression: &str) -> Result<String, String> {
    let Some(value) = value.filter(|value| truthy(value)) else {
        return Ok(String::new());
    };
    let Value::String(text) = value else {
        return Err(format!("({expression} || \"\").trim is not a function"));
    };
    Ok(js_trim(text).to_string())
}

/// The exact object `POST /api/providers` handed to `createProvider`.
pub fn create_payload(input: Option<&Map<String, Value>>) -> Result<Map<String, Value>, String> {
    let empty = Map::new();
    let input = input.unwrap_or(&empty);
    // Both parsers run before the object literal is evaluated.
    let allowlist = parse_egress_ip_allowlist(Some(input))?;
    let binding = parse_egress_binding(Some(input))?;
    let app_type = js_trim_property(input.get("appType"), "req.body.appType")?;
    let name = input.get("name").cloned();
    let base_url = js_trim_property(input.get("baseUrl"), "req.body.baseUrl")?;
    let auth_token = js_trim_property(input.get("authToken"), "req.body.authToken")?;
    let model = js_trim_property(input.get("model"), "req.body.model")?;
    let mut out = Map::new();
    out.insert("appType".into(), Value::String(app_type));
    if let Some(name) = name {
        out.insert("name".into(), name);
    }
    out.insert("baseUrl".into(), Value::String(base_url));
    out.insert("authToken".into(), Value::String(auth_token));
    out.insert("model".into(), Value::String(model));
    for key in [
        "models",
        "apiFormat",
        "settingsConfig",
        "virtual",
        "aliasMap",
    ] {
        if let Some(value) = input.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if let Some(list) = allowlist {
        out.insert(
            "egressIpAllowlist".into(),
            Value::Array(list.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(binding) = binding {
        out.insert("egressBinding".into(), binding);
    }
    Ok(out)
}

/// The exact patch object `PATCH /api/providers/:appType/:id` handed to
/// `updateProvider`: raw members (no trimming) and the same spreads.
pub fn update_payload(input: Option<&Map<String, Value>>) -> Result<Map<String, Value>, String> {
    let empty = Map::new();
    let input = input.unwrap_or(&empty);
    let allowlist = parse_egress_ip_allowlist(Some(input))?;
    let binding = parse_egress_binding(Some(input))?;
    let mut out = Map::new();
    for key in ["name", "baseUrl", "authToken", "model", "models"] {
        if let Some(value) = input.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    for key in ["apiFormat", "settingsConfig", "virtual", "aliasMap"] {
        if let Some(value) = input.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if let Some(list) = allowlist {
        out.insert(
            "egressIpAllowlist".into(),
            Value::Array(list.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(binding) = binding {
        out.insert("egressBinding".into(), binding);
    }
    Ok(out)
}

/// `normalizeProbeCandidates`. `Ok(None)` is JavaScript `undefined` (the body
/// carried no candidates at all).
pub fn normalize_probe_candidates(
    value: Option<&Value>,
) -> Result<Option<Vec<String>>, (u16, &'static str)> {
    let value = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(array @ Value::Array(_)) => array,
        Some(_) => return Err((400, "probe candidates must be an array")),
    };
    let items = value.as_array().expect("array");
    if items.len() > MAX_PROBE_CANDIDATES {
        return Err((413, "too many probe candidates"));
    }
    let mut candidates: Vec<String> = Vec::new();
    for item in items {
        let Value::String(text) = item else {
            return Err((400, "invalid probe candidate"));
        };
        let candidate = js_trim(text);
        if candidate.is_empty() || utf16_len(candidate) > MAX_PROBE_CANDIDATE_LENGTH {
            return Err((400, "invalid probe candidate"));
        }
        if !candidates.iter().any(|seen| seen == candidate) {
            candidates.push(candidate.to_string());
        }
    }
    Ok(Some(candidates))
}

/// `sanitizeProbeResult`: a shallow copy whose `error`/`reason`/`sample`
/// strings are pushed through `sanitizePublicText`.
pub fn sanitize_probe_result(result: &Value) -> Value {
    let Value::Object(object) = result else {
        return result.clone();
    };
    let mut out = Map::new();
    for (key, value) in object {
        let value = match key.as_str() {
            "error" => Value::String(public_text(Some(value), "provider probe failed")),
            "tested" => match value {
                Value::Array(entries) => {
                    let mut tested = Vec::with_capacity(entries.len());
                    for entry in entries {
                        let Value::Object(entry) = entry else {
                            tested.push(entry.clone());
                            continue;
                        };
                        let mut item = Map::new();
                        for (field, field_value) in entry {
                            let field_value = match field.as_str() {
                                "error" | "reason" => Value::String(public_text(
                                    Some(field_value),
                                    "provider probe failed",
                                )),
                                "sample" => Value::String(public_text(
                                    Some(field_value),
                                    "provider probe output hidden",
                                )),
                                _ => field_value.clone(),
                            };
                            item.insert(field.clone(), field_value);
                        }
                        tested.push(Value::Object(item));
                    }
                    Value::Array(tested)
                }
                other => other.clone(),
            },
            _ => value.clone(),
        };
        out.insert(key.clone(), value);
    }
    Value::Object(out)
}

/// Direct-value variant retaining undefined, key order and lone UTF-16 units.
pub fn sanitize_probe_result_js(result: &crate::js::JsValue) -> crate::js::JsValue {
    use crate::js::JsValue;
    use crate::public_safety::sanitize_public_js_text;
    fn clean(value: &JsValue, fallback: &str) -> JsValue {
        let text = match value {
            JsValue::String(value) => Some(value),
            _ => None,
        };
        JsValue::String(sanitize_public_js_text(text, fallback))
    }
    let JsValue::Object(fields) = result else {
        return result.clone();
    };
    JsValue::Object(
        fields
            .iter()
            .map(|(key, value)| {
                let value = if key == "error" {
                    clean(value, "provider probe failed")
                } else if key == "tested" {
                    match value {
                        JsValue::Array(entries) => JsValue::Array(
                            entries
                                .iter()
                                .map(|entry| {
                                    let JsValue::Object(fields) = entry else {
                                        return entry.clone();
                                    };
                                    JsValue::Object(
                                        fields
                                            .iter()
                                            .map(|(key, value)| {
                                                let value = if key == "error" || key == "reason" {
                                                    clean(value, "provider probe failed")
                                                } else if key == "sample" {
                                                    clean(value, "provider probe output hidden")
                                                } else {
                                                    value.clone()
                                                };
                                                (key.clone(), value)
                                            })
                                            .collect(),
                                    )
                                })
                                .collect(),
                        ),
                        _ => value.clone(),
                    }
                } else {
                    value.clone()
                };
                (key.clone(), value)
            })
            .collect(),
    )
}

/// `importErrorDto`: the 400 body of `POST /api/providers/import`.
pub fn import_error_dto(
    message: Option<&str>,
    code: Option<&Value>,
    reason: Option<&Value>,
) -> Value {
    let mut out = Map::new();
    out.insert(
        "error".into(),
        Value::String(public_error(message, "provider import failed")),
    );
    if let Some(code) = code.filter(|value| truthy(value)) {
        out.insert(
            "code".into(),
            Value::String(safe_code(&js_string(code), "PROVIDER_IMPORT_FAILED")),
        );
    }
    if let Some(reason) = reason.filter(|value| truthy(value)) {
        out.insert(
            "reason".into(),
            Value::String(public_text(Some(reason), "provider import failed")),
        );
    }
    Value::Object(out)
}

/// `relayModelsOf`: the summary's model metadata, deduped and capped.
pub fn relay_models_of(summary: Option<&Value>) -> Vec<String> {
    let mut models: Vec<String> = Vec::new();
    let mut consider = |value: Option<&Value>| {
        let text = value_or_empty(value);
        let text = js_trim(&text);
        if text.is_empty() || utf16_len(text) > MAX_RELAY_MODEL_LENGTH {
            return;
        }
        if !models.iter().any(|seen| seen == text) {
            models.push(text.to_string());
        }
    };
    let object = summary.and_then(Value::as_object);
    if let Some(object) = object {
        consider(object.get("model"));
        if let Some(Value::Array(options)) = object.get("modelOptions") {
            for option in options {
                consider(Some(option));
            }
        }
    }
    if models.is_empty()
        && object.is_some_and(|object| {
            object.get("isOfficial") == Some(&Value::Bool(true))
                && object.get("appType") == Some(&Value::String("claude".to_string()))
        })
    {
        return claude_models::fallback_ids()
            .into_iter()
            .take(MAX_RELAY_MODELS)
            .map(str::to_string)
            .collect();
    }
    models.truncate(MAX_RELAY_MODELS);
    models
}

/// `encodeRelayShareCode`: `mcrelay1.` + base64url of the v2 JSON payload.
pub fn encode_relay_share_code(
    name: &str,
    app_type: &str,
    base_url: &str,
    models: &[String],
    relay_share_id: &str,
    auth_token: &str,
) -> String {
    let mut payload = Map::new();
    payload.insert("v".into(), json!(2));
    payload.insert("kind".into(), json!("multicc-relay"));
    payload.insert("name".into(), json!(name));
    payload.insert("appType".into(), json!(app_type));
    payload.insert("baseUrl".into(), json!(base_url));
    if let Some(first) = models.first().filter(|first| !first.is_empty()) {
        payload.insert("model".into(), json!(first));
        payload.insert("models".into(), json!(models));
    }
    payload.insert("relayShareId".into(), json!(relay_share_id));
    payload.insert("authToken".into(), json!(auth_token));
    let text = js_json_stringify(&Value::Object(payload));
    format!("{RELAY_CODE_PREFIX}{}", URL_SAFE_NO_PAD.encode(text))
}

/// `parseCredential` (`mcr1.<id>.<secret>`).
pub fn parse_credential(token: Option<&Value>) -> Option<(String, String)> {
    let token = token?;
    crate::relay_shares::parse_credential(&crate::js::from_serde(token))
}

/// `relayRouteFromBaseUrl`: `{ appType, providerId, url }` for a proxy path.
pub fn relay_route_from_base_url(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    let route = crate::relay_shares::relay_route(&crate::js::from_serde(value))?;
    Some(crate::js::to_serde(&route))
}

/// The lender's public URLs for a new share.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayShareUrls {
    pub base: String,
    pub relay_base_url: String,
}

/// `new URL(...)` + origin + the per-app relay path. `None` is the route's 400.
pub fn relay_share_urls(
    app_type: &str,
    provider_id: &str,
    public_base_url: Option<&Value>,
) -> Option<RelayShareUrls> {
    let raw = value_or_empty(public_base_url);
    let parsed = url::Url::parse(js_trim(&raw)).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let base = parsed.origin().ascii_serialization();
    let encoded = encode_uri_component(provider_id);
    let relay_base_url = if app_type == "codex" {
        format!("{base}/codex-proxy/{encoded}")
    } else {
        format!("{base}/claude-proxy/{encoded}/remote")
    };
    Some(RelayShareUrls {
        base,
        relay_base_url,
    })
}

/// The `DELETE /api/providers/:appType/:id` decision tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeletePlan {
    /// 409 `PROVIDER_IN_USE`.
    InUse,
    /// References exist and the caller may force: detach, then delete.
    Detach,
    /// Nothing references the provider.
    Delete,
}

pub fn plan_delete(reference_count: usize, force: bool, forceable: bool) -> DeletePlan {
    if reference_count == 0 {
        DeletePlan::Delete
    } else if force && forceable {
        DeletePlan::Detach
    } else {
        DeletePlan::InUse
    }
}

/// 409 body when the provider is still referenced.
pub fn provider_in_use_response(references: &Value, forceable: bool) -> Value {
    let mut out = Map::new();
    out.insert("error".into(), json!("provider is still referenced"));
    out.insert("code".into(), json!("PROVIDER_IN_USE"));
    out.insert("references".into(), references.clone());
    out.insert("forceable".into(), Value::Bool(forceable));
    Value::Object(out)
}

/// 409 body when some reference could not be detached.
pub fn detach_failed_response(failed: &Value, detached: &Value) -> Value {
    let mut out = Map::new();
    out.insert(
        "error".into(),
        json!("provider references could not all be detached"),
    );
    out.insert("code".into(), json!("PROVIDER_DETACH_FAILED"));
    out.insert("references".into(), failed.clone());
    out.insert("detached".into(), detached.clone());
    out.insert("forceable".into(), Value::Bool(false));
    Value::Object(out)
}

/// 200 body of a successful delete.
pub fn delete_response(ok: bool, forced: bool, detached: &Value) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(ok));
    if forced {
        out.insert("forced".into(), Value::Bool(true));
        out.insert("detached".into(), detached.clone());
    }
    Value::Object(out)
}

/// `String(req.params.appType || '').trim()` must be one of the two pools.
pub fn is_valid_app_type(app_type: &str) -> bool {
    app_type == "claude" || app_type == "codex"
}

/// `rawTarget == null || rawTarget === '' ? null : String(rawTarget).trim()`.
/// `Some("")` is possible (`" "` trims to empty) and is falsy downstream.
pub fn reassign_target_id(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(other) => Some(js_trim(&js_string(other)).to_string()),
    }
}

/// `body.dryRun === true || body.dryRun === '1' || body.dryRun === 'true'`.
pub fn reassign_dry_run(body: Option<&Map<String, Value>>) -> bool {
    match body.and_then(|object| object.get("dryRun")) {
        Some(Value::Bool(true)) => true,
        Some(Value::String(text)) => text == "1" || text == "true",
        _ => false,
    }
}

/// The two validation steps that happen before any provider lookup, in order:
/// the target must differ from the source, and a non-dry run needs a target.
pub fn reassign_precheck(
    provider_id: &str,
    target: Option<&str>,
    dry_run: bool,
) -> Result<(), (u16, &'static str)> {
    if target == Some(provider_id) {
        return Err((400, "target provider must differ from the source"));
    }
    if target.is_none_or(str::is_empty) && !dry_run {
        return Err((400, "targetProviderId is required"));
    }
    Ok(())
}

/// The provider-defaults keys a PUT body touches, in the route's order.
pub fn defaults_updates(body: Option<&Map<String, Value>>) -> Vec<(String, Value)> {
    let mut updates = Vec::new();
    for cli in ["claude", "codex"] {
        if let Some(value) = body.and_then(|object| object.get(cli)) {
            updates.push((cli.to_string(), value.clone()));
        }
    }
    updates
}

/// 400 body of an invalid provider-defaults value.
pub fn invalid_defaults_error(cli: &str) -> Value {
    json!({ "error": format!("invalid {cli} provider id") })
}

/// The merge the PUT route performs on the live defaults object.
pub fn merge_defaults(updates: &[(String, Value)]) -> Map<String, Value> {
    let mut out = Map::new();
    for (cli, value) in updates {
        out.insert(cli.clone(), value.clone());
    }
    out
}

/// `GET /api/providers`: Express object order with `available` first and the
/// derived `ccSwitchAvailable`. Members the host omitted stay omitted, like
/// `JSON.stringify` dropping `undefined`.
pub fn catalog_body(facts: &Value) -> Value {
    let object = facts.as_object();
    let mut out = Map::new();
    out.insert("available".into(), Value::Bool(true));
    let status = object.and_then(|object| object.get("ccSwitchStatus"));
    if let Some(Value::Object(status)) = status {
        if let Some(available) = status.get("available") {
            out.insert("ccSwitchAvailable".into(), available.clone());
        }
    }
    for (key, source) in [
        ("ccSwitchStatus", status),
        (
            "providers",
            object.and_then(|object| object.get("providers")),
        ),
        ("defaults", object.and_then(|object| object.get("defaults"))),
        ("stats", object.and_then(|object| object.get("stats"))),
        (
            "limitCacheStaleMs",
            object.and_then(|object| object.get("limitCacheStaleMs")),
        ),
    ] {
        if let Some(value) = source {
            out.insert(key.into(), value.clone());
        }
    }
    Value::Object(out)
}

/// The `appType` pool a session's `cli` draws its provider from, or `None` for a
/// CLI with no managed pool. Retired from `src/providers/references.js`'s
/// `appTypeForCli`; the `-exp` lanes fold onto their base CLI and `opencode`
/// draws from the Claude pool.
pub fn reference_app_type_for_cli(cli: Option<&str>) -> Option<&'static str> {
    match cli {
        Some("codex") | Some("codex-exp") => Some("codex"),
        Some("claude") | Some("claude-exp") | Some("opencode") => Some("claude"),
        _ => None,
    }
}

/// Whether a session's `cli` may bind a provider from *either* stored pool, so
/// its own pool must not be compared with the one being deleted. Provider ids
/// are globally unique, which is what makes the exact-id match below sufficient.
pub fn reference_cli_spans_pools(cli: Option<&str>) -> bool {
    matches!(cli, Some("opencode") | Some("zcode"))
}

/// Whether the deletion target names a managed pool at all. A blank or unknown
/// `appType`, or a blank provider id, has no references by construction.
pub fn reference_target_is_poolable(app_type: &str, provider_id: &str) -> bool {
    matches!(app_type, "claude" | "codex") && !provider_id.is_empty()
}

/// The pool the Aux queue's own provider belongs to: its wire protocol decides,
/// not a stored `appType`. Anything other than `openai` (case-insensitively) is
/// an Anthropic-shaped route and therefore the Claude pool.
///
/// The retired rule used JavaScript's full-Unicode `toLowerCase()`. An ASCII
/// fold is equivalent *for this target*: no non-ASCII code point lowercases to
/// any of `o p e n a i`, so no input can reach `"openai"` through the Unicode
/// path without already being ASCII. A different target string would need the
/// Unicode fold back.
pub fn reference_aux_app_type(protocol: Option<&str>) -> &'static str {
    match protocol {
        Some(value) if value.eq_ignore_ascii_case("openai") => "codex",
        _ => "claude",
    }
}

/// Whether a trimmed Auto pool still has enough enabled candidates to stay in
/// Auto mode. Below two it collapses to a manual route on the first remaining
/// candidate, because an Auto pool of one has nothing to fail over to.
pub fn detach_keeps_auto(enabled: usize) -> bool {
    enabled >= 2
}

/// The `maxAttempts` written back onto a trimmed Auto pool. The runtime derives
/// the real attempt budget from the enabled pool; this stored value only has to
/// stay inside the legacy-valid 2..=4 band for older readers.
pub fn detach_max_attempts(enabled: usize) -> f64 {
    enabled.clamp(2, 4) as f64
}

/// How much of a failed patch's error message is reported back. The retired
/// rule sliced the *string* at 200, i.e. UTF-16 code units, so the slice itself
/// stays in JavaScript; only the bound lives here.
pub const DETACH_ERROR_LIMIT: f64 = 200.0;

/// `Set` membership helper used by tests and callers reading a model list.
pub fn unique_models(models: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    models
        .iter()
        .filter(|model| seen.insert((*model).clone()))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trimmed_auto_pool_collapses_to_manual_below_two_enabled_candidates() {
        assert!(!detach_keeps_auto(0));
        assert!(!detach_keeps_auto(1));
        assert!(detach_keeps_auto(2));
        assert!(detach_keeps_auto(9));
        // Clamped into the legacy 2..=4 band in both directions.
        assert_eq!(detach_max_attempts(0), 2.0);
        assert_eq!(detach_max_attempts(2), 2.0);
        assert_eq!(detach_max_attempts(3), 3.0);
        assert_eq!(detach_max_attempts(4), 4.0);
        assert_eq!(detach_max_attempts(9), 4.0);
        assert_eq!(DETACH_ERROR_LIMIT, 200.0);
    }

    #[test]
    fn reference_pool_rules_fold_the_exp_lanes_and_span_the_cross_pool_clis() {
        assert_eq!(reference_app_type_for_cli(Some("codex")), Some("codex"));
        assert_eq!(reference_app_type_for_cli(Some("codex-exp")), Some("codex"));
        assert_eq!(reference_app_type_for_cli(Some("claude")), Some("claude"));
        assert_eq!(
            reference_app_type_for_cli(Some("claude-exp")),
            Some("claude")
        );
        // OpenCode draws from the Claude pool *and* spans both pools: the pool
        // comparison is skipped for it, so this mapping only matters elsewhere.
        assert_eq!(reference_app_type_for_cli(Some("opencode")), Some("claude"));
        assert_eq!(reference_app_type_for_cli(Some("zcode")), None);
        assert_eq!(reference_app_type_for_cli(Some("kimi")), None);
        assert_eq!(reference_app_type_for_cli(None), None);

        assert!(reference_cli_spans_pools(Some("opencode")));
        assert!(reference_cli_spans_pools(Some("zcode")));
        assert!(!reference_cli_spans_pools(Some("claude")));
        assert!(!reference_cli_spans_pools(None));
    }

    #[test]
    fn a_reference_target_needs_both_a_known_pool_and_an_id() {
        assert!(reference_target_is_poolable("claude", "p1"));
        assert!(reference_target_is_poolable("codex", "p1"));
        assert!(!reference_target_is_poolable("opencode", "p1"));
        assert!(!reference_target_is_poolable("", "p1"));
        assert!(!reference_target_is_poolable("claude", ""));
    }

    #[test]
    fn the_aux_pool_follows_its_wire_protocol_not_an_app_type() {
        assert_eq!(reference_aux_app_type(Some("openai")), "codex");
        assert_eq!(reference_aux_app_type(Some("OpenAI")), "codex");
        assert_eq!(reference_aux_app_type(Some("anthropic")), "claude");
        assert_eq!(reference_aux_app_type(Some("")), "claude");
        assert_eq!(reference_aux_app_type(None), "claude");
    }

    #[test]
    fn native_provider_lines_preserve_lane_and_identifier_rules() {
        let vendors = vec!["qoder".to_string(), "grok".to_string()];
        let check = |cli, id, phase| {
            native_provider_line(cli, id, phase, &vendors, "-native:", "opencode-native:")
        };
        assert_eq!(check(Some("qoder"), "qoder-native:", 1), 1);
        assert_eq!(check(Some("claude"), "qoder-native:any", 1), 2);
        assert_eq!(check(Some("qoder"), "other-native:any", 1), 0);
        assert_eq!(check(Some("opencode"), "opencode-native:Z-1", 2), 1);
        assert_eq!(check(Some("opencode"), "opencode-native:-bad", 2), 2);
        assert_eq!(check(Some("claude"), "opencode-native:good", 2), 2);
        assert_eq!(
            check(
                Some("opencode"),
                &format!("opencode-native:{}", "x".repeat(65)),
                2
            ),
            2
        );
    }
    use crate::js::serde::js_json_stringify;

    fn body(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    #[test]
    fn ip_detection_matches_the_node_vectors() {
        for good in [
            "1.2.3.4",
            "0.0.0.0",
            "255.255.255.255",
            " 10.0.0.1 ",
            "::1",
            "2001:db8::1",
            "fe80::",
            ":",
            "1:2:3:4:5:6:7:8:9",
            "01.02.03.004",
        ] {
            assert!(is_valid_ip(good), "{good}");
        }
        for bad in [
            "",
            " ",
            "1.2.3",
            "1.2.3.4.5",
            "256.0.0.1",
            "1.2.3.999",
            "1.2.3.-1",
            "1.2.3.4/24",
            "localhost",
            "::1%en0",
            "2001:db8::1g",
            "1.2.3.4:80",
        ] {
            assert!(!is_valid_ip(bad), "{bad}");
        }
        // A four-part dotted value with non-digits is not the dotted shape and
        // has no colon, so it is rejected.
        assert!(!is_valid_ip("a.b.c.d"));
    }

    #[test]
    fn egress_allowlist_keeps_the_three_cases_apart() {
        assert_eq!(parse_egress_ip_allowlist(None), Ok(None));
        assert_eq!(
            parse_egress_ip_allowlist(Some(&Map::new())),
            Ok(None),
            "absent is not the same as null"
        );
        assert_eq!(
            parse_egress_ip_allowlist(Some(&body(json!({ "egressIpAllowlist": null })))),
            Ok(Some(Vec::new()))
        );
        assert_eq!(
            parse_egress_ip_allowlist(Some(&body(
                json!({ "egressIpAllowlist": [" 1.2.3.4 ", "", null, 5] })
            ))),
            Err("egressIpAllowlist contains an invalid IP address: null".into()),
            "String(v).trim() then filter(Boolean), then the first invalid IP wins"
        );
        assert_eq!(
            parse_egress_ip_allowlist(Some(&body(
                json!({ "egressIpAllowlist": [" 1.2.3.4 ", "", " 2001:db8::1 "] })
            ))),
            Ok(Some(vec!["1.2.3.4".into(), "2001:db8::1".into()]))
        );
        assert_eq!(
            parse_egress_ip_allowlist(Some(&body(json!({ "egressIpAllowlist": "1.2.3.4" })))),
            Err("egressIpAllowlist must be an array of IP addresses".into())
        );
        assert_eq!(
            parse_egress_ip_allowlist(Some(&body(
                json!({ "egressIpAllowlist": ["1.2.3.4", "nope"] })
            ))),
            Err("egressIpAllowlist contains an invalid IP address: nope".into())
        );
    }

    #[test]
    fn egress_binding_narrows_to_the_two_ids() {
        assert_eq!(parse_egress_binding(None), Ok(None));
        assert_eq!(
            parse_egress_binding(Some(&body(json!({ "egressBinding": null })))),
            Ok(Some(Value::Null))
        );
        assert_eq!(
            parse_egress_binding(Some(&body(json!({
                "egressBinding": { "profileId": "p", "pluginId": "x", "extra": 1 }
            })))),
            Ok(Some(json!({ "pluginId": "x", "profileId": "p" })))
        );
        assert_eq!(
            parse_egress_binding(Some(&body(json!({ "egressBinding": ["x"] })))),
            Err("egressBinding must be an object with pluginId and profileId".into())
        );
        assert_eq!(
            parse_egress_binding(Some(&body(json!({ "egressBinding": 3 })))),
            Err("egressBinding must be an object with pluginId and profileId".into())
        );
        // Missing members are `undefined` and stay absent from the envelope.
        assert_eq!(
            parse_egress_binding(Some(&body(json!({ "egressBinding": {} })))),
            Ok(Some(json!({})))
        );
        assert_eq!(
            validate_egress(Some(&body(json!({
                "egressIpAllowlist": "bad",
                "egressBinding": 1
            })))),
            Err("egressIpAllowlist must be an array of IP addresses".into())
        );
    }

    #[test]
    fn create_payload_trims_and_omits_the_same_keys() {
        let payload = create_payload(Some(&body(json!({
            "appType": " claude ",
            "name": "  kept raw ",
            "baseUrl": " http://x ",
            "authToken": " tok ",
            "model": " m ",
            "models": ["a"],
            "apiFormat": null,
            "settingsConfig": { "env": {} },
            "virtual": false,
            "aliasMap": {},
            "egressIpAllowlist": ["1.2.3.4"],
            "egressBinding": { "pluginId": "p", "profileId": "q" },
            "unknown": "dropped"
        }))))
        .unwrap();
        assert_eq!(
            js_json_stringify(&Value::Object(payload)),
            r#"{"appType":"claude","name":"  kept raw ","baseUrl":"http://x","authToken":"tok","model":"m","models":["a"],"apiFormat":null,"settingsConfig":{"env":{}},"virtual":false,"aliasMap":{},"egressIpAllowlist":["1.2.3.4"],"egressBinding":{"pluginId":"p","profileId":"q"}}"#
        );
        let minimal = create_payload(None).unwrap();
        assert_eq!(
            js_json_stringify(&Value::Object(minimal)),
            r#"{"appType":"","baseUrl":"","authToken":"","model":""}"#
        );
        assert!(create_payload(Some(&body(json!({
            "egressIpAllowlist": ["bad"]
        }))))
        .is_err());
        // egress parsing runs before the object literal, so its error wins
        // even when a later trim would also throw.
        assert_eq!(
            create_payload(Some(&body(json!({
                "appType": 7,
                "egressIpAllowlist": "bad"
            })))),
            Err("egressIpAllowlist must be an array of IP addresses".into())
        );
        // A truthy non-string has no `.trim`; the caught TypeError text is
        // what the 400 body carries.
        assert_eq!(
            create_payload(Some(&body(json!({ "appType": ["claude"] })))),
            Err(r#"(req.body.appType || "").trim is not a function"#.into())
        );
        assert_eq!(
            create_payload(Some(&body(json!({ "baseUrl": {} })))),
            Err(r#"(req.body.baseUrl || "").trim is not a function"#.into())
        );
        // Falsy non-strings take the `|| ''` branch.
        let falsy = create_payload(Some(&body(json!({
            "appType": 0,
            "baseUrl": false,
            "authToken": null,
            "model": ""
        }))))
        .unwrap();
        assert_eq!(
            js_json_stringify(&Value::Object(falsy)),
            r#"{"appType":"","baseUrl":"","authToken":"","model":""}"#
        );
    }

    #[test]
    fn update_payload_keeps_raw_members_and_the_same_spreads() {
        let payload = update_payload(Some(&body(json!({
            "appType": "ignored",
            "name": " kept ",
            "baseUrl": " http://x ",
            "authToken": " tok ",
            "model": " m ",
            "models": ["a"],
            "apiFormat": null,
            "settingsConfig": { "env": {} },
            "virtual": false,
            "aliasMap": {},
            "egressIpAllowlist": null,
            "egressBinding": { "pluginId": "p" },
            "unknown": "dropped"
        }))))
        .unwrap();
        assert_eq!(
            js_json_stringify(&Value::Object(payload)),
            r#"{"name":" kept ","baseUrl":" http://x ","authToken":" tok ","model":" m ","models":["a"],"apiFormat":null,"settingsConfig":{"env":{}},"virtual":false,"aliasMap":{},"egressIpAllowlist":[],"egressBinding":{"pluginId":"p"}}"#
        );
        assert_eq!(
            js_json_stringify(&Value::Object(update_payload(None).unwrap())),
            "{}"
        );
        assert_eq!(
            update_payload(Some(&body(json!({ "egressBinding": "bad" })))),
            Err("egressBinding must be an object with pluginId and profileId".into())
        );
    }

    #[test]
    fn probe_candidates_follow_the_route_limits() {
        assert_eq!(normalize_probe_candidates(None), Ok(None));
        assert_eq!(normalize_probe_candidates(Some(&Value::Null)), Ok(None));
        assert_eq!(
            normalize_probe_candidates(Some(&json!("x"))),
            Err((400, "probe candidates must be an array"))
        );
        let many: Vec<Value> = (0..21).map(|i| json!(format!("m{i}"))).collect();
        assert_eq!(
            normalize_probe_candidates(Some(&Value::Array(many))),
            Err((413, "too many probe candidates"))
        );
        assert_eq!(
            normalize_probe_candidates(Some(&json!([" a ", "a", "b"]))),
            Ok(Some(vec!["a".into(), "b".into()]))
        );
        assert_eq!(
            normalize_probe_candidates(Some(&json!([1]))),
            Err((400, "invalid probe candidate"))
        );
        assert_eq!(
            normalize_probe_candidates(Some(&json!(["   "]))),
            Err((400, "invalid probe candidate"))
        );
        assert_eq!(
            normalize_probe_candidates(Some(&json!(["x".repeat(200)]))),
            Ok(Some(vec!["x".repeat(200)]))
        );
        assert_eq!(
            normalize_probe_candidates(Some(&json!(["x".repeat(201)]))),
            Err((400, "invalid probe candidate"))
        );
    }

    #[test]
    fn probe_results_are_shallow_copies_with_sanitized_strings() {
        let result = json!({
            "error": "token: abc",
            "tested": [
                { "error": "upstream down", "reason": "bad", "sample": "/etc/passwd", "model": "m" },
                "line",
                null
            ],
            "accepted": ["m"],
            "other": 1
        });
        assert_eq!(
            sanitize_probe_result(&result),
            json!({
                "error": "provider probe failed",
                "tested": [
                    {
                        "error": "provider probe failed",
                        "reason": "bad",
                        "sample": "provider probe output hidden",
                        "model": "m"
                    },
                    "line",
                    null
                ],
                "accepted": ["m"],
                "other": 1
            })
        );
        assert_eq!(sanitize_probe_result(&json!(["x"])), json!(["x"]));
        assert_eq!(sanitize_probe_result(&Value::Null), Value::Null);
    }

    #[test]
    fn import_error_dto_matches_the_route_body() {
        assert_eq!(
            import_error_dto(None, None, None),
            json!({ "error": "provider import failed" })
        );
        assert_eq!(
            import_error_dto(Some("bad cc"), Some(&json!("NOT_JSON")), Some(&json!("x"))),
            json!({ "error": "bad cc", "code": "NOT_JSON", "reason": "x" })
        );
        assert_eq!(
            import_error_dto(
                Some("upstream broke"),
                Some(&json!("bad code!")),
                Some(&json!(false))
            ),
            json!({ "error": "provider import failed", "code": "PROVIDER_IMPORT_FAILED" })
        );
        assert_eq!(
            import_error_dto(Some("bad cc"), Some(&json!("")), Some(&json!("/a/b"))),
            json!({ "error": "bad cc", "reason": "provider import failed" })
        );
    }

    #[test]
    fn relay_models_dedupes_trims_and_falls_back() {
        assert_eq!(relay_models_of(None), Vec::<String>::new());
        assert_eq!(
            relay_models_of(Some(&json!({
                "model": " a ",
                "modelOptions": ["a", "b", "", "  ", 3, "c".repeat(257)]
            }))),
            vec!["a".to_string(), "b".to_string(), "3".to_string()]
        );
        assert_eq!(
            relay_models_of(Some(&json!({
                "isOfficial": true,
                "appType": "claude",
                "model": "  "
            }))),
            claude_models::fallback_ids()
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            relay_models_of(Some(&json!({
                "isOfficial": "true",
                "appType": "claude"
            }))),
            Vec::<String>::new(),
            "isOfficial compares strictly with true"
        );
        let many: Vec<Value> = (0..150).map(|i| json!(format!("m{i}"))).collect();
        assert_eq!(
            relay_models_of(Some(&json!({ "modelOptions": many }))).len(),
            100
        );
        assert_eq!(
            unique_models(&["a".into(), "a".into(), "b".into()]).len(),
            2
        );
    }

    #[test]
    fn relay_share_code_round_trips_the_v2_payload() {
        let models = vec!["m1".to_string(), "m2".to_string()];
        let code = encode_relay_share_code(
            "Name · 远程共享",
            "claude",
            "https://host/claude-proxy/p%2F1/remote",
            &models,
            "share-1",
            "secret-token",
        );
        assert!(code.starts_with(RELAY_CODE_PREFIX));
        let encoded = &code[RELAY_CODE_PREFIX.len()..];
        let decoded = URL_SAFE_NO_PAD.decode(encoded).unwrap();
        assert_eq!(
            String::from_utf8(decoded).unwrap(),
            r#"{"v":2,"kind":"multicc-relay","name":"Name · 远程共享","appType":"claude","baseUrl":"https://host/claude-proxy/p%2F1/remote","model":"m1","models":["m1","m2"],"relayShareId":"share-1","authToken":"secret-token"}"#
        );
        let empty = encode_relay_share_code("n", "codex", "https://h", &[], "s", "t");
        let text = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(&empty[RELAY_CODE_PREFIX.len()..])
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            text,
            r#"{"v":2,"kind":"multicc-relay","name":"n","appType":"codex","baseUrl":"https://h","relayShareId":"s","authToken":"t"}"#
        );
        // JSON escaping is JSON.stringify's, not serde's pretty form.
        let escaped = encode_relay_share_code("a\"b\\c\n", "claude", "https://h", &[], "s", "t");
        let text = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(&escaped[RELAY_CODE_PREFIX.len()..])
                .unwrap(),
        )
        .unwrap();
        assert!(text.contains(r#""name":"a\"b\\c\n""#));
    }

    #[test]
    fn credentials_and_relay_routes_reuse_the_relay_kernel() {
        assert_eq!(
            parse_credential(Some(&json!("mcr1.0123456789abcdef.secret12"))),
            Some(("0123456789abcdef".to_string(), "secret12".to_string()))
        );
        assert_eq!(parse_credential(Some(&json!("nope"))), None);
        assert_eq!(parse_credential(None), None);
        assert_eq!(
            relay_route_from_base_url(Some(&json!(
                "https://lender.example/claude-proxy/0123456789abcdef/remote"
            ))),
            Some(json!({
                "appType": "claude",
                "providerId": "0123456789abcdef",
                "url": "https://lender.example/claude-proxy/0123456789abcdef/remote"
            }))
        );
        assert_eq!(
            relay_route_from_base_url(Some(&json!("http://127.0.0.1/claude-proxy/x/remote"))),
            None
        );
    }

    #[test]
    fn share_urls_use_the_origin_and_encode_the_provider() {
        assert_eq!(
            relay_share_urls(
                "claude",
                "p 1",
                Some(&json!(" https://PUBLIC.example:8443/ignored/path?q=1 "))
            ),
            Some(RelayShareUrls {
                base: "https://public.example:8443".into(),
                relay_base_url: "https://public.example:8443/claude-proxy/p%201/remote".into(),
            })
        );
        assert_eq!(
            relay_share_urls("codex", "p/1", Some(&json!("http://h:80"))),
            Some(RelayShareUrls {
                base: "http://h".into(),
                relay_base_url: "http://h/codex-proxy/p%2F1".into(),
            })
        );
        assert_eq!(
            relay_share_urls("claude", "p", Some(&json!("ftp://h"))),
            None
        );
        assert_eq!(
            relay_share_urls("claude", "p", Some(&json!("not a url"))),
            None
        );
        assert_eq!(relay_share_urls("claude", "p", Some(&json!(42))), None);
        assert_eq!(relay_share_urls("claude", "p", None), None);
    }

    #[test]
    fn delete_plan_and_bodies() {
        assert_eq!(plan_delete(0, false, false), DeletePlan::Delete);
        assert_eq!(plan_delete(2, false, true), DeletePlan::InUse);
        assert_eq!(plan_delete(2, true, false), DeletePlan::InUse);
        assert_eq!(plan_delete(2, true, true), DeletePlan::Detach);

        assert_eq!(
            js_json_stringify(&provider_in_use_response(
                &json!([{ "kind": "session" }]),
                true
            )),
            r#"{"error":"provider is still referenced","code":"PROVIDER_IN_USE","references":[{"kind":"session"}],"forceable":true}"#
        );
        assert_eq!(
            js_json_stringify(&detach_failed_response(&json!(["a"]), &json!(["b"]))),
            r#"{"error":"provider references could not all be detached","code":"PROVIDER_DETACH_FAILED","references":["a"],"detached":["b"],"forceable":false}"#
        );
        assert_eq!(
            js_json_stringify(&delete_response(true, true, &json!(["a"]))),
            r#"{"ok":true,"forced":true,"detached":["a"]}"#
        );
        assert_eq!(
            js_json_stringify(&delete_response(false, false, &json!([]))),
            r#"{"ok":false}"#
        );
    }

    #[test]
    fn reassign_validation_order() {
        assert!(is_valid_app_type("claude"));
        assert!(is_valid_app_type("codex"));
        assert!(!is_valid_app_type("Claude"));
        assert!(!is_valid_app_type("opencode"));

        assert_eq!(reassign_target_id(None), None);
        assert_eq!(reassign_target_id(Some(&Value::Null)), None);
        assert_eq!(reassign_target_id(Some(&json!(""))), None);
        assert_eq!(reassign_target_id(Some(&json!(" p "))), Some("p".into()));
        assert_eq!(reassign_target_id(Some(&json!(" "))), Some("".into()));
        assert_eq!(
            reassign_target_id(Some(&json!(["a", "b"]))),
            Some("a,b".into())
        );
        assert_eq!(reassign_target_id(Some(&json!(0))), Some("0".into()));
        assert_eq!(
            reassign_target_id(Some(&json!({}))),
            Some("[object Object]".into())
        );

        assert!(reassign_dry_run(Some(&body(json!({ "dryRun": true })))));
        assert!(reassign_dry_run(Some(&body(json!({ "dryRun": "1" })))));
        assert!(reassign_dry_run(Some(&body(json!({ "dryRun": "true" })))));
        assert!(!reassign_dry_run(Some(&body(json!({ "dryRun": "TRUE" })))));
        assert!(!reassign_dry_run(None));

        assert_eq!(
            reassign_precheck("p", Some("p"), true),
            Err((400, "target provider must differ from the source"))
        );
        assert_eq!(
            reassign_precheck("p", Some(""), false),
            Err((400, "targetProviderId is required"))
        );
        assert_eq!(
            reassign_precheck("p", None, false),
            Err((400, "targetProviderId is required"))
        );
        assert_eq!(reassign_precheck("p", None, true), Ok(()));
        assert_eq!(reassign_precheck("p", Some("q"), false), Ok(()));
        // An empty target is falsy and is not required on a dry run either.
        assert_eq!(reassign_precheck("p", Some(""), true), Ok(()));
    }

    #[test]
    fn defaults_updates_and_merge_keep_the_two_keys_in_order() {
        assert!(defaults_updates(None).is_empty());
        let updates = defaults_updates(Some(&body(json!({
            "codex": "c",
            "other": 1,
            "claude": null
        }))));
        assert_eq!(
            updates,
            vec![
                ("claude".to_string(), Value::Null),
                ("codex".to_string(), json!("c")),
            ]
        );
        assert_eq!(
            js_json_stringify(&Value::Object(merge_defaults(&updates))),
            r#"{"claude":null,"codex":"c"}"#
        );
        assert_eq!(
            invalid_defaults_error("codex"),
            json!({ "error": "invalid codex provider id" })
        );
    }

    #[test]
    fn catalog_body_orders_the_members_and_derives_cc_switch() {
        let facts = json!({
            "ok": true,
            "ccSwitchStatus": { "available": false, "path": "/x" },
            "providers": [{ "id": "p" }],
            "stats": { "total": { "turnCount": 1 } },
            "defaults": { "claude": null, "codex": null },
            "limitCacheStaleMs": 60000
        });
        assert_eq!(
            js_json_stringify(&catalog_body(&facts)),
            r#"{"available":true,"ccSwitchAvailable":false,"ccSwitchStatus":{"available":false,"path":"/x"},"providers":[{"id":"p"}],"defaults":{"claude":null,"codex":null},"stats":{"total":{"turnCount":1}},"limitCacheStaleMs":60000}"#
        );
        // A host answer with no cache still carries `limitCacheStaleMs: null`.
        assert_eq!(
            js_json_stringify(&catalog_body(&json!({
                "ccSwitchStatus": { "available": true },
                "providers": [],
                "defaults": {},
                "stats": {},
                "limitCacheStaleMs": null
            }))),
            r#"{"available":true,"ccSwitchAvailable":true,"ccSwitchStatus":{"available":true},"providers":[],"defaults":{},"stats":{},"limitCacheStaleMs":null}"#
        );
        // Unknown members are dropped; an absent status drops its derived key.
        assert_eq!(
            js_json_stringify(&catalog_body(&json!({ "extra": 1 }))),
            r#"{"available":true}"#
        );
    }

    // ── provider id validation ─────────────────────────────────────────────

    fn vendor_list() -> Vec<String> {
        VENDOR_NATIVE_CLIS
            .iter()
            .map(|cli| (*cli).to_string())
            .collect()
    }

    fn claude_facts(api_format: &str) -> ProviderCliFacts {
        ProviderCliFacts {
            app_type: Some("claude".into()),
            api_format: Some(api_format.into()),
            ..Default::default()
        }
    }

    #[test]
    fn compatible_pools_keep_the_retired_order_and_gate_credentials() {
        assert_eq!(
            compatible_clis_for_format("anthropic"),
            &["claude", "claude-exp", "opencode", "zcode", "dsh", "grok"]
        );
        assert_eq!(
            compatible_clis_for_format("openai_responses"),
            &["codex", "codex-exp", "opencode", "zcode", "kimi", "grok"]
        );
        // Anything that is not the Anthropic constant selects the OpenAI pool.
        assert_eq!(compatible_clis_for_format(""), &OPENAI_COMPATIBLE_CLIS);
        assert_eq!(
            compatible_clis("anthropic", false),
            vec!["claude", "claude-exp", "opencode"]
        );
        assert_eq!(
            compatible_clis("openai_responses", false),
            vec!["codex", "codex-exp", "opencode"]
        );
        assert_eq!(compatible_clis("anthropic", true).len(), 6);
        assert_eq!(
            compatible_clis("openai_responses", true),
            vec!["codex", "codex-exp", "opencode", "zcode", "kimi", "grok"]
        );
        assert!(CREDENTIAL_GATED_CLIS.contains(&"dsh"));
        assert!(!CREDENTIAL_GATED_CLIS.contains(&"opencode"));
    }

    #[test]
    fn cli_pools_and_native_lanes_match_the_retired_tables() {
        assert_eq!(app_type_for_cli("codex"), Some("codex"));
        assert_eq!(app_type_for_cli("codex-exp"), Some("codex"));
        assert_eq!(app_type_for_cli("claude"), Some("claude"));
        assert_eq!(app_type_for_cli("claude-exp"), Some("claude"));
        assert_eq!(app_type_for_cli("opencode"), Some("claude"));
        assert_eq!(app_type_for_cli("dsh"), Some("claude"));
        assert_eq!(app_type_for_cli("zcode"), None);
        assert_eq!(app_type_for_cli("kimi"), None);
        assert_eq!(app_type_for_cli("grok"), None);
        assert_eq!(app_type_for_cli("qoder"), None);
        assert_eq!(app_type_for_cli(""), None);

        assert_eq!(app_types_for_cli("opencode"), vec!["claude", "codex"]);
        assert_eq!(app_types_for_cli("zcode"), vec!["claude", "codex"]);
        assert_eq!(app_types_for_cli("kimi"), vec!["claude", "codex"]);
        assert_eq!(app_types_for_cli("grok"), vec!["claude", "codex"]);
        assert_eq!(app_types_for_cli("claude-exp"), vec!["claude"]);
        assert_eq!(app_types_for_cli("codex-exp"), vec!["codex"]);
        assert_eq!(app_types_for_cli("dsh"), vec!["claude"]);
        assert!(app_types_for_cli("qoder").is_empty());
        assert!(app_types_for_cli("").is_empty());

        assert_eq!(folded_cli_for_normalize(Some("codex-exp")), Some("codex"));
        assert_eq!(folded_cli_for_normalize(Some("claude-exp")), Some("claude"));
        assert_eq!(folded_cli_for_normalize(Some("opencode")), Some("opencode"));
        assert_eq!(folded_cli_for_normalize(None), None);
    }

    #[test]
    fn provider_supports_cli_follows_virtual_format_and_credentials() {
        // A falsy provider or cli rejects outright.
        assert!(!provider_supports_cli(None, Some("claude")));
        assert!(!provider_supports_cli(
            Some(&ProviderCliFacts::default()),
            None
        ));

        // Virtual lines serve only their own pool and its -exp lane.
        let virtual_facts = ProviderCliFacts {
            app_type: Some("claude".into()),
            virtual_truthy: true,
            // The stored format is irrelevant for a virtual line.
            api_format: Some("openai_responses".into()),
            ..Default::default()
        };
        assert!(provider_supports_cli(Some(&virtual_facts), Some("claude")));
        assert!(provider_supports_cli(
            Some(&virtual_facts),
            Some("claude-exp")
        ));
        assert!(!provider_supports_cli(Some(&virtual_facts), Some("codex")));
        assert!(!provider_supports_cli(
            Some(&virtual_facts),
            Some("opencode")
        ));

        // The format table decides the pool.
        assert!(provider_supports_cli(
            Some(&claude_facts("anthropic")),
            Some("claude")
        ));
        assert!(provider_supports_cli(
            Some(&claude_facts("anthropic")),
            Some("opencode")
        ));
        assert!(!provider_supports_cli(
            Some(&claude_facts("anthropic")),
            Some("codex")
        ));
        assert!(provider_supports_cli(
            Some(&claude_facts("openai_responses")),
            Some("claude")
        ));
        // With no pool to pin it, the requested format decides.
        let unpinned = ProviderCliFacts {
            api_format: Some("openai_responses".into()),
            ..Default::default()
        };
        assert!(provider_supports_cli(Some(&unpinned), Some("codex")));
        assert!(!provider_supports_cli(Some(&unpinned), Some("claude")));
        // A known pool pins the format even when the row asks for the other one.
        let pinned = ProviderCliFacts {
            app_type: Some("codex".into()),
            api_format: Some("anthropic".into()),
            ..Default::default()
        };
        assert!(!provider_supports_cli(Some(&pinned), Some("claude")));
        assert!(provider_supports_cli(Some(&pinned), Some("codex")));
        // `protocol` is the fallback when `apiFormat` is absent.
        let protocol_only = ProviderCliFacts {
            app_type: Some("claude".into()),
            protocol: Some("messages".into()),
            ..Default::default()
        };
        assert!(provider_supports_cli(Some(&protocol_only), Some("claude")));

        // Gated lanes need a real baseUrl *and* a token; plain lanes do not.
        let gated = ProviderCliFacts {
            app_type: Some("claude".into()),
            api_format: Some("anthropic".into()),
            base_url_truthy: true,
            has_token_truthy: false,
            ..Default::default()
        };
        assert!(provider_supports_cli(Some(&gated), Some("claude")));
        assert!(!provider_supports_cli(Some(&gated), Some("dsh")));
        assert!(!provider_supports_cli(Some(&gated), Some("grok")));
        let gated = ProviderCliFacts {
            has_token_truthy: true,
            ..gated
        };
        assert!(provider_supports_cli(Some(&gated), Some("dsh")));
        assert!(!provider_supports_cli(Some(&gated), Some("kimi")));
    }

    #[test]
    fn provider_cli_facts_read_a_json_summary() {
        assert_eq!(provider_cli_facts_from_json(None), None);
        assert_eq!(provider_cli_facts_from_json(Some(&Value::Null)), None);
        assert_eq!(provider_cli_facts_from_json(Some(&json!(false))), None);
        assert_eq!(
            provider_cli_facts_from_json(Some(&json!({}))),
            Some(ProviderCliFacts::default())
        );
        // A truthy primitive reads every member as undefined.
        assert_eq!(
            provider_cli_facts_from_json(Some(&json!(5))),
            Some(ProviderCliFacts::default())
        );
        assert_eq!(
            provider_cli_facts_from_json(Some(&json!({
                "appType": "codex",
                "virtual": "yes",
                "apiFormat": "",
                "protocol": "messages",
                "baseUrl": "https://h",
                "hasToken": 0
            }))),
            Some(ProviderCliFacts {
                app_type: Some("codex".into()),
                virtual_truthy: true,
                api_format: None,
                protocol: Some("messages".into()),
                base_url_truthy: true,
                has_token_truthy: false,
            })
        );
    }

    /// The two lazy lookups, recorded so call counts and order can be asserted.
    struct Recorder {
        normalize_present: bool,
        normalize_result: Option<Option<String>>,
        facts: Option<ProviderCliFacts>,
        normalize_calls: usize,
        normalize_cli: Option<String>,
        summary_calls: usize,
        summary_pool: Option<Option<String>>,
        summary_id: Option<String>,
    }

    impl Recorder {
        fn new() -> Self {
            Self {
                normalize_present: false,
                normalize_result: None,
                facts: None,
                normalize_calls: 0,
                normalize_cli: None,
                summary_calls: 0,
                summary_pool: None,
                summary_id: None,
            }
        }
    }

    impl ProviderIdQueries for Recorder {
        type Raw = Option<String>;
        type Error = ();
        fn can_normalize(&self) -> Result<bool, ()> {
            Ok(self.normalize_present)
        }
        fn normalize(
            &mut self,
            cli: Option<&str>,
            id: &Option<String>,
        ) -> Result<Option<String>, ()> {
            self.normalize_calls += 1;
            self.normalize_cli = cli.map(str::to_string);
            Ok(match &self.normalize_result {
                Some(result) => result.clone(),
                None => id.clone(),
            })
        }
        fn stringify(&mut self, id: &Option<String>) -> Result<Option<String>, ()> {
            Ok(id.clone())
        }
        fn summary(
            &mut self,
            app_type: Option<&str>,
            id: &str,
        ) -> Result<Option<ProviderCliFacts>, ()> {
            self.summary_calls += 1;
            self.summary_pool = Some(app_type.map(str::to_string));
            self.summary_id = Some(id.to_string());
            Ok(self.facts.clone())
        }
    }

    fn validate(
        recorder: &mut Recorder,
        cli: Option<&str>,
        id: Option<&str>,
    ) -> ValidatedProviderId {
        let vendors = vendor_list();
        validate_provider_id(
            recorder,
            cli,
            &id.map(str::to_string),
            &vendors,
            NATIVE_VENDOR_SUFFIX,
            NATIVE_OPENCODE_PREFIX,
        )
        .unwrap()
    }

    #[test]
    fn validate_provider_id_passes_the_empty_value_through_without_a_lookup() {
        let mut recorder = Recorder::new();
        assert_eq!(
            validate(&mut recorder, Some("claude"), None),
            empty_provider_id()
        );
        assert_eq!(
            validate(&mut recorder, Some("claude"), Some("")),
            empty_provider_id()
        );
        assert_eq!(recorder.normalize_calls, 0);
        assert_eq!(recorder.summary_calls, 0);

        // A normalizer that answers nullish is the same empty pass-through.
        let mut recorder = Recorder::new();
        recorder.normalize_present = true;
        recorder.normalize_result = Some(None);
        assert_eq!(
            validate(&mut recorder, Some("claude"), Some("whatever")),
            empty_provider_id()
        );
        assert_eq!(recorder.normalize_calls, 1);
        assert_eq!(recorder.summary_calls, 0);

        // A normalizer that answers '' is empty too.
        let mut recorder = Recorder::new();
        recorder.normalize_present = true;
        recorder.normalize_result = Some(Some(String::new()));
        assert_eq!(
            validate(&mut recorder, Some("claude"), Some("p1")),
            empty_provider_id()
        );
        assert_eq!(recorder.summary_calls, 0);
    }

    #[test]
    fn validate_provider_id_answers_native_lanes_without_a_lookup() {
        // Vendor-native: the id's lane must equal the cli.
        let mut recorder = Recorder::new();
        assert_eq!(
            validate(&mut recorder, Some("qoder"), Some("qoder-native:q1")),
            ValidatedProviderId {
                ok: true,
                value: Some("qoder-native:q1".into())
            }
        );
        assert_eq!(recorder.summary_calls, 0);
        let mut recorder = Recorder::new();
        assert_eq!(
            validate(&mut recorder, Some("claude"), Some("qoder-native:q1")),
            rejected_provider_id()
        );
        assert_eq!(recorder.summary_calls, 0);

        // opencode-native: only the opencode lane, structural id required.
        let mut recorder = Recorder::new();
        assert_eq!(
            validate(
                &mut recorder,
                Some("opencode"),
                Some("opencode-native:ok-1")
            ),
            ValidatedProviderId {
                ok: true,
                value: Some("opencode-native:ok-1".into())
            }
        );
        let mut recorder = Recorder::new();
        assert_eq!(
            validate(&mut recorder, Some("claude"), Some("opencode-native:ok-1")),
            rejected_provider_id()
        );
        for bad in [
            "opencode-native:",
            "opencode-native:-bad",
            "opencode-native:a b",
        ] {
            let mut recorder = Recorder::new();
            assert_eq!(
                validate(&mut recorder, Some("opencode"), Some(bad)),
                rejected_provider_id(),
                "{bad}"
            );
            assert_eq!(recorder.summary_calls, 0);
        }
        // A cli with no pool at all never reaches the lookup.
        let mut recorder = Recorder::new();
        assert_eq!(
            validate(&mut recorder, Some("qoder"), Some("plain")),
            rejected_provider_id()
        );
        assert_eq!(recorder.summary_calls, 0);
    }

    #[test]
    fn validate_provider_id_looks_up_only_at_step_five() {
        // A managed provider id on the claude lane.
        let mut recorder = Recorder::new();
        recorder.facts = Some(claude_facts("anthropic"));
        assert_eq!(
            validate(&mut recorder, Some("claude"), Some("p1")),
            ValidatedProviderId {
                ok: true,
                value: Some("p1".into())
            }
        );
        assert_eq!(recorder.summary_calls, 1);
        assert_eq!(recorder.summary_pool, Some(Some("claude".into())));
        assert_eq!(recorder.summary_id.as_deref(), Some("p1"));

        // A summary the format table rejects (no pool to pin the format).
        let mut recorder = Recorder::new();
        recorder.facts = Some(ProviderCliFacts {
            api_format: Some("openai_responses".into()),
            ..Default::default()
        });
        assert_eq!(
            validate(&mut recorder, Some("claude"), Some("p1")),
            rejected_provider_id()
        );
        assert_eq!(recorder.summary_calls, 1);

        // A missing provider.
        let mut recorder = Recorder::new();
        assert_eq!(
            validate(&mut recorder, Some("claude"), Some("p1")),
            rejected_provider_id()
        );
        assert_eq!(recorder.summary_calls, 1);

        // Both pools: the summary lookup gets an undefined appType.
        let mut recorder = Recorder::new();
        recorder.facts = Some(claude_facts("anthropic"));
        assert_eq!(
            validate(&mut recorder, Some("opencode"), Some("p1")),
            ValidatedProviderId {
                ok: true,
                value: Some("p1".into())
            }
        );
        assert_eq!(recorder.summary_pool, Some(None));

        // dsh is a single-pool cli even though it is credential-gated.
        let mut recorder = Recorder::new();
        recorder.facts = Some(ProviderCliFacts {
            app_type: Some("claude".into()),
            api_format: Some("anthropic".into()),
            base_url_truthy: true,
            has_token_truthy: true,
            ..Default::default()
        });
        assert!(validate(&mut recorder, Some("dsh"), Some("p1")).ok);
        assert_eq!(recorder.summary_pool, Some(Some("claude".into())));
    }

    #[test]
    fn validate_provider_id_folds_exp_clis_for_the_normalizer() {
        let mut recorder = Recorder::new();
        recorder.normalize_present = true;
        recorder.facts = Some(ProviderCliFacts {
            app_type: Some("codex".into()),
            api_format: Some("openai_responses".into()),
            ..Default::default()
        });
        assert!(validate(&mut recorder, Some("codex-exp"), Some("p1")).ok);
        assert_eq!(recorder.normalize_calls, 1);
        assert_eq!(recorder.normalize_cli.as_deref(), Some("codex"));
        assert_eq!(recorder.summary_pool, Some(Some("codex".into())));

        let mut recorder = Recorder::new();
        recorder.normalize_present = true;
        recorder.facts = Some(claude_facts("anthropic"));
        assert!(validate(&mut recorder, Some("claude-exp"), Some("p1")).ok);
        assert_eq!(recorder.normalize_cli.as_deref(), Some("claude"));

        // Without a normalizer the raw String(id) is used and no call happens.
        let mut recorder = Recorder::new();
        recorder.facts = Some(claude_facts("anthropic"));
        assert!(validate(&mut recorder, Some("claude"), Some("p1")).ok);
        assert_eq!(recorder.normalize_calls, 0);
    }

    #[test]
    fn provider_id_step_reports_the_lookup_pool() {
        let vendors = vendor_list();
        assert_eq!(
            provider_id_step(
                Some("claude"),
                None,
                &vendors,
                NATIVE_VENDOR_SUFFIX,
                NATIVE_OPENCODE_PREFIX
            ),
            ProviderIdStep::Empty
        );
        assert_eq!(
            provider_id_step(
                Some("claude"),
                Some(String::new()),
                &vendors,
                NATIVE_VENDOR_SUFFIX,
                NATIVE_OPENCODE_PREFIX
            ),
            ProviderIdStep::Empty
        );
        assert_eq!(
            provider_id_step(
                Some("claude"),
                Some("qoder-native:q".into()),
                &vendors,
                NATIVE_VENDOR_SUFFIX,
                NATIVE_OPENCODE_PREFIX
            ),
            ProviderIdStep::Rejected
        );
        assert_eq!(
            provider_id_step(
                Some("dsh"),
                Some("p1".into()),
                &vendors,
                NATIVE_VENDOR_SUFFIX,
                NATIVE_OPENCODE_PREFIX
            ),
            ProviderIdStep::Lookup {
                pool: Some("claude".into()),
                id: "p1".into()
            }
        );
        assert_eq!(
            provider_id_step(
                Some("grok"),
                Some("p1".into()),
                &vendors,
                NATIVE_VENDOR_SUFFIX,
                NATIVE_OPENCODE_PREFIX
            ),
            ProviderIdStep::Lookup {
                pool: None,
                id: "p1".into()
            }
        );
    }
}
