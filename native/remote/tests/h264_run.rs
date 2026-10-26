//! `h264::run` 的事件循环：两个「永远就绪」的坑会让 select 变成忙轮询、把一个
//! CPU 核烧满 —— p2p=None（发送端被丢，recv 永远立刻回 None）和首帧超时 Sleep
//! 到期后（永远 ready，循环里没人摘掉它）。
//!
//! CPU 是进程级读数，所以整个文件只留一个测试：别的测试并行跑会把读数搅脏。

#![cfg(unix)]

mod support;

use multicc_remote::h264::{run, H264Options, T_KEY};
use multicc_remote::p2p_api::{P2pControl, P2pEvent, P2pFactory, P2pOptions};
use multicc_remote::stats::Registry;
use multicc_remote::wsout::Incoming;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::UnixListener;
use tokio::sync::{mpsc, oneshot};

/// 当前进程累计的 CPU 毫秒数（user + sys）。忙轮询 350ms 会直接体现在这里。
fn cpu_ms() -> f64 {
    unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        assert_eq!(libc::getrusage(libc::RUSAGE_SELF, &mut usage), 0);
        let user = usage.ru_utime.tv_sec as f64 * 1000.0 + usage.ru_utime.tv_usec as f64 / 1000.0;
        let sys = usage.ru_stime.tv_sec as f64 * 1000.0 + usage.ru_stime.tv_usec as f64 / 1000.0;
        user + sys
    }
}

fn socket_path(tag: &str) -> PathBuf {
    // sun_path 只有 104 字节，别把 /var/folders/... 拼进去。
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    PathBuf::from(format!("/tmp/mrh264-{tag}-{}-{nanos}.sock", std::process::id()))
}

/// 假 Agent 的 h264.sock：连上后第一件事可选的写一帧，然后一直挂着，直到测试放行。
struct FakeH264Agent {
    path: PathBuf,
    release: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

async fn fake_agent(tag: &str, first_write: Option<Vec<u8>>) -> (FakeH264Agent, oneshot::Receiver<()>) {
    let path = socket_path(tag);
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let (accepted_tx, accepted_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let task_path = path.clone();
    let task = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let (mut stream, _) = listener.accept().await.unwrap();
        accepted_tx.send(()).unwrap();
        if let Some(bytes) = first_write {
            stream.write_all(&bytes).await.unwrap();
        }
        let _ = release_rx.await;
        drop(stream);
        let _ = std::fs::remove_file(&task_path);
    });
    (FakeH264Agent { path, release: release_tx, task }, accepted_rx)
}

/// 直连工厂替身：唯一的职责是**把事件发送端活着留住**，让 p2p_rx.recv() 一直
/// 处于 pending。这样 p2p 分支稳定不触发，测到的空转只可能来自首帧 Sleep。
struct HeldEvents {
    _events: mpsc::UnboundedSender<P2pEvent>,
}

impl P2pControl for HeldEvents {
    fn handle_signal(&self, _msg: &Value) {}
    fn active(&self) -> bool {
        false
    }
    fn close(&self) {}
}

fn holding_factory() -> P2pFactory {
    Arc::new(|_opts: P2pOptions, events: mpsc::UnboundedSender<P2pEvent>| {
        Box::new(HeldEvents { _events: events }) as Box<dyn P2pControl>
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_does_not_spin_when_p2p_and_first_frame_timers_are_done() {
    // ① p2p=None：old 代码里 p2p_tx 被丢掉，recv() 每次都立刻回 None。
    let (agent, accepted) = fake_agent("none", None).await;
    let ws = support::FakeWs::new();
    let (_input_tx, input_rx) = mpsc::unbounded_channel::<Incoming>();
    let opts = H264Options {
        socket_path: Some(agent.path.clone()),
        first_frame_timeout: Duration::from_secs(30),
        key_request_interval: Duration::from_millis(20),
        p2p: None,
        ..Default::default()
    };
    let task = tokio::spawn(run(ws.clone(), input_rx, opts, Arc::new(Registry::new())));
    accepted.await.unwrap();

    let before = cpu_ms();
    tokio::time::sleep(Duration::from_millis(350)).await;
    let used = cpu_ms() - before;
    assert!(used < 100.0, "p2p=None 时 run 在忙轮询：350ms 烧了 {used:.1}ms CPU");
    assert!(!task.is_finished(), "不该自己退出");

    // Agent 断开 → 读端 EOF → 桥关闭 WS、任务干净收尾。
    agent.release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("Agent 断开后 run 应当退出")
        .unwrap();
    agent.task.await.unwrap();
    let closed = ws.close_reason().expect("Agent 断开应关闭 WS");
    assert_eq!((closed.0, closed.1.as_str()), (1011, "h264-unavailable"));

    // ② p2p 通道活着（recv pending），先用一帧把 saw_frame 置真；首帧超时 Sleep
    //    一到点就永远 ready —— 谁忘了把它从 select 里摘掉，这里就会烧满 CPU。
    let frame = support::frame(T_KEY, b"\x00\x00\x00\x01kp");
    let (agent, accepted) = fake_agent("frame", Some(frame)).await;
    let ws = support::FakeWs::new();
    let (_input_tx, input_rx) = mpsc::unbounded_channel::<Incoming>();
    let opts = H264Options {
        socket_path: Some(agent.path.clone()),
        first_frame_timeout: Duration::from_millis(80),
        key_request_interval: Duration::from_millis(20),
        p2p: Some(holding_factory()),
        ..Default::default()
    };
    let task = tokio::spawn(run(ws.clone(), input_rx, opts, Arc::new(Registry::new())));
    accepted.await.unwrap();
    // 等帧真的过桥（首帧 → saw_frame=true，超时到点后不再关闭）。
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while ws.frames().is_empty() && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(ws.frames().len(), 1);

    let before = cpu_ms();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let used = cpu_ms() - before;
    assert!(used < 120.0, "首帧超时 Sleep 到期后 run 在忙轮询：400ms 烧了 {used:.1}ms CPU");
    assert!(!task.is_finished(), "出过帧就不该被首帧超时关掉");

    agent.release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("Agent 断开后 run 应当退出")
        .unwrap();
    agent.task.await.unwrap();
    assert!(ws.close_reason().is_some());
}
