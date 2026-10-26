//! WS 出口：桥只依赖 `WsOut`，真实现是一对写/读任务。
//!
//! 积压量的定义（docs/remote-screen-process.md §4.4）：**已经交给写端、还没写进
//! socket 的字节数**。丢帧、补关键帧的水位都按它算 —— 只看内核发送缓冲会漏掉
//! 自己队列里的几 MB，慢链路上帧只排队不丢，画面越拖越旧。

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use bytes::Bytes;
use futures_util::future::BoxFuture;
use futures_util::{Sink, SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot, Notify};

pub trait WsOut: Send + Sync {
    /// 已交给写端、尚未写进 socket 的字节数。
    fn buffered(&self) -> usize;
    /// 入队就返回（H.264 的帧走这条：Dropping 由 buffered() 决定）。
    fn try_send(&self, data: Bytes) -> bool;
    /// 入队并等写进 socket（RFB 是字节流，读端要跟着写完成暂停）。
    fn send(&self, data: Bytes) -> BoxFuture<'static, bool>;
    fn send_text(&self, text: String) -> bool;
    fn close(&self, code: u16, reason: &str);
    fn is_open(&self) -> bool;
}

/// 客户端 → 桥的消息。RFB 桥把文本当字节透传，H.264 桥只把文本当信令。
#[derive(Debug, Clone)]
pub enum Incoming {
    Bin(Bytes),
    Text(String),
}

enum OutMsg {
    Bin(Bytes),
    Text(String),
    Ack(Bytes, oneshot::Sender<bool>),
}

#[derive(Default)]
struct CloseState {
    reason: Mutex<Option<(u16, String)>>,
    notify: Notify,
}

pub struct WsChannel {
    tx: mpsc::UnboundedSender<OutMsg>,
    queued: Arc<AtomicUsize>,
    open: Arc<AtomicBool>,
    close: Arc<CloseState>,
}

/// 把升级后的 WS 拆成写任务 + 读任务，返回出口与「客户端消息」的接收端。
pub fn spawn(socket: WebSocket) -> (Arc<WsChannel>, mpsc::UnboundedReceiver<Incoming>) {
    let (sink, stream) = socket.split();
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Incoming>();
    spawn_reader(stream, in_tx);
    let (tx, rx) = mpsc::unbounded_channel::<OutMsg>();
    let queued = Arc::new(AtomicUsize::new(0));
    let open = Arc::new(AtomicBool::new(true));
    let close = Arc::new(CloseState::default());
    let task_queued = queued.clone();
    let task_open = open.clone();
    let task_close = close.clone();
    tokio::spawn(write_loop(sink, rx, task_queued, task_open, task_close));
    (Arc::new(WsChannel { tx, queued, open, close }), in_rx)
}

/// 写任务主体。抽成泛型是为了单测能塞假 sink 真跑并发 —— 真的 `WebSocket` 在
/// 测试里造不出来，而「先 send 后记账」的回绕只在高并发下才暴露。
async fn write_loop<S>(mut sink: S, mut rx: mpsc::UnboundedReceiver<OutMsg>, task_queued: Arc<AtomicUsize>, task_open: Arc<AtomicBool>, task_close: Arc<CloseState>)
where
    S: Sink<Message> + Unpin,
{
    loop {
        tokio::select! {
            biased;
            _ = task_close.notify.notified() => {
                let reason = task_close.reason.lock().unwrap().take();
                task_open.store(false, Ordering::SeqCst);
                if let Some((code, text)) = reason {
                    let frame = CloseFrame { code, reason: text.into() };
                    let _ = sink.send(Message::Close(Some(frame))).await;
                }
                break;
            }
            message = rx.recv() => {
                let Some(message) = message else { break };
                let result = match message {
                    OutMsg::Bin(data) => {
                        let len = data.len();
                        let sent = sink.send(Message::Binary(data)).await.is_ok();
                        sub_queued(&task_queued, len);
                        sent
                    }
                    OutMsg::Text(text) => {
                        let len = text.len();
                        let sent = sink.send(Message::Text(text.into())).await.is_ok();
                        sub_queued(&task_queued, len);
                        sent
                    }
                    OutMsg::Ack(data, ack) => {
                        let len = data.len();
                        let sent = sink.send(Message::Binary(data)).await;
                        sub_queued(&task_queued, len);
                        let ok = sent.is_ok();
                        let _ = ack.send(ok);
                        ok
                    }
                };
                if !result {
                    task_open.store(false, Ordering::SeqCst);
                    break;
                }
            }
        }
    }
    task_open.store(false, Ordering::SeqCst);
    task_queued.store(0, Ordering::SeqCst);
}

/// 读任务：断连时发送端被丢弃，桥收到 `None` 即「客户端关了」。
pub fn spawn_reader(mut stream: futures_util::stream::SplitStream<WebSocket>, tx: mpsc::UnboundedSender<Incoming>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(message) = stream.next().await {
            let mapped = match message {
                Ok(Message::Binary(data)) => Incoming::Bin(data),
                Ok(Message::Text(text)) => Incoming::Text(text.to_string()),
                Ok(Message::Close(_)) | Err(_) => break,
                // Ping/Pong 由 tungstenite 在轮询时自动处理，这里没有要给桥的东西。
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => continue,
            };
            if tx.send(mapped).is_err() {
                break;
            }
        }
    })
}

/// 入队与记账的顺序：**先加字节数，再交给写端**。
///
/// 反过来写（先 send 后 fetch_add）会输给写端：消息一进队列，写任务可能抢在
/// 这里 fetch_add 之前就写进 socket 并 fetch_sub —— 从 0 减出 usize::MAX。
/// 之后 buffered() 永远是天文数字，普通帧全被判为积压丢掉，画面黑且不自愈。
fn enqueue(queued: &AtomicUsize, tx: &mpsc::UnboundedSender<OutMsg>, message: OutMsg, len: usize) -> bool {
    queued.fetch_add(len, Ordering::SeqCst);
    if tx.send(message).is_err() {
        // 写端已经退出：撤回这次记账，别把字节数白留在账上。
        sub_queued(queued, len);
        return false;
    }
    true
}

/// 写端只减自己那条消息的字节数。按入队顺序这本该永远不会多减，但 AtomicUsize
/// 一旦下溢就是回绕成 usize::MAX（见 `enqueue` 的注释），宁可少报也不能回绕。
fn sub_queued(queued: &AtomicUsize, len: usize) {
    let _ = queued.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
        Some(value.saturating_sub(len))
    });
}

impl WsOut for WsChannel {
    fn buffered(&self) -> usize {
        self.queued.load(Ordering::SeqCst)
    }

    fn try_send(&self, data: Bytes) -> bool {
        if !self.is_open() {
            return false;
        }
        let len = data.len();
        enqueue(&self.queued, &self.tx, OutMsg::Bin(data), len)
    }

    fn send(&self, data: Bytes) -> BoxFuture<'static, bool> {
        if !self.is_open() {
            return Box::pin(async { false });
        }
        let len = data.len();
        let (ack_tx, ack_rx) = oneshot::channel();
        if !enqueue(&self.queued, &self.tx, OutMsg::Ack(data, ack_tx), len) {
            return Box::pin(async { false });
        }
        Box::pin(async move { ack_rx.await.unwrap_or(false) })
    }

    fn send_text(&self, text: String) -> bool {
        if !self.is_open() {
            return false;
        }
        let len = text.len();
        enqueue(&self.queued, &self.tx, OutMsg::Text(text), len)
    }

    fn close(&self, code: u16, reason: &str) {
        if self.close.reason.lock().unwrap().is_none() {
            *self.close.reason.lock().unwrap() = Some((code, reason.to_string()));
            self.open.store(false, Ordering::SeqCst);
            self.close.notify.notify_one();
        }
    }

    fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::{Duration, Instant};

    /// 假 sink：每条消息都 `yield_now()`，把写端和发送端强行交错，暴露记账顺序问题。
    struct CountingSink {
        sent: Arc<AtomicUsize>,
    }

    impl Sink<Message> for CountingSink {
        type Error = std::io::Error;

        fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(self: Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
            std::thread::yield_now();
            self.sent.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    #[test]
    fn queued_subtraction_saturates_instead_of_wrapping() {
        let queued = AtomicUsize::new(0);
        sub_queued(&queued, 5);
        assert_eq!(queued.load(Ordering::SeqCst), 0);
        queued.store(3, Ordering::SeqCst);
        sub_queued(&queued, 5);
        assert_eq!(queued.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn failed_enqueue_rolls_back_the_byte_count() {
        let (tx, rx) = mpsc::unbounded_channel();
        drop(rx);
        let queued = AtomicUsize::new(0);
        assert!(!enqueue(&queued, &tx, OutMsg::Bin(Bytes::from_static(b"abcd")), 4));
        assert_eq!(queued.load(Ordering::SeqCst), 0);
    }

    /// 多线程 + 真写任务压测：积压量必须始终 ≤ 已入队总字节，并且最终回落到 0。
    /// 旧实现（先 send 后 fetch_add）在这里会从 0 减出 usize::MAX，再也回不来。
    #[test]
    fn queued_bytes_stay_bounded_and_return_to_zero_under_concurrent_writer() {
        const THREADS: usize = 4;
        const PER: usize = 2000;
        const LEN: usize = 8;
        const TOTAL: usize = THREADS * PER * LEN;

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (tx, rx) = mpsc::unbounded_channel();
            let queued = Arc::new(AtomicUsize::new(0));
            let open = Arc::new(AtomicBool::new(true));
            let close = Arc::new(CloseState::default());
            let ws = Arc::new(WsChannel {
                tx,
                queued: queued.clone(),
                open: open.clone(),
                close: close.clone(),
            });
            let sent = Arc::new(AtomicUsize::new(0));
            tokio::spawn(write_loop(
                CountingSink { sent: sent.clone() },
                rx,
                queued.clone(),
                open,
                close,
            ));

            let mut handles = Vec::new();
            for _ in 0..THREADS {
                let ws = ws.clone();
                handles.push(std::thread::spawn(move || {
                    for _ in 0..PER {
                        assert!(ws.try_send(Bytes::from_static(b"12345678")));
                        // 回绕后的值会是一个天文数字，立刻在这里露馅。
                        assert!(ws.buffered() <= TOTAL, "queued bytes blew past the enqueued total");
                    }
                }));
            }
            for handle in handles {
                handle.join().unwrap();
            }

            let deadline = Instant::now() + Duration::from_secs(5);
            while queued.load(Ordering::SeqCst) != 0 && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(queued.load(Ordering::SeqCst), 0);
            assert_eq!(sent.load(Ordering::SeqCst), THREADS * PER);
        });
    }
}
