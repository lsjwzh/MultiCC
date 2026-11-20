use super::{is_role, optional_text, store, value, wire, Session, HISTORY_PAGE};
use crate::ws_chat_hub::{Attached, ChatHub};
use multicc_core::{
    auth_runtime, chat_connect_replay, chat_history_frame,
    http_gate::encode_uri_component,
    js::{self, JsValue as V},
    quota_guard,
};
use serde_json::json;

pub(super) fn initial_frames(
    hub: &ChatHub,
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
    let turn_id = session.active.as_ref().map(|active| active.id.as_str());
    let route = session
        .active
        .as_ref()
        .map(|active| js::to_serde(&active.route.scope));
    let provider_id = if route.is_some() {
        Some("claude-official".to_owned())
    } else {
        optional_text(record, "provider")
    };
    let mut frames = vec![value(json!({
        "type":"system", "subtype":"init", "cwd":stored.cwd, "session":id, "session_id":id,
        "cli":cli, "is_streaming":streaming, "taskShell":task_shell, "turnId":turn_id,
        "model":optional_text(record,"model"), "effectiveModel":optional_text(record,"model"),
        "effort":optional_text(record,"effort"), "effectiveEffort":optional_text(record,"effort"),
        "agent":optional_text(record,"agent"), "providerRouteProtocolVersion":1,
        "providerRoute":route, "providerId":provider_id, "providerName":route.as_ref().map(|_| "Claude"),
        "providerSelection":null, "autoProvider":null, "providerTokenWindows":null,
        "cliStates":{}, "cliAvailability":{}, "pendingCliHandoff":null,
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
        has_task_state_seed: false,
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
            chat_connect_replay::Step::ClearBuffer => hub.clear_replay(id),
            chat_connect_replay::Step::ReplayBurst { .. } => burst = true,
            chat_connect_replay::Step::TaskStateSeed => {}
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
