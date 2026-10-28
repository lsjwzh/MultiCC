//! router 的逐帧测试：这里的「Chrome」就是手写的应答帧。

use super::*;
use serde_json::{json, Value};

fn anon() -> JoinOptions {
    JoinOptions {
        control: true,
        ..Default::default()
    }
}

fn named(name: &str, ttl_ms: u64) -> JoinOptions {
    JoinOptions {
        control: true,
        lane: Some(name.into()),
        ttl_ms,
        ..Default::default()
    }
}

fn chrome(out: &[Out]) -> Vec<Value> {
    out.iter()
        .filter_map(|o| match o {
            Out::Chrome(s) => Some(serde_json::from_str(s).unwrap()),
            _ => None,
        })
        .collect()
}

fn lines(out: &[Out], conn: ConnId) -> Vec<Value> {
    out.iter()
        .filter_map(|o| match o {
            Out::Line(c, s) if *c == conn => Some(serde_json::from_str(s).unwrap()),
            _ => None,
        })
        .collect()
}

fn closed(out: &[Out]) -> Vec<ConnId> {
    out.iter()
        .filter_map(|o| {
            if let Out::Close(c, _) = o {
                Some(*c)
            } else {
                None
            }
        })
        .collect()
}

fn method_of(frames: &[Value], method: &str) -> Value {
    frames
        .iter()
        .find(|f| f["method"] == method)
        .cloned()
        .unwrap_or_else(|| panic!("no {method} in {frames:?}"))
}

fn router() -> Router {
    let (mut r, out) = Router::new("ws://127.0.0.1:9222/devtools/browser/x");
    let discover = method_of(&chrome(&out), "Target.setDiscoverTargets");
    assert!(r
        .from_chrome(&json!({ "id": discover["id"], "result": {} }).to_string())
        .is_empty());
    r
}

fn reply(r: &mut Router, frame: &Value, result: Value) -> Vec<Out> {
    let mut answer = json!({ "id": frame["id"], "result": result });
    if let Some(sid) = frame.get("sessionId") {
        answer["sessionId"] = sid.clone();
    }
    r.from_chrome(&answer.to_string())
}

fn fail(r: &mut Router, frame: &Value, message: &str) -> Vec<Out> {
    r.from_chrome(
        &json!({ "id": frame["id"], "error": { "code": -32000, "message": message } }).to_string(),
    )
}

fn event(r: &mut Router, session: Option<&str>, method: &str, params: Value) -> Vec<Out> {
    let mut frame = json!({ "method": method, "params": params });
    if let Some(sid) = session {
        frame["sessionId"] = json!(sid);
    }
    r.from_chrome(&frame.to_string())
}

/// join 并完成根会话握手。
fn join_ready(r: &mut Router, conn: ConnId, options: JoinOptions, root: &str) -> Vec<Out> {
    let out = r.join(conn, options, 0);
    let attach = method_of(&chrome(&out), "Target.attachToBrowserTarget");
    reply(r, &attach, json!({ "sessionId": root }))
}

/// 调用方发一帧，返回转给 Chrome 的那一帧（没有则 None）和全部输出。
fn send(r: &mut Router, conn: ConnId, frame: Value) -> (Option<Value>, Vec<Out>) {
    let out = r.from_conn(conn, &frame.to_string());
    (chrome(&out).into_iter().next(), out)
}

#[test]
fn frames_wait_for_the_lane_root_then_carry_it() {
    let mut r = router();
    let out = r.join(1, anon(), 0);
    let attach = method_of(&chrome(&out), "Target.attachToBrowserTarget");
    assert!(
        lines(&out, 1).is_empty(),
        "not ready before the lane has its own browser session"
    );

    let (forwarded, _) = send(
        &mut r,
        1,
        json!({ "id": 1, "method": "Browser.getVersion" }),
    );
    assert!(forwarded.is_none(), "queued until the root session exists");

    let out = reply(&mut r, &attach, json!({ "sessionId": "ROOT-A" }));
    assert_eq!(lines(&out, 1)[0]["phase"], "ready");
    assert_eq!(lines(&out, 1)[0]["mode"], "isolated");
    let forwarded = method_of(&chrome(&out), "Browser.getVersion");
    assert_eq!(forwarded["sessionId"], "ROOT-A");

    let out = reply(&mut r, &forwarded, json!({ "product": "Chrome" }));
    assert_eq!(
        lines(&out, 1),
        vec![json!({ "id": 1, "result": { "product": "Chrome" } })]
    );
}

#[test]
fn responses_go_only_to_their_sender_and_late_ones_are_dropped() {
    let mut r = router();
    join_ready(&mut r, 1, anon(), "ROOT-A");
    join_ready(&mut r, 2, anon(), "ROOT-B");
    let (a, _) = send(&mut r, 1, json!({ "id": 7, "method": "Page.navigate" }));
    let (b, _) = send(&mut r, 2, json!({ "id": 7, "method": "Page.reload" }));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_ne!(
        a["id"], b["id"],
        "callers keep their ids, the wire gets unique ones"
    );

    let out = reply(&mut r, &b, json!({ "who": "b" }));
    assert_eq!(
        lines(&out, 2),
        vec![json!({ "id": 7, "result": { "who": "b" } })]
    );
    assert!(lines(&out, 1).is_empty());

    // A leaves with a request in flight: its lane root is detached, and the late
    // response goes nowhere — in particular not to B, whose own ids could collide.
    let out = r.leave(1, 0);
    let detach = method_of(&chrome(&out), "Target.detachFromTarget");
    assert_eq!(detach["params"]["sessionId"], "ROOT-A");
    let out = reply(&mut r, &a, json!({ "who": "a" }));
    assert!(
        out.is_empty(),
        "late response must not be broadcast: {out:?}"
    );
}

#[test]
fn events_follow_session_ownership() {
    let mut r = router();
    join_ready(&mut r, 1, anon(), "ROOT-A");
    join_ready(&mut r, 2, anon(), "ROOT-B");
    let (attach, _) = send(
        &mut r,
        1,
        json!({ "id": 2, "method": "Target.attachToTarget", "params": { "targetId": "T1", "flatten": true } }),
    );
    let attach = attach.unwrap();
    assert_eq!(attach["sessionId"], "ROOT-A");

    let out = event(
        &mut r,
        Some("ROOT-A"),
        "Target.attachedToTarget",
        json!({ "sessionId": "S1", "targetInfo": { "targetId": "T1" } }),
    );
    assert_eq!(lines(&out, 1)[0]["method"], "Target.attachedToTarget");
    assert!(
        lines(&out, 1)[0].get("sessionId").is_none(),
        "root session is invisible to the caller"
    );
    assert!(lines(&out, 2).is_empty());
    let out = reply(&mut r, &attach, json!({ "sessionId": "S1" }));
    assert_eq!(
        lines(&out, 1),
        vec![json!({ "id": 2, "result": { "sessionId": "S1" } })]
    );

    let out = event(&mut r, Some("S1"), "Network.responseReceived", json!({}));
    assert_eq!(lines(&out, 1)[0]["sessionId"], "S1");
    assert!(lines(&out, 2).is_empty());

    assert!(event(
        &mut r,
        Some("S-unknown"),
        "Network.responseReceived",
        json!({})
    )
    .is_empty());
    assert!(
        event(
            &mut r,
            None,
            "Target.targetCreated",
            json!({ "targetInfo": {} })
        )
        .is_empty(),
        "the gateway's own discovery events reach no isolated lane"
    );
}

#[test]
fn a_lane_cannot_borrow_another_lanes_session() {
    let mut r = router();
    join_ready(&mut r, 1, anon(), "ROOT-A");
    join_ready(&mut r, 2, anon(), "ROOT-B");
    event(
        &mut r,
        Some("ROOT-A"),
        "Target.attachedToTarget",
        json!({ "sessionId": "S1", "targetInfo": { "targetId": "T1" } }),
    );

    for frame in [
        json!({ "id": 5, "sessionId": "S1", "method": "Page.navigate", "params": { "url": "https://x" } }),
        json!({ "id": 6, "sessionId": "ROOT-A", "method": "Target.getTargets" }),
        json!({ "id": 7, "method": "Target.detachFromTarget", "params": { "sessionId": "S1" } }),
    ] {
        let (forwarded, out) = send(&mut r, 2, frame.clone());
        assert!(forwarded.is_none(), "{frame} must not reach Chrome");
        assert_eq!(lines(&out, 2)[0]["id"], frame["id"]);
        assert!(lines(&out, 2)[0]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }
}

#[test]
fn created_targets_are_leased_to_their_creator_until_it_leaves() {
    let mut r = router();
    join_ready(&mut r, 1, anon(), "ROOT-A");
    join_ready(&mut r, 2, anon(), "ROOT-B");
    let (create, _) = send(
        &mut r,
        1,
        json!({ "id": 1, "method": "Target.createTarget", "params": { "url": "about:blank" } }),
    );
    reply(&mut r, &create.unwrap(), json!({ "targetId": "T2" }));

    for method in ["Target.attachToTarget", "Target.closeTarget"] {
        let (forwarded, out) = send(
            &mut r,
            2,
            json!({ "id": 9, "method": method, "params": { "targetId": "T2" } }),
        );
        assert!(
            forwarded.is_none(),
            "{method} on a leased target must not reach Chrome"
        );
        let message = lines(&out, 2)[0]["error"]["message"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(message.starts_with("cdp-target-busy"), "{message}");
    }

    r.leave(1, 0);
    let (forwarded, _) = send(
        &mut r,
        2,
        json!({ "id": 10, "method": "Target.attachToTarget", "params": { "targetId": "T2" } }),
    );
    assert!(forwarded.is_some(), "the lease ends with its lane");
}

#[test]
fn concurrent_attaches_to_one_tab_let_exactly_one_through() {
    let mut r = router();
    join_ready(&mut r, 1, anon(), "ROOT-A");
    join_ready(&mut r, 2, anon(), "ROOT-B");
    let (first, _) = send(
        &mut r,
        1,
        json!({ "id": 1, "method": "Target.attachToTarget", "params": { "targetId": "T1" } }),
    );
    let (second, out) = send(
        &mut r,
        2,
        json!({ "id": 1, "method": "Target.attachToTarget", "params": { "targetId": "T1" } }),
    );
    assert!(
        second.is_none(),
        "the tab is claimed while the first attach is still in flight"
    );
    assert!(lines(&out, 2)[0]["error"]["message"]
        .as_str()
        .unwrap()
        .starts_with("cdp-target-busy"));

    // The first attach fails (tab vanished): the claim is released.
    fail(&mut r, &first.unwrap(), "No target with given id found");
    let (retry, _) = send(
        &mut r,
        2,
        json!({ "id": 2, "method": "Target.attachToTarget", "params": { "targetId": "T1" } }),
    );
    assert!(retry.is_some());
}

#[test]
fn detaching_the_last_session_or_destroying_the_target_ends_the_lease() {
    let mut r = router();
    join_ready(&mut r, 1, anon(), "ROOT-A");
    join_ready(&mut r, 2, anon(), "ROOT-B");
    let (attach, _) = send(
        &mut r,
        1,
        json!({ "id": 1, "method": "Target.attachToTarget", "params": { "targetId": "T1" } }),
    );
    event(
        &mut r,
        Some("ROOT-A"),
        "Target.attachedToTarget",
        json!({ "sessionId": "S1", "targetInfo": { "targetId": "T1" } }),
    );
    reply(&mut r, &attach.unwrap(), json!({ "sessionId": "S1" }));
    // A nested auto-attached worker under S1 goes with it.
    event(
        &mut r,
        Some("S1"),
        "Target.attachedToTarget",
        json!({ "sessionId": "S1-w", "targetInfo": { "targetId": "W1" } }),
    );
    event(
        &mut r,
        Some("ROOT-A"),
        "Target.detachedFromTarget",
        json!({ "sessionId": "S1" }),
    );
    assert!(
        event(&mut r, Some("S1-w"), "Runtime.consoleAPICalled", json!({})).is_empty(),
        "child sessions go with their parent"
    );
    let (forwarded, _) = send(
        &mut r,
        2,
        json!({ "id": 1, "method": "Target.attachToTarget", "params": { "targetId": "T1" } }),
    );
    assert!(forwarded.is_some(), "no session left on T1, so it is free");

    let (create, _) = send(
        &mut r,
        1,
        json!({ "id": 2, "method": "Target.createTarget", "params": { "url": "about:blank" } }),
    );
    reply(&mut r, &create.unwrap(), json!({ "targetId": "T3" }));
    event(
        &mut r,
        None,
        "Target.targetDestroyed",
        json!({ "targetId": "T3" }),
    );
    assert!(!r.leases.contains_key("T3"));
}

#[test]
fn browser_close_is_refused_unless_the_caller_opted_in() {
    let mut r = router();
    join_ready(&mut r, 1, anon(), "ROOT-A");
    let (forwarded, out) = send(&mut r, 1, json!({ "id": 3, "method": "Browser.close" }));
    assert!(forwarded.is_none());
    assert!(lines(&out, 1)[0]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("refused"));

    join_ready(
        &mut r,
        2,
        JoinOptions {
            allow_browser_close: true,
            ..anon()
        },
        "ROOT-B",
    );
    let (forwarded, _) = send(&mut r, 2, json!({ "id": 3, "method": "Browser.close" }));
    assert!(forwarded.is_some());
}

#[test]
fn chrome_without_browser_sessions_falls_back_to_shared_mode() {
    let mut r = router();
    let out = r.join(1, anon(), 0);
    let attach = method_of(&chrome(&out), "Target.attachToBrowserTarget");
    let out = fail(
        &mut r,
        &attach,
        "'Target.attachToBrowserTarget' wasn't found",
    );
    assert_eq!(lines(&out, 1)[0]["mode"], "shared");

    let (forwarded, _) = send(&mut r, 1, json!({ "id": 1, "method": "Target.getTargets" }));
    assert!(forwarded.unwrap().get("sessionId").is_none());
    let out = event(&mut r, None, "Target.targetCreated", json!({}));
    assert_eq!(lines(&out, 1).len(), 1, "shared lanes see root events");

    // Explicit attaches are still tracked and handed back on leave.
    let (attach, _) = send(
        &mut r,
        1,
        json!({ "id": 2, "method": "Target.attachToTarget", "params": { "targetId": "T1", "flatten": true } }),
    );
    reply(&mut r, &attach.unwrap(), json!({ "sessionId": "S1" }));
    let out = r.leave(1, 0);
    assert_eq!(
        method_of(&chrome(&out), "Target.detachFromTarget")["params"]["sessionId"],
        "S1"
    );
}

#[test]
fn a_named_lane_outlives_its_connections_until_the_ttl() {
    let mut r = router();
    join_ready(&mut r, 1, named("job", 1_000), "ROOT-J");
    event(
        &mut r,
        Some("ROOT-J"),
        "Target.attachedToTarget",
        json!({ "sessionId": "S1", "targetInfo": { "targetId": "T1" } }),
    );
    assert!(
        chrome(&r.leave(1, 0)).is_empty(),
        "a named lane keeps its sessions across connections"
    );

    let out = r.join(2, named("job", 1_000), 500);
    assert!(chrome(&out).is_empty(), "reuses the existing root session");
    assert_eq!(lines(&out, 2)[0]["phase"], "ready", "ready immediately");
    let (forwarded, _) = send(
        &mut r,
        2,
        json!({ "id": 1, "sessionId": "S1", "method": "Runtime.evaluate" }),
    );
    assert_eq!(forwarded.unwrap()["sessionId"], "S1");

    r.leave(2, 600);
    assert!(r.expire(1_599).is_empty());
    let out = r.expire(1_600);
    assert_eq!(
        method_of(&chrome(&out), "Target.detachFromTarget")["params"]["sessionId"],
        "ROOT-J"
    );
    assert!(!r.has_lanes());
}

#[test]
fn releasing_a_named_lane_closes_its_connections() {
    let mut r = router();
    join_ready(&mut r, 1, named("job", 60_000), "ROOT-J");
    let (found, out) = r.release("job");
    assert!(found);
    assert_eq!(closed(&out), vec![1]);
    assert!(!r.release("job").0);
}

#[test]
fn a_lane_that_leaves_before_its_root_arrives_hands_it_back() {
    let mut r = router();
    let out = r.join(1, anon(), 0);
    let attach = method_of(&chrome(&out), "Target.attachToBrowserTarget");
    r.leave(1, 0);
    let out = reply(&mut r, &attach, json!({ "sessionId": "ROOT-late" }));
    assert_eq!(
        method_of(&chrome(&out), "Target.detachFromTarget")["params"]["sessionId"],
        "ROOT-late"
    );
}

#[test]
fn malformed_frames_are_answered_locally() {
    let mut r = router();
    join_ready(&mut r, 1, anon(), "ROOT-A");
    for (frame, code) in [
        ("[1]", -32700),
        (r#"{"method":"Page.enable"}"#, -32600),
        (r#"{"id":"x","method":"Page.enable"}"#, -32600),
        (r#"{"id":1}"#, -32600),
    ] {
        let out = r.from_conn(1, frame);
        assert!(chrome(&out).is_empty(), "{frame}");
        assert_eq!(lines(&out, 1)[0]["error"]["code"], code, "{frame}");
    }
}

#[test]
fn wire_ids_wrap_at_int32_and_skip_ids_still_in_flight() {
    let mut r = router();
    join_ready(&mut r, 1, anon(), "ROOT-A");
    r.next_id = i64::from(i32::MAX);
    let (first, _) = send(&mut r, 1, json!({ "id": 1, "method": "A.a" }));
    assert_eq!(first.unwrap()["id"], i32::MAX);
    r.pending.insert(
        1,
        Pending {
            conn: None,
            lane: GATEWAY,
            original: Value::Null,
            kind: Kind::Internal,
            root: None,
        },
    );
    let (second, _) = send(&mut r, 1, json!({ "id": 2, "method": "A.b" }));
    assert_eq!(second.unwrap()["id"], 2);
}
