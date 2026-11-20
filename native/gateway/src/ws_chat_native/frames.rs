use super::{
    error_frame, is_role, optional_text,
    provider::{self, Provider},
    store, value, wire, Active, Host, Session, HISTORY_PAGE,
};
use crate::{app::App, ws_chat_hub::Attached};
use multicc_core::{
    api_error_policy, auth_runtime, chat_connect_replay, chat_history_frame, chat_task_state_frame,
    cli_capability, cli_switch, event_routes,
    http_gate::encode_uri_component,
    js::{self, JsValue as V},
    provider_error, quota_guard,
};
use serde_json::json;

pub(super) async fn initial_frames(
    app: &App,
    id: &str,
    session: &Session,
    attached: &Attached,
    archive: bool,
    shell_history: Option<Vec<V>>,
    task_shell: bool,
) -> Vec<String> {
    let stored = &session.stored;
    let record = &stored.record;
    let cli = store::cli(record);
    let streaming = session.active.is_some();
    let persisted_task = record.get("taskState");
    let turn_id = session
        .active
        .as_ref()
        .map(|active| active.id.clone())
        .or_else(|| persisted_task.and_then(|task| optional_text(task, "userInputSignalTurnId")))
        .or_else(|| {
            stored
                .messages
                .iter()
                .rev()
                .find_map(|row| optional_text(row, "turnId"))
        });
    let route = session
        .active
        .as_ref()
        .map(|active| js::to_serde(&active.route.scope));
    let active_route = session.active.as_ref().map(|active| &active.route);
    let provider_selection = provider::selection(record).ok().flatten();
    let last_route = provider_selection
        .as_ref()
        .and_then(|_| provider::last_route(record));
    let provider_id = active_route
        .and_then(|route| optional_text(&route.scope, "providerId"))
        .or_else(|| {
            last_route
                .as_ref()
                .and_then(|route| route["providerId"].as_str().map(ToOwned::to_owned))
        })
        .or_else(|| optional_text(record, "provider"));
    let record = record.clone();
    let provider = if store::is_claude(&record) && provider_id.is_some() {
        Provider::load_fixed(&app.data_root, &record)
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    let provider_name = active_route
        .map(|route| js::to_serde(&route.provider_name))
        .or_else(|| {
            last_route
                .as_ref()
                .map(|route| route["providerName"].clone())
        })
        .or_else(|| provider.as_ref().map(|provider| json!(provider.name)));
    let effective_model = active_route
        .and_then(|route| match &route.model {
            V::String(model) => Some(model.to_string_lossy()),
            _ => None,
        })
        .or_else(|| provider.and_then(|provider| provider.model))
        .or_else(|| optional_text(&record, "model"));
    let (effective_effort, cli_availability) = super::launch::init_facts(app, &record).await;
    let clis = event_routes::client_clis();
    let cli_states = cli_switch::state_summary(&json!({
        "cliStates":js::to_serde(&record)["cliStates"],
        "providerlessClis":clis.iter().filter(|cli| cli_capability::is_providerless(cli)).collect::<Vec<_>>()
    })).unwrap_or_else(|_| json!({}));
    let mut frames = vec![value(json!({
        "type":"system", "subtype":"init", "cwd":stored.cwd, "session":id, "session_id":id,
        "cli":cli, "is_streaming":streaming, "taskShell":task_shell, "turnId":turn_id,
        "model":optional_text(&record,"model"), "effectiveModel":effective_model,
        "effort":optional_text(&record,"effort"), "effectiveEffort":effective_effort,
        "agent":optional_text(&record,"agent"), "providerRouteProtocolVersion":1,
        "providerRoute":route, "providerId":provider_id, "providerName":provider_name,
        "providerSelection":provider_selection, "autoProvider":last_route,
        "providerTokenWindows":null,
        "cliStates":cli_states, "cliAvailability":cli_availability, "pendingCliHandoff":null,
    }))];
    let (mut page, has_more, scoped) = match shell_history {
        Some(mut history) => {
            let start = history.len().saturating_sub(HISTORY_PAGE);
            (history.split_off(start), start > 0, true)
        }
        None => {
            let mut visible = stored.messages.iter().rev().filter(|row| {
                archive
                    || !matches!(row.get("id"), Some(V::String(id)) if stored.hidden.contains(id))
            });
            let mut page: Vec<_> = visible.by_ref().take(HISTORY_PAGE).cloned().collect();
            page.reverse();
            (page, visible.next().is_some(), false)
        }
    };
    if let Some(active) = session.active.as_ref().filter(|_| !scoped) {
        if !active.content.is_empty() || !active.delta.is_empty() || !active.tools.is_empty() {
            let mut message = value(
                json!({"role":"assistant", "content":format!("{}{}", active.content,active.delta),
                "ts":auth_runtime::now_ms(), "streaming":true}),
            );
            if !active.tools.is_empty() {
                quota_guard::set(&mut message, "tools", value(json!(active.tools)));
            }
            if page
                .last()
                .is_some_and(|row| is_role(row, "assistant") && js::truthy_opt(row.get("_interim")))
            {
                let tail = page.last_mut().expect("interim message");
                if let V::Object(fields) = message {
                    for (key, value) in fields {
                        quota_guard::set(tail, &key.as_str_lossy(), value);
                    }
                }
            } else {
                page.push(message);
            }
        }
    }
    let fitted = chat_history_frame::fit(&page, has_more, &Default::default());
    let seed = task_state(stored);
    let facts = chat_connect_replay::Facts {
        replay_messages: fitted.messages.len(),
        // A scoped page currently contains durable rows from multiple
        // executions. Its final assistant is not proof that this socket has
        // seen the active session's in-progress tail.
        last_message_is_assistant: !scoped
            && fitted
                .messages
                .last()
                .is_some_and(|row| is_role(row, "assistant")),
        is_streaming: streaming,
        buffered_events: attached.replay.len(),
        has_token_usage: !stored.token_usage.is_nullish(),
        has_task_state_seed: seed.is_some(),
    };
    let mut burst = false;
    for step in chat_connect_replay::plan(&facts) {
        match step {
            chat_connect_replay::Step::ChatHistory => frames.push(V::object(vec![
                ("type", V::from("chat_history")),
                ("messages", V::Array(fitted.messages.clone())),
                ("tokenUsage", stored.token_usage.clone()),
                ("hasMore", V::Bool(fitted.has_more)),
            ])),
            chat_connect_replay::Step::ClearBuffer => app.native_chat.hub.clear_replay(id),
            chat_connect_replay::Step::ReplayBurst { .. } => burst = true,
            chat_connect_replay::Step::TaskStateSeed => frames.extend(seed.iter().cloned()),
        }
    }
    let mut frames: Vec<_> = frames.iter().filter_map(wire).collect();
    if burst {
        frames.extend(
            attached
                .replay
                .iter()
                .filter_map(|frame| std::str::from_utf8(frame).ok().map(ToOwned::to_owned)),
        );
    }
    frames.extend(
        [
            json!({"type":"background_tasks","tasks":[]}),
            json!({"type":"unattended_state","unattended":null}),
        ]
        .into_iter()
        .filter_map(|frame| wire(&value(frame))),
    );
    frames
}

pub(super) fn task_state(stored: &super::Stored) -> Option<V> {
    let task = stored.record.get("taskState");
    let facts = chat_task_state_frame::Facts {
        task_short_code: stored
            .messages
            .iter()
            .rev()
            .filter(|row| task.and_then(|task| task.get("taskId")) == row.get("taskId"))
            .find_map(|row| optional_text(row, "taskShortCode"))
            .unwrap_or_default(),
        ..Default::default()
    };
    chat_task_state_frame::seed(task, &facts)
}

pub(super) fn notify(phase: &str, goal: &str) -> V {
    let (state, label) = match phase {
        "succeeded" => ("succeeded", "执行成功"),
        "released" => ("cancelled", "已取消"),
        "waiting" => ("waiting", "等待交互"),
        _ => ("running", "处理中"),
    };
    let message = if goal.is_empty() {
        label.to_owned()
    } else {
        format!("{label}：{goal}")
    };
    value(json!({"type":"notify","state":state,"message":message}))
}

pub(super) fn provider_failure(
    host: &Host,
    id: &str,
    turn: &Active,
    detail: &str,
    code: Option<&str>,
    fence: &str,
) -> V {
    let fallback = error_frame("chat_provider_error", detail);
    if turn.task.is_none() {
        host.publish(id, turn.attempt_frame(fallback), false);
        return V::Null;
    }
    let safe = super::property(&fallback, "error");
    eprintln!(
        "[multicc-gateway] native provider failed ({id}): {}",
        js::js_to_string(&safe).to_string_lossy()
    );
    let now = auth_runtime::now_ms();
    let raw = value(json!({"message":js::to_serde(&safe),"code":code}));
    let cli = super::property(&turn.route.scope, "cli");
    let args =
        json!({"source":"claude_result","provider":js::to_serde(&cli),"error":js::to_serde(&raw)});
    let failure = provider_error::classify(&args.to_string())
        .ok()
        .and_then(|raw| js::json_parse(&raw).ok())
        .unwrap_or(V::Null);
    let elapsed = turn.start.elapsed().as_millis() as f64;
    let context = value(json!({
        "source":"claude_result","provider":js::to_serde(&cli),"attempt":1,"maxAttempts":1,
        "phase":if fence == "none" { "before_first_token" } else { "after_first_token" },
        "partialOutput":fence == "visible_output","sideEffects":fence == "tool_intent",
        "turnElapsedMs":elapsed
    }));
    let decision = api_error_policy::decide(
        &raw,
        &context,
        &api_error_policy::NormalizeDeps {
            source: "claude_result".into(),
            provider: js::js_to_string(&cli),
            upstream: V::Null,
            failure,
            rejection: V::Null,
            now,
            known: false,
        },
        &|_| f64::NAN,
        &mut || 0.0,
    );
    let message = V::String(api_error_policy::retry_notice(&decision));
    let details = decision.get("error").unwrap_or(&V::Null);
    let mut durable = V::object(vec![
        ("category", super::property(details, "category")),
        ("provider", cli),
        (
            "providerId",
            super::property(&turn.route.scope, "providerId"),
        ),
        ("providerName", turn.route.provider_name.clone()),
    ]);
    for name in [
        "code",
        "httpStatus",
        "retryable",
        "safeToRetry",
        "retryAfterMs",
        "phase",
        "partialOutput",
    ] {
        quota_guard::set(&mut durable, name, super::property(details, name));
    }
    for (name, source) in [
        ("attempt", &decision),
        ("maxAttempts", details),
        ("action", &decision),
        ("reason", &decision),
        ("retryAt", &decision),
        ("userAction", details),
        ("rootCause", details),
        ("param", details),
        ("budgetExhaustedBy", &decision),
    ] {
        quota_guard::set(
            &mut durable,
            name,
            source.get(name).cloned().unwrap_or(V::Null),
        );
    }
    quota_guard::set(&mut durable, "turnElapsedMs", V::Number(elapsed));
    quota_guard::set(&mut durable, "at", V::Number(now));
    let mut policy = V::object(vec![
        ("type", V::from("api_error_policy")),
        ("state", V::from("failed")),
        ("message", message.clone()),
    ]);
    if let V::Object(fields) = &durable {
        for (key, field) in fields {
            quota_guard::set(&mut policy, &key.as_str_lossy(), field.clone());
        }
    }
    host.publish(id, turn.attribute(policy), false);
    host.publish(
        id,
        turn.attribute(V::object(vec![
            ("type", V::from("system")),
            ("subtype", V::from("warning")),
            ("message", message),
        ])),
        false,
    );
    durable
}

pub(super) fn require_shell_route(session_id: &str) -> V {
    V::object(vec![
        ("type", V::from("error")),
        ("code", V::from("task_shell_route_required")),
        ("error", V::from("请从任务会话入口发送消息或操作任务。")),
        (
            "url",
            V::from(format!(
                "/chat.html?session={}",
                encode_uri_component(session_id)
            )),
        ),
    ])
}
