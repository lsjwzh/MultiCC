//! 运行配置预设（run-config presets）：纯 JSON 进、JSON 出。
//!
//! 一条预设描述「用哪几个候选线路、按什么顺序试、失败几次换一个」：
//! `{ id, name, protocol, pick, tiering, maxAttempts, sticky, recent, savedAt, candidates[] }`。
//! 这里只做校验、归一化与合并（服务端已存的 stored 与客户端本机的 incoming），
//! 不碰磁盘 —— 文件读写与会话注入留在宿主的 Node 路由里。
//!
//! 任何不完整或越界的条目按契约直接丢弃；预设里不允许夹带密钥类字段，
//! 输出永远只由下面这些键重新拼出来。
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

const INVALID: &str = "RUN_CONFIG_PRESETS_INVALID";
const MAX_ID: usize = 128;
const MAX_NAME: usize = 60;
const MAX_PROVIDER_ID: usize = 256;
const MAX_CLI: usize = 40;
const MAX_MODEL: usize = 200;
const MIN_CANDIDATES: usize = 2;
const MAX_CANDIDATES: usize = 32;
const MAX_NAMED: usize = 20;
const MAX_RECENT: usize = 5;
const PROTOCOLS: [&str; 2] = ["anthropic", "openai_responses"];
const TIERS: [&str; 6] = ["t1", "t2", "t3", "t4", "t5", "t6"];

fn invalid(reason: &str) -> String {
    format!("{INVALID}: {reason}")
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}

fn trimmed(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn float_int(raw: f64) -> Option<i64> {
    if !raw.is_finite() {
        return None;
    }
    let truncated = raw.trunc();
    if truncated >= i64::MAX as f64 {
        Some(i64::MAX)
    } else if truncated <= i64::MIN as f64 {
        Some(i64::MIN)
    } else {
        Some(truncated as i64)
    }
}

// Accepts numbers and numeric strings; floats truncate. Anything else is None.
fn int_like(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().and_then(float_int)),
        Value::String(text) => text.trim().parse::<f64>().ok().and_then(float_int),
        _ => None,
    }
}

// savedAt is millisecond epoch; negatives and garbage collapse to 0.
fn saved_at(value: Option<&Value>) -> i64 {
    match int_like(value) {
        Some(raw) if raw > 0 => raw,
        _ => 0,
    }
}

// A retired lane id folds into the lane that replaced it (`claude-exp` ->
// `claude`, see cli_switch_runtime::family). Stored presets written before the
// retirement still carry the old id; the availability table the server hands
// out no longer lists it, so a client that compared the raw id would reject
// the whole preset as "lane unavailable". Normalising here means every reader
// (web, Flutter, merge) sees the live id and the old one is never written back.
fn canonical_lane(cli: &str) -> String {
    match cli {
        "claude-exp" => "claude".to_owned(),
        _ => cli.to_owned(),
    }
}

struct Candidate {
    provider_id: String,
    cli: Option<String>,
    model: Option<String>,
    priority: i64,
    tier: Option<String>,
    auto_model: bool,
}

impl Candidate {
    fn from_value(value: &Value, index: usize) -> Option<Candidate> {
        let object = value.as_object()?;
        let provider_id = trimmed(object.get("providerId"))?;
        if char_len(&provider_id) > MAX_PROVIDER_ID {
            return None;
        }
        let cli = trimmed(object.get("cli"))
            .filter(|text| char_len(text) <= MAX_CLI)
            .map(|text| canonical_lane(&text));
        let model = match object.get("model") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => {
                let text = text.trim();
                if text.is_empty() {
                    None
                } else if char_len(text) > MAX_MODEL {
                    return None;
                } else {
                    Some(text.to_owned())
                }
            }
            // The contract only knows string | null; any other shape is a bad preset.
            Some(_) => return None,
        };
        // Missing/garbage priorities fall back to the input position, then the
        // stable sort below keeps equal priorities in input order.
        let priority = int_like(object.get("priority"))
            .filter(|raw| *raw > 0)
            .unwrap_or(index as i64 + 1);
        let tier = trimmed(object.get("tier")).filter(|text| TIERS.contains(&text.as_str()));
        let auto_model = object.get("autoModel").and_then(Value::as_bool) == Some(true);
        Some(Candidate {
            provider_id,
            cli,
            model,
            priority,
            tier,
            auto_model,
        })
    }

    fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("providerId".into(), Value::String(self.provider_id.clone()));
        if let Some(cli) = &self.cli {
            object.insert("cli".into(), Value::String(cli.clone()));
        }
        object.insert(
            "model".into(),
            match &self.model {
                Some(model) => Value::String(model.clone()),
                None => Value::Null,
            },
        );
        object.insert("priority".into(), json!(self.priority));
        if let Some(tier) = &self.tier {
            object.insert("tier".into(), Value::String(tier.clone()));
        }
        if self.auto_model {
            object.insert("autoModel".into(), Value::Bool(true));
        }
        Value::Object(object)
    }
}

struct Preset {
    id: String,
    name: String,
    protocol: String,
    pick: String,
    tiering: String,
    max_attempts: i64,
    sticky: bool,
    recent: bool,
    saved_at: i64,
    candidates: Vec<Candidate>,
    subagent: Option<(String, String)>,
}

impl Preset {
    // `index` is the entry's position in its input array; it only feeds the
    // generated id when the entry has none.
    fn from_value(value: &Value, index: usize) -> Option<Preset> {
        let object = value.as_object()?;
        let name = trimmed(object.get("name")).filter(|text| char_len(text) <= MAX_NAME)?;
        let protocol =
            trimmed(object.get("protocol")).filter(|text| PROTOCOLS.contains(&text.as_str()))?;
        let raw_candidates = object.get("candidates").and_then(Value::as_array)?;
        if raw_candidates.len() < MIN_CANDIDATES || raw_candidates.len() > MAX_CANDIDATES {
            return None;
        }
        let mut candidates = Vec::with_capacity(raw_candidates.len());
        for (candidate_index, raw) in raw_candidates.iter().enumerate() {
            candidates.push(Candidate::from_value(raw, candidate_index)?);
        }
        candidates.sort_by_key(|candidate| candidate.priority);
        for (position, candidate) in candidates.iter_mut().enumerate() {
            candidate.priority = position as i64 + 1;
        }

        let pick = match object.get("pick").and_then(Value::as_str).map(str::trim) {
            Some("order") => "order".to_owned(),
            Some("difficulty") => "difficulty".to_owned(),
            _ => {
                let has_tier = candidates.iter().any(|candidate| candidate.tier.is_some());
                if has_tier {
                    "difficulty".to_owned()
                } else {
                    "order".to_owned()
                }
            }
        };
        let tiering = match object.get("tiering").and_then(Value::as_str).map(str::trim) {
            Some("manual") => "manual".to_owned(),
            _ => "price".to_owned(),
        };
        // A preset's attempt budget is its candidate count: the runtime keeps
        // switching until every enabled line has failed, so a stored 2..4 (or
        // any other legacy value) is ignored instead of being preserved.
        let max_attempts = candidates.len() as i64;
        let sticky = object
            .get("sticky")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let recent = object
            .get("recent")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let saved_at = saved_at(object.get("savedAt"));
        let id = trimmed(object.get("id"))
            .filter(|text| char_len(text) <= MAX_ID)
            .unwrap_or_else(|| format!("p{:x}{index}", saved_at));
        let subagent = object
            .get("subagent")
            .and_then(Value::as_object)
            .and_then(|sub| {
                let provider_id = sub
                    .get("providerId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty() && char_len(text) <= MAX_PROVIDER_ID)?;
                let model = sub
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty() && char_len(text) <= MAX_MODEL)?;
                Some((provider_id.to_owned(), model.to_owned()))
            });

        Some(Preset {
            id,
            name,
            protocol,
            pick,
            tiering,
            max_attempts,
            sticky,
            recent,
            saved_at,
            candidates,
            subagent,
        })
    }

    fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), Value::String(self.id.clone()));
        object.insert("name".into(), Value::String(self.name.clone()));
        object.insert("protocol".into(), Value::String(self.protocol.clone()));
        object.insert("pick".into(), Value::String(self.pick.clone()));
        object.insert("tiering".into(), Value::String(self.tiering.clone()));
        object.insert("maxAttempts".into(), json!(self.max_attempts));
        object.insert("sticky".into(), Value::Bool(self.sticky));
        object.insert("recent".into(), Value::Bool(self.recent));
        object.insert("savedAt".into(), json!(self.saved_at));
        object.insert(
            "candidates".into(),
            Value::Array(self.candidates.iter().map(Candidate::to_value).collect()),
        );
        if let Some((provider_id, model)) = &self.subagent {
            object.insert(
                "subagent".into(),
                json!({ "providerId": provider_id, "model": model }),
            );
        }
        Value::Object(object)
    }
}

fn collect_presets(value: Option<&Value>) -> Vec<Preset> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .enumerate()
                .filter_map(|(index, entry)| Preset::from_value(entry, index))
                .collect()
        })
        .unwrap_or_default()
}

fn name_key(preset: &Preset) -> String {
    preset.name.trim().to_lowercase()
}

// id first (first occurrence wins), then names among the non-recent entries
// (case/whitespace-insensitive). Recent entries may share names.
fn dedupe(entries: Vec<Preset>) -> Vec<Preset> {
    let mut ids = HashSet::new();
    let mut by_id = Vec::with_capacity(entries.len());
    for preset in entries {
        if !ids.insert(preset.id.clone()) {
            continue;
        }
        by_id.push(preset);
    }
    let mut names = HashSet::new();
    let mut out = Vec::with_capacity(by_id.len());
    for preset in by_id {
        if !preset.recent && !names.insert(name_key(&preset)) {
            continue;
        }
        out.push(preset);
    }
    out
}

// Dedupe, cap named at 20 and recent at 5 (input order), then named before recent.
fn finalize(entries: Vec<Preset>) -> Vec<Preset> {
    let entries = dedupe(entries);
    let mut named = Vec::new();
    let mut recent = Vec::new();
    for preset in entries {
        if preset.recent {
            if recent.len() < MAX_RECENT {
                recent.push(preset);
            }
        } else if named.len() < MAX_NAMED {
            named.push(preset);
        }
    }
    named.extend(recent);
    named
}

fn output(entries: &[Preset]) -> String {
    json!({ "presets": entries.iter().map(Preset::to_value).collect::<Vec<_>>() }).to_string()
}

fn parse_root(input: &str) -> Result<Value, String> {
    let parsed: Value = crate::json_lenient::from_str(input)
        .map_err(|error| invalid(&format!("invalid JSON: {error}")))?;
    if !parsed.is_object() {
        return Err(invalid("root must be a JSON object"));
    }
    Ok(parsed)
}

/// Normalize `{ "presets": <any> }` into `{"presets":[Preset,...]}`.
pub fn normalize(input: &str) -> Result<String, String> {
    let parsed = parse_root(input)?;
    let presets = finalize(collect_presets(parsed.get("presets")));
    Ok(output(&presets))
}

struct Sourced {
    preset: Preset,
    stored: bool,
    seq: usize,
}

// stored wins ties so the server copy is authoritative.
fn newer(incoming: &Sourced, existing: &Sourced) -> bool {
    incoming.preset.saved_at > existing.preset.saved_at
        || (incoming.preset.saved_at == existing.preset.saved_at
            && !existing.stored
            && incoming.stored)
}

/// Merge `{ "stored": <any>, "incoming": <any> }` into `{"presets":[Preset,...]}`.
/// Same id keeps the newer savedAt (tie: stored); same name (non-recent) keeps
/// the newer savedAt (tie: stored); then newest first, named before recent.
pub fn merge(input: &str) -> Result<String, String> {
    let parsed = parse_root(input)?;
    let mut entries = Vec::new();
    let mut seq = 0;
    for stored in [true, false] {
        let key = if stored { "stored" } else { "incoming" };
        for preset in collect_presets(parsed.get(key)) {
            entries.push(Sourced {
                preset,
                stored,
                seq,
            });
            seq += 1;
        }
    }

    // Same id: keep the newer savedAt. Positions stay put; the sort below
    // decides the final order.
    let mut by_id: Vec<Sourced> = Vec::with_capacity(entries.len());
    let mut id_positions: HashMap<String, usize> = HashMap::new();
    for entry in entries {
        if let Some(&position) = id_positions.get(&entry.preset.id) {
            let existing = &mut by_id[position];
            if newer(&entry, existing) {
                let seq = existing.seq;
                *existing = entry;
                existing.seq = seq;
            }
        } else {
            id_positions.insert(entry.preset.id.clone(), by_id.len());
            by_id.push(entry);
        }
    }

    // Same name across different ids: keep the newer savedAt within the named set.
    let mut kept: Vec<Sourced> = Vec::with_capacity(by_id.len());
    let mut name_positions: HashMap<String, usize> = HashMap::new();
    for entry in by_id {
        if entry.preset.recent {
            kept.push(entry);
            continue;
        }
        let key = name_key(&entry.preset);
        if let Some(&position) = name_positions.get(&key) {
            let existing = &mut kept[position];
            if newer(&entry, existing) {
                let seq = existing.seq;
                *existing = entry;
                existing.seq = seq;
            }
            continue;
        }
        name_positions.insert(key, kept.len());
        kept.push(entry);
    }

    kept.sort_by(|left, right| {
        right
            .preset
            .saved_at
            .cmp(&left.preset.saved_at)
            .then(right.stored.cmp(&left.stored))
            .then(left.seq.cmp(&right.seq))
    });
    let presets: Vec<Preset> = kept.into_iter().map(|entry| entry.preset).collect();
    Ok(output(&finalize(presets)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(input: Value) -> Value {
        serde_json::from_str(&normalize(&input.to_string()).unwrap()).unwrap()
    }

    fn merged(input: Value) -> Value {
        serde_json::from_str(&merge(&input.to_string()).unwrap()).unwrap()
    }

    fn candidates(prefix: &str, count: usize) -> Value {
        Value::Array(
            (0..count)
                .map(|index| json!({ "providerId": format!("{prefix}{index}"), "model": "m" }))
                .collect(),
        )
    }

    fn entry(id: &str, name: &str, saved_at: i64) -> Value {
        json!({
            "id": id,
            "name": name,
            "protocol": "anthropic",
            "savedAt": saved_at,
            "candidates": candidates("p", 2),
        })
    }

    fn recent_entry(id: &str, name: &str, saved_at: i64) -> Value {
        json!({
            "id": id,
            "name": name,
            "protocol": "anthropic",
            "recent": true,
            "savedAt": saved_at,
            "candidates": candidates("p", 2),
        })
    }

    fn ids(out: &Value) -> Vec<String> {
        out["presets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|preset| preset["id"].as_str().unwrap().to_owned())
            .collect()
    }

    // a) 非法条目被丢弃：候选数不足、协议不在枚举、名字为空。
    #[test]
    fn drops_invalid_entries() {
        let out = norm(json!({ "presets": [
            { "id": "few", "name": "Few", "protocol": "anthropic",
                "candidates": [{ "providerId": "p" }] },
            { "id": "proto", "name": "Proto", "protocol": "gemini",
                "candidates": candidates("p", 2) },
            { "id": "blank", "name": "   ", "protocol": "anthropic",
                "candidates": candidates("p", 2) },
            { "id": "ok", "name": "Ok", "protocol": "anthropic",
                "candidates": candidates("p", 2) },
            { "id": "good", "name": "Good", "protocol": "openai_responses",
                "candidates": candidates("p", 2) },
        ]}));
        let presets = out["presets"].as_array().unwrap();
        assert_eq!(ids(&out), vec!["ok", "good"]);
        // A model over 200 chars kills the whole preset.
        let oversized = json!({ "presets": [{
            "id": "model",
            "name": "Model",
            "protocol": "anthropic",
            "candidates": [
                { "providerId": "p", "model": "m".repeat(201) },
                { "providerId": "q" },
            ],
        }]});
        assert_eq!(norm(oversized)["presets"].as_array().unwrap().len(), 0);
        assert_eq!(presets.len(), 2);
    }

    // b') 退役车道 id 折叠到接替它的车道：claude-exp 只读不写。
    #[test]
    fn folds_retired_lane_alias_into_live_lane() {
        let out = norm(json!({ "presets": [{
            "id": "cn",
            "name": "cnmodel",
            "protocol": "anthropic",
            "candidates": [
                { "providerId": "p-1", "cli": "claude-exp", "priority": 1 },
                { "providerId": "p-2", "cli": " CLAUDE-EXP ", "priority": 2 },
                { "providerId": "p-3", "cli": "codex-exp", "priority": 3 },
            ],
        }]}));
        let list = out["presets"][0]["candidates"].as_array().unwrap();
        assert_eq!(list[0]["cli"], "claude");
        // Lane ids are case-sensitive everywhere else; only the exact retired id folds.
        assert_eq!(list[1]["cli"], "CLAUDE-EXP");
        assert_eq!(list[2]["cli"], "codex-exp");
    }

    // b) priority 重排 + cli/model/tier/flag 归一化。
    #[test]
    fn normalizes_candidates_and_flags() {
        let out = norm(json!({ "presets": [{
            "id": " b ",
            "name": " B ",
            "protocol": "anthropic",
            "maxAttempts": 99,
            "savedAt": "1720000000000",
            "apiKey": "leak",
            "candidates": [
                { "providerId": " p-b ", "cli": " codex ", "model": "", "priority": 9,
                    "tier": "t2", "autoModel": true, "secret": "leak" },
                { "providerId": "p-a", "model": " m1 ", "cli": "", "priority": 2 },
                { "providerId": "p-c", "model": "m2", "priority": "bogus",
                    "tier": "t9", "autoModel": false },
            ],
        }]}));
        let preset = &out["presets"][0];
        assert_eq!(preset["id"], "b");
        assert_eq!(preset["name"], "B");
        assert_eq!(preset["savedAt"], 1720000000000i64);
        assert_eq!(preset["sticky"], true);
        assert_eq!(preset["recent"], false);
        assert_eq!(preset["tiering"], "price");
        // p-b carries a valid tier, so the missing pick becomes difficulty.
        assert_eq!(preset["pick"], "difficulty");
        // The candidate count is the attempt budget, so the stored 99 is ignored.
        assert_eq!(preset["maxAttempts"], 3);
        assert!(preset.get("apiKey").is_none());
        let list = preset["candidates"].as_array().unwrap();
        assert_eq!(list[0]["providerId"], "p-a");
        assert_eq!(list[0]["priority"], 1);
        assert_eq!(list[0]["model"], "m1");
        assert!(list[0].get("cli").is_none());
        assert_eq!(list[1]["providerId"], "p-c");
        assert_eq!(list[1]["priority"], 2);
        assert_eq!(list[1]["model"], "m2");
        assert!(list[1].get("tier").is_none());
        assert!(list[1].get("autoModel").is_none());
        assert_eq!(list[2]["providerId"], "p-b");
        assert_eq!(list[2]["priority"], 3);
        assert_eq!(list[2]["cli"], "codex");
        assert_eq!(list[2]["model"], Value::Null);
        assert_eq!(list[2]["tier"], "t2");
        assert_eq!(list[2]["autoModel"], true);
        assert!(list
            .iter()
            .all(|candidate| candidate.get("secret").is_none()));

        // No tier anywhere: pick defaults to order; maxAttempts follows the count.
        let plain = norm(json!({ "presets": [{
            "id": "plain", "name": "Plain", "protocol": "anthropic", "maxAttempts": 9,
            "candidates": candidates("p", 2),
        }]}));
        assert_eq!(plain["presets"][0]["pick"], "order");
        assert_eq!(plain["presets"][0]["maxAttempts"], 2);
        assert_eq!(plain["presets"][0]["tiering"], "price");
        assert_eq!(plain["presets"][0]["savedAt"], 0);
    }

    // c) 先按 id 去重，再对具名条目按 name 去重；recent 不参与名字去重。
    #[test]
    fn dedupes_by_id_then_name() {
        let out = norm(json!({ "presets": [
            entry("dup", "First", 100),
            entry("dup", "Second", 200),
            entry("n1", " Same Name ", 5),
            entry("n2", "same name", 9),
            recent_entry("r1", "Same Name", 1),
            recent_entry("r2", "same name", 2),
        ]}));
        assert_eq!(ids(&out), vec!["dup", "n1", "r1", "r2"]);
        assert_eq!(out["presets"][0]["name"], "First");
        assert_eq!(out["presets"][1]["name"], "Same Name");
        assert_eq!(out["presets"][2]["recent"], true);
    }

    // d) 具名 20 条、recent 5 条的按输入顺序截断。
    #[test]
    fn caps_named_at_20_and_recent_at_5() {
        let mut presets = Vec::new();
        for index in 0..25 {
            let id = format!("n{index}");
            let name = format!("N{index}");
            presets.push(entry(&id, &name, index as i64));
        }
        for index in 0..8 {
            let id = format!("r{index}");
            let name = format!("R{index}");
            presets.push(recent_entry(&id, &name, index as i64));
        }
        let out = norm(json!({ "presets": presets }));
        let expected: Vec<String> = (0..20)
            .map(|index| format!("n{index}"))
            .chain((0..5).map(|index| format!("r{index}")))
            .collect();
        assert_eq!(ids(&out), expected);
        let presets = out["presets"].as_array().unwrap();
        assert_eq!(presets.iter().filter(|p| p["recent"] != true).count(), 20);
        assert_eq!(presets.iter().filter(|p| p["recent"] == true).count(), 5);
    }

    // e) merge：同 id 取 savedAt 新者、同 name 合并、按 savedAt 降序且具名在前。
    #[test]
    fn merge_prefers_newer_and_sorts() {
        let out = merged(json!({
            "stored": [entry("a", "A", 100), entry("b", "B", 300)],
            "incoming": [
                entry("a", "A", 200),
                entry("b", "Bee", 50),
                entry("c", "A", 400),
                recent_entry("r", "R", 999),
            ],
        }));
        // id a: incoming 200 > stored 100 → keep incoming; id b: stored 300 wins.
        // name "a": c (400) beats a (200). Newest first, named before recent.
        assert_eq!(ids(&out), vec!["c", "b", "r"]);
        assert_eq!(out["presets"][0]["name"], "A");
        assert_eq!(out["presets"][0]["savedAt"], 400);
        assert_eq!(out["presets"][1]["name"], "B");
        assert_eq!(out["presets"][1]["savedAt"], 300);
        assert_eq!(out["presets"][2]["recent"], true);

        // Equal savedAt on the same id or name keeps the server (stored) copy.
        let tie = merged(json!({
            "stored": [entry("t", "T", 10), entry("u", "U", 50)],
            "incoming": [entry("t", "T2", 10), entry("v", "U", 50)],
        }));
        assert_eq!(ids(&tie), vec!["u", "t"]);
        assert_eq!(tie["presets"][0]["name"], "U");
        assert_eq!(tie["presets"][1]["name"], "T");
    }

    // f) 缺失 id 时用 savedAt 十六进制 + 输入下标生成。
    #[test]
    fn generates_ids_from_saved_at_and_index() {
        let out = norm(json!({ "presets": [
            { "name": "Zero", "protocol": "anthropic", "savedAt": 0,
                "candidates": candidates("p", 2) },
            { "name": "Hex", "protocol": "anthropic", "savedAt": 255,
                "candidates": candidates("q", 2) },
        ]}));
        assert_eq!(ids(&out), vec!["p00", "pff1"]);
    }

    #[test]
    fn rejects_bad_roots_and_tolerates_missing_arrays() {
        for input in ["[]", "\"nope\"", "not json", "null"] {
            let error = normalize(input).unwrap_err();
            assert!(
                error.starts_with("RUN_CONFIG_PRESETS_INVALID: "),
                "unexpected error: {error}"
            );
            assert!(merge(input)
                .unwrap_err()
                .starts_with("RUN_CONFIG_PRESETS_INVALID: "));
        }
        assert_eq!(norm(json!({ "presets": "oops" })), json!({ "presets": [] }));
        assert_eq!(norm(json!({})), json!({ "presets": [] }));
        assert_eq!(
            merged(json!({ "stored": 7, "incoming": {} })),
            json!({ "presets": [] })
        );
        assert_eq!(merged(json!({})), json!({ "presets": [] }));
    }

    #[test]
    fn subagent_kept_only_when_complete() {
        let out = norm(json!({ "presets": [
            {
                "id": "s1", "name": "S1", "protocol": "anthropic",
                "candidates": candidates("p", 2),
                "subagent": { "providerId": " sp ", "model": " sm " },
            },
            {
                "id": "s2", "name": "S2", "protocol": "anthropic",
                "candidates": candidates("q", 2),
                "subagent": { "providerId": "sp", "model": "  " },
            },
        ]}));
        assert_eq!(
            out["presets"][0]["subagent"],
            json!({ "providerId": "sp", "model": "sm" })
        );
        assert!(out["presets"][1].get("subagent").is_none());
    }
}
