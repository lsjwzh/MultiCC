//! End-to-end tests for `app::remote_annotation` against the fake
//! `multicc-remote` (`examples/remote_child_fixture.rs`, `FIXTURE_ANNOTATION`).
//!
//! Every case is checked through the two public entry points a wired route
//! would use: [`RemoteAnnotation::try_relay`] and
//! [`RemoteAnnotation::handle_annotation`], and the returned relay value is
//! additionally fed through `multicc_core::event_routes::annotation_relay_body`
//! to prove the wiring shape.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use multicc_core::event_routes::annotation_relay_body;
use multicc_gateway::app::remote_annotation::{RemoteAnnotation, NO_RESPONSE};
use multicc_gateway::remote_child::{Config, RemoteChild};

mod common;
use common::fixture;

fn temp_dir(tag: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_micros())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "multicc-remote-annotation-{tag}-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

struct Harness {
    child: Arc<RemoteChild>,
    /// `DIR`, also the child's screenshot directory.
    dir: PathBuf,
    requests: PathBuf,
}

impl Harness {
    fn annotation(&self) -> RemoteAnnotation {
        RemoteAnnotation::new(Arc::clone(&self.child), self.dir.clone())
    }

    fn records(&self) -> Vec<Value> {
        let Ok(text) = std::fs::read_to_string(&self.requests) else {
            return Vec::new();
        };
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).expect("record line"))
            .collect()
    }
}

fn harness(tag: &str, env: &[(&str, &str)]) -> Harness {
    harness_with(tag, env, |_| {})
}

fn harness_with(tag: &str, env: &[(&str, &str)], tune: impl FnOnce(&mut Config)) -> Harness {
    let root = temp_dir(tag);
    let dir = root.join("remote-screen");
    std::fs::create_dir_all(&dir).expect("screenshot dir");
    let requests = root.join("requests.jsonl");
    let mut config = Config::new(dir.clone());
    config.binary = Some(fixture());
    config.ready_timeout = Duration::from_millis(400);
    config.restart_base = Duration::from_millis(20);
    config.restart_max = Duration::from_millis(200);
    config.stable_reset = Duration::from_millis(150);
    config.shutdown_grace = Duration::from_millis(500);
    config.env = env
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    if !env.iter().any(|(key, _)| *key == "FIXTURE_REQUESTS_FILE") {
        config.env.push((
            "FIXTURE_REQUESTS_FILE".to_string(),
            requests.to_string_lossy().into_owned(),
        ));
    }
    tune(&mut config);
    Harness {
        child: Arc::new(RemoteChild::new(config)),
        dir,
        requests,
    }
}

fn payload(src: impl Into<String>) -> Value {
    json!({
        "sessionId": "s1",
        "src": src.into(),
        "width": 640,
        "height": 480,
        "kind": "rect",
        "a": { "x": 1.5 },
        "b": null,
    })
}

fn result_of(relay: &Value) -> Value {
    let results = relay["results"].as_array().expect("results array");
    assert_eq!(results.len(), 1, "exactly one relay result");
    results[0].clone()
}

#[tokio::test]
async fn own_shot_roundtrip_posts_the_js_bytes_and_headers() {
    let h = harness("ok", &[("FIXTURE_ANNOTATION", "ok")]);
    let shot = h.dir.join("shot-42.png");
    let payload = json!({
        "sessionId": "s1",
        "src": shot.to_string_lossy(),
        "width": 640,
        "height": 480,
        "kind": "rect",
        "a": { "x": 1.5, "label": "中文" },
        "b": null,
        "note": "emoji 😀",
    });
    let relay = h
        .annotation()
        .try_relay(&payload)
        .await
        .expect("own shot is relayed");
    let done = json!({ "ok": true, "refresh": true, "text": "done" });
    assert_eq!(relay, json!({ "relayed": 1, "results": [done.clone()] }));
    // The relay value is exactly what the wired route hands to Node's body
    // builder: { ok: true, relayed, results }.
    assert_eq!(
        annotation_relay_body(&relay),
        json!({ "ok": true, "relayed": 1, "results": [done] })
    );
    assert_eq!(h.child.snapshot().attempts, 1, "the child was started once");

    let records = h.records();
    assert_eq!(records.len(), 1);
    let record = &records[0];
    assert_eq!(record["method"], "POST");
    assert_eq!(record["target"], "/internal/annotation");
    assert_eq!(record["secretOk"], true);
    let headers = record["headers"].as_object().expect("headers");
    assert_eq!(headers["content-type"], "application/json");
    assert!(headers.contains_key("x-multicc-remote-secret"));
    // JSON.stringify bytes: insertion/key order, floats, raw non-ASCII.
    let expected_body = format!(
        "{{\"sessionId\":\"s1\",\"src\":{},\"width\":640,\"height\":480,\"kind\":\"rect\",\
         \"a\":{{\"x\":1.5,\"label\":\"中文\"}},\"b\":null,\"note\":\"emoji 😀\"}}",
        serde_json::to_string(&Value::String(shot.to_string_lossy().into_owned()))
            .expect("quote path")
    );
    assert_eq!(record["body"], expected_body);

    h.child.shutdown().await;
}

#[tokio::test]
async fn a_miss_returns_none_and_never_starts_the_child() {
    let h = harness("miss", &[]);
    let annotation = h.annotation();
    let outside = h.dir.join("..").join("shot-1.png");
    let cases = [
        payload(h.dir.join("other.png").to_string_lossy()),
        payload(h.dir.join("shot-.png").to_string_lossy()),
        payload(h.dir.join("shot-1a.png").to_string_lossy()),
        payload(h.dir.join("shot-1.PNG").to_string_lossy()),
        payload(h.dir.join("sub").join("shot-1.png").to_string_lossy()),
        payload(outside.to_string_lossy()),
        payload("shot-1.png"),
        payload(""),
        json!({}),
        json!({ "src": 123 }),
        json!({ "src": 0 }),
        json!({ "src": null }),
        json!({ "src": true }),
        json!({ "src": { "a": 1 } }),
        // One-element arrays join into the path in JS (String([p]) === p), so
        // they are NOT a miss; two elements join with a comma.
        json!({ "src": [h.dir.join("shot-1.png").to_string_lossy(), "x"] }),
        json!([]),
        json!(42),
    ];
    for case in cases {
        assert!(
            annotation.try_relay(&case).await.is_none(),
            "not an own shot: {case}"
        );
    }
    assert_eq!(h.child.snapshot().attempts, 0);
    assert!(!h.requests.exists(), "no request may reach the child");
}

#[tokio::test]
async fn a_non_200_answer_is_the_no_response_shape() {
    let h = harness("status500", &[("FIXTURE_ANNOTATION", "status500")]);
    let relay = h
        .annotation()
        .try_relay(&payload(h.dir.join("shot-1.png").to_string_lossy()))
        .await
        .expect("relayed");
    assert_eq!(relay["relayed"], 1);
    assert_eq!(
        result_of(&relay),
        json!({ "ok": false, "refresh": false, "text": NO_RESPONSE })
    );
    h.child.shutdown().await;
}

#[tokio::test]
async fn an_unparsable_body_is_the_no_response_shape() {
    let h = harness("notjson", &[("FIXTURE_ANNOTATION", "notjson")]);
    let relay = h
        .annotation()
        .try_relay(&payload(h.dir.join("shot-1.png").to_string_lossy()))
        .await
        .expect("relayed");
    assert_eq!(
        result_of(&relay),
        json!({ "ok": false, "refresh": false, "text": NO_RESPONSE })
    );
    h.child.shutdown().await;
}

#[tokio::test]
async fn a_json_array_is_a_valid_answer_but_a_number_is_not() {
    // `!result || typeof result !== 'object'`: arrays are objects in JS and
    // pass through untouched; numbers are not and become the fixed failure.
    let h = harness("array", &[("FIXTURE_ANNOTATION", "array")]);
    let relay = h
        .annotation()
        .try_relay(&payload(h.dir.join("shot-1.png").to_string_lossy()))
        .await
        .expect("relayed");
    assert_eq!(result_of(&relay), json!([{ "ok": true }]));
    h.child.shutdown().await;

    let h = harness("number", &[("FIXTURE_ANNOTATION", "number")]);
    let relay = h
        .annotation()
        .try_relay(&payload(h.dir.join("shot-1.png").to_string_lossy()))
        .await
        .expect("relayed");
    assert_eq!(
        result_of(&relay),
        json!({ "ok": false, "refresh": false, "text": NO_RESPONSE })
    );
    h.child.shutdown().await;
}

#[tokio::test]
async fn a_stalled_child_times_out_on_the_annotation_budget() {
    let h = harness("stall", &[("FIXTURE_ANNOTATION", "stall")]);
    let annotation = h.annotation().with_timeout(Duration::from_millis(150));
    let start = Instant::now();
    let relay = annotation
        .try_relay(&payload(h.dir.join("shot-1.png").to_string_lossy()))
        .await
        .expect("relayed");
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_eq!(
        result_of(&relay),
        json!({ "ok": false, "refresh": false, "text": NO_RESPONSE })
    );
    h.child.shutdown().await;
}

#[tokio::test]
async fn an_unavailable_child_is_the_service_unavailable_shape() {
    let h = harness_with("unavailable", &[], |config| {
        config.binary = Some(PathBuf::from("/nonexistent/multicc-remote"));
    });
    let relay = h
        .annotation()
        .try_relay(&payload(h.dir.join("shot-1.png").to_string_lossy()))
        .await
        .expect("relayed");
    assert_eq!(
        result_of(&relay),
        json!({ "ok": false, "refresh": false, "text": "远控服务不可用" })
    );
    assert_eq!(h.child.snapshot().attempts, 0);
}

#[tokio::test]
async fn handle_annotation_rechecks_the_path_itself() {
    let h = harness("recheck", &[]);
    assert_eq!(
        h.annotation()
            .handle_annotation(&json!({ "src": "x.png" }))
            .await,
        json!({ "ok": false, "refresh": false, "text": "不是远程屏幕截图" })
    );
    assert_eq!(h.child.snapshot().attempts, 0);
}
