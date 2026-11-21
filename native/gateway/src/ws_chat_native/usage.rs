//! Usage DTOs shared with the compatibility host's on-disk ledgers.
use chrono::{Datelike, Local, NaiveDate};
use multicc_core::{
    js::{self, JsValue as V},
    provider_store, quota_guard, state_file,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path};

const MAX_COUNT: u64 = 9_007_199_254_740_991;

fn count(value: &Value) -> u64 {
    value
        .as_u64()
        .or_else(|| value.as_str()?.trim().parse().ok())
        .filter(|value| *value <= MAX_COUNT)
        .unwrap_or(0)
}

fn sum(a: u64, b: u64) -> u64 {
    a.saturating_add(b).min(MAX_COUNT)
}

#[derive(Clone, Copy, Default)]
struct CodexUsage {
    fresh: u64,
    cached: u64,
    write: u64,
    output: u64,
    reasoning: u64,
}

impl CodexUsage {
    fn read(usage: &Value) -> Self {
        let cache_read = usage
            .get("cache_read_input_tokens")
            .filter(|value| !value.is_null());
        let cached = count(cache_read.unwrap_or(&usage["cached_input_tokens"]));
        let input = count(&usage["input_tokens"]);
        Self {
            fresh: if cache_read.is_some() {
                input
            } else {
                input.saturating_sub(cached)
            },
            cached,
            write: count(&usage["cache_creation_input_tokens"]),
            output: count(&usage["output_tokens"]),
            reasoning: count(&usage["reasoning_output_tokens"]),
        }
    }

    fn delta(self, previous: Self) -> Option<Self> {
        Some(Self {
            fresh: self.fresh.checked_sub(previous.fresh)?,
            cached: self.cached.checked_sub(previous.cached)?,
            write: self.write.checked_sub(previous.write)?,
            output: self.output.checked_sub(previous.output)?,
            reasoning: self.reasoning.saturating_sub(previous.reasoning),
        })
    }

    fn to_usage(self, usage: &Value) -> Value {
        let mut usage = usage.as_object().cloned().unwrap_or_default();
        for (key, count) in [
            ("input_tokens", self.fresh),
            ("cached_input_tokens", self.cached),
            ("cache_read_input_tokens", self.cached),
            ("cache_creation_input_tokens", self.write),
            ("output_tokens", self.output),
            ("reasoning_output_tokens", self.reasoning),
            (
                "total_tokens",
                sum(sum(self.fresh, self.cached), self.output),
            ),
        ] {
            usage.insert(key.into(), json!(count));
        }
        Value::Object(usage)
    }
}

fn codex_snapshot(row: &V, key: &str) -> Option<Value> {
    let usage = js::to_serde(row.get(key)?);
    let object = usage.as_object()?;
    (key == "usageCumulative"
        || object.contains_key("cached_input_tokens")
        || object.contains_key("reasoning_output_tokens"))
    .then_some(usage)
}

pub(super) fn exec_turn(usage: &Value, rows: &[V], thread: &str) -> (Value, V, V) {
    if !usage.is_object() || usage.as_object().is_some_and(serde_json::Map::is_empty) {
        return (usage.clone(), V::Undefined, V::Undefined);
    }
    let epoch = format!("{:x}", Sha256::digest(thread));
    let epoch = &epoch[..24];
    let previous = rows
        .iter()
        .rev()
        .filter(|row| super::is_role(row, "assistant"))
        .find_map(|row| {
            if js::truthy_opt(row.get("usageCumulative")) {
                let matches_epoch =
                    super::optional_text(row, "usageEpoch").is_none_or(|value| value == epoch);
                return matches_epoch
                    .then(|| codex_snapshot(row, "usageCumulative"))
                    .flatten();
            }
            codex_snapshot(row, "usage")
        });
    let current = CodexUsage::read(usage);
    let (delta, cumulative) = match previous.as_ref().map(CodexUsage::read) {
        Some(previous) => match current.delta(previous) {
            Some(delta) => (delta, current),
            None => (CodexUsage::default(), previous),
        },
        None => (current, current),
    };
    (
        delta.to_usage(usage),
        super::value(cumulative.to_usage(&Value::Null)),
        V::from(epoch),
    )
}

#[derive(Default)]
pub(super) struct History {
    baselines: HashMap<String, CodexUsage>,
    counts: Counts,
}

impl History {
    /// Observe every saved row in order before selecting the requested page.
    pub(super) fn observe(&mut self, row: &V, per_turn: bool) -> Option<V> {
        if !super::is_role(row, "assistant") {
            return None;
        }
        let epoch = super::optional_text(row, "usageEpoch").unwrap_or_else(|| "legacy".into());
        let usage = row.get("usage").map(js::to_serde).unwrap_or_default();
        let mut projected = None;
        if js::truthy_opt(row.get("usageCumulative")) {
            if let Some(cumulative) = codex_snapshot(row, "usageCumulative") {
                self.baselines.insert(epoch, CodexUsage::read(&cumulative));
            }
        } else if !per_turn
            && (usage.get("cached_input_tokens").is_some()
                || usage.get("reasoning_output_tokens").is_some())
        {
            let current = CodexUsage::read(&usage);
            let delta = self
                .baselines
                .insert(epoch, current)
                .and_then(|previous| current.delta(previous))
                .unwrap_or(current);
            projected = Some(delta.to_usage(&usage));
        }
        if let Some(counts) = Counts::result(projected.as_ref().unwrap_or(&usage)) {
            self.counts.add(counts);
        }
        projected.map(super::value)
    }

    pub(super) fn total(&self) -> V {
        super::value(
            Counts {
                known: true,
                ..self.counts
            }
            .bucket(),
        )
    }
}

pub(super) fn wire_row(row: &mut V, usage: Option<V>) {
    if let V::Object(fields) = row {
        fields.retain(|(key, _)| key != "usageCumulative" && key != "usageEpoch");
    }
    if let Some(usage) = usage {
        quota_guard::set(row, "usage", usage);
    }
}

#[derive(Clone, Copy, Default)]
struct Counts {
    input: u64,
    fresh: u64,
    read: u64,
    write: u64,
    output: u64,
    turns: u64,
    known: bool,
}

impl Counts {
    fn result(value: &Value) -> Option<Self> {
        let fresh = count(&value["input_tokens"]);
        let read = count(&value["cache_read_input_tokens"]);
        let write = count(&value["cache_creation_input_tokens"]);
        let input = sum(sum(fresh, read), write);
        let output = count(&value["output_tokens"]);
        (input != 0 || output != 0).then_some(Self {
            input,
            fresh,
            read,
            write,
            output,
            turns: 1,
            known: true,
        })
    }

    fn from_bucket(value: &Value) -> Self {
        let input = value
            .get("consumedInputTokens")
            .filter(|value| !value.is_null())
            .unwrap_or(&value["inputTokens"]);
        Self {
            input: count(input),
            fresh: count(&value["freshInputTokens"]),
            read: count(&value["cacheReadTokens"]),
            write: count(&value["cacheWriteTokens"]),
            output: count(&value["outputTokens"]),
            turns: count(&value["turnCount"]),
            known: value["breakdownKnown"].as_bool().unwrap_or_else(|| {
                ["freshInputTokens", "cacheReadTokens", "cacheWriteTokens"]
                    .iter()
                    .any(|key| value.get(key).is_some())
            }),
        }
    }

    fn add(&mut self, other: Self) {
        self.input = sum(self.input, other.input);
        self.fresh = sum(self.fresh, other.fresh);
        self.read = sum(self.read, other.read);
        self.write = sum(self.write, other.write);
        self.output = sum(self.output, other.output);
        self.turns = sum(self.turns, other.turns);
        self.known |= other.known;
    }

    fn bucket(self) -> Value {
        json!({"inputTokens":self.input, "consumedInputTokens":self.input,"freshInputTokens":self.fresh,
            "cacheReadTokens":self.read,"cacheWriteTokens":self.write,"breakdownKnown":self.known,
            "outputTokens":self.output,"turnCount":self.turns})
    }

    fn window(self) -> Value {
        if self.turns == 0 && self.input == 0 && self.output == 0 {
            return Value::Null;
        }
        let mut bucket = self.bucket();
        bucket["unattributedInputTokens"] = json!(self
            .input
            .saturating_sub(sum(sum(self.fresh, self.read), self.write)));
        bucket
    }
}

fn read(file: &Path) -> Result<Value, String> {
    let data = provider_store::read(file)?.unwrap_or_else(|| json!({}));
    if !data.is_object() {
        return Err("invalid_usage_ledger".into());
    }
    Ok(data)
}

fn update(bucket: &mut Value, counts: Counts) {
    let mut total = Counts::from_bucket(bucket);
    total.add(counts);
    if !bucket.is_object() {
        *bucket = json!({});
    }
    for (key, value) in total.bucket().as_object().expect("usage bucket") {
        bucket[key] = value.clone();
    }
}

fn update_frame(file: &Path, update: impl FnOnce(&mut Value)) -> Result<Value, String> {
    let _lock = provider_store::lock(file)?;
    let mut data = read(file)?;
    update(&mut data);
    state_file::write_json_atomic(file, &data).map_err(|error| error.to_string())?;
    Ok(data)
}

pub(super) fn record(
    root: &Path,
    session: &str,
    provider: &str,
    usage: &Value,
) -> Result<Option<Value>, String> {
    let Some(counts) = Counts::result(usage) else {
        return Ok(None);
    };
    let ledger = update_frame(&root.join("token_usage.json"), |data| {
        let bucket = &mut data[session];
        update(bucket, counts);
        if !bucket["byProvider"].is_object() {
            bucket["byProvider"] = json!({});
        }
        update(&mut bucket["byProvider"][provider], counts);
    })?;
    let day = Local::now().date_naive().to_string();
    if let Err(error) = update_frame(&root.join("token_daily.json"), |data| {
        if !data[&day].is_object() {
            data[&day] = json!({});
        }
        update(&mut data[&day][provider], counts);
    }) {
        eprintln!("[multicc-gateway] native Codex daily usage write failed: {error}");
    }
    Ok(Some(ledger[session].clone()))
}

pub(super) fn windows(root: &Path, session: &str, provider: &str) -> Result<Value, String> {
    let day = Local::now().date_naive();
    let month = day.with_day(1).expect("first of the month");
    let week = day - chrono::Duration::days(i64::from(day.weekday().num_days_from_monday()));
    let daily = read(&root.join("token_daily.json"))?;
    let (mut today, mut this_week, mut this_month, mut all) = (
        Counts::default(),
        Counts::default(),
        Counts::default(),
        Counts::default(),
    );
    for (date, row) in daily.as_object().expect("usage ledger") {
        let Ok(date) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
            continue;
        };
        let entry = Counts::from_bucket(&row[provider]);
        all.add(entry);
        if date < month {
            continue;
        }
        this_month.add(entry);
        if date < week {
            continue;
        }
        this_week.add(entry);
        if date == day {
            today.add(entry);
        }
    }
    let mut windows = json!({"today":today.window(),"week":this_week.window(),"month":this_month.window(),"all":all.window()});
    if windows["all"].is_null() {
        let ledger = read(&root.join("token_usage.json"))?;
        for row in ledger.as_object().expect("usage ledger").values() {
            all.add(Counts::from_bucket(&row["byProvider"][provider]));
        }
        windows["all"] = all.window();
        if windows["all"].is_null() {
            let session = Counts::from_bucket(&ledger[session]);
            windows["attributionUnknown"] = json!(session.input != 0 || session.output != 0);
        }
    }
    Ok(windows)
}

pub(super) fn role(usage: &Value, provider: &str, name: &str, model: &Value) -> Option<Value> {
    let counts = Counts::result(usage)?;
    Some(json!({
        "main":{"inputTokens":counts.fresh,"outputTokens":counts.output,"cacheWrite":counts.write,"cacheRead":counts.read},
        "mainByProvider":[{"providerId":provider,"name":name,"model":model,
            "inputTokens":counts.fresh,"outputTokens":counts.output,"cacheWrite":counts.write,"cacheRead":counts.read}],
        "sub":null,"subByProvider":[]
    }))
}
