//! 移植 tests/test-remote-screen.js 的服务端用例（HTTP 路由、输入白名单、截图、
//! 标注、唤屏、平台画像）。浏览器侧（public/chat-remote-screen.js）与 Node 侧的
//! annotation-live / connection-router / mcu.sh 用例不在这个进程的职责里。

mod support;

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::{Json, Router};
use multicc_remote::agent::{AgentClient, UnixAgentClient};
use multicc_remote::annotation::handle_annotation;
use multicc_remote::host::{self, Host};
use multicc_remote::region::crop_geometry;
use multicc_remote::routes::{self, AppState};
use multicc_remote::wake;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use support::*;

// ── 组装一个「macOS + 假命令 + 假 agent」的状态 ────────────────────────
struct MacEnv {
    state: AppState,
    agent: Arc<FakeAgent>,
    commands: Arc<std::sync::Mutex<Vec<Vec<String>>>>,
}

fn mac_env(tag: &str) -> MacEnv {
    let dir = temp_dir(tag);
    let agent = FakeAgent::new(|_| json!({ "ok": true }));
    let commands = Arc::new(std::sync::Mutex::new(Vec::new()));
    let profile = host::profile_for("darwin", "/Users/x", &HashMap::new());
    let host = Arc::new(Host::new(profile, mac_exec(commands.clone()), Some(multicc_remote::agent::host_call(agent.clone()))));
    let state = AppState::new(dir, host, agent.clone(), "secret").with_p2p(None);
    MacEnv { state, agent, commands }
}

fn query(pairs: &[(&str, &str)]) -> Query<HashMap<String, String>> {
    Query(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
}

fn json_body(value: Value) -> Option<Json<Value>> {
    Some(Json(value))
}

// ── buildInput ─────────────────────────────────────────────────────────
#[test]
fn pointer_samples_keep_logical_coordinates_and_viewer() {
    let built = routes::build_input(&json!({ "op": "pointer", "viewer": "viewer-1", "mask": 1, "x": 123, "y": 45 })).unwrap();
    assert_eq!(
        built,
        json!({ "op": "pointer", "session": "remote-screen", "viewer": "viewer-1", "mask": 1,
                "x": 123, "y": 45, "allowSystem": true })
    );
    for body in [
        json!({ "viewer": "", "mask": 1, "x": 1, "y": 2 }),
        json!({ "viewer": "../invalid", "mask": 1, "x": 1, "y": 2 }),
        json!({ "viewer": "valid", "mask": 4, "x": 1, "y": 2 }),
        json!({ "viewer": "valid", "mask": 0, "y": 2 }),
    ] {
        let mut body = body.as_object().unwrap().clone();
        body.insert("op".into(), json!("pointer"));
        assert!(routes::build_input(&Value::Object(body)).is_err());
    }
}

#[test]
fn input_whitelist_coerces_clamps_and_pins_the_session() {
    for op in ["unlock", "see", "set", "snap", "probe-unlock", ""] {
        let error = routes::build_input(&json!({ "op": op })).unwrap_err();
        assert_eq!(error.status, 400, "{op}");
    }
    let click = routes::build_input(&json!({
        "op": "click", "x": "10.5", "y": 20, "button": "right", "count": 9,
        "session": "evil", "allowTerminal": true
    }))
    .unwrap();
    assert_eq!(
        click,
        json!({ "op": "click", "session": "remote-screen", "x": 10.5, "y": 20, "allowSystem": true,
                "button": "right", "count": 3 })
    );
    assert_eq!(routes::build_input(&json!({ "op": "scroll", "x": 1, "y": 1, "amount": -999 })).unwrap()["amount"], json!(-50));
    assert!(routes::build_input(&json!({ "op": "drag", "x": 1, "y": 1 })).is_err());
    assert_eq!(routes::build_input(&json!({ "op": "drag", "x": 1, "y": 1, "x2": 5, "y2": 5, "ms": 1 })).unwrap()["ms"], json!(80));
    assert!(routes::build_input(&json!({ "op": "type", "text": "x".repeat(4001) })).is_err());
    assert!(routes::build_input(&json!({ "op": "press", "keys": "" })).is_err());
    assert_eq!(routes::build_input(&json!({ "op": "press", "keys": " cmd+c " })).unwrap()["keys"], json!("cmd+c"));
    assert_eq!(
        routes::build_input(&json!({ "op": "release" })).unwrap(),
        json!({ "op": "release", "session": "remote-screen" })
    );
}

// ── Agent 客户端 ───────────────────────────────────────────────────────
#[tokio::test]
async fn agent_call_speaks_one_json_line_over_the_unix_socket() {
    let dir = temp_dir("agent");
    let sock = dir.join("a.sock");
    let listener = tokio::net::UnixListener::bind(&sock).unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 256];
        loop {
            let n = tokio::io::AsyncReadExt::read(&mut stream, &mut chunk).await.unwrap();
            buf.extend_from_slice(&chunk[..n]);
            if buf.contains(&b'\n') {
                break;
            }
        }
        let req: Value = serde_json::from_slice(&buf[..buf.iter().position(|b| *b == b'\n').unwrap()]).unwrap();
        let reply = json!({ "ok": true, "echo": req["op"], "session": req["session"] });
        let mut line = serde_json::to_string(&reply).unwrap();
        line.push('\n');
        tokio::io::AsyncWriteExt::write_all(&mut stream, line.as_bytes()).await.unwrap();
    });
    let client = UnixAgentClient::new(Some(sock));
    let reply = client.call(json!({ "op": "status", "session": "remote-screen" }), None).await;
    assert_eq!(reply, json!({ "ok": true, "echo": "status", "session": "remote-screen" }));

    let missing = UnixAgentClient::new(Some(dir.join("missing.sock")));
    assert_eq!(missing.call(json!({ "op": "status" }), None).await["error"], json!("agent-unreachable"));
}

// ── 路由 ───────────────────────────────────────────────────────────────
#[tokio::test]
async fn frame_is_a_logical_width_jpeg_and_snapshot_returns_a_download_url() {
    let env = mac_env("routes");
    let response = routes::frame(State(env.state.clone()), query(&[])).await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "image/jpeg");
    assert_eq!(response.headers()["x-screen-width"], "1470");
    assert_eq!(env.agent.requests()[0]["op"], json!("snap"));

    let snap = body_json(routes::snapshot(State(env.state.clone()), json_body(json!({}))).await).await;
    assert_eq!(snap["width"], json!(1470));
    let path = snap["path"].as_str().unwrap();
    assert!(path.contains("shot-") && path.ends_with(".png"), "{path}");
    let url = snap["url"].as_str().unwrap();
    assert!(url.starts_with("/api/download?path=") && url.ends_with("&inline=1"), "{url}");

    let bad = routes::input(State(env.state.clone()), json_body(json!({ "op": "unlock" }))).await;
    assert_eq!(bad.status(), 400);

    env.agent.set(|_| json!({ "ok": false, "reason": "user-stopped" }));
    let halted = body_json(routes::input(State(env.state.clone()), json_body(json!({ "op": "click", "x": 1, "y": 2 }))).await).await;
    assert_eq!(halted["error"], json!("user-stopped"));
    assert!(halted["message"].as_str().unwrap().contains("Esc"));
}

#[tokio::test]
async fn annotations_run_as_input_and_refresh_the_same_file() {
    let env = mac_env("annotation");
    let shot = env.state.screen.dir.join("shot-1.png");
    std::fs::write(&shot, "old").unwrap();
    let src = shot.to_string_lossy().to_string();

    let point = handle_annotation(
        &env.state,
        &json!({ "src": src, "width": 1470, "height": 956, "kind": "point", "a": { "x": 100, "y": 50 } }),
    )
    .await;
    assert_eq!(point, json!({ "ok": true, "refresh": true, "text": "已点击 (100, 50)" }));
    let ops: Vec<Value> = env.agent.requests().iter().map(|r| r["op"].clone()).collect();
    assert_eq!(ops, vec![json!("click"), json!("snap")]);
    assert_eq!(std::fs::read_to_string(&shot).unwrap(), "img");

    env.agent.reset();
    // 标注图若被缩小到一半，坐标按逻辑宽放大回去。
    handle_annotation(
        &env.state,
        &json!({ "src": src, "width": 735, "kind": "arrow", "a": { "x": 10, "y": 10 }, "b": { "x": 20, "y": 30 } }),
    )
    .await;
    assert_eq!(
        env.agent.requests()[0],
        json!({ "op": "drag", "session": "remote-screen", "x": 20, "y": 20, "allowSystem": true,
                "x2": 40, "y2": 60, "ms": 400 })
    );

    env.agent.reset();
    handle_annotation(
        &env.state,
        &json!({ "src": src, "width": 1470, "kind": "box", "a": { "x": 0, "y": 0 }, "b": { "x": 10, "y": 20 } }),
    )
    .await;
    let click = &env.agent.requests()[0];
    assert_eq!((click["x"].clone(), click["y"].clone()), (json!(5), json!(10)));

    env.agent.reset();
    let recapture = handle_annotation(&env.state, &json!({ "src": src, "width": 1470, "kind": "recapture" })).await;
    assert_eq!(recapture["refresh"], json!(true));
    let ops: Vec<Value> = env.agent.requests().iter().map(|r| r["op"].clone()).collect();
    assert_eq!(ops, vec![json!("snap")]);

    env.agent.set(|req| if req["op"] == json!("click") { json!({ "ok": false, "reason": "screen-locked" }) } else { json!({ "ok": true }) });
    let locked = handle_annotation(&env.state, &json!({ "src": src, "width": 1470, "kind": "point", "a": { "x": 1, "y": 1 } })).await;
    assert_eq!(locked["ok"], json!(false));
    assert!(locked["text"].as_str().unwrap().contains("锁定"));

    let stranger = handle_annotation(&env.state, &json!({ "src": shot.with_file_name("shot-9.png"), "kind": "point", "a": { "x": 1, "y": 1 } })).await;
    assert_eq!(stranger["ok"], json!(false));
    assert!(!multicc_remote::annotation::is_own_shot(&env.state.screen.dir, &env.state.screen.dir.join("live.jpg")));
    assert!(!multicc_remote::annotation::is_own_shot(&env.state.screen.dir, &env.state.screen.dir.join("sub/shot-1.png")));
}

// ── 平台画像 ───────────────────────────────────────────────────────────
#[test]
fn desktop_host_profiles_match_the_js_table() {
    let mac = host::profile_for("darwin", "/Users/x", &HashMap::new());
    assert!(mac.supported);
    assert_eq!(mac.transport, "unix");
    assert_eq!(mac.modifier, "cmd");
    assert!(mac.features.control);
    assert_eq!(mac.agent_sock.as_deref(), Some("/Users/x/.multicc/agent/agent.sock"));
    assert_eq!(mac.rfb_sock.as_deref(), Some("/Users/x/.multicc/agent/rfb.sock"));

    let win = host::profile_for("win32", "C:\\Users\\x", &HashMap::new());
    assert!(!win.supported);
    assert_eq!(win.transport, "named-pipe");
    assert_eq!(win.modifier, "ctrl");
    assert_eq!(win.rfb_sock, None);
    assert_eq!(win.features, host::Features::NONE);

    let env: HashMap<String, String> = [("XDG_RUNTIME_DIR".to_string(), "/run/user/7".to_string())].into_iter().collect();
    let linux = host::profile_for("linux", "/home/x", &env);
    assert!(linux.supported);
    assert_eq!(linux.transport, "unix");
    assert_eq!(linux.modifier, "ctrl");
    assert_eq!(linux.agent_sock.as_deref(), Some("/run/user/7/multicc-agent/agent.sock"));
    assert_eq!(linux.features, host::Features::LINUX);
    assert_eq!(linux.rfb_sock, None);
}

#[tokio::test]
async fn linux_capture_goes_through_the_agents_snap_and_mac_helpers_fail_loudly() {
    let agent = FakeAgent::new(|req| {
        json!({ "ok": true, "path": req["path"], "width": 1920, "height": 1080,
                "crop": req.get("crop").cloned().unwrap_or(Value::Null), "ms": 12 })
    });
    let env: HashMap<String, String> = [("XDG_RUNTIME_DIR".to_string(), "/run/user/7".to_string())].into_iter().collect();
    let profile = host::profile_for("linux", "/home/x", &env);
    let host = Host::new(profile, panic_exec(), Some(multicc_remote::agent::host_call(agent.clone())));

    let full = host.capture_direct("/tmp/x/live.jpg", None, "remote-screen", true, 60).await.unwrap();
    let requests = agent.requests();
    assert_eq!(
        requests[0],
        json!({ "op": "snap", "path": "/tmp/x/live.jpg", "session": "remote-screen", "jpeg": true, "quality": 60 })
    );
    assert_eq!((full.width, full.height, full.region.clone()), (1920.0, 1080.0, None));

    let region = multicc_remote::region::Region { x: 10.0, y: 20.0, width: 100.0, height: 50.0 };
    let cropped = host.capture_direct("/tmp/x/crop.jpg", Some(region), "remote-screen", true, 85).await.unwrap();
    assert_eq!(agent.requests()[1]["crop"], json!({ "x": 10, "y": 20, "width": 100, "height": 50 }));
    assert_eq!(agent.requests()[1]["quality"], json!(85));
    assert_eq!(cropped.region, Some(json!({ "x": 10, "y": 20, "width": 100, "height": 50 })));

    let cached = host.cached_logical_size().unwrap();
    assert_eq!((cached.width, cached.height), (1920.0, 1080.0));
    let logical = host.logical_size(1920.0, 1080.0).await;
    assert_eq!((logical.width, logical.height), (1920.0, 1080.0));

    // 裁到屏幕外是调用方的错 → 400，不该当成 agent 故障。
    let outside = FakeAgent::new(|_| json!({ "ok": false, "error": "region-outside-screen" }));
    let profile = host::profile_for("linux", "/home/x", &env);
    let outside_host = Host::new(profile, panic_exec(), Some(multicc_remote::agent::host_call(outside)));
    let error = outside_host.capture_direct("/tmp/x/o.jpg", Some(region), "remote-screen", true, 85).await.unwrap_err();
    assert_eq!((error.status, error.message.as_str()), (400, "region-outside-screen"));

    // 平台专有的壳外调用要明说走错了路，而不是去 exec 一个不存在的命令。
    assert_eq!(host.image_size("/tmp/x/raw.png").await.unwrap_err().reason.as_deref(), Some("wrong-platform-helper"));
    let area = crop_geometry(region, (1920.0, 1080.0), (1920.0, 1080.0)).unwrap();
    assert_eq!(host.crop_image("/tmp/x/raw.png", area, "/tmp/x/c.png").await.unwrap_err().reason.as_deref(), Some("wrong-platform-helper"));
    assert_eq!(host.convert_image("/tmp/x/raw.png", "/tmp/x/o.jpg", true, Some(60), None).await.unwrap_err().reason.as_deref(), Some("wrong-platform-helper"));
    assert_eq!(host.wake_display().await.unwrap_err().reason.as_deref(), Some("wrong-platform-helper"));
}

#[tokio::test]
async fn linux_wake_route_collapses_on_features_wake_not_supported() {
    let dir = temp_dir("linux-wake");
    let agent = FakeAgent::new(|_| json!({ "ok": true, "screenLocked": false }));
    let profile = host::profile_for("linux", "/home/x", &HashMap::new());
    let host = Arc::new(Host::new(profile, panic_exec(), Some(multicc_remote::agent::host_call(agent.clone()))));
    let state = AppState::new(dir, host, agent, "secret").with_p2p(None);

    let get = body_json(wake::get(&state, &HeaderMap::new()).await).await;
    assert_eq!(get["canWake"], json!(false));
    let caps = body_json(routes::capabilities(State(state.clone())).await).await;
    assert_eq!(caps["supported"], json!(true));
    assert_eq!(caps["features"]["wake"], json!(false));
    // 唤屏在 Linux 上是 409 + platform-unsupported，且不查询 agent。
    let post = wake::post(&state, &HeaderMap::new()).await;
    assert_eq!(post.status(), 409);
}

#[tokio::test]
async fn linux_install_hint_reason_texts_and_type_timeout() {
    let dir = temp_dir("linux-hint");
    let agent = FakeAgent::new(|_| json!({ "ok": false, "error": "agent-unreachable" }));
    let profile = host::profile_for("linux", "/home/x", &HashMap::new());
    let host = Arc::new(Host::new(profile, panic_exec(), Some(multicc_remote::agent::host_call(agent.clone()))));
    let state = AppState::new(dir, host, agent.clone(), "secret").with_p2p(None);

    let caps = body_json(routes::capabilities(State(state.clone())).await).await;
    assert_eq!(caps["installHint"], json!("sh scripts/linux-agent/install.sh install"));

    let failed = body_json(routes::input(State(state.clone()), json_body(json!({ "op": "click", "x": 1, "y": 2 }))).await).await;
    assert_eq!(failed["error"], json!("agent-unreachable"));
    assert!(failed["message"].as_str().unwrap().contains("install.sh install"));

    for (code, needle) in [("wayland-session", "X11"), ("no-display", "X server"), ("interrupted", "中途")] {
        agent.set(move |_| json!({ "ok": false, "reason": code, "error": code }));
        let failed = body_json(routes::input(State(state.clone()), json_body(json!({ "op": "click", "x": 1, "y": 2 }))).await).await;
        assert_eq!(failed["error"], json!(code));
        assert!(failed["message"].as_str().unwrap().contains(needle), "{code}: {}", failed["message"]);
    }

    // 超时不能比打字本身短：agent 看到请求方断开会立刻停手，固定 8s 等于把长文本截断。
    agent.reset();
    agent.set(|_| json!({ "ok": true }));
    routes::input(State(state.clone()), json_body(json!({ "op": "type", "text": "x".repeat(4000) }))).await;
    routes::input(State(state.clone()), json_body(json!({ "op": "click", "x": 1, "y": 2 }))).await;
    let timeouts = agent.timeouts();
    assert!(timeouts[0].unwrap() >= std::time::Duration::from_millis(4000 * 25), "{:?}", timeouts[0]);
    assert_eq!(timeouts[1], None);
}

#[tokio::test]
async fn capabilities_answer_what_this_machine_can_do_and_non_mac_refuses_cleanly() {
    let env = mac_env("caps");
    let caps = body_json(routes::capabilities(State(env.state.clone())).await).await;
    assert_eq!(caps["ok"], json!(true));
    assert_eq!(caps["platform"], json!("darwin"));
    assert_eq!(caps["supported"], json!(true));
    assert_eq!(caps["transport"], json!("unix"));
    assert_eq!(caps["modifier"], json!("cmd"));
    assert_eq!(caps["reason"], Value::Null);
    assert_eq!(caps["installHint"], Value::Null);
    assert_eq!(
        caps["features"],
        json!({ "view": true, "control": true, "snapshot": true, "annotate": true,
                "stream": true, "wake": true, "unlock": true, "elementTree": true })
    );
    assert_eq!(caps["streams"], json!({ "h264": false, "rfb": false }));

    // win32：三条路由干净拒绝，不碰 agent 也不碰 shell（假 exec 一调就报错）。
    let dir = temp_dir("win");
    let agent = FakeAgent::new(|_| json!({ "ok": true }));
    let profile = host::profile_for("win32", "C:\\Users\\x", &HashMap::new());
    let host = Arc::new(Host::new(profile, panic_exec(), None));
    let state = AppState::new(dir, host, agent.clone(), "secret").with_p2p(None);

    assert_eq!(routes::frame(State(state.clone()), query(&[])).await.status(), 503);
    assert_eq!(routes::snapshot(State(state.clone()), json_body(json!({}))).await.status(), 503);
    let input = routes::input(State(state.clone()), json_body(json!({ "op": "click", "x": 1, "y": 2 }))).await;
    assert_eq!(input.status(), 503);
    let body = body_json(input).await;
    assert_eq!(body["error"], json!("platform-unsupported"));
    assert!(body["message"].as_str().unwrap().contains("还不支持远程屏幕"));
    assert_eq!(
        routes::input(State(state.clone()), json_body(json!({ "op": "unlock" }))).await.status(),
        400,
        "白名单仍然先于平台判断"
    );
    assert!(agent.requests().is_empty());
}

#[tokio::test]
async fn wake_is_only_for_auto_unlock_users_and_checks_the_real_unlock() {
    let env = mac_env("wake");
    let dir = env.state.screen.dir.clone();
    let mut consent = HeaderMap::new();
    consent.insert(wake::CONSENT_HEADER, "1".parse().unwrap());

    #[derive(Clone)]
    struct Flags {
        enabled: bool,
        locked: bool,
        permissions: bool,
        halted: bool,
        unlock_ok: bool,
        stays_locked: bool,
    }
    let flags = Arc::new(std::sync::Mutex::new(Flags {
        enabled: false,
        locked: true,
        permissions: true,
        halted: false,
        unlock_ok: true,
        stays_locked: false,
    }));
    let agent = FakeAgent::new({
        let flags = flags.clone();
        move |req| {
            let mut f = flags.lock().unwrap().clone();
            if req["op"] == json!("status") {
                return json!({ "ok": true, "screenLocked": f.locked,
                    "accessibility": f.permissions, "screenRecording": f.permissions,
                    "control": { "halted": f.halted }, "unlockPassword": f.enabled });
            }
            if req["op"] != json!("unlock") {
                return json!({ "ok": true });
            }
            assert_eq!(*req, json!({ "op": "unlock", "session": "remote-screen" }));
            if !f.unlock_ok {
                return json!({ "ok": false, "reason": "password-needs-authorization" });
            }
            if !f.stays_locked {
                f.locked = false;
                *flags.lock().unwrap() = f;
            }
            json!({ "ok": true })
        }
    });
    let profile = host::profile_for("darwin", "/Users/x", &HashMap::new());
    let host = Arc::new(Host::new(profile, mac_exec(Arc::new(std::sync::Mutex::new(Vec::new()))), Some(multicc_remote::agent::host_call(agent.clone()))));
    let state = AppState::new(dir, host, agent.clone(), "secret").with_p2p(None);

    let get = body_json(wake::get(&state, &consent).await).await;
    assert_eq!(get["canWake"], json!(false));
    assert_eq!(agent.requests().iter().filter(|r| r["op"] == json!("unlock")).count(), 0);

    let error = body_json(wake::post(&state, &consent).await).await["error"].clone();
    assert_eq!(error, json!("auto-unlock-disabled"));

    flags.lock().unwrap().enabled = true;
    flags.lock().unwrap().permissions = false;
    assert_eq!(body_json(wake::post(&state, &consent).await).await["error"], json!("permissions-required"));

    flags.lock().unwrap().permissions = true;
    flags.lock().unwrap().halted = true;
    assert_eq!(body_json(wake::post(&state, &consent).await).await["error"], json!("user-stopped"));

    flags.lock().unwrap().halted = false;
    flags.lock().unwrap().unlock_ok = false;
    assert_eq!(body_json(wake::post(&state, &consent).await).await["error"], json!("password-needs-authorization"));

    flags.lock().unwrap().unlock_ok = true;
    flags.lock().unwrap().stays_locked = true;
    assert_eq!(body_json(wake::post(&state, &consent).await).await["error"], json!("still-locked"));

    flags.lock().unwrap().stays_locked = false;
    let ok = body_json(wake::post(&state, &consent).await).await;
    assert_eq!(ok["screenLocked"], json!(false));
    assert_eq!(ok["message"], json!("屏幕已唤起，正在恢复画面。"));

    let unlocks = agent.requests().iter().filter(|r| r["op"] == json!("unlock")).count();
    assert_eq!(unlocks, 3, "只有锁屏时才提交密码（三次 post 都处于锁屏）");
    // 未锁屏时只唤醒，不再提交密码。
    let before = agent.requests().len();
    assert_eq!(body_json(wake::post(&state, &consent).await).await["ok"], json!(true));
    assert_eq!(agent.requests()[before..].iter().filter(|r| r["op"] == json!("unlock")).count(), 0);

    // 成功后清帧缓存：下一次 frame 必须重新 snap。
    agent.reset();
    routes::frame(State(state.clone()), query(&[])).await;
    assert_eq!(agent.requests().iter().filter(|r| r["op"] == json!("snap")).count(), 1);
}

#[tokio::test]
async fn concurrent_wake_clicks_never_submit_the_password_twice() {
    let dir = temp_dir("wake-busy");
    let agent = FakeAgent::new(|req| {
        if req["op"] == json!("status") {
            json!({ "ok": true, "screenLocked": false, "accessibility": true, "screenRecording": true,
                    "control": {}, "unlockPassword": true })
        } else {
            json!({ "ok": true })
        }
    });
    let gate = Arc::new(tokio::sync::Notify::new());
    let exec = {
        let gate = gate.clone();
        multicc_remote::host::Exec::from(Arc::new(move |cmd: String, _args: Vec<String>, _timeout: std::time::Duration| {
            let gate = gate.clone();
            Box::pin(async move {
                if cmd == "/usr/bin/caffeinate" {
                    gate.notified().await;
                }
                Ok::<String, String>(String::new())
            }) as futures_util::future::BoxFuture<'static, Result<String, String>>
        }) as Arc<dyn Fn(String, Vec<String>, std::time::Duration) -> futures_util::future::BoxFuture<'static, Result<String, String>> + Send + Sync>)
    };
    let profile = host::profile_for("darwin", "/Users/x", &HashMap::new());
    let host = Arc::new(Host::new(profile, exec, Some(multicc_remote::agent::host_call(agent.clone()))));
    let state = AppState::new(dir, host, agent.clone(), "secret").with_p2p(None);
    let mut consent = HeaderMap::new();
    consent.insert(wake::CONSENT_HEADER, "1".parse().unwrap());

    let first = {
        let state = state.clone();
        let consent = consent.clone();
        tokio::spawn(async move { wake::post(&state, &consent).await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(body_json(wake::post(&state, &consent).await).await["error"], json!("busy"));
    gate.notify_waiters();
    let response = first.await.unwrap();
    assert_eq!(body_json(response).await["ok"], json!(true));
    assert_eq!(agent.requests().iter().filter(|r| r["op"] == json!("status")).count(), 2);
}

#[tokio::test]
async fn source_crop_keeps_native_pixels_and_distinguishes_cache_keys() {
    let env = mac_env("crop");
    let region = query(&[("x", "100"), ("y", "80"), ("width", "400"), ("height", "240")]);
    let first = routes::frame(State(env.state.clone()), region).await;
    assert_eq!(first.headers()["x-screen-width"], "1470");
    assert_eq!(first.headers()["x-region-x"], "100");
    assert_eq!(first.headers()["x-region-width"], "400");

    let sips: Vec<Vec<String>> = env
        .commands
        .lock()
        .unwrap()
        .iter()
        .filter(|cmd| cmd[0] == "sips" && cmd[1] != "-g")
        .cloned()
        .collect();
    assert_eq!(sips.len(), 2);
    // log 的第 0 项是命令名，参数从 1 开始：对齐 JS 的 args.slice(1, 6)
    assert_eq!(&sips[0][2..7], ["--cropToHeightWidth", "480", "800", "--cropOffset", "160"]);
    assert_eq!(sips[0][7], "200");
    assert!(sips[1].iter().any(|a| a == "85"));
    assert!(!sips[1].iter().any(|a| a == "--resampleWidth"));
    assert_eq!(
        sips[1][sips[1].iter().position(|a| a == "--out").unwrap() - 1],
        *sips[0].last().unwrap(),
        "JPEG 读的是原生裁剪结果，不是整屏 JPEG"
    );

    let count = env.agent.requests().iter().filter(|r| r["op"] == json!("snap")).count();
    routes::frame(State(env.state.clone()), query(&[("x", "100"), ("y", "80"), ("width", "400"), ("height", "240")])).await;
    let same = env.agent.requests().iter().filter(|r| r["op"] == json!("snap")).count();
    assert_eq!(same, count, "同一区域复用帧缓存");
    routes::frame(State(env.state.clone()), query(&[("x", "120"), ("y", "80"), ("width", "400"), ("height", "240")])).await;
    let other = env.agent.requests().iter().filter(|r| r["op"] == json!("snap")).count();
    assert_eq!(other, count + 1, "换一个区域不能吃到上一块裁剪");
    routes::frame(State(env.state.clone()), query(&[])).await;
    assert_eq!(env.agent.requests().iter().filter(|r| r["op"] == json!("snap")).count(), count + 2);
}

#[tokio::test]
async fn invalid_and_outside_regions_are_rejected_and_captures_stay_bounded() {
    let env = mac_env("regions");
    for pairs in [
        vec![("x", "-1"), ("y", "0"), ("width", "5"), ("height", "5")],
        vec![("x", "1")],
        vec![("x", "0"), ("y", "0"), ("width", "Infinity"), ("height", "5")],
        vec![("x", " "), ("y", "0"), ("width", "5"), ("height", "5")],
        vec![("x", "2000"), ("y", "0"), ("width", "10"), ("height", "10")],
    ] {
        let response = routes::frame(State(env.state.clone()), query(&pairs)).await;
        assert_eq!(response.status(), 400, "{pairs:?}");
    }

    let edge = routes::frame(
        State(env.state.clone()),
        query(&[("x", "1460"), ("y", "950"), ("width", "100"), ("height", "100")]),
    )
    .await;
    assert_eq!(edge.headers()["x-region-width"], "10");
    assert_eq!(edge.headers()["x-region-height"], "6");

    env.agent.reset();
    let a = routes::frame(State(env.state.clone()), query(&[("x", "10"), ("y", "10"), ("width", "50"), ("height", "50")]));
    let b = routes::frame(State(env.state.clone()), query(&[("x", "20"), ("y", "20"), ("width", "50"), ("height", "50")]));
    let (a, b) = tokio::join!(a, b);
    assert_eq!((a.status().as_u16(), b.status().as_u16()), (200, 200));
    let paths: std::collections::HashSet<String> = env
        .agent
        .requests()
        .iter()
        .filter(|r| r["op"] == json!("snap"))
        .map(|r| r["path"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(paths.len(), 2, "每次截图都有自己的原始文件");
    let leftovers: Vec<String> = std::fs::read_dir(&env.state.screen.dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".capture-") || n.starts_with(".frame-"))
        .collect();
    assert!(leftovers.is_empty(), "临时目录要清掉：{leftovers:?}");
}

#[tokio::test]
async fn cropped_snapshots_keep_offsets_through_point_arrow_and_recapture() {
    let env = mac_env("offset");
    let snap = body_json(
        routes::snapshot(State(env.state.clone()), json_body(json!({ "x": 100, "y": 80, "width": 400, "height": 240 }))).await,
    )
    .await;
    assert_eq!(snap["region"]["pixelWidth"], json!(800));
    let path = snap["path"].as_str().unwrap().to_string();
    assert!(std::path::Path::new(&format!("{path}.json")).exists());

    env.agent.reset();
    handle_annotation(&env.state, &json!({ "src": path, "width": 800, "height": 480, "kind": "point", "a": { "x": 200, "y": 100 } })).await;
    let click = &env.agent.requests()[0];
    assert_eq!((click["x"].clone(), click["y"].clone()), (json!(200), json!(130)));

    env.agent.reset();
    handle_annotation(&env.state, &json!({ "src": path, "width": 800, "height": 480, "kind": "arrow", "a": { "x": 0, "y": 0 }, "b": { "x": 600, "y": 400 } })).await;
    let drag = &env.agent.requests()[0];
    assert_eq!(
        (drag["x"].clone(), drag["y"].clone(), drag["x2"].clone(), drag["y2"].clone()),
        (json!(100), json!(80), json!(400), json!(280))
    );

    env.commands.lock().unwrap().clear();
    handle_annotation(&env.state, &json!({ "src": path, "kind": "recapture" })).await;
    assert!(
        env.commands.lock().unwrap().iter().any(|cmd| cmd.iter().any(|a| a == "--cropToHeightWidth")),
        "重拍要保留原来的裁剪范围"
    );
}

#[tokio::test]
async fn snapshots_keep_only_the_last_twenty_shots() {
    let env = mac_env("prune");
    let dir = env.state.screen.dir.clone();
    for i in 1..=25 {
        std::fs::write(dir.join(format!("shot-{i:03}.png")), "x").unwrap();
        std::fs::write(dir.join(format!("shot-{i:03}.png.json")), "{}").unwrap();
    }
    env.state.screen.prune_shots();
    let mut left: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".png"))
        .collect();
    left.sort();
    assert_eq!(left.len(), 20);
    assert_eq!(left.first().unwrap(), "shot-006.png");
    assert!(!dir.join("shot-005.png.json").exists());
    assert!(dir.join("shot-025.png.json").exists());
}

// 路由表本身：路径与鉴权层都在 router() 里，这里只需确认能构建。
#[test]
fn router_builds_with_all_documented_paths() {
    let env = mac_env("router");
    let _: Router = routes::router(env.state);
}

// ── JS 真值语义下的默认值（num(v) || fallback）──────────────────────────
#[test]
fn falsy_numbers_fall_back_like_javascript_or() {
    // drag ms：JS `num(body.ms) || 300`。0 / -0 / null / false / NaN 都是假值。
    for ms in [json!(0), json!(-0.0), json!(null), json!(false), json!("nan")] {
        let built = routes::build_input(&json!({ "op": "drag", "x": 1, "y": 2, "x2": 3, "y2": 4, "ms": ms })).unwrap();
        assert_eq!(built["ms"], json!(300), "{ms}");
    }
    assert_eq!(
        routes::build_input(&json!({ "op": "drag", "x": 1, "y": 2, "x2": 3, "y2": 4, "ms": 500 })).unwrap()["ms"],
        json!(500)
    );
    // scroll amount：假值一律 0，不是 NaN（NaN 进 JSON 会变 null，Agent 会当成没给）。
    for amount in [json!(0), json!("nan"), json!(false), json!(null)] {
        let built = routes::build_input(&json!({ "op": "scroll", "x": 1, "y": 1, "amount": amount })).unwrap();
        assert_eq!(built["amount"], json!(0), "{amount}");
    }
    // click count：假值回退 1，再 clamp 到 1..=3。
    for count in [json!(0), json!("nan"), json!(false)] {
        let built = routes::build_input(&json!({ "op": "click", "x": 1, "y": 1, "count": count })).unwrap();
        assert_eq!(built["count"], json!(1), "{count}");
    }
    // 坐标不是「假值回退」而是必填：NaN 必须 400（JS 的 Number.isFinite 判断）。
    for bad in ["nan", "inf", "1e999"] {
        let error = routes::build_input(&json!({ "op": "click", "x": bad, "y": 1 })).unwrap_err();
        assert_eq!((error.status, error.message.as_str()), (400, "x and y are required"), "{bad}");
    }
}

// ── 唤屏：GET 一律 no-store，同意值三态 ─────────────────────────────────
#[tokio::test]
async fn wake_get_is_never_cached_and_unknown_consent_is_503() {
    let agent = FakeAgent::new(|req| {
        if req["op"] == json!("status") {
            json!({ "ok": true, "screenLocked": false, "accessibility": true, "screenRecording": true,
                    "control": {}, "unlockPassword": true })
        } else {
            json!({ "ok": true })
        }
    });
    let profile = host::profile_for("darwin", "/Users/x", &HashMap::new());
    let host = Arc::new(Host::new(
        profile,
        mac_exec(Arc::new(std::sync::Mutex::new(Vec::new()))),
        Some(multicc_remote::agent::host_call(agent.clone())),
    ));
    let state = AppState::new(temp_dir("wake-cache"), host, agent.clone(), "secret").with_p2p(None);
    let consent = |value: &'static str| {
        let mut headers = HeaderMap::new();
        headers.insert(wake::CONSENT_HEADER, value.parse().unwrap());
        headers
    };

    // 同意 = 开：200 且 no-store。
    let ok = wake::get(&state, &consent("1")).await;
    assert_eq!(ok.status(), 200);
    assert_eq!(ok.headers()["cache-control"], "no-store");
    let body = body_json(ok).await;
    assert_eq!(body["autoUnlockEnabled"], json!(true));
    assert_eq!(body["canWake"], json!(true));

    // 同意 = 关：仍是 200（这是合法状态），只是不能唤屏；照样不能缓存。
    let off = wake::get(&state, &consent("0")).await;
    assert_eq!(off.headers()["cache-control"], "no-store");
    let body = body_json(off).await;
    assert_eq!(body["autoUnlockEnabled"], json!(false));
    assert_eq!(body["reason"], json!("auto-unlock-disabled"));

    // 读电源设置失败（Node 送 "error"）或没带头：无法判断，等同 JS 的 readConsent 抛错。
    for headers in [consent("error"), HeaderMap::new()] {
        let response = wake::get(&state, &headers).await;
        assert_eq!(response.status(), 503);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(body_json(response).await["error"], json!("agent-unavailable"));

        let response = wake::post(&state, &headers).await;
        assert_eq!(response.status(), 503);
        assert_eq!(body_json(response).await["error"], json!("agent-unavailable"));
    }

    // Agent 状态不可用（不认 status 的回复）：503 也要带 no-store。
    let broken = mac_env("wake-cache-broken");
    let response = wake::get(&broken.state, &consent("1")).await;
    assert_eq!(response.status(), 503);
    assert_eq!(response.headers()["cache-control"], "no-store");

    // 平台不支持：GET 200 的降级体同样 no-store。
    let win_agent = FakeAgent::new(|_| json!({ "ok": true }));
    let win_host = Arc::new(Host::new(host::profile_for("win32", "C:\\Users\\x", &HashMap::new()), panic_exec(), None));
    let win_state = AppState::new(temp_dir("wake-cache-win"), win_host, win_agent, "secret").with_p2p(None);
    let response = wake::get(&win_state, &consent("1")).await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(body_json(response).await["error"], json!("platform-unsupported"));
}
