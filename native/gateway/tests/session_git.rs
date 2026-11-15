//! Integration coverage for the 16 session/git routes retired from
//! `src/routes/session-git.js` and answered by the Rust front door
//! (`native/gateway/src/app/session_git.rs`):
//!
//!   GET|HEAD /api/sessions/:id/merge-status
//!   GET|HEAD /api/sessions/:id/diff[/files|/file]
//!   POST     /api/sessions/:id/{merge,sync,rebase}
//!   GET|HEAD /api/git/log
//!   GET|HEAD /api/git/commit-files
//!   GET|HEAD /api/git/commit-diff
//!   GET|HEAD /api/git/directory-file-diff
//!   GET|HEAD /api/git/directory-status
//!   GET|HEAD /api/task-board/tasks/:taskId/diff[/files|/file]
//!   POST     /api/task-board/tasks/:taskId/{merge,cleanup-worktree}
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/session-git` from `FIXTURE_HOST_SCRIPT`
//! and appends every payload to `session-git-calls.jsonl`. Git subprocesses stay
//! in Node by design — the front door only ever sends `{ op: "git", repo, args }`.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const GATEWAY_BIN: &str = env!("CARGO_BIN_EXE_multicc-gateway");
const FIXTURE_JS: &str = include_str!("fixtures/upstream.js");
const TOKEN: &str = "secret-token-1";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-session-git-{}-{tag}-{nanos}",
        std::process::id()
    ))
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|error| {
            panic!(
                "JSON response: {error}; status {} body {:?}",
                self.status, self.body
            )
        })
    }
}

struct Gateway {
    dir: PathBuf,
    state: PathBuf,
    port: u16,
    child: Child,
}

impl Gateway {
    fn start(tag: &str, script: Value) -> Self {
        Self::start_with_env(tag, script, &[])
    }

    fn start_with_env(tag: &str, script: Value, envs: &[(&str, String)]) -> Self {
        let mut last_log = String::new();
        for attempt in 0..6 {
            match Self::start_once(&format!("{tag}-{attempt}"), &script, envs) {
                Ok(gateway) => return gateway,
                Err((log, retryable)) => {
                    last_log = log;
                    if !retryable {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        panic!("gateway never became ready\n{last_log}");
    }

    fn start_once(
        tag: &str,
        script: &Value,
        envs: &[(&str, String)],
    ) -> Result<Self, (String, bool)> {
        let dir = unique(tag);
        let data = dir.join("data");
        let home = dir.join("home");
        let state = dir.join("state");
        for path in [&dir, &data, &home, &state] {
            fs::create_dir_all(path).unwrap();
        }
        let script_path = dir.join("host-script.json");
        fs::write(&script_path, script.to_string()).unwrap();
        fs::write(dir.join("server.js"), FIXTURE_JS).unwrap();
        let port = free_port();
        let log = fs::File::create(dir.join("gateway.log")).unwrap();
        let mut command = Command::new(GATEWAY_BIN);
        command
            .arg("serve")
            .arg("--cwd")
            .arg(&dir)
            .arg("--node")
            .arg(std::env::var("MULTICC_TEST_NODE").unwrap_or_else(|_| "node".to_string()))
            .arg("server.js")
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into()),
            )
            .env("PORT", port.to_string())
            .env("ACCESS_TOKEN", TOKEN)
            .env("HOME", &home)
            .env("MULTICC_DATA_DIR", &data)
            .env("MULTICC_GATEWAY_UPSTREAM_WAIT_MS", "3000")
            .env("MULTICC_GATEWAY_BACKOFF_SCALE", "0.01")
            .env("FIXTURE_MODE", "echo")
            .env("FIXTURE_STATE_DIR", &state)
            .env("FIXTURE_HOST_SCRIPT", &script_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log));
        for (name, value) in envs {
            command.env(name, value);
        }
        for key in [
            "TMPDIR",
            "SystemRoot",
            "SYSTEMROOT",
            "windir",
            "TEMP",
            "TMP",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let child = command.spawn().expect("spawn multicc-gateway");
        let mut gateway = Self {
            dir,
            state,
            port,
            child,
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        while !gateway.state.join("ready").exists() {
            if let Ok(Some(status)) = gateway.child.try_wait() {
                let log = gateway.log();
                let retryable = log.contains("EADDRINUSE") || log.contains("cannot bind");
                return Err((format!("{log}\nchild exited: {status}"), retryable));
            }
            if Instant::now() >= deadline {
                return Err((gateway.log(), false));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(gateway)
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("gateway.log")).unwrap_or_default()
    }

    fn calls(&self, file: &str) -> Vec<Value> {
        fs::read_to_string(self.state.join(file))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn session_git_calls(&self) -> Vec<Value> {
        self.calls("session-git-calls.jsonl")
    }

    fn exchange(
        &self,
        method: &str,
        url: &str,
        body: Option<&str>,
        extra: &[(&str, &str)],
    ) -> Response {
        let mut host = "localhost";
        let mut request_id = "diff-req-1";
        let mut lines = String::new();
        for &(name, value) in extra {
            if name.eq_ignore_ascii_case("host") {
                host = value;
            } else if name.eq_ignore_ascii_case("x-request-id") {
                request_id = value;
            } else {
                lines.push_str(name);
                lines.push_str(": ");
                lines.push_str(value);
                lines.push_str("\r\n");
            }
        }
        let payload = body.unwrap_or("");
        let mut request = format!(
            "{method} {url} HTTP/1.1\r\nHost: {host}\r\nX-Request-Id: {request_id}\r\n{lines}"
        );
        if body.is_some() {
            request.push_str("Content-Type: application/json\r\n");
            request.push_str(&format!("Content-Length: {}\r\n", payload.len()));
        }
        request.push_str("Connection: close\r\n\r\n");
        request.push_str(payload);
        let mut raw = Vec::new();
        for attempt in 0..4 {
            let mut stream = TcpStream::connect(("127.0.0.1", self.port)).expect("connect gateway");
            stream
                .set_read_timeout(Some(Duration::from_secs(30)))
                .unwrap();
            stream.write_all(request.as_bytes()).unwrap();
            raw.clear();
            match stream.read_to_end(&mut raw) {
                Ok(_) => break,
                Err(error)
                    if raw.is_empty()
                        && attempt < 3
                        && matches!(
                            error.kind(),
                            std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionAborted
                                | std::io::ErrorKind::BrokenPipe
                        ) =>
                {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(error) => panic!("gateway exchange failed: {error:?}"),
            }
        }
        let split = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("response headers");
        let head = String::from_utf8_lossy(&raw[..split]);
        let mut lines = head.split("\r\n");
        let status = lines
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())
            .expect("status line");
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect();
        Response {
            status,
            headers,
            body: String::from_utf8_lossy(&raw[split + 4..]).into_owned(),
        }
    }

    fn get(&self, url: &str) -> Response {
        self.exchange("GET", url, None, &[])
    }

    fn head(&self, url: &str) -> Response {
        self.exchange("HEAD", url, None, &[])
    }

    fn options(&self, url: &str) -> Response {
        self.exchange("OPTIONS", url, None, &[])
    }

    fn send(&self, method: &str, url: &str, body: &Value) -> Response {
        self.exchange(method, url, Some(&body.to_string()), &[])
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn assert_key_order(body: &str, keys: &[&str]) {
    let mut last = 0;
    for key in keys {
        let needle = format!("\"{key}\":");
        let index = body
            .find(&needle)
            .unwrap_or_else(|| panic!("missing {key} in {body}"));
        assert!(index >= last, "{key} is out of order in {body}");
        last = index;
    }
}

fn session_facts() -> Value {
    json!({
        "session": {
            "id": "s1",
            "worktreePath": "/repo/wt-s1",
            "branch": "multicc/s1",
            "workspaceState": "active",
        },
        "dir": {"id": "d1", "path": "/repo", "baseBranch": "main"},
        "worktreeExists": true,
    })
}

fn merge_value() -> Value {
    json!({"mergeReady": true, "dirty": false, "ahead": 2, "behind": 1})
}

fn merge_answer() -> Value {
    json!({"value": merge_value()})
}

fn dir_lookup(dir_id: &str, path: &str, base_branch: Option<&str>) -> Value {
    let mut dir = json!({"id": dir_id, "path": path});
    if let Some(branch) = base_branch {
        dir["baseBranch"] = json!(branch);
    }
    json!({
        "session": null,
        "dir": dir,
        "sessionWorktreeExists": false,
        "dirPathExists": true,
    })
}

fn session_lookup(worktree: &str) -> Value {
    json!({
        "session": {"id": "s1", "worktreePath": worktree, "branch": "multicc/s1"},
        "dir": null,
        "sessionWorktreeExists": true,
        "dirPathExists": false,
    })
}

#[test]
fn options_allow_headers_match_the_retired_express_routes() {
    let gateway = Gateway::start("options", json!({}));
    for (url, allow) in [
        ("/api/sessions/s1/merge-status", "GET,HEAD"),
        ("/api/sessions/s1/diff", "GET,HEAD"),
        ("/api/sessions/s1/diff/files", "GET,HEAD"),
        ("/api/sessions/s1/diff/file", "GET,HEAD"),
        ("/api/git/log", "GET,HEAD"),
        ("/api/git/commit-files", "GET,HEAD"),
        ("/api/git/commit-diff", "GET,HEAD"),
        ("/api/git/directory-file-diff", "GET,HEAD"),
        ("/api/git/directory-status", "GET,HEAD"),
        ("/api/task-board/tasks/t1/diff/files", "GET,HEAD"),
        ("/api/task-board/tasks/t1/diff/file", "GET,HEAD"),
        ("/api/task-board/tasks/t1/merge", "POST"),
        ("/api/task-board/tasks/t1/cleanup-worktree", "POST"),
        ("/api/sessions/s1/merge", "POST"),
        ("/api/sessions/s1/sync", "POST"),
        ("/api/sessions/s1/rebase", "POST"),
    ] {
        let response = gateway.options(url);
        assert_eq!(response.status, 200, "{url} {}", response.body);
        assert_eq!(response.header("allow"), Some(allow), "{url}");
    }
    assert!(
        gateway.session_git_calls().is_empty(),
        "OPTIONS never reaches the host port"
    );
}

#[test]
fn merge_status_serves_the_cached_value_and_maps_lookup_errors() {
    let gateway = Gateway::start(
        "merge-status",
        json!({"sessionGit": {
            "sessions": {"s1": session_facts()},
            "mergeState": {"session:s1": merge_answer()},
        }}),
    );
    let response = gateway.get("/api/sessions/s1/merge-status");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json(), merge_value());
    assert_key_order(&response.body, &["mergeReady", "dirty", "ahead", "behind"]);
    assert_eq!(
        gateway.session_git_calls(),
        vec![
            json!({"op": "session", "sessionId": "s1"}),
            json!({"op": "merge-state", "sessionId": "s1", "refresh": false, "priority": true}),
        ]
    );

    // `?refresh=1` (or `?fresh=1`) asks the host for an authoritative read.
    gateway.get("/api/sessions/s1/merge-status?refresh=1");
    gateway.get("/api/sessions/s1/merge-status?fresh=1");
    let calls = gateway.session_git_calls();
    for call in calls.iter().filter(|call| call["refresh"] == json!(true)) {
        assert_eq!(
            call,
            &json!({"op": "merge-state", "sessionId": "s1", "refresh": true, "priority": true})
        );
    }
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["refresh"] == json!(true))
            .count(),
        2
    );

    let missing = gateway.get("/api/sessions/gone/merge-status");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({"error": "session not found"}));
    // A malformed escape never reaches the handler: the front door's request
    // parser refuses it with the shared safe-error DTO (same as the provider
    // cluster), so no `:id` decoding happens here at all.
    let bad = gateway.get("/api/sessions/%E0%A4%A/merge-status");
    assert_eq!(bad.status, 400);
    assert_eq!(bad.json()["code"], json!("request_error"));
    assert_key_order(
        &bad.body,
        &[
            "ok",
            "error",
            "code",
            "apiVersion",
            "requestId",
            "correlationId",
        ],
    );
}

#[test]
fn diff_returns_the_legacy_key_order() {
    let gateway = Gateway::start(
        "diff",
        json!({"sessionGit": {
            "sessions": {"s1": session_facts()},
            "mergeState": {"session:s1": merge_answer()},
            "git": {
                "diff\t--no-color\tmain": {"ok": true, "stdout": "PATCH\n"},
                "diff\t--stat\t--no-color\tmain": {"ok": true, "stdout": " 1 file changed\n"},
            },
        }}),
    );
    let response = gateway.get("/api/sessions/s1/diff");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "baseBranch": "main",
            "branch": "multicc/s1",
            "stat": " 1 file changed\n",
            "diff": "PATCH\n",
            "truncated": false,
            "mergeState": merge_value(),
            "error": null,
        })
    );
    assert_key_order(
        &response.body,
        &[
            "baseBranch",
            "branch",
            "stat",
            "diff",
            "truncated",
            "mergeState",
            "error",
        ],
    );
    assert!(
        gateway.session_git_calls().contains(&json!({
            "op": "git",
            "repo": "/repo/wt-s1",
            "args": ["diff", "--no-color", "main"],
            "maxBuffer": 1064960,
            "raw": false,
        })),
        "{:?}",
        gateway.session_git_calls()
    );
    assert_eq!(gateway.head("/api/sessions/s1/diff").status, 200);
}

#[test]
fn diff_reports_git_failures_and_the_oversize_cap() {
    let failing = Gateway::start(
        "diff-fail",
        json!({"sessionGit": {
            "sessions": {"s1": session_facts()},
            "mergeState": {"session:s1": merge_answer()},
            "git": {"diff\t--no-color\tmain": {
                "ok": false,
                "stderr": "fatal: bad revision",
                "message": "Command failed",
                "maxBuffer": false,
            }},
        }}),
    );
    let response = failing.get("/api/sessions/s1/diff");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["error"], json!("fatal: bad revision"));
    assert_eq!(response.json()["diff"], json!(""));
    assert_eq!(response.json()["truncated"], json!(false));

    let oversize = Gateway::start(
        "diff-cap",
        json!({"sessionGit": {
            "sessions": {"s1": session_facts()},
            "mergeState": {"session:s1": merge_answer()},
            "git": {"diff\t--no-color\tmain": {
                "ok": false,
                "stderr": null,
                "message": "maxBuffer exceeded",
                "maxBuffer": true,
            }},
        }}),
    );
    let response = oversize.get("/api/sessions/s1/diff");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["truncated"], json!(true));
    assert_eq!(
        response.json()["diff"],
        json!("(diff exceeds 1MB cap — too large to display in browser)")
    );
    assert_eq!(response.json()["error"], json!(null));
}

#[test]
fn diff_files_appends_untracked_entries_and_totals() {
    let gateway = Gateway::start(
        "diff-files",
        json!({"sessionGit": {
            "sessions": {"s1": session_facts()},
            "mergeState": {"session:s1": merge_answer()},
            "git": {
                "-c\tcore.quotepath=false\tdiff\t--numstat\t--no-color\t-z\tmain": {
                    "ok": true, "stdout": "3\t1\tsrc/a.js\u{0}",
                },
                "-c\tcore.quotepath=false\tdiff\t--name-status\t--no-color\t-z\tmain": {
                    "ok": true, "stdout": "M\u{0}src/a.js\u{0}",
                },
                "-c\tcore.quotepath=false\tls-files\t--others\t--exclude-standard\t-z": {
                    "ok": true, "stdout": "new.txt\u{0}",
                },
            },
            "facts": {"new.txt": {"additions": 5, "binary": false}},
        }}),
    );
    let response = gateway.get("/api/sessions/s1/diff/files");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "baseBranch": "main",
            "branch": "multicc/s1",
            "files": [
                {
                    "path": "src/a.js", "oldPath": null, "status": "M",
                    "additions": 3, "deletions": 1, "binary": false,
                },
                {
                    "path": "new.txt", "oldPath": null, "status": "U",
                    "additions": 5, "deletions": 0, "binary": false,
                },
            ],
            "totalFiles": 2,
            "totalAdditions": 8,
            "totalDeletions": 1,
            "untrackedCount": 1,
            "truncated": false,
            "mergeState": merge_value(),
            "error": null,
        })
    );
    assert_key_order(
        &response.body,
        &[
            "baseBranch",
            "branch",
            "files",
            "totalFiles",
            "totalAdditions",
            "totalDeletions",
            "untrackedCount",
            "truncated",
            "mergeState",
            "error",
        ],
    );
}

#[test]
fn diff_files_reports_git_errors_and_requires_a_worktree() {
    let failing = Gateway::start(
        "diff-files-fail",
        json!({"sessionGit": {
            "sessions": {"s1": session_facts()},
            "mergeState": {"session:s1": merge_answer()},
            "git": {
                "-c\tcore.quotepath=false\tdiff\t--numstat\t--no-color\t-z\tmain": {
                    "ok": false,
                    "stderr": "fatal: bad merge base",
                    "message": "x",
                    "maxBuffer": false,
                },
            },
        }}),
    );
    let response = failing.get("/api/sessions/s1/diff/files");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["files"], json!([]));
    assert_eq!(response.json()["error"], json!("fatal: bad merge base"));
    assert_eq!(response.json()["totalFiles"], json!(0));

    let missing = Gateway::start(
        "diff-files-wt",
        json!({"sessionGit": {
            "sessions": {"s1": {
                "session": {"id": "s1"},
                "dir": {"id": "d1", "path": "/repo", "baseBranch": "main"},
                "worktreeExists": false,
            }},
        }}),
    );
    let response = missing.get("/api/sessions/s1/diff/files");
    assert_eq!(response.status, 400);
    assert_eq!(response.json(), json!({"error": "worktree missing"}));
}

#[test]
fn diff_file_validates_the_path_and_synthesizes_untracked_patches() {
    let gateway = Gateway::start(
        "diff-file",
        json!({"sessionGit": {
            "sessions": {"s1": session_facts()},
            "git": {
                "diff\t--no-color\tmain\t--\tsrc/a.js": {"ok": true, "stdout": "PATCH\n"},
                "-c\tcore.quotepath=false\tls-files\t--others\t--exclude-standard\t-z": {
                    "ok": true, "stdout": "new.txt\u{0}bin.dat\u{0}",
                },
            },
            "texts": {
                "new.txt": {"exists": true, "binary": false, "text": "alpha\nbeta\n"},
                "bin.dat": {"exists": true, "binary": true, "text": ""},
            },
        }}),
    );
    assert_eq!(
        gateway.get("/api/sessions/s1/diff/file").json(),
        json!({"error": "path required (1..500 chars)"})
    );
    assert_eq!(
        gateway.get("/api/sessions/s1/diff/file?path=-x").json(),
        json!({"error": "path must not start with \"-\""})
    );

    let tracked = gateway.get("/api/sessions/s1/diff/file?path=src%2Fa.js");
    assert_eq!(tracked.status, 200, "{}", tracked.body);
    assert_eq!(
        tracked.json(),
        json!({
            "path": "src/a.js", "patch": "PATCH\n",
            "truncated": false, "error": null, "untracked": false,
        })
    );
    assert_key_order(
        &tracked.body,
        &["path", "patch", "truncated", "error", "untracked"],
    );

    let untracked = gateway.get("/api/sessions/s1/diff/file?path=new.txt");
    assert_eq!(untracked.status, 200, "{}", untracked.body);
    assert_eq!(
        untracked.json(),
        json!({
            "path": "new.txt",
            "patch": "diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+alpha\n+beta",
            "truncated": false,
            "error": null,
            "untracked": true,
        })
    );
    let binary = gateway.get("/api/sessions/s1/diff/file?path=bin.dat");
    assert_eq!(binary.status, 200, "{}", binary.body);
    assert_eq!(
        binary.json()["patch"],
        json!("Binary files /dev/null and b/bin.dat differ")
    );
    assert_eq!(binary.json()["untracked"], json!(true));
}

#[test]
fn git_log_parses_the_scripted_repository() {
    let gateway = Gateway::start(
        "git-log",
        json!({"sessionGit": {
            "lookups": {
                "s1|": session_lookup("/repo/wt-s1"),
                "|d1": dir_lookup("d1", "/repo", None),
                "|d9": {
                    "session": null,
                    "dir": {"id": "d9", "path": "/gone"},
                    "sessionWorktreeExists": false,
                    "dirPathExists": false,
                },
            },
            "git": {"log": {"ok": true, "stdout": "h1\u{0}abc1234\u{0}Ann\u{0}2026-01-01T00:00:00Z\u{0}first\u{0}, HEAD -> main, origin/main\n"}},
        }}),
    );
    let response = gateway.get("/api/git/log?sessionId=s1");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "commits": [{
                "hash": "h1",
                "short": "abc1234",
                "author": "Ann",
                "date": "2026-01-01T00:00:00Z",
                "subject": "first",
                "refs": "HEAD -> main, origin/main",
            }],
            "repoPath": "/repo/wt-s1",
        })
    );
    assert_key_order(&response.body, &["commits", "repoPath"]);

    let paged = gateway.get("/api/git/log?dirId=d1&limit=5&all=1");
    assert_eq!(paged.status, 200, "{}", paged.body);
    assert_eq!(paged.json()["repoPath"], json!("/repo"));
    let log_call = gateway
        .session_git_calls()
        .into_iter()
        .find(|call| call["args"][0] == json!("log") && call["repo"] == json!("/repo"))
        .expect("directory log call");
    assert_eq!(log_call["args"][1], json!("-5"));
    assert_eq!(
        log_call["args"].as_array().unwrap().last(),
        Some(&json!("--all"))
    );

    assert_eq!(
        gateway.get("/api/git/log").json(),
        json!({"error": "dirId or sessionId required"})
    );
    assert_eq!(
        gateway.get("/api/git/log?dirId=d9").json(),
        json!({"error": "repo path missing"})
    );
    assert_eq!(
        gateway.get("/api/git/log?dirId=dz").json(),
        json!({"error": "directory not found"})
    );

    let failing = Gateway::start(
        "git-log-fail",
        json!({"sessionGit": {
            "lookups": {"s1|": session_lookup("/repo/wt-s1")},
            "git": {"log": {
                "ok": false,
                "stderr": "fatal: not a git repository",
                "message": "x",
                "maxBuffer": false,
            }},
        }}),
    );
    let response = failing.get("/api/git/log?sessionId=s1");
    assert_eq!(response.status, 500);
    assert_eq!(
        response.json(),
        json!({"error": "fatal: not a git repository"})
    );
}

#[test]
fn commit_files_parses_name_status_and_validates_the_hash() {
    let gateway = Gateway::start(
        "commit-files",
        json!({"sessionGit": {
            "lookups": {"s1|": session_lookup("/repo/wt-s1")},
            "git": {"show": {"ok": true, "stdout": "M\u{0}README.md\u{0}R100\u{0}old name.txt\u{0}new name.txt\u{0}"}},
        }}),
    );
    let response = gateway.get("/api/git/commit-files?sessionId=s1&hash=abc123");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "hash": "abc123",
            "files": [
                {"status": "M", "path": "README.md"},
                {"status": "R100", "oldPath": "old name.txt", "path": "new name.txt"},
            ],
        })
    );
    assert_key_order(&response.body, &["hash", "files"]);
    assert_eq!(
        gateway
            .get("/api/git/commit-files?sessionId=s1&hash=zz")
            .json(),
        json!({"error": "invalid hash"})
    );
    assert_eq!(
        gateway
            .get("/api/git/commit-files?sessionId=gone&hash=abc123")
            .json(),
        json!({"error": "repo not found"})
    );
}

#[test]
fn commit_diff_orders_path_between_hash_and_stat() {
    let gateway = Gateway::start(
        "commit-diff",
        json!({"sessionGit": {
            "lookups": {"|d1": dir_lookup("d1", "/repo", Some("main"))},
            "git": {
                "show\t--format=\t--name-status\t-z\t--root\t--first-parent\t--no-color\tabcdef": {
                    "ok": true, "stdout": "M\u{0}src/a.js\u{0}",
                },
                "show\t--format=\t--patch\t--root\t--first-parent\t--no-color\t--no-ext-diff\t--no-textconv\tabcdef\t--\t:(literal)src/a.js": {
                    "ok": true, "stdout": "PATCH\n",
                },
            },
        }}),
    );
    let response = gateway.get("/api/git/commit-diff?dirId=d1&hash=abcdef&file=src/a.js");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "hash": "abcdef", "path": "src/a.js", "stat": "",
            "diff": "PATCH\n", "truncated": false, "error": null,
        })
    );
    assert_key_order(
        &response.body,
        &["hash", "path", "stat", "diff", "truncated", "error"],
    );
    assert_eq!(
        gateway
            .get("/api/git/commit-diff?dirId=d1&hash=abcdef&file=")
            .json(),
        json!({"error": "invalid file"})
    );
    assert_eq!(
        gateway
            .get("/api/git/commit-diff?dirId=d1&hash=abcdef&file=other.js")
            .json(),
        json!({"error": "file not found in commit"})
    );
}

#[test]
fn commit_diff_without_file_falls_back_to_the_parent_patch() {
    let gateway = Gateway::start(
        "commit-diff-nofile",
        json!({"sessionGit": {
            "lookups": {"|d1": dir_lookup("d1", "/repo", Some("main"))},
            "git": {
                "show\t--format=\t--patch\tabcdef": {"ok": true, "stdout": ""},
                "rev-parse\t--verify\t--quiet\tabcdef~1": {"ok": true, "stdout": "parent"},
                "diff\t--patch\tabcdef~1\tabcdef": {"ok": true, "stdout": "DIFF\n"},
                "show\t--format=\t--stat\tabcdef": {"ok": true, "stdout": " STAT\n"},
            },
        }}),
    );
    let response = gateway.get("/api/git/commit-diff?dirId=d1&hash=abcdef");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "hash": "abcdef", "stat": " STAT\n", "diff": "DIFF\n",
            "truncated": false, "error": null,
        })
    );
    assert_key_order(
        &response.body,
        &["hash", "stat", "diff", "truncated", "error"],
    );
    assert!(!response.body.contains("\"path\""), "{}", response.body);

    let root = Gateway::start(
        "commit-diff-root",
        json!({"sessionGit": {
            "lookups": {"|d1": dir_lookup("d1", "/repo", Some("main"))},
            "git": {
                "show": {"ok": true, "stdout": ""},
                "rev-parse": {
                    "ok": false,
                    "stderr": "fatal: bad revision",
                    "message": "x",
                    "maxBuffer": false,
                },
            },
        }}),
    );
    let response = root.get("/api/git/commit-diff?dirId=d1&hash=abcdef");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["diff"], json!(""));
    assert_eq!(response.json()["error"], json!(null));
}

#[test]
fn directory_file_diff_validates_inputs_and_falls_back() {
    let gateway = Gateway::start(
        "dir-file-diff",
        json!({"sessionGit": {
            "lookups": {
                "|d1": dir_lookup("d1", "/repo", Some("main")),
                "|d9": {
                    "session": null,
                    "dir": {"id": "d9", "path": "/gone"},
                    "sessionWorktreeExists": false,
                    "dirPathExists": false,
                },
            },
            "git": {
                "diff\t--no-color\tHEAD\t--\tsrc/a.js": {"ok": true, "stdout": "PATCH\n"},
                "diff\t--no-color\tHEAD\t--\tfb.js": {
                    "ok": false,
                    "stderr": "fatal: bad object HEAD",
                    "message": "x",
                    "maxBuffer": false,
                },
                "diff\t--no-color\t--\tfb.js": {"ok": true, "stdout": "FB\n"},
            },
        }}),
    );
    assert_eq!(
        gateway.get("/api/git/directory-file-diff").json(),
        json!({"error": "dirId required"})
    );
    assert_eq!(
        gateway.get("/api/git/directory-file-diff?dirId=d1").json(),
        json!({"error": "invalid path"})
    );
    assert_eq!(
        gateway
            .get("/api/git/directory-file-diff?dirId=d1&path=../x")
            .json(),
        json!({"error": "invalid path"})
    );
    assert_eq!(
        gateway
            .get("/api/git/directory-file-diff?dirId=d9&path=a.js")
            .json(),
        json!({"error": "repo path missing"})
    );

    let tracked = gateway.get("/api/git/directory-file-diff?dirId=d1&path=src%2Fa.js");
    assert_eq!(tracked.status, 200, "{}", tracked.body);
    assert_eq!(
        tracked.json(),
        json!({
            "path": "src/a.js", "patch": "PATCH\n",
            "truncated": false, "error": null, "untracked": false,
        })
    );
    assert_key_order(
        &tracked.body,
        &["path", "patch", "truncated", "error", "untracked"],
    );

    let fallback = gateway.get("/api/git/directory-file-diff?dirId=d1&path=fb.js");
    assert_eq!(fallback.status, 200, "{}", fallback.body);
    assert_eq!(fallback.json()["patch"], json!("FB\n"));
    assert_eq!(fallback.json()["error"], json!(null));
}

#[test]
fn directory_status_renders_the_repository_state() {
    let gateway = Gateway::start(
        "dir-status",
        json!({"sessionGit": {
            "lookups": {"|d1": dir_lookup("d1", "/repo", Some("main"))},
            "git": {
                "rev-parse\t--abbrev-ref\tHEAD": {"ok": true, "stdout": "main\n"},
                "rev-parse\t--abbrev-ref\t--symbolic-full-name\t@{upstream}": {
                    "ok": true, "stdout": "origin/main\n",
                },
                "rev-list\t--count\torigin/main..HEAD": {"ok": true, "stdout": "3\n"},
                "rev-list\t--count\tHEAD..origin/main": {"ok": true, "stdout": "2\n"},
                "status\t--porcelain": {
                    "ok": true,
                    "stdout": " M src/a.js\n?? new.txt\n?? .multicc-worktrees/x\nR  old -> new\n\n",
                },
            },
        }}),
    );
    let response = gateway.get("/api/git/directory-status?dirId=d1");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "branch": "main",
            "upstream": "origin/main",
            "baseBranch": "main",
            "ahead": 3,
            "behind": 2,
            "dirtyFiles": [
                {"status": "M", "path": "src/a.js"},
                {"status": "??", "path": "new.txt"},
                {"status": "R", "path": "old → new"},
            ],
        })
    );
    assert_key_order(
        &response.body,
        &[
            "branch",
            "upstream",
            "baseBranch",
            "ahead",
            "behind",
            "dirtyFiles",
        ],
    );

    let plain = Gateway::start(
        "dir-status-plain",
        json!({"sessionGit": {
            "lookups": {"|d2": dir_lookup("d2", "/plain", None)},
            "git": {
                "rev-parse\t--abbrev-ref\tHEAD": {"ok": true, "stdout": "dev\n"},
                "rev-parse\t--abbrev-ref\t--symbolic-full-name\t@{upstream}": {
                    "ok": false,
                    "stderr": "fatal: no upstream",
                    "message": "x",
                    "maxBuffer": false,
                },
                "rev-list\t--count\tmain..HEAD": {"ok": true, "stdout": "0\n"},
                "rev-list\t--count\tHEAD..main": {"ok": true, "stdout": "0\n"},
            },
        }}),
    );
    let response = plain.get("/api/git/directory-status?dirId=d2");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["upstream"], json!(null));
    assert_eq!(response.json()["baseBranch"], json!("main"));
    assert_eq!(
        plain.get("/api/git/directory-status").json(),
        json!({"error": "dirId required"})
    );
    assert_eq!(
        plain.get("/api/git/directory-status?dirId=d9").json(),
        json!({"error": "directory not found"})
    );

    let broken = Gateway::start(
        "dir-status-fail",
        json!({"sessionGit": {
            "lookups": {"|d1": dir_lookup("d1", "/repo", Some("main"))},
            "git": {"rev-parse": {
                "ok": false,
                "stderr": "fatal: not a repo",
                "message": "x",
                "maxBuffer": false,
            }},
        }}),
    );
    let response = broken.get("/api/git/directory-status?dirId=d1");
    assert_eq!(response.status, 500);
    assert_eq!(response.json(), json!({"error": "fatal: not a repo"}));
}

#[test]
fn task_diff_routes_resolve_the_board_worktree() {
    let task = json!({
        "dir": {"id": "d1", "path": "/repo", "baseBranch": "main"},
        "worktreePath": "/repo/wt-t1",
        "branch": "task/t1",
        "token": "t1",
    });
    let gateway = Gateway::start(
        "task-diff",
        json!({"sessionGit": {
            "tasks": {"t1": task},
            "mergeState": {"task:t1": merge_answer()},
            "git": {
                "-c\tcore.quotepath=false\tdiff\t--numstat\t--no-color\t-z\tmain": {
                    "ok": true, "stdout": "1\t0\tsrc/a.js\u{0}",
                },
                "-c\tcore.quotepath=false\tdiff\t--name-status\t--no-color\t-z\tmain": {
                    "ok": true, "stdout": "A\u{0}src/a.js\u{0}",
                },
            },
        }}),
    );
    let response = gateway.get("/api/task-board/tasks/t1/diff/files");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["branch"], json!("task/t1"));
    assert_eq!(
        response.json()["files"],
        json!([{
            "path": "src/a.js", "oldPath": null, "status": "A",
            "additions": 1, "deletions": 0, "binary": false,
        }])
    );
    assert_eq!(response.json()["mergeState"], merge_value());
    assert_key_order(
        &response.body,
        &[
            "baseBranch",
            "branch",
            "files",
            "totalFiles",
            "totalAdditions",
            "totalDeletions",
            "untrackedCount",
            "truncated",
            "mergeState",
            "error",
        ],
    );
    assert!(gateway.session_git_calls().contains(&json!({
        "op": "merge-state", "taskId": "t1", "refresh": false, "priority": false,
    })));

    let file = gateway.get("/api/task-board/tasks/t1/diff/file?path=src%2Fa.js");
    assert_eq!(file.status, 200, "{}", file.body);
    assert_eq!(file.json()["path"], json!("src/a.js"));
    assert_eq!(
        gateway.get("/api/task-board/tasks/t1/diff/file").json(),
        json!({"error": "path required (1..500 chars)"})
    );
    assert_eq!(
        gateway.get("/api/task-board/tasks/gone/diff/files").json(),
        json!({"error": "task_not_found"})
    );

    let removed = Gateway::start(
        "task-diff-removed",
        json!({"sessionGit": {
            "tasks": {"t1": {
                "dir": {"id": "d1", "path": "/repo", "baseBranch": "main"},
                "worktreePath": "/repo/wt-t1",
                "branch": "task/t1",
                "worktreeExists": false,
            }},
        }}),
    );
    assert_eq!(
        removed.get("/api/task-board/tasks/t1/diff/files").json(),
        json!({"error": "worktree missing"})
    );
}

#[test]
fn task_merge_maps_the_host_flow_outcomes() {
    let task = |id: &str| {
        json!({
            "dir": {"id": "d1", "path": "/repo", "baseBranch": "main"},
            "worktreePath": format!("/repo/wt-{id}"),
            "branch": format!("task/{id}"),
            "token": id,
        })
    };
    let gateway = Gateway::start(
        "task-merge",
        json!({"sessionGit": {
            "tasks": {
                "t1": task("t1"),
                "t2": task("t2"),
                "t3": task("t3"),
                "t4": task("t4"),
                "t5": task("t5"),
                "t6": {
                    "dir": {"id": "d1", "path": "/repo", "baseBranch": "main"},
                    "worktreePath": "/repo/wt-t6",
                    "branch": "task/t6",
                    "worktreeExists": false,
                },
            },
            "flows": {
                "task-merge:t1": {"missing": true},
                "task-merge:t2": {"result": {"ok": false, "conflicts": ["a.js"]}},
                "task-merge:t3": {"error": {"code": "SESSION_ACTIVE", "message": "busy", "operationId": "op-1"}},
                "task-merge:t4": {"result": {"ok": true, "merged": true, "commits": 2}},
                "task-merge:t5": {"error": {"message": "boom"}},
            },
        }}),
    );
    let missing = gateway.send("POST", "/api/task-board/tasks/t1/merge", &json!({}));
    assert_eq!(missing.status, 404, "{}", missing.body);
    assert_eq!(missing.json(), json!({"error": "task_not_found"}));

    let conflicts = gateway.send("POST", "/api/task-board/tasks/t2/merge", &json!({}));
    assert_eq!(conflicts.status, 409, "{}", conflicts.body);
    assert_eq!(
        conflicts.json(),
        json!({"ok": false, "conflicts": ["a.js"]})
    );

    let blocked = gateway.send("POST", "/api/task-board/tasks/t3/merge", &json!({}));
    assert_eq!(blocked.status, 400, "{}", blocked.body);
    assert_eq!(
        blocked.json(),
        json!({
            "ok": false, "blocked": true, "reasons": ["active"],
            "operationId": "op-1", "error": "busy",
        })
    );
    assert_key_order(
        &blocked.body,
        &["ok", "blocked", "reasons", "operationId", "error"],
    );

    let ok = gateway.send("POST", "/api/task-board/tasks/t4/merge", &json!({}));
    assert_eq!(ok.status, 200, "{}", ok.body);
    assert_eq!(ok.json(), json!({"ok": true, "merged": true, "commits": 2}));
    assert!(gateway.session_git_calls().contains(&json!({
        "op": "task-merge", "taskId": "t4",
    })));

    let generic = gateway.send("POST", "/api/task-board/tasks/t5/merge", &json!({}));
    assert_eq!(generic.status, 500, "{}", generic.body);
    assert_eq!(
        generic.json(),
        json!({"ok": false, "code": "git_operation_failed", "error": "Git operation failed"})
    );

    let gone = gateway.send("POST", "/api/task-board/tasks/t6/merge", &json!({}));
    assert_eq!(gone.status, 400, "{}", gone.body);
    assert_eq!(gone.json(), json!({"error": "任务 worktree 不存在"}));
}

#[test]
fn task_cleanup_maps_the_host_flow_outcomes_and_forwards_force() {
    let task = |id: &str| {
        json!({
            "dir": {"id": "d1", "path": "/repo", "baseBranch": "main"},
            "worktreePath": format!("/repo/wt-{id}"),
            "branch": format!("task/{id}"),
            "token": id,
        })
    };
    let gateway = Gateway::start(
        "task-cleanup",
        json!({"sessionGit": {
            "tasks": {"t1": task("t1"), "t2": task("t2"), "t3": task("t3"), "t4": task("t4")},
            "flows": {
                "task-cleanup:t1": {"result": null},
                "task-cleanup:t2": {"result": {"ok": false, "blocked": true}},
                "task-cleanup:t3": {"result": {"ok": false, "code": "task_not_found"}},
                "task-cleanup:t4": {"result": {"ok": true, "removed": true}},
            },
        }}),
    );
    let failed = gateway.send(
        "POST",
        "/api/task-board/tasks/t1/cleanup-worktree",
        &json!({}),
    );
    assert_eq!(failed.status, 400, "{}", failed.body);
    assert_eq!(failed.json(), json!({"error": "cleanup_failed"}));

    let blocked = gateway.send(
        "POST",
        "/api/task-board/tasks/t2/cleanup-worktree",
        &json!({}),
    );
    assert_eq!(blocked.status, 409, "{}", blocked.body);
    assert_eq!(blocked.json(), json!({"ok": false, "blocked": true}));

    let missing = gateway.send(
        "POST",
        "/api/task-board/tasks/t3/cleanup-worktree",
        &json!({}),
    );
    assert_eq!(missing.status, 404, "{}", missing.body);
    assert_eq!(missing.json(), json!({"error": "task_not_found"}));

    let ok = gateway.send(
        "POST",
        "/api/task-board/tasks/t4/cleanup-worktree",
        &json!({"force": true}),
    );
    assert_eq!(ok.status, 200, "{}", ok.body);
    assert_eq!(ok.json(), json!({"ok": true, "removed": true}));
    let calls = gateway.session_git_calls();
    assert!(calls.contains(&json!({"op": "task-cleanup", "taskId": "t4", "force": true})));
    assert!(calls.contains(&json!({"op": "task-cleanup", "taskId": "t1", "force": false})));

    let gone = gateway.send(
        "POST",
        "/api/task-board/tasks/gone/cleanup-worktree",
        &json!({}),
    );
    assert_eq!(gone.status, 404, "{}", gone.body);
    assert_eq!(gone.json(), json!({"error": "task_not_found"}));
}

#[test]
fn session_merge_maps_worktree_and_failure_outcomes() {
    let gateway = Gateway::start(
        "session-merge",
        json!({"sessionGit": {
            "sessions": {
                "s1": session_facts(),
                "s2": {
                    "session": {"id": "s2"},
                    "dir": {"id": "d1", "path": "/repo", "baseBranch": "main"},
                    "worktreeExists": true,
                },
                "s3": {
                    "session": {
                        "id": "s3", "worktreePath": "/repo/wt-s3",
                        "branch": "multicc/s3", "workspaceState": "hibernated",
                    },
                    "dir": {"id": "d1", "path": "/repo", "baseBranch": "main"},
                    "worktreeExists": false,
                },
                "s4": {
                    "session": {"id": "s4", "worktreePath": "/repo/wt-s4", "branch": "multicc/s4"},
                    "dir": {"id": "d1", "path": "/repo", "baseBranch": "main"},
                    "worktreeExists": true,
                },
                "s5": {
                    "session": {"id": "s5", "worktreePath": "/repo/wt-s5", "branch": "multicc/s5"},
                    "dir": {"id": "d1", "path": "/repo", "baseBranch": "main"},
                    "worktreeExists": true,
                },
            },
            "flows": {
                "session-merge:s1": {"error": {
                    "code": "SESSION_LEASED", "message": "leased", "queueDepth": 2,
                }},
                "session-merge:s4": {"result": {"ok": false, "code": "git_operation_failed"}},
                "session-merge:s5": {"result": {"ok": true, "merged": true, "commits": 1}},
            },
        }}),
    );
    let blocked = gateway.send("POST", "/api/sessions/s1/merge", &json!({}));
    assert_eq!(blocked.status, 400, "{}", blocked.body);
    assert_eq!(
        blocked.json(),
        json!({
            "ok": false, "blocked": true, "reasons": ["leased"],
            "queueDepth": 2, "error": "leased",
        })
    );
    assert_key_order(
        &blocked.body,
        &["ok", "blocked", "reasons", "queueDepth", "error"],
    );

    let no_worktree = gateway.send("POST", "/api/sessions/s2/merge", &json!({}));
    assert_eq!(no_worktree.status, 400);
    assert_eq!(
        no_worktree.json(),
        json!({"error": "该会话没有 worktree，无需合并"})
    );

    let hibernated = gateway.send("POST", "/api/sessions/s3/merge", &json!({}));
    assert_eq!(hibernated.status, 409, "{}", hibernated.body);
    assert_eq!(
        hibernated.json(),
        json!({
            "ok": false, "blocked": true, "code": "workspace_hibernated",
            "reasons": ["hibernated"], "workspaceState": "hibernated",
            "error": "工作区已休眠；发送消息后会自动恢复",
        })
    );

    // A flow result is echoed verbatim; only a thrown host error is folded into
    // the generic `failedGitResult` DTO.
    let generic = gateway.send("POST", "/api/sessions/s4/merge", &json!({}));
    assert_eq!(generic.status, 500, "{}", generic.body);
    assert_eq!(
        generic.json(),
        json!({"ok": false, "code": "git_operation_failed"})
    );

    let ok = gateway.send("POST", "/api/sessions/s5/merge", &json!({}));
    assert_eq!(ok.status, 200, "{}", ok.body);
    assert_eq!(ok.json(), json!({"ok": true, "merged": true, "commits": 1}));
    assert!(gateway
        .session_git_calls()
        .contains(&json!({"op": "session-merge", "sessionId": "s5"})));
}

#[test]
fn session_sync_blocks_on_the_gate_unless_forced() {
    let busy = Gateway::start(
        "sync-busy",
        json!({"sessionGit": {
            "sessions": {"s1": session_facts()},
            "syncGate": {"active": true, "classifyState": "D"},
        }}),
    );
    let response = busy.send("POST", "/api/sessions/s1/sync", &json!({}));
    assert_eq!(response.status, 409, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "ok": false, "blocked": true, "reasons": ["busy"],
            "classifyState": "running",
            "error": "会话正在执行任务（进程运行中），请等待本轮结束后再同步",
        })
    );
    assert!(
        !busy
            .session_git_calls()
            .iter()
            .any(|call| call["op"] == json!("session-sync")),
        "a gated sync never reaches git"
    );

    let state = Gateway::start(
        "sync-p",
        json!({"sessionGit": {
            "sessions": {"s1": session_facts()},
            "syncGate": {"active": false, "classifyState": "P"},
        }}),
    );
    let response = state.send("POST", "/api/sessions/s1/sync", &json!({}));
    assert_eq!(response.status, 409, "{}", response.body);
    assert_eq!(response.json()["classifyState"], json!("P"));
    assert_eq!(
        response.json()["error"],
        json!("会话任务未结束（处理中，状态 P），请等待任务完成/暂停后再同步")
    );

    let forced = Gateway::start(
        "sync-force",
        json!({"sessionGit": {
            "sessions": {"s1": session_facts()},
            "syncGate": {"active": true, "classifyState": "P"},
            "flows": {"session-sync:s1": {"result": {"ok": true, "merged": false, "commits": 0}}},
        }}),
    );
    let response = forced.send("POST", "/api/sessions/s1/sync?force=1", &json!({}));
    assert_eq!(response.status, 200, "{}", response.body);
    assert!(forced
        .session_git_calls()
        .iter()
        .any(|call| call["op"] == json!("session-sync") && call["force"] == json!(true)));

    let conflicts = Gateway::start(
        "sync-conflicts",
        json!({"sessionGit": {
            "sessions": {"s1": session_facts()},
            "flows": {"session-sync:s1": {"result": {"ok": false, "conflicts": ["a.js"]}}},
        }}),
    );
    let response = conflicts.send("POST", "/api/sessions/s1/sync", &json!({}));
    assert_eq!(response.status, 409, "{}", response.body);
    assert_eq!(response.json(), json!({"ok": false, "conflicts": ["a.js"]}));

    let failed = Gateway::start(
        "sync-fail",
        json!({"sessionGit": {
            "sessions": {"s1": session_facts()},
            "flows": {"session-sync:s1": {"error": {"message": "lease lost"}}},
        }}),
    );
    let response = failed.send("POST", "/api/sessions/s1/sync", &json!({}));
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({"ok": false, "blocked": true, "reasons": ["leased"], "error": "lease lost"})
    );
}

#[test]
fn session_rebase_forwards_the_action_and_maps_failures() {
    let gateway = Gateway::start(
        "rebase",
        json!({"sessionGit": {
            "sessions": {
                "s1": session_facts(),
                "s2": {
                    "session": {"id": "s2", "worktreePath": "/repo/wt-s2", "branch": "multicc/s2"},
                    "dir": {"id": "d1", "path": "/repo", "baseBranch": "main"},
                    "worktreeExists": true,
                },
            },
            "flows": {
                "session-rebase:s1": {"result": {"ok": true, "done": true}},
                "session-rebase:s2": {"error": {"code": "SESSION_ACTIVE", "message": "busy"}},
            },
        }}),
    );
    let response = gateway.send(
        "POST",
        "/api/sessions/s1/rebase?force=1",
        &json!({"action": "abort"}),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json(), json!({"ok": true, "done": true}));
    assert!(gateway.session_git_calls().contains(&json!({
        "op": "session-rebase", "sessionId": "s1", "action": "abort", "force": true,
    })));

    let blocked = gateway.send(
        "POST",
        "/api/sessions/s2/rebase",
        &json!({"action": "continue"}),
    );
    assert_eq!(blocked.status, 400, "{}", blocked.body);
    assert_eq!(
        blocked.json(),
        json!({"ok": false, "blocked": true, "reasons": ["active"], "error": "busy"})
    );
    assert!(gateway.session_git_calls().contains(&json!({
        "op": "session-rebase", "sessionId": "s2", "action": "continue", "force": false,
    })));

    let no_worktree = Gateway::start(
        "rebase-wt",
        json!({"sessionGit": {
            "sessions": {"s1": {
                "session": {"id": "s1"},
                "dir": {"id": "d1", "path": "/repo", "baseBranch": "main"},
                "worktreeExists": true,
            }},
        }}),
    );
    assert_eq!(
        no_worktree
            .send("POST", "/api/sessions/s1/rebase", &json!({}))
            .json(),
        json!({"error": "该会话没有 worktree"})
    );
}

#[test]
fn a_dead_host_answers_the_feature_unavailable_face() {
    let gateway = Gateway::start("down", json!({"hostDown": true}));
    let response = gateway.get("/api/sessions/s1/merge-status");
    assert_eq!(response.status, 503, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "error": "会话 Git 接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        })
    );
    let write = gateway.send("POST", "/api/sessions/s1/merge", &json!({}));
    assert_eq!(write.status, 503, "{}", write.body);
    assert_eq!(write.json()["code"], json!("rust_backend_unavailable"));
}
