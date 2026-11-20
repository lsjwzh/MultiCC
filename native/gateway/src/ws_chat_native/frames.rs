use super::{is_role, optional_text, store, value, wire, Session};
use crate::ws_chat_hub::{Attached, ChatHub};
use multicc_core::{
    auth_runtime, chat_connect_replay, chat_history_frame,
    js::{self, JsValue as V},
    quota_guard,
};
use serde_json::json;

const HISTORY_PAGE: usize = 5;

pub(super) fn initial_frames(
    hub: &ChatHub,
    id: &str,
    session: &Session,
    attached: &Attached,
    archive: bool,
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
        "cli":cli, "is_streaming":streaming, "taskShell":false, "turnId":turn_id,
        "model":optional_text(record,"model"), "effectiveModel":optional_text(record,"model"),
        "effort":optional_text(record,"effort"), "effectiveEffort":optional_text(record,"effort"),
        "agent":optional_text(record,"agent"), "providerRouteProtocolVersion":1,
        "providerRoute":route, "providerId":provider_id, "providerName":route.as_ref().map(|_| "Claude"),
        "providerSelection":null, "autoProvider":null, "providerTokenWindows":null,
        "cliStates":{}, "cliAvailability":{}, "pendingCliHandoff":null,
    }))];
    let mut visible = stored.messages.iter().rev().filter(|row| {
        archive || !matches!(row.get("id"), Some(V::String(id)) if stored.hidden.contains(id))
    });
    let mut page = visible
        .by_ref()
        .take(HISTORY_PAGE)
        .cloned()
        .collect::<Vec<_>>();
    page.reverse();
    if let Some(active) = &session.active {
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
    let fitted = chat_history_frame::fit(&page, visible.next().is_some(), &Default::default());
    let facts = chat_connect_replay::Facts {
        replay_messages: fitted.messages.len(),
        last_message_is_assistant: fitted
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
