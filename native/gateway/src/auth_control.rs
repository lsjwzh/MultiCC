//! One authenticated stream per Node generation. Unavailable/expired streams
//! fail closed; no env-file guesses or replay of an ambiguous ticket issue.
use multicc_core::{
    auth_control as wire,
    auth_runtime::{Request, Response, Snapshot},
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
}
impl Bridge {
    pub async fn request(&self, request: Request) -> io::Result<Response> {
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
