//! multicc-cdpd：三平台统一的 CDP 网关。
//!
//!   serve                                      常驻（通常由 MultiCC 或下面的命令按需拉起）
//!   cdp '<json>' <目标> [--lane N] [--ttl S]     一次性调用，复用网关里的长连接
//!   endpoint <目标> [--lane N] [--ttl S]         打印给 Puppeteer / Playwright / 脚本用的 ws:// 地址
//!   status | ping | paths                      查看
//!   release --lane N <目标>                     提前结束一个命名 lane
//!   shutdown [--force]                         停止（还有已授权的上游时要 --force）
//!   --version
//!
//! 目标：--ws ws://127.0.0.1:PORT/devtools/browser/ID，或 --active-port <文件|profile 目录|default>
//! （default = 用户日常 Chrome 的 DevToolsActivePort）。

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use multicc_cdpd::ipc;
use multicc_cdpd::paths::{self, Paths};
use multicc_cdpd::wire::{self, LineReader};

const VALUE_FLAGS: [&str; 6] = [
    "--ws",
    "--active-port",
    "--lane",
    "--ttl",
    "--timeout",
    "--approval-timeout",
];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version") {
        println!("{}", multicc_cdpd::version_line());
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let code = runtime.block_on(run(args));
    std::process::exit(code);
}

struct Args {
    positional: Vec<String>,
    values: HashMap<String, String>,
    switches: HashSet<String>,
}

impl Args {
    fn parse(raw: &[String]) -> Result<Self, String> {
        let mut args = Args {
            positional: Vec::new(),
            values: HashMap::new(),
            switches: HashSet::new(),
        };
        let mut index = 0;
        while index < raw.len() {
            let arg = &raw[index];
            if VALUE_FLAGS.contains(&arg.as_str()) {
                let value = raw
                    .get(index + 1)
                    .ok_or_else(|| format!("{arg} needs a value"))?;
                args.values.insert(arg.clone(), value.clone());
                index += 2;
            } else if arg.starts_with("--") {
                args.switches.insert(arg.clone());
                index += 1;
            } else {
                args.positional.push(arg.clone());
                index += 1;
            }
        }
        Ok(args)
    }

    fn value(&self, flag: &str) -> Option<&str> {
        self.values.get(flag).map(String::as_str)
    }

    fn has(&self, flag: &str) -> bool {
        self.switches.contains(flag)
    }

    fn secs(&self, flag: &str, default: u64) -> u64 {
        self.value(flag)
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    }

    /// 目标与 lane 字段，写进请求体。
    fn fill_target(&self, body: &mut Value) -> Result<(), String> {
        match (self.value("--ws"), self.value("--active-port")) {
            (Some(ws), _) => body["wsUrl"] = json!(ws),
            (None, Some(file)) => body["activePort"] = json!(file),
            (None, None) => {
                return Err("pass --ws ws://… or --active-port <file|dir|default>".into())
            }
        }
        if let Some(lane) = self.value("--lane") {
            body["lane"] = json!(lane);
        }
        if let Some(ttl) = self.value("--ttl").and_then(|v| v.parse::<u64>().ok()) {
            body["laneTtlMs"] = json!(ttl.saturating_mul(1000));
        }
        if self.has("--force") {
            body["force"] = json!(true);
        }
        if self.has("--allow-browser-close") {
            body["allowBrowserClose"] = json!(true);
        }
        Ok(())
    }
}

async fn run(raw: Vec<String>) -> i32 {
    let command = raw.first().map(String::as_str).unwrap_or("help");
    let args = match Args::parse(raw.get(1..).unwrap_or(&[])) {
        Ok(args) => args,
        Err(error) => return fail("bad-request", &error),
    };
    let paths = paths::resolve();
    match command {
        "serve" => match multicc_cdpd::daemon::serve(paths).await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("multicc-cdpd: {error}");
                1
            }
        },
        "paths" => {
            println!("{}", paths.to_json());
            0
        }
        "socket" | "--print-socket" => {
            println!("{}", paths.socket.display());
            0
        }
        "ping" => control(&paths, json!({ "op": "ping" })).await,
        "status" => control(&paths, json!({ "op": "status" })).await,
        "shutdown" => {
            control(
                &paths,
                json!({ "op": "shutdown", "force": args.has("--force") }),
            )
            .await
        }
        "release" => {
            let mut body = json!({ "op": "release" });
            if let Err(error) = args.fill_target(&mut body) {
                return fail("bad-request", &error);
            }
            if body.get("lane").is_none() {
                return fail("bad-request", "release needs --lane");
            }
            control(&paths, body).await
        }
        "endpoint" => endpoint(&paths, &args).await,
        "cdp" => one_shot(&paths, &args).await,
        "help" | "--help" | "-h" => {
            usage();
            0
        }
        _ => {
            usage();
            2
        }
    }
}

fn fail(code: &str, detail: &str) -> i32 {
    println!("{}", wire::error_body(code, detail));
    1
}

async fn control(paths: &Paths, body: Value) -> i32 {
    match ipc::request(&paths.socket, &body, Duration::from_secs(5)).await {
        Ok(reply) => {
            println!("{reply}");
            i32::from(reply["ok"] != true)
        }
        Err(error) => fail("unreachable", &error),
    }
}

async fn ping(paths: &Paths) -> bool {
    ipc::request(
        &paths.socket,
        &json!({ "op": "ping" }),
        Duration::from_secs(2),
    )
    .await
    .is_ok_and(|r| r["ok"] == true)
}

/// 没在跑就拉起一个，等它应答。并发拉起是安全的：多出来的那个拿不到锁，自己退出。
async fn ensure_running(paths: &Paths) -> Result<(), String> {
    if ping(paths).await {
        return Ok(());
    }
    spawn_detached(paths).map_err(|e| format!("cannot start multicc-cdpd: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if ping(paths).await {
            return Ok(());
        }
    }
    Err(format!(
        "multicc-cdpd did not come up; see {}",
        paths.log.display()
    ))
}

/// 守护进程活得比调用方久：脱离会话、cwd 放到自己的目录（不钉住某个会被删掉的
/// worktree），环境只带必需的变量（不把调用方的密钥带进一个常驻进程）。
fn spawn_detached(paths: &Paths) -> std::io::Result<()> {
    const KEEP: [&str; 13] = [
        "HOME",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "USERNAME",
        "PATH",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LANG",
        "SystemRoot",
        "SYSTEMROOT",
        "RUST_BACKTRACE",
    ];
    std::fs::create_dir_all(&paths.dir)?;
    let mut command = std::process::Command::new(std::env::current_exe()?);
    command
        .arg("serve")
        .current_dir(&paths.dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env_clear();
    for (key, value) in std::env::vars() {
        if KEEP.contains(&key.as_str()) || key.starts_with("MULTICC_CDP_") {
            command.env(key, value);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid 在 fork 后、exec 前调用，只影响子进程。
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().map(|_| ())
}

async fn endpoint(paths: &Paths, args: &Args) -> i32 {
    let mut target = json!({});
    if let Err(error) = args.fill_target(&mut target) {
        return fail("bad-request", &error);
    }
    if !args.has("--no-start") {
        if let Err(error) = ensure_running(paths).await {
            return fail("unreachable", &error);
        }
    }
    let reply = match ipc::request(
        &paths.socket,
        &json!({ "op": "endpoint" }),
        Duration::from_secs(5),
    )
    .await
    {
        Ok(reply) if reply["ok"] == true => reply,
        Ok(reply) => {
            println!("{reply}");
            return 1;
        }
        Err(error) => return fail("unreachable", &error),
    };
    let mut query = Vec::new();
    for (field, key) in [
        ("wsUrl", "ws"),
        ("activePort", "activePort"),
        ("lane", "lane"),
    ] {
        if let Some(value) = target[field].as_str() {
            query.push(format!("{key}={}", percent_encode(value)));
        }
    }
    if let Some(ttl) = target["laneTtlMs"].as_u64() {
        query.push(format!("ttl={}", ttl / 1000));
    }
    if target["allowBrowserClose"] == true {
        query.push("allowBrowserClose=1".into());
    }
    println!(
        "{}?{}",
        reply["url"].as_str().unwrap_or(""),
        query.join("&")
    );
    0
}

fn percent_encode(raw: &str) -> String {
    raw.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// 一次性命令：发一帧、等它的响应、退出。命名 lane（--lane）让「每个动作一个进程」
/// 的脚本也能跨命令保住 attach 来的 session。
async fn one_shot(paths: &Paths, args: &Args) -> i32 {
    let Some(raw) = args.positional.first() else {
        return fail(
            "bad-request",
            "usage: multicc-cdpd cdp '<json frame>' --ws ws://… | --active-port …",
        );
    };
    let mut frame: Value = match serde_json::from_str(raw) {
        Ok(value @ Value::Object(_)) => value,
        _ => return fail("bad-request", "the frame must be a JSON object"),
    };
    if frame.get("id").is_none() {
        frame["id"] = json!(1);
    }
    let want = frame["id"].clone();
    let mut hello = json!({ "op": "cdp" });
    if let Err(error) = args.fill_target(&mut hello) {
        return fail("bad-request", &error);
    }
    if !args.has("--no-start") {
        if let Err(error) = ensure_running(paths).await {
            return fail("unreachable", &error);
        }
    }
    let connection = match ipc::connect(&paths.socket).await {
        Ok(connection) => connection,
        Err(error) => {
            return fail(
                "unreachable",
                &format!("cannot reach {}: {error}", paths.socket.display()),
            )
        }
    };
    let (reader, mut writer) = tokio::io::split(connection);
    let mut lines = LineReader::new(reader, ipc::MAX_FRAME_BYTES);
    if wire::write_line(&mut writer, &hello.to_string())
        .await
        .is_err()
    {
        return fail("unreachable", "the daemon closed the connection");
    }

    // 等 ready 的时间以网关的审批超时为准（它会回错误）；这里只兜底网关本身卡死。
    let approval_deadline =
        Instant::now() + Duration::from_secs(args.secs("--approval-timeout", 200));
    let mut hinted = false;
    let mut sent = false;
    let mut deadline = approval_deadline;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return fail(
                "cdp-timeout",
                if sent {
                    "no reply to the command"
                } else {
                    "the gateway never became ready"
                },
            );
        }
        let wait = if !sent && !hinted {
            Duration::from_millis(1500).min(deadline - now)
        } else {
            deadline - now
        };
        let line = match tokio::time::timeout(wait, lines.next_line()).await {
            Err(_) => {
                if !sent && !hinted {
                    hinted = true;
                    eprintln!("multicc-cdpd: waiting for Chrome to accept the connection (click Allow if it asks \"Allow remote debugging?\")…");
                }
                continue;
            }
            Ok(Ok(Some(line))) => line,
            Ok(_) => return fail("cdp-upstream-closed", "the daemon closed the connection"),
        };
        let value: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        if value.get("ok").is_some() && value.get("id").is_none() {
            if value["ok"] != true {
                println!("{line}");
                return 1;
            }
            if value["phase"] == "ready" && !sent {
                if wire::write_line(&mut writer, &frame.to_string())
                    .await
                    .is_err()
                {
                    return fail("cdp-upstream-closed", "the daemon closed the connection");
                }
                sent = true;
                deadline = Instant::now() + Duration::from_secs(args.secs("--timeout", 30));
            }
            continue;
        }
        if sent && value.get("id") == Some(&want) {
            println!("{line}");
            return i32::from(value.get("error").is_some());
        }
    }
}

fn usage() {
    println!(
        "usage:
  multicc-cdpd cdp '<json frame>' (--ws URL | --active-port FILE|DIR|default) [--lane NAME] [--ttl SECS] [--timeout SECS] [--force]
  multicc-cdpd endpoint (--ws URL | --active-port FILE|DIR|default) [--lane NAME] [--ttl SECS]
  multicc-cdpd status | ping | paths | --version
  multicc-cdpd release --lane NAME (--ws URL | --active-port …)
  multicc-cdpd shutdown [--force]
  multicc-cdpd serve

Chrome 144+ asks \"Allow remote debugging?\" once per WebSocket connection. The gateway keeps one
approved connection per Chrome and multiplexes every caller over it, so each browser session is
approved once. Each caller gets its own browser session (state and events isolated, cleaned up on
disconnect); a tab opened or attached by one caller cannot be attached or closed by another."
    );
}
