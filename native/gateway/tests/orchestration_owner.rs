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
fn metadata_pages_are_bounded_private_and_tied_to_a_snapshot() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut store = owner(&file);
    let db = Database::open(&file, false, true, 5000).unwrap();
    db.exec(
        "INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence) VALUES\
        ('a','{\"id\":\"a\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":1,\"queueOrder\":3,\"message\":\"PRIVATE-MESSAGE\"}','s','pending',1),\
        ('b','{\"id\":\"b\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":2,\"queueOrder\":\"3\",\"message\":\"PRIVATE-MESSAGE\"}','s','pending',2),\
        ('c','{\"id\":\"c\",\"sessionId\":\"s\",\"state\":\"leased\",\"sequence\":3,\"queueOrder\":-0.5}','s','leased',3),\
        ('d','{\"id\":\"d\",\"sessionId\":\"other\",\"state\":\"pending\",\"sequence\":4}','other','pending',4)",
    )
    .unwrap();
    db.exec("INSERT INTO orchestration_session_schedules(session_id,data_json,state) VALUES('s','{\"active\":{\"entryId\":\"entry\",\"deliveryId\":\"delivery\"},\"priorityEntryId\":\"a\",\"unrelated\":\"PRIVATE-SCHEDULE\"}','running')").unwrap();
    let snapshot = store
        .request("scheduleMetadataBegin", &json!({"sessionId":"s"}))
        .unwrap();
    let token = snapshot["token"].as_str().unwrap();
    assert_eq!(
        snapshot["schedule"],
        json!({"exists":true,"activeDeliveryId":"delivery","priorityEntryId":"a"})
    );
    assert!(!snapshot.to_string().contains("PRIVATE-SCHEDULE"));
    assert!(store
        .request("scheduleMetadataPage", &json!({"token":token,"limit":129}))
        .is_err());
    let first = store
        .request(
            "scheduleMetadataPage",
            &json!({
                "token": token, "limit":1
            }),
        )
        .unwrap();
    assert_eq!(
        first,
        json!({"state":"pending","rows":[{"id":"a","sequence":1,"queueOrder":3.0}],"scanComplete":false})
    );
    assert!(!first.to_string().contains("PRIVATE-MESSAGE"));
    assert!(store
        .request(
            "scheduleMetadataPage",
            &json!({"token":token,"limit":1,"afterSequence":2})
        )
        .is_err());
    assert!(store
        .request(
            "scheduleMetadataPage",
            &json!({"token":token,"limit":1,"state":"leased"})
        )
        .is_err());
    db.exec("UPDATE orchestration_outbox SET state='delivered' WHERE id='b'")
        .unwrap();
    let second = store
        .request(
            "scheduleMetadataPage",
            &json!({
                "token": token, "limit":1
            }),
        )
        .unwrap();
    assert_eq!(
        second,
        json!({"state":"pending","rows":[{"id":"b","sequence":2,"queueOrder":null}],"scanComplete":false})
    );
    let leased = store
        .request(
            "scheduleMetadataPage",
            &json!({
                "token": token, "limit":128
            }),
        )
        .unwrap();
    assert_eq!(
        leased["rows"],
        json!([{"id":"c","sequence":3,"queueOrder":-0.5}])
    );
    assert_eq!(leased["state"], "leased");
    assert_eq!(leased["scanComplete"], true);
    assert!(store
        .request("scheduleMetadataPage", &json!({"token":token,"limit":1}))
        .is_err());
    let state = &snapshot["state"];
    assert!(store
        .request(
            "prepare",
            &json!({"expectedRevision":state["revision"],"state":state,"changes":[]})
        )
        .is_err());
    assert!(store
        .request(
            "scheduleMetadataPrepare",
            &json!({"token":token,"expectedRevision":1,"state":state,"changes":[]})
        )
        .is_err());
    let error = store
        .request(
            "scheduleMetadataPrepare",
            &json!({
                "token":token, "expectedRevision":state["revision"], "state":state, "changes":[]
            }),
        )
        .unwrap_err();
    assert!(
        error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:"),
        "{error}"
    );
    assert!(store
        .request(
            "scheduleMetadataPage",
            &json!({
                "token":token, "limit":1
            })
        )
        .is_err());
    store.request("begin", &json!({})).unwrap();
    assert!(store
        .request(
            "scheduleMetadataPage",
            &json!({
                "limit":1
            })
        )
        .is_err());
    let next = store
        .request("scheduleMetadataBegin", &json!({"sessionId":"s"}))
        .unwrap();
    assert_ne!(next["token"], snapshot["token"]);
    assert!(store
        .request(
            "scheduleMetadataPage",
            &json!({
                "token":token, "limit":1
            })
        )
        .is_err());
    store.request("end", &json!({})).unwrap();
    db.exec("INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence) VALUES(printf('%.*c',1025,'x'),'{}','s','pending',5)").unwrap();
    let large_id = store
        .request("scheduleMetadataBegin", &json!({"sessionId":"s"}))
        .unwrap();
    let error = store
        .request(
            "scheduleMetadataPage",
            &json!({
                "token":large_id["token"], "limit":128
            }),
        )
        .unwrap_err();
    assert!(error.contains("identifier exceeds limit"), "{error}");
    store.request("end", &json!({})).unwrap();
    db.exec("INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence) VALUES('invalid','{}','invalid-session','pending',NULL)").unwrap();
    let invalid = store
        .request(
            "scheduleMetadataBegin",
            &json!({"sessionId":"invalid-session"}),
        )
        .unwrap();
    assert!(store
        .request(
            "scheduleMetadataPage",
            &json!({"token":invalid["token"],"limit":1})
        )
        .is_err());
    store.request("close", &json!({})).unwrap();
}

#[test]
fn metadata_schedule_projection_rejects_unsupported_or_large_values() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut store = owner(&file);
    let db = Database::open(&file, false, true, 5000).unwrap();
    db.exec("INSERT INTO orchestration_session_schedules(session_id,data_json,state) VALUES('s','{\"active\":{\"deliveryId\":true}}','running')").unwrap();
    assert!(store
        .request("scheduleMetadataBegin", &json!({"sessionId":"s"}))
        .unwrap_err()
        .contains("string identifiers"));
    db.exec("UPDATE orchestration_session_schedules SET data_json='{\"active\":{\"entryId\":\"fallback\",\"deliveryId\":\"\"},\"priorityEntryId\":null}' WHERE session_id='s'").unwrap();
    let result = store
        .request("scheduleMetadataBegin", &json!({"sessionId":"s"}))
        .unwrap();
    assert_eq!(
        result["schedule"],
        json!({"exists":true,"activeDeliveryId":"fallback","priorityEntryId":null})
    );
    store.request("end", &json!({})).unwrap();
    db.exec("UPDATE orchestration_session_schedules SET data_json='{\"unrelated\":\"' || printf('%.*c',65536,'x') || '\"}' WHERE session_id='s'").unwrap();
    assert!(store
        .request("scheduleMetadataBegin", &json!({"sessionId":"s"}))
        .unwrap_err()
        .contains("schedule exceeds limit"));
    store.request("close", &json!({})).unwrap();
}

#[test]
fn metadata_order_projection_rejects_large_or_inconsistent_rows() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut store = owner(&file);
    let db = Database::open(&file, false, true, 5000).unwrap();
    db.exec("INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence) VALUES('a','{\"id\":\"a\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":1,\"message\":\"' || printf('%.*c',65536,'x') || '\"}','s','pending',1)").unwrap();
    let snapshot = store
        .request("scheduleMetadataBegin", &json!({"sessionId":"s"}))
        .unwrap();
    let error = store
        .request(
            "scheduleMetadataPage",
            &json!({"token":snapshot["token"],"limit":1}),
        )
        .unwrap_err();
    assert!(error.contains("outbox record exceeds limit"), "{error}");
    store.request("end", &json!({})).unwrap();
    db.exec("UPDATE orchestration_outbox SET data_json='{\"id\":\"different\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":1}' WHERE id='a'").unwrap();
    let snapshot = store
        .request("scheduleMetadataBegin", &json!({"sessionId":"s"}))
        .unwrap();
    let error = store
        .request(
            "scheduleMetadataPage",
            &json!({"token":snapshot["token"],"limit":1}),
        )
        .unwrap_err();
    assert!(error.contains("indexed fields do not match"), "{error}");
    store.request("close", &json!({})).unwrap();
}

#[test]
fn metadata_scans_are_bound_to_the_owner_session() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut owner = owner(&file);
    let other = owner
        .open_session(&json!({"version":OWNER_PROTOCOL_VERSION,"file":file,"now":1,"policy":{}}))
        .unwrap();
    let first = owner
        .request_for(1, "scheduleMetadataBegin", &json!({"sessionId":"s"}))
        .unwrap();
    let second = owner
        .request_for(other, "scheduleMetadataBegin", &json!({"sessionId":"s"}))
        .unwrap();
    assert_ne!(first["token"], second["token"]);
    assert!(owner.request_for(1, "scheduleMetadataPrepare", &json!({"token":first["token"],"expectedRevision":first["state"]["revision"],"state":first["state"],"changes":[]})).is_err());
    assert!(owner
        .request_for(
            other,
            "scheduleMetadataPage",
            &json!({"token":first["token"],"limit":1})
        )
        .is_err());
    let page = owner
        .request_for(
            other,
            "scheduleMetadataPage",
            &json!({"token":second["token"],"limit":1}),
        )
        .unwrap();
    assert_eq!(
        page,
        json!({"state":"pending","rows":[],"scanComplete":false})
    );
    let first_page = owner
        .request_for(
            1,
            "scheduleMetadataPage",
            &json!({"token":first["token"],"limit":1}),
        )
        .unwrap();
    assert_eq!(first_page["scanComplete"], false);
    let first_page = owner
        .request_for(
            1,
            "scheduleMetadataPage",
            &json!({"token":first["token"],"limit":1}),
        )
        .unwrap();
    assert_eq!(first_page["scanComplete"], true);
    let mut state = first["state"].clone();
    state["revision"] = json!(1);
    owner.request_for(1, "scheduleMetadataPrepare", &json!({"token":first["token"],"expectedRevision":first["state"]["revision"],"state":state,"changes":[
        {"collection":"outbox","key":"new","valueJson":"{\"id\":\"new\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":1,\"availableAt\":0}"}
    ]})).unwrap();
    owner.request_for(1, "commit", &json!({})).unwrap();
    assert!(owner
        .request_for(
            1,
            "scheduleMetadataPage",
            &json!({"token":first["token"],"limit":1})
        )
        .is_err());
    let page = owner
        .request_for(
            other,
            "scheduleMetadataPage",
            &json!({"token":second["token"],"limit":1}),
        )
        .unwrap();
    assert_eq!(
        page,
        json!({"state":"leased","rows":[],"scanComplete":true})
    );
    let error = owner.request_for(other, "scheduleMetadataPrepare", &json!({"token":second["token"],"expectedRevision":second["state"]["revision"],"state":second["state"],"changes":[]})).unwrap_err();
    assert!(
        error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:"),
        "{error}"
    );
    owner.request_for(1, "close", &json!({})).unwrap();
    owner.request_for(other, "close", &json!({})).unwrap();
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
fn independent_owners_fail_closed_and_release_the_lease_on_exit() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut first = owner(&file);
    let alias = fixture.0.join(".").join("state.sqlite");
    let second = OwnerClient::spawn(
        Path::new(env!("CARGO_BIN_EXE_multicc-gateway")),
        &json!({"version": OWNER_PROTOCOL_VERSION, "file": alias, "now": 1, "policy": {}}),
        256 * 1024 * 1024,
    );
    let error = match second {
        Ok(_) => panic!("independent owner must not open the same database"),
        Err(error) => error,
    };
    assert!(error.contains("owner lease unavailable"), "{error}");
    assert_eq!(
        first.request("info", &json!({})).unwrap()["state"]["revision"],
        0
    );

    // Abnormal termination must release the OS lease as well as SQLite locks.
    first.abort();
    let mut replacement = owner(&file);
    assert_eq!(
        replacement.request("info", &json!({})).unwrap()["state"]["revision"],
        0
    );
    replacement.request("close", &json!({})).unwrap();
}

#[cfg(any(unix, windows))]
#[test]
fn owner_rejects_hardlinked_database_aliases() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut first = owner(&file);
    first.request("close", &json!({})).unwrap();
    let alias = fixture.0.join("hardlink.sqlite");
    std::fs::hard_link(&file, &alias).unwrap();
    for path in [Path::new(&file), alias.as_path()] {
        let result = OwnerClient::spawn(
            Path::new(env!("CARGO_BIN_EXE_multicc-gateway")),
            &json!({"version":OWNER_PROTOCOL_VERSION,"file":path,"now":1,"policy":{}}),
            256 * 1024 * 1024,
        );
        let error = match result {
            Ok(_) => panic!("hardlinked database must be rejected"),
            Err(error) => error,
        };
        assert!(error.contains("hard links are not supported"), "{error}");
    }
    std::fs::remove_file(alias).unwrap();
    let mut reopened = owner(&file);
    assert_eq!(
        reopened.request("info", &json!({})).unwrap()["state"]["revision"],
        0
    );
    reopened.request("close", &json!({})).unwrap();
}

#[test]
fn simultaneous_first_open_never_creates_two_owners() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let barrier = barrier.clone();
            let file = file.clone();
            std::thread::spawn(move || {
                barrier.wait();
                OwnerClient::spawn(
                    Path::new(env!("CARGO_BIN_EXE_multicc-gateway")),
                    &json!({"version": OWNER_PROTOCOL_VERSION, "file": file, "now": 1, "policy": {}}),
                    256 * 1024 * 1024,
                )
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let error = results
        .iter()
        .find_map(|result| result.as_ref().err())
        .unwrap();
    assert!(error.contains("lease unavailable"), "{error}");
    drop(results);
    let mut replacement = owner(&file);
    assert_eq!(
        replacement.request("info", &json!({})).unwrap()["state"]["revision"],
        0
    );
    replacement.request("close", &json!({})).unwrap();
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
