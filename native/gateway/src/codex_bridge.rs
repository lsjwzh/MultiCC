//! Native Codex app-server bridge. No Node process, HTTP listener or shared
//! account mutation: the caller supplies the isolated cwd and environment.
use multicc_core::{
    codex_background::Background,
    js::{self, JsString as S, JsValue as V},
};
use std::{
    collections::BTreeMap,
    io::Write,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot},
};

fn get(value: &V, key: &str) -> V {
    value.get(key).cloned().unwrap_or(V::Undefined)
}
fn text(value: &str) -> V {
    V::from(value)
}
fn truth(value: &V) -> bool {
    js::truthy(value)
}
fn or(value: V, next: V) -> V {
    if truth(&value) {
        value
    } else {
        next
    }
}
fn str_value(value: &V) -> String {
    js::js_to_string(value).to_string_lossy()
}
fn obj(fields: &[(&str, V)]) -> V {
    V::object(fields.to_vec())
}
fn emit(value: &V) -> Result<(), String> {
    let line = js::json_stringify(value).ok_or("invalid app-server output frame")?;
    writeln!(std::io::stdout().lock(), "{line}")
        .map_err(|error| format!("app-server output failed: {error}"))
}
fn error_line(message: &str) {
    let _ = writeln!(std::io::stderr().lock(), "[codex-exp] {message}");
}
fn number(value: u64) -> V {
    V::Number(value as f64)
}
fn parsed(bytes: &[u8]) -> Option<V> {
    js::json_parse(&String::from_utf8_lossy(bytes)).ok()
}

#[derive(Clone)]
struct Options {
    binary: String,
    configs: Vec<String>,
    thread: V,
    model: V,
    effort: V,
    prompt: V,
    resident: bool,
}
impl Options {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut out = Self {
            binary: String::new(),
            configs: vec![],
            thread: V::Null,
            model: V::Undefined,
            effort: V::Undefined,
            prompt: V::Undefined,
            resident: false,
        };
        let mut index = 0;
        while index < args.len() {
            let flag = &args[index];
            match flag.as_str() {
                "--resident" => out.resident = true,
                "--" => {
                    out.prompt = text(&args[index + 1..].join(" "));
                    break;
                }
                "--config" | "--codex-bin" | "--thread-id" | "--model" | "--effort" => {
                    index += 1;
                    let value = args
                        .get(index)
                        .ok_or_else(|| format!("missing {flag} value"))?;
                    match flag.as_str() {
                        "--config" => out.configs.push(value.clone()),
                        "--codex-bin" => out.binary = value.clone(),
                        "--thread-id" => out.thread = text(value),
                        "--model" => out.model = text(value),
                        _ => out.effort = text(value),
                    }
                }
                _ => {}
            }
            index += 1;
        }
        if out.binary.is_empty() {
            return Err("missing --codex-bin".into());
        }
        if !out.resident && !truth(&out.prompt) {
            return Err("missing prompt".into());
        }
        Ok(out)
    }
}
enum Control {
    Request {
        method: &'static str,
        params: V,
        reply: oneshot::Sender<Result<V, String>>,
    },
    Main(V),
    Ready,
    Stop(Option<String>),
    Attached {
        agent: usize,
        result: V,
        failed: bool,
    },
}
#[derive(Clone)]
struct Rpc(mpsc::UnboundedSender<Control>);
impl Rpc {
    async fn request(&self, method: &'static str, params: V) -> Result<V, String> {
        let (tx, rx) = oneshot::channel();
        self.0
            .send(Control::Request {
                method,
                params,
                reply: tx,
            })
            .map_err(|_| "app-server exited before responding".to_owned())?;
        rx.await
            .map_err(|_| "app-server exited before responding".to_owned())?
    }
    fn main(&self, id: V) {
        let _ = self.0.send(Control::Main(id));
    }
    fn stop(&self, error: Option<String>) {
        let _ = self.0.send(Control::Stop(error));
    }
}
fn common(model: V) -> Vec<(&'static str, V)> {
    let mut fields = vec![
        (
            "cwd",
            text(
                &std::env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy(),
            ),
        ),
        ("approvalPolicy", text("never")),
        ("sandbox", text("danger-full-access")),
    ];
    if truth(&model) {
        fields.push(("model", model));
    }
    fields
}
fn unusable(error: &str) -> bool {
    let view = js::regex::to_unit_view(&S::from(error));
    let pattern = format!(
        "(?:{}|{}[\\s\\S]{{0,160}}?{})",
        js::regex::ascii_ci("no rollout found for thread id"),
        js::regex::ascii_ci("uses model provider"),
        js::regex::ascii_ci("which is no longer configured")
    );
    regex::Regex::new(&pattern)
        .expect("thread error rule")
        .is_match(&view)
}
async fn open_thread(rpc: &Rpc, id: V, model: V) -> Result<V, String> {
    if truth(&id) {
        rpc.main(id.clone());
        let mut fields = vec![("threadId", id.clone()), ("excludeTurns", V::Bool(true))];
        fields.extend(common(model.clone()));
        match rpc.request("thread/resume", obj(&fields)).await {
            Ok(_) => {
                rpc.main(id.clone());
                return Ok(id);
            }
            Err(error) => {
                if !unusable(&error) {
                    return Err(error);
                }
                let truncated = S::from(error).truncate_units(200).to_string_lossy();
                error_line(&format!(
                    "native session {} cannot be resumed: {truncated}",
                    str_value(&id)
                ));
                rpc.main(V::Null);
                emit(&obj(&[
                    ("method", text("multicc/native_session_missing")),
                    ("params", obj(&[("threadId", id)])),
                ]))?;
            }
        }
    }
    let mut fields = common(model);
    fields.extend([
        ("threadSource", text("multicc-codex-exp")),
        ("sessionStartSource", text("startup")),
    ]);
    let started = rpc.request("thread/start", obj(&fields)).await?;
    let id = or(
        get(&get(&started, "thread"), "id"),
        or(get(&started, "threadId"), get(&started, "id")),
    );
    if !truth(&id) {
        return Err("app-server did not return a thread id".into());
    }
    rpc.main(id.clone());
    Ok(id)
}
async fn initialize(rpc: &Rpc) -> Result<(), String> {
    let result = rpc
        .request(
            "initialize",
            obj(&[(
                "clientInfo",
                obj(&[
                    ("name", text("multicc-codex-exp")),
                    ("title", text("MultiCC Codex")),
                    ("version", text("0.1.0")),
                ]),
            )]),
        )
        .await?;
    let agent = or(get(&result, "userAgent"), text("unknown"));
    let value = str_value(&agent);
    let regex = regex::Regex::new(r"(?-u:\b)([0-9]+)\.([0-9]+)\.([0-9]+)(?-u:\b)").unwrap();
    let supported = regex.captures(&value).is_some_and(|m| {
        let version = [1, 2, 3].map(|i| m[i].parse::<u64>().unwrap_or(u64::MAX));
        version >= [0, 154, 0]
    });
    if !supported {
        return Err(format!(
            "unsupported app-server version: {value} (requires Codex >= 0.154.0)"
        ));
    }
    rpc.0
        .send(Control::Request {
            method: "initialized",
            params: obj(&[]),
            reply: oneshot::channel().0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}
async fn start_turn(rpc: &Rpc, id: V, prompt: V, model: V, effort: V) -> Result<(), String> {
    let mut fields = vec![
        ("threadId", id),
        (
            "input",
            V::Array(vec![obj(&[("type", text("text")), ("text", prompt)])]),
        ),
    ];
    if truth(&model) {
        fields.push(("model", model));
    }
    if truth(&effort) {
        fields.push(("effort", effort));
    }
    rpc.request("turn/start", obj(&fields)).await.map(|_| ())
}
async fn run(
    rpc: Rpc,
    options: Options,
    mut done: mpsc::UnboundedReceiver<()>,
    mut incoming: mpsc::UnboundedReceiver<Vec<u8>>,
) -> Result<(), String> {
    initialize(&rpc).await?;
    let mut id = open_thread(&rpc, options.thread.clone(), options.model.clone()).await?;
    if !options.resident {
        return start_turn(&rpc, id, options.prompt, options.model, options.effort).await;
    }
    let _ = rpc.0.send(Control::Ready);
    let mut queue = std::collections::VecDeque::new();
    let mut busy = false;
    loop {
        if !busy {
            if let Some(turn) = queue.pop_front() {
                let prompt = if matches!(turn, V::String(_)) {
                    turn.clone()
                } else {
                    get(&turn, "text")
                };
                let model = or(get(&turn, "model"), options.model.clone());
                let effort = or(get(&turn, "effort"), options.effort.clone());
                let next = get(&turn, "threadId");
                if truth(&next) && next != id {
                    id = open_thread(&rpc, next, model.clone()).await?;
                }
                busy = true;
                start_turn(&rpc, id.clone(), prompt, model, effort).await?;
            }
        }
        tokio::select! {
            line = incoming.recv() => {
                let Some(line) = line else { return Ok(()); };
                if String::from_utf8_lossy(&line).trim().is_empty() { continue; }
                let Some(turn) = parsed(&line) else {
                    error_line("resident bridge dropped a non-JSON stdin line");
                    continue;
                };
                let prompt = if matches!(turn, V::String(_)) { turn.clone() } else { get(&turn, "text") };
                if matches!(&prompt, V::String(value) if !value.is_empty()) { queue.push_back(turn); }
            },
            received=done.recv()=>{if received.is_none(){return Ok(());}busy=false;}
        }
    }
}
struct Pending {
    method: &'static str,
    reply: oneshot::Sender<Result<V, String>>,
    deadline: Instant,
}
struct Actor {
    rpc: Rpc,
    background: Background,
    timers: BTreeMap<u64, Instant>,
    pending: BTreeMap<u64, Pending>,
    next: u64,
    main: V,
    start: Instant,
}
impl Actor {
    fn now(&self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }
    fn effects(&mut self) -> Result<(), String> {
        for effect in self.background.effects() {
            match str_value(&get(&effect, "kind")).as_str() {
                "emit" => emit(&obj(&[
                    ("method", text("multicc/background")),
                    ("params", obj(&[("event", get(&effect, "event"))])),
                ]))?,
                "timer" => {
                    let id = js::js_to_number(&get(&effect, "id")) as u64;
                    let ms = js::js_to_number(&get(&effect, "delay")).clamp(0.0, 86_400_000.0);
                    self.timers
                        .insert(id, Instant::now() + Duration::from_secs_f64(ms / 1000.0));
                }
                "cancel" => {
                    self.timers
                        .remove(&(js::js_to_number(&get(&effect, "id")) as u64));
                }
                "attach" => {
                    let rpc = self.rpc.clone();
                    tokio::spawn(async move {
                        let id = get(&effect, "id");
                        let agent = js::js_to_number(&get(&effect, "agent")) as usize;
                        let result = async {
                            let resumed = rpc
                                .request(
                                    "thread/resume",
                                    obj(&[
                                        ("threadId", id.clone()),
                                        ("excludeTurns", V::Bool(true)),
                                    ]),
                                )
                                .await?;
                            if get(&get(&resumed, "thread"), "id") != id {
                                return Err("子线程接入身份不匹配".to_owned());
                            }
                            if get(&get(&get(&resumed, "thread"), "status"), "type") != text("idle")
                            {
                                return Ok(resumed);
                            }
                            let page = rpc
                                .request(
                                    "thread/turns/list",
                                    obj(&[
                                        ("threadId", id),
                                        ("limit", number(1)),
                                        ("sortDirection", text("desc")),
                                        ("itemsView", text("summary")),
                                    ]),
                                )
                                .await
                                .unwrap_or(V::Null);
                            let latest = if let V::Array(values) = get(&page, "data") {
                                values.first().cloned().unwrap_or(V::Undefined)
                            } else {
                                V::Undefined
                            };
                            let mut resumed = resumed;
                            if let V::Object(fields) = &mut resumed {
                                if let Some((_, value)) =
                                    fields.iter_mut().find(|(k, _)| *k == "latestTurn")
                                {
                                    *value = latest;
                                } else {
                                    fields.push((S::from("latestTurn"), latest));
                                }
                            }
                            Ok(resumed)
                        }
                        .await;
                        let failed = result.is_err();
                        let _ = rpc.0.send(Control::Attached {
                            agent,
                            result: result.unwrap_or(V::Null),
                            failed,
                        });
                    });
                }
                _ => {}
            }
        }
        Ok(())
    }
    fn expired(&mut self) -> Result<(), String> {
        let now = Instant::now();
        let ids = self
            .timers
            .iter()
            .filter(|(_, at)| **at <= now)
            .map(|(id, _)| *id)
            .collect::<Vec<_>>();
        for id in ids {
            self.timers.remove(&id);
            self.background.fire(id, self.now());
            self.effects()?;
        }
        let ids = self
            .pending
            .iter()
            .filter(|(_, p)| p.deadline <= now)
            .map(|(id, _)| *id)
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(p) = self.pending.remove(&id) {
                let _ = p.reply.send(Err(format!("{} timed out", p.method)));
            }
        }
        Ok(())
    }
    fn deadline(&self) -> Instant {
        self.timers
            .values()
            .copied()
            .chain(self.pending.values().map(|p| p.deadline))
            .min()
            .unwrap_or(Instant::now() + Duration::from_secs(3600))
    }
    async fn write(input: &mut tokio::process::ChildStdin, value: &V) -> Result<(), String> {
        let mut line = js::json_stringify(value).ok_or("invalid app-server frame")?;
        line.push('\n');
        input
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())
    }
    async fn message(
        &mut self,
        message: V,
        input: &mut tokio::process::ChildStdin,
    ) -> Result<bool, String> {
        let id = get(&message, "id");
        if id != V::Undefined
            && (get(&message, "result") != V::Undefined || get(&message, "error") != V::Undefined)
        {
            if let V::Number(id) = id {
                if id == (id as u64) as f64 {
                    if let Some(pending) = self.pending.remove(&(id as u64)) {
                        let error = get(&message, "error");
                        let result = if truth(&error) {
                            Err(str_value(&or(
                                get(&error, "message"),
                                text(&js::json_stringify(&error).unwrap_or_default()),
                            )))
                        } else {
                            Ok(get(&message, "result"))
                        };
                        let _ = pending.reply.send(result);
                    }
                }
            }
            return Ok(false);
        }
        let method = get(&message, "method");
        if !truth(&method) {
            return Ok(false);
        }
        let params = get(&message, "params");
        let thread = get(&params, "thread");
        let event_id = or(get(&params, "threadId"), get(&thread, "id"));
        if !truth(&self.main)
            && method == text("thread/started")
            && !truth(&get(&thread, "parentThreadId"))
        {
            self.main = event_id.clone();
            self.background.set_main(self.main.clone());
        }
        let ownership = self.background.consume(&message, self.now());
        self.effects()?;
        let child = truth(&get(&ownership, "child"));
        if !child {
            emit(&message)?;
        }
        if id != V::Undefined {
            let name = str_value(&method);
            let reply = if name.contains("requestApproval") || name.ends_with("Approval") {
                obj(&[("id", id), ("result", obj(&[("decision", text("cancel"))]))])
            } else {
                obj(&[("id",id),("error",obj(&[("code",V::Number(-32601.0)),("message",text("codex-exp bridge does not support interactive server requests yet"))]))])
            };
            Self::write(input, &reply).await?;
            return Ok(false);
        }
        Ok(!child
            && method == text("turn/completed")
            && (!truth(&event_id) || event_id == self.main))
    }
}
#[cfg(unix)]
async fn signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM");
    let mut interrupt = signal(SignalKind::interrupt()).expect("SIGINT");
    tokio::select! {_=term.recv()=>{},_=interrupt.recv()=>{}}
}
#[cfg(not(unix))]
async fn signal() {
    let _ = tokio::signal::ctrl_c().await;
}
fn terminate(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    let _ = child.start_kill();
}

pub async fn serve(args: &[String]) -> i32 {
    let options = match Options::parse(args) {
        Ok(v) => v,
        Err(e) => {
            error_line(&e);
            return 1;
        }
    };
    let mut command = Command::new(&options.binary);
    command.args(["app-server", "--listen", "stdio://"]);
    for config in &options.configs {
        if !config.is_empty() {
            command.args(["-c", config]);
        }
    }
    let mut child = match command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(v) => v,
        Err(e) => {
            error_line(&format!("app-server spawn failed: {e}"));
            return 1;
        }
    };
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut stderr = child.stderr.take().unwrap();
    let stderr_task = tokio::spawn(async move {
        let mut target = tokio::io::stderr();
        let _ = tokio::io::copy(&mut stderr, &mut target).await;
    });
    let (tx, mut rx) = mpsc::unbounded_channel();
    let rpc = Rpc(tx);
    let (done_tx, done_rx) = mpsc::unbounded_channel();
    let resident = options.resident;
    let (turn_tx, turn_rx) = mpsc::unbounded_channel();
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut stdin_line = vec![];
    let mut ready = false;
    let mut actor = Actor {
        background: Background::new(options.thread.clone(), 1000.0, true),
        main: options.thread.clone(),
        rpc: rpc.clone(),
        timers: BTreeMap::new(),
        pending: BTreeMap::new(),
        next: 1,
        start: Instant::now(),
    };
    let runner = tokio::spawn(async move {
        if let Err(e) = run(rpc.clone(), options, done_rx, turn_rx).await {
            rpc.stop(Some(e));
        }
    });
    let signal = signal();
    tokio::pin!(signal);
    let mut stopping = None;
    let mut exit = None;
    let mut eof = false;
    let mut code = 0;
    let mut terminal = false;
    let mut line = vec![];
    loop {
        if exit.is_some() && eof {
            break;
        }
        let deadline = stopping.unwrap_or_else(|| actor.deadline());
        tokio::select! {
            _ = &mut signal, if stopping.is_none() => {
                actor.background.dispose(); actor.timers.clear();
                terminate(&mut child);
                stopping = Some(Instant::now() + Duration::from_secs(1));
            },
            status = child.wait(), if exit.is_none() => {
                exit = Some(status.map(|s| s.code().unwrap_or(1)).unwrap_or(1));
            },
            count = output.read_until(b'\n', &mut line), if !eof => {
                match count {
                    Ok(0) | Err(_) => eof = true,
                    Ok(_) => {
                        if let Some(message) = parsed(&line) {
                            match actor.message(message, &mut input).await {
                                Ok(true) => {
                                    if resident { let _ = done_tx.send(()); }
                                    else if stopping.is_none() {
                                        terminal = true;
                                        actor.background.dispose(); actor.timers.clear();
                                        terminate(&mut child);
                                        stopping = Some(Instant::now() + Duration::from_secs(1));
                                    }
                                },
                                Err(error) => {
                                    error_line(&error); code = 1;
                                    actor.background.dispose(); actor.timers.clear();
                                    terminate(&mut child);
                                    stopping = Some(Instant::now() + Duration::from_secs(1));
                                },
                                _ => {}
                            }
                        }
                    }
                }
                line.clear();
            },
            count = stdin.read_until(b'\n', &mut stdin_line), if ready && resident && stopping.is_none() => {
                match count {
                    Ok(0) | Err(_) => {
                        terminal = true;
                        actor.background.dispose(); actor.timers.clear();
                        terminate(&mut child);
                        stopping = Some(Instant::now() + Duration::from_secs(1));
                    },
                    Ok(_) => { let _ = turn_tx.send(std::mem::take(&mut stdin_line)); }
                }
            },
            control = rx.recv() => {
                match control {
                    Some(Control::Request { method, params, reply }) => {
                        let id = actor.next;
                        if method != "initialized" { actor.next += 1; }
                        let mut frame = vec![("id", number(id)), ("method", text(method)), ("params", params)];
                        if method == "initialized" { frame.remove(0); }
                        else { actor.pending.insert(id, Pending { method, reply, deadline: Instant::now() + Duration::from_secs(30) }); }
                        if let Err(error) = Actor::write(&mut input, &obj(&frame)).await {
                            error_line(&error); code = 1;
                            actor.background.dispose(); actor.timers.clear();
                            terminate(&mut child);
                            stopping = Some(Instant::now() + Duration::from_secs(1));
                        }
                    },
                    Some(Control::Ready) => ready = true,
                    Some(Control::Main(id)) => { actor.main = id.clone(); actor.background.set_main(id); },
                    Some(Control::Stop(error)) => {
                        if stopping.is_none() {
                            terminal = error.is_none();
                            if let Some(error) = error { error_line(&error); code = 1; }
                            actor.background.dispose(); actor.timers.clear();
                            terminate(&mut child);
                            stopping = Some(Instant::now() + Duration::from_secs(1));
                        }
                    },
                    Some(Control::Attached { agent, result, failed }) => {
                        actor.background.attached(agent, &result, failed, actor.now());
                        if let Err(error) = actor.effects() {
                            error_line(&error); code = 1;
                            actor.background.dispose(); actor.timers.clear();
                            terminate(&mut child);
                            stopping = Some(Instant::now() + Duration::from_secs(1));
                        }
                    },
                    None => {}
                }
            },
            _ = tokio::time::sleep_until(deadline.into()) => {
                if stopping.is_some() {
                    let _ = child.start_kill();
                    let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
                    break;
                }
                if let Err(error) = actor.expired() {
                    error_line(&error); code = 1;
                    actor.background.dispose(); actor.timers.clear();
                    terminate(&mut child);
                    stopping = Some(Instant::now() + Duration::from_secs(1));
                }
            }
        }
    }

    runner.abort();
    for (_, pending) in actor.pending {
        let _ = pending
            .reply
            .send(Err("app-server exited before responding".into()));
    }
    actor.background.dispose();
    let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
    if code != 0 {
        code
    } else if terminal {
        0
    } else {
        exit.unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_timeout_keeps_the_method_and_releases_the_waiter() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let (reply, mut received) = oneshot::channel();
        let mut actor = Actor {
            rpc: Rpc(tx),
            background: Background::new(V::Null, 1000.0, false),
            timers: BTreeMap::new(),
            pending: BTreeMap::new(),
            next: 2,
            main: V::Null,
            start: Instant::now(),
        };
        actor.pending.insert(
            1,
            Pending {
                method: "turn/start",
                reply,
                deadline: Instant::now(),
            },
        );
        actor.expired().unwrap();
        assert_eq!(
            received.try_recv().unwrap(),
            Err("turn/start timed out".to_owned())
        );
        assert!(actor.pending.is_empty());
        actor.expired().unwrap();
    }

    #[test]
    fn wire_text_retains_lone_utf16_units_and_ignores_invalid_json() {
        let line = r#"{"method":"item/agentMessage/delta","params":{"delta":"\ud800"}}"#;
        let frame = parsed(line.as_bytes()).unwrap();
        assert_eq!(js::json_stringify(&frame).unwrap(), line);
        assert!(parsed(b"not-json").is_none());
    }
}
