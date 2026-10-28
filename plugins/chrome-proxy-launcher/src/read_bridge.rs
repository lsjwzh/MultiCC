//! 监督进程内的受限页面正文快照接口，不暴露通用 CDP 或脚本执行入口。
use serde_json::{json, Value};

pub const PROTOCOL: &str = "multicc-browser-read-v1";

fn safe_failure(error: &str) -> Value {
    let code = match error {
        "浏览器私有管道已失效，请重新启动该身份" => "channel_unavailable",
        "浏览器响应超过读取上限" => "response_limit",
        "等待浏览器响应超时" | "浏览器只读请求超时" => "read_timeout",
        _ => "page_read_failed",
    };
    json!({"ok":false,"error":"实例页面读取失败，请重新检查","errorCode":code})
}

pub fn source_revision(profile: &crate::store::Profile) -> Result<Value, String> {
    let subscription = if let Some(binding) = &profile.subscription {
        let subscriptions = crate::store::load_subscriptions()?;
        let source = subscriptions
            .iter()
            .find(|s| s.id == binding.id)
            .ok_or("浏览器身份引用的订阅不存在")?;
        if source.updated_at < 0 {
            return Err("浏览器身份元数据无效".into());
        }
        json!({"id":source.id,"updatedAt":source.updated_at,"sourceBytes":source.source_bytes})
    } else {
        Value::Null
    };
    if profile.created_at < 0 || profile.updated_at < 0 {
        return Err("浏览器身份元数据无效".into());
    }
    Ok(
        json!({"profileCreatedAt":profile.created_at,"profileUpdatedAt":profile.updated_at,
        "subscription":subscription,"confidence":"public_metadata"}),
    )
}

#[cfg(unix)]
pub mod unix {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        collections::{HashMap, HashSet},
        fs,
        io::{Read, Write},
        os::{
            fd::AsRawFd,
            unix::{
                ffi::OsStrExt,
                fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt},
                net::{UnixListener, UnixStream},
            },
        },
        path::{Path, PathBuf},
        time::{Duration, Instant},
    };

    const ERROR: &str = "浏览器只读请求未完成，请刷新页面或检查身份会话后重试";
    const MAX_REQUEST: usize = 16 * 1024;
    const MAX_RESPONSE: usize = 512 * 1024;
    const MAX_TEXT: usize = 120_000;
    const MAX_NODES: usize = 100_000;
    const STYLES: [&str; 8] = [
        "display",
        "visibility",
        "opacity",
        "content-visibility",
        "overflow-x",
        "overflow-y",
        "clip",
        "clip-path",
    ];
    type Result<T> = std::result::Result<T, String>;

    pub struct Bridge {
        listener: UnixListener,
        path: PathBuf,
        inode: u64,
        device: u64,
        profile_id: String,
        revision: Value,
        instance_id: String,
    }

    fn uuid() -> Result<String> {
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes).map_err(|_| ERROR)?;
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        Ok(format!(
            "{}-{}-{}-{}-{}",
            &h[..8],
            &h[8..12],
            &h[12..16],
            &h[16..20],
            &h[20..]
        ))
    }
    fn valid_uuid(s: &str) -> bool {
        s.len() == 36
            && s.bytes().enumerate().all(|(i, b)| {
                if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_hexdigit()
                }
            })
    }
    fn safe_id(s: &str) -> bool {
        !s.is_empty()
            && s.len() <= 80
            && !s.starts_with('-')
            && !s.ends_with('-')
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    }
    fn safe_target(s: &str) -> bool {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }
    fn remaining(deadline: Instant) -> Result<Duration> {
        deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| ERROR.into())
    }
    /// 监督进程绑定与公开读取命令连接共用这一个位置，两边不能各算各的。
    /// 默认在数据目录 run/ 下；sun_path 在 macOS 只有 104 字节，HOME 或数据目录较长时
    /// 退到 /tmp 下按用户隔离的短目录，文件名带上数据根摘要，不同数据根互不相撞。
    pub fn socket_path(root: &Path, profile_id: &str) -> PathBuf {
        let digest = format!("{:x}", Sha256::digest(profile_id.as_bytes()));
        let path = root.join("run").join(format!("read-{}.sock", &digest[..16]));
        if fits_sun_path(&path) {
            return path;
        }
        let mut scoped = Sha256::new();
        scoped.update(root.as_os_str().as_bytes());
        scoped.update([0]);
        scoped.update(profile_id.as_bytes());
        let digest = format!("{:x}", scoped.finalize());
        short_dir().join(format!("read-{}.sock", &digest[..16]))
    }
    fn short_dir() -> PathBuf {
        PathBuf::from(format!("/tmp/multicc-cpl-{}", unsafe { libc::geteuid() }))
    }
    fn fits_sun_path(path: &Path) -> bool {
        let max = if cfg!(target_os = "macos") { 104 } else { 108 };
        path.as_os_str().as_bytes().len() < max
    }
    /// /tmp 是共享目录：只用自己建的、仅属主可访问的目录，别人抢先建的同名目录直接拒绝。
    fn ensure_short_dir(dir: &Path) -> Result<()> {
        match fs::DirBuilder::new().mode(0o700).create(dir) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(ERROR.into()),
        }
        private_dir(dir)?;
        let mode = fs::symlink_metadata(dir).map_err(|_| ERROR)?.permissions().mode();
        if mode & 0o077 != 0 {
            return Err(ERROR.into());
        }
        Ok(())
    }
    fn private_dir(path: &Path) -> Result<()> {
        let meta = fs::symlink_metadata(path).map_err(|_| ERROR)?;
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.permissions().mode() & 0o022 != 0
        {
            return Err(ERROR.into());
        }
        Ok(())
    }
    fn same_user(stream: &UnixStream) -> bool {
        #[cfg(any(
            target_os = "macos",
            target_os = "freebsd",
            target_os = "openbsd",
            target_os = "netbsd"
        ))]
        {
            let mut uid: libc::uid_t = 0;
            let mut gid: libc::gid_t = 0;
            unsafe {
                libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) == 0
                    && uid == libc::geteuid()
            }
        }
        #[cfg(target_os = "linux")]
        {
            let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
            let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
            unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    &mut cred as *mut _ as *mut libc::c_void,
                    &mut size,
                ) == 0
                    && cred.uid == libc::geteuid()
            }
        }
        #[cfg(not(any(
            target_os = "macos",
            target_os = "freebsd",
            target_os = "openbsd",
            target_os = "netbsd",
            target_os = "linux"
        )))]
        {
            let _ = stream;
            false
        }
    }

    impl Bridge {
        pub fn bind(profile_id: &str, revision: Value) -> Result<Self> {
            Self::bind_at(&crate::store::data_dir(), profile_id, revision)
        }
        #[cfg(test)]
        pub(crate) fn bind_test(root: &Path, profile_id: &str, revision: Value) -> Result<Self> {
            Self::bind_at(root, profile_id, revision)
        }
        fn bind_at(root: &Path, profile_id: &str, revision: Value) -> Result<Self> {
            if !safe_id(profile_id) || revision["confidence"] != "public_metadata" {
                return Err(ERROR.into());
            }
            private_dir(root)?;
            let run = root.join("run");
            if !run.exists() {
                fs::create_dir(&run).map_err(|_| ERROR)?;
            }
            let metadata = fs::symlink_metadata(&run).map_err(|_| ERROR)?;
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || metadata.uid() != unsafe { libc::geteuid() }
            {
                return Err(ERROR.into());
            }
            fs::set_permissions(&run, fs::Permissions::from_mode(0o700)).map_err(|_| ERROR)?;
            private_dir(&run)?;
            let path = socket_path(root, profile_id);
            if path.parent() != Some(run.as_path()) {
                ensure_short_dir(path.parent().ok_or(ERROR)?)?;
            }
            // 还有监督实例在听就拒绝，防止接管；只有自己的、已无人监听的残留 socket
            // （监督进程被强杀时 Drop 来不及清理）才删除重建，否则该身份将永远无法再启动。
            if let Ok(meta) = fs::symlink_metadata(&path) {
                let stale = meta.file_type().is_socket()
                    && meta.uid() == unsafe { libc::geteuid() }
                    && UnixStream::connect(&path)
                        .is_err_and(|err| err.kind() == std::io::ErrorKind::ConnectionRefused);
                if !stale {
                    return Err("浏览器只读接口路径已占用，请检查旧监督会话".into());
                }
                fs::remove_file(&path).map_err(|_| ERROR)?;
            }
            let instance_id = uuid()?;
            let listener = UnixListener::bind(&path).map_err(|_| ERROR)?;
            let metadata = fs::symlink_metadata(&path).map_err(|_| ERROR)?;
            let bridge = Self {
                listener,
                path,
                inode: metadata.ino(),
                device: metadata.dev(),
                profile_id: profile_id.into(),
                revision,
                instance_id,
            };
            fs::set_permissions(&bridge.path, fs::Permissions::from_mode(0o600))
                .map_err(|_| ERROR)?;
            bridge.listener.set_nonblocking(true).map_err(|_| ERROR)?;
            Ok(bridge)
        }

        /// 一个循环至多接收一个请求，所有 CDP 调用仍由监督线程顺序执行。
        #[cfg(test)]
        pub fn poll<F>(&self, cdp: F)
        where
            F: FnMut(&str, Value, Option<&str>, Instant) -> Result<Value>,
        {
            self.poll_with_cancel(cdp, || false)
        }
        pub fn poll_with_cancel<F, C>(&self, mut cdp: F, cancelled: C)
        where
            F: FnMut(&str, Value, Option<&str>, Instant) -> Result<Value>,
            C: Fn() -> bool,
        {
            if cancelled() { return; }
            let Ok((mut stream, _)) = self.listener.accept() else {
                return;
            };
            if !same_user(&stream) {
                return;
            }
            let deadline = Instant::now() + Duration::from_secs(8);
            let result = self
                .read_request(&mut stream, deadline, &cancelled)
                .and_then(|request| self.respond(request, deadline, &mut cdp));
            let response = match result {
                Ok(data) => json!({"ok":true,"data":data}),
                Err(error) => super::safe_failure(&error),
            };
            let mut bytes = serde_json::to_vec(&response).unwrap_or_default();
            if bytes.len() >= MAX_RESPONSE {
                bytes = serde_json::to_vec(&json!({"ok":false,"error":ERROR})).unwrap();
            }
            bytes.push(b'\n');
            let mut offset = 0;
            while offset < bytes.len() && !cancelled() {
                let Ok(timeout) = remaining(deadline) else { break; };
                if stream.set_write_timeout(Some(timeout.min(Duration::from_millis(100)))).is_err() { break; }
                match stream.write(&bytes[offset..]) {
                    Ok(0) => break,
                    Ok(count) => offset += count,
                    Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted) => {},
                    Err(_) => break,
                }
            }
        }
        fn read_request<C: Fn() -> bool>(&self, stream: &mut UnixStream, deadline: Instant, cancelled: &C) -> Result<Value> {
            let mut bytes = Vec::new();
            loop {
                if cancelled() { return Err(ERROR.into()); }
                stream
                    .set_read_timeout(Some(remaining(deadline)?.min(Duration::from_millis(100))))
                    .map_err(|_| ERROR)?;
                let mut byte = [0u8; 1];
                match stream.read(&mut byte) {
                    Ok(1) => {},
                    Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted) => continue,
                    _ => return Err(ERROR.into()),
                }
                bytes.push(byte[0]);
                if bytes.len() > MAX_REQUEST {
                    return Err(ERROR.into());
                }
                if byte[0] == b'\n' {
                    break;
                }
            }
            serde_json::from_slice(&bytes).map_err(|_| ERROR.into())
        }
        fn respond<F>(&self, request: Value, deadline: Instant, cdp: &mut F) -> Result<Value>
        where
            F: FnMut(&str, Value, Option<&str>, Instant) -> Result<Value>,
        {
            let object = request.as_object().ok_or(ERROR)?;
            let keys = [
                "protocol",
                "requestId",
                "profileId",
                "sourceRevision",
                "action",
                "targetId",
                "expectedInstanceId",
                "origins",
                "observations",
                "url",
            ];
            if object.keys().any(|k| !keys.contains(&k.as_str()))
                || request["protocol"] != PROTOCOL
                || request["profileId"] != self.profile_id
                || request["sourceRevision"] != self.revision
                || !request["requestId"].as_str().is_some_and(valid_uuid)
            {
                return Err(ERROR.into());
            }
            let origins = crate::page_observer::origins(&request["origins"])?;
            if request.get("expectedInstanceId").is_some_and(|id|id!=&self.instance_id) {return Err(ERROR.into());}
            let action = request["action"].as_str().ok_or(ERROR)?;
            let mut data = json!({"protocol":PROTOCOL,"requestId":request["requestId"],"profileId":self.profile_id,
                "sourceRevision":self.revision,"instanceId":self.instance_id,"action":action});
            match action {
                "status" => {
                    // 验证私有管道仍可应答；该固定命令不读取任何页面。
                    cdp("Browser.getVersion", json!({}), None, deadline)?;
                    data["state"] = json!("ready");
                }
                "pages" => {
                    let targets = cdp("Target.getTargets", json!({}), None, deadline)?;
                    let infos = targets["targetInfos"]
                        .as_array()
                        .filter(|v| v.len() <= 500)
                        .ok_or(ERROR)?;
                    let pages: Vec<Value> = infos
                        .iter()
                        .filter_map(|v| page_info(v, &origins).ok())
                        .take(100)
                        .collect();
                    data["pages"] = json!(pages);
                }
                "read-page" => {
                    if request["expectedInstanceId"] != self.instance_id {
                        return Err(ERROR.into());
                    }
                    let target = request["targetId"]
                        .as_str()
                        .filter(|s| safe_target(s))
                        .ok_or(ERROR)?;
                    data["page"] = read_page(target, &origins, deadline, cdp)?;
                }
                "open-page" => {
                    if request["expectedInstanceId"] != self.instance_id { return Err(ERROR.into()); }
                    let raw=request["url"].as_str().ok_or(ERROR)?;
                    let (url,_)=permitted_url(raw,&origins)?;
                    if url!=raw {return Err(ERROR.into());}
                    let opened=cdp("Target.createTarget",json!({"url":url,"background":true}),None,deadline)?;
                    data["targetId"]=opened["targetId"].clone();
                }
                "inspect-page" => {
                    if request["expectedInstanceId"] != self.instance_id { return Err(ERROR.into()); }
                    let target = request["targetId"].as_str().filter(|s| safe_target(s)).ok_or(ERROR)?;
                    let before = cdp("Target.getTargetInfo", json!({"targetId":target}), None, deadline)?;
                    page_info(&before["targetInfo"], &origins)?;
                    let url = before["targetInfo"]["url"].as_str().ok_or(ERROR)?;
                    let (copy_id, observations) = crate::page_observer::inspect(url, &origins, &request["observations"], deadline, cdp)?;
                    let result = read_page(&copy_id, &origins, deadline, cdp);
                    let _ = cdp("Target.closeTarget", json!({"targetId":copy_id}), None, deadline);
                    let after=cdp("Target.getTargetInfo",json!({"targetId":target}),None,deadline)?;
                    if after["targetInfo"]["url"]!=before["targetInfo"]["url"] {return Err(ERROR.into());}
                    data["page"] = result?;
                    data["page"]["targetId"] = json!(target);
                    data["observations"] = observations;
                }
                _ => return Err(ERROR.into()),
            }
            remaining(deadline)?;
            Ok(data)
        }
    }
    impl Drop for Bridge {
        fn drop(&mut self) {
            if fs::symlink_metadata(&self.path).is_ok_and(|m| {
                m.file_type().is_socket() && m.ino() == self.inode && m.dev() == self.device
            }) {
                let _ = fs::remove_file(&self.path);
            }
        }
    }

    pub(crate) fn permitted_url(raw: &str, origins: &[String]) -> Result<(String, String)> {
        if raw.len() > 16_384 || raw.chars().any(char::is_control) {
            return Err(ERROR.into());
        }
        let mut url = url::Url::parse(raw).map_err(|_| ERROR)?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port_or_known_default() != Some(443)
        {
            return Err(ERROR.into());
        }
        let platform = url.origin().ascii_serialization();
        if !origins.contains(&platform) { return Err(ERROR.into()); }
        url.set_query(None);
        url.set_fragment(None);
        let clean: String = url.into();
        if clean.len() > 2048 {
            return Err(ERROR.into());
        }
        Ok((clean, platform))
    }
    fn page_info(target: &Value, origins: &[String]) -> Result<Value> {
        if target["type"] != "page" {
            return Err(ERROR.into());
        }
        let id = target["targetId"]
            .as_str()
            .filter(|s| safe_target(s))
            .ok_or(ERROR)?;
        let (url, platform) = permitted_url(target["url"].as_str().ok_or(ERROR)?, origins)?;
        let title: String = target["title"]
            .as_str()
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_control())
            .take(300)
            .collect();
        Ok(json!({"targetId":id,"title":title,"url":url,"origin":platform}))
    }
    fn frame_url(frame: &Value) -> Result<String> {
        let base = frame["url"].as_str().ok_or(ERROR)?;
        let fragment = frame
            .get("urlFragment")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !fragment.is_empty() && !fragment.starts_with('#') {
            return Err(ERROR.into());
        }
        Ok(format!("{base}{fragment}"))
    }
    fn read_page<F>(target: &str, origins: &[String], deadline: Instant, cdp: &mut F) -> Result<Value>
    where
        F: FnMut(&str, Value, Option<&str>, Instant) -> Result<Value>,
    {
        let before = cdp(
            "Target.getTargetInfo",
            json!({"targetId":target}),
            None,
            deadline,
        )?;
        let info = &before["targetInfo"];
        let mut page = page_info(info, origins)?;
        if info["targetId"] != target {
            return Err(ERROR.into());
        }
        let attached = cdp(
            "Target.attachToTarget",
            json!({"targetId":target,"flatten":true}),
            None,
            deadline,
        )?;
        let session = attached["sessionId"]
            .as_str()
            .filter(|s| safe_target(s))
            .ok_or(ERROR)?;
        // 为释放本次会话预留 500ms，读取和清理共享同一个 8 秒总期限。
        let read_deadline = deadline
            .checked_sub(Duration::from_millis(500))
            .ok_or(ERROR)?;
        let result = (|| {
            let before_frame = cdp("Page.getFrameTree", json!({}), Some(session), read_deadline)?;
            let frame = &before_frame["frameTree"]["frame"];
            if Some(frame_url(frame)?.as_str()) != info["url"].as_str()
                || frame["loaderId"].as_str().is_none_or(str::is_empty)
                || frame["id"].as_str().is_none_or(str::is_empty)
            {
                return Err(ERROR.into());
            }
            let snapshot = cdp(
                "DOMSnapshot.captureSnapshot",
                json!({
                "computedStyles":STYLES,
                "includePaintOrder":false,"includeDOMRects":false}),
                Some(session),
                read_deadline,
            )?;
            let (text, truncated) = snapshot_text(&snapshot, frame)?;
            let after_frame = cdp("Page.getFrameTree", json!({}), Some(session), read_deadline)?;
            let after = cdp(
                "Target.getTargetInfo",
                json!({"targetId":target}),
                None,
                read_deadline,
            )?;
            let current_frame = &after_frame["frameTree"]["frame"];
            if current_frame["id"] != frame["id"]
                || current_frame["loaderId"] != frame["loaderId"]
                || frame_url(current_frame)? != frame_url(frame)?
                || after["targetInfo"]["url"] != info["url"]
                || after["targetInfo"]["targetId"] != target
                || after["targetInfo"]["type"] != "page"
            {
                return Err(ERROR.into());
            }
            page["text"] = json!(text);
            page["truncated"] = json!(truncated);
            Ok(page)
        })();
        // 无论快照成功与否，都尝试释放本次只读会话；不延长总预算。
        if remaining(deadline).is_ok() {
            let _ = cdp(
                "Target.detachFromTarget",
                json!({"sessionId":session}),
                None,
                deadline,
            );
        }
        result
    }

    fn string_at<'a>(strings: &'a [Value], index: &Value) -> Result<&'a str> {
        // DOMSnapshot 使用 -1 表示空字符串（如无值的 contenteditable 属性）。
        if index.as_i64() == Some(-1) {
            return Ok("");
        }
        index
            .as_u64()
            .and_then(|i| strings.get(i as usize))
            .and_then(Value::as_str)
            .ok_or_else(|| ERROR.into())
    }
    fn snapshot_text(snapshot: &Value, frame: &Value) -> Result<(String, bool)> {
        let strings = snapshot["strings"].as_array().ok_or(ERROR)?;
        let documents = snapshot["documents"].as_array().ok_or(ERROR)?;
        let document = documents.first().ok_or(ERROR)?;
        let document_url = string_at(strings, &document["documentURL"])?;
        // 来源已经由 read_page 校验；以下再次核对文档与冻结 frame 地址。
        if document_url != frame_url(frame)?
            || Some(string_at(strings, &document["frameId"])?) != frame["id"].as_str()
        {
            return Err(ERROR.into());
        }
        // 只处理主文档；不返回任何 iframe 文档、属性、输入值或原始快照。
        let nodes = &document["nodes"];
        let names = nodes["nodeName"]
            .as_array()
            .filter(|v| v.len() <= MAX_NODES)
            .ok_or(ERROR)?;
        let parents = nodes["parentIndex"]
            .as_array()
            .filter(|v| v.len() == names.len())
            .ok_or(ERROR)?;
        let types = nodes["nodeType"]
            .as_array()
            .filter(|v| v.len() == names.len())
            .ok_or(ERROR)?;
        let attributes = nodes["attributes"]
            .as_array()
            .filter(|v| v.len() == names.len())
            .ok_or(ERROR)?;
        let layout = &document["layout"];
        let indices = layout["nodeIndex"]
            .as_array()
            .filter(|v| v.len() <= MAX_NODES)
            .ok_or(ERROR)?;
        let texts = layout["text"]
            .as_array()
            .filter(|v| v.len() == indices.len())
            .ok_or(ERROR)?;
        let styles = layout["styles"]
            .as_array()
            .filter(|v| v.len() == indices.len())
            .ok_or(ERROR)?;
        let bounds = layout["bounds"]
            .as_array()
            .filter(|v| v.len() == indices.len())
            .ok_or(ERROR)?;
        let mut hidden = HashSet::new();
        let mut clips = HashMap::new();
        for (i, index) in indices.iter().enumerate() {
            let index = index
                .as_u64()
                .filter(|n| (*n as usize) < names.len())
                .ok_or(ERROR)? as usize;
            let style = styles[i].as_array().ok_or(ERROR)?;
            // Chrome 为 #document 返回空计算样式；该节点仍是正文的祖先。
            if style.is_empty() && types[index].as_u64() == Some(9) {
                continue;
            }
            if style.len() != STYLES.len() {
                hidden.insert(index);
                continue;
            }
            let computed: Vec<&str> = style
                .iter()
                .map(|s| string_at(strings, s))
                .collect::<Result<_>>()?;
            if computed[0] == "none"
                || ["hidden", "collapse"].contains(&computed[1])
                || computed[2].parse::<f64>().is_ok_and(|v| v <= 0.0)
                || computed[3] == "hidden"
                || computed[6] != "auto"
                || computed[7] != "none"
            {
                hidden.insert(index);
            }
            let clip_x = ["hidden", "clip", "scroll", "auto"].contains(&computed[4]);
            let clip_y = ["hidden", "clip", "scroll", "auto"].contains(&computed[5]);
            if clip_x || clip_y {
                let rect = bounds[i].as_array().filter(|r| r.len() == 4).ok_or(ERROR)?;
                let rect: Vec<f64> = rect
                    .iter()
                    .map(|v| v.as_f64().ok_or_else(|| ERROR.to_string()))
                    .collect::<Result<_>>()?;
                clips.insert(index, (clip_x, clip_y, rect));
            }
        }
        for (i, name) in names.iter().enumerate() {
            let name = string_at(strings, name)?;
            if [
                "SCRIPT", "STYLE", "NOSCRIPT", "INPUT", "TEXTAREA", "SELECT", "OPTION", "FORM",
                "IFRAME", "OBJECT", "EMBED",
            ]
            .contains(&name)
            {
                hidden.insert(i);
            }
            let attrs = attributes[i]
                .as_array()
                .filter(|a| a.len() % 2 == 0)
                .ok_or(ERROR)?;
            for pair in attrs.chunks_exact(2) {
                let key = string_at(strings, &pair[0])?;
                let value = string_at(strings, &pair[1])?;
                if key.eq_ignore_ascii_case("hidden")
                    || (key.eq_ignore_ascii_case("aria-hidden")
                        && value.eq_ignore_ascii_case("true"))
                    || (key.eq_ignore_ascii_case("contenteditable")
                        && !value.eq_ignore_ascii_case("false"))
                {
                    hidden.insert(i);
                }
            }
        }
        let mut output = String::new();
        let mut chars = 0usize;
        let mut truncated = false;
        for (i, index) in indices.iter().enumerate() {
            let index = index.as_u64().ok_or(ERROR)? as usize;
            if types[index].as_u64() != Some(3) {
                continue;
            }
            let rect = bounds[i].as_array().filter(|r| r.len() == 4).ok_or(ERROR)?;
            if !rect[2].as_f64().is_some_and(|n| n > 0.0)
                || !rect[3].as_f64().is_some_and(|n| n > 0.0)
            {
                continue;
            }
            let rect: Vec<f64> = rect
                .iter()
                .map(|v| v.as_f64().ok_or_else(|| ERROR.to_string()))
                .collect::<Result<_>>()?;
            let mut cursor = Some(index);
            let mut visible = true;
            let mut visited = HashSet::new();
            while let Some(node) = cursor {
                if !visited.insert(node) || visited.len() > 256 {
                    return Err(ERROR.into());
                }
                if hidden.contains(&node) {
                    visible = false;
                    break;
                }
                if let Some((x, y, clip)) = clips.get(&node) {
                    if (*x
                        && (clip[2] <= 0.0
                            || rect[0] < clip[0]
                            || rect[0] + rect[2] > clip[0] + clip[2]))
                        || (*y
                            && (clip[3] <= 0.0
                                || rect[1] < clip[1]
                                || rect[1] + rect[3] > clip[1] + clip[3]))
                    {
                        visible = false;
                        break;
                    }
                }
                let parent = parents[node].as_i64().ok_or(ERROR)?;
                cursor = if parent < 0 {
                    None
                } else {
                    Some(
                        usize::try_from(parent)
                            .ok()
                            .filter(|p| *p < names.len())
                            .ok_or(ERROR)?,
                    )
                };
            }
            if !visible {
                continue;
            }
            let text = string_at(strings, &texts[i])?;
            let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if normalized.is_empty() {
                continue;
            }
            if !output.is_empty() {
                if chars >= MAX_TEXT {
                    truncated = true;
                    break;
                }
                output.push('\n');
                chars += 1;
            }
            for ch in normalized.chars().filter(|c| !c.is_control()) {
                if chars >= MAX_TEXT {
                    truncated = true;
                    break;
                }
                output.push(ch);
                chars += 1;
            }
            if truncated {
                break;
            }
        }
        Ok((output, truncated))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        fn allowed()->Vec<String>{vec!["https://kalodata.com".into(),"https://affiliate.tiktok.com".into(),"https://www.kalodata.com".into()]}
        fn permitted_url(raw:&str)->Result<(String,String)>{super::permitted_url(raw,&allowed())}
        fn revision() -> Value {
            json!({"profileCreatedAt":1,"profileUpdatedAt":2,"subscription":null,"confidence":"public_metadata"})
        }
        fn fixture() -> (Value, Value) {
            let strings = json!([
                "https://kalodata.com/creator?token=private",
                "frame",
                "#document",
                "HTML",
                "BODY",
                "#text",
                "FORM",
                "SCRIPT",
                "DIV",
                "",
                "公开数据",
                "表单秘密",
                "脚本秘密",
                "隐藏秘密",
                "block",
                "visible",
                "1",
                "0",
                "normal",
                "none",
                "auto"
            ]);
            let nodes = json!({"nodeName":[2,3,4,5,6,5,7,5,8,5],"nodeType":[9,1,1,3,1,3,1,3,1,3],"parentIndex":[-1,0,1,2,2,4,2,6,2,8],"attributes":[[],[],[],[],[],[],[],[],[],[]]});
            let layout = json!({"nodeIndex":[0,1,2,3,4,5,6,7,8,9],"text":[-1,9,9,10,9,11,9,12,9,13],"styles":[[],[14,15,16,18,15,15,20,19],[14,15,16,18,15,15,20,19],[14,15,16,18,15,15,20,19],[14,15,16,18,15,15,20,19],[14,15,16,18,15,15,20,19],[14,15,16,18,15,15,20,19],[14,15,16,18,15,15,20,19],[14,15,17,18,15,15,20,19],[14,15,16,18,15,15,20,19]],"bounds":[[0,0,100,100],[0,0,100,100],[0,0,100,100],[0,0,100,10],[0,0,100,10],[0,0,100,10],[0,0,100,10],[0,0,100,10],[0,0,100,10],[0,0,100,10]]});
            (
                json!({"strings":strings,"documents":[{"documentURL":0,"frameId":1,"nodes":nodes,"layout":layout},{"documentURL":999,"text":"跨域秘密"}]}),
                json!({"id":"frame","url":"https://kalodata.com/creator?token=private","loaderId":"loader"}),
            )
        }
        #[test]
        fn partial_socket_request_is_cancelled_before_cdp() {
            use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
            let root = temp_root();
            let bridge = Bridge::bind_at(&root, "shop", revision()).unwrap();
            let mut client = UnixStream::connect(&bridge.path).unwrap();
            client.write_all(b"{").unwrap();
            let cancelled = Arc::new(AtomicBool::new(false));
            let signal = cancelled.clone();
            let thread = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150));
                signal.store(true, Ordering::Relaxed);
            });
            let started = Instant::now();
            bridge.poll_with_cancel(|_, _, _, _| panic!("未完成请求不得访问 CDP"), || cancelled.load(Ordering::Relaxed));
            thread.join().unwrap();
            assert!(started.elapsed() < Duration::from_secs(1));
            let mut response = String::new();
            client.read_to_string(&mut response).unwrap();
            assert!(response.is_empty());
            drop(bridge);
            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn url_allowlist_and_projection() {
            assert_eq!(
                permitted_url("https://affiliate.tiktok.com/a?secret=x#f")
                    .unwrap()
                    .0,
                "https://affiliate.tiktok.com/a"
            );
            for url in [
                "http://kalodata.com/",
                "https://kalodata.com.evil/",
                "https://user:pw@kalodata.com/",
                "https://kalodata.com:8443/",
                "file:///secret",
                "https://evil/?https://kalodata.com/",
            ] {
                assert!(permitted_url(url).is_err());
            }
            assert_eq!(
                frame_url(&json!({"url":"https://kalodata.com/a?q=1","urlFragment":"#part"}))
                    .unwrap(),
                "https://kalodata.com/a?q=1#part"
            );
            assert_eq!(string_at(&[], &json!(-1)).unwrap(), "");
        }
        #[test]
        fn default_uuid_socket_path_fits_macos() {
            let digest = format!(
                "{:x}",
                Sha256::digest(b"12345678-1234-4234-8234-123456789abc")
            );
            let path = format!(
                "/Users/Zhuanz/.multicc/plugins-data/chrome-proxy-launcher/run/read-{}.sock",
                &digest[..16]
            );
            assert!(path.len() < 104);
        }
        #[test]
        fn snapshot_filters_forms_scripts_hidden_and_iframes() {
            let (snapshot, frame) = fixture();
            assert_eq!(
                snapshot_text(&snapshot, &frame).unwrap(),
                ("公开数据".into(), false)
            );
            assert!(snapshot_text(
                &snapshot,
                &json!({"id":"frame","url":"https://kalodata.com/changed"})
            )
            .is_err());
        }
        #[test]
        fn snapshot_truncates_and_rejects_invalid_indices() {
            let (mut snapshot, frame) = fixture();
            snapshot["strings"][10] = json!("中".repeat(MAX_TEXT + 1));
            let (text, truncated) = snapshot_text(&snapshot, &frame).unwrap();
            assert_eq!(text.chars().count(), MAX_TEXT);
            assert!(truncated);
            snapshot["documents"][0]["nodes"]["parentIndex"][3] = json!(9999);
            assert!(snapshot_text(&snapshot, &frame).is_err());
        }
        fn temp_root() -> PathBuf {
            let root = std::env::temp_dir().join(format!("cbr-{}", &uuid().unwrap()[..8]));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            root
        }
        fn request(action: &str) -> Value {
            json!({"protocol":PROTOCOL,"requestId":uuid().unwrap(),"profileId":"shop","sourceRevision":revision(),"action":action,"origins":allowed()})
        }
        #[test]
        fn status_is_read_only_and_rejects_other_identity_or_revision() {
            let root = temp_root();
            let bridge = Bridge::bind_at(&root, "shop", revision()).unwrap();
            let mut cdp = |method: &str, _: Value, _: Option<&str>, _: Instant| -> Result<Value> {
                assert_eq!(method, "Browser.getVersion");
                Ok(json!({}))
            };
            let deadline = Instant::now() + Duration::from_secs(1);
            assert_eq!(
                bridge
                    .respond(request("status"), deadline, &mut cdp)
                    .unwrap()["state"],
                "ready"
            );
            let mut wrong = request("status");
            wrong["profileId"] = json!("other");
            assert!(bridge.respond(wrong, deadline, &mut cdp).is_err());
            let mut wrong = request("status");
            wrong["sourceRevision"]["profileUpdatedAt"] = json!(3);
            assert!(bridge.respond(wrong, deadline, &mut cdp).is_err());
            let mut wrong = request("read-page");
            wrong["targetId"] = json!("target");
            wrong["expectedInstanceId"] = json!(uuid().unwrap());
            assert!(bridge.respond(wrong, deadline, &mut cdp).is_err());
            let mut wrong = request("status");
            wrong["method"] = json!("Runtime.evaluate");
            assert!(bridge.respond(wrong, deadline, &mut cdp).is_err());
            drop(bridge);
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn ipc_framing_permissions_and_owned_socket_cleanup() {
            let root = temp_root();
            let bridge = Bridge::bind_at(&root, "shop", revision()).unwrap();
            let path = bridge.path.clone();
            assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
            let mut client = UnixStream::connect(&path).unwrap();
            client
                .write_all((request("status").to_string() + "\n").as_bytes())
                .unwrap();
            bridge.poll(|method, _, _, _| {
                assert_eq!(method, "Browser.getVersion");
                Ok(json!({}))
            });
            let mut response = String::new();
            client.read_to_string(&mut response).unwrap();
            let response: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(response["ok"], true);
            assert!(valid_uuid(response["data"]["instanceId"].as_str().unwrap()));
            assert!(Bridge::bind_at(&root, "shop", revision()).is_err());
            fs::remove_file(&path).unwrap();
            fs::write(&path, "replacement").unwrap();
            drop(bridge);
            assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn long_data_root_falls_back_to_private_short_dir() {
            let short = Path::new("/Users/Zhuanz/.multicc/plugins-data/chrome-proxy-launcher");
            assert_eq!(socket_path(short, "shop").parent(), Some(short.join("run").as_path()));
            let long = PathBuf::from(format!("/Users/{}", "x".repeat(80)));
            let other = PathBuf::from(format!("/Users/{}", "y".repeat(80)));
            let path = socket_path(&long, "shop");
            assert_eq!(path.parent(), Some(short_dir().as_path()));
            assert!(fits_sun_path(&path));
            assert_ne!(path, socket_path(&other, "shop"));
            assert_ne!(path, socket_path(&long, "other"));

            let base = temp_root();
            let root = base.join("d".repeat(80));
            fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
            let bridge = Bridge::bind_at(&root, "shop", revision()).unwrap();
            assert_eq!(bridge.path, socket_path(&root, "shop"));
            assert_eq!(bridge.path.parent(), Some(short_dir().as_path()));
            let dir_mode = fs::metadata(short_dir()).unwrap().mode();
            assert_eq!(dir_mode & 0o077, 0);
            UnixStream::connect(&bridge.path).unwrap();
            let path = bridge.path.clone();
            drop(bridge);
            assert!(fs::symlink_metadata(&path).is_err());
            fs::remove_dir_all(base).unwrap();
        }
        #[test]
        fn stale_socket_is_replaced_but_regular_file_is_refused() {
            let root = temp_root();
            let path = socket_path(&root, "shop");
            fs::create_dir(root.join("run")).unwrap();
            fs::set_permissions(root.join("run"), fs::Permissions::from_mode(0o700)).unwrap();
            // 监督进程被强杀：socket 文件还在，但已无人监听。
            drop(UnixListener::bind(&path).unwrap());
            assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket());
            let bridge = Bridge::bind_at(&root, "shop", revision()).unwrap();
            UnixStream::connect(&bridge.path).unwrap();
            drop(bridge);
            fs::write(&path, "not a socket").unwrap();
            assert!(Bridge::bind_at(&root, "shop", revision()).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), "not a socket");
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn symlink_root_is_rejected() {
            let root = temp_root();
            let link = root.with_extension("link");
            std::os::unix::fs::symlink(&root, &link).unwrap();
            assert!(Bridge::bind_at(&link, "shop", revision()).is_err());
            fs::remove_file(link).unwrap();
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn read_page_uses_fixed_methods_and_detects_navigation() {
            let (snapshot, frame) = fixture();
            for changed in [false, true] {
                let mut frame_reads = 0;
                let mut detached = false;
                let mut cdp = |method: &str,
                               params: Value,
                               session: Option<&str>,
                               _deadline: Instant|
                 -> Result<Value> {
                    Ok(match method {
                        "Target.getTargetInfo" => {
                            json!({"targetInfo":{"type":"page","targetId":"target","title":"标题","url":frame["url"]}})
                        }
                        "Target.attachToTarget" => {
                            assert_eq!(params["flatten"], true);
                            json!({"sessionId":"session"})
                        }
                        "Page.getFrameTree" => {
                            assert_eq!(session, Some("session"));
                            frame_reads += 1;
                            let mut f = frame.clone();
                            if changed && frame_reads > 1 {
                                f["loaderId"] = json!("new");
                            }
                            json!({"frameTree":{"frame":f}})
                        }
                        "DOMSnapshot.captureSnapshot" => {
                            assert_eq!(session, Some("session"));
                            snapshot.clone()
                        }
                        "Target.detachFromTarget" => {
                            detached = true;
                            json!({})
                        }
                        _ => panic!("不允许的方法: {method}"),
                    })
                };
                let result = read_page("target", &allowed(), Instant::now() + Duration::from_secs(2), &mut cdp);
                if changed {
                    assert!(result.is_err());
                } else {
                    let result = result.unwrap();
                    assert_eq!(result["text"], "公开数据");
                    assert_eq!(result["url"], "https://kalodata.com/creator");
                }
                assert!(detached);
            }
        }
    }
}
