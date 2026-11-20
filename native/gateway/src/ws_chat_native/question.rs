//! The native chat owner and its turn-scoped wait_for_user_answer MCP port.
use super::{shell, store, Host, Session};
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{header, Method, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use multicc_core::{
    auth_security::timing_safe_equal_text,
    claude_lane::LaunchInput,
    js::{self, JsValue as V},
    orchestration_store, random_id, session_question,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::Mutex, task::JoinHandle};

pub(super) struct Snapshot {
    pub version: u64,
    pub pending: V,
    pub category: V,
}

fn initial(record: &V) -> V {
    let record_type = record.get("type").cloned().unwrap_or(V::Null);
    let state = record.get("taskState");
    let mut category = match state {
        Some(V::Object(fields)) => V::Object(
            fields
                .iter()
                .filter(|(name, _)| name != "pendingUserInput")
                .cloned()
                .collect(),
        ),
        _ => V::Object(Vec::new()),
    };
    multicc_core::quota_guard::set(&mut category, "recoveryRecordType", record_type);
    multicc_core::quota_guard::set(
        &mut category,
        "unattended",
        record.get("unattended").cloned().unwrap_or(V::Null),
    );
    category
}

pub(super) fn read(root: &Path, id: &str, record: &V) -> Result<Snapshot, String> {
    let file = root.join("orchestration.sqlite");
    if !file.try_exists().map_err(|error| error.to_string())?
        && root
            .join("orchestration.json")
            .try_exists()
            .map_err(|error| error.to_string())?
    {
        // Restore legacy question rows before resolving ownership or version.
        shell::queue_store(root)?;
    }
    let saved = orchestration_store::chat_question_snapshot(&file, id)?;
    let Some(saved) = saved else {
        return Ok(Snapshot {
            version: 0,
            pending: record
                .get("taskState")
                .and_then(|state| state.get("pendingUserInput"))
                .cloned()
                .unwrap_or(V::Null),
            category: initial(record),
        });
    };
    let parse = |key: &str| {
        let raw = saved[key]
            .as_str()
            .ok_or("invalid session question state")?;
        js::json_parse(raw).map_err(|error| error.to_string())
    };
    Ok(Snapshot {
        version: saved["version"]
            .as_u64()
            .ok_or("invalid session question version")?,
        pending: parse("pendingQuestionJson")?,
        category: parse("categoryJson")?,
    })
}

pub(super) struct Transition {
    pub result: Value,
    pub notification: V,
}

pub(super) fn transition(
    root: &Path,
    id: &str,
    record: &V,
    mut command: V,
) -> Result<Transition, String> {
    use multicc_core::quota_guard::set;
    set(&mut command, "sessionId", V::from(id));
    set(
        &mut command,
        "at",
        V::Number(multicc_core::auth_runtime::now_ms()),
    );
    set(
        &mut command,
        "initialState",
        V::object(vec![
            ("activeTurn", V::Null),
            (
                "pendingQuestion",
                record
                    .get("taskState")
                    .and_then(|state| state.get("pendingUserInput"))
                    .cloned()
                    .unwrap_or(V::Null),
            ),
            ("category", initial(record)),
        ]),
    );
    let request = js::json_stringify(&command).ok_or("invalid session question command")?;
    let response = shell::queue_store(root)?.request(
        "sessionWorkQuestionExperimental",
        &json!({"requestJson":request}),
    )?;
    let notification = js::json_parse(response["notificationJson"].as_str().unwrap_or("null"))
        .map_err(|error| error.to_string())?;
    Ok(Transition {
        result: response["result"].clone(),
        notification,
    })
}

struct Tool {
    host: Arc<Host>,
    session: Arc<Mutex<Session>>,
    root: std::path::PathBuf,
    id: String,
    turn: String,
    token: String,
    closed: AtomicBool,
}

pub(super) struct Mcp {
    server: JoinHandle<()>,
    tool: Arc<Tool>,
}

impl Drop for Mcp {
    fn drop(&mut self) {
        self.tool.closed.store(true, Ordering::Release);
        self.server.abort();
    }
}

pub(super) async fn open(
    launch: &mut LaunchInput,
    app: &crate::app::App,
    session: &Arc<Mutex<Session>>,
    id: &str,
    turn: &str,
) -> Result<Mcp, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let token = random_id::random_uuid_v4().map_err(|error| error.to_string())?;
    let servers = launch.mcp_servers.get_or_insert_with(|| json!({}));
    servers["multicc_questions"] = json!({
        "type":"http","url":format!("http://{address}/mcp"),
        "headers":{"Authorization":format!("Bearer {token}")}
    });
    let guidance = "When a missing user decision blocks this turn, call the multicc_questions wait_for_user_answer tool, present the same question, and end the turn.";
    let prompt = launch.system_prompt_append.get_or_insert_with(String::new);
    if !prompt.is_empty() {
        prompt.push_str("\n\n");
    }
    prompt.push_str(guidance);
    launch.disallowed_tools.push("AskUserQuestion".into());
    for key in ["NO_PROXY", "no_proxy"] {
        let previous = launch.env.get(key).and_then(Value::as_str).unwrap_or("");
        launch
            .env
            .insert(key.into(), json!(format!("127.0.0.1,{previous}")));
    }
    let tool = Arc::new(Tool {
        host: Arc::clone(&app.native_chat),
        session: Arc::clone(session),
        root: app.data_root.clone(),
        id: id.into(),
        turn: turn.into(),
        token,
        closed: AtomicBool::new(false),
    });
    let routes = Router::new().fallback(mcp).with_state(Arc::clone(&tool));
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, routes).await;
    });
    Ok(Mcp { server, tool })
}

async fn mcp(State(tool): State<Arc<Tool>>, req: Request) -> Response {
    if req.uri().path() != "/mcp"
        || req.headers().contains_key(header::ORIGIN)
        || !req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|token| timing_safe_equal_text(token, &tool.token))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if req.method() != Method::POST {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Ok(Ok(raw)) = tokio::time::timeout(
        Duration::from_secs(5),
        to_bytes(req.into_body(), 128 * 1024),
    )
    .await
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Ok(request) = std::str::from_utf8(&raw) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Ok(request) = js::json_parse(request) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if request.get("jsonrpc") != Some(&V::from("2.0")) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let method = store::optional_text(&request, "method").unwrap_or_default();
    if method.starts_with("notifications/") && request.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let Some(id @ (V::Number(_) | V::String(_))) = request.get("id") else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let params = request.get("params").unwrap_or(&V::Undefined);
    let result = match method.as_str() {
        "initialize" => {
            let version = store::optional_text(params, "protocolVersion")
                .filter(|version| {
                    matches!(version.as_str(), "2025-03-26" | "2025-06-18" | "2025-11-25")
                })
                .unwrap_or_else(|| "2025-03-26".into());
            json!({"protocolVersion":version,"capabilities":{"tools":{}},
                "serverInfo":{"name":"multicc_questions","version":"1"}})
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools":[{"name":"wait_for_user_answer",
            "description":"Record a blocking question and its options for the user. Present it as the final reply and end the turn.",
            "inputSchema":{"type":"object","required":["question"],"properties":{
                "question":{"type":"string"},"reason":{"type":"string"},
                "options":{"type":"array","items":{"type":"string"}},"allow_multiple":{"type":"boolean"}
            }}
        }]}),
        "tools/call" if params.get("name") == Some(&V::from("wait_for_user_answer")) => {
            let record = record(&tool, params.get("arguments").unwrap_or(&V::Undefined)).await;
            let (payload, failed) = match record {
                Ok(value) => (value, false),
                Err(error) => (error, true),
            };
            json!({"content":[{"type":"text","text":payload.to_string()}],"isError":failed})
        }
        _ => {
            return Json(json!({"jsonrpc":"2.0","id":js::to_serde(id),
            "error":{"code":-32601,"message":"Method not found"}}))
            .into_response()
        }
    };
    Json(json!({"jsonrpc":"2.0","id":js::to_serde(id),"result":result})).into_response()
}

async fn record(tool: &Tool, args: &V) -> Result<Value, Value> {
    let signal = session_question::tool_signal(&tool.id, &tool.turn, args)
        .map_err(|error| js::to_serde(&error))?;
    let request_id = store::text(&signal, "requestId");
    let state = tool.session.lock().await;
    if tool.closed.load(Ordering::Acquire)
        || !state
            .active
            .as_ref()
            .is_some_and(|turn| turn.id == tool.turn && turn.cancel.is_some())
    {
        return Err(json!({"code":"turn_not_active"}));
    }
    let (root, id, record) = (
        tool.root.clone(),
        tool.id.clone(),
        state.stored.record.clone(),
    );
    let saved = shell::blocking(move || {
        transition(
            &root,
            &id,
            &record,
            V::object(vec![("action", V::from("record")), ("signal", signal)]),
        )
    })
    .await
    .map_err(|error| json!({"code":"user_input_record_failed","message":error}))?;
    if saved.result["ok"] != true {
        return Err(saved.result);
    }
    if saved.notification != V::Null {
        tool.host.publish(&tool.id, saved.notification, false);
    }
    Ok(
        json!({"ok":true,"status":"waiting_reply_signal_recorded","request_id":request_id,
        "duplicate":saved.result["duplicate"],"instruction":"Present the recorded question to the user as the final response and stop this turn."}),
    )
}
