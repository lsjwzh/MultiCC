//! The front door's end of the chat bridge (frame grammar:
//! `multicc_core::chat_bridge`).
//!
//! The front door owns every `/ws/chat` client socket. The chat engine still
//! runs in the Node child, so for each client socket the engine is handed a
//! virtual socket over one private loopback stream: the child connects out
//! with the per-generation capability (the same mutual proof the
//! authentication control stream uses), then both sides exchange the frames of
//! `chat_bridge`. One stream carries every connection, multiplexed by id.
//!
//! Ownership rules this module enforces:
//! - There is at most one live stream per Node generation. A new generation (a
//!   Node restart) or the loss of the stream ends every client socket it
//!   carried, abruptly and without a close frame: that is what a dead Node
//!   used to look like to a client when the socket was a raw splice.
//! - Frames from Node for an id that no longer exists are dropped, except a
//!   `Send`, which is answered with a failed `Sent` so the sender's callback
//!   still resolves.
//! - Frames towards Node go through one bounded queue. A client that floods
//!   messages therefore stops being read once the queue is full, which puts
//!   the pressure back on its TCP connection instead of growing memory here.
use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use multicc_core::auth_control as wire;
use multicc_core::auth_security;
use multicc_core::chat_bridge::{frame, OpenInfo, ToGateway, ToNode, MAX_BODY};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// Frames queued towards Node before the readers of client sockets wait.
const TO_NODE_QUEUE: usize = 1024;

/// What Node asked the front door to do with one client socket.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Send {
        seq: u32,
        binary: bool,
        data: Vec<u8>,
    },
    Close {
        code: Option<u16>,
        reason: String,
    },
    Terminate,
    Ping,
}

struct Active {
    to_node: mpsc::Sender<Vec<u8>>,
    conns: Mutex<HashMap<u32, mpsc::UnboundedSender<Command>>>,
}

#[derive(Default)]
pub struct ChatBridge {
    generation: AtomicU64,
    next_conn: AtomicU32,
    active: Mutex<Option<Arc<Active>>>,
}

pub struct Registration {
    pub port: u16,
    pub capability: String,
    task: JoinHandle<()>,
    generation: u64,
    bridge: Arc<ChatBridge>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.task.abort();
        self.bridge.retire(self.generation);
    }
}

/// The cloneable half of a client socket's side of the bridge: what the tasks
/// that read and write the socket use to report to Node.
#[derive(Clone)]
pub struct Link {
    pub conn: u32,
    active: Arc<Active>,
}

/// One client socket's side of the bridge. Dropping it forgets the id.
pub struct Session {
    pub conn: u32,
    pub commands: mpsc::UnboundedReceiver<Command>,
    link: Link,
}

impl Session {
    pub fn link(&self) -> Link {
        self.link.clone()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.link
            .active
            .conns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.conn);
    }
}

/// The Node stream this socket was attached to has ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BridgeGone;

impl Link {
    async fn push(&self, frame_body: ToNode) -> Result<(), BridgeGone> {
        self.active
            .to_node
            .send(frame(&frame_body.encode()))
            .await
            .map_err(|_| BridgeGone)
    }
    pub async fn message(&self, binary: bool, data: Vec<u8>) -> Result<(), BridgeGone> {
        self.push(ToNode::Message {
            conn: self.conn,
            binary,
            data,
        })
        .await
    }
    pub async fn pong(&self) -> Result<(), BridgeGone> {
        self.push(ToNode::Pong { conn: self.conn }).await
    }
    pub async fn sent(&self, seq: u32, error: Option<String>) -> Result<(), BridgeGone> {
        self.push(ToNode::Sent {
            conn: self.conn,
            seq,
            error,
        })
        .await
    }
    /// The final frame for this id.
    pub async fn closed(
        &self,
        code: u16,
        received: bool,
        sent: bool,
        reason: String,
    ) -> Result<(), BridgeGone> {
        self.push(ToNode::Closed {
            conn: self.conn,
            code,
            received,
            sent,
            reason,
        })
        .await
    }
}

impl ChatBridge {
    /// Whether a Node generation currently has a live stream.
    pub fn connected(&self) -> bool {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// Registers a client socket and tells Node about it. `None` when no Node
    /// stream is live.
    pub async fn attach(&self, info: OpenInfo) -> Option<Session> {
        let active = self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()?;
        let conn = self.next_conn.fetch_add(1, Ordering::SeqCst);
        let (commands_tx, commands) = mpsc::unbounded_channel();
        active
            .conns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(conn, commands_tx);
        let session = Session {
            conn,
            commands,
            link: Link { conn, active },
        };
        session
            .link
            .push(ToNode::Open { conn, info })
            .await
            .ok()
            .map(|_| session)
    }

    /// Starts a new generation: binds a loopback listener and returns the port
    /// and capability the child must be handed. Any stream of the previous
    /// generation is ended.
    pub fn open(self: &Arc<Self>) -> io::Result<Registration> {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.end_active();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        listener.set_nonblocking(true)?;
        let listener = TcpListener::from_std(listener)?;
        let capability = auth_security::random_base64url(32).map_err(|_| io::ErrorKind::Other)?;
        let key = capability.clone();
        let bridge = Arc::clone(self);
        let task = tokio::spawn(async move {
            let mut pending = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break; };
                        if pending.len() >= 16 { continue; }
                        let key = key.clone();
                        let bridge = Arc::clone(&bridge);
                        pending.spawn(async move {
                            let mut stream = stream;
                            let _ = stream.set_nodelay(true);
                            let proven = tokio::time::timeout(
                                wire::TIMEOUT,
                                wire::accept(&mut stream, &key),
                            ).await;
                            if matches!(proven, Ok(Ok(()))) {
                                bridge.run(stream, generation);
                            }
                        });
                    }
                    _ = pending.join_next(), if !pending.is_empty() => {}
                }
            }
        });
        Ok(Registration {
            port,
            capability,
            task,
            generation,
            bridge: Arc::clone(self),
        })
    }

    fn end_active(&self) {
        // Dropping the map's senders ends every client task; dropping the
        // `to_node` sender stops the writer task.
        let previous = self.active.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(previous) = previous {
            previous
                .conns
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
        }
    }

    fn retire(&self, generation: u64) {
        if self.generation.load(Ordering::SeqCst) == generation {
            self.generation.fetch_add(1, Ordering::SeqCst);
            self.end_active();
        }
    }

    /// Installs an authenticated stream as the live one and pumps it until it
    /// ends. A stream that is not of the current generation is refused.
    fn run(self: &Arc<Self>, stream: TcpStream, generation: u64) {
        let (to_node, mut from_clients) = mpsc::channel::<Vec<u8>>(TO_NODE_QUEUE);
        let active = Arc::new(Active {
            to_node,
            conns: Mutex::new(HashMap::new()),
        });
        {
            let mut slot = self.active.lock().unwrap_or_else(|e| e.into_inner());
            if self.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            // A second stream of the same generation replaces the first: the
            // child reconnected, and the old stream's sockets belong to a
            // state the child no longer has.
            if let Some(old) = slot.replace(Arc::clone(&active)) {
                old.conns.lock().unwrap_or_else(|e| e.into_inner()).clear();
            }
        }
        let (mut reader, mut writer) = stream.into_split();
        tokio::spawn(async move {
            while let Some(bytes) = from_clients.recv().await {
                if writer.write_all(&bytes).await.is_err() {
                    break;
                }
            }
            let _ = writer.shutdown().await;
        });
        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            let result = read_loop(&mut reader, &active).await;
            let _ = result;
            // The stream is over: forget it if it is still the live one and
            // end every client socket it carried.
            let mut slot = bridge.active.lock().unwrap_or_else(|e| e.into_inner());
            if slot
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &active))
            {
                slot.take();
            }
            drop(slot);
            active
                .conns
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
        });
    }
}

async fn read_loop(
    reader: &mut tokio::net::tcp::OwnedReadHalf,
    active: &Arc<Active>,
) -> io::Result<()> {
    loop {
        let size = reader.read_u32().await? as usize;
        if size == 0 || size > MAX_BODY {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut body = vec![0u8; size];
        reader.read_exact(&mut body).await?;
        let decoded = ToGateway::decode(&body).map_err(|_| io::ErrorKind::InvalidData)?;
        let conn = decoded.conn();
        let target = active
            .conns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&conn)
            .cloned();
        let command = match decoded {
            ToGateway::Send {
                seq, binary, data, ..
            } => Command::Send { seq, binary, data },
            ToGateway::Close { code, reason, .. } => Command::Close { code, reason },
            ToGateway::Terminate { .. } => Command::Terminate,
            ToGateway::Ping { .. } => Command::Ping,
        };
        match target {
            Some(sender) => {
                let _ = sender.send(command);
            }
            None => {
                // The id is gone. A Send still owes its callback a completion.
                if let Command::Send { seq, .. } = command {
                    let body = ToNode::Sent {
                        conn,
                        seq,
                        error: Some("socket is closed".into()),
                    }
                    .encode();
                    if active.to_node.send(frame(&body)).await.is_err() {
                        return Ok(());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn info(url: &str) -> OpenInfo {
        OpenInfo {
            url: url.into(),
            headers: vec![("host".into(), "x".into())],
            remote_address: "203.0.113.9".into(),
            remote_port: 4000,
            local_address: "127.0.0.1".into(),
            local_port: 8080,
        }
    }

    /// A scripted stand-in for the Node child.
    struct FakeNode(TcpStream);

    impl FakeNode {
        async fn connect(registration: &Registration) -> FakeNode {
            let mut stream = TcpStream::connect(("127.0.0.1", registration.port))
                .await
                .unwrap();
            wire::connect(&mut stream, &registration.capability)
                .await
                .unwrap();
            FakeNode(stream)
        }
        async fn read(&mut self) -> ToNode {
            let size = self.0.read_u32().await.unwrap() as usize;
            let mut body = vec![0; size];
            self.0.read_exact(&mut body).await.unwrap();
            ToNode::decode(&body).unwrap()
        }
        async fn write(&mut self, frame_body: ToGateway) {
            self.0
                .write_all(&frame(&frame_body.encode()))
                .await
                .unwrap();
        }
    }

    async fn until_connected(bridge: &ChatBridge) {
        for _ in 0..200 {
            if bridge.connected() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the stream never became live");
    }

    #[tokio::test]
    async fn a_stream_with_the_wrong_capability_is_never_installed() {
        let bridge = Arc::new(ChatBridge::default());
        let registration = bridge.open().unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", registration.port))
            .await
            .unwrap();
        assert!(wire::connect(&mut stream, "not-the-capability")
            .await
            .is_err());
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!bridge.connected());
        assert!(bridge.attach(info("/ws/chat")).await.is_none());
    }

    #[tokio::test]
    async fn attach_announces_the_client_and_routes_commands_by_id() {
        let bridge = Arc::new(ChatBridge::default());
        let registration = bridge.open().unwrap();
        let mut node = FakeNode::connect(&registration).await;
        until_connected(&bridge).await;
        let mut first = bridge.attach(info("/ws/chat?session=a")).await.unwrap();
        let mut second = bridge.attach(info("/ws/chat?session=b")).await.unwrap();
        assert_ne!(first.conn, second.conn);
        let ToNode::Open { conn, info: seen } = node.read().await else {
            panic!("expected Open")
        };
        assert_eq!(
            (conn, seen.url.as_str()),
            (first.conn, "/ws/chat?session=a")
        );
        assert!(matches!(node.read().await, ToNode::Open { conn, .. } if conn == second.conn));

        first
            .link()
            .message(false, b"hello".to_vec())
            .await
            .unwrap();
        assert_eq!(
            node.read().await,
            ToNode::Message {
                conn: first.conn,
                binary: false,
                data: b"hello".to_vec()
            }
        );
        node.write(ToGateway::Send {
            conn: second.conn,
            seq: 7,
            binary: true,
            data: vec![1, 2],
        })
        .await;
        node.write(ToGateway::Ping { conn: first.conn }).await;
        node.write(ToGateway::Close {
            conn: first.conn,
            code: Some(4003),
            reason: "Forbidden".into(),
        })
        .await;
        assert_eq!(
            second.commands.recv().await.unwrap(),
            Command::Send {
                seq: 7,
                binary: true,
                data: vec![1, 2]
            }
        );
        assert_eq!(first.commands.recv().await.unwrap(), Command::Ping);
        assert_eq!(
            first.commands.recv().await.unwrap(),
            Command::Close {
                code: Some(4003),
                reason: "Forbidden".into()
            }
        );
    }

    #[tokio::test]
    async fn a_send_for_a_forgotten_id_still_completes_with_an_error() {
        let bridge = Arc::new(ChatBridge::default());
        let registration = bridge.open().unwrap();
        let mut node = FakeNode::connect(&registration).await;
        until_connected(&bridge).await;
        let gone = bridge.attach(info("/ws/chat")).await.unwrap();
        let id = gone.conn;
        let _ = node.read().await;
        drop(gone);
        node.write(ToGateway::Send {
            conn: id,
            seq: 3,
            binary: false,
            data: b"late".to_vec(),
        })
        .await;
        // Other frames for the forgotten id are dropped without a reply.
        node.write(ToGateway::Ping { conn: id }).await;
        assert_eq!(
            node.read().await,
            ToNode::Sent {
                conn: id,
                seq: 3,
                error: Some("socket is closed".into())
            }
        );
    }

    #[tokio::test]
    async fn losing_the_stream_ends_every_client_without_a_close_frame() {
        let bridge = Arc::new(ChatBridge::default());
        let registration = bridge.open().unwrap();
        let mut node = FakeNode::connect(&registration).await;
        until_connected(&bridge).await;
        let mut session = bridge.attach(info("/ws/chat")).await.unwrap();
        let _ = node.read().await;
        drop(node);
        assert!(session.commands.recv().await.is_none());
        for _ in 0..100 {
            if !bridge.connected() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!bridge.connected());
        assert!(bridge.attach(info("/ws/chat")).await.is_none());
    }

    #[tokio::test]
    async fn a_new_generation_ends_the_previous_generations_clients() {
        let bridge = Arc::new(ChatBridge::default());
        let first = bridge.open().unwrap();
        let mut node = FakeNode::connect(&first).await;
        until_connected(&bridge).await;
        let mut session = bridge.attach(info("/ws/chat")).await.unwrap();
        let _ = node.read().await;
        let second = bridge.open().unwrap();
        assert!(session.commands.recv().await.is_none());
        assert!(!bridge.connected());
        // The stale registration cannot take the new generation down when it
        // is finally dropped.
        let mut replacement = FakeNode::connect(&second).await;
        until_connected(&bridge).await;
        drop(first);
        assert!(bridge.connected());
        let live = bridge.attach(info("/ws/chat")).await.unwrap();
        assert!(matches!(replacement.read().await, ToNode::Open { conn, .. } if conn == live.conn));
    }

    #[tokio::test]
    async fn a_malformed_frame_from_node_ends_the_bridge() {
        let bridge = Arc::new(ChatBridge::default());
        let registration = bridge.open().unwrap();
        let mut node = FakeNode::connect(&registration).await;
        until_connected(&bridge).await;
        let mut session = bridge.attach(info("/ws/chat")).await.unwrap();
        let _ = node.read().await;
        // Kind 0x7f is not in the grammar.
        node.0.write_all(&frame(&[0x7f, 0, 0, 0, 1])).await.unwrap();
        assert!(session.commands.recv().await.is_none());
        // A zero length prefix is not a frame either.
        let mut again = FakeNode::connect(&registration).await;
        until_connected(&bridge).await;
        let mut other = bridge.attach(info("/ws/chat")).await.unwrap();
        let _ = again.read().await;
        again.0.write_all(&0u32.to_be_bytes()).await.unwrap();
        assert!(other.commands.recv().await.is_none());
    }
}
