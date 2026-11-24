//! Each managed child gets a scoped loopback capability. The gateway alone reads
//! the selected provider and uses the shared CPR request and streaming code.
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Request, State},
    http::{HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use futures_util::stream;
use multicc_core::{
    auth_runtime,
    auth_security::timing_safe_equal_text,
    auto_provider_policy,
    claude_lane::LaunchInput,
    exact_secret::{normalize_secrets, redact_fragments, Secrets, StreamRedactor},
    js::{self, buffer::Utf8Decoder, JsString, JsValue as V},
    provider_attempt_identity, provider_limit_store, provider_store, random_id,
};
use multicc_cpr::{plan, transport::Exchange};
use serde_json::{json, Value};
use std::{io, path::Path, sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::watch, task::JoinHandle};
use url::Url;

const MAX_REQUEST: usize = 25 * 1024 * 1024;
const MODEL_KEYS: [&str; 5] = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
];

pub(super) struct Provider {
    pub id: String,
    pub name: String,
    pub model: Option<String>,
    effort: Option<String>,
    claude_workflow: Option<bool>,
    pub revision: String,
    provider: Value,
    env: Value,
    codex_credential: Option<Value>,
    protocol: &'static str,
}

impl Provider {
    pub async fn load(root: &Path, record: &V) -> Result<Option<Self>, String> {
        match selection(record)? {
            None => Self::load_fixed(root, record).await,
            Some(selection) => {
                let root = root.to_owned();
                let record = js::to_serde(record);
                tokio::task::spawn_blocking(move || choose(&root, &record, &selection).map(Some))
                    .await
                    .map_err(|error| error.to_string())?
            }
        }
    }

    pub async fn load_fixed(root: &Path, record: &V) -> Result<Option<Self>, String> {
        let Some(id) = super::optional_text(record, "provider") else {
            return Ok(None);
        };
        let root = root.to_owned();
        let model = super::optional_text(record, "model");
        tokio::task::spawn_blocking(move || {
            let list = catalog(&root)?;
            let provider = lookup(&list, &id)?.clone();
            Self::configured(provider, id, model).map(Some)
        })
        .await
        .map_err(|error| error.to_string())?
    }

    fn configured(mut provider: Value, id: String, model: Option<String>) -> Result<Self, String> {
        let config = &provider["settingsConfig"];
        let config = match config.as_str() {
            Some(raw) => {
                serde_json::from_str::<Value>(raw).map_err(|_| "provider_invalid_settings")?
            }
            None => config.clone(),
        };
        if provider["apiFormat"]
            .as_str()
            .or_else(|| config["apiFormat"].as_str())
            .is_some_and(|format| format != "anthropic")
        {
            return Err("provider_protocol_unavailable".into());
        }
        let mut env = config["env"].clone();
        if !env.is_object() {
            return Err("provider_invalid_settings".into());
        }
        let base = env["ANTHROPIC_BASE_URL"]
            .as_str()
            .filter(|v| !v.trim().is_empty())
            .ok_or("provider_requires_account_route")?
            .to_owned();
        let parsed = Url::parse(&base).map_err(|_| "provider_invalid_address")?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("provider_invalid_address".into());
        }
        if keys(&env).next().is_none() {
            return Err("provider_credential_unavailable".into());
        }
        let models: Vec<_> = MODEL_KEYS
            .iter()
            .filter_map(|key| env[*key].as_str())
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        let default_model = models.first().cloned();
        if env["ANTHROPIC_MODEL"].as_str().is_none_or(str::is_empty) {
            if let Some(default_model) = default_model.as_ref() {
                env["ANTHROPIC_MODEL"] = json!(default_model);
            }
        }
        let model = model
            .filter(|value| {
                models.contains(value)
                    || matches!(
                        value.to_ascii_lowercase().as_str(),
                        "sonnet" | "opus" | "haiku" | "fable" | "default"
                    )
            })
            .or(default_model);
        let name = provider["name"].as_str().unwrap_or(&id).to_owned();
        let revision =
            provider_attempt_identity::provider_revision(&JsString::from_rust_str(&format!(
                "claude:anthropic:{id}:{base}:{}",
                model.as_deref().unwrap_or("")
            )));
        provider["settingsConfig"] = config;
        provider["settingsConfig"]["env"] = env.clone();
        Ok(Self {
            id,
            name,
            model,
            effort: None,
            claude_workflow: None,
            revision,
            provider,
            env,
            codex_credential: None,
            protocol: "claude",
        })
    }

    pub async fn load_codex(root: &Path, home: &Path, record: &V) -> Result<Option<Self>, String> {
        let Some(id) = super::optional_text(record, "provider").filter(|id| id != "_default_")
        else {
            return Ok(None);
        };
        let root = root.to_owned();
        let home = home.to_owned();
        let model = super::optional_text(record, "model");
        tokio::task::spawn_blocking(move || {
            let list = catalog(&root)?;
            let provider = list
                .into_iter()
                .find(|provider| provider["id"] == id && provider["appType"] == "codex")
                .ok_or("provider_not_found")?;
            Self::configured_codex(provider, id, model, &home).map(Some)
        })
        .await
        .map_err(|error| error.to_string())?
    }

    fn configured_codex(
        mut provider: Value,
        id: String,
        model: Option<String>,
        home: &Path,
    ) -> Result<Self, String> {
        if let Some(raw) = provider["settingsConfig"].as_str() {
            provider["settingsConfig"] =
                serde_json::from_str(raw).map_err(|_| "provider_invalid_settings")?;
        }
        let config = &provider["settingsConfig"];
        let model = model.or_else(|| {
            multicc_core::codex_provider_home::configured_model(config["config"].as_str()?)
        });
        let route = plan::Route {
            protocol: "codex".into(),
            provider_id: id.clone(),
            main_provider_id: id.clone(),
            session_id: String::new(),
            role: "main".into(),
            agent_role: String::new(),
            route_name: "main".into(),
            model: model.clone().unwrap_or_default(),
            api_path: "/responses".into(),
            query: String::new(),
            is_stream: true,
        };
        let mut input = json!({"provider":provider,"route":route,"method":"POST",
            "body":json!({"model":model,"stream":true}).to_string()});
        let mut planned = plan::prepare(input.clone())?;
        let codex_credential = if let Some(request) = planned.get("credentialRequest") {
            let account = request["accountId"].as_str().unwrap_or("");
            let file = multicc_core::account_subscription::codex_auth_file(home, account);
            let current = provider_store::read(&file)?.unwrap_or(Value::Null);
            let credential = multicc_core::provider_credentials::codex_credential(
                &current,
                auth_runtime::now_ms(),
            );
            if credential["ok"] != true {
                return Err(credential["reason"]
                    .as_str()
                    .unwrap_or("provider_credential_unavailable")
                    .into());
            }
            input["codexCredential"] = credential.clone();
            planned = plan::prepare(input)?;
            Some(credential)
        } else {
            None
        };
        let base = planned["plan"]["url"]
            .as_str()
            .ok_or("provider_invalid_address")?;
        let revision =
            provider_attempt_identity::provider_revision(&JsString::from_rust_str(&format!(
                "codex:openai_responses:{id}:{base}:{}",
                model.as_deref().unwrap_or("")
            )));
        let name = provider["name"].as_str().unwrap_or(&id).to_owned();
        Ok(Self {
            id,
            name,
            model,
            effort: None,
            claude_workflow: None,
            revision,
            provider,
            env: Value::Null,
            codex_credential,
            protocol: "codex",
        })
    }

    pub async fn open(self, launch: &mut LaunchInput, session: &str) -> io::Result<Proxy> {
        // Authentication and upstream selection are fixed by the persisted
        // provider for the turn. The child never receives its credentials.
        launch.env.retain(|key, _| !key.starts_with("ANTHROPIC_"));
        for key in MODEL_KEYS {
            if let Some(value) = self.env[key].as_str() {
                launch.env.insert(key.into(), json!(value));
            }
        }
        for key in [
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
            "ANTHROPIC_BEDROCK_BASE_URL",
            "ANTHROPIC_VERTEX_BASE_URL",
            "ANTHROPIC_FOUNDRY_BASE_URL",
        ] {
            launch.env.insert(key.into(), json!(""));
        }
        for key in ["NO_PROXY", "no_proxy"] {
            let previous = launch.env.get(key).and_then(Value::as_str).unwrap_or("");
            launch
                .env
                .insert(key.into(), json!(format!("127.0.0.1,{previous}")));
        }
        launch.model = self.model.clone();
        if let Some(flag) = self.claude_workflow {
            launch.claude_workflow = flag;
        }
        if let Some(level) = &self.effort {
            launch.effort = Some(level.clone());
        }
        let (proxy, endpoint, token) = self.start_proxy(session).await?;
        launch.env.insert(
            "ANTHROPIC_BASE_URL".into(),
            json!(format!("{endpoint}/{token}")),
        );
        launch
            .env
            .insert("ANTHROPIC_AUTH_TOKEN".into(), json!(token));
        Ok(proxy)
    }

    pub async fn start_proxy(self, session: &str) -> io::Result<(Proxy, String, String)> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let token = random_id::prefixed_id("proxy-route").map_err(io::Error::other)?;
        let (stop, stopped) = watch::channel(false);
        let mut shutdown = stopped.clone();
        let app = Router::new()
            .fallback(forward)
            .with_state(Arc::new(ProxyState {
                provider: self,
                token: token.clone(),
                stopped,
                session: session.into(),
            }));
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown.changed().await;
                })
                .await;
        });
        Ok((Proxy { stop, server }, endpoint, token))
    }

    fn secrets(&self) -> impl Iterator<Item = JsString> + '_ {
        let config = &self.provider["settingsConfig"];
        let credential = self.codex_credential.as_ref().unwrap_or(&Value::Null);
        keys(&self.env).chain(
            [
                &config["proxyTarget"]["apiKey"],
                &config["auth"]["OPENAI_API_KEY"],
                &config["auth"]["tokens"]["access_token"],
                &credential["accessToken"],
                &credential["accountId"],
            ]
            .into_iter()
            .filter_map(Value::as_str)
            .filter(|secret| !secret.is_empty())
            .map(JsString::from_rust_str),
        )
    }
}

pub(super) fn remembered_route(record: &V, route: &super::route::Route) -> Option<V> {
    selection(record).ok().flatten()?;
    let selection_key = multicc_core::auto_provider_selection_key::key_of(&js::to_serde(
        record.get("providerSelection")?,
    ));
    Some(V::object(vec![
        ("cli", super::property(&route.scope, "cli")),
        ("providerId", super::property(&route.scope, "providerId")),
        ("providerName", route.provider_name.clone()),
        ("model", route.model.clone()),
        ("selectionKey", V::from(selection_key)),
    ]))
}

pub(super) fn last_route(record: &V) -> Option<Value> {
    let last = record.get("autoProviderLastRoute")?;
    if !matches!(last, V::Object(_)) {
        return None;
    }
    Some(json!({
        "cli":super::optional_text(last, "cli"),
        "providerId":super::optional_text(last, "providerId"),
        "providerName":super::optional_text(last, "providerName"),
        "model":super::optional_text(last, "model")
    }))
}

fn catalog(root: &Path) -> Result<Vec<Value>, String> {
    let value = provider_store::read(&root.join("providers.json"))?.ok_or("provider_not_found")?;
    value
        .as_array()
        .or_else(|| value["providers"].as_array())
        .cloned()
        .ok_or_else(|| "PROVIDER_STORE_INVALID_SCHEMA".into())
}

fn lookup<'a>(list: &'a [Value], id: &str) -> Result<&'a Value, String> {
    list.iter()
        .find(|provider| provider["id"] == id && provider["appType"] == "claude")
        .ok_or_else(|| "provider_not_found".into())
}

pub(super) fn selection(record: &V) -> Result<Option<Value>, String> {
    let Some(raw) = record
        .get("providerSelection")
        .filter(|raw| js::truthy(raw))
    else {
        return Ok(None);
    };
    let raw = js::to_serde(raw);
    let list = raw["candidates"]
        .as_array()
        .filter(|rows| (1..=12).contains(&rows.len()))
        .ok_or("INVALID_AUTO_PROVIDER_CONFIG")?;
    if raw["mode"] != "auto"
        || !matches!(raw["protocol"].as_str(), None | Some("anthropic"))
        || js::serde::truthy(&raw["routing"])
        || js::serde::truthy(&raw["cliSwitch"])
        || list.iter().any(|row| {
            row["providerId"].as_str().is_none_or(str::is_empty)
                || js::serde::truthy(&row["autoModel"])
                || row["cli"].as_str().is_some_and(|cli| cli != "claude")
        })
    {
        return Err("unsupported_auto_provider_selection".into());
    }
    let candidates: Vec<_> = list
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let mut candidate = json!({
                "providerId": row["providerId"], "cli": "claude",
                "model": row["model"].as_str(), "effort": row["effort"].as_str(),
                "priority": row["priority"].as_f64().unwrap_or(index as f64),
                "enabled": row["enabled"] != false,
            });
            if let Some(flag) = row["claudeWorkflow"].as_bool() {
                candidate["claudeWorkflow"] = json!(flag);
            }
            candidate
        })
        .collect();
    Ok(Some(json!({
        "version":1,"mode":"auto","protocol":"anthropic",
        "maxAttempts":raw["maxAttempts"],"sticky":raw["sticky"] != false,
        "preferMaxQuota":raw["preferMaxQuota"] == true,"candidates":candidates
    })))
}

fn choose(root: &Path, record: &Value, selection: &Value) -> Result<Provider, String> {
    let list = catalog(root)?;
    let limits_file = root.join("provider-limit-cache.db");
    let entries = if limits_file
        .try_exists()
        .map_err(|_| "provider_limit_unavailable")?
    {
        provider_limit_store::Store::open_existing(&limits_file)?.snapshot()?
    } else {
        V::Null
    };
    let mut providers = Vec::new();
    let mut candidates = Vec::new();
    for (index, row) in selection["candidates"]
        .as_array()
        .expect("normalized selection")
        .iter()
        .enumerate()
    {
        if row["enabled"] == false {
            continue;
        }
        let id = row["providerId"].as_str().expect("normalized provider id");
        let Ok(mut provider) = lookup(&list, id).and_then(|config| {
            Provider::configured(
                config.clone(),
                id.to_owned(),
                row["model"].as_str().map(ToOwned::to_owned),
            )
        }) else {
            continue;
        };
        provider.claude_workflow = row["claudeWorkflow"]
            .as_bool()
            .or((row["effort"] == "ultracode").then_some(true));
        provider.effort = (if row["effort"] == "ultracode" {
            multicc_core::cli_capability::legacy_claude_effort(
                provider.model.as_deref().unwrap_or(""),
            )
        } else {
            row["effort"].as_str()
        })
        .filter(|level| {
            multicc_core::cli_capability::supports_effort(
                "claude",
                provider.model.as_deref().unwrap_or(""),
                level,
            )
        })
        .map(str::to_owned);
        let key = format!("claude:{id}");
        let entry = entries.get("entries").and_then(|entries| entries.get(&key));
        let facts = json!({"entry":entry.map(js::to_serde),"model":provider.model,"now":auth_runtime::now_ms()});
        let limit: Value =
            serde_json::from_str(&auto_provider_policy::limit_state(&facts.to_string())?)
                .map_err(|_| "provider_limit_unavailable")?;
        let mut candidate = row.clone();
        candidate["index"] = json!(index);
        candidate["model"] = json!(provider.model);
        candidate["limitState"] = limit["state"].clone();
        candidate["limitReason"] = limit["reason"].clone();
        candidate["usedPercent"] = limit["usedPercent"].clone();
        providers.push(provider);
        candidates.push(candidate);
    }
    let sticky = record["autoProviderLastRoute"]["providerId"]
        .as_str()
        .filter(|_| {
            selection["sticky"] == true
                && record["autoProviderLastRoute"]["selectionKey"]
                    == multicc_core::auto_provider_selection_key::key_of(
                        &record["providerSelection"],
                    )
        });
    let args = json!({"candidates":candidates,"stickyProviderId":sticky,
        "preferCli":"claude","byQuota":selection["preferMaxQuota"]});
    let chosen: Value =
        serde_json::from_str(&auto_provider_policy::choose_candidate(&args.to_string())?)
            .map_err(|_| "provider_selection_failed")?;
    let index = chosen["candidate"]
        .as_u64()
        .ok_or("AUTO_PROVIDER_POOL_EXHAUSTED")? as usize;
    providers
        .into_iter()
        .nth(index)
        .ok_or_else(|| "provider_selection_failed".into())
}

pub(super) struct Proxy {
    stop: watch::Sender<bool>,
    server: JoinHandle<()>,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        self.server.abort();
    }
}

struct ProxyState {
    provider: Provider,
    token: String,
    stopped: watch::Receiver<bool>,
    session: String,
}

fn keys(env: &Value) -> impl Iterator<Item = JsString> + '_ {
    ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
        .into_iter()
        .filter_map(|key| env[key].as_str())
        .filter(|secret| !secret.is_empty())
        .map(JsString::from_rust_str)
}

async fn forward(State(state): State<Arc<ProxyState>>, req: Request) -> Response {
    let (head, body) = req.into_parts();
    let (capability, path) = if state.provider.protocol == "codex" {
        let capability = head
            .headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or("");
        (capability, head.uri.path().trim_start_matches('/'))
    } else {
        let Some(route) = head
            .uri
            .path()
            .trim_start_matches('/')
            .split_once('/')
            .or_else(|| {
                (head.method == Method::HEAD)
                    .then_some((head.uri.path().trim_start_matches('/'), ""))
            })
        else {
            return StatusCode::NOT_FOUND.into_response();
        };
        route
    };
    if !timing_safe_equal_text(capability, &state.token) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if head.method == Method::HEAD && path.is_empty() {
        return StatusCode::OK.into_response();
    }
    if !matches!(
        (state.provider.protocol, head.method.as_str(), path),
        ("claude", "POST", "v1/messages" | "v1/messages/count_tokens")
            | ("claude", "GET", "v1/models")
            | ("codex", "POST", "responses")
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut stopped = state.stopped.clone();
    if *stopped.borrow() {
        return StatusCode::GONE.into_response();
    }
    let raw = match tokio::select! {
        _ = stopped.changed() => return StatusCode::GONE.into_response(),
        bytes = to_bytes(body, MAX_REQUEST) => bytes
    } {
        Ok(bytes) => match std::str::from_utf8(&bytes) {
            Ok(text) => text.to_owned(),
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        },
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    let body: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let route = plan::Route {
        protocol: state.provider.protocol.into(),
        provider_id: state.provider.id.clone(),
        main_provider_id: state.provider.id.clone(),
        session_id: state.session.clone(),
        role: "main".into(),
        agent_role: String::new(),
        route_name: "main".into(),
        model: body["model"].as_str().unwrap_or("").into(),
        api_path: format!("/{path}"),
        query: head
            .uri
            .query()
            .map_or_else(String::new, |query| format!("?{query}")),
        is_stream: body["stream"] == true,
    };
    let headers = head
        .headers
        .iter()
        .filter_map(|(name, value)| value.to_str().ok().map(|value| (name.as_str(), value)))
        .collect::<std::collections::BTreeMap<_, _>>();
    let planned = match plan::prepare(json!({"route":route,"provider":state.provider.provider,
        "body":raw,"headers":headers,"method":head.method.as_str(),"codexCredential":state.provider.codex_credential}))
    {
        Ok(plan) => plan,
        Err(error) => return upstream_error(error),
    };
    let exchange = match Exchange::new(planned["plan"].to_string()) {
        Ok(exchange) => exchange,
        Err(error) => return upstream_error(error),
    };
    let opened = match tokio::select! {
        _ = stopped.changed() => return StatusCode::GONE.into_response(),
        result = exchange.open() => result,
    } {
        Ok(value) => value,
        Err(error) => return upstream_error(error),
    };
    let status = opened["status"]
        .as_u64()
        .and_then(|n| u16::try_from(n).ok())
        .and_then(|n| StatusCode::from_u16(n).ok())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    if status.is_redirection() {
        return upstream_error("UPSTREAM_REDIRECT_REFUSED".into());
    }
    if opened["headers"]["content-encoding"]
        .as_str()
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        return upstream_error("UPSTREAM_ENCODING_UNSUPPORTED".into());
    }
    let secrets = normalize_secrets(state.provider.secrets());
    let source = ProviderBody {
        exchange,
        stopped,
        decoder: Utf8Decoder::default(),
        redactor: StreamRedactor::new(state.provider.secrets()),
        done: false,
    };
    let mut response = (
        status,
        Body::from_stream(stream::unfold(source, ProviderBody::next)),
    )
        .into_response();
    if let Some(headers) = opened["headers"].as_object() {
        for (name, value) in headers
            .iter()
            .filter(|(name, _)| !matches!(name.as_str(), "content-encoding" | "location"))
        {
            let value = sanitized_header(value, &secrets);
            if let (Ok(name), Some(value)) = (HeaderName::from_bytes(name.as_bytes()), value) {
                response.headers_mut().insert(name, value);
            }
        }
    }
    response
}

struct ProviderBody {
    exchange: Exchange,
    stopped: watch::Receiver<bool>,
    decoder: Utf8Decoder,
    redactor: StreamRedactor,
    done: bool,
}

impl ProviderBody {
    async fn next(mut self) -> Option<(io::Result<Bytes>, Self)> {
        if self.done || *self.stopped.borrow() {
            return None;
        }
        loop {
            let chunk = match tokio::select! {
                _ = self.stopped.changed() => return None,
                result = tokio::time::timeout(Duration::from_secs(90), self.exchange.read()) => result
                    .unwrap_or_else(|_| Err("UPSTREAM_IDLE_TIMEOUT".into())),
            } {
                Ok(chunk) => chunk,
                Err(error) => {
                    self.done = true;
                    return Some((Err(io::Error::other(error)), self));
                }
            };
            let mut text = self.decoder.feed(&chunk.data);
            self.done = chunk.meta["done"] == true;
            if self.done {
                text.push_str(&self.decoder.finish());
            }
            let mut output = self.redactor.push(&JsString::from_rust_str(&text));
            if self.done {
                output.push(&self.redactor.flush());
            }
            if !output.is_empty() {
                return Some((Ok(Bytes::from(output.to_string_lossy())), self));
            }
            if self.done {
                return None;
            }
        }
    }
}

impl Drop for ProviderBody {
    fn drop(&mut self) {
        self.exchange.abort();
    }
}

fn sanitized_header(value: &Value, secrets: &Secrets) -> Option<HeaderValue> {
    let parts = redact_fragments(vec![JsString::from_rust_str(value.as_str()?)], secrets);
    HeaderValue::from_str(&parts.first()?.to_string_lossy()).ok()
}

fn upstream_error(message: String) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        axum::Json(json!({
            "type":"error","error":{"type":"api_error","message":message}
        })),
    )
        .into_response()
}
