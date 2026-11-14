//! 常驻任务板：宿主只上送变更，规则在常驻副本上就地执行，只回传差分。
//!
//! 一致性约定：`shadow` 记着宿主镜像当前持有的每个条目指纹与键序。上送先写入
//! 常驻副本并同步指纹；可变规则执行后与指纹比对得出差分，宿主按差分回填后两侧
//! 重新一致。规则报错或 panic 时常驻副本可能半改：不更新指纹，只列出改动过的
//! 条目，由宿主用自己手里（规则执行前）的副本重新上送覆盖，等价旧的整板克隆语义。
use super::host::{Dates, Host, Order};
use super::*;
use serde_json::Map;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

const KINDS: [&str; 3] = ["tasks", "modules", "taskGroups"];

#[derive(Default)]
struct Shadow {
    hashes: [HashMap<String, u64>; 3],
    keys: [Vec<String>; 3],
    root: HashMap<String, u64>,
}

#[derive(Default)]
struct Changes {
    set: [Vec<String>; 3],
    del: [Vec<String>; 3],
    order: [bool; 3],
    hashes: [HashMap<String, u64>; 3],
    root_set: Vec<String>,
    root_del: Vec<String>,
    root_hashes: HashMap<String, u64>,
}

impl Changes {
    fn any(&self) -> bool {
        (0..KINDS.len())
            .any(|k| !self.set[k].is_empty() || !self.del[k].is_empty() || self.order[k])
            || !self.root_set.is_empty()
            || !self.root_del.is_empty()
    }
    /// 失败时交给宿主重新上送的条目清单（宿主有就覆盖，没有就删除）。
    fn touched(&self) -> Value {
        let mut out = Map::new();
        for (k, name) in KINDS.iter().enumerate() {
            let ids: Vec<&String> = self.set[k].iter().chain(&self.del[k]).collect();
            if !ids.is_empty() || self.order[k] {
                out.insert((*name).into(), json!({"ids":ids,"order":self.order[k]}));
            }
        }
        let root: Vec<&String> = self.root_set.iter().chain(&self.root_del).collect();
        if !root.is_empty() {
            out.insert("root".into(), json!(root));
        }
        Value::Object(out)
    }
}

#[derive(Default)]
pub struct BoardState {
    board: Value,
    shadow: Shadow,
    dates: Dates,
    task_order: Order,
    group_order: Order,
    version: u64,
    verify_reads: bool,
    stale: bool,
    disk: Option<repository::DiskStamp>,
}

// 数值按 JS 双精度语义比较：4 与 4.0 是同一个值；超出 2^53 的整数保留原值。
fn number_key(n: &serde_json::Number) -> (u8, u64) {
    const SAFE: u64 = 1 << 53;
    if let Some(u) = n.as_u64() {
        if u > SAFE {
            return (1, u);
        }
    }
    if let Some(i) = n.as_i64() {
        if i < -(SAFE as i64) {
            return (2, i as u64);
        }
    }
    let f = n.as_f64().unwrap_or(0.0);
    (0, if f == 0.0 { 0 } else { f.to_bits() })
}
fn feed(v: &Value, h: &mut DefaultHasher) {
    match v {
        Value::Null => 0u8.hash(h),
        Value::Bool(b) => (1u8, b).hash(h),
        Value::Number(n) => (2u8, number_key(n)).hash(h),
        Value::String(s) => (3u8, s).hash(h),
        Value::Array(a) => {
            (4u8, a.len()).hash(h);
            a.iter().for_each(|x| feed(x, h));
        }
        Value::Object(o) => {
            (5u8, o.len()).hash(h);
            for (k, x) in o {
                k.hash(h);
                feed(x, h);
            }
        }
    }
}
fn fp(v: &Value) -> u64 {
    let mut h = DefaultHasher::new();
    feed(v, &mut h);
    h.finish()
}
/// 校验用：数值按双精度、对象键序无关（宿主回填保留旧键位置，键序天然可能不同）。
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => number_key(x) == number_key(y),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}
fn root_entries(board: &Value) -> impl Iterator<Item = (&String, &Value)> {
    board
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(k, _)| !KINDS.contains(&k.as_str()))
}
/// 宿主漏列的键保持原相对顺序追加在后面。
fn reorder(map: &mut Map<String, Value>, order: &[Value]) {
    let old = std::mem::take(map);
    let keys: Vec<String> = old.keys().cloned().collect();
    let mut pool: HashMap<String, Value> = old.into_iter().collect();
    for id in order.iter().filter_map(Value::as_str) {
        if let Some(v) = pool.remove(id) {
            map.insert(id.to_string(), v);
        }
    }
    for k in keys {
        if let Some(v) = pool.remove(&k) {
            map.insert(k, v);
        }
    }
}
/// 是否需要比对差分。拿不准的一律按可变处理：多一次指纹比对只费时间，
/// 漏判则两侧分叉（测试模式 verifyReads 会把漏判抓成 readonlyMutated）。
fn mutating(v: &Value) -> bool {
    let action = text(&v["action"]);
    match text(&v["op"]) {
        "board" => action == "lifecycle",
        "planning" => ![
            "normalizePriority",
            "normalizeDueAt",
            "normalizeRank",
            "planningRevision",
            "recordTypeForTask",
            "planningFields",
            "validateExpectedRevision",
            "plannedTasksInStage",
            "rankAtEnd",
            "rankForMove",
        ]
        .contains(&action),
        "classification" => {
            !["parseTagResult", "parseBackfillResult", "findTaskByTitle"].contains(&action)
        }
        "normalize" => ["reconcileTaskGroups", "groupRelatedTasks"].contains(&action),
        _ => false,
    }
}
// 各规则沿用无状态调用时宿主传的那份序：planning 是全部任务 id，normalize /
// classification / view 是任务组 id；retention 自带候选序。
fn dispatch(
    b: &mut Value,
    dates: &Dates,
    tasks: &Order,
    groups: &Order,
    v: &Value,
) -> Result<Value, String> {
    let with = |order| Host { dates, order };
    match text(&v["op"]) {
        "board" => board::apply(b, v),
        "planning" => planning::apply(b, v, with(tasks)),
        "classification" => Ok(classification::apply(b, v, with(groups))),
        "normalize" => Ok(normalize::apply(b, v, with(groups))),
        "view" => Ok(view::apply(b, v, with(groups))),
        "retention" => {
            let given = Order::from_ids(&v["idOrder"]);
            Ok(retention::apply(b, v, with(&given)))
        }
        "airVisible" => Ok(json!(air::visible(b, &v["shellTasks"])
            .iter()
            .map(|t| t["id"].clone())
            .collect::<Vec<_>>())),
        "airInputs" => Ok(air::run_on(b, v)),
        "deletedAmong" => Ok(json!(deleted::among(b, &v["ids"]))),
        _ => Err("TASK_BOARD_UNSUPPORTED_OP".into()),
    }
}
fn parse(input: &str, code: &str) -> Result<Value, String> {
    crate::json_lenient::from_str(input).map_err(|_| code.to_string())
}

impl BoardState {
    pub fn board(&self) -> &Value {
        &self.board
    }
    /// 常驻副本每变一次就递增；派生缓存（卡片输入）按它失效。
    pub fn version(&self) -> u64 {
        self.version
    }
    /// 宿主镜像与常驻副本是否已不可信（上送中途失败、锁中毒）：下次必须整板上送。
    pub fn mark_stale(&mut self) {
        self.stale = true;
        self.version += 1;
    }
    pub fn is_stale(&self) -> bool {
        self.stale
    }

    /// 规范化宿主读到的原始板并常驻；返回规范化结果给宿主建镜像。
    pub fn open(&mut self, input: &str) -> Result<String, String> {
        let v = parse(input, "invalid_task_board_open")?;
        let facts = host::Facts::of(&v);
        self.board = normalize::normalize(&v["raw"], facts.host());
        self.dates = facts.dates;
        self.task_order = Order::default();
        self.group_order = Order::default();
        self.verify_reads = v["verifyReads"] == true;
        self.stale = false;
        self.rebuild();
        self.version += 1;
        Ok(self.board.to_string())
    }

    pub fn apply(&mut self, input: &str) -> Result<String, String> {
        let mut v = parse(input, "invalid_task_board_input")?;
        self.sync(&mut v["sync"])?;
        let command = std::mem::take(&mut v["command"]);
        if command.is_null() {
            return Ok(json!({"ok":true,"version":self.version}).to_string());
        }
        self.dates.extend(&command["dates"], true);
        let writes = mutating(&command);
        let (board, dates, tasks, groups) = (
            &mut self.board,
            &self.dates,
            &self.task_order,
            &self.group_order,
        );
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            dispatch(board, dates, tasks, groups, &command)
        }));
        let reply = match outcome {
            Ok(Ok(out)) => {
                let diff = if writes || self.verify_reads {
                    self.diff()
                } else {
                    Value::Null
                };
                let readonly_mutated = !writes && !diff.is_null();
                json!({"ok":true,"out":out,"diff":diff,"readonlyMutated":readonly_mutated})
            }
            Ok(Err(error)) => self.failure(error),
            Err(_) => self.failure("TASK_DOMAIN_PANIC".into()),
        };
        Ok(reply.to_string())
    }

    /// 异步只读：在工作线程执行，宿主须先同步上送；可变规则一律拒绝（差分晚到会
    /// 覆盖宿主期间的新写入）。
    pub fn apply_read(&mut self, input: &str) -> Result<String, String> {
        let v = parse(input, "invalid_task_board_input")?;
        if self.stale {
            return Err("TASK_BOARD_RESYNC_REQUIRED".into());
        }
        if !v["sync"].is_null() || mutating(&v["command"]) {
            return Err("TASK_BOARD_ASYNC_WRITE".into());
        }
        let (board, dates, tasks, groups) = (
            &mut self.board,
            &self.dates,
            &self.task_order,
            &self.group_order,
        );
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            dispatch(board, dates, tasks, groups, &v["command"])
        }));
        if self.verify_reads && self.changes().any() {
            self.mark_stale();
            return Err("TASK_BOARD_READONLY_MUTATED".into());
        }
        match outcome {
            Ok(Ok(out)) => Ok(json!({"ok":true,"out":out}).to_string()),
            Ok(Err(error)) => Ok(json!({"ok":false,"error":error}).to_string()),
            Err(_) => {
                // 只读规则 panic 也可能半改；无法让宿主同步补救，只能整板重同步。
                if self.changes().any() {
                    self.mark_stale();
                }
                Ok(json!({"ok":false,"error":"TASK_DOMAIN_PANIC"}).to_string())
            }
        }
    }

    /// 落盘常驻副本（宿主负责 revision 递增）。IO 失败以 ok:false 返回，
    /// 上送已生效，宿主不必整板重同步。
    pub fn persist(&mut self, input: &str) -> Result<String, String> {
        let mut v = parse(input, "invalid_task_board_input")?;
        self.sync(&mut v["sync"])?;
        let saved = repository::save_board_stamped(
            Path::new(text(&v["file"])),
            &mut self.board,
            v.get("expectedRevision").filter(|r| !r.is_null()),
            v["onConflict"] == "preserve",
            &mut self.disk,
        );
        // 冲突保全会把 revision 改成磁盘+1：只可能产生根键差分。
        let diff = self.diff();
        Ok(match saved {
            Ok(result) => json!({"ok":true,"result":result,"diff":diff}),
            Err(error) => json!({"ok":false,"error":error,"diff":diff}),
        }
        .to_string())
    }

    pub fn snapshot(&mut self, input: &str) -> Result<String, String> {
        let mut v = parse(input, "invalid_task_board_input")?;
        self.sync(&mut v["sync"])?;
        Ok(self.board.to_string())
    }

    /// 与宿主整板逐条比对（数值按双精度、条目内键序无关），列出分叉的条目。
    pub fn verify(&mut self, input: &str) -> Result<String, String> {
        let mut v = parse(input, "invalid_task_board_input")?;
        self.sync(&mut v["sync"])?;
        let theirs = &v["board"];
        let empty = Map::new();
        let mut drift = Map::new();
        for name in KINDS {
            let a = self.board[name].as_object().unwrap_or(&empty);
            let b = theirs[name].as_object().unwrap_or(&empty);
            let mut ids: Vec<&String> = a
                .iter()
                .filter(|(id, x)| !b.get(*id).is_some_and(|y| same(x, y)))
                .map(|(id, _)| id)
                .collect();
            ids.extend(b.keys().filter(|id| !a.contains_key(*id)));
            let order = !a.keys().eq(b.keys());
            if !ids.is_empty() || order {
                drift.insert(name.into(), json!({"ids":ids,"order":order}));
            }
        }
        let mine: Vec<(&String, &Value)> = root_entries(&self.board).collect();
        let host: Vec<(&String, &Value)> = root_entries(theirs).collect();
        let mut root: Vec<&String> = mine
            .iter()
            .filter(|(k, x)| !host.iter().any(|(j, y)| j == k && same(x, y)))
            .map(|(k, _)| *k)
            .collect();
        root.extend(
            host.iter()
                .filter(|(k, _)| !mine.iter().any(|(j, _)| j == k))
                .map(|(k, _)| *k),
        );
        if !root.is_empty() {
            drift.insert("root".into(), json!(root));
        }
        Ok(json!({"ok":drift.is_empty(),"drift":drift}).to_string())
    }

    fn failure(&mut self, error: String) -> Value {
        let changes = self.changes();
        if changes.any() {
            self.version += 1;
        }
        json!({"ok":false,"error":error,"restore":changes.touched()})
    }

    fn sync(&mut self, s: &mut Value) -> Result<(), String> {
        if s.is_null() {
            return if self.stale {
                Err("TASK_BOARD_RESYNC_REQUIRED".into())
            } else {
                Ok(())
            };
        }
        match catch_unwind(AssertUnwindSafe(|| self.sync_inner(s))) {
            Ok(Ok(changed)) => {
                if changed {
                    self.version += 1;
                }
                Ok(())
            }
            Ok(Err(error)) => {
                self.mark_stale();
                Err(error)
            }
            Err(_) => {
                self.mark_stale();
                Err("TASK_BOARD_SYNC_PANIC".into())
            }
        }
    }

    fn sync_inner(&mut self, s: &mut Value) -> Result<bool, String> {
        let mut changed = false;
        if s["full"].is_object() {
            self.board = std::mem::take(&mut s["full"]);
            self.rebuild();
            self.stale = false;
            changed = true;
        } else if self.stale {
            return Err("TASK_BOARD_RESYNC_REQUIRED".into());
        }
        if !self.board.is_object() {
            self.board = json!({});
        }
        for (k, name) in KINDS.iter().enumerate() {
            let mut part = std::mem::take(&mut s[*name]);
            if part.is_null() {
                continue;
            }
            changed = true;
            if part["replace"].is_object() {
                self.board[*name] = std::mem::take(&mut part["replace"]);
                self.rebuild_kind(k);
            }
            if !self.board[*name].is_object() {
                self.board[*name] = json!({});
            }
            let Some(map) = self.board[*name].as_object_mut() else {
                continue;
            };
            let shadow = &mut self.shadow;
            if let Some(set) = part["set"].as_array_mut() {
                for pair in set {
                    let Some(id) = pair[0].as_str().map(str::to_string) else {
                        continue;
                    };
                    let entry = std::mem::take(&mut pair[1]);
                    if !map.contains_key(&id) {
                        shadow.keys[k].push(id.clone());
                    }
                    shadow.hashes[k].insert(id.clone(), fp(&entry));
                    map.insert(id, entry);
                }
            }
            for id in part["del"].as_array().into_iter().flatten() {
                let Some(id) = id.as_str() else { continue };
                if map.shift_remove(id).is_some() {
                    shadow.hashes[k].remove(id);
                    shadow.keys[k].retain(|x| x != id);
                }
            }
            if let Some(order) = part["order"].as_array() {
                reorder(map, order);
                shadow.keys[k] = map.keys().cloned().collect();
            }
        }
        let mut root = std::mem::take(&mut s["root"]);
        if root.is_object() {
            changed = true;
            if let Some(board) = self.board.as_object_mut() {
                if let Some(set) = root["set"].as_object_mut() {
                    for (key, value) in std::mem::take(set) {
                        if KINDS.contains(&key.as_str()) {
                            continue;
                        }
                        self.shadow.root.insert(key.clone(), fp(&value));
                        board.insert(key, value);
                    }
                }
                for key in root["del"].as_array().into_iter().flatten() {
                    let Some(key) = key.as_str().filter(|k| !KINDS.contains(k)) else {
                        continue;
                    };
                    board.shift_remove(key);
                    self.shadow.root.remove(key);
                }
            }
        }
        if s["orders"]["tasks"].is_array() {
            self.task_order = Order::from_ids(&s["orders"]["tasks"]);
        }
        if s["orders"]["taskGroups"].is_array() {
            self.group_order = Order::from_ids(&s["orders"]["taskGroups"]);
        }
        self.dates.extend(&s["dates"], true);
        Ok(changed)
    }

    fn rebuild(&mut self) {
        for k in 0..KINDS.len() {
            self.rebuild_kind(k);
        }
        self.shadow.root = root_entries(&self.board)
            .map(|(k, v)| (k.clone(), fp(v)))
            .collect();
    }
    fn rebuild_kind(&mut self, k: usize) {
        let empty = Map::new();
        let map = self.board[KINDS[k]].as_object().unwrap_or(&empty);
        self.shadow.hashes[k] = map.iter().map(|(id, v)| (id.clone(), fp(v))).collect();
        self.shadow.keys[k] = map.keys().cloned().collect();
    }

    fn changes(&self) -> Changes {
        let mut c = Changes::default();
        let empty = Map::new();
        for (k, kind) in KINDS.iter().enumerate() {
            let cur = self.board[*kind].as_object().unwrap_or(&empty);
            let old = &self.shadow.hashes[k];
            let mut hashes = HashMap::with_capacity(cur.len());
            for (id, v) in cur {
                let h = fp(v);
                if old.get(id) != Some(&h) {
                    c.set[k].push(id.clone());
                }
                hashes.insert(id.clone(), h);
            }
            c.del[k] = self.shadow.keys[k]
                .iter()
                .filter(|id| !cur.contains_key(*id))
                .cloned()
                .collect();
            // 宿主按差分回填得到的顺序：幸存键保持相对顺序、新键追加在尾部。
            let expected = self.shadow.keys[k]
                .iter()
                .filter(|id| cur.contains_key(*id))
                .chain(cur.keys().filter(|id| !old.contains_key(*id)));
            c.order[k] = !expected.eq(cur.keys());
            c.hashes[k] = hashes;
        }
        for (key, v) in root_entries(&self.board) {
            let h = fp(v);
            if self.shadow.root.get(key) != Some(&h) {
                c.root_set.push(key.clone());
            }
            c.root_hashes.insert(key.clone(), h);
        }
        c.root_del = self
            .shadow
            .root
            .keys()
            .filter(|k| !c.root_hashes.contains_key(*k))
            .cloned()
            .collect();
        c
    }

    fn diff(&mut self) -> Value {
        let c = self.changes();
        if !c.any() {
            return Value::Null;
        }
        let empty = Map::new();
        let mut out = Map::new();
        for (k, name) in KINDS.iter().enumerate() {
            let cur = self.board[*name].as_object().unwrap_or(&empty);
            if !c.set[k].is_empty() || !c.del[k].is_empty() || c.order[k] {
                let set: Vec<Value> = c.set[k].iter().map(|id| json!([id, cur[id]])).collect();
                let order = if c.order[k] {
                    json!(cur.keys().collect::<Vec<_>>())
                } else {
                    Value::Null
                };
                out.insert(
                    (*name).into(),
                    json!({"set":set,"del":c.del[k],"order":order}),
                );
            }
            self.shadow.keys[k] = cur.keys().cloned().collect();
        }
        if !c.root_set.is_empty() || !c.root_del.is_empty() {
            let board = &self.board;
            let set: Map<String, Value> = c
                .root_set
                .iter()
                .map(|k| (k.clone(), board[k.as_str()].clone()))
                .collect();
            out.insert("root".into(), json!({"set":set,"del":c.root_del}));
        }
        self.shadow.hashes = c.hashes;
        self.shadow.root = c.root_hashes;
        self.version += 1;
        Value::Object(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opened(raw: Value) -> BoardState {
        let mut s = BoardState::default();
        s.open(&json!({"raw":raw,"dates":[],"idOrder":[],"verifyReads":true}).to_string())
            .unwrap();
        s
    }
    fn call(s: &mut BoardState, input: Value) -> Value {
        serde_json::from_str(&s.apply(&input.to_string()).unwrap()).unwrap()
    }
    fn task(id: &str) -> Value {
        json!({"id":id,"title":id,"status":"active","areas":[],"refs":[],"createdAt":1,"updatedAt":1})
    }

    #[test]
    fn upload_then_read_needs_no_diff() {
        let mut s = opened(json!({"schemaVersion":2,"tasks":{},"modules":{}}));
        let reply = call(
            &mut s,
            json!({"sync":{"tasks":{"set":[["a",task("a")]]}},"command":{"op":"board","action":"resolveTask","taskId":"a"}}),
        );
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["out"]["result"]["id"], "a");
        assert!(reply["diff"].is_null(), "上送的条目已同步指纹，不应回弹");
        assert_eq!(reply["readonlyMutated"], false);
    }

    #[test]
    fn writes_return_only_changed_entries() {
        let mut s = opened(json!({"schemaVersion":2,"tasks":{},"modules":{}}));
        call(
            &mut s,
            json!({"sync":{"tasks":{"set":[["a",task("a")],["b",task("b")]]}}}),
        );
        let reply = call(
            &mut s,
            json!({"command":{"op":"board","action":"lifecycle","taskId":"a","operation":"archive","now":5}}),
        );
        assert_eq!(reply["ok"], true);
        let set = reply["diff"]["tasks"]["set"].as_array().unwrap();
        assert_eq!(set.len(), 1);
        assert_eq!(set[0][0], "a");
        assert_eq!(set[0][1]["status"], "archived");
        assert!(reply["diff"]["tasks"]["order"].is_null());
    }

    #[test]
    fn failed_rule_lists_entries_for_host_restore() {
        let mut s = opened(json!({"schemaVersion":2,"tasks":{},"modules":{}}));
        call(&mut s, json!({"sync":{"tasks":{"set":[["a",task("a")]]}}}));
        let reply = call(
            &mut s,
            json!({"command":{"op":"board","action":"lifecycle","taskId":"missing","operation":"archive","now":5}}),
        );
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"], "task_not_found");
        assert!(reply["restore"].as_object().unwrap().is_empty());
    }

    #[test]
    fn deletes_and_reorder_round_trip() {
        let mut s = opened(json!({"schemaVersion":2,"tasks":{},"modules":{}}));
        call(
            &mut s,
            json!({"sync":{"tasks":{"set":[["a",task("a")],["b",task("b")],["c",task("c")]]}}}),
        );
        call(
            &mut s,
            json!({"sync":{"tasks":{"del":["b"],"order":["c","a"]}}}),
        );
        let mut host: Value = serde_json::from_str(&s.snapshot("{}").unwrap()).unwrap();
        let keys: Vec<&String> = host["tasks"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["c", "a"]);
        host["tasks"] = json!({"c":task("c"),"a":task("a")});
        let check: Value =
            serde_json::from_str(&s.verify(&json!({ "board": host }).to_string()).unwrap())
                .unwrap();
        assert_eq!(check["ok"], true, "{check}");
    }

    #[test]
    fn verify_tolerates_number_forms_and_key_order() {
        let mut s = opened(json!({"schemaVersion":2,"tasks":{},"modules":{}}));
        call(
            &mut s,
            json!({"sync":{"tasks":{"set":[["a",{"id":"a","rank":4.0,"x":1,"y":2}]]}}}),
        );
        let mut host: Value = serde_json::from_str(&s.snapshot("{}").unwrap()).unwrap();
        host["tasks"] = json!({"a":{"y":2,"id":"a","x":1,"rank":4}});
        let check: Value =
            serde_json::from_str(&s.verify(&json!({ "board": host }).to_string()).unwrap())
                .unwrap();
        assert_eq!(check["ok"], true, "{check}");
    }

    #[test]
    fn stale_state_demands_full_upload() {
        let mut s = opened(json!({"schemaVersion":2,"tasks":{},"modules":{}}));
        s.mark_stale();
        assert!(s.apply("{}").unwrap_err().contains("RESYNC_REQUIRED"));
        let reply = call(
            &mut s,
            json!({"sync":{"full":{"schemaVersion":2,"tasks":{"a":task("a")},"modules":{}}}}),
        );
        assert_eq!(reply["ok"], true);
        assert!(!s.is_stale());
    }

    #[test]
    fn deleted_among_is_a_readonly_batch_lookup() {
        let mut s = opened(json!({"schemaVersion":2,"tasks":{},"modules":{},
            "deletedTaskIds":["gone","also-gone"]}));
        assert!(!mutating(&json!({"op":"deletedAmong"})));
        let before = s.board().to_string();
        let reply = call(
            &mut s,
            json!({"command":{"op":"deletedAmong","ids":["keep","also-gone","gone","also-gone",null,7]}}),
        );
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["out"], json!(["also-gone", "gone", "also-gone"]));
        assert!(reply["diff"].is_null(), "只读规则不应产生差分");
        assert_eq!(reply["readonlyMutated"], false);
        assert_eq!(s.board().to_string(), before);
    }

    #[test]
    fn deleted_among_runs_on_the_async_read_path() {
        let mut s = opened(json!({"schemaVersion":2,"tasks":{},"modules":{},
            "deletedTaskIds":["gone"]}));
        let out = s
            .apply_read(
                &json!({"command":{"op":"deletedAmong","ids":["a","gone","b"]}}).to_string(),
            )
            .unwrap();
        let reply: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["out"], json!(["gone"]));
        let empty: Value = serde_json::from_str(
            &s.apply_read(&json!({"command":{"op":"deletedAmong","ids":[]}}).to_string())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(empty["ok"], true);
        assert_eq!(empty["out"], json!([]));
    }

    #[test]
    fn deleted_among_tolerates_a_board_without_the_field() {
        let mut s = opened(json!({"schemaVersion":2,"tasks":{},"modules":{}}));
        let reply = call(&mut s, json!({"command":{"op":"deletedAmong","ids":["a"]}}));
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["out"], json!([]));
        let missing = call(&mut s, json!({"command":{"op":"deletedAmong"}}));
        assert_eq!(missing["out"], json!([]));
    }
}
