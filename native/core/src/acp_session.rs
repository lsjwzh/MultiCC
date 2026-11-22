//! ACP session negotiation and turn lifecycle, independent of the host UI.
use crate::{
    acp_bridge,
    acp_transport::{Client, Event, RpcFailure},
    js::{self, JsValue as V},
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, watch};

fn get(v: &V, key: &str) -> V {
    v.get(key).cloned().unwrap_or(V::Undefined)
}
fn text(s: &str) -> V {
    V::string(s)
}
fn obj(fields: Vec<(&str, V)>) -> V {
    V::object(fields)
}
fn or(v: V, fallback: V) -> V {
    if js::truthy(&v) {
        v
    } else {
        fallback
    }
}
fn name(v: &V) -> String {
    js::js_to_string(v).to_string_lossy()
}
fn output(method: &str, params: V) -> V {
    obj(vec![("method", text(method)), ("params", params)])
}
fn failure(message: String, code: V) -> RpcFailure {
    RpcFailure {
        message,
        code,
        rpc_error: V::Undefined,
    }
}
fn merge(base: &V, extra: &V) -> V {
    let mut entries = if let V::Object(fields) = base {
        fields.clone()
    } else {
        vec![]
    };
    if let V::Object(fields) = extra {
        for (key, value) in fields {
            if let Some((_, old)) = entries.iter_mut().find(|(name, _)| name == key) {
                *old = value.clone();
            } else {
                entries.push((key.clone(), value.clone()));
            }
        }
    }
    V::Object(entries)
}
fn safe_integer(v: &V) -> Option<f64> {
    if let V::Number(n) = v {
        if n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
            return Some(*n);
        }
    }
    None
}

struct Live {
    session_id: V,
    active: bool,
    cancelled: bool,
    context: Option<V>,
}
impl Default for Live {
    fn default() -> Self {
        Self {
            session_id: V::Undefined,
            active: false,
            cancelled: false,
            context: None,
        }
    }
}

/// Configuration which Node previously derived from its process environment.
#[derive(Clone)]
pub struct Options {
    pub label: String,
    pub cwd: PathBuf,
    pub router: V,
    pub env: V,
    pub native_usage: bool,
}

pub struct Session {
    client: Client,
    options: Options,
    output: mpsc::UnboundedSender<V>,
    live: Arc<Mutex<Live>>,
    active_change: watch::Sender<bool>,
    exit_change: watch::Receiver<Option<Option<i32>>>,
    agent_capabilities: V,
    agent_info: V,
    auth_methods: Vec<V>,
    config_options: Vec<V>,
}
impl Session {
    pub fn new(
        client: Client,
        mut events: mpsc::UnboundedReceiver<Event>,
        options: Options,
        output: mpsc::UnboundedSender<V>,
    ) -> Self {
        let live = Arc::new(Mutex::new(Live::default()));
        let event_live = Arc::clone(&live);
        let event_output = output.clone();
        let (active_change, _) = watch::channel(false);
        let (exit_tx, exit_change) = watch::channel(None);
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    Event::Barrier(done) => {
                        let _ = done.send(());
                    }
                    Event::Exited(status) => {
                        let _ = exit_tx.send(Some(status));
                        break;
                    }
                    Event::Frame(frame) => {
                        if get(&frame, "method") == text("session/update") {
                            let params = get(&frame, "params");
                            let update = get(&params, "update");
                            let mut state = event_live.lock().unwrap();
                            if state.active
                                && get(&params, "sessionId") == state.session_id
                                && get(&update, "sessionUpdate") == text("usage_update")
                            {
                                let used = safe_integer(&get(&update, "used"));
                                let size = safe_integer(&get(&update, "size"));
                                if let (Some(used), Some(size)) = (used, size) {
                                    if used >= 0.0 && size > 0.0 && used <= size {
                                        state.context = Some(obj(vec![
                                            ("context_tokens", V::Number(used)),
                                            ("context_window", V::Number(size)),
                                            ("usage_source", text("acp")),
                                        ]));
                                    }
                                }
                            }
                        }
                        let _ = event_output.send(frame);
                    }
                }
            }
            let missing_exit = exit_tx.borrow().is_none();
            if missing_exit {
                let _ = exit_tx.send(Some(None));
            }
        });
        Self {
            client,
            options,
            output,
            live,
            active_change,
            exit_change,
            agent_capabilities: obj(vec![]),
            agent_info: V::Null,
            auth_methods: vec![],
            config_options: vec![],
        }
    }
    async fn request(&self, method: &str, params: V) -> Result<V, RpcFailure> {
        self.client
            .request(method, params, Duration::from_secs(60))
            .await
    }
    fn emit(&self, method: &str, params: V) {
        let _ = self.output.send(output(method, params));
    }
    pub async fn initialize(&mut self) -> Result<(), RpcFailure> {
        let result = self
            .request(
                "initialize",
                obj(vec![
                    ("protocolVersion", V::Number(1.0)),
                    (
                        "clientCapabilities",
                        obj(vec![
                            (
                                "fs",
                                obj(vec![
                                    ("readTextFile", V::Bool(false)),
                                    ("writeTextFile", V::Bool(false)),
                                ]),
                            ),
                            ("terminal", V::Bool(false)),
                        ]),
                    ),
                    (
                        "clientInfo",
                        obj(vec![
                            ("name", text("multicc")),
                            ("title", text("MultiCC")),
                            ("version", text("1.0.0")),
                        ]),
                    ),
                ]),
            )
            .await?;
        self.agent_capabilities = or(get(&result, "agentCapabilities"), obj(vec![]));
        self.agent_info = or(get(&result, "agentInfo"), V::Null);
        if let V::Array(methods) = get(&result, "authMethods") {
            self.auth_methods = methods;
        }
        Ok(())
    }
    fn auth_hint(&self, mut error: RpcFailure) -> RpcFailure {
        let lower = error.message.to_ascii_lowercase();
        let is_auth = lower.contains("auth")
            || lower.contains("api key")
            || lower.contains("login")
            || lower.contains("log in")
            || lower.contains("credential")
            || error.code == V::Number(-32000.0)
            || error.code == V::Number(401.0);
        if is_auth && !self.auth_methods.is_empty() {
            let hints: Vec<String> = self
                .auth_methods
                .iter()
                .map(|item| {
                    or(
                        get(item, "description"),
                        or(get(item, "name"), get(item, "id")),
                    )
                })
                .filter(js::truthy)
                .map(|v| name(&v))
                .collect();
            error.message = format!("{} ({})", error.message, hints.join("; "));
            error.code = text("auth_required");
        }
        error
    }
    pub async fn open_session(&mut self, existing: V) -> Result<V, RpcFailure> {
        let common = || {
            vec![
                ("cwd", text(&self.options.cwd.to_string_lossy())),
                (
                    "mcpServers",
                    acp_bridge::router_servers(&self.options.router, &self.options.env),
                ),
            ]
        };
        if js::truthy(&existing) {
            let method = if js::truthy(&get(
                &get(&self.agent_capabilities, "sessionCapabilities"),
                "resume",
            )) {
                Some("session/resume")
            } else if js::truthy(&get(&self.agent_capabilities, "loadSession")) {
                Some("session/load")
            } else {
                None
            };
            let result = if let Some(method) = method {
                let mut fields = vec![("sessionId", existing.clone())];
                fields.extend(common());
                self.request(method, obj(fields)).await
            } else {
                Err(failure(
                    format!("{} cannot resume sessions over ACP", self.options.label),
                    V::Undefined,
                ))
            };
            match result {
                Ok(opened) => {
                    self.live.lock().unwrap().session_id = existing.clone();
                    self.config_options = match get(&opened,"configOptions") { V::Array(v) => v, _ => vec![] };
                    self.emit("multicc/session",obj(vec![("sessionId",existing),("resumed",V::Bool(true)),("agentInfo",self.agent_info.clone())]));
                    return Ok(opened);
                }
                Err(error) if error.code == text("agent_exited") => return Err(error),
                Err(error) => self.emit("multicc/notice",obj(vec![("message",text(&format!("{} could not resume session {} ({}); started a new session — earlier context is not visible to the agent.",self.options.label,name(&existing),error.message)))])),
            }
        }
        let opened = self
            .request("session/new", obj(common()))
            .await
            .map_err(|error| self.auth_hint(error))?;
        let session = get(&opened, "sessionId");
        if !js::truthy(&session) {
            return Err(failure(
                format!("{} did not return a sessionId", self.options.label),
                V::Undefined,
            ));
        }
        self.live.lock().unwrap().session_id = session.clone();
        self.config_options = match get(&opened, "configOptions") {
            V::Array(v) => v,
            _ => vec![],
        };
        self.emit(
            "multicc/session",
            obj(vec![
                ("sessionId", session),
                ("resumed", V::Bool(false)),
                ("agentInfo", self.agent_info.clone()),
            ]),
        );
        Ok(opened)
    }
    fn option(&self, category: &str) -> Option<V> {
        self.config_options
            .iter()
            .find(|v| {
                let id = get(v, "id");
                if category == "thought_level" {
                    let id = name(&id).to_ascii_lowercase();
                    get(v, "category") == text(category)
                        || ["variant", "effort", "thought", "reasoning"]
                            .iter()
                            .any(|s| id.contains(s))
                } else {
                    get(v, "category") == text(category) || id == text(category)
                }
            })
            .cloned()
    }
    async fn set_config(&mut self, option: V, value: V) -> Result<(), RpcFailure> {
        let choices = match get(&option, "options") {
            V::Array(v) => v,
            _ => vec![],
        };
        let flat: Vec<V> = choices
            .into_iter()
            .flat_map(|choice| match get(&choice, "options") {
                V::Array(v) => v,
                _ => vec![choice],
            })
            .collect();
        if !flat.is_empty() && !flat.iter().any(|choice| get(choice, "value") == value) {
            let sample = flat
                .iter()
                .take(8)
                .map(|choice| {
                    let v = get(choice, "value");
                    if v.is_nullish() {
                        String::new()
                    } else {
                        name(&v)
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            return Err(failure(
                format!(
                    "{} has no {} \"{}\" (available: {}{})",
                    self.options.label,
                    name(&get(&option, "id")),
                    name(&value),
                    sample,
                    if flat.len() > 8 { ", …" } else { "" }
                ),
                text("invalid_config"),
            ));
        }
        if get(&option, "currentValue") == value {
            return Ok(());
        }
        let session = self.live.lock().unwrap().session_id.clone();
        let result = self
            .request(
                "session/set_config_option",
                obj(vec![
                    ("sessionId", session),
                    ("configId", get(&option, "id")),
                    ("value", value),
                ]),
            )
            .await?;
        if let V::Array(options) = get(&result, "configOptions") {
            self.config_options = options;
        }
        Ok(())
    }
    pub async fn apply_config(
        &mut self,
        opened: &V,
        model: V,
        mode: V,
        effort: V,
    ) -> Result<(), RpcFailure> {
        if js::truthy(&model) {
            if let Some(option) = self.option("model") {
                self.set_config(option, model).await?;
            } else if js::truthy(&get(&get(opened, "models"), "availableModels")) {
                if get(&get(opened, "models"), "currentModelId") != model {
                    let session = self.live.lock().unwrap().session_id.clone();
                    self.request(
                        "session/set_model",
                        obj(vec![("sessionId", session), ("modelId", model)]),
                    )
                    .await?;
                }
            } else {
                return Err(failure(
                    format!(
                        "{} does not expose model selection over ACP",
                        self.options.label
                    ),
                    text("invalid_config"),
                ));
            }
        }
        if js::truthy(&mode) {
            let result = if let Some(option) = self.option("mode") {
                self.set_config(option, mode).await
            } else if let V::Array(modes) = get(&get(opened, "modes"), "availableModes") {
                if modes.iter().any(|v| get(v, "id") == mode) {
                    let session = self.live.lock().unwrap().session_id.clone();
                    self.request(
                        "session/set_mode",
                        obj(vec![("sessionId", session), ("modeId", mode)]),
                    )
                    .await
                    .map(|_| ())
                } else {
                    Ok(())
                }
            } else {
                Ok(())
            };
            if let Err(error) = result {
                self.emit(
                    "multicc/notice",
                    obj(vec![("message", text(&error.message))]),
                );
            }
        }
        if js::truthy(&effort) {
            if let Some(option) = self.option("thought_level") {
                if let Err(error) = self.set_config(option, effort).await {
                    self.emit(
                        "multicc/notice",
                        obj(vec![("message", text(&error.message))]),
                    );
                }
            } else {
                self.emit(
                    "multicc/notice",
                    obj(vec![(
                        "message",
                        text(&format!(
                            "{} has no reasoning-effort option over ACP; \"{}\" was ignored.",
                            self.options.label,
                            name(&effort)
                        )),
                    )]),
                );
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct CancelHandle {
    client: Client,
    live: Arc<Mutex<Live>>,
    active_change: watch::Receiver<bool>,
}
impl CancelHandle {
    pub fn stop(&self) {
        self.client.stop();
    }
    /// Ask the current agent to cancel and wait up to two seconds for its reply.
    pub async fn cancel(&self) -> bool {
        let session = {
            let mut live = self.live.lock().unwrap();
            if !live.active || !js::truthy(&live.session_id) {
                return false;
            }
            live.cancelled = true;
            live.session_id.clone()
        };
        self.client
            .notify("session/cancel", obj(vec![("sessionId", session)]));
        let mut active = self.active_change.clone();
        if !*active.borrow() {
            return true;
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            while active.changed().await.is_ok() {
                if !*active.borrow() {
                    return;
                }
            }
        })
        .await
        .is_ok()
    }
}

impl Session {
    pub fn cancel_handle(&self) -> CancelHandle {
        CancelHandle {
            client: self.client.clone(),
            live: Arc::clone(&self.live),
            active_change: self.active_change.subscribe(),
        }
    }
    pub fn session_id(&self) -> V {
        self.live.lock().unwrap().session_id.clone()
    }
    pub fn stop(&self) {
        self.client.stop();
    }
    pub fn exit_handle(&self) -> watch::Receiver<Option<Option<i32>>> {
        self.exit_change.clone()
    }
    async fn native_usage(&self, op: &str, session: &V, cursor: Option<&V>) -> V {
        let env = self.options.env.clone();
        let sid = session.clone();
        let cursor = cursor.cloned();
        let op = op.to_owned();
        tokio::task::spawn_blocking(move || {
            let home = if js::truthy(&get(&env, "HOME")) {
                name(&get(&env, "HOME"))
            } else {
                #[allow(deprecated)]
                std::env::home_dir()
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default()
            };
            let data = name(&or(
                get(&env, "XDG_DATA_HOME"),
                text(&format!("{home}/.local/share")),
            ));
            let cache = name(&or(
                get(&env, "XDG_CACHE_HOME"),
                text(&format!("{home}/.cache")),
            ));
            let mut fields = vec![
                ("op", text(&op)),
                ("sessionId", sid),
                ("dbPath", text(&format!("{data}/opencode/opencode.db"))),
                ("cachePath", text(&format!("{cache}/opencode/models.json"))),
                ("threshold", V::Number(0.85)),
            ];
            if let Some(cursor) = cursor {
                fields.push(("cursor", cursor));
            }
            let input = js::json_stringify(&obj(fields)).unwrap_or_default();
            crate::opencode_context::read(&input)
                .ok()
                .and_then(|v| js::json_parse(&v).ok())
                .unwrap_or_else(|| {
                    obj(vec![
                        ("found", V::Bool(false)),
                        ("reason", text("read-failed")),
                    ])
                })
        })
        .await
        .unwrap_or_else(|_| {
            obj(vec![
                ("found", V::Bool(false)),
                ("reason", text("read-failed")),
            ])
        })
    }
    pub async fn prompt(&self, message: V) -> Result<V, RpcFailure> {
        let session = self.session_id();
        let cursor = if self.options.native_usage {
            self.native_usage("cursor", &session, None).await
        } else {
            V::Null
        };
        {
            let mut live = self.live.lock().unwrap();
            live.cancelled = false;
            live.context = None;
            live.active = true;
            self.active_change.send_replace(true);
        }
        let result = self
            .client
            .request(
                "session/prompt",
                obj(vec![
                    ("sessionId", session.clone()),
                    (
                        "prompt",
                        V::Array(vec![obj(vec![("type", text("text")), ("text", message)])]),
                    ),
                ]),
                Duration::ZERO,
            )
            .await;
        self.client.flush_events().await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                self.live.lock().unwrap().active = false;
                self.active_change.send_replace(false);
                return Err(error);
            }
        };
        let cancelled = self.live.lock().unwrap().cancelled;
        let stop = if cancelled && get(&result, "stopReason") != text("end_turn") {
            text("cancelled")
        } else {
            or(get(&result, "stopReason"), text("end_turn"))
        };
        let mut usage = acp_bridge::normalize_usage(&get(&result, "usage"));
        if self.options.native_usage && get(&cursor, "sessionId") == session {
            let measured = self
                .native_usage("turn_usage", &session, Some(&cursor))
                .await;
            if get(&measured, "usage_source") == text("opencode_native") {
                let positive = if let V::Object(fields) = &usage {
                    fields.iter().any(|(_, v)| js::js_to_number(v) > 0.0)
                } else {
                    false
                };
                usage = if positive {
                    merge(&measured, &usage)
                } else {
                    measured
                };
            }
        }
        let context = self.live.lock().unwrap().context.clone();
        if let Some(context) = context {
            usage = merge(&usage, &context);
        }
        self.emit(
            "multicc/turnEnd",
            obj(vec![
                ("sessionId", session),
                ("stopReason", stop.clone()),
                ("usage", usage),
            ]),
        );
        self.live.lock().unwrap().active = false;
        self.active_change.send_replace(false);
        Ok(stop)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::acp_transport::{self, SpawnOptions};
    #[tokio::test]
    async fn session_negotiates_and_preserves_context_before_turn_end() {
        let script = r#"
          IFS= read -r request || exit 1
          printf '%s\n' '{"id":1,"result":{"agentCapabilities":{},"agentInfo":{"name":"fake"}}}'
          IFS= read -r request || exit 2
          printf '%s\n' '{"id":2,"result":{"sessionId":"s","configOptions":[{"id":"model","currentValue":"one","options":[{"value":"one"},{"value":"two"}]}]}}'
          IFS= read -r request || exit 3
          case "$request" in *'"method":"session/set_config_option"'*'"value":"two"'*) ;; *) exit 4;; esac
          printf '%s\n' '{"id":3,"result":{}}'
          IFS= read -r request || exit 5
          printf '%s\n' '{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"usage_update","used":12,"size":100}}}'
          printf '%s\n' '{"id":4,"result":{"stopReason":"end_turn","usage":{"inputTokens":5}}}'
          IFS= read -r request || :
        "#;
        let (client, events) = acp_transport::spawn(SpawnOptions {
            binary: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: std::env::current_dir().unwrap(),
            label: "Fake".into(),
        })
        .unwrap();
        let (out, mut frames) = mpsc::unbounded_channel();
        let options = Options {
            label: "Fake".into(),
            cwd: std::env::current_dir().unwrap(),
            router: V::Null,
            env: obj(vec![]),
            native_usage: false,
        };
        let mut session = Session::new(client, events, options, out);
        session.initialize().await.unwrap();
        let opened = session.open_session(V::Undefined).await.unwrap();
        session
            .apply_config(&opened, text("two"), V::Undefined, V::Undefined)
            .await
            .unwrap();
        assert_eq!(session.prompt(text("hi")).await.unwrap(), text("end_turn"));
        let mut values = vec![];
        while let Ok(v) = frames.try_recv() {
            values.push(v);
        }
        assert_eq!(values.len(), 3);
        assert_eq!(get(&values[0], "method"), text("multicc/session"));
        assert_eq!(get(&values[1], "method"), text("session/update"));
        let usage = get(&get(&values[2], "params"), "usage");
        assert_eq!(get(&usage, "context_tokens"), V::Number(12.0));
        assert_eq!(get(&usage, "input_tokens"), V::Number(5.0));
        session.stop();
    }
}
