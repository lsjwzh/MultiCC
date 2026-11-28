//! One authenticated stream per Node generation. Unavailable/expired streams
//! fail closed; no env-file guesses or replay of an ambiguous ticket issue.
use multicc_core::{
    auth_control as wire,
    auth_runtime::{AuthRuntime, Request, Response, Snapshot},
    auth_security,
};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    io,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{Mutex as AsyncMutex, Semaphore},
    task::JoinHandle,
};

struct Client {
    generation: u64,
    stream: AsyncMutex<Option<TcpStream>>,
    capacity: Semaphore,
}
impl Client {
    async fn request<Q: Serialize, R: DeserializeOwned>(
        &self,
        request: &Q,
        chunks: bool,
    ) -> io::Result<R> {
        let _capacity = self
            .capacity
            .try_acquire()
            .map_err(|_| io::ErrorKind::WouldBlock)?;
        tokio::time::timeout(wire::TIMEOUT, async {
            let mut holder = self.stream.lock().await;
            // A cancelled/failed RPC drops its stream, preventing a later caller
            // from reading a previous request's reply as its own.
            let mut stream = holder.take().ok_or(io::ErrorKind::NotConnected)?;
            if chunks {
                wire::write_chunks(&mut stream, request).await?;
            } else {
                wire::write(&mut stream, request).await?;
            }
            let response = if chunks {
                wire::read_chunks(&mut stream).await?
            } else {
                wire::read(&mut stream).await?
            };
            *holder = Some(stream);
            Ok(response)
        })
        .await
        .map_err(|_| io::ErrorKind::TimedOut)?
    }
}

#[derive(Default)]
pub struct Bridge {
    client: Mutex<Option<Arc<Client>>>,
    generation: AtomicU64,
    active_capability: Mutex<Option<String>>,
    /// `--no-node`: this process owns the authentication runtime itself
    /// (access token, shutdown flag, revision and WS tickets). It is never
    /// installed while a Node child exists: two owners could mint tickets
    /// from different revisions or disagree about the shutdown flag.
    local: Mutex<Option<AuthRuntime>>,
}
impl Bridge {
    /// Takes ownership of the authentication runtime for `--no-node`.
    ///
    /// Fails closed: an empty or oversized token installs nothing, so the
    /// bridge keeps the "no owner" behaviour (the caller answers 503
    /// `node_runtime_absent`). Never call this in `--node` mode.
    pub fn install_local(&self, secret: String) -> Result<(), &'static str> {
        if secret.is_empty() {
            return Err("ACCESS_TOKEN is empty");
        }
        AuthRuntime::validate_secret(&secret)?;
        *self.local.lock().unwrap_or_else(|e| e.into_inner()) = Some(AuthRuntime::new(secret));
        Ok(())
    }
    /// Whether this process holds the authentication runtime itself.
    pub fn has_local(&self) -> bool {
        self.local
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }
    /// Constant-time verification of the active Node child's loopback capability.
    pub fn verify_capability(&self, candidate: &str) -> bool {
        if candidate.is_empty() {
            return false;
        }
        let guard = self
            .active_capability
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        guard
            .as_deref()
            .is_some_and(|expected| auth_security::timing_safe_equal_text(expected, candidate))
    }
    /// Installs a deterministic loopback capability for gateway integration tests.
    pub fn set_internal_capability(&self, capability: Option<String>) {
        *self
            .active_capability
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = capability;
    }
    /// `--no-node` stop: publish `shutting_down` so in-flight requests that
    /// need a snapshot answer 503 `SERVER_SHUTTING_DOWN` before the process
    /// exits. Returns false in `--node` mode, where Node owns the flag.
    pub fn begin_shutdown(&self) -> bool {
        match self
            .local
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            Some(state) => {
                state.shutting_down = true;
                true
            }
            None => false,
        }
    }
    pub async fn request(&self, request: Request) -> io::Result<Response> {
        {
            let mut local = self.local.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(state) = local.as_mut() {
                return Ok(state.respond(request));
            }
        }
        self.exchange(&request, false).await
    }
    pub async fn workspace(
        &self,
        request: &multicc_core::workspace_sharing::control::Request,
    ) -> io::Result<String> {
        self.exchange(request, true).await
    }
    async fn exchange<Q: Serialize, R: DeserializeOwned>(
        &self,
        request: &Q,
        chunks: bool,
    ) -> io::Result<R> {
        let client = tokio::time::timeout(wire::TIMEOUT, async {
            loop {
                if let Some(client) = self
                    .client
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone()
                {
                    break client;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| io::ErrorKind::TimedOut)?;
        let generation = client.generation;
        let result = client.request(request, chunks).await;
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err(io::ErrorKind::NotConnected.into());
        }
        if result
            .as_ref()
            .err()
            .is_some_and(|e| e.kind() != io::ErrorKind::WouldBlock)
        {
            let mut current = self.client.lock().unwrap_or_else(|e| e.into_inner());
            if current.as_ref().is_some_and(|c| Arc::ptr_eq(c, &client)) {
                *current = None;
            }
        }
        result
    }
    pub async fn snapshot(&self) -> io::Result<Snapshot> {
        match self.request(Request::Snapshot).await? {
            Response::Snapshot(value) => Ok(value),
            _ => Err(io::ErrorKind::InvalidData.into()),
        }
    }
    pub fn open(self: &Arc<Self>) -> io::Result<Registration> {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *self.client.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        listener.set_nonblocking(true)?;
        let listener = TcpListener::from_std(listener)?;
        let capability = auth_security::random_base64url(32).map_err(|_| io::ErrorKind::Other)?;
        *self
            .active_capability
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(capability.clone());
        let key = capability.clone();
        let bridge = Arc::clone(self);
        let task = tokio::spawn(async move {
            let mut pending = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((mut stream, _)) = accepted else { break; };
                        if pending.len() >= 16 { continue; }
                        let key = key.clone();
                        let bridge = Arc::clone(&bridge);
                        pending.spawn(async move {
                            let _ = stream.set_nodelay(true);
                            if matches!(tokio::time::timeout(wire::TIMEOUT, wire::accept(&mut stream, &key)).await, Ok(Ok(()))) {
                                let mut current = bridge.client.lock().unwrap_or_else(|e| e.into_inner());
                                if bridge.generation.load(Ordering::SeqCst) != generation { return; }
                                *current = Some(Arc::new(Client {
                                    generation,
                                    stream: AsyncMutex::new(Some(stream)), capacity: Semaphore::new(64),
                                }));
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
}

pub struct Registration {
    pub port: u16,
    pub capability: String,
    task: JoinHandle<()>,
    generation: u64,
    bridge: Arc<Bridge>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.task.abort();
        let mut current = self.bridge.client.lock().unwrap_or_else(|e| e.into_inner());
        if self.bridge.generation.load(Ordering::SeqCst) == self.generation {
            self.bridge.generation.fetch_add(1, Ordering::SeqCst);
            *current = None;
            *self
                .bridge
                .active_capability
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use multicc_core::auth_runtime::AuthRuntime;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn workspace_bulk_reply_crosses_frames_without_blocking_authentication() {
        use multicc_core::workspace_sharing::control::Request as SourceRequest;
        let source = Arc::new(Bridge::default());
        let registration = source.open().unwrap();
        let mut stream = actor(&registration).await;
        let worker = Arc::clone(&source);
        let pending = tokio::spawn(async move {
            worker
                .workspace(&SourceRequest::List {
                    id: "workspace".into(),
                })
                .await
        });
        let _: SourceRequest = wire::read_chunks(&mut stream).await.unwrap();
        // Source deliberately has not replied. Authentication must still work.
        let auth = Arc::new(Bridge::default());
        let auth_registration = auth.open().unwrap();
        let mut auth_stream = actor(&auth_registration).await;
        let peer = tokio::spawn(async move {
            let request = wire::read(&mut auth_stream).await.unwrap();
            wire::write(
                &mut auth_stream,
                &AuthRuntime::new("live".into()).respond(request),
            )
            .await
            .unwrap();
        });
        assert_eq!(auth.snapshot().await.unwrap().secret, "live");
        peer.await.unwrap();
        assert!(!pending.is_finished());
        let data = "记录😀\\ud800".repeat(wire::MAX_FRAME);
        wire::write_chunks(&mut stream, &data).await.unwrap();
        assert_eq!(pending.await.unwrap().unwrap(), data);
    }

    #[tokio::test]
    async fn cancelled_or_truncated_bulk_reply_never_becomes_the_next_response() {
        use multicc_core::workspace_sharing::control::Request as SourceRequest;
        for cancel in [false, true] {
            let bridge = Arc::new(Bridge::default());
            let registration = bridge.open().unwrap();
            let mut stream = actor(&registration).await;
            let worker = Arc::clone(&bridge);
            let pending = tokio::spawn(async move {
                worker
                    .workspace(&SourceRequest::Revoke {
                        id: "w".into(),
                        token: "t".into(),
                    })
                    .await
            });
            let _: SourceRequest = wire::read_chunks(&mut stream).await.unwrap();
            // A syntactically complete JSON value is not a complete bulk reply
            // without the terminator. No success may be observed from it.
            stream.write_u32(4).await.unwrap();
            stream.write_all(b"\"ok\"").await.unwrap();
            if cancel {
                pending.abort();
            } else {
                drop(stream);
            }
            let result = pending.await;
            assert!(result.is_err() || result.unwrap().is_err());
            assert!(bridge
                .workspace(&SourceRequest::List { id: "w".into() })
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn oversized_workspace_chunk_fails_closed() {
        use multicc_core::workspace_sharing::control::Request as SourceRequest;
        let bridge = Arc::new(Bridge::default());
        let registration = bridge.open().unwrap();
        let mut stream = actor(&registration).await;
        let peer = tokio::spawn(async move {
            let _: SourceRequest = wire::read_chunks(&mut stream).await.unwrap();
            stream
                .write_u32((wire::MAX_FRAME + 1) as u32)
                .await
                .unwrap();
        });
        assert!(bridge
            .workspace(&SourceRequest::List { id: "w".into() })
            .await
            .is_err());
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn a_local_runtime_answers_snapshots_without_a_node_stream() {
        let bridge = Arc::new(Bridge::default());
        assert!(!bridge.has_local(), "--node has no local owner");
        bridge.install_local("local-token".into()).unwrap();
        assert!(bridge.has_local());
        let snapshot = bridge.snapshot().await.unwrap();
        assert_eq!(snapshot.secret, "local-token");
        assert_eq!(snapshot.revision, 0);
        assert!(!snapshot.shutting_down);
        // Concurrent snapshots serialize on the local mutex: no stream, no
        // deadlock, and every answer carries the same credential.
        let (first, second, third) =
            tokio::join!(bridge.snapshot(), bridge.snapshot(), bridge.snapshot());
        for snapshot in [first, second, third] {
            assert_eq!(snapshot.unwrap().secret, "local-token");
        }
    }

    #[tokio::test]
    async fn a_local_runtime_fails_closed_on_a_missing_or_oversized_token() {
        let bridge = Bridge::default();
        assert!(bridge.install_local(String::new()).is_err());
        assert!(!bridge.has_local());
        assert!(bridge.install_local("x".repeat(wire::MAX_FRAME)).is_err());
        assert!(!bridge.has_local());
        // No owner: the request still goes to the (absent) Node stream and
        // fails instead of being answered by a default credential.
        assert!(bridge.snapshot().await.is_err());
    }

    #[tokio::test]
    async fn local_tickets_follow_revision_path_and_metadata_rules() {
        let bridge = Bridge::default();
        bridge.install_local("token".into()).unwrap();
        let issue = |revision: u64, path: &str, metadata: serde_json::Value| Request::IssueTicket {
            revision,
            path: path.into(),
            metadata,
        };
        let Response::Ticket {
            ticket,
            path,
            expires_at,
        } = bridge
            .request(issue(0, "/ws/test", serde_json::json!({"requestId": "r"})))
            .await
            .unwrap()
        else {
            panic!("a fresh revision must mint a ticket")
        };
        assert_eq!(ticket.len(), 32);
        assert_eq!(path, "/ws/test");
        assert!(expires_at > 0.0);
        // A rotated revision is stale, an off-origin path and a non-object
        // metadata are invalid, and neither mints anything.
        assert!(matches!(
            bridge
                .request(issue(1, "/ws/test", serde_json::json!({})))
                .await
                .unwrap(),
            Response::Stale
        ));
        assert!(matches!(
            bridge
                .request(issue(0, "http://elsewhere.test/ws", serde_json::json!({})))
                .await
                .unwrap(),
            Response::Invalid
        ));
        assert!(matches!(
            bridge
                .request(issue(
                    0,
                    "/ws/test",
                    serde_json::json!(["not", "an", "object"])
                ))
                .await
                .unwrap(),
            Response::Invalid
        ));
    }

    #[tokio::test]
    async fn local_shutdown_marks_the_snapshot_and_refuses_new_tickets() {
        let bridge = Bridge::default();
        bridge.install_local("token".into()).unwrap();
        assert!(!bridge.snapshot().await.unwrap().shutting_down);
        assert!(bridge.begin_shutdown());
        assert!(bridge.snapshot().await.unwrap().shutting_down);
        assert!(matches!(
            bridge
                .request(Request::IssueTicket {
                    revision: 0,
                    path: "/ws/test".into(),
                    metadata: serde_json::json!({}),
                })
                .await
                .unwrap(),
            Response::Stale
        ));
        // `--node`: the flag belongs to the child, so this is a no-op.
        assert!(!Bridge::default().begin_shutdown());
    }

    async fn actor(registration: &Registration) -> TcpStream {
        let mut stream = TcpStream::connect(("127.0.0.1", registration.port))
            .await
            .unwrap();
        wire::connect(&mut stream, &registration.capability)
            .await
            .unwrap();
        stream
    }

    #[tokio::test]
    async fn redemption_uses_the_same_owner_across_the_control_stream() {
        let bridge = Arc::new(Bridge::default());
        let registration = bridge.open().unwrap();
        let mut stream = actor(&registration).await;
        let peer = tokio::spawn(async move {
            let mut state = AuthRuntime::new("token".into());
            for _ in 0..3 {
                let request = wire::read(&mut stream).await.unwrap();
                wire::write(&mut stream, &state.respond(request))
                    .await
                    .unwrap();
            }
        });
        let Response::Ticket { ticket, .. } = bridge
            .request(Request::IssueTicket {
                revision: 0,
                path: "/ws/chat".into(),
                metadata: serde_json::json!({"requestId": "r"}),
            })
            .await
            .unwrap()
        else {
            panic!("ticket refused")
        };
        let redeem = || Request::ConsumeTicket {
            ticket: ticket.clone(),
            path: "/ws/chat".into(),
        };
        let Response::Redeemed { metadata, path, .. } = bridge.request(redeem()).await.unwrap()
        else {
            panic!("ticket not redeemed")
        };
        assert_eq!(path, "/ws/chat");
        assert_eq!(metadata, serde_json::json!({"requestId": "r"}));
        assert!(matches!(
            bridge.request(redeem()).await.unwrap(),
            Response::Invalid
        ));
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn simultaneous_redemptions_have_one_winner() {
        let bridge = Arc::new(Bridge::default());
        bridge.install_local("token".into()).unwrap();
        let Response::Ticket { ticket, .. } = bridge
            .request(Request::IssueTicket {
                revision: 0,
                path: "/ws/chat".into(),
                metadata: serde_json::json!({}),
            })
            .await
            .unwrap()
        else {
            panic!("ticket refused")
        };
        let mut tasks = Vec::new();
        for _ in 0..12 {
            let bridge = Arc::clone(&bridge);
            let ticket = ticket.clone();
            tasks.push(tokio::spawn(async move {
                bridge
                    .request(Request::ConsumeTicket {
                        ticket,
                        path: "/ws/chat".into(),
                    })
                    .await
                    .unwrap()
            }));
        }
        let mut winners = 0;
        for task in tasks {
            match task.await.unwrap() {
                Response::Redeemed { .. } => winners += 1,
                Response::Invalid => {}
                _ => panic!("unexpected redemption result"),
            }
        }
        assert_eq!(winners, 1);
    }

    #[tokio::test]
    async fn forged_proof_cannot_install_an_authentication_owner() {
        let bridge = Arc::new(Bridge::default());
        let registration = bridge.open().unwrap();
        let mut rogue = TcpStream::connect(("127.0.0.1", registration.port))
            .await
            .unwrap();
        let _: String = wire::read(&mut rogue).await.unwrap();
        wire::write(&mut rogue, &"forged").await.unwrap();
        assert!(wire::read::<String>(&mut rogue).await.is_err());
        assert!(bridge.client.lock().unwrap().is_none());
        let mut stream = actor(&registration).await;
        let task = tokio::spawn(async move {
            let mut state = AuthRuntime::new("valid".into());
            let request = wire::read(&mut stream).await.unwrap();
            wire::write(&mut stream, &state.respond(request))
                .await
                .unwrap();
        });
        assert_eq!(bridge.snapshot().await.unwrap().secret, "valid");
        task.await.unwrap();
    }

    #[tokio::test]
    async fn a_cancelled_rpc_closes_its_stream_and_cannot_shift_responses() {
        let bridge = Arc::new(Bridge::default());
        let registration = bridge.open().unwrap();
        let mut stream = actor(&registration).await;
        let worker = Arc::clone(&bridge);
        let pending = tokio::spawn(async move { worker.snapshot().await });
        let _: Request = wire::read(&mut stream).await.unwrap();
        pending.abort();
        let _ = pending.await;
        assert!(wire::read::<Request>(&mut stream).await.is_err());
        assert!(bridge.snapshot().await.is_err());
    }

    #[tokio::test]
    async fn oversized_frames_fail_closed_without_allocation_or_fallback() {
        let bridge = Arc::new(Bridge::default());
        let registration = bridge.open().unwrap();
        let mut stream = actor(&registration).await;
        let peer = tokio::spawn(async move {
            let _: Request = wire::read(&mut stream).await.unwrap();
            stream
                .write_u32((wire::MAX_FRAME + 1) as u32)
                .await
                .unwrap();
        });
        assert!(bridge.snapshot().await.is_err());
        assert!(bridge.client.lock().unwrap().is_none());
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn replacing_a_child_rejects_an_inflight_old_generation_reply() {
        let bridge = Arc::new(Bridge::default());
        let registration = bridge.open().unwrap();
        let mut old = actor(&registration).await;
        let worker = Arc::clone(&bridge);
        let pending = tokio::spawn(async move { worker.snapshot().await });
        let _: Request = wire::read(&mut old).await.unwrap();
        drop(registration);
        let replacement = bridge.open().unwrap();
        wire::write(
            &mut old,
            &AuthRuntime::new("old".into()).respond(Request::Snapshot),
        )
        .await
        .unwrap();
        assert!(pending.await.unwrap().is_err());
        let mut new = actor(&replacement).await;
        let peer = tokio::spawn(async move {
            let request = wire::read(&mut new).await.unwrap();
            wire::write(&mut new, &AuthRuntime::new("new".into()).respond(request))
                .await
                .unwrap();
        });
        assert_eq!(bridge.snapshot().await.unwrap().secret, "new");
        peer.await.unwrap();
    }
}
