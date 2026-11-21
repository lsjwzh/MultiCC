//! Codex wire-event ownership, background progress and timer decisions.
use crate::js::{self, JsString as S, JsValue as V};
use regex::Regex;

fn get(value: &V, key: &str) -> V {
    value.get(key).cloned().unwrap_or(V::Undefined)
}
fn yes(value: &V) -> bool {
    js::truthy(value)
}
fn fallback(value: V, other: V) -> V {
    if yes(&value) {
        value
    } else {
        other
    }
}
fn string(value: &V) -> S {
    js::js_to_string(value)
}
fn txt(value: &str) -> V {
    V::from(value)
}
fn obj(fields: &[(&str, V)]) -> V {
    V::Object(
        fields
            .iter()
            .map(|(k, v)| (S::from(*k), v.clone()))
            .collect(),
    )
}
fn cat(parts: &[V]) -> V {
    V::String(S::join(
        &parts.iter().map(string).collect::<Vec<_>>(),
        &S::new(),
    ))
}
fn is(value: &V, expected: &str) -> bool {
    value == &txt(expected)
}
fn array(value: &V) -> Vec<V> {
    if let V::Array(values) = value {
        values.clone()
    } else {
        vec![]
    }
}
fn entries(value: &V) -> Vec<(S, V)> {
    if let V::Object(values) = value {
        values.clone()
    } else {
        vec![]
    }
}
fn end(value: &V) -> Option<&'static str> {
    match string(value).to_string_lossy().as_str() {
        "completed" => Some("completed"),
        "errored" | "failed" => Some("failed"),
        "interrupted" | "shutdown" | "notFound" => Some("interrupted"),
        _ => None,
    }
}
fn outcome(value: &str) -> &'static str {
    match value {
        "completed" => "已完成",
        "failed" => "执行失败",
        _ => "已中断",
    }
}

pub fn safe_text(value: &V, limit: usize) -> S {
    let source = string(&fallback(value.clone(), txt("")));
    let source = crate::redaction::redact_text(&crate::redaction::redact_route_capability(&source));
    let mut out = S::new();
    let mut space = false;
    for unit in source.as_units() {
        if *unit <= 31 || *unit == 127 {
            if !space {
                out.push_unit(32);
            }
            space = true;
        } else {
            out.push_unit(*unit);
            space = false;
        }
    }
    out.trim().truncate_units(limit)
}
fn replace(value: &S, pattern: &str, replacement: &str) -> S {
    let view = js::regex::to_unit_view(value);
    let regex = Regex::new(
        &pattern
            .replace(r"\s", &format!("[{}]", js::regex::SPACE))
            .replace(r"\S", &format!("[^{}]", js::regex::SPACE)),
    )
    .expect("Codex wire text rule");
    js::regex::from_unit_view(&regex.replace_all(&view, replacement))
}
pub fn unwrap_command(value: &V) -> S {
    let mut value = value.clone();
    if let V::Array(parts) = &value {
        if parts.len() == 3
            && Regex::new("^-l?c$")
                .unwrap()
                .is_match(&string(&parts[1]).to_string_lossy())
            && Regex::new("(?:^|/)(?:ba|z|fi)?sh$")
                .unwrap()
                .is_match(&string(&parts[0]).to_string_lossy())
        {
            value = parts[2].clone();
        }
    }
    let text = if let V::Array(parts) = &value {
        S::join(
            &parts
                .iter()
                .map(|v| {
                    if matches!(v, V::Undefined | V::Null) {
                        S::new()
                    } else {
                        string(v)
                    }
                })
                .collect::<Vec<_>>(),
            &S::from(" "),
        )
    } else {
        string(&fallback(value, txt("")))
    };
    let mut text = replace(&text, &format!("[{}]+", js::regex::SPACE), " ").trim();
    let view = js::regex::to_unit_view(&text);
    let space = js::regex::SPACE;
    let wrapped = Regex::new(&format!(
        r#"^(?:[^{space}]*/)?(?:ba|z|fi)?sh[{space}]+-l?c[{space}]+(['"])(?s:(.*))['"]$"#
    ))
    .unwrap();
    if let Some(found) = wrapped.captures(&view) {
        let quote = found.get(1).unwrap().as_str();
        if view.ends_with(quote) {
            text = js::regex::from_unit_view(found.get(2).unwrap().as_str()).trim();
        }
    }
    replace(&text, r#"^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*"#, "").trim()
}
fn short_args(value: &V) -> S {
    if !matches!(value, V::Object(_) | V::Array(_)) {
        return safe_text(value, 80);
    }
    let pick = [
        "description",
        "command",
        "query",
        "pattern",
        "path",
        "file_path",
        "url",
        "prompt",
        "name",
    ]
    .into_iter()
    .map(|key| get(value, key))
    .find(yes);
    let source = pick.unwrap_or_else(|| value.clone());
    let source = if matches!(source, V::String(_)) {
        source
    } else {
        txt(&js::json_stringify(&source).unwrap_or_default())
    };
    safe_text(&source, 80)
}
pub fn tool_detail(item: &V) -> S {
    match string(&get(item, "type")).to_string_lossy().as_str() {
        "commandExecution" => safe_text(&V::String(unwrap_command(&get(item, "command"))), 100),
        "fileChange" => {
            let names = array(&get(item, "changes"))
                .into_iter()
                .map(|change| {
                    let path = string(&fallback(get(&change, "path"), txt("")));
                    let view = js::regex::to_unit_view(&path);
                    js::regex::from_unit_view(
                        view.rsplit(['/', '\\'])
                            .find(|p| !p.is_empty())
                            .unwrap_or(""),
                    )
                })
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>();
            let head = S::join(&names[..names.len().min(3)], &S::from(", "));
            let text = if names.len() > 3 {
                cat(&[V::String(head), txt(&format!(" 等 {} 个文件", names.len()))])
            } else {
                V::String(head)
            };
            safe_text(&text, 100)
        }
        "mcpToolCall" => short_args(&get(item, "arguments")),
        "webSearch" => safe_text(
            &fallback(
                get(item, "query"),
                fallback(get(&get(item, "action"), "query"), txt("")),
            ),
            80,
        ),
        _ => S::new(),
    }
}
fn tool_label(item: &V) -> S {
    let kind = get(item, "type");
    let mut label = match string(&kind).to_string_lossy().as_str() {
        "commandExecution" => "正在执行命令",
        "mcpToolCall" => "正在调用工具",
        "fileChange" => "正在修改文件",
        "webSearch" => "正在搜索资料",
        _ => return S::new(),
    }
    .to_owned();
    if is(&kind, "commandExecution")
        && Regex::new(r"(?-u:\b)(test|pytest|jest|vitest)(?-u:\b)")
            .unwrap()
            .is_match(&unwrap_command(&get(item, "command")).to_string_lossy())
    {
        label = "正在运行测试".into();
    }
    let mut label = S::from(label);
    if is(&kind, "mcpToolCall") && yes(&get(item, "tool")) {
        label.push_str("：");
        label.push(&safe_text(&get(item, "tool"), 60));
    }
    let detail = tool_detail(item);
    if !detail.is_empty() {
        label.push_str(" · ");
        label.push(&detail);
    }
    label
}
#[derive(Clone)]
struct Agent {
    id: V,
    label: S,
    live: bool,
    ended: bool,
    seen: bool,
    active: V,
    last: f64,
    description: S,
    pending: V,
    progress: Option<u64>,
    pulse: Option<u64>,
    attach: Option<u64>,
}
struct Tool {
    key: S,
    id: S,
    label: S,
    last: f64,
}
#[derive(Clone, Copy)]
enum TimerKind {
    Progress,
    Pulse,
    Attach,
}
struct Timer {
    id: u64,
    agent: usize,
    kind: TimerKind,
}
pub struct Background {
    main: V,
    agents: Vec<Agent>,
    tools: Vec<Tool>,
    activities: Vec<S>,
    timers: Vec<Timer>,
    next: u64,
    disposed: bool,
    throttle: f64,
    effects: Vec<V>,
    now: f64,
    attach: bool,
}
impl Background {
    pub fn new(main: V, throttle: f64, attach: bool) -> Self {
        Self {
            main,
            agents: vec![],
            tools: vec![],
            activities: vec![],
            timers: vec![],
            next: 0,
            disposed: false,
            throttle,
            effects: vec![],
            now: 0.0,
            attach,
        }
    }
    pub fn active_count(&self) -> usize {
        self.agents.iter().filter(|a| a.live).count()
    }
    fn known(&self, id: &V) -> bool {
        *id == self.main || self.index(id).is_some()
    }
    fn index(&self, id: &V) -> Option<usize> {
        self.agents.iter().position(|a| a.id == *id)
    }
    fn effect(&mut self, kind: &str, fields: &[(&str, V)]) {
        let mut all = vec![("kind", txt(kind))];
        all.extend_from_slice(fields);
        self.effects.push(obj(&all));
    }
    fn publish(
        &mut self,
        subtype: &str,
        id: S,
        description: S,
        status: &str,
        kind: &str,
        heartbeat: bool,
    ) {
        if self.disposed {
            return;
        }
        let mut fields = vec![
            ("type", txt("system")),
            ("subtype", txt(&format!("codex_task_{subtype}"))),
            ("task_id", V::String(id)),
            (
                "description",
                V::String(safe_text(&V::String(description), 180)),
            ),
            ("status", txt(status)),
            ("kind", txt(kind)),
            ("active", V::Number(self.active_count() as f64)),
        ];
        if heartbeat {
            fields.push(("heartbeat", V::Bool(true)));
        }
        self.effect("emit", &[("event", obj(&fields))]);
    }
    fn task(&self, index: usize) -> S {
        string(&cat(&[txt("codex-agent:"), self.agents[index].id.clone()]))
    }
    fn cancel(&mut self, id: Option<u64>) {
        if let Some(id) = id {
            self.timers.retain(|t| t.id != id);
            self.effect("cancel", &[("id", V::Number(id as f64))]);
        }
    }
    fn schedule(&mut self, index: usize, kind: TimerKind, delay: f64) -> u64 {
        self.next += 1;
        let id = self.next;
        self.timers.push(Timer {
            id,
            agent: index,
            kind,
        });
        self.effect(
            "timer",
            &[("id", V::Number(id as f64)), ("delay", V::Number(delay))],
        );
        id
    }
    fn progress(&mut self, index: usize, text: V, force: bool) {
        if !self.agents[index].live {
            return;
        }
        let description = string(&cat(&[
            V::String(self.agents[index].label.clone()),
            txt(" · "),
            V::String(safe_text(&text, 180)),
        ]));
        let elapsed = self.now - self.agents[index].last;
        if !force && elapsed < self.throttle {
            self.agents[index].pending = text;
            if self.agents[index].progress.is_none() {
                let id = self.schedule(index, TimerKind::Progress, self.throttle - elapsed);
                self.agents[index].progress = Some(id);
            }
            return;
        }
        if !force && description == self.agents[index].description && elapsed < 30000.0 {
            return;
        }
        let timer = self.agents[index].progress.take();
        self.cancel(timer);
        self.agents[index].description = description.clone();
        self.agents[index].last = self.now;
        self.publish(
            "progress",
            self.task(index),
            description,
            "running",
            "agent",
            false,
        );
    }
    fn start(&mut self, index: usize) {
        let a = &mut self.agents[index];
        a.live = true;
        a.ended = false;
        a.last = f64::NEG_INFINITY;
        a.description = string(&cat(&[V::String(a.label.clone()), txt(" · 正在执行")]));
        let description = a.description.clone();
        self.publish(
            "started",
            self.task(index),
            description,
            "running",
            "agent",
            false,
        );
        let pulse = self.agents[index].pulse.take();
        self.cancel(pulse);
        let progress = self.agents[index].progress.take();
        self.cancel(progress);
        let pulse = self.schedule(index, TimerKind::Pulse, 30000.0);
        self.agents[index].pulse = Some(pulse);
    }
    fn finish(&mut self, index: usize, status: &V) {
        if !self.agents[index].live {
            return;
        }
        let Some(status) = end(status) else {
            return;
        };
        self.agents[index].live = false;
        self.agents[index].ended = true;
        for timer in [
            self.agents[index].attach.take(),
            self.agents[index].pulse.take(),
            self.agents[index].progress.take(),
        ] {
            self.cancel(timer);
        }
        let description = string(&cat(&[
            V::String(self.agents[index].label.clone()),
            txt(" · "),
            txt(outcome(status)),
        ]));
        self.publish(
            "done",
            self.task(index),
            description,
            status,
            "agent",
            false,
        );
    }
    fn discover(&mut self, id: V, parent: V, description: V, restart: bool) -> Option<usize> {
        if !yes(&id) || id == self.main || !self.known(&parent) {
            return None;
        }
        if let Some(index) = self.index(&id) {
            if restart && self.agents[index].ended {
                self.start(index);
            }
            return Some(index);
        }
        let title = safe_text(&description, 60);
        let mut label = S::from(format!("子任务 {}", self.agents.len() + 1));
        if !title.is_empty() {
            label.push_str("：");
            label.push(&title);
        }
        let index = self.agents.len();
        self.agents.push(Agent {
            id,
            label,
            live: false,
            ended: false,
            seen: false,
            active: V::Undefined,
            last: f64::NEG_INFINITY,
            description: S::new(),
            pending: V::Undefined,
            progress: None,
            pulse: None,
            attach: None,
        });
        self.start(index);
        let timer = self.schedule(index, TimerKind::Attach, 100.0);
        self.agents[index].attach = Some(timer);
        Some(index)
    }
    fn finish_tool(&mut self, key: &S, status: &str) {
        let Some(index) = self.tools.iter().position(|t| t.key == *key) else {
            return;
        };
        let tool = self.tools.remove(index);
        let description = string(&cat(&[
            V::String(tool.label),
            txt(" · "),
            txt(outcome(status)),
        ]));
        self.publish(
            "done",
            tool.id,
            description,
            end(&txt(status)).unwrap_or("interrupted"),
            "tool",
            false,
        );
    }
    pub fn consume(&mut self, message: &V, now: f64) -> V {
        self.now = now;
        let method = get(message, "method");
        let params = fallback(get(message, "params"), obj(&[]));
        let thread = fallback(get(&params, "thread"), obj(&[]));
        let id = fallback(
            get(&params, "threadId"),
            if is(&method, "thread/started") {
                get(&thread, "id")
            } else {
                V::Null
            },
        );
        let item = fallback(get(&params, "item"), obj(&[]));
        if is(&method, "thread/started") && yes(&get(&thread, "parentThreadId")) {
            self.discover(
                get(&thread, "id"),
                get(&thread, "parentThreadId"),
                fallback(get(&thread, "name"), get(&thread, "agentNickname")),
                false,
            );
        }
        if yes(&id) && !self.known(&id) {
            return obj(&[("child", V::Bool(true)), ("unrelated", V::Bool(true))]);
        }
        let agent = if yes(&id) { self.index(&id) } else { None };
        if let Some(index) = agent {
            self.agents[index].seen = true;
        }
        let item_event = is(&method, "item/started") || is(&method, "item/completed");
        if item_event && is(&get(&item, "type"), "collabAgentToolCall") {
            let parent = fallback(
                get(&item, "senderThreadId"),
                fallback(id.clone(), self.main.clone()),
            );
            if self.known(&parent) {
                let restart = ["resumeAgent", "followupTask", "sendInput"]
                    .iter()
                    .any(|s| is(&get(&item, "tool"), s));
                for receiver in array(&get(&item, "receiverThreadIds")) {
                    if !is(&get(&item, "tool"), "spawnAgent") && self.index(&receiver).is_none() {
                        continue;
                    }
                    if is(&get(&item, "tool"), "spawnAgent")
                        && !is(&get(&item, "status"), "completed")
                    {
                        continue;
                    }
                    self.discover(receiver, parent.clone(), get(&item, "prompt"), restart);
                }
                for (receiver, state) in entries(&get(&item, "agentsStates")) {
                    if let Some(index) = self.index(&V::String(receiver)) {
                        let status = get(&state, "status");
                        if end(&status).is_some() {
                            self.finish(index, &status);
                        } else if is(&status, "running") || is(&status, "pendingInit") {
                            self.progress(index, txt("正在执行"), false);
                        }
                    }
                }
            }
        }
        if item_event && is(&get(&item, "type"), "subAgentActivity") {
            let key = if yes(&get(&item, "id")) {
                Some(string(&cat(&[
                    id.clone(),
                    txt(":"),
                    get(&item, "id"),
                    txt(":"),
                    get(&item, "kind"),
                ])))
            } else {
                None
            };
            if key.as_ref().is_none_or(|k| !self.activities.contains(k)) {
                if let Some(key) = key {
                    self.activities.push(key);
                }
                if let Some(index) = self.discover(
                    get(&item, "agentThreadId"),
                    fallback(id.clone(), self.main.clone()),
                    get(&item, "agentPath"),
                    is(&get(&item, "kind"), "started"),
                ) {
                    let kind = get(&item, "kind");
                    if is(&kind, "completed") || is(&kind, "interrupted") {
                        self.finish(index, &kind);
                    }
                }
            }
        }
        let label = tool_label(&item);
        if is(&method, "item/started") && !label.is_empty() {
            if let Some(index) = agent {
                self.progress(index, V::String(label.clone()), true);
            } else if id == self.main && yes(&get(&item, "id")) {
                let key = string(&cat(&[id.clone(), txt(":"), get(&item, "id")]));
                if !self.tools.iter().any(|t| t.key == key) {
                    let label = string(&cat(&[txt("本轮工具 · "), V::String(label.clone())]));
                    let task = string(&cat(&[txt("codex-tool:"), V::String(key.clone())]));
                    self.tools.push(Tool {
                        key,
                        id: task.clone(),
                        label: label.clone(),
                        last: f64::NEG_INFINITY,
                    });
                    self.publish("started", task, label, "running", "tool", false);
                }
            }
        }
        if is(&method, "item/mcpToolCall/progress") {
            let text = V::String(safe_text(&get(&params, "message"), 180));
            let text = fallback(text, txt("工具仍在执行"));
            if let Some(index) = agent {
                self.progress(index, text, false);
            } else {
                let key = string(&cat(&[id.clone(), txt(":"), get(&params, "itemId")]));
                if let Some(index) = self.tools.iter().position(|t| t.key == key) {
                    if self.now - self.tools[index].last >= self.throttle {
                        self.tools[index].last = self.now;
                        let tool = &self.tools[index];
                        self.publish(
                            "progress",
                            tool.id.clone(),
                            string(&cat(&[V::String(tool.label.clone()), txt(" · "), text])),
                            "running",
                            "tool",
                            false,
                        );
                    }
                }
            }
        }
        if let Some(index) = agent {
            if string(&fallback(method.clone(), txt("")))
                .to_string_lossy()
                .ends_with("outputDelta")
            {
                self.progress(index, txt("工具仍在执行"), false);
            }
        }
        if is(&method, "item/completed") && !label.is_empty() {
            if let Some(index) = agent {
                let detail = tool_detail(&item);
                let outcome = if is(&get(&item, "status"), "failed") {
                    txt("工具执行失败，等待子任务结果")
                } else {
                    txt("工具执行结束")
                };
                let message = if detail.is_empty() {
                    outcome
                } else {
                    cat(&[outcome, txt(" · "), V::String(detail)])
                };
                self.progress(index, message, true);
            } else {
                let key = string(&cat(&[id.clone(), txt(":"), get(&item, "id")]));
                let status = if is(&get(&item, "status"), "failed")
                    || yes(&get(&item, "error"))
                    || (!matches!(get(&item, "exitCode"), V::Undefined | V::Null)
                        && js::js_to_number(&get(&item, "exitCode")) != 0.0)
                {
                    "failed"
                } else if is(&get(&item, "status"), "completed") {
                    "completed"
                } else {
                    "interrupted"
                };
                self.finish_tool(&key, status);
            }
        }
        if let Some(index) = agent {
            if is(&method, "turn/started") {
                self.agents[index].active = get(&get(&params, "turn"), "id");
                if self.agents[index].ended {
                    self.start(index);
                }
            }
        }
        if is(&method, "turn/completed") {
            if let Some(index) = agent {
                self.finish(index, &get(&get(&params, "turn"), "status"));
            } else if id == self.main || !yes(&id) {
                let keys = self.tools.iter().map(|t| t.key.clone()).collect::<Vec<_>>();
                for key in keys {
                    self.finish_tool(&key, "interrupted");
                }
            }
        }
        if let Some(index) = agent {
            if is(&method, "thread/closed")
                || is(&get(&get(&params, "status"), "type"), "systemError")
            {
                self.finish(index, &txt("interrupted"));
            }
        }
        obj(&[("child", V::Bool(agent.is_some()))])
    }
    pub fn fire(&mut self, id: u64, now: f64) {
        self.now = now;
        let Some(position) = self.timers.iter().position(|t| t.id == id) else {
            return;
        };
        let timer = self.timers.remove(position);
        let index = timer.agent;
        match timer.kind {
            TimerKind::Progress => {
                self.agents[index].progress = None;
                let text = self.agents[index].pending.clone();
                self.progress(index, text, false);
            }
            TimerKind::Pulse => {
                if self.disposed || !self.agents[index].live {
                    return;
                }
                self.publish(
                    "progress",
                    self.task(index),
                    self.agents[index].description.clone(),
                    "running",
                    "agent",
                    true,
                );
                let id = self.schedule(index, TimerKind::Pulse, 30000.0);
                self.agents[index].pulse = Some(id);
            }
            TimerKind::Attach => {
                if !self.disposed
                    && self.agents[index].live
                    && !self.agents[index].seen
                    && self.attach
                {
                    self.effect(
                        "attach",
                        &[
                            ("agent", V::Number(index as f64)),
                            ("id", self.agents[index].id.clone()),
                        ],
                    );
                }
            }
        }
    }
    pub fn attached(&mut self, index: usize, result: &V, failed: bool, now: f64) {
        self.now = now;
        if self.disposed || index >= self.agents.len() {
            return;
        }
        if failed {
            self.progress(index, txt("详细进度暂时不可用，等待子任务状态"), true);
            return;
        }
        let latest = get(result, "latestTurn");
        if is(&get(&get(&get(result, "thread"), "status"), "type"), "idle")
            && yes(&latest)
            && (!yes(&self.agents[index].active) || self.agents[index].active == get(&latest, "id"))
        {
            self.finish(index, &get(&latest, "status"));
        }
    }
    pub fn set_main(&mut self, id: V) {
        self.main = id;
    }
    pub fn dispose(&mut self) {
        self.disposed = true;
        let ids = self.timers.iter().map(|t| t.id).collect::<Vec<_>>();
        for id in ids {
            self.cancel(Some(id));
        }
        self.agents.clear();
        self.tools.clear();
    }
    pub fn effects(&mut self) -> Vec<V> {
        std::mem::take(&mut self.effects)
    }
}
