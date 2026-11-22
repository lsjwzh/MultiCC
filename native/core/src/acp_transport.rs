//! ACP JSON-RPC transport. The agent process is isolated to its caller's cwd
//! and environment; all protocol state is local to this process instance.
use crate::{
    acp_bridge,
    js::{self, JsValue as V},
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot},
};

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

#[derive(Clone, Debug, PartialEq)]
pub struct RpcFailure {
    pub message: String,
    pub code: V,
    pub rpc_error: V,
}
impl RpcFailure {
    fn closed(label: &str, method: &str) -> Self {
        Self {
            message: format!("{label} exited before answering {method}"),
            code: text("agent_exited"),
            rpc_error: V::Undefined,
        }
    }
    fn timeout(method: &str) -> Self {
        Self {
            message: format!("{method} timed out"),
            code: text("acp_timeout"),
            rpc_error: V::Undefined,
        }
    }
    fn remote(error: V) -> Self {
        let data = get(&error, "data");
        let detail = or(
            get(&data, "message"),
            or(get(&data, "details"), get(&data, "error")),
        );
        let base = name(&or(get(&error, "message"), error.clone()));
        let message = if js::truthy(&detail) && !base.contains(&name(&detail)) {
            format!("{base}: {}", name(&detail))
        } else {
            base
        };
        Self {
            message,
            code: get(&error, "code"),
            rpc_error: error,
        }
    }
}

#[derive(Debug)]
pub enum Event {
    Frame(V),
    Exited(Option<i32>),
    Barrier(oneshot::Sender<()>),
}

enum Control {
    Request {
        id: u64,
        method: String,
        params: V,
        reply: oneshot::Sender<Result<V, RpcFailure>>,
    },
    Notify {
        method: String,
        params: V,
    },
    Barrier(oneshot::Sender<()>),
    TimedOut(u64),
    Stop,
}

#[derive(Clone)]
pub struct Client {
    tx: mpsc::UnboundedSender<Control>,
    label: String,
    next_id: Arc<AtomicU64>,
}
impl Client {
    /// A zero timeout waits indefinitely, matching session/prompt.
    pub async fn request(
        &self,
        method: &str,
        params: V,
        timeout: Duration,
    ) -> Result<V, RpcFailure> {
        let (reply, result) = oneshot::channel();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.tx
            .send(Control::Request {
                id,
                method: method.to_owned(),
                params,
                reply,
            })
            .map_err(|_| RpcFailure::closed(&self.label, method))?;
        if timeout.is_zero() {
            result
                .await
                .unwrap_or_else(|_| Err(RpcFailure::closed(&self.label, method)))
        } else {
            match tokio::time::timeout(timeout, result).await {
                Ok(Ok(answer)) => answer,
                Ok(Err(_)) => Err(RpcFailure::closed(&self.label, method)),
                Err(_) => {
                    let _ = self.tx.send(Control::TimedOut(id));
                    Err(RpcFailure::timeout(method))
                }
            }
        }
    }
    pub fn notify(&self, method: &str, params: V) {
        let _ = self.tx.send(Control::Notify {
            method: method.to_owned(),
            params,
        });
    }
    pub async fn flush_events(&self) {
        let (done, received) = oneshot::channel();
        if self.tx.send(Control::Barrier(done)).is_ok() {
            let _ = received.await;
        }
    }
    pub fn stop(&self) {
        let _ = self.tx.send(Control::Stop);
    }
}

pub struct SpawnOptions {
    pub binary: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub label: String,
}

// Node's readline accepts LF, CRLF, and a bare CR. Keep bytes until a whole
// line is available so invalid UTF-8 is replaced the same way as Node.
async fn read_acp_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    line: &mut Vec<u8>,
) -> std::io::Result<bool> {
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(!line.is_empty());
        }
        let end = available
            .iter()
            .position(|byte| *byte == b'\n' || *byte == b'\r');
        let size = end.unwrap_or(available.len());
        line.extend_from_slice(&available[..size]);
        let consumed = size + usize::from(end.is_some());
        reader.consume(consumed);
        if end.is_some() {
            return Ok(true);
        }
    }
}

/// Start one ACP agent. stderr stays attached to the parent, as in the Node bridge.
pub fn spawn(options: SpawnOptions) -> std::io::Result<(Client, mpsc::UnboundedReceiver<Event>)> {
    let mut child = Command::new(&options.binary)
        .args(&options.args)
        .current_dir(&options.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdin = child.stdin.take().expect("piped ACP stdin");
    let stdout = child.stdout.take().expect("piped ACP stdout");
    let (commands, mut controls) = mpsc::unbounded_channel();
    let (events, received) = mpsc::unbounded_channel();
    let (writer, mut outbound) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = outbound.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let label = options.label;
    let client = Client {
        tx: commands,
        label: label.clone(),
        next_id: Arc::new(AtomicU64::new(1)),
    };
    tokio::spawn(async move {
        let mut output = BufReader::new(stdout);
        let mut line = Vec::new();
        let mut pending: BTreeMap<u64, (String, oneshot::Sender<Result<V, RpcFailure>>)> =
            BTreeMap::new();
        let mut replaying = false;
        let mut output_closed = false;
        let mut child_status = None;
        let send = |message: V| {
            if let Some(line) = js::json_stringify(&acp_bridge::rpc_frame(&message)) {
                let _ = writer.send(format!("{line}\n"));
            }
        };
        loop {
            if output_closed && child_status.is_some() {
                break;
            }
            tokio::select! {
                result = child.wait(), if child_status.is_none() => {
                    child_status = Some(result.ok());
                },
                control = controls.recv() => match control {
                    Some(Control::Request { id, method, params, reply }) => {
                        if method == "session/load" { replaying = true; }
                        send(obj(vec![("id", V::Number(id as f64)), ("method", text(&method)), ("params", params)]));
                        pending.insert(id, (method, reply));
                    }
                    Some(Control::Notify { method, params }) => send(obj(vec![("method", text(&method)), ("params", params)])),
                    Some(Control::Barrier(done)) => { let _ = events.send(Event::Barrier(done)); },
                    Some(Control::TimedOut(id)) => {
                        if let Some((method, _)) = pending.remove(&id) {
                            if method == "session/load" { replaying = false; }
                        }
                    },
                    Some(Control::Stop) | None => break,
                },
                read = read_acp_line(&mut output, &mut line), if !output_closed => match read {
                    Ok(true) => {
                        let decoded = String::from_utf8_lossy(&line);
                        let parsed = js::json_parse(&decoded);
                        line.clear();
                        let Ok(message) = parsed else { continue; };
                        if !matches!(message, V::Object(_) | V::Array(_)) { continue; }
                        let id = get(&message, "id"); let method = get(&message, "method");
                        if !id.is_nullish() && !js::truthy(&method) {
                            if let V::Number(raw) = id {
                                if raw >= 0.0 && raw.fract() == 0.0 {
                                    if let Some((method, reply)) = pending.remove(&(raw as u64)) {
                                        if method == "session/load" { replaying = false; }
                                        let error = get(&message, "error");
                                        let result = if js::truthy(&error) { Err(RpcFailure::remote(error)) } else { Ok(or(get(&message,"result"), obj(vec![]))) };
                                        let _ = reply.send(result);
                                    }
                                }
                            }
                            continue;
                        }
                        if !js::truthy(&method) { continue; }
                        if !id.is_nullish() {
                            if method == text("session/request_permission") {
                                let params = get(&message, "params"); let option = acp_bridge::pick_permission(&get(&params,"options"));
                                if !js::truthy(&option) {
                                    send(obj(vec![("id",id),("result",obj(vec![("outcome",obj(vec![("outcome",text("cancelled"))]))]))]));
                                } else {
                                    let tool = get(&params,"toolCall");
                                    let event = obj(vec![("method",text("multicc/permission")),("params",obj(vec![
                                        ("title",or(get(&tool,"title"),V::Null)),("kind",or(get(&tool,"kind"),V::Null)),("optionId",get(&option,"optionId"))]))]);
                                    let _ = events.send(Event::Frame(event));
                                    send(obj(vec![("id",id),("result",obj(vec![("outcome",obj(vec![("outcome",text("selected")),("optionId",get(&option,"optionId"))]))]))]));
                                }
                            } else {
                                send(obj(vec![("id",id),("error",obj(vec![("code",V::Number(-32601.0)),("message",text(&format!("multicc ACP client does not implement {}",name(&method))))]))]));
                            }
                            continue;
                        }
                        if method == text("session/update") && !replaying {
                            let _ = events.send(Event::Frame(obj(vec![("method",method),("params",get(&message,"params"))])));
                        }
                    }
                    _ => output_closed = true,
                }
            }
        }
        drop(writer);
        let status = if let Some(result) = child_status {
            result.and_then(|status| status.code())
        } else {
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
            #[cfg(not(unix))]
            {
                let _ = child.start_kill();
            }
            match tokio::time::timeout(Duration::from_secs(1), child.wait()).await {
                Ok(Ok(status)) => status.code(),
                _ => {
                    let _ = child.start_kill();
                    child.wait().await.ok().and_then(|status| status.code())
                }
            }
        };
        for (_, (method, reply)) in pending {
            let _ = reply.send(Err(RpcFailure::closed(&label, &method)));
        }
        let _ = events.send(Event::Exited(status));
    });
    Ok((client, received))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn options(script: &str) -> SpawnOptions {
        SpawnOptions {
            binary: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: std::env::current_dir().unwrap(),
            label: "Fake".into(),
        }
    }
    #[tokio::test]
    async fn permission_replies_replay_suppression_and_request_order() {
        let script = r#"
          IFS= read -r request || exit 1
          printf '%s\n' '{"method":"session/update","params":{"update":{"text":"first"}}}'
          printf '%s\n' '{"id":"req","method":"session/request_permission","params":{"toolCall":{"title":"read"},"options":[{"kind":"allow_once","optionId":"yes"}]}}'
          IFS= read -r reply || exit 2
          case "$reply" in *'"optionId":"yes"'*) ;; *) exit 3;; esac
          printf '%s\n' '{"id":1,"result":{"ok":true}}'
          IFS= read -r request || exit 4
          printf '%s\n' '{"method":"session/update","params":{"update":{"text":"replay"}}}'
          printf '%s\n' '{"id":2,"result":{}}'
          IFS= read -r request || exit 5
          printf '%s\n' '{"method":"session/update","params":{"update":{"text":"live"}}}'
          printf '%s\n' '{"id":3,"result":{"stopReason":"end_turn"}}'
          IFS= read -r request || :
        "#;
        let (client, mut events) = spawn(options(script)).unwrap();
        let first = client
            .request("initialize", obj(vec![]), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(get(&first, "ok"), V::Bool(true));
        client
            .request("session/load", obj(vec![]), Duration::from_secs(2))
            .await
            .unwrap();
        client
            .request("session/prompt", obj(vec![]), Duration::from_secs(2))
            .await
            .unwrap();
        let mut frames = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let Event::Frame(frame) = event {
                frames.push(js::json_stringify(&frame).unwrap());
            }
        }
        assert_eq!(frames.len(), 3);
        assert!(frames[0].contains("first"));
        assert!(frames[1].contains("multicc/permission") && frames[1].contains("yes"));
        assert!(frames[2].contains("live"));
        client.stop();
    }
    #[tokio::test]
    async fn request_timeout_and_remote_error_keep_their_codes() {
        let script = r#"IFS= read -r request; printf '%s\n' '{"id":1,"error":{"code":-32000,"message":"failed","data":{"message":"detail"}}}'; IFS= read -r request; sleep 2"#;
        let (client, _events) = spawn(options(script)).unwrap();
        let error = client
            .request("initialize", obj(vec![]), Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(error.message, "failed: detail");
        assert_eq!(error.code, V::Number(-32000.0));
        let error = client
            .request("session/new", obj(vec![]), Duration::from_millis(30))
            .await
            .unwrap_err();
        assert_eq!(error.code, text("acp_timeout"));
        client.stop();
    }
    #[tokio::test]
    async fn timed_out_load_does_not_suppress_later_live_updates() {
        let script = r#"IFS= read -r request; sleep 0.1; printf '%s\n' '{"method":"session/update","params":{"update":{"text":"live"}}}'; IFS= read -r request; printf '%s\n' '{"id":2,"result":{}}'; IFS= read -r request || :"#;
        let (client, mut events) = spawn(options(script)).unwrap();
        let error = client
            .request("session/load", obj(vec![]), Duration::from_millis(20))
            .await
            .unwrap_err();
        assert_eq!(error.code, text("acp_timeout"));
        client
            .request("session/new", obj(vec![]), Duration::from_secs(2))
            .await
            .unwrap();
        assert!(
            matches!(events.try_recv(), Ok(Event::Frame(frame)) if js::json_stringify(&frame).unwrap().contains("live"))
        );
        client.stop();
    }
    #[tokio::test]
    async fn closing_stdout_does_not_kill_a_still_running_agent() {
        let script = r#"IFS= read -r request; exec 1>&-; sleep 0.15; exit 17"#;
        let (client, mut events) = spawn(options(script)).unwrap();
        let start = std::time::Instant::now();
        let error = client
            .request("initialize", obj(vec![]), Duration::from_secs(2))
            .await
            .unwrap_err();
        assert_eq!(error.code, text("agent_exited"));
        assert!(start.elapsed() >= Duration::from_millis(100));
        assert!(matches!(events.recv().await, Some(Event::Exited(Some(17)))));
    }
}
