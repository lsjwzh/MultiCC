//! 路由状态机：每个上游 Chrome 一份。输入是「连接来了 / 走了 / 发来一帧」和
//! 「Chrome 发来一帧」，输出是要写给 Chrome 或某条连接的行。这里不做任何 IO，
//! 所以全部边界都能在单测里逐帧验证。
//!
//! 核心不变量：**调用方断开，对 Chrome 来说要等同于它自己的 WebSocket 断开。**
//!
//! 直连时 Chrome 在 WS 关闭时会自动 detach 这条连接上的所有 session、销毁
//! `disposeOnDetach` 的 browser context、丢掉 `setDiscoverTargets` / `setAutoAttach`
//! 等浏览器级状态。网关共用一条 WS，这些都不会自动发生 —— 调用方崩一次就在用户
//! 的日常 Chrome 里留下一堆还开着 Network 域的 session。所以每个 lane（一个逻辑
//! 调用方）先用 `Target.attachToBrowserTarget` 拿一个**自己的浏览器级会话**，lane 里
//! 的一切都挂在它下面；lane 结束时 detach 这一个会话，Chrome 自己级联清理。
//! 浏览器级状态和事件也因此天然按 lane 隔离，不用猜哪条事件属于谁。
//!
//! 其余规则：
//! - 响应按全局 id 精确送回发起的连接；找不到主人的响应丢弃，**绝不广播**
//!   （广播出去的全局 id 可能恰好撞上别人的待决 id）。
//! - 事件按 sessionId 归属只送给对应 lane；陌生 session 的事件丢弃。
//! - lane 只能使用自己的 session，不能借别人的 sessionId 操作别人的页面。
//! - target 租约：`createTarget` 的创建者、显式 `attachToTarget` 的 lane 独占该
//!   target；别的 lane 再 attach / closeTarget 立刻收到 `cdp-target-busy`。不排队：
//!   排队会让一条卡住的命令拖死所有会话，而调用方换一个新 tab 永远可行。
//!   自动 attach（setAutoAttach）是旁观，不占租约，也不受租约限制。
//! - `Browser.close` / `Browser.crash` 默认拦截：共享的是用户的日常 Chrome，
//!   Puppeteer 里 `close()` 和 `disconnect()` 写混是常见错误。
//!
//! Chrome 不支持 `attachToBrowserTarget` 时（很老的版本或非 Chrome 的 CDP 实现）
//! lane 退回 shared 模式：帧原样转发，根级事件与认不出归属的事件交给所有 shared
//! lane。功能可用，但失去上面的隔离，ready 消息里的 `mode` 会如实说明。

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use crate::wire;

pub type ConnId = u64;
type LaneId = u64;

/// 网关自己发的命令挂在这个 lane 名下（真实 lane 从 1 开始编号）。
const GATEWAY: LaneId = 0;

#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Chrome(String),
    Line(ConnId, String),
    /// 关闭连接。reason 对行协议连接是最后一行控制消息，对 WebSocket 入口是 close reason。
    Close(ConnId, Option<String>),
}

#[derive(Debug, Clone, Default)]
pub struct JoinOptions {
    /// 命名 lane 跨连接存活（一次性 CLI、每动作一个进程的脚本靠它保住 session）；
    /// None 表示匿名 lane，与这条连接同寿。
    pub lane: Option<String>,
    /// 命名 lane 最后一条连接离开后保留多久；0 表示立即结束。
    pub ttl_ms: u64,
    pub allow_browser_close: bool,
    /// 行协议连接：会收到 ready / 错误等控制消息。WebSocket 入口只收纯 CDP。
    pub control: bool,
}

#[derive(Debug, Clone, PartialEq)]
enum Root {
    Pending,
    Isolated(String),
    Shared,
}

struct Lane {
    name: Option<String>,
    root: Root,
    conns: HashSet<ConnId>,
    /// 根会话就绪前到达的帧，就绪后按原顺序补发。
    queue: Vec<(ConnId, Map<String, Value>)>,
    ttl_ms: u64,
    idle_since: Option<u64>,
}

struct Conn {
    lane: LaneId,
    control: bool,
    allow_browser_close: bool,
}

struct Session {
    lane: LaneId,
    parent: Option<String>,
    target: Option<String>,
}

struct Lease {
    lane: LaneId,
    /// 自己创建的 target 一直占着，直到它被销毁或 lane 结束；attach 来的只在
    /// 还有 session 连着时占着。
    created: bool,
}

enum Kind {
    Plain,
    Attach(String),
    Create,
    ChildSession,
    CreateContext,
    RootAttach,
    Internal,
}

struct Pending {
    conn: Option<ConnId>,
    lane: LaneId,
    original: Value,
    kind: Kind,
    /// 注入过的根 sessionId：响应里原样带回时要摘掉，调用方眼里它就是根。
    root: Option<String>,
}

pub struct Router {
    url: String,
    next_id: i64,
    next_lane: LaneId,
    conns: HashMap<ConnId, Conn>,
    lanes: HashMap<LaneId, Lane>,
    names: HashMap<String, LaneId>,
    sessions: HashMap<String, Session>,
    leases: HashMap<String, Lease>,
    contexts: HashMap<String, LaneId>,
    pending: HashMap<i64, Pending>,
}

const BROWSER_KILLERS: [&str; 3] = ["Browser.close", "Browser.crash", "Browser.crashGpuProcess"];

impl Router {
    pub fn new(url: &str) -> (Self, Vec<Out>) {
        let mut router = Self {
            url: url.to_string(),
            next_id: 1,
            next_lane: 1,
            conns: HashMap::new(),
            lanes: HashMap::new(),
            names: HashMap::new(),
            sessions: HashMap::new(),
            leases: HashMap::new(),
            contexts: HashMap::new(),
            pending: HashMap::new(),
        };
        let mut out = Vec::new();
        // 网关自己的根会话订阅 target 生灭，只用来回收租约；这些事件不转给任何 lane。
        router.internal(
            &mut out,
            "Target.setDiscoverTargets",
            json!({ "discover": true }),
            GATEWAY,
            Kind::Internal,
        );
        (router, out)
    }

    pub fn join(&mut self, conn: ConnId, options: JoinOptions, now: u64) -> Vec<Out> {
        let mut out = Vec::new();
        let named = options
            .lane
            .as_ref()
            .and_then(|name| self.names.get(name).copied());
        let lane_id = match named {
            Some(id) => id,
            None => {
                let id = self.next_lane;
                self.next_lane += 1;
                self.lanes.insert(
                    id,
                    Lane {
                        name: options.lane.clone(),
                        root: Root::Pending,
                        conns: HashSet::new(),
                        queue: Vec::new(),
                        ttl_ms: options.ttl_ms,
                        idle_since: None,
                    },
                );
                if let Some(name) = &options.lane {
                    self.names.insert(name.clone(), id);
                }
                self.internal(
                    &mut out,
                    "Target.attachToBrowserTarget",
                    json!({}),
                    id,
                    Kind::RootAttach,
                );
                id
            }
        };
        let lane = self.lanes.get_mut(&lane_id).expect("lane exists");
        lane.conns.insert(conn);
        lane.idle_since = None;
        if options.lane.is_some() {
            lane.ttl_ms = options.ttl_ms;
        }
        let _ = now;
        let ready = lane.root != Root::Pending;
        self.conns.insert(
            conn,
            Conn {
                lane: lane_id,
                control: options.control,
                allow_browser_close: options.allow_browser_close,
            },
        );
        if ready {
            self.push_ready(conn, &mut out);
        }
        out
    }

    pub fn leave(&mut self, conn: ConnId, now: u64) -> Vec<Out> {
        let mut out = Vec::new();
        let Some(gone) = self.conns.remove(&conn) else {
            return out;
        };
        for pending in self.pending.values_mut() {
            if pending.conn == Some(conn) {
                pending.conn = None; // 副作用照常处理，回复丢弃
            }
        }
        let Some(lane) = self.lanes.get_mut(&gone.lane) else {
            return out;
        };
        lane.conns.remove(&conn);
        lane.queue.retain(|(owner, _)| *owner != conn);
        if lane.conns.is_empty() {
            if lane.name.is_none() || lane.ttl_ms == 0 {
                self.close_lane(gone.lane, None, &mut out);
            } else {
                lane.idle_since = Some(now);
            }
        }
        out
    }

    /// 结束闲置超过 TTL 的命名 lane。
    pub fn expire(&mut self, now: u64) -> Vec<Out> {
        let due: Vec<LaneId> = self
            .lanes
            .iter()
            .filter(|(_, lane)| {
                lane.conns.is_empty()
                    && lane
                        .idle_since
                        .is_some_and(|since| now.saturating_sub(since) >= lane.ttl_ms)
            })
            .map(|(id, _)| *id)
            .collect();
        let mut out = Vec::new();
        for id in due {
            self.close_lane(id, None, &mut out);
        }
        out
    }

    /// 显式结束一个命名 lane（还连着的连接一并关闭）。
    pub fn release(&mut self, name: &str) -> (bool, Vec<Out>) {
        let mut out = Vec::new();
        let Some(id) = self.names.get(name).copied() else {
            return (false, out);
        };
        let reason = wire::error_body("cdp-lane-released", name);
        self.close_lane(id, Some(reason), &mut out);
        (true, out)
    }

    pub fn has_lanes(&self) -> bool {
        !self.lanes.is_empty()
    }

    pub fn from_conn(&mut self, conn: ConnId, text: &str) -> Vec<Out> {
        let mut out = Vec::new();
        if !self.conns.contains_key(&conn) {
            return out;
        }
        match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => self.client_frame(conn, map, &mut out),
            _ => out.push(Out::Line(
                conn,
                json!({ "error": { "code": -32700, "message": "Message must be a JSON object" } })
                    .to_string(),
            )),
        }
        out
    }

    pub fn from_chrome(&mut self, text: &str) -> Vec<Out> {
        let mut out = Vec::new();
        let Ok(Value::Object(map)) = serde_json::from_str::<Value>(text) else {
            return out;
        };
        if let Some(id) = map.get("id").and_then(Value::as_i64) {
            if let Some(pending) = self.pending.remove(&id) {
                self.on_response(pending, map, &mut out);
            }
            return out;
        }
        self.on_event(map, &mut out);
        out
    }

    pub fn snapshot(&self) -> Value {
        let lanes: Vec<Value> = self
            .lanes
            .iter()
            .map(|(id, lane)| {
                json!({
                    "lane": lane.name.clone().unwrap_or_else(|| format!("#{id}")),
                    "named": lane.name.is_some(),
                    "mode": match lane.root { Root::Pending => "pending", Root::Isolated(_) => "isolated", Root::Shared => "shared" },
                    "conns": lane.conns.len(),
                    "sessions": self.sessions.values().filter(|s| s.lane == *id).count(),
                    "targets": self.leases.iter().filter(|(_, l)| l.lane == *id).map(|(t, _)| t.clone()).collect::<Vec<_>>(),
                    "idleMs": lane.idle_since.map(|since| crate::log::now_ms().saturating_sub(since)),
                })
            })
            .collect();
        json!({ "lanes": lanes, "pending": self.pending.len() })
    }

    // ---- 调用方 → Chrome ----

    fn client_frame(&mut self, conn: ConnId, mut map: Map<String, Value>, out: &mut Vec<Out>) {
        let Some(info) = self.conns.get(&conn) else {
            return;
        };
        let lane_id = info.lane;
        let allow_close = info.allow_browser_close;
        let original = map.get("id").cloned().unwrap_or(Value::Null);
        if original.as_i64().is_none() {
            // 没有整数 id 的帧 Chrome 会回一个没有 id 的错误，那会被当成事件；在这里就挡掉。
            out.push(Out::Line(
                conn,
                wire::cdp_error(&original, -32600, "Message must have integer 'id' property"),
            ));
            return;
        }
        let Some(method) = map.get("method").and_then(Value::as_str).map(str::to_owned) else {
            out.push(Out::Line(
                conn,
                wire::cdp_error(
                    &original,
                    -32600,
                    "Message must have string 'method' property",
                ),
            ));
            return;
        };
        let session = map
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(sid) = &session {
            if self.sessions.get(sid).map(|s| s.lane) != Some(lane_id) {
                out.push(Out::Line(
                    conn,
                    wire::cdp_error(&original, -32001, "Session with given id not found."),
                ));
                return;
            }
        }
        let Some(lane) = self.lanes.get_mut(&lane_id) else {
            return;
        };
        if session.is_none() && lane.root == Root::Pending {
            lane.queue.push((conn, map));
            return;
        }
        if !allow_close && BROWSER_KILLERS.contains(&method.as_str()) {
            let message = format!(
                "multicc-cdpd: {method} refused: this Chrome is shared with other clients (often the user's own browser). \
                 Close your own targets or disconnect instead; connect with allowBrowserClose to override."
            );
            out.push(Out::Line(
                conn,
                wire::cdp_error(&original, -32000, &message),
            ));
            return;
        }
        let params = map.get("params").cloned().unwrap_or(Value::Null);
        let kind = match self.admit(lane_id, &method, &params) {
            Ok(kind) => kind,
            Err(message) => {
                out.push(Out::Line(
                    conn,
                    wire::cdp_error(&original, -32000, &message),
                ));
                return;
            }
        };
        let mut root = None;
        if session.is_none() {
            if let Some(Root::Isolated(sid)) = self.lanes.get(&lane_id).map(|l| &l.root) {
                map.insert("sessionId".into(), json!(sid));
                root = Some(sid.clone());
            }
        }
        let id = self.alloc_id();
        map.insert("id".into(), json!(id));
        self.pending.insert(
            id,
            Pending {
                conn: Some(conn),
                lane: lane_id,
                original,
                kind,
                root,
            },
        );
        out.push(Out::Chrome(Value::Object(map).to_string()));
    }

    /// 租约与归属检查；Ok 里带上响应回来时要做的记账。
    fn admit(&mut self, lane: LaneId, method: &str, params: &Value) -> Result<Kind, String> {
        let target = params.get("targetId").and_then(Value::as_str);
        match method {
            "Target.attachToTarget" => match target {
                Some(target) => {
                    self.check_free(lane, target)?;
                    // 先占上：两个 lane 同时 attach 同一个 tab，后到的立刻 busy，而不是两个都成功。
                    self.leases.entry(target.to_owned()).or_insert(Lease {
                        lane,
                        created: false,
                    });
                    Ok(Kind::Attach(target.to_owned()))
                }
                None => Ok(Kind::Plain),
            },
            "Target.closeTarget" => {
                if let Some(target) = target {
                    self.check_free(lane, target)?;
                }
                Ok(Kind::Plain)
            }
            "Target.createTarget" => Ok(Kind::Create),
            "Target.attachToBrowserTarget" => Ok(Kind::ChildSession),
            "Target.createBrowserContext" => Ok(Kind::CreateContext),
            "Target.disposeBrowserContext" => {
                let context = params
                    .get("browserContextId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                match self.contexts.get(context) {
                    Some(owner) if *owner != lane => Err(format!(
                        "cdp-target-busy: browser context {context} belongs to another multicc-cdpd client{}",
                        self.lane_label(*owner)
                    )),
                    _ => Ok(Kind::Plain),
                }
            }
            "Target.detachFromTarget" => {
                if let Some(sid) = params.get("sessionId").and_then(Value::as_str) {
                    if self.sessions.get(sid).map(|s| s.lane) != Some(lane) {
                        return Err("Session with given id not found.".into());
                    }
                }
                Ok(Kind::Plain)
            }
            _ => Ok(Kind::Plain),
        }
    }

    fn check_free(&self, lane: LaneId, target: &str) -> Result<(), String> {
        match self.leases.get(target) {
            Some(lease) if lease.lane != lane => Err(format!(
                "cdp-target-busy: target {target} is in use by another multicc-cdpd client{}; open your own tab instead",
                self.lane_label(lease.lane)
            )),
            _ => Ok(()),
        }
    }

    fn lane_label(&self, lane: LaneId) -> String {
        match self.lanes.get(&lane).and_then(|l| l.name.as_ref()) {
            Some(name) => format!(" (lane {name})"),
            None => String::new(),
        }
    }

    // ---- Chrome → 调用方 ----

    fn on_response(&mut self, pending: Pending, mut map: Map<String, Value>, out: &mut Vec<Out>) {
        let result = map.get("result").cloned();
        let field = |key: &str| {
            result
                .as_ref()
                .and_then(|r| r.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let alive = self.lanes.contains_key(&pending.lane);
        match &pending.kind {
            Kind::RootAttach => {
                self.on_root_attached(pending.lane, field("sessionId"), out);
                return;
            }
            Kind::Internal => return,
            Kind::Attach(target) => match field("sessionId") {
                Some(sid) if alive => self.adopt(sid, pending.lane, Some(target.clone())),
                // lane 在等响应期间就结束了：这个 session 没人要，立刻还给 Chrome。
                Some(sid) => self.detach(&sid, out),
                None => self.release_if_unused(target),
            },
            Kind::ChildSession => match field("sessionId") {
                Some(sid) if alive => self.adopt(sid, pending.lane, None),
                Some(sid) => self.detach(&sid, out),
                None => {}
            },
            Kind::Create => {
                if let Some(target) = field("targetId") {
                    if alive {
                        self.leases.insert(
                            target,
                            Lease {
                                lane: pending.lane,
                                created: true,
                            },
                        );
                    }
                }
            }
            Kind::CreateContext => match field("browserContextId") {
                Some(context) if alive => {
                    self.contexts.insert(context, pending.lane);
                }
                Some(context) => self.internal(
                    out,
                    "Target.disposeBrowserContext",
                    json!({ "browserContextId": context }),
                    GATEWAY,
                    Kind::Internal,
                ),
                None => {}
            },
            Kind::Plain => {}
        }
        let Some(conn) = pending.conn.filter(|conn| self.conns.contains_key(conn)) else {
            return;
        };
        map.insert("id".into(), pending.original);
        if pending.root.is_some()
            && map.get("sessionId").and_then(Value::as_str) == pending.root.as_deref()
        {
            map.remove("sessionId");
        }
        out.push(Out::Line(conn, Value::Object(map).to_string()));
    }

    fn on_root_attached(&mut self, lane_id: LaneId, sid: Option<String>, out: &mut Vec<Out>) {
        let Some(lane) = self.lanes.get_mut(&lane_id) else {
            // lane 在等根会话期间就走了。
            if let Some(sid) = sid {
                self.detach(&sid, out);
            }
            return;
        };
        match sid {
            Some(sid) => {
                lane.root = Root::Isolated(sid.clone());
                self.sessions.insert(
                    sid,
                    Session {
                        lane: lane_id,
                        parent: None,
                        target: None,
                    },
                );
            }
            None => {
                lane.root = Root::Shared;
                crate::log!(
                    "[{}] Target.attachToBrowserTarget unsupported; lane runs in shared mode",
                    self.url
                );
            }
        }
        let lane = self.lanes.get_mut(&lane_id).expect("lane exists");
        let conns: Vec<ConnId> = lane.conns.iter().copied().collect();
        let queue = std::mem::take(&mut lane.queue);
        for conn in conns {
            self.push_ready(conn, out);
        }
        for (conn, map) in queue {
            self.client_frame(conn, map, out);
        }
    }

    fn on_event(&mut self, mut map: Map<String, Value>, out: &mut Vec<Out>) {
        let method = map
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let params = map.get("params").cloned().unwrap_or(Value::Null);
        let Some(sid) = map
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            self.on_root_event(&method, &params);
            self.deliver_shared(&Value::Object(map).to_string(), out);
            return;
        };
        let Some(lane_id) = self.sessions.get(&sid).map(|s| s.lane) else {
            // 认不出归属：只可能来自 shared lane 的自动 attach（isolated lane 的每个
            // session 都挂在已知父会话下）。
            self.deliver_shared(&Value::Object(map).to_string(), out);
            return;
        };
        let child = params
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        match (method.as_str(), child) {
            ("Target.attachedToTarget", Some(child)) => {
                let target = params
                    .get("targetInfo")
                    .and_then(|info| info.get("targetId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.sessions.entry(child).or_insert(Session {
                    lane: lane_id,
                    parent: Some(sid.clone()),
                    target,
                });
            }
            ("Target.detachedFromTarget", Some(child)) => self.drop_session_tree(&child),
            _ => {}
        }
        if matches!(self.lanes.get(&lane_id).map(|l| &l.root), Some(Root::Isolated(root)) if *root == sid)
        {
            map.remove("sessionId");
        }
        self.deliver(lane_id, &Value::Object(map).to_string(), out);
    }

    /// 网关根会话上的事件：只用来回收租约、发现 lane 的根会话被 Chrome 收走。
    fn on_root_event(&mut self, method: &str, params: &Value) {
        match method {
            "Target.targetDestroyed" => {
                if let Some(target) = params.get("targetId").and_then(Value::as_str) {
                    self.leases.remove(target);
                }
            }
            "Target.detachedFromTarget" => {
                if let Some(sid) = params.get("sessionId").and_then(Value::as_str) {
                    let owner = self
                        .sessions
                        .get(sid)
                        .filter(|s| s.parent.is_none())
                        .map(|s| s.lane);
                    self.drop_session_tree(sid);
                    if let Some(lane) = owner.and_then(|id| self.lanes.get_mut(&id)) {
                        if lane.root == Root::Isolated(sid.to_owned()) {
                            // 根会话没了，lane 里的状态已全部失效，只能当作 shared 继续。
                            crate::log!(
                                "[{}] a lane root session was detached by Chrome",
                                self.url
                            );
                            lane.root = Root::Shared;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // ---- 记账 ----

    fn adopt(&mut self, sid: String, lane: LaneId, target: Option<String>) {
        let session = self.sessions.entry(sid).or_insert(Session {
            lane,
            parent: None,
            target: None,
        });
        if session.target.is_none() {
            session.target = target;
        }
    }

    fn drop_session_tree(&mut self, sid: &str) {
        let mut doomed = vec![sid.to_owned()];
        let mut index = 0;
        while index < doomed.len() {
            let parent = doomed[index].clone();
            doomed.extend(
                self.sessions
                    .iter()
                    .filter(|(_, s)| s.parent.as_deref() == Some(parent.as_str()))
                    .map(|(id, _)| id.clone()),
            );
            index += 1;
        }
        let mut targets = Vec::new();
        for id in doomed {
            if let Some(session) = self.sessions.remove(&id) {
                targets.extend(session.target);
            }
        }
        for target in targets {
            self.release_if_unused(&target);
        }
    }

    fn release_if_unused(&mut self, target: &str) {
        let Some(lease) = self.leases.get(target) else {
            return;
        };
        if lease.created {
            return;
        }
        let lane = lease.lane;
        let attached = self
            .sessions
            .values()
            .any(|s| s.lane == lane && s.target.as_deref() == Some(target));
        let attaching = self
            .pending
            .values()
            .any(|p| p.lane == lane && matches!(&p.kind, Kind::Attach(t) if t == target));
        if !attached && !attaching {
            self.leases.remove(target);
        }
    }

    fn close_lane(&mut self, id: LaneId, reason: Option<String>, out: &mut Vec<Out>) {
        let Some(lane) = self.lanes.remove(&id) else {
            return;
        };
        if let Some(name) = &lane.name {
            self.names.remove(name);
        }
        for conn in &lane.conns {
            self.conns.remove(conn);
            out.push(Out::Close(*conn, reason.clone()));
        }
        match &lane.root {
            // 一条 detach，Chrome 级联收走子会话和 disposeOnDetach 的 context。
            Root::Isolated(sid) => self.detach(&sid.clone(), out),
            Root::Shared => {
                let tops: Vec<String> = self
                    .sessions
                    .iter()
                    .filter(|(_, s)| {
                        s.lane == id
                            && s.parent
                                .as_ref()
                                .is_none_or(|p| self.sessions.get(p).is_none_or(|ps| ps.lane != id))
                    })
                    .map(|(sid, _)| sid.clone())
                    .collect();
                for sid in tops {
                    self.detach(&sid, out);
                }
                let contexts: Vec<String> = self
                    .contexts
                    .iter()
                    .filter(|(_, owner)| **owner == id)
                    .map(|(c, _)| c.clone())
                    .collect();
                for context in contexts {
                    self.internal(
                        out,
                        "Target.disposeBrowserContext",
                        json!({ "browserContextId": context }),
                        GATEWAY,
                        Kind::Internal,
                    );
                }
            }
            // RootAttach 的响应回来时发现 lane 已不在，会补发 detach。
            Root::Pending => {}
        }
        self.sessions.retain(|_, s| s.lane != id);
        self.leases.retain(|_, l| l.lane != id);
        self.contexts.retain(|_, owner| *owner != id);
        for pending in self.pending.values_mut() {
            if pending.lane == id {
                pending.conn = None;
            }
        }
    }

    fn detach(&mut self, sid: &str, out: &mut Vec<Out>) {
        self.internal(
            out,
            "Target.detachFromTarget",
            json!({ "sessionId": sid }),
            GATEWAY,
            Kind::Internal,
        );
    }

    fn internal(
        &mut self,
        out: &mut Vec<Out>,
        method: &str,
        params: Value,
        lane: LaneId,
        kind: Kind,
    ) {
        let id = self.alloc_id();
        let frame = json!({ "id": id, "method": method, "params": params });
        self.pending.insert(
            id,
            Pending {
                conn: None,
                lane,
                original: Value::Null,
                kind,
                root: None,
            },
        );
        out.push(Out::Chrome(frame.to_string()));
    }

    /// Chrome 按 int32 解析 id：到顶回绕，跳过仍在等响应的。
    fn alloc_id(&mut self) -> i64 {
        loop {
            let id = self.next_id;
            self.next_id = if id >= i64::from(i32::MAX) { 1 } else { id + 1 };
            if !self.pending.contains_key(&id) {
                return id;
            }
        }
    }

    fn push_ready(&self, conn: ConnId, out: &mut Vec<Out>) {
        let Some(info) = self.conns.get(&conn) else {
            return;
        };
        if !info.control {
            return;
        }
        let Some(lane) = self.lanes.get(&info.lane) else {
            return;
        };
        let mode = if matches!(lane.root, Root::Shared) {
            "shared"
        } else {
            "isolated"
        };
        let line = json!({ "ok": true, "phase": "ready", "wsUrl": self.url, "lane": lane.name, "mode": mode });
        out.push(Out::Line(conn, line.to_string()));
    }

    fn deliver(&self, lane: LaneId, line: &str, out: &mut Vec<Out>) {
        if let Some(lane) = self.lanes.get(&lane) {
            for conn in &lane.conns {
                out.push(Out::Line(*conn, line.to_string()));
            }
        }
    }

    fn deliver_shared(&self, line: &str, out: &mut Vec<Out>) {
        for (id, lane) in &self.lanes {
            if lane.root == Root::Shared {
                self.deliver(*id, line, out);
            }
        }
    }
}

#[cfg(test)]
#[path = "router_tests.rs"]
mod tests;
