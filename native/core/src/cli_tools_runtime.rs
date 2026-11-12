//! CLI installation and version state. The Node host supplies process/file facts;
//! this owner alone holds jobs, cache TTLs, mutexes and public response policy.
use crate::homebrew_takeover::{is_npm_global_install as npm_global, takeover_command};
use crate::js::serde::{js_string, truthy};
use crate::js::{from_serde, js_trim, to_serde, JsString, JsValue};
use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::sync::LazyLock;

const TTL: f64 = 86_400_000.0;
const LOG_CAP: usize = 12 * 1024;
const JOB_CAP: usize = 50;
static VERSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?").unwrap());
static TLS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)certificate|cert verification|\btls\b|\bssl\b|handshake").unwrap()
});
static NETWORK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)No binary available|Failed to download|Could not resolve|connection (timed out|refused)|network is unreachable|temporary failure").unwrap()
});
static REQUIRED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)is required but not installed|Neither curl nor wget").unwrap()
});
fn env_key(line: &str) -> Option<&str> {
    let line = line.trim_start_matches(crate::js::is_js_whitespace_char);
    let before = line.split_once('=')?.0;
    if before.contains('#') {
        return None;
    }
    let key = before.trim_end_matches(crate::js::is_js_whitespace_char);
    (!key.is_empty()).then_some(key)
}
fn s(v: &Value) -> String {
    if v.is_null() {
        String::new()
    } else {
        js_string(v)
    }
}
fn text(v: &Value, key: &str) -> String {
    s(&v[key])
}
fn present(v: &Value) -> Value {
    if truthy(v) {
        v.clone()
    } else {
        Value::Null
    }
}
fn list(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn response(status: u16, body: Value) -> Value {
    json!({"response": {"status": status, "body": body}})
}
fn iso(at: f64) -> Value {
    DateTime::<Utc>::from_timestamp_millis(at as i64)
        .map(|v| Value::String(v.to_rfc3339_opts(SecondsFormat::Millis, true)))
        .unwrap_or(Value::Null)
}
fn compare(a: &Value, b: &Value) -> i32 {
    let difference = crate::cli_upstream_version::compare_semver(&from_serde(a), &from_serde(b));
    if difference < 0.0 {
        -1
    } else if difference > 0.0 {
        1
    } else {
        0
    }
}
fn normalized_version(v: &Value) -> Value {
    to_serde(&crate::cli_upstream_version::normalized_version(
        &from_serde(v),
    ))
}
fn cmd_env(cli: &str) -> Option<&'static str> {
    match cli {
        "claude" => Some("CLAUDE_CMD"),
        "codex" | "codex-exp" => Some("CODEX_CMD"),
        "opencode" => Some("OPENCODE_CMD"),
        "zcode" => Some("ZCODE_CMD"),
        "kimi" => Some("KIMI_CMD"),
        "qoder" => Some("QODER_CMD"),
        "codebuddy" => Some("CODEBUDDY_CMD"),
        "dsh" => Some("DSH_CMD"),
        "gemini" => Some("GEMINI_CMD"),
        "grok" => Some("GROK_CMD"),
        "commandcode" => Some("COMMAND_CODE_CMD"),
        "pi" => Some("PI_CMD"),
        _ => None,
    }
}
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn native_upgrade(cmd: &str, real: &str, target: &str, sep: &str) -> Option<String> {
    if cmd.is_empty() {
        return None;
    }
    let (sub, markers) = match target {
        "claude" => (
            "update",
            vec![
                "/.local/share/claude/versions/",
                "/.claude/local/",
                "/.local/bin/claude",
            ],
        ),
        "opencode" => ("upgrade", vec!["/.opencode/bin/"]),
        _ => return None,
    };
    markers
        .iter()
        .any(|v| {
            let marker = v.replace('/', sep);
            real.contains(&marker) || cmd.contains(&marker)
        })
        .then(|| format!("{} {}", shell_quote(cmd), sub))
}
fn hint(log: &str) -> Value {
    let value = if TLS.is_match(log) {
        Some("安装程序的 HTTPS 请求证书校验失败，通常由 VPN / 网络代理 / 抓包工具拦截 HTTPS 引起。可尝试关闭 VPN/代理后重试，或在终端手动执行上面的命令。")
    } else if NETWORK.is_match(log) {
        Some("下载发布信息或二进制失败，多为网络不通或被代理拦截。可检查网络/代理后重试，或在终端手动执行上面的命令。")
    } else if log.contains("EEXIST") {
        Some("目标位置已有一个不是 npm 装的同名文件（例如 Homebrew 或其它渠道装的旧版），npm 拒绝覆盖。请先卸载那份旧安装再重试。")
    } else if REQUIRED.is_match(log) {
        Some("缺少安装所需的命令行工具（如 curl / unzip / tar）。请先安装相应工具后重试。")
    } else {
        None
    };
    value.map(Value::from).unwrap_or(Value::Null)
}
#[derive(Default)]
struct Cache {
    at: f64,
    value: Option<Value>,
}
impl Cache {
    fn fresh(&self, now: f64, force: bool) -> bool {
        !force && self.value.is_some() && now - self.at < TTL
    }
}
struct Job {
    data: Value,
    log: JsString,
    before: Value,
    expected: Value,
}
impl Job {
    fn running(&self) -> bool {
        self.data["status"] == "running"
    }
    fn tail(&self) -> JsString {
        self.log
            .slice_units(self.log.len().saturating_sub(LOG_CAP), self.log.len())
    }
    fn public(&self) -> Value {
        let mut out = self.data.clone();
        let tail = self.tail().to_string_lossy();
        out["hint"] = if truthy(&out["hint"]) {
            out["hint"].clone()
        } else {
            hint(&tail)
        };
        out["logTail"] = Value::String(tail);
        out
    }
}
pub struct Runtime {
    config: Value,
    local: Cache,
    latest: Cache,
    bundled: Cache,
    jobs: VecDeque<Job>,
    watch_started: bool,
}
impl Runtime {
    pub fn new(config: Value) -> Self {
        Self {
            config,
            local: Cache::default(),
            latest: Cache::default(),
            bundled: Cache::default(),
            jobs: VecDeque::new(),
            watch_started: false,
        }
    }
    fn lane(&self, name: &str) -> Value {
        list(&self.config["catalog"])
            .into_iter()
            .find(|v| v["id"] == name)
            .unwrap_or(Value::Null)
    }
    fn target(&self, name: &str) -> String {
        let key = js_trim(name).to_lowercase();
        if truthy(&self.config["specs"][&key]) {
            return key;
        }
        let family = text(&self.lane(&key), "family");
        if family.is_empty() {
            key
        } else {
            family
        }
    }
    fn target_key(&self, cli: &str) -> String {
        let target = self.target(cli);
        let command = text(&self.config["specs"][&target], "command");
        let command = js_trim(&command);
        if command.is_empty() {
            format!("cli:{target}")
        } else {
            command.to_string()
        }
    }
    fn targets(&self) -> Vec<(String, Value)> {
        let mut result: Vec<(String, Value)> = Vec::new();
        for lane in list(&self.config["catalog"]) {
            let target = self.target(&text(&lane, "id"));
            if result.iter().any(|(key, _)| key == &target)
                || (truthy(&lane["bundled"]) && !truthy(&lane["terminal"]))
            {
                continue;
            }
            result.push((target, lane));
        }
        result
    }
    fn counts(&self, active: &Value) -> Value {
        let mut counts = Map::new();
        for lane in list(active) {
            let key = self.target(&s(&lane));
            let n = counts.get(&key).and_then(Value::as_u64).unwrap_or(0) + 1;
            counts.insert(key, Value::from(n));
        }
        Value::Object(counts)
    }
    fn invalidate(&mut self) {
        self.local = Cache::default();
        self.latest = Cache::default();
        self.bundled = Cache::default();
    }
    fn running(&self, cli: &str) -> Option<&Job> {
        let key = self.target_key(cli);
        self.jobs
            .iter()
            .find(|j| j.running() && j.data["target"] == key)
    }
    fn bundled_engines(&self, lane: &Value, input: &Value) -> Value {
        Value::Array(
            list(&lane["engines"])
                .into_iter()
                .map(|mut engine| {
                    let name = text(&engine, "lane");
                    engine["available"] =
                        Value::Bool(truthy(&input["availability"][&name]["available"]));
                    engine["version"] = present(&input["bundledVersions"][&name]);
                    engine
                })
                .collect(),
        )
    }
    fn install_plan(&self, input: &Value) -> Value {
        let requested = js_trim(&text(input, "requested")).to_lowercase();
        if !list(&self.config["supported"])
            .iter()
            .any(|v| v == &requested)
        {
            return response(400, json!({"ok":false,"error":"unsupported cli"}));
        }
        let row = self.lane(&requested);
        let cli = text(&row, "canonical");
        let row = self.lane(&cli);
        if truthy(&row["bundled"]) && !truthy(&row["terminal"]) {
            let names = list(&row["engines"])
                .iter()
                .map(|e| text(e, "engine"))
                .collect::<Vec<_>>()
                .join(" / ");
            let names = if names.is_empty() {
                "内置引擎"
            } else {
                &names
            };
            return response(
                400,
                json!({"ok":false,"manual":true,"error":format!("{} 的引擎({names})随 MultiCC 一起发布，请升级 MultiCC 本身来更新它",text(&row,"familyName"))}),
            );
        }
        let upgrade = input["kind"] == "upgrade";
        if input["validateOnly"] == true {
            return json!({"cli":cli,"needAvailability":!upgrade});
        }
        if !upgrade && truthy(&input["availability"][&cli]["available"]) {
            return response(
                200,
                json!({"ok":true,"alreadyInstalled":true,"availability":{(cli.clone()):input["availability"][&cli]}}),
            );
        }
        let target = self.target(&cli);
        let spec = &self.config["specs"][&target];
        if spec.is_null() {
            return response(400, json!({"ok":false,"error":"unsupported cli"}));
        }
        if spec["auto"] == false {
            return response(
                400,
                json!({"ok":false,"manual":true,"error":spec["manual"]}),
            );
        }
        if let Some(job) = self.running(&cli) {
            let other = text(&job.data, "cli");
            return response(
                409,
                json!({"ok":false,"running":true,"jobId":job.data["id"],"error":if other == cli { format!("{cli} 的{}任务正在进行中",if upgrade {"升级"} else {"安装/升级"}) } else { format!("{other} 与 {cli} 使用同一条安装命令，请等它跑完再试") }}),
            );
        }
        json!({"cli":cli,"target":target,"command":spec["command"],"needActive":upgrade})
    }
    pub fn request(&mut self, op: &str, raw: &JsValue) -> JsValue {
        if op == "jobLog" {
            let id = raw
                .get("id")
                .map(to_serde)
                .map(|v| s(&v))
                .unwrap_or_default();
            if let Some(job) = self.jobs.iter_mut().find(|j| j.data["id"] == id) {
                if let Some(JsValue::String(value)) = raw.get("text") {
                    job.log.push(value);
                    if job.log.len() > LOG_CAP * 2 {
                        job.log = job.tail();
                    }
                }
            }
            return JsValue::Null;
        }
        let input = to_serde(raw);
        let value = self.data_request(op, &input);
        let mut result = from_serde(&value);
        if op == "probeVersion" && !value["error"].is_null() {
            if let Some(JsValue::String(error)) = raw.get("error") {
                if !error.is_empty() {
                    set_path(
                        &mut result,
                        &["error"],
                        JsValue::String(error.truncate_units(200)),
                    );
                }
            }
        }
        // Logs cross the native boundary as UTF-16, including a cut surrogate.
        if op == "jobStatus" {
            if let Some(job) = self.jobs.iter().find(|j| j.data["id"] == input["id"]) {
                set_path(
                    &mut result,
                    &["response", "body", "job", "logTail"],
                    JsValue::String(job.tail()),
                );
            }
        }
        result
    }
    fn data_request(&mut self, op: &str, input: &Value) -> Value {
        let now = input["now"].as_f64().unwrap_or(0.0);
        let force = truthy(&input["force"]);
        match op {
            "pinNames" => Value::Array(
                [
                    "CLAUDE_CMD",
                    "CODEX_CMD",
                    "OPENCODE_CMD",
                    "ZCODE_CMD",
                    "KIMI_CMD",
                    "QODER_CMD",
                    "CODEBUDDY_CMD",
                    "DSH_CMD",
                    "GEMINI_CMD",
                    "GROK_CMD",
                    "COMMAND_CODE_CMD",
                    "PI_CMD",
                ]
                .into_iter()
                .map(Value::from)
                .collect(),
            ),
            "bundledEngineVersion" => {
                let installed = &input["installed"];
                if installed.is_string() && truthy(installed) {
                    let raw = s(installed);
                    json!(raw.strip_prefix('v').unwrap_or(&raw))
                } else if let Some(raw) = input["declared"].as_str() {
                    json!(if raw.starts_with('~') || raw.starts_with('^') {
                        &raw[1..]
                    } else {
                        raw
                    })
                } else {
                    Value::Null
                }
            }
            "specs" => response(
                200,
                json!({"ok":true,"specs":self.config["specs"],"availability":input["availability"]}),
            ),
            "force" => {
                Value::Bool(input["query"]["refresh"] == "1" || input["query"]["force"] == "1")
            }
            "watchStart" => {
                if self.watch_started {
                    json!({"start":false})
                } else {
                    self.watch_started = true;
                    json!({"start":true,"startupMs":15_000,"intervalMs":86_400_000})
                }
            }
            "probeVersion" => {
                let version = ["stdout", "stderr"].iter().find_map(|key| {
                    VERSION
                        .find(&text(input, key))
                        .map(|m| Value::from(m.as_str()))
                });
                if let Some(version) = version {
                    json!({"version":version,"error":null})
                } else {
                    let error = if truthy(&input["error"]) {
                        crate::js::utf16_prefix(&text(input, "error"), 200)
                    } else {
                        "version not parseable".into()
                    };
                    json!({"version":null,"error":error})
                }
            }
            "bundledPlan" => {
                if self.bundled.fresh(now, force) {
                    json!({"cached":true,"version":self.bundled.value})
                } else {
                    json!({"cached":false})
                }
            }
            "bundledCommit" => {
                self.bundled = Cache {
                    at: now,
                    value: Some(input["version"].clone()),
                };
                input["version"].clone()
            }
            "localPeek" => {
                if self.local.fresh(now, force) {
                    json!({"cached":true,"at":self.local.at,"versions":self.local.value})
                } else {
                    Value::Null
                }
            }
            "localPlan" => {
                if self.local.fresh(now, force) {
                    return json!({"cached":true,"at":self.local.at,"versions":self.local.value});
                }
                let mut entries = Map::new();
                let mut probes = Vec::new();
                for (family, lane) in self.targets() {
                    let id = text(&lane, "id");
                    let cmd = present(&input["commands"][&id]);
                    let available = truthy(&input["availability"][&id]["available"]);
                    let bundled = self.bundled_engines(&lane, input);
                    if cmd.is_null() || !available {
                        entries.insert(family,json!({"cmd":cmd,"available":false,"version":null,"error":null,"bundled":bundled}));
                    } else {
                        probes.push(json!({"family":family,"cmd":cmd,"bundled":bundled}));
                    }
                }
                json!({"cached":false,"at":now,"initial":entries,"probes":probes})
            }
            "localCommit" => {
                let mut versions = input["initial"].clone();
                for item in list(&input["results"]) {
                    let key = text(&item, "family");
                    versions[&key] = json!({"cmd":item["cmd"],"available":true,"version":item["result"]["version"],"error":item["result"]["error"],"bundled":item["bundled"]});
                }
                self.local = Cache {
                    at: now,
                    value: Some(versions.clone()),
                };
                json!({"cached":false,"at":now,"versions":versions})
            }
            "latestPlan" => {
                if self.latest.fresh(now, force) {
                    let cached = self.latest.value.as_ref().unwrap();
                    return json!({"cached":true,"at":self.latest.at,"latest":cached["latest"],"registry":cached["registry"]});
                }
                let mut initial = Map::new();
                let mut registry = Map::new();
                let mut probes = Vec::new();
                for (family, _lane) in self.targets() {
                    let pkg = &self.config["npmPackages"][&family];
                    if !truthy(pkg)
                        || !truthy(&input["versions"][&family]["available"])
                        || (family == "claude" && truthy(&input["baseline"]))
                    {
                        initial.insert(family.clone(), Value::Null);
                        registry.insert(family, Value::Null);
                    } else {
                        probes.push(json!({"family":family,"pkg":pkg}));
                    }
                }
                json!({"cached":false,"at":now,"initial":initial,"registry":registry,"probes":probes})
            }
            "latestCommit" => {
                let mut latest = input["initial"].clone();
                let mut registry = input["registry"].clone();
                for item in list(&input["results"]) {
                    let key = text(&item, "family");
                    let value = &item["result"];
                    latest[&key] = if value.is_string() {
                        value.clone()
                    } else {
                        present(&value["version"])
                    };
                    registry[&key] = present(&value["registry"]);
                }
                self.latest = Cache {
                    at: now,
                    value: Some(json!({"latest":latest,"registry":registry})),
                };
                json!({"cached":false,"at":now,"latest":latest,"registry":registry})
            }
            "versions" => self.versions(input),
            "installValidate" => {
                let mut facts = input.clone();
                facts["validateOnly"] = Value::Bool(true);
                self.install_plan(&facts)
            }
            "installPlan" => self.install_plan(input),
            "installEnvironment" => {
                let target = self.target(&text(input, "cli"));
                let registry = self
                    .latest
                    .value
                    .as_ref()
                    .map(|v| present(&v["registry"][&target]))
                    .unwrap_or(Value::Null);
                let mut paths = vec![
                    text(input, "path"),
                    "/opt/homebrew/bin".into(),
                    "/usr/local/bin".into(),
                    text(input, "localBin"),
                ];
                paths.retain(|path| !path.is_empty());
                let mut patch = json!({"PATH": paths.join(":")});
                if truthy(&registry) {
                    patch["npm_config_registry"] = registry.clone();
                }
                if target == "codex" {
                    patch["CODEX_NON_INTERACTIVE"] = json!("1");
                }
                json!({"target":target,"registry":registry,"patch":patch})
            }
            "nativeUpgrade" => native_upgrade(
                &text(input, "cmd"),
                &text(input, "real"),
                &text(input, "target"),
                input["sep"].as_str().unwrap_or("/"),
            )
            .map(Value::from)
            .unwrap_or(Value::Null),
            "needsBrewProbe" => {
                Value::Bool(!truthy(&input["nativeUpgrade"]) && npm_global(&text(input, "command")))
            }
            "launch" => self.launch(input),
            "jobEvent" => self.job_event(input),
            "jobRefresh" => self.job_refresh(input),
            "jobVerify" => self.job_verify(input),
            "jobStatus" => {
                if let Some(job) = self.jobs.iter().find(|j| j.data["id"] == input["id"]) {
                    if input["lookupOnly"] == true {
                        return json!({"needAvailability":true});
                    }
                    let cli = text(&job.data, "cli");
                    let available = if truthy(&input["availability"][&cli]) {
                        input["availability"][&cli].clone()
                    } else {
                        json!({"available":false})
                    };
                    response(
                        200,
                        json!({"ok":true,"job":job.public(),"availability":{(cli):available}}),
                    )
                } else {
                    response(404, json!({"ok":false,"error":"job not found"}))
                }
            }
            "installResponse" => {
                let Some(job) = self.jobs.iter().find(|j| j.data["id"] == input["id"]) else {
                    return response(404, json!({"ok":false,"error":"job not found"}));
                };
                let mut body = json!({"ok":true,"jobId":job.data["id"],"cli":job.data["cli"],"command":job.data["command"]});
                if input["kind"] == "upgrade" {
                    body["inUseCount"] = self.counts(&input["active"])
                        [self.target(&text(&job.data, "cli"))]
                    .as_u64()
                    .unwrap_or(0)
                    .into();
                }
                response(202, body)
            }
            "unpinValidate" => {
                let mut facts = input.clone();
                facts["validateOnly"] = Value::Bool(true);
                self.unpin_start(&facts)
            }
            "unpinStart" => self.unpin_start(input),
            "unpinText" => unpin_text(input),
            "unpinResult" => {
                if input["success"] == true {
                    self.invalidate();
                    response(
                        200,
                        json!({"ok":true,"env":input["name"],"previous":input["previous"],"restartRecommended":true}),
                    )
                } else {
                    response(
                        500,
                        json!({"ok":false,"code":"env_write_failed","error":"写入 .env 失败"}),
                    )
                }
            }
            _ => Value::Null,
        }
    }
    fn versions(&self, input: &Value) -> Value {
        let local = &input["local"];
        let upstream = &input["upstream"];
        let baseline = &input["baseline"];
        let counts = self.counts(&input["active"]);
        let mut versions = Map::new();
        let mut update_count = 0;
        for (family, _lane) in self.targets() {
            let mut entry = local["versions"][&family].clone();
            if entry.is_null() {
                entry =
                    json!({"cmd":null,"available":false,"version":null,"error":null,"bundled":[]});
            }
            let bundled_rule = family == "claude" && truthy(baseline);
            let published = normalized_version(if bundled_rule {
                baseline
            } else {
                &upstream["latest"][&family]
            });
            let current = normalized_version(&entry["version"]);
            let update =
                truthy(&current) && truthy(&published) && compare(&current, &published) < 0;
            if update {
                update_count += 1;
            }
            if family == "claude" {
                entry["bundled"] = Value::Array(
                    list(&entry["bundled"])
                        .into_iter()
                        .map(|mut v| {
                            v["cliVersion"] = baseline.clone();
                            v
                        })
                        .collect(),
                );
            }
            entry["latest"] = published;
            entry["updateAvailable"] = Value::Bool(update);
            entry["updateSource"] = if bundled_rule {
                json!("multiCC")
            } else if truthy(&self.config["npmPackages"][&family]) {
                json!("npm")
            } else {
                Value::Null
            };
            entry["latestRegistry"] = present(&upstream["registry"][&family]);
            entry["inUseCount"] = counts[&family].as_u64().unwrap_or(0).into();
            let env = cmd_env(&family).unwrap_or("");
            let value = js_trim(&text(&input["pins"], env)).to_string();
            let cmd = text(&entry, "cmd");
            let real = text(&input["realPaths"], &value);
            entry["pinned"] = if value.is_empty()
                || (!cmd.is_empty() && value != cmd)
                || native_upgrade(&value, &real, &family, input["sep"].as_str().unwrap_or("/"))
                    .is_some()
            {
                Value::Null
            } else {
                json!({"env":env,"path":value})
            };
            versions.insert(family, entry);
        }
        let la = local["at"].as_f64().unwrap_or(0.0);
        let ua = upstream["at"].as_f64().unwrap_or(0.0);
        response(
            200,
            json!({"ok":true,"versions":versions,"cached":truthy(&local["cached"])&&truthy(&upstream["cached"]),"checkedAt":iso(la.max(ua)),"lastCheckedAt":iso(la),"latestCheckedAt":iso(ua),"latestRegistries":upstream["registry"],"updateCount":update_count}),
        )
    }
    fn launch(&mut self, input: &Value) -> Value {
        let cli = text(input, "cli");
        let target = self.target(&cli);
        let spec = &self.config["specs"][&target];
        let base = text(spec, "command");
        let native = text(input, "nativeUpgrade");
        let owner = &input["brewOwner"];
        let command = if !native.is_empty() {
            native
        } else {
            takeover_command(&from_serde(owner), &JsValue::string(&base))
                .map(|command| command.to_string_lossy())
                .unwrap_or(base)
        };
        let registry = self
            .latest
            .value
            .as_ref()
            .map(|v| present(&v["registry"][&target]))
            .unwrap_or(Value::Null);
        let before = self
            .local
            .value
            .as_ref()
            .map(|v| present(&v[&target]["version"]))
            .unwrap_or(Value::Null);
        let expected = self
            .latest
            .value
            .as_ref()
            .map(|v| present(&v["latest"][&target]))
            .unwrap_or(Value::Null);
        let data = json!({"id":input["id"],"cli":cli,"status":"running","command":command,"target":self.target_key(&cli),"startedAt":input["at"],"endedAt":null,"exitCode":null,"error":null,"errorCode":null,"pinnedEnv":null,"hint":null,"registry":registry});
        // Finished history is bounded; active mutex ownership is never evicted.
        while self.jobs.len() >= JOB_CAP {
            let Some(index) = self.jobs.iter().position(|j| !j.running()) else {
                break;
            };
            self.jobs.remove(index);
        }
        self.jobs.push_back(Job {
            data,
            log: JsString::new(),
            before,
            expected,
        });
        json!({"id":input["id"],"cli":cli,"command":command,"timeoutMs":900_000})
    }
    fn job_event(&mut self, input: &Value) -> Value {
        let Some(job) = self.jobs.iter_mut().find(|j| j.data["id"] == input["id"]) else {
            return json!({"accepted":false});
        };
        if !job.running() {
            return json!({"accepted":false});
        }
        let kind = text(input, "kind");
        job.data["endedAt"] = input["at"].clone();
        if kind == "exit" {
            job.data["exitCode"] = input["code"].clone();
            if input["code"] == 0 {
                return json!({"accepted":true,"refresh":true,"cli":job.data["cli"]});
            }
        }
        job.data["status"] = json!("error");
        job.data["error"] = json!(match kind.as_str() {
            "timeout" => "安装超时".into(),
            "spawnError" => format!("安装进程启动失败: {}", text(input, "error")),
            "error" => format!("安装进程异常: {}", text(input, "error")),
            _ =>
                if truthy(&input["signal"]) {
                    format!("安装失败, 信号 {}", text(input, "signal"))
                } else {
                    format!("安装失败, 退出码 {}", js_string(&input["code"]))
                },
        });
        json!({"accepted":true,"kill":kind=="timeout"})
    }
    fn job_refresh(&mut self, input: &Value) -> Value {
        let Some(index) = self.jobs.iter().position(|j| j.data["id"] == input["id"]) else {
            return Value::Null;
        };
        if !self.jobs[index].running() {
            return Value::Null;
        }
        let cli = text(&self.jobs[index].data, "cli");
        let job = &mut self.jobs[index];
        if truthy(&input["availability"][&cli]["available"]) {
            job.data["status"] = json!("done");
            let verify = truthy(&job.before)
                && truthy(&job.expected)
                && compare(&job.before, &job.expected) < 0;
            self.invalidate();
            json!({"verify":verify,"cli":cli})
        } else {
            job.data["status"] = json!("error");
            job.data["error"] =
                json!("安装已完成, 但未在 PATH 找到可执行文件, 请重开终端或手动配置 PATH");
            Value::Null
        }
    }
    fn job_verify(&mut self, input: &Value) -> Value {
        let Some(job) = self.jobs.iter_mut().find(|j| j.data["id"] == input["id"]) else {
            return Value::Null;
        };
        let version = &input["version"];
        let cmd = text(input, "cmd");
        if cmd.is_empty() || !truthy(version) || compare(&job.before, version) != 0 {
            return Value::Null;
        }
        let cli = text(&job.data, "cli");
        let name = cmd_env(&cli)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}_CMD", cli.to_uppercase()));
        let before = s(&job.before);
        job.data["status"] = json!("error");
        if truthy(&input["pins"][&name]) && input["pins"][&name] == cmd {
            job.data["errorCode"] = json!("pinned_target");
            job.data["pinnedEnv"] = json!(name);
            job.data["error"]=json!(format!("升级命令已完成，但 {name} 固定了 {cmd}（v{before}），升级装到了别处，该固定路径没有变化"));
            job.data["hint"]=json!(format!("multicc 派生会话会一直使用 {name} 指向的这份。若想用新版：取消 {name}（改为注释）后重启 multicc，让它自动选择新装的那份；或把 {name} 改指向新装的可执行文件。不要删除被固定的旧安装。"));
        } else {
            job.data["errorCode"] = json!("install_noop");
            job.data["error"] = json!(format!(
                "升级命令已完成，但 multicc 派生的 {cmd} 仍是 v{before}"
            ));
            job.data["hint"]=json!(format!("新版本装到了另一个位置，multicc 实际派生的这个二进制没有变化。解决办法二选一：① 设置环境变量 {name} 指向升级后的可执行文件，然后重启 multicc；② 移除或重命名被派生的旧安装（{cmd}），让 multicc 回退到新装的那一份。"));
        }
        Value::Null
    }
    fn unpin_start(&self, input: &Value) -> Value {
        let requested = js_trim(&text(input, "requested")).to_lowercase();
        if !list(&self.config["supported"])
            .iter()
            .any(|v| v == &requested)
        {
            return response(400, json!({"ok":false,"error":"unsupported cli"}));
        }
        let cli = text(&self.lane(&requested), "canonical");
        let Some(name) = cmd_env(&cli) else {
            return response(400, json!({"ok":false,"error":"unsupported cli"}));
        };
        if input["validateOnly"] == true {
            return json!({"name":name});
        }
        let previous = js_trim(&text(&input["pins"], name)).to_string();
        if previous.is_empty() {
            return response(
                409,
                json!({"ok":false,"code":"not_pinned","error":format!("{name} 未设置，无需处理")}),
            );
        }
        json!({"name":name,"previous":previous})
    }
}
fn set_path(value: &mut JsValue, path: &[&str], replacement: JsValue) {
    if path.is_empty() {
        *value = replacement;
        return;
    }
    if let JsValue::Object(entries) = value {
        if let Some((_, child)) = entries.iter_mut().find(|(key, _)| key == path[0]) {
            set_path(child, &path[1..], replacement);
        }
    }
}
fn unpin_text(input: &Value) -> Value {
    let name = text(input, "name");
    let raw = text(input, "text");
    let mut lines: Vec<_> = raw.split('\n').map(str::to_string).collect();
    let Some(index) = lines
        .iter()
        .position(|line| env_key(line).is_some_and(|key| key == name))
    else {
        return response(
            409,
            json!({"ok":false,"code":"pin_not_in_env_file","error":format!("{name} 不是写在 .env 里的（可能来自系统服务或 shell 环境），multicc 无法代为修改"),"hint":format!("请在设置它的地方（如 launchd plist 的 EnvironmentVariables）移除 {name}，然后重启 multicc。")}),
        );
    };
    lines[index] = format!(
        "# {}  # unpinned by multicc {}",
        js_trim(&lines[index]),
        text(input, "at")
    );
    json!({"text":lines.join("\n")})
}
pub fn official_specs(input: &Value) -> Value {
    let mut out = Map::new();
    if let Some(entries) = input.as_object() {
        for (family, spec) in entries {
            out.insert(
                family.clone(),
                if truthy(&spec["auto"]) {
                    json!({"auto":true,"command":spec["command"],"display":spec["command"]})
                } else {
                    json!({"auto":false,"manual":spec["manual"]})
                },
            );
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn runtime() -> Runtime {
        Runtime::new(json!({
            "supported":["claude","codex","codex-exp"],
            "specs":{"claude":{"auto":true,"command":"npm install -g claude"},"codex":{"auto":true,"command":"install-codex"}},
            "catalog":[
                {"id":"claude","canonical":"claude","family":"claude","terminal":true,"bundled":true,"engines":[]},
                {"id":"codex","canonical":"codex","family":"codex","terminal":true,"bundled":false,"engines":[]},
                {"id":"codex-exp","canonical":"codex-exp","family":"codex","terminal":false,"bundled":false,"engines":[]}
            ]
        }))
    }
    #[test]
    fn native_commands_quote_every_path_byte_instead_of_expanding_shell_syntax() {
        let path = "/home/a'$(touch /tmp/no)`date`/.local/bin/claude";
        assert_eq!(
            native_upgrade(path, path, "claude", "/"),
            Some("'/home/a'\\''$(touch /tmp/no)`date`/.local/bin/claude' update".into())
        );
        assert_eq!(
            native_upgrade("/opt/bin/claude", "/opt/bin/claude", "claude", "/"),
            None
        );
    }
    #[test]
    fn log_ring_preserves_the_low_surrogate_at_a_utf16_tail_boundary() {
        let mut runtime = runtime();
        runtime.data_request("launch", &json!({"id":"j","cli":"claude","at":"start"}));
        let mut text = JsString::from("汉😀");
        text.push_str(&"x".repeat(LOG_CAP - 1));
        runtime.request(
            "jobLog",
            &JsValue::object(vec![
                ("id", JsValue::from("j")),
                ("text", JsValue::String(text)),
            ]),
        );
        let reply = runtime.request(
            "jobStatus",
            &from_serde(&json!({"id":"j","availability":{}})),
        );
        let tail = reply
            .get("response")
            .unwrap()
            .get("body")
            .unwrap()
            .get("job")
            .unwrap()
            .get("logTail")
            .unwrap();
        let JsValue::String(tail) = tail else {
            panic!("string");
        };
        assert_eq!(tail.len(), LOG_CAP);
        assert_eq!(tail.code_unit_at(0), Some(0xde00));
    }
    #[test]
    fn timeout_is_terminal_and_capacity_never_drops_a_running_mutex() {
        let mut runtime = runtime();
        runtime.data_request(
            "launch",
            &json!({"id":"active","cli":"claude","at":"start"}),
        );
        for i in 0..JOB_CAP + 1 {
            let id = format!("done-{i}");
            runtime.data_request("launch", &json!({"id":id,"cli":"codex","at":"start"}));
            runtime.data_request(
                "jobEvent",
                &json!({"id":id,"kind":"error","error":"x","at":"end"}),
            );
        }
        assert!(runtime.running("claude").is_some());
        let blocked =
            runtime.install_plan(&json!({"requested":"claude","kind":"upgrade","availability":{}}));
        assert_eq!(blocked["response"]["status"], 409);
        let timed = runtime.data_request(
            "jobEvent",
            &json!({"id":"active","kind":"timeout","at":"timeout"}),
        );
        assert_eq!(timed["kill"], true);
        for event in [
            json!({"id":"active","kind":"exit","code":0,"at":"late"}),
            json!({"id":"active","kind":"error","error":"late","at":"late"}),
        ] {
            assert_eq!(runtime.data_request("jobEvent", &event)["accepted"], false);
        }
        assert_eq!(
            runtime
                .jobs
                .iter()
                .find(|j| j.data["id"] == "active")
                .unwrap()
                .data["endedAt"],
            "timeout"
        );
    }
    #[test]
    fn unpin_rewrites_only_the_first_uncommented_exact_name_and_failure_keeps_caches() {
        let input = json!({"name":"CLAUDE_CMD","at":"now","text":"# CLAUDE_CMD=old\r\nCLAUDE_CMD=/first\r\nCLAUDE_CMD=/second\r\nOTHER=x\r\n"});
        assert_eq!(unpin_text(&input)["text"],"# CLAUDE_CMD=old\r\n# CLAUDE_CMD=/first  # unpinned by multicc now\nCLAUDE_CMD=/second\r\nOTHER=x\r\n");
        let mut runtime = runtime();
        runtime.local = Cache {
            at: 1.0,
            value: Some(json!({"claude":{"version":"1.0.0"}})),
        };
        assert_eq!(
            runtime.data_request("unpinResult", &json!({"success":false}))["response"]["status"],
            500
        );
        assert!(runtime.local.value.is_some());
        runtime.data_request("unpinResult", &json!({"success":true}));
        assert!(runtime.local.value.is_none());
    }
    #[test]
    fn independent_caches_include_unknown_bundled_versions_and_ascii_version_parsing() {
        let mut runtime = runtime();
        runtime.data_request("bundledCommit", &json!({"now":1,"version":null}));
        assert_eq!(
            runtime.data_request("bundledPlan", &json!({"now":2,"force":false})),
            json!({"cached":true,"version":null})
        );
        assert_eq!(
            runtime.data_request("localPlan", &json!({"now":2,"force":false}))["cached"],
            false
        );
        assert_eq!(
            runtime.data_request("probeVersion", &json!({"stdout":"v１２.３.４"}))["version"],
            Value::Null
        );
        assert_eq!(
            runtime.data_request("probeVersion", &json!({"stdout":"cli v1.2.3-beta"}))["version"],
            "1.2.3-beta"
        );
        assert_eq!(compare(&json!("1.2.3-beta"), &json!("1.2.3")), -1);
    }
}
