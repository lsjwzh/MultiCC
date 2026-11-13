use multicc_core::orchestration_owner::{OwnerClient, OWNER_PROTOCOL_VERSION};
use multicc_core::sqlite::Database;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let nonce = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "multicc-owner-process-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self) -> String {
        self.0.join("state.sqlite").to_string_lossy().into_owned()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn owner(file: &str) -> OwnerClient {
    OwnerClient::spawn(
        Path::new(env!("CARGO_BIN_EXE_multicc-gateway")),
        &json!({"version":OWNER_PROTOCOL_VERSION,"file":file,"now":1,"policy":{}}),
        256 * 1024 * 1024,
    )
    .unwrap()
}

#[test]
fn owner_rejects_stale_transaction_after_external_commit() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut store = owner(&file);
    let db = Database::open(&file, false, true, 5000).unwrap();
    db.exec("INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence,available_at) VALUES('a','{\"id\":\"a\",\"state\":\"pending\",\"sessionId\":\"s\"}','s','pending',1,0)").unwrap();
    let header = store.request("begin", &json!({})).unwrap();
    store
        .request("materialize", &json!({"collection":"outbox","key":"a"}))
        .unwrap();
    db.exec(
        "UPDATE orchestration_outbox SET data_json=json_set(data_json,'$.external',7) WHERE id='a'",
    )
    .unwrap();
    let error = store
        .request(
            "prepare",
            &json!({"expectedRevision":header["revision"],"state":header,"changes":[]}),
        )
        .unwrap_err();
    assert!(
        error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:"),
        "{error}"
    );
    let value = store
        .request("materialize", &json!({"collection":"outbox","key":"a"}))
        .unwrap();
    let row: Value = serde_json::from_str(value["valueJson"].as_str().unwrap()).unwrap();
    assert_eq!(row["external"], 7);
    store.request("close", &json!({})).unwrap();
    assert!(store
        .request("info", &json!({}))
        .unwrap_err()
        .contains("connection lost"));
}

#[test]
fn one_owner_keeps_sessions_independent_and_rejects_stale_writes() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut owner = owner(&file);
    let different = fixture.0.join("different.sqlite");
    assert!(owner
        .open_session(&json!({"version":OWNER_PROTOCOL_VERSION,"file":different,
        "now":1,"policy":{}}))
        .unwrap_err()
        .contains("database mismatch"));
    assert!(!different.exists());
    let second = owner
        .open_session(&json!({"version": OWNER_PROTOCOL_VERSION, "file": file,
        "now": 1, "policy": {}}))
        .unwrap();
    let first_header = owner.request_for(1, "begin", &json!({})).unwrap();
    let second_header = owner.request_for(second, "begin", &json!({})).unwrap();
    let mut state = second_header.clone();
    state["revision"] = json!(1);
    owner.request_for(second, "prepare", &json!({"expectedRevision":second_header["revision"],"state":state,"changes":[
        {"collection":"outbox","key":"b","valueJson":"{\"id\":\"b\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":1,\"availableAt\":0}"}
    ]})).unwrap();
    owner.request_for(second, "commit", &json!({})).unwrap();
    let error = owner
        .request_for(
            1,
            "prepare",
            &json!({"expectedRevision":first_header["revision"],
        "state":first_header,"changes":[]}),
        )
        .unwrap_err();
    assert!(
        error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:"),
        "{error}"
    );
    let snapshot = owner.request_for(second, "begin", &json!({})).unwrap();
    let close_started = Instant::now();
    owner.request_for(1, "close", &json!({})).unwrap();
    assert!(
        close_started.elapsed() < Duration::from_secs(3),
        "closing one session must not wait for another session's read snapshot"
    );
    assert_eq!(snapshot["revision"], 1);
    assert_eq!(
        owner
            .request_for(
                second,
                "materialize",
                &json!({"collection":"outbox","key":"b"})
            )
            .unwrap()["found"],
        true
    );
    owner.request_for(second, "end", &json!({})).unwrap();
    assert_eq!(
        owner.request_for(second, "info", &json!({})).unwrap()["state"]["revision"],
        1
    );
    assert!(owner.request_for(1, "info", &json!({})).is_err());
    owner.request_for(second, "close", &json!({})).unwrap();
    assert!(owner.is_failed());
}

#[test]
fn owner_termination_rolls_back_uncommitted_changes() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut store = owner(&file);
    let header = store.request("begin", &json!({})).unwrap();
    let mut state = header.clone();
    state["revision"] = json!(1);
    store.request("prepare", &json!({"expectedRevision":header["revision"],"state":state,"changes":[
        {"collection":"outbox","key":"a","valueJson":"{\"id\":\"a\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":1,\"availableAt\":0}"}
    ]})).unwrap();
    drop(store);
    let mut reopened = owner(&file);
    let found = reopened
        .request("materialize", &json!({"collection":"outbox","key":"a"}))
        .unwrap();
    assert_eq!(found["found"], false);
    assert_eq!(
        reopened.request("info", &json!({})).unwrap()["state"]["revision"],
        0
    );
    reopened.request("close", &json!({})).unwrap();
}

#[test]
fn transport_failure_abandons_owner_without_replaying_commands() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut store = OwnerClient::spawn(
        Path::new(env!("CARGO_BIN_EXE_multicc-gateway")),
        &json!({"version": OWNER_PROTOCOL_VERSION, "file": file, "now": 1, "policy": {}}),
        1024,
    )
    .unwrap();
    store.request("begin", &json!({})).unwrap();
    let error = store
        .request("info", &json!({"oversize": "x".repeat(2048)}))
        .unwrap_err();
    assert!(error.contains("transport failed"), "{error}");
    let error = store.request("info", &json!({})).unwrap_err();
    assert!(error.contains("owner connection lost"), "{error}");
    let mut reopened = owner(&file);
    assert_eq!(
        reopened.request("info", &json!({})).unwrap()["state"]["revision"],
        0
    );
    reopened.request("close", &json!({})).unwrap();
}

#[test]
fn owner_rolls_back_when_parent_pipe_closes_mid_transaction() {
    fn exchange(input: &mut impl Write, output: &mut impl Read, value: &Value) -> Value {
        let bytes = serde_json::to_vec(value).unwrap();
        input
            .write_all(&(bytes.len() as u64).to_be_bytes())
            .unwrap();
        input.write_all(&bytes).unwrap();
        input.flush().unwrap();
        let mut header = [0; 8];
        output.read_exact(&mut header).unwrap();
        let mut response = vec![0; u64::from_be_bytes(header) as usize];
        output.read_exact(&mut response).unwrap();
        let response: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(response["ok"], true, "{response}");
        response["value"].clone()
    }
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut child = Command::new(env!("CARGO_BIN_EXE_multicc-gateway"))
        .arg("orchestration-owner")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    exchange(
        &mut input,
        &mut output,
        &json!({"version":OWNER_PROTOCOL_VERSION,"file":file,"now":1,"policy":{}}),
    );
    let header = exchange(&mut input, &mut output, &json!({"op":"begin","input":{}}));
    let mut state = header.clone();
    state["revision"] = json!(1);
    exchange(
        &mut input,
        &mut output,
        &json!({"op":"prepare","input":{
            "expectedRevision":header["revision"], "state":state, "changes":[
                {"collection":"outbox","key":"a","valueJson":"{\"id\":\"a\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":1,\"availableAt\":0}"}
            ]
        }}),
    );
    drop(input);
    assert!(child.wait().unwrap().success());
    let mut reopened = owner(&file);
    assert_eq!(
        reopened
            .request("materialize", &json!({"collection":"outbox","key":"a"}))
            .unwrap()["found"],
        false
    );
    reopened.request("close", &json!({})).unwrap();
}
