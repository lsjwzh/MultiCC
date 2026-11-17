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
fn detached_draft_rejects_external_write_before_a_late_read_and_releases_state() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut owner = owner(&file);
    let db = Database::open(&file, false, true, 5000).unwrap();
    db.exec("INSERT INTO orchestration_waits(id,data_json,session_id,status) VALUES('w','{\"id\":\"w\",\"status\":\"pending\"}','s','pending')").unwrap();
    let start = owner.request("beginTrackedDraft", &json!({})).unwrap();
    let token = start["token"].as_str().unwrap();
    owner
        .request("detachDraftSnapshot", &json!({"token":token}))
        .unwrap();
    db.exec("UPDATE orchestration_waits SET data_json='{\"id\":\"w\",\"status\":\"resolved\"}',status='resolved' WHERE id='w'").unwrap();
    let error = owner
        .request(
            "readTrackedDraft",
            &json!({"token":token,"operation":"materialize",
        "input":{"collection":"waits","key":"w"}}),
        )
        .unwrap_err();
    assert!(
        error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:"),
        "{error}"
    );
    let next = owner.request("beginTrackedDraft", &json!({})).unwrap();
    owner
        .request("discardTrackedDraft", &json!({"token":next["token"]}))
        .unwrap();
}

#[test]
fn read_only_draft_cannot_be_used_to_commit_without_a_footprint() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut owner = owner(&file);
    let start = owner
        .request("beginTrackedDraft", &json!({"readOnly":true}))
        .unwrap();
    let token = start["token"].as_str().unwrap();
    owner
        .request("detachDraftSnapshot", &json!({"token":token}))
        .unwrap();
    let error = owner
        .request(
            "commitTrackedDraft",
            &json!({"token":token,"headerReadsTracked":true,
        "expectedRevision":start["state"]["revision"],"state":start["state"],"changes":[]}),
        )
        .unwrap_err();
    assert!(error.contains("read-only draft cannot commit"), "{error}");
    owner
        .request("discardTrackedDraft", &json!({"token":token}))
        .unwrap();
}

#[test]
fn tracked_draft_merges_only_when_read_and_query_footprints_remain_valid() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut owner = owner(&file);
    let db = Database::open(&file, false, true, 5000).unwrap();
    db.exec("INSERT INTO orchestration_waits(id,data_json,session_id,status) VALUES('w','{\"id\":\"w\",\"sessionId\":\"s\",\"status\":\"pending\"}','s','pending')").unwrap();
    let start = owner.request("beginTrackedDraft", &json!({})).unwrap();
    let token = start["token"].as_str().unwrap().to_owned();
    owner
        .request("materialize", &json!({"collection":"waits","key":"w"}))
        .unwrap();
    owner
        .request("materialize", &json!({"collection":"extras","key":"draft"}))
        .unwrap();
    owner
        .request("detachDraftSnapshot", &json!({"token":token}))
        .unwrap();
    let question = json!({"action":"record","sessionId":"s","expectedVersion":0,"at":1,
        "initialState":{"pendingQuestion":null,"activeTurn":{"_activeTurn":{"turnId":"t"},
          "isStreaming":true,"_currentTaskId":"task"},"category":{"classifyState":"W"}},
        "signal":{"sessionId":"s","turnId":"t","requestId":"q","question":"Q"}});
    owner
        .request(
            "sessionWorkQuestionExperimental",
            &json!({"requestJson":question.to_string()}),
        )
        .unwrap();
    let answer = json!({"sessionId":"s","text":"answer","hostAdmission":true,
        "options":{"userInputRequestId":"q","clientMsgId":"tracked-answer"}});
    let admitted = owner
        .request(
            "scheduleAdmit",
            &json!({"requestJson":answer.to_string(),
        "expectedRevision":start["state"]["revision"],"now":2}),
        )
        .unwrap();
    let admitted_result: Value =
        serde_json::from_str(admitted["resultJson"].as_str().unwrap()).unwrap();
    assert_eq!(admitted_result["answerConsumed"]["requestId"], "q");
    let after_answer = owner
        .request(
            "readTrackedDraft",
            &json!({"token":token,"operation":"materialize",
        "input":{"collection":"waits","key":"w"}}),
        )
        .unwrap();
    assert!(after_answer["valueJson"]
        .as_str()
        .unwrap()
        .contains("pending"));
    let mut state = start["state"].clone();
    state["updatedAt"] = json!(3);
    let committed = owner
        .request(
            "commitTrackedDraft",
            &json!({"token":token,"headerReadsTracked":true,
        "expectedRevision":start["state"]["revision"],"state":state,
        "changes":[{"collection":"extras","key":"draft","valueJson":"1"}]}),
        )
        .unwrap();
    assert_eq!(committed["state"]["revision"], 2);
    assert_eq!(
        committed["state"]["nextOutboxSequence"],
        admitted["state"]["nextOutboxSequence"]
    );
    assert_eq!(
        owner
            .request("materialize", &json!({"collection":"extras","key":"draft"}))
            .unwrap()["valueJson"],
        "1"
    );
    assert_eq!(
        owner
            .request(
                "sessionWorkState",
                &json!({"action":"read","sessionId":"s"})
            )
            .unwrap()["pendingQuestion"]["resolved"],
        true
    );

    // A change to a previously read record invalidates an otherwise disjoint
    // write, even though that write itself targets a different collection.
    let start = owner.request("beginTrackedDraft", &json!({})).unwrap();
    let token = start["token"].as_str().unwrap().to_owned();
    owner
        .request("materialize", &json!({"collection":"waits","key":"w"}))
        .unwrap();
    owner
        .request(
            "materialize",
            &json!({"collection":"extras","key":"read-conflict"}),
        )
        .unwrap();
    owner
        .request("detachDraftSnapshot", &json!({"token":token}))
        .unwrap();
    let live = owner.request("begin", &json!({})).unwrap();
    let mut live_state = live.clone();
    live_state["revision"] = json!(live["revision"].as_u64().unwrap() + 1);
    owner
        .request(
            "prepare",
            &json!({"expectedRevision":live["revision"],"state":live_state,
        "changes":[{"collection":"waits","key":"w","valueJson":
          "{\"id\":\"w\",\"sessionId\":\"s\",\"status\":\"resolved\"}"}]}),
        )
        .unwrap();
    owner.request("commit", &json!({})).unwrap();
    let error = owner
        .request(
            "commitTrackedDraft",
            &json!({"token":token,"headerReadsTracked":true,
        "expectedRevision":start["state"]["revision"],"state":start["state"],
        "changes":[{"collection":"extras","key":"read-conflict","valueJson":"1"}]}),
        )
        .unwrap_err();
    assert!(
        error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:"),
        "{error}"
    );
    assert_eq!(
        owner
            .request(
                "materialize",
                &json!({"collection":"extras","key":"read-conflict"})
            )
            .unwrap()["found"],
        false
    );

    // A query footprint protects its whole result, including newly inserted
    // matching rows that were absent when the draft observed the query.
    let start = owner.request("beginTrackedDraft", &json!({})).unwrap();
    let token = start["token"].as_str().unwrap().to_owned();
    let baseline = owner
        .request(
            "selectKeys",
            &json!({"collection":"outbox","options":{"where":{"state":"pending"}}}),
        )
        .unwrap();
    owner
        .request(
            "materialize",
            &json!({"collection":"extras","key":"phantom"}),
        )
        .unwrap();
    owner
        .request("detachDraftSnapshot", &json!({"token":token}))
        .unwrap();
    let live = owner.request("begin", &json!({})).unwrap();
    let mut live_state = live.clone();
    live_state["revision"] = json!(live["revision"].as_u64().unwrap() + 1);
    live_state["nextOutboxSequence"] = json!(live["nextOutboxSequence"].as_u64().unwrap() + 1);
    owner.request("prepare", &json!({"expectedRevision":live["revision"],"state":live_state,
        "changes":[{"collection":"outbox","key":"phantom-entry","valueJson":
          "{\"id\":\"phantom-entry\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":2,\"availableAt\":0}"}]})).unwrap();
    owner.request("commit", &json!({})).unwrap();
    let still_original = owner
        .request(
            "readTrackedDraft",
            &json!({"token":token,"operation":"selectKeys",
        "input":{"collection":"outbox","options":{"where":{"state":"pending"}}}}),
        )
        .unwrap();
    assert_eq!(still_original, baseline);
    let error = owner
        .request(
            "commitTrackedDraft",
            &json!({"token":token,"headerReadsTracked":true,
        "expectedRevision":start["state"]["revision"],"state":start["state"],
        "changes":[{"collection":"extras","key":"phantom","valueJson":"1"}]}),
        )
        .unwrap_err();
    assert!(
        error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:"),
        "{error}"
    );
    assert_eq!(
        owner
            .request(
                "materialize",
                &json!({"collection":"extras","key":"phantom"})
            )
            .unwrap()["found"],
        false
    );
    // Header observations are dependencies too: a revision read cannot be
    // silently reused after another same-owner transaction commits.
    let start = owner.request("beginTrackedDraft", &json!({})).unwrap();
    let token = start["token"].as_str().unwrap().to_owned();
    owner
        .request(
            "draftTrackHeader",
            &json!({"token":token,"field":"revision"}),
        )
        .unwrap();
    owner
        .request(
            "materialize",
            &json!({"collection":"extras","key":"header-conflict"}),
        )
        .unwrap();
    owner
        .request("detachDraftSnapshot", &json!({"token":token}))
        .unwrap();
    let live = owner.request("begin", &json!({})).unwrap();
    let mut live_state = live.clone();
    live_state["revision"] = json!(live["revision"].as_u64().unwrap() + 1);
    owner
        .request(
            "prepare",
            &json!({"expectedRevision":live["revision"],"state":live_state,
        "changes":[{"collection":"extras","key":"other","valueJson":"1"}]}),
        )
        .unwrap();
    owner.request("commit", &json!({})).unwrap();
    let error = owner
        .request(
            "commitTrackedDraft",
            &json!({"token":token,"headerReadsTracked":true,
        "expectedRevision":start["state"]["revision"],"state":start["state"],
        "changes":[{"collection":"extras","key":"header-conflict","valueJson":"1"}]}),
        )
        .unwrap_err();
    assert!(
        error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:"),
        "{error}"
    );

    let start = owner.request("beginTrackedDraft", &json!({})).unwrap();
    let token = start["token"].as_str().unwrap().to_owned();
    owner
        .request("detachDraftSnapshot", &json!({"token":token}))
        .unwrap();
    let error = owner
        .request(
            "commitTrackedDraft",
            &json!({"token":token,"headerReadsTracked":true,
        "expectedRevision":start["state"]["revision"],"state":start["state"],
        "changes":[{"collection":"extras","key":"untracked-write","valueJson":"1"}]}),
        )
        .unwrap_err();
    assert!(
        error.contains("draft write lacks captured baseline"),
        "{error}"
    );

    let start = owner.request("beginTrackedDraft", &json!({})).unwrap();
    let token = start["token"].as_str().unwrap().to_owned();
    owner
        .request(
            "materialize",
            &json!({"collection":"extras","key":"external-conflict"}),
        )
        .unwrap();
    owner
        .request("detachDraftSnapshot", &json!({"token":token}))
        .unwrap();
    let error = owner
        .request(
            "commitTrackedDraft",
            &json!({"token":"wrong","headerReadsTracked":true,
        "expectedRevision":start["state"]["revision"],"state":start["state"],"changes":[]}),
        )
        .unwrap_err();
    assert!(error.contains("invalid detached draft token"), "{error}");
    db.exec(
        "UPDATE orchestration_waits SET data_json=json_set(data_json,'$.external',1) WHERE id='w'",
    )
    .unwrap();
    let error = owner
        .request(
            "commitTrackedDraft",
            &json!({"token":token,"headerReadsTracked":true,
        "expectedRevision":start["state"]["revision"],"state":start["state"],
        "changes":[{"collection":"extras","key":"external-conflict","valueJson":"1"}]}),
        )
        .unwrap_err();
    assert!(
        error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:"),
        "{error}"
    );
    assert_eq!(
        owner
            .request(
                "materialize",
                &json!({"collection":"extras","key":"external-conflict"})
            )
            .unwrap()["found"],
        false
    );
    owner.request("close", &json!({})).unwrap();
}

#[test]
fn detached_draft_commit_is_atomic_and_rejects_external_changes() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut owner = owner(&file);
    let header = owner.request("begin", &json!({})).unwrap();
    let token = owner.request("detachDraftSnapshot", &json!({})).unwrap();
    assert_eq!(token["state"], header);
    let request = json!({"action":"record","sessionId":"s","expectedVersion":0,"at":1,
        "initialState":{"pendingQuestion":null,"activeTurn":{"_activeTurn":{"turnId":"t"},
          "isStreaming":true,"_currentTaskId":"task"},"category":{"classifyState":"W"}},
        "signal":{"sessionId":"s","turnId":"t","requestId":"q","question":"Q"}});
    let recorded = owner
        .request(
            "sessionWorkQuestionExperimental",
            &json!({"requestJson":request.to_string()}),
        )
        .unwrap();
    assert_eq!(recorded["result"]["ok"], true);
    let mut state = header.clone();
    state["revision"] = json!(header["revision"].as_u64().unwrap() + 1);
    state["updatedAt"] = json!(10);
    let committed = owner.request("commitDetachedDraft", &json!({
        "dataVersion":token["dataVersion"],"expectedRevision":header["revision"],"state":state,
        "changes":[{"collection":"extras","key":"marker","valueJson":"\"done\""}]
    })).unwrap();
    assert_eq!(committed["state"]["revision"], 1);
    assert_eq!(
        owner
            .request(
                "sessionWorkState",
                &json!({"action":"read","sessionId":"s"})
            )
            .unwrap()["pendingQuestion"]["requestId"],
        "q"
    );

    // An intervening answer increments the store revision. The stale draft
    // cannot overwrite the answer, even when both use this owner connection.
    let header = owner.request("begin", &json!({})).unwrap();
    let token = owner.request("detachDraftSnapshot", &json!({})).unwrap();
    let answer = json!({"sessionId":"s","text":"answer","hostAdmission":true,
        "options":{"userInputRequestId":"q","clientMsgId":"detached-answer"}});
    let admitted = owner
        .request(
            "scheduleAdmit",
            &json!({"requestJson":answer.to_string(),
        "expectedRevision":header["revision"],"now":2}),
        )
        .unwrap();
    let result: Value = serde_json::from_str(admitted["resultJson"].as_str().unwrap()).unwrap();
    assert_eq!(result["answerConsumed"]["requestId"], "q");
    let mut state = header.clone();
    state["revision"] = json!(header["revision"].as_u64().unwrap() + 1);
    let error = owner.request("commitDetachedDraft", &json!({
        "dataVersion":token["dataVersion"],"expectedRevision":header["revision"],"state":state,
        "changes":[{"collection":"extras","key":"after-answer","valueJson":"1"}]
    })).unwrap_err();
    assert!(
        error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:"),
        "{error}"
    );
    assert_eq!(
        owner
            .request(
                "sessionWorkState",
                &json!({"action":"read","sessionId":"s"})
            )
            .unwrap()["pendingQuestion"]["resolved"],
        true
    );
    let header = owner.request("begin", &json!({})).unwrap();
    let token = owner.request("detachDraftSnapshot", &json!({})).unwrap();
    let live = owner.request("begin", &json!({})).unwrap();
    let mut live_state = live.clone();
    live_state["revision"] = json!(live["revision"].as_u64().unwrap() + 1);
    owner
        .request(
            "prepare",
            &json!({"expectedRevision":live["revision"],"state":live_state,
        "changes":[{"collection":"extras","key":"marker","valueJson":"\"newer\""}]}),
        )
        .unwrap();
    owner.request("commit", &json!({})).unwrap();
    let mut state = header.clone();
    state["revision"] = json!(header["revision"].as_u64().unwrap() + 1);
    let error = owner
        .request(
            "commitDetachedDraft",
            &json!({"mergeDisjoint":true,
        "dataVersion":token["dataVersion"],"expectedRevision":header["revision"],
        "baseNextOutboxSequence":header["nextOutboxSequence"],"state":state,
        "changes":[{"collection":"extras","key":"marker","beforeExists":true,
          "beforeJson":"\"done\"","valueJson":"\"draft\""}]}),
        )
        .unwrap_err();
    assert!(
        error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:"),
        "{error}"
    );
    assert_eq!(
        owner
            .request(
                "materialize",
                &json!({"collection":"extras","key":"marker"})
            )
            .unwrap()["valueJson"],
        "\"newer\""
    );

    let header = owner.request("begin", &json!({})).unwrap();
    let token = owner.request("detachDraftSnapshot", &json!({})).unwrap();
    let db = Database::open(&file, false, true, 5000).unwrap();
    db.exec("INSERT INTO orchestration_extras(key,data_json) VALUES('external','1')")
        .unwrap();
    let mut state = header.clone();
    state["revision"] = json!(header["revision"].as_u64().unwrap() + 1);
    let error = owner.request("commitDetachedDraft", &json!({
        "mergeDisjoint":true,"dataVersion":token["dataVersion"],"expectedRevision":header["revision"],
        "baseNextOutboxSequence":header["nextOutboxSequence"],"state":state,
        "changes":[{"collection":"extras","key":"stale","beforeExists":false,"valueJson":"1"}]
    })).unwrap_err();
    assert!(
        error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:"),
        "{error}"
    );
    assert_eq!(
        owner
            .request("materialize", &json!({"collection":"extras","key":"stale"}))
            .unwrap()["found"],
        false
    );
    assert_eq!(
        owner
            .request(
                "materialize",
                &json!({"collection":"extras","key":"external"})
            )
            .unwrap()["valueJson"],
        "1"
    );
    owner.request("begin", &json!({})).unwrap();
    db.exec("UPDATE orchestration_extras SET data_json='2' WHERE key='external'")
        .unwrap();
    let error = owner
        .request("detachDraftSnapshot", &json!({}))
        .unwrap_err();
    assert!(error.contains("snapshot changed during capture"), "{error}");
    assert_eq!(
        owner
            .request(
                "materialize",
                &json!({"collection":"extras","key":"external"})
            )
            .unwrap()["valueJson"],
        "2"
    );
    owner.request("close", &json!({})).unwrap();
}

#[test]
fn session_work_state_is_versioned_and_atomic_across_owner_sessions() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut owner = owner(&file);
    let second = owner
        .open_session(&json!({"version":OWNER_PROTOCOL_VERSION,"file":file,"now":1,"policy":{}}))
        .unwrap();
    assert!(owner
        .request(
            "sessionWorkState",
            &json!({"action":"read","encoding":"future","sessionId":"s"})
        )
        .is_err());
    let empty = owner
        .request_for(
            second,
            "sessionWorkState",
            &json!({"action":"read","sessionId":"s"}),
        )
        .unwrap();
    assert_eq!(empty["version"], 0);
    let seed = json!({"action":"readOrInitialize","sessionId":"seeded","initial":{
        "pendingQuestion":{"requestId":"old"},"activeTurn":null,"category":"P"}});
    let first = owner.request("sessionWorkState", &seed).unwrap();
    assert_eq!(first["version"], 1);
    let other_seed = json!({"action":"readOrInitialize","sessionId":"seeded","initial":{
        "pendingQuestion":{"requestId":"stale"},"activeTurn":null,"category":"D"}});
    assert_eq!(
        owner
            .request_for(second, "sessionWorkState", &other_seed)
            .unwrap(),
        first
    );
    let update = |id: &str, version: u64, category: &str| {
        json!({"sessionId":id,
        "expectedVersion":version,"pendingQuestion":{"requestId":"r"},
        "activeTurn":{"turnId":"t"},"category":category})
    };
    let saved = owner
        .request(
            "sessionWorkState",
            &json!({"action":"write","updates":[update("s",0,"unknown-future-category")]}),
        )
        .unwrap();
    assert_eq!(
        owner
            .request_for(
                second,
                "sessionWorkState",
                &json!({"action":"read","sessionId":"s"})
            )
            .unwrap(),
        saved["snapshots"][0]
    );
    assert!(owner
        .request_for(
            second,
            "sessionWorkState",
            &json!({"action":"write","updates":[update("new",0,"W"),update("s",0,"P")]})
        )
        .is_err());
    assert_eq!(
        owner
            .request(
                "sessionWorkState",
                &json!({"action":"read","sessionId":"new"})
            )
            .unwrap()["version"],
        0
    );
    assert_eq!(
        owner
            .request(
                "sessionWorkState",
                &json!({"action":"read","sessionId":"s"})
            )
            .unwrap()["category"],
        "unknown-future-category"
    );
    owner.request_for(second, "close", &json!({})).unwrap();
    owner.request("close", &json!({})).unwrap();
    let mut reopened = OwnerClient::spawn(
        Path::new(env!("CARGO_BIN_EXE_multicc-gateway")),
        &json!({"version":OWNER_PROTOCOL_VERSION,"file":file,"now":1,"policy":{}}),
        256 * 1024 * 1024,
    )
    .unwrap();
    assert_eq!(
        reopened
            .request(
                "sessionWorkState",
                &json!({"action":"read","sessionId":"s"})
            )
            .unwrap(),
        saved["snapshots"][0]
    );
    reopened.request("close", &json!({})).unwrap();
}

#[test]
fn experimental_completion_rejects_external_writes_and_commits_in_owner() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut owner = owner(&file);
    owner.request("sessionWorkState", &json!({"action":"readOrInitialize","encoding":"json","sessionId":"s",
        "initial":{"pendingQuestionJson":"{\"requestId\":\"q\",\"taskId\":\"task\"}","activeTurnJson":"null","categoryJson":"null"}})).unwrap();
    let db = Database::open(&file, false, true, 5000).unwrap();
    db.exec("INSERT INTO orchestration_session_schedules(session_id,data_json,state) VALUES('s','{\"sessionId\":\"s\",\"state\":\"running\",\"active\":{\"entryId\":\"active\",\"taskId\":\"task\"},\"classifyState\":\"P\"}','running'); INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence) VALUES('q1','{\"id\":\"q1\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":1,\"payload\":{\"type\":\"session.work\",\"message\":\"hello\"},\"directRun\":true}','s','pending',1)").unwrap();
    drop(db);
    let token = owner
        .request(
            "scheduleCompleteTokenExperimental",
            &json!({"sessionId":"s"}),
        )
        .unwrap();
    let mut command = json!({"sessionId":"s","expectedRevision":token["state"]["revision"],
        "expectedVersion":token["snapshot"]["version"],"expectedDataVersion":token["dataVersion"],
        "at":1000,"updatedAt":1200,"expectedTaskIdJson":"\"task\"","reasonJson":"\"successful\"",
        "classifyStateJson":"\"W\"","awaitingRequestIdJson":"\"q\""});
    let external = Database::open(&file, false, true, 5000).unwrap();
    external
        .exec("INSERT INTO orchestration_extras(key,data_json) VALUES('external','{}')")
        .unwrap();
    drop(external);
    assert!(owner
        .request("scheduleCompleteExperimental", &command)
        .unwrap_err()
        .contains("database version conflict"));
    let new_token = owner
        .request(
            "scheduleCompleteTokenExperimental",
            &json!({"sessionId":"s"}),
        )
        .unwrap();
    command["expectedDataVersion"] = new_token["dataVersion"].clone();
    let completed = owner
        .request("scheduleCompleteExperimental", &command)
        .unwrap();
    let result: Value = serde_json::from_str(completed["resultJson"].as_str().unwrap()).unwrap();
    assert_eq!(result["schedule"]["classifyState"], "W");
    assert_eq!(result["schedule"]["awaitingRequestId"], "q");
    owner.request("begin", &json!({})).unwrap();
    let item = owner
        .request("materialize", &json!({"collection":"outbox","key":"q1"}))
        .unwrap();
    let value: Value = serde_json::from_str(item["valueJson"].as_str().unwrap()).unwrap();
    assert_eq!(value["directRun"], false);
    assert_eq!(value["blockedByUserInput"], "q");
    owner.request("end", &json!({})).unwrap();
    owner.request("close", &json!({})).unwrap();
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
fn opt_in_metadata_preparation_projects_large_and_split_records_without_leaking_bodies() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut store = owner(&file);
    let db = Database::open(&file, false, true, 5000).unwrap();
    db.exec("INSERT INTO orchestration_session_schedules(session_id,data_json,state) VALUES('s','{\"active\":{\"entryId\":\"entry\"},\"extra\":\"' || printf('%.*c',1048576,'x') || '\"}','running')").unwrap();
    db.exec("INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence) VALUES('a','{\"id\":\"a\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":1,\"queueOrder\":2,\"queue\\u004frder\":7,\"message\":\"PRIVATE-' || printf('%.*c',4194304,'x') || '\"}','s','pending',1)").unwrap();
    db.exec("INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence,body_ref) VALUES('b','{}','s','pending',2,1)").unwrap();
    db.exec("INSERT INTO orchestration_record_bodies(collection,record_key,data_json) VALUES('outbox','b','{\"id\":\"b\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":2,\"queueOrder\":-1,\"message\":\"PRIVATE-SPLIT\"}')").unwrap();
    assert!(store
        .request(
            "scheduleMetadataBegin",
            &json!({"sessionId":"s","prepareLargeRecords":"true"})
        )
        .is_err());
    let snapshot = store
        .request(
            "scheduleMetadataBegin",
            &json!({"sessionId":"s","prepareLargeRecords":true}),
        )
        .unwrap();
    assert_eq!(snapshot["schedule"]["activeDeliveryId"], "entry");
    let pending = store
        .request(
            "scheduleMetadataPage",
            &json!({"token":snapshot["token"],"limit":128}),
        )
        .unwrap();
    assert_eq!(
        pending["rows"],
        json!([
            {"id":"a","sequence":1,"queueOrder":7.0},
            {"id":"b","sequence":2,"queueOrder":-1.0}
        ])
    );
    assert!(!pending.to_string().contains("PRIVATE"));
    let leased = store
        .request(
            "scheduleMetadataPage",
            &json!({"token":snapshot["token"],"limit":128}),
        )
        .unwrap();
    assert_eq!(leased["scanComplete"], true);
    db.exec("UPDATE orchestration_outbox SET state='delivered' WHERE id='b'")
        .unwrap();
    let error = store.request("scheduleMetadataPrepare", &json!({"token":snapshot["token"],"expectedRevision":snapshot["state"]["revision"],"state":snapshot["state"],"changes":[]})).unwrap_err();
    assert!(
        error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:"),
        "{error}"
    );
    store.request("close", &json!({})).unwrap();
}

#[test]
fn opt_in_metadata_preparation_still_rejects_oversized_and_missing_bodies() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut store = owner(&file);
    let db = Database::open(&file, false, true, 5000).unwrap();
    db.exec("INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence) VALUES('a','{\"id\":\"a\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":1,\"message\":\"' || printf('%.*c',16777216,'x') || '\"}','s','pending',1)").unwrap();
    let snapshot = store
        .request(
            "scheduleMetadataBegin",
            &json!({"sessionId":"s","prepareLargeRecords":true}),
        )
        .unwrap();
    let error = store
        .request(
            "scheduleMetadataPage",
            &json!({"token":snapshot["token"],"limit":1}),
        )
        .unwrap_err();
    assert!(error.contains("outbox record exceeds limit"), "{error}");
    store.request("end", &json!({})).unwrap();
    db.exec("UPDATE orchestration_outbox SET data_json='{}',body_ref=1 WHERE id='a'")
        .unwrap();
    // The update trigger clears body_ref; set it afterwards to model a
    // corrupted split record with a missing original.
    db.exec("UPDATE orchestration_outbox SET body_ref=1 WHERE id='a'")
        .unwrap();
    let snapshot = store
        .request(
            "scheduleMetadataBegin",
            &json!({"sessionId":"s","prepareLargeRecords":true}),
        )
        .unwrap();
    assert!(store
        .request(
            "scheduleMetadataPage",
            &json!({"token":snapshot["token"],"limit":1})
        )
        .is_err());
    store.request("close", &json!({})).unwrap();
}

#[test]
fn metadata_preparation_rejects_invalid_json_even_in_unprojected_payloads() {
    let fixture = Fixture::new();
    let file = fixture.file();
    let mut store = owner(&file);
    let db = Database::open(&file, false, true, 5000).unwrap();
    db.exec("INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence) VALUES('a','{\"id\":\"a\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":1,\"payload\":[1,]}','s','pending',1)").unwrap();
    let snapshot = store
        .request(
            "scheduleMetadataBegin",
            &json!({"sessionId":"s","prepareLargeRecords":true}),
        )
        .unwrap();
    let error = store
        .request(
            "scheduleMetadataPage",
            &json!({"token":snapshot["token"],"limit":1}),
        )
        .unwrap_err();
    assert!(error.starts_with("ORCHESTRATION_STORE_CORRUPT:"), "{error}");
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
