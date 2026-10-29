// 只编译到测试二进制。复用生产 Pipe 和 Bridge，在临时无头 Chrome 中验收真实 IPC。
#[test]
fn read_bridge_pipe_recovers_after_boundary_timeout_and_skips_late_response() {
    let (write, server_read) = UnixStream::pair().unwrap();
    let (mut server_write, read) = UnixStream::pair().unwrap();
    let mut pipe = Pipe { write, read: BufReader::new(read), id: 0, startup_deadline: None,
        broken: false, write_broken: false, frame_complete: false, pending_frame: vec![], timed_out: false, control: None, events: vec![] };
    assert!(pipe.call_with_session("Browser.getVersion", json!({}), None,
        Instant::now() + Duration::from_millis(30)).is_err());
    assert!(!pipe.broken, "尚未读到响应字节的超时不破坏帧边界");
    let mut reader = BufReader::new(server_read);
    let mut request = vec![];
    reader.read_until(0, &mut request).unwrap();
    server_write.write_all(b"{\"id\":1,\"result\":{\"late\":true}}\0{\"id\":2,\"result\":{\"current\":true}}\0").unwrap();
    assert_eq!(pipe.call("Browser.getVersion", json!({})).unwrap(), json!({"current":true}));
}

#[test]
fn read_bridge_pipe_expired_request_writes_nothing_and_remains_usable() {
    let (write, _server_read) = UnixStream::pair().unwrap();
    let (mut server_write, read) = UnixStream::pair().unwrap();
    let mut pipe = Pipe { write, read: BufReader::new(read), id: 0, startup_deadline: None,
        broken: false, write_broken: false, frame_complete: false, pending_frame: vec![], timed_out: false, control: None, events: vec![] };
    assert!(pipe.call_with_session("Browser.getVersion", json!({}), None, Instant::now()).is_err());
    assert_eq!(pipe.id, 0);
    assert!(!pipe.broken);
    server_write.write_all(b"{\"id\":1,\"result\":{}}\0").unwrap();
    assert!(pipe.call("Browser.getVersion", json!({})).is_ok());
}

#[test]
fn read_bridge_pipe_partial_timeout_resumes_without_mixing_response_ids() {
    let (write, _server_read) = UnixStream::pair().unwrap();
    let (mut server_write, read) = UnixStream::pair().unwrap();
    server_write.write_all(b"{\"id\":1").unwrap();
    let mut pipe = Pipe { write, read: BufReader::new(read), id: 0, startup_deadline: None,
        broken: false, write_broken: false, frame_complete: false, pending_frame: vec![], timed_out: false, control: None, events: vec![] };
    assert!(pipe.call_with_session("Browser.getVersion", json!({}), None,
        Instant::now() + Duration::from_millis(30)).is_err());
    assert!(!pipe.broken, "半帧超时保存已读片段，不丢失响应边界");
    assert_eq!(pipe.pending_frame, b"{\"id\":1");
    server_write.write_all(b",\"result\":{\"late\":true}}\0{\"id\":2,\"result\":{\"current\":true}}\0").unwrap();
    assert_eq!(pipe.call("Browser.getVersion", json!({})).unwrap(), json!({"current":true}));
    assert!(pipe.pending_frame.is_empty());
}

#[test]
fn read_bridge_pipe_rejects_partial_frames_without_reusing_stream() {
    let (write, server_read) = UnixStream::pair().unwrap();
    let (mut server_write, read) = UnixStream::pair().unwrap();
    server_write.write_all(b"{\"id\":1").unwrap();
    server_write.shutdown(std::net::Shutdown::Write).unwrap();
    let mut pipe = Pipe {
        write,
        read: BufReader::new(read),
        id: 0,
        startup_deadline: None,
        broken: false,
        write_broken: false,
        frame_complete: false, pending_frame: vec![], timed_out: false, control: None, events:vec![],
    };
    assert!(pipe.call("Browser.getVersion", json!({})).is_err());
    assert!(pipe.broken);
    let id = pipe.id;
    assert!(pipe.call("Browser.getVersion", json!({})).is_err());
    assert_eq!(pipe.id, id, "失效管道不再写入新请求");
    pipe.request_close().unwrap();
    let mut reader = BufReader::new(server_read);
    let mut frame = Vec::new();
    reader.read_until(0, &mut frame).unwrap();
    frame.clear();
    reader.read_until(0, &mut frame).unwrap();
    let close: Value = serde_json::from_slice(&frame[..frame.len() - 1]).unwrap();
    assert_eq!(close["method"], "Browser.close");
    assert!(pipe.request_close().is_err(), "关闭写入只允许一次");
}

#[test]
fn read_bridge_pipe_never_closes_after_failed_write() {
    let (write, peer) = UnixStream::pair().unwrap();
    let (_server_write, read) = UnixStream::pair().unwrap();
    drop(peer);
    let mut pipe = Pipe { write, read: BufReader::new(read), id: 0, startup_deadline: None,
        broken: false, write_broken: false, frame_complete: false, pending_frame: vec![], timed_out: false, control: None, events:vec![] };
    assert!(pipe.call("Browser.getVersion", json!({})).is_err());
    assert!(pipe.write_broken);
    let id = pipe.id;
    assert!(pipe.request_close().is_err());
    assert_eq!(pipe.id, id, "可能写入半帧后禁止追加关闭帧");
}

#[test]
fn read_bridge_pipe_preserves_complete_cdp_errors() {
    let (write, _server_read) = UnixStream::pair().unwrap();
    let (mut server_write, read) = UnixStream::pair().unwrap();
    server_write
        .write_all(b"{\"id\":1,\"error\":{\"message\":\"synthetic\"}}\0{\"id\":2,\"result\":{}}\0")
        .unwrap();
    let mut pipe = Pipe {
        write,
        read: BufReader::new(read),
        id: 0,
        startup_deadline: None,
        broken: false,
        write_broken: false,
        frame_complete: false, pending_frame: vec![], timed_out: false, control: None, events:vec![],
    };
    assert!(pipe
        .call("Target.getTargetInfo", json!({"targetId":"closed"}))
        .is_err());
    assert!(!pipe.broken, "完整CDP错误帧不破坏后续读取");
    assert!(pipe.call("Browser.getVersion", json!({})).is_ok());
}

#[test]
#[ignore = "需要明确指定 CHROME_READ_TEST_ROOT、CHROME_TEST_BIN 和合成本地代理"]
fn read_bridge_headless_pipe() {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;
    let chrome = std::env::var("CHROME_TEST_BIN").expect("需要测试浏览器路径");
    let proxy = std::env::var("CHROME_READ_FIXTURE_PROXY").expect("需要合成本地代理");
    assert!(proxy.starts_with("http://127.0.0.1:"));
    let test_root = std::env::var("CHROME_READ_TEST_ROOT").unwrap();
    assert!(
        test_root.starts_with("/tmp/cbr-"),
        "只允许本测试创建的隔离目录"
    );
    let (write, child_read) = UnixStream::pair().unwrap();
    let (child_write, read) = UnixStream::pair().unwrap();
    let input_fd = child_fd(&child_read).unwrap();
    let output_fd = child_fd(&child_write).unwrap();
    let fd3 = input_fd.as_raw_fd();
    let fd4 = output_fd.as_raw_fd();
    let mut command = Command::new(chrome);
    command
        .args([
            "--headless=new",
            "--remote-debugging-pipe",
            "--use-mock-keychain",
            "--ignore-certificate-errors",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
        ])
        .arg(format!("--proxy-server={proxy}"))
        .arg("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1")
        .arg(format!("--user-data-dir={test_root}/test-profile"))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(fd3, 3) < 0 || libc::dup2(fd4, 4) < 0 {
                return Err(Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut browser = Browser(command.spawn().unwrap());
    drop(input_fd);
    drop(output_fd);
    drop(child_read);
    drop(child_write);
    let mut pipe = Pipe {
        write,
        read: BufReader::new(read),
        id: 0,
        startup_deadline: None,
        broken: false,
        write_broken: false,
        frame_complete: false, pending_frame: vec![], timed_out: false, control: None, events:vec![],
    };
    let targets = pipe.call("Target.getTargets", json!({})).unwrap();
    let target = targets["targetInfos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["type"] == "page")
        .unwrap()["targetId"]
        .as_str()
        .unwrap()
        .to_owned();
    let session = pipe
        .call(
            "Target.attachToTarget",
            json!({"targetId":target,"flatten":true}),
        )
        .unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    pipe.call_with_session(
        "Page.navigate",
        json!({"url":"https://kalodata.com/fixture?private=redacted#fragment"}),
        Some(&session),
        Instant::now() + Duration::from_secs(8),
    )
    .unwrap();
    // 等待合成页面加载；只在测试夹具中启用导航和检查。
    for _ in 0..50 {
        let frame = pipe
            .call_with_session(
                "Page.getFrameTree",
                json!({}),
                Some(&session),
                Instant::now() + Duration::from_secs(2),
            )
            .unwrap();
        if frame["frameTree"]["frame"]["url"]
            .as_str()
            .is_some_and(|s| s.starts_with("https://kalodata.com/fixture"))
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    pipe.call("Target.detachFromTarget", json!({"sessionId":session}))
        .unwrap();
    let root = std::path::PathBuf::from(test_root).join("source-data");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let revision = json!({"profileCreatedAt":1,"profileUpdatedAt":2,"subscription":null,"confidence":"public_metadata"});
    let bridge =
        crate::read_bridge::unix::Bridge::bind_test(&root, "fixture", revision.clone()).unwrap();
    let hash = format!("{:x}", Sha256::digest(b"fixture"));
    let path = root.join("run").join(format!("read-{}.sock", &hash[..16]));
    let mut seq = 0u64;
    let mut request = |action: &str, extra: Value| {
        seq += 1;
        let mut request = json!({"protocol":crate::read_bridge::PROTOCOL,"requestId":format!("00000000-0000-4000-8000-{seq:012x}"),
            "profileId":"fixture","sourceRevision":revision,"action":action});
        for (key, value) in extra.as_object().unwrap() {
            request[key] = value.clone();
        }
        let mut client = UnixStream::connect(&path).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        client
            .write_all((request.to_string() + "\n").as_bytes())
            .unwrap();
        bridge.poll(|method, params, session, deadline| {
            pipe.call_with_session(method, params, session, deadline)
        });
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        serde_json::from_str::<Value>(&response).unwrap()
    };
    let status = request("status", json!({}));
    assert_eq!(status["ok"], true);
    let pages = request("pages", json!({}));
    assert_eq!(pages["ok"], true);
    assert_eq!(pages["data"]["pages"].as_array().unwrap().len(), 1);
    assert_eq!(
        pages["data"]["pages"][0]["url"],
        "https://kalodata.com/fixture"
    );
    assert_eq!(pages["data"]["pages"][0]["platform"], "kalodata");
    let instance = pages["data"]["instanceId"].clone();
    let mut page = Value::Null;
    for _ in 0..30 {
        page = request(
            "read-page",
            json!({"targetId":target,"expectedInstanceId":instance}),
        );
        if page["ok"] == true
            && page["data"]["page"]["text"]
                .as_str()
                .is_some_and(|s| s.contains("公开正文"))
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(page["ok"], true, "{}", page);
    assert_eq!(page["data"]["page"]["text"], "公开正文");
    assert_eq!(page["data"]["page"]["truncated"], false);
    assert_eq!(
        request(
            "read-page",
            json!({"targetId":target,"expectedInstanceId":"00000000-0000-4000-8000-000000000000"})
        )["ok"],
        false
    );
    assert_eq!(request("status", json!({"profileId":"wrong"}))["ok"], false);
    assert_eq!(request("status", json!({"sourceRevision":{}}))["ok"], false);
    assert_eq!(request("Runtime.evaluate", json!({}))["ok"], false);
    drop(request);
    drop(bridge);
    assert!(!path.exists());
    pipe.call("Browser.close", json!({})).unwrap();
    browser.0.wait().unwrap();
}
