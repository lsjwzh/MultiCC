//! 私有匿名 CDP 管道：每次启动加载扩展，成功后才创建网页窗口。
//! 监督进程与一次性插件请求分离；完整控制经本机 Agent 网关，不开放 TCP 调试端口。
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

pub fn launch(
    id: &str,
    browser: &std::path::Path,
    args: &[String],
    extension: Option<&Value>,
    source_revision: &Value,
    budget: Duration,
    tz: Option<&str>,
    ui_args: &[String],
) -> Result<Value, String> {
    #[cfg(not(unix))]
    return Err("此平台尚不支持私有管道自动加载扩展，已拒绝无保护启动".into());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        command
            .arg("browser-supervise")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("启动浏览器监督进程失败：{e}"))?;
        let input = json!({"browser":browser,"args":args,"extensionPath":extension.map(|e| &e["extensionPath"]),"id":id,"sourceRevision":source_revision,"timeoutMs":budget.as_millis(),"tz":tz,"uiArgs":ui_args});
        let sent = child
            .stdin
            .take()
            .unwrap()
            .write_all(input.to_string().as_bytes());
        if sent.is_err() {
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.wait();
            return Err("发送浏览器启动配置失败".into());
        }
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
            let _ = tx.send(result);
        });
        let response = rx
            .recv_timeout(budget)
            .ok()
            .and_then(Result::ok)
            .and_then(|s| serde_json::from_str::<Value>(&s).ok());
        match response {
            Some(v) if v["ok"] == true => Ok(v["data"].clone()),
            other => {
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.wait();
                Err(other
                    .and_then(|v| v["error"].as_str().map(str::to_owned))
                    .unwrap_or_else(|| "自动加载扩展超时或监督进程异常退出，未确认启动成功".into()))
            }
        }
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::io::Error;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::{net::UnixStream, process::CommandExt};
    use std::process::Child;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;
    static STOP: AtomicBool = AtomicBool::new(false);
    extern "C" fn stop_signal(_: libc::c_int) {
        STOP.store(true, Ordering::Relaxed);
    }

    // 先复制到 >= 10，避免 dup2(fd, 3/4) 覆盖另一管道端点。
    fn child_fd(stream: &UnixStream) -> Result<OwnedFd, String> {
        let fd = unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
        if fd < 0 {
            return Err("创建 Chrome 私有管道失败".into());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
    struct Browser(Child);
    impl Drop for Browser {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    struct Pipe {
        write: UnixStream,
        read: BufReader<UnixStream>,
        id: u64,
        startup_deadline: Option<Instant>,
        broken: bool,
        write_broken: bool,
        frame_complete: bool,
        pending_frame: Vec<u8>,
        timed_out: bool,
        events: Vec<Value>,
        control: Option<crate::control_bridge::Bridge>,
    }
    impl Pipe {
        fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
            self.call_with_session(
                method,
                params,
                None,
                Instant::now() + Duration::from_secs(12),
            )
        }
        fn call_with_session(
            &mut self,
            method: &str,
            params: Value,
            session: Option<&str>,
            request_deadline: Instant,
        ) -> Result<Value, String> {
            if self.broken {
                return Err("浏览器私有管道已失效，请重新启动该身份".into());
            }
            let deadline = self
                .startup_deadline
                .map_or(request_deadline, |d| d.min(request_deadline));
            if deadline <= Instant::now() {
                return Err("浏览器只读请求超时".into());
            }
            self.frame_complete = false;
            self.timed_out = false;
            let result = self.call_frame(method, params, session, deadline);
            if result.is_err() && !self.frame_complete && !self.timed_out {
                self.broken = true;
            }
            result
        }
        fn call_frame(
            &mut self,
            method: &str,
            params: Value,
            session: Option<&str>,
            request_deadline: Instant,
        ) -> Result<Value, String> {
            if method == "_read_events" {
                return Ok(json!(std::mem::take(&mut self.events)));
            }
            let Some(write_budget) = request_deadline.checked_duration_since(Instant::now()) else {
                self.frame_complete = true;
                return Err("浏览器只读请求超时".into());
            };
            self.id += 1;
            let mut request = json!({"id":self.id,"method":method,"params":params});
            if let Some(session) = session {
                request["sessionId"] = json!(session);
            }
            let request = request.to_string() + "\0";
            if self
                .write
                .set_write_timeout(Some(write_budget.min(Duration::from_millis(100))))
                .is_err()
            {
                self.write_broken = true;
                return Err("浏览器私有管道不可写".into());
            }
            if self.write.write_all(request.as_bytes()).is_err() {
                self.write_broken = true;
                return Err("浏览器私有管道已断开".into());
            }
            #[cfg(feature = "gapaw-read-bridge-test")]
            if method == "DOMSnapshot.captureSnapshot" {
                let gate = crate::store::data_dir().join("run/test-snapshot-delay");
                if std::fs::remove_file(&gate).is_ok() {
                    std::fs::write(gate.with_extension("started"), b"request-written")
                        .map_err(|e| e.to_string())?;
                    while Instant::now() < request_deadline && !STOP.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                }
            }
            let request_id = self.id;
            loop {
                let v = self.read_frame(request_deadline)?;
                self.observe(&v);
                if v["id"].as_u64() != Some(request_id) {
                    continue;
                }
                self.frame_complete = true;
                if v.get("error").is_some() {
                    return Err(format!(
                        "浏览器拒绝 {method}；需使用支持自动加载扩展的 Chrome，或检查组织策略"
                    ));
                }
                return Ok(v["result"].clone());
            }
        }
        fn observe(&mut self, v: &Value) {
            if let Some(control) = &mut self.control {
                control.route(v);
            }
            if self.events.len() < 512
                && matches!(
                    v["method"].as_str(),
                    Some(
                        "Network.requestWillBeSent"
                            | "Network.responseReceived"
                            | "Network.loadingFinished"
                            | "Network.loadingFailed"
                    )
                )
            {
                // 不缓存请求头、响应头、Cookie 或请求体。
                let r = &v["params"]["response"];
                self.events.push(json!({"method":v["method"],"sessionId":v["sessionId"],"requestId":v["params"]["requestId"],"type":v["params"]["type"],"url":r["url"],"status":r["status"],"mimeType":r["mimeType"],"metadata":{
                            "country":v["params"]["request"]["headers"]["country"].as_str().filter(|s|s.len()==2&&s.bytes().all(|b|b.is_ascii_alphabetic()))}}));
            }
        }
        fn read_frame(&mut self, request_deadline: Instant) -> Result<Value, String> {
            let deadline = self
                .startup_deadline
                .map_or(request_deadline, |d| d.min(request_deadline));
            let mut bytes = std::mem::take(&mut self.pending_frame);
            loop {
                self.pump_control()?;
                if STOP.load(Ordering::Relaxed) {
                    return Err("浏览器正在停止，已取消读取".into());
                }
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    // 超时只终止本次等待，已读片段留在当前管道中。
                    // 后续请求先续读至 NUL 边界，再按请求编号丢弃迟到响应。
                    // 片段不向调用方返回；EOF、超限、坏 JSON 和写入失败仍作废。
                    self.frame_complete = bytes.is_empty();
                    self.pending_frame = bytes;
                    self.timed_out = true;
                    return Err("等待浏览器响应超时".into());
                };
                self.read
                    .get_ref()
                    .set_read_timeout(Some(remaining.min(Duration::from_millis(100))))
                    .map_err(|_| "浏览器私有管道不可读")?;
                let buffer = match self.read.fill_buf() {
                    Ok(buffer) => buffer,
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock
                                | std::io::ErrorKind::TimedOut
                                | std::io::ErrorKind::Interrupted
                        ) =>
                    {
                        continue
                    }
                    Err(_) => return Err("浏览器响应超时或管道已断开".into()),
                };
                if buffer.is_empty() {
                    return Err("浏览器响应无效或已退出".into());
                }
                let count = buffer
                    .iter()
                    .position(|b| *b == 0)
                    .map_or(buffer.len(), |i| i + 1);
                if bytes.len() + count > 512 * 1024 * 1024 {
                    return Err("浏览器响应超过读取上限".into());
                }
                bytes.extend_from_slice(&buffer[..count]);
                self.read.consume(count);
                if bytes.last() == Some(&0) {
                    break;
                }
            }
            bytes.pop();
            let v: Value = serde_json::from_slice(&bytes).map_err(|_| "浏览器响应格式无效")?;
            self.frame_complete = true;
            Ok(v)
        }
        fn send_control(&mut self, mut frame: Value) -> Result<(), String> {
            self.id += 1;
            if let Some(control) = &mut self.control {
                if !control.track(self.id, &frame) {
                    return Ok(());
                }
            }
            frame["id"] = json!(self.id);
            self.write_frame(&frame)
        }
        fn write_frame(&mut self, frame: &Value) -> Result<(), String> {
            if self.write_broken {
                return Err("浏览器私有管道已断开".into());
            }
            self.write
                .set_write_timeout(Some(Duration::from_millis(100)))
                .map_err(|e| e.to_string())?;
            if self
                .write
                .write_all((frame.to_string() + "\0").as_bytes())
                .is_err()
            {
                self.write_broken = true;
                self.broken = true;
                return Err("浏览器私有管道已断开".into());
            }
            Ok(())
        }
        fn pump_control(&mut self) -> Result<(), String> {
            if self.broken {
                return Err("浏览器私有管道已失效".into());
            }
            let Some(control) = &mut self.control else {
                return Ok(());
            };
            let requests = control.requests();
            let detached = control.take_detached();
            for request in requests {
                self.send_control(request)?;
            }
            for session in detached {
                self.id += 1;
                self.write_frame(&json!({"id":self.id,"method":"Target.detachFromTarget","params":{"sessionId":session}}))?;
            }
            Ok(())
        }
        fn poll_control(&mut self) -> Result<(), String> {
            if STOP.load(Ordering::Relaxed) {
                return Ok(());
            }
            self.pump_control()?;
            for _ in 0..64 {
                self.timed_out = false;
                match self.read_frame(Instant::now() + Duration::from_millis(1)) {
                    Ok(frame) => self.observe(&frame),
                    Err(_) if STOP.load(Ordering::Relaxed) => return Ok(()),
                    Err(_) if self.timed_out => break,
                    Err(error) => {
                        self.broken = true;
                        return Err(error);
                    }
                }
            }
            if let Some(control) = &mut self.control {
                control.register();
            }
            Ok(())
        }
        // 停止后不再解析读端；仅当此前所有写帧完整时发送一次固定关闭请求。
        // 读端即使因取消或半帧而失效，Browser.close 仍可让 Chrome 正常保存会话。
        fn request_close(&mut self) -> Result<(), String> {
            self.broken = true;
            if self.write_broken {
                return Err("浏览器写入管道已失效".into());
            }
            self.write_broken = true;
            self.id += 1;
            self.write
                .set_write_timeout(Some(Duration::from_millis(500)))
                .map_err(|e| e.to_string())?;
            let request =
                json!({"id":self.id,"method":"Browser.close","params":{}}).to_string() + "\0";
            self.write
                .write_all(request.as_bytes())
                .map_err(|_| "发送浏览器关闭请求失败".into())
        }
    }

    pub fn run(input: &Value) -> Result<(), String> {
        unsafe {
            libc::signal(
                libc::SIGUSR1,
                stop_signal as *const () as libc::sighandler_t,
            );
        }
        let id = input["id"].as_str().ok_or("缺少身份编号")?;
        if id.is_empty()
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("身份编号无效".into());
        }
        let startup_deadline = Instant::now()
            + Duration::from_millis(input["timeoutMs"].as_u64().unwrap_or(18000).min(18000));
        let browser = input["browser"].as_str().ok_or("缺少浏览器路径")?;
        let args: Vec<String> =
            serde_json::from_value(input["args"].clone()).map_err(|_| "启动参数无效")?;
        let extension = input["extensionPath"].as_str();
        // 出口地理一致性的时区半边：TZ 环境跟着实例走（Chrome 的 Intl/Date
        // 读它），两个阶段（无窗口的扩展加载 + 身份窗口）都要带上。
        let tz = input["tz"].as_str().filter(|zone| !zone.is_empty());
        // 界面 locale 覆盖（macOS 的 -AppleLanguages，见 chrome::ui_locale_args）
        // 只给阶段一的主进程：它带 --no-startup-window，不会把参数值当网页打开。
        let ui_args: Vec<String> =
            serde_json::from_value(input["uiArgs"].clone()).unwrap_or_default();
        let (write, child_read) = UnixStream::pair().map_err(|e| e.to_string())?;
        let (child_write, read) = UnixStream::pair().map_err(|e| e.to_string())?;
        write
            .set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        let input_fd = child_fd(&child_read)?;
        let output_fd = child_fd(&child_write)?;
        let mut command = Command::new(browser);
        // 原 args 最后一个非开关参数是用户 URL；第一阶段绝不传给 Chrome。
        if let Some(zone) = tz {
            command.env("TZ", zone);
        }
        command.args(
            args.iter()
                .filter(|a| extension.is_none() || a.starts_with("--")),
        );
        if extension.is_some() {
            command.args(["--no-startup-window", "--enable-unsafe-extension-debugging"]);
        }
        command
            .arg("--remote-debugging-pipe")
            .args(&ui_args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let fd3 = input_fd.as_raw_fd();
        let fd4 = output_fd.as_raw_fd();
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(fd3, 3) < 0 || libc::dup2(fd4, 4) < 0 {
                    return Err(Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = Browser(
            command
                .spawn()
                .map_err(|e| format!("启动浏览器失败：{e}"))?,
        );
        drop(input_fd);
        drop(output_fd);
        drop(child_read);
        drop(child_write);
        let mut pipe = Pipe {
            write,
            read: BufReader::new(read),
            id: 0,
            startup_deadline: Some(startup_deadline),
            broken: false,
            write_broken: false,
            frame_complete: false,
            pending_frame: vec![],
            timed_out: false,
            events: vec![],
            control: None,
        };
        let targets = pipe.call("Target.getTargets", json!({}))?;
        if extension.is_some()
            && targets["targetInfos"]
                .as_array()
                .is_some_and(|ts| ts.iter().any(|t| t["type"] == "page"))
        {
            return Err("浏览器提前打开了网页，已停止启动以避免扩展加载竞态".into());
        }
        let fingerprint = if let Some(extension) = extension {
            let loaded = pipe.call("Extensions.loadUnpacked", json!({"path":extension}))?;
            let extension_id = loaded["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("浏览器未确认扩展加载成功")?;
            json!({"status":"loaded","installationVerified":true,"extensionId":extension_id})
        } else {
            json!({"status":"notRequested","installationVerified":false})
        };
        let initial_url = args
            .iter()
            .rev()
            .find(|arg| !arg.starts_with("--"))
            .map(String::as_str)
            .unwrap_or("chrome://newtab/");
        if extension.is_some() {
            pipe.call(
                "Target.createTarget",
                json!({"url":initial_url,"newWindow":true}),
            )?;
        }
        let bridge = crate::read_bridge::unix::Bridge::bind(id, input["sourceRevision"].clone())?;
        let control = crate::control_bridge::Bridge::bind(&crate::store::data_dir(), id)?;
        let control_metadata = control.metadata();
        pipe.control = Some(control);
        let state = crate::store::data_dir()
            .join("run")
            .join(format!("{id}.browser.json"));
        std::fs::create_dir_all(state.parent().unwrap()).map_err(|_| "创建运行记录目录失败")?;
        std::fs::write(
            &state,
            json!({"pid":child.0.id(),"supervisorPid":std::process::id(),"browserControl":control_metadata}).to_string(),
        )
        .map_err(|_| "保存浏览器监督记录失败")?;
        let result = json!({"ok":true,"data":{"pid":child.0.id(),"supervisorPid":std::process::id(),
            "browserControl":control_metadata,"fingerprint":fingerprint}});
        writeln!(std::io::stdout(), "{result}").map_err(|_| "启动请求已中断")?;
        std::io::stdout().flush().map_err(|_| "启动请求已中断")?;
        pipe.startup_deadline = None;
        // 停止后不再接受排队 RPC，也不再读取/复用已取消的响应。
        let mut stopping = false;
        loop {
            if child.0.try_wait().map_err(|e| e.to_string())?.is_some() {
                break;
            }
            if STOP.load(Ordering::Relaxed) && !stopping {
                stopping = true;
                let _ = pipe.request_close();
            }
            if !stopping {
                pipe.poll_control()?;
                bridge.poll_with_cancel(
                    |method, params, session, deadline| {
                        pipe.call_with_session(method, params, session, deadline)
                    },
                    || STOP.load(Ordering::Relaxed),
                );
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = std::fs::remove_file(state);
        Ok(())
    }
    #[cfg(test)]
    include!("read_bridge_integration.rs");
}

pub fn supervise(input: &Value) {
    #[cfg(unix)]
    let result = unix::run(input);
    #[cfg(not(unix))]
    let result: Result<(), String> = Err("此平台不支持自动加载扩展".into());
    if let Err(error) = result {
        println!("{}", json!({"ok":false,"error":error}));
    }
}

/// Never advertise stale state from an earlier Chrome/supervisor lifetime.
pub fn control_metadata(id: &str, pid: i32) -> Option<Value> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
        let path = crate::store::data_dir()
            .join("run")
            .join(format!("{id}.browser.json"));
        let state: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        if state["pid"].as_i64() != Some(pid as i64) {
            return None;
        }
        let supervisor = i32::try_from(state["supervisorPid"].as_i64()?).ok()?;
        if supervisor <= 1 || !crate::chrome::pid_alive(supervisor) {
            return None;
        }
        let control = &state["browserControl"];
        if control["protocol"] != crate::control_bridge::PROTOCOL {
            return None;
        }
        let path = control["wsUrl"].as_str()?.strip_prefix("pipe://")?;
        let meta = std::fs::symlink_metadata(path).ok()?;
        if !meta.file_type().is_socket()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.permissions().mode() & 0o077 != 0
        {
            return None;
        }
        Some(control.clone())
    }
    #[cfg(not(unix))]
    {
        let _ = (id, pid);
        None
    }
}

/// 只向与本次 Chrome PID 对应的监督进程请求正常退出。
pub fn request_stop(id: &str, pid: i32) -> bool {
    #[cfg(unix)]
    {
        let path = crate::store::data_dir()
            .join("run")
            .join(format!("{id}.browser.json"));
        let state = std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        if let Some(v) = state {
            if v["pid"].as_i64() == Some(pid as i64) {
                if let Some(supervisor) = v["supervisorPid"].as_i64().filter(|p| *p > 1) {
                    let parent = Command::new("ps")
                        .args(["-o", "ppid=", "-p", &pid.to_string()])
                        .output()
                        .ok()
                        .and_then(|o| String::from_utf8(o.stdout).ok())
                        .and_then(|s| s.trim().parse::<i64>().ok());
                    if parent == Some(supervisor) {
                        return unsafe { libc::kill(supervisor as i32, libc::SIGUSR1) == 0 };
                    }
                }
            }
        }
    }
    false
}

/// 在更改代理进程之前串行化同身份的启动请求。
pub fn launch_lock(id: &str) -> Result<std::fs::File, String> {
    let dir = crate::store::data_dir().join("run");
    std::fs::create_dir_all(&dir).map_err(|_| "创建运行目录失败")?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(dir.join(format!("{id}.launch.lock")))
        .map_err(|_| "打开启动锁失败")?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("该身份正在启动，请稍候".into());
        }
    }
    Ok(file)
}
