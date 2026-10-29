//! 守护进程本体：单实例、两个入口（本地 socket / loopback WebSocket）、空闲退出。
//!
//! 单实例靠一把随进程消亡的锁（unix 上 flock，Windows 上 first_pipe_instance）。
//! 只靠「探活 + unlink 旧 socket」不够：两个进程同时启动时都会探到死 socket、
//! 都 unlink、各自 bind —— 先 bind 的那个从路径上被摘掉，永远连不上却一直活着。

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::front::FrontInfo;
use crate::log::now_ms;
use crate::paths::Paths;
use crate::pool::{Pool, Refusal, Settings};
use crate::router::{ConnId, JoinOptions};
use crate::upstream::{Cmd, ConnMsg, CONN_QUEUE};
use crate::PROTOCOL_VERSION;

pub struct Daemon {
    pub pool: Arc<Pool>,
    pub paths: Paths,
    pub started_ms: u64,
    pub shutdown: Notify,
    pub front: OnceLock<FrontInfo>,
    active: AtomicUsize,
    next_conn: AtomicU64,
}

/// 一条 CDP 连接在用时计数；空闲退出只看它和上游池。
pub struct ActiveGuard(Arc<Daemon>);

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct Attached {
    pub actor: mpsc::Sender<Cmd>,
    pub conn: ConnId,
    pub rx: mpsc::Receiver<ConnMsg>,
    pub _guard: ActiveGuard,
}

impl Daemon {
    pub fn new(paths: Paths) -> Arc<Self> {
        Arc::new(Self {
            pool: Pool::new(Settings::from_env()),
            paths,
            started_ms: now_ms(),
            shutdown: Notify::new(),
            front: OnceLock::new(),
            active: AtomicUsize::new(0),
            next_conn: AtomicU64::new(1),
        })
    }

    pub fn busy(&self) -> bool {
        !self.pool.is_empty() || self.active.load(Ordering::SeqCst) > 0
    }

    pub fn ping_body(&self) -> Value {
        json!({
            "ok": true,
            "pong": true,
            "protocol": PROTOCOL_VERSION,
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "startedAt": crate::log::format_utc(self.started_ms / 1000),
            "busy": self.busy(),
            "capabilities": if cfg!(unix) { vec!["browser-control-pipe-v1"] } else { vec![] },
        })
    }

    pub async fn status(&self) -> Value {
        let mut upstreams = Vec::new();
        for actor in self.pool.actors() {
            let (reply, answer) = oneshot::channel();
            if actor.send(Cmd::Snapshot { reply }).await.is_ok() {
                if let Ok(Ok(snapshot)) = tokio::time::timeout(Duration::from_secs(1), answer).await
                {
                    upstreams.push(snapshot);
                }
            }
        }
        let mut body = self.ping_body();
        body["upstreams"] = Value::Array(upstreams);
        if let Some(front) = self.front.get() {
            body["endpoint"] = json!(front.base());
        }
        body
    }

    pub async fn release(&self, url: &str, lane: &str) -> bool {
        let Some(actor) = self.pool.existing(url) else {
            return false;
        };
        let (reply, answer) = oneshot::channel();
        if actor
            .send(Cmd::Release {
                lane: lane.to_string(),
                reply,
            })
            .await
            .is_err()
        {
            return false;
        }
        answer.await.unwrap_or(false)
    }

    /// 把一条新连接挂到上游 actor 上。actor 恰好在退出时 send 会失败：池里的旧条目
    /// 随即被清掉（is_closed），再取一次就是新建的。
    pub async fn attach(
        self: &Arc<Self>,
        url: &str,
        force: bool,
        options: JoinOptions,
    ) -> Result<Attached, Refusal> {
        for _ in 0..3 {
            let actor = self.pool.handle(url, force)?;
            let conn = self.next_conn.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = mpsc::channel(CONN_QUEUE);
            self.active.fetch_add(1, Ordering::SeqCst);
            let guard = ActiveGuard(self.clone());
            if actor
                .send(Cmd::Join {
                    conn,
                    options: options.clone(),
                    tx,
                })
                .await
                .is_ok()
            {
                return Ok(Attached {
                    actor,
                    conn,
                    rx,
                    _guard: guard,
                });
            }
            drop(guard);
            tokio::task::yield_now().await;
        }
        Err(Refusal {
            code: "chrome_unavailable",
            detail: "the upstream connection kept closing".into(),
            retry_after_ms: None,
        })
    }
}

/// 解析调用方给的 lane 参数（行协议的 JSON 字段和 WebSocket 入口的 query 共用）。
pub fn join_options(
    lane: Option<&str>,
    ttl_ms: Option<u64>,
    allow_browser_close: bool,
    control: bool,
) -> Result<JoinOptions, Refusal> {
    let lane = lane
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned);
    if let Some(name) = &lane {
        let valid = name.len() <= 64
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'));
        if !valid {
            return Err(Refusal::bad_request(
                "lane must be 1-64 characters of [A-Za-z0-9._:-]",
            ));
        }
    }
    let ttl_ms = match &lane {
        Some(_) => ttl_ms.unwrap_or(10 * 60 * 1000).min(24 * 60 * 60 * 1000),
        None => 0,
    };
    Ok(JoinOptions {
        lane,
        ttl_ms,
        allow_browser_close,
        control,
    })
}

fn idle_exit_after() -> Option<Duration> {
    let secs = std::env::var("MULTICC_CDP_IDLE_EXIT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(3600);
    (secs > 0).then(|| Duration::from_secs(secs))
}

pub async fn serve(paths: Paths) -> Result<(), String> {
    std::fs::create_dir_all(&paths.dir)
        .map_err(|e| format!("create {}: {e}", paths.dir.display()))?;
    restrict_dir(&paths.dir);
    crate::log::init(&paths.log);

    #[cfg(unix)]
    let _lock = match lock::acquire(&paths.lock) {
        Ok(file) => file,
        Err(lock::LockError::Busy) => {
            // 另一个实例在跑（或正在启动）：这不是错误，自动拉起的并发竞争就会走到这里。
            eprintln!("multicc-cdpd already running ({})", paths.socket.display());
            return Ok(());
        }
        Err(lock::LockError::Io(error)) => {
            return Err(format!("lock {}: {error}", paths.lock.display()))
        }
    };

    let listener = match crate::ipc::Listener::bind(&paths.socket).await {
        Ok(listener) => listener,
        Err(crate::ipc::BindError::InUse) => {
            eprintln!("multicc-cdpd already running ({})", paths.socket.display());
            return Ok(());
        }
        Err(crate::ipc::BindError::Other(error)) => return Err(error),
    };
    let daemon = Daemon::new(paths.clone());

    if std::env::var("MULTICC_CDP_WS")
        .map(|v| v.trim() != "0")
        .unwrap_or(true)
    {
        match crate::front::bind().await {
            Ok((front_listener, info)) => {
                write_endpoint(&paths, &info);
                let _ = daemon.front.set(info);
                tokio::spawn(crate::front::serve(front_listener, daemon.clone()));
            }
            Err(error) => crate::log!("websocket endpoint disabled: {error}"),
        }
    }
    crate::log!(
        "multicc-cdpd {} (protocol {PROTOCOL_VERSION}) pid {} serving {}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        paths.socket.display()
    );

    tokio::spawn(watch_signals(daemon.clone()));
    if let Some(limit) = idle_exit_after() {
        tokio::spawn(watch_idle(daemon.clone(), limit));
    }

    let accept = {
        let daemon = daemon.clone();
        async move {
            let mut listener = listener;
            loop {
                match listener.accept().await {
                    Ok(stream) => {
                        tokio::spawn(crate::ipc::handle(stream, daemon.clone()));
                    }
                    Err(error) => {
                        crate::log!("accept failed: {error}");
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                }
            }
        }
    };
    tokio::select! {
        _ = accept => {}
        _ = daemon.shutdown.notified() => {}
    }
    #[cfg(unix)]
    let _ = std::fs::remove_file(&paths.socket);
    let _ = std::fs::remove_file(&paths.endpoint);
    crate::log!("multicc-cdpd stopped");
    Ok(())
}

async fn watch_signals(daemon: Arc<Daemon>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let wait = |kind: SignalKind| async move {
            match signal(kind) {
                Ok(mut stream) => {
                    stream.recv().await;
                }
                Err(_) => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = wait(SignalKind::terminate()) => {}
            _ = wait(SignalKind::hangup()) => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(windows)]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    crate::log!("signal received, shutting down");
    daemon.shutdown.notify_one();
}

/// 没有任何上游、也没有连接满 `limit` 就退出。有上游时永不退出：那是已经授权过的
/// 连接，退出就要用户再点一次。调用方按需拉起，所以退出是安全的。
async fn watch_idle(daemon: Arc<Daemon>, limit: Duration) {
    let mut idle_since = now_ms();
    let mut tick = tokio::time::interval(Duration::from_secs(30).min(limit));
    loop {
        tick.tick().await;
        if daemon.busy() {
            idle_since = now_ms();
        } else if now_ms().saturating_sub(idle_since) >= limit.as_millis() as u64 {
            crate::log!("idle for {}s, exiting", limit.as_secs());
            daemon.shutdown.notify_one();
            return;
        }
    }
}

fn write_endpoint(paths: &Paths, info: &FrontInfo) {
    let body = json!({
        "protocol": PROTOCOL_VERSION,
        "pid": std::process::id(),
        "url": info.base(),
        "port": info.port,
    });
    let temporary = paths.endpoint.with_extension("json.tmp");
    if std::fs::write(&temporary, body.to_string()).is_ok() {
        restrict_file(&temporary);
        let _ = std::fs::rename(&temporary, &paths.endpoint);
    }
}

#[cfg(unix)]
fn restrict_dir(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
}

#[cfg(unix)]
pub fn restrict_file(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(windows)]
fn restrict_dir(_path: &std::path::Path) {}

#[cfg(windows)]
pub fn restrict_file(_path: &std::path::Path) {}

#[cfg(unix)]
mod lock {
    use std::fs::{File, OpenOptions};
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;
    use std::path::Path;

    pub enum LockError {
        Busy,
        Io(std::io::Error),
    }

    /// 持有到进程退出；SIGKILL 也会被内核释放，所以不存在「死锁文件」。
    pub fn acquire(path: &Path) -> Result<File, LockError> {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .map_err(LockError::Io)?;
        // SAFETY: flock 只读 fd，file 在本函数内保持打开。
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            return Err(if error.kind() == std::io::ErrorKind::WouldBlock {
                LockError::Busy
            } else {
                LockError::Io(error)
            });
        }
        let _ = file.set_len(0);
        let _ = writeln!(file, "{}", std::process::id());
        Ok(file)
    }
}
