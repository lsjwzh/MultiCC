//! ACP process front door. Protocol policy and session state live in core;
//! this module owns process signals, stdio and the resident request queue.
use multicc_core::{
    acp_bridge,
    acp_session::{Options, Session},
    acp_transport::{self, RpcFailure, SpawnOptions},
    js::{self, JsValue as V},
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, Mutex},
};

fn get(value: &V, key: &str) -> V {
    value.get(key).cloned().unwrap_or(V::Undefined)
}
fn text(value: &str) -> V {
    V::string(value)
}
fn name(value: &V) -> String {
    js::js_to_string(value).to_string_lossy()
}
fn obj(fields: Vec<(&str, V)>) -> V {
    V::object(fields)
}
fn or(value: V, fallback: V) -> V {
    if js::truthy(&value) {
        value
    } else {
        fallback
    }
}
fn event(method: &str, params: V) -> V {
    obj(vec![("method", text(method)), ("params", params)])
}
fn string(v: &V) -> Option<String> {
    if let V::String(s) = v {
        Some(s.to_string_lossy())
    } else {
        None
    }
}

/// Match the Node bridge's bounded, allowlisted provider-error projection.
fn error_fields(raw: &V, depth: usize, nodes: &mut usize, chars: &mut usize) -> V {
    let mut fields = Vec::new();
    if !matches!(raw, V::Object(_)) || depth > 6 || *nodes == 0 {
        return V::Object(fields);
    }
    *nodes -= 1;
    for key in [
        "message",
        "code",
        "name",
        "type",
        "errorName",
        "category",
        "httpStatus",
        "statusCode",
        "status",
    ] {
        let value = get(raw, key);
        let kept = match value {
            V::String(value) => {
                let limit = if key == "message" { *chars } else { 128 };
                let clipped = value.truncate_units(limit);
                if key == "message" {
                    *chars = chars.saturating_sub(clipped.len());
                }
                Some(V::String(clipped))
            }
            V::Number(value) if value.is_finite() => Some(V::Number(value)),
            _ => None,
        };
        if let Some(value) = kept {
            fields.push((key.into(), value));
        }
    }
    for key in ["rpcError", "error", "data"] {
        let value = get(raw, key);
        if matches!(value, V::Object(_) | V::Array(_)) {
            fields.push((key.into(), error_fields(&value, depth + 1, nodes, chars)));
        }
    }
    let response = get(&get(raw, "response"), "error");
    if js::truthy(&response) {
        fields.push((
            "response".into(),
            obj(vec![(
                "error",
                error_fields(&response, depth + 1, nodes, chars),
            )]),
        ));
    }
    V::Object(fields)
}
fn report(output: &mpsc::UnboundedSender<V>, label: &str, error: RpcFailure, phase: &str) {
    let mut params = vec![
        ("message", text(&format!("{label}: {}", error.message))),
        ("code", or(error.code, V::Null)),
    ];
    if js::truthy(&error.rpc_error) {
        params.push((
            "rpcError",
            error_fields(&error.rpc_error, 0, &mut 24, &mut 65536),
        ));
    }
    params.push(("phase", text(phase)));
    let _ = output.send(event("multicc/error", obj(params)));
}

#[cfg(unix)]
async fn signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let Ok(mut term) = signal(SignalKind::terminate()) else {
        return;
    };
    let Ok(mut interrupt) = signal(SignalKind::interrupt()) else {
        return;
    };
    tokio::select! { _ = term.recv()=>{}, _ = interrupt.recv()=>{} }
}
#[cfg(not(unix))]
async fn signal() {
    let _ = tokio::signal::ctrl_c().await;
}

pub async fn serve(args: &[String]) -> i32 {
    let options = match acp_bridge::parse_args(args) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    let label = name(&get(&options, "label"));
    let binary = name(&get(&options, "agentBin"));
    let arguments = if let V::Array(values) = get(&options, "agentArgs") {
        values.iter().map(name).collect()
    } else {
        vec![]
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let environment = V::Object(
        std::env::vars_os()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().as_ref().into(),
                    text(&v.to_string_lossy()),
                )
            })
            .collect(),
    );
    let (events, mut output) = mpsc::unbounded_channel::<V>();
    let output_task = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(event) = output.recv().await {
            if let Some(frame) = js::json_stringify(&event) {
                if stdout
                    .write_all(format!("{frame}\n").as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
        // Tokio 的 stdout 可在后台写入完成前返回。入口会立即退出进程，
        // 在此等最后一帧写完，提前退出的 agent 才能把错误送回调用方。
        let _ = stdout.flush().await;
    });
    let (client, incoming) = match acp_transport::spawn(SpawnOptions {
        binary: binary.clone(),
        args: arguments,
        cwd: cwd.clone(),
        label: label.clone(),
    }) {
        Ok(child) => child,
        Err(error) => {
            let code = match error.kind() {
                std::io::ErrorKind::NotFound => "ENOENT",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                std::io::ErrorKind::InvalidInput => "EINVAL",
                _ => "UNKNOWN",
            };
            let _ = events.send(event(
                "multicc/error",
                obj(vec![
                    (
                        "message",
                        text(&format!("{label} failed to start: spawn {binary} {code}")),
                    ),
                    ("code", text("spawn_failed")),
                    ("phase", text("spawn")),
                ]),
            ));
            report(
                &events,
                &label,
                RpcFailure {
                    message: format!("{label} exited before answering initialize"),
                    code: text("agent_exited"),
                    rpc_error: V::Undefined,
                },
                if js::truthy(&get(&options, "resident")) {
                    "session"
                } else {
                    "initialize"
                },
            );
            drop(events);
            let _ = output_task.await;
            return 1;
        }
    };
    let mut session = Session::new(
        client,
        incoming,
        Options {
            label: label.clone(),
            cwd,
            router: get(&options, "routerMcp"),
            env: environment,
            native_usage: get(&options, "nativeUsage") == text("opencode"),
        },
        events.clone(),
    );
    let mut exited = session.exit_handle();
    let cancel = session.cancel_handle();
    let stop_on_signal = cancel.clone();
    let signal_task = tokio::spawn(async move {
        signal().await;
        // A second signal must not wait for the normal cancellation grace.
        tokio::select! {
            _ = stop_on_signal.cancel() => {},
            _ = signal() => {},
        }
        stop_on_signal.stop();
    });
    let mut phase = "initialize";
    let initialized = async {
        session.initialize().await?;
        phase = "session";
        let opened = session.open_session(get(&options, "sessionId")).await?;
        phase = "config";
        session
            .apply_config(
                &opened,
                get(&options, "model"),
                get(&options, "mode"),
                get(&options, "effort"),
            )
            .await?;
        Ok::<(), RpcFailure>(())
    }
    .await;
    let mut code = 0;
    if let Err(error) = initialized {
        report(
            &events,
            &label,
            error,
            if js::truthy(&get(&options, "resident")) {
                "session"
            } else {
                phase
            },
        );
        code = 1;
        session.stop();
        drop(session);
    } else if !js::truthy(&get(&options, "resident")) {
        match session.prompt(get(&options, "prompt")).await {
            Ok(reason) if reason == text("cancelled") || reason == text("refusal") => code = 1,
            Ok(_) => {}
            Err(error) => {
                report(&events, &label, error, "prompt");
                code = 1;
            }
        }
        session.stop();
        drop(session);
    } else {
        let mut exit = session.exit_handle();
        let session = Arc::new(Mutex::new(session));
        let (queue, mut turns) = mpsc::unbounded_channel::<V>();
        let worker = Arc::clone(&session);
        let worker_output = events.clone();
        let worker_label = label.clone();
        let failed = Arc::new(AtomicBool::new(false));
        let worker_failed = Arc::clone(&failed);
        let mut current_model = get(&options, "model");
        let mut pump = tokio::spawn(async move {
            while let Some(turn) = turns.recv().await {
                let mut session = worker.lock().await;
                let model = get(&turn, "model");
                if js::truthy(&model) && model != current_model {
                    if let Err(error) = session
                        .apply_config(&obj(vec![]), model.clone(), V::Undefined, V::Undefined)
                        .await
                    {
                        worker_failed.store(true, Ordering::Relaxed);
                        report(&worker_output, &worker_label, error, "prompt");
                        continue;
                    }
                    current_model = model;
                }
                if let Err(error) = session.prompt(get(&turn, "text")).await {
                    let exited = error.code == text("agent_exited");
                    worker_failed.store(true, Ordering::Relaxed);
                    report(&worker_output, &worker_label, error, "prompt");
                    if exited {
                        break;
                    }
                }
            }
        });
        let mut stdin = BufReader::new(tokio::io::stdin()).lines();
        loop {
            tokio::select! {
                line = stdin.next_line() => match line {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() { continue; }
                        let Ok(turn) = js::json_parse(&line) else { eprintln!("[{label}] resident bridge dropped a non-JSON stdin line"); continue; };
                        if get(&turn,"type") == text("cancel") {
                            let cancellation = cancel.clone();
                            tokio::spawn(async move { if !cancellation.cancel().await { cancellation.stop(); } });
                            continue;
                        }
                        let body = if matches!(turn,V::String(_)) {turn.clone()} else {get(&turn,"text")};
                        if string(&body).is_some_and(|v|!v.is_empty()) { let _ = queue.send(obj(vec![("text",body),("model",or(get(&turn,"model"),V::Null))])); }
                    }
                    _ => break,
                },
                result = exit.changed() => { if result.is_err() || exit.borrow().is_some() { break; } }
            }
        }
        cancel.stop();
        drop(queue);
        if tokio::time::timeout(std::time::Duration::from_secs(2), &mut pump)
            .await
            .is_err()
        {
            pump.abort();
            let _ = pump.await;
        }
        if failed.load(Ordering::Relaxed) {
            code = 1;
        }
        drop(session);
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while exited.borrow().is_none() {
            if exited.changed().await.is_err() {
                break;
            }
        }
    })
    .await;
    if code == 0 {
        if let Some(Some(status)) = *exited.borrow() {
            if status != 0 {
                code = status;
            }
        }
    }
    signal_task.abort();
    // Session callbacks can still be delivering queued events as the child exits.
    drop(events);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), output_task).await;
    code
}
