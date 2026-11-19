//! Bounded connection registry for the future Rust WebSocket host.
//!
//! This registry is not yet wired to the public listener. A connection owns
//! its receiver and registration; dropping it removes the only published
//! sender. Queue limits are supplied by the caller, not inferred here.
use hyper::body::Bytes;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
};
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    Text(Bytes),
    Binary(Bytes),
    Close { code: u16, reason: String },
}
impl Frame {
    fn size(&self) -> usize {
        match self {
            Self::Text(bytes) | Self::Binary(bytes) => bytes.len(),
            Self::Close { reason, .. } => reason.len(),
        }
    }
}

pub struct QueuedFrame {
    pub frame: Frame,
    // The byte reservation survives until the receiver finishes with the frame.
    _reservation: OwnedSemaphorePermit,
}

#[derive(Clone)]
struct Entry {
    sender: mpsc::Sender<QueuedFrame>,
    overflow: watch::Sender<bool>,
    bytes: Arc<Semaphore>,
    limit: usize,
    session: Option<String>,
}

#[derive(Default)]
struct Entries {
    connections: HashMap<u64, Entry>,
    sessions: HashMap<String, Vec<u64>>,
}

#[derive(Default)]
pub struct Registry {
    next: AtomicU64,
    entries: Mutex<Entries>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DispatchError {
    Missing,
    Closed,
    QueueFull,
    FrameTooLarge,
}

pub type BroadcastResults = Vec<(u64, Result<(), DispatchError>)>;

pub struct Connection {
    pub id: u64,
    pub receiver: mpsc::Receiver<QueuedFrame>,
    pub overflow: watch::Receiver<bool>,
    registry: Weak<Registry>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            let mut entries = registry.entries.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(Entry {
                session: Some(session),
                ..
            }) = entries.connections.remove(&self.id)
            {
                if let Some(ids) = entries.sessions.get_mut(&session) {
                    ids.retain(|id| *id != self.id);
                    if ids.is_empty() {
                        entries.sessions.remove(&session);
                    }
                }
            }
        }
    }
}

impl Registry {
    pub fn register(self: &Arc<Self>, messages: usize, bytes: usize) -> Option<Connection> {
        self.register_inner(None, messages, bytes)
    }

    pub fn register_session(
        self: &Arc<Self>,
        session: String,
        messages: usize,
        bytes: usize,
    ) -> Option<Connection> {
        self.register_inner(Some(session), messages, bytes)
    }

    fn register_inner(
        self: &Arc<Self>,
        session: Option<String>,
        messages: usize,
        bytes: usize,
    ) -> Option<Connection> {
        if messages == 0
            || messages > Semaphore::MAX_PERMITS
            || bytes == 0
            || bytes > u32::MAX as usize
            || bytes > Semaphore::MAX_PERMITS
        {
            return None;
        }
        let id = self
            .next
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .ok()?;
        let (sender, receiver) = mpsc::channel(messages);
        let (overflow, overflow_receiver) = watch::channel(false);
        let entry = Entry {
            sender,
            overflow,
            bytes: Arc::new(Semaphore::new(bytes)),
            limit: bytes,
            session: session.clone(),
        };
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.connections.insert(id, entry);
        if let Some(session) = session {
            entries.sessions.entry(session).or_default().push(id);
        }
        Some(Connection {
            id,
            receiver,
            overflow: overflow_receiver,
            registry: Arc::downgrade(self),
        })
    }

    pub fn dispatch(&self, id: u64, frame: Frame) -> Result<(), DispatchError> {
        // Serialize direct sends with broadcasts and overflow decisions, so a
        // concurrent producer cannot enqueue after the connection is marked
        // for closure. Queue insertion itself is nonblocking.
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let entry = entries
            .connections
            .get(&id)
            .cloned()
            .ok_or(DispatchError::Missing)?;
        Self::dispatch_entry(entry, frame)
    }

    fn dispatch_entry(entry: Entry, frame: Frame) -> Result<(), DispatchError> {
        if *entry.overflow.borrow() {
            return Err(DispatchError::Closed);
        }
        let size = frame.size();
        if size > entry.limit {
            entry.overflow.send_replace(true);
            return Err(DispatchError::FrameTooLarge);
        }
        let reservation = match entry.bytes.clone().try_acquire_many_owned(size as u32) {
            Ok(reservation) => reservation,
            Err(_) => {
                entry.overflow.send_replace(true);
                return Err(DispatchError::QueueFull);
            }
        };
        entry
            .sender
            .try_send(QueuedFrame {
                frame,
                _reservation: reservation,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => {
                    entry.overflow.send_replace(true);
                    DispatchError::QueueFull
                }
                mpsc::error::TrySendError::Closed(_) => DispatchError::Closed,
            })
    }

    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .connections
            .len()
    }

    /// Fan out synchronously in registration order. Holding the registry lock
    /// across nonblocking queue inserts preserves a single event order for all
    /// recipients, even when several producers broadcast concurrently. No
    /// socket I/O or host callback executes while this lock is held.
    pub fn broadcast_from(&self, id: u64, frame: Frame) -> Result<BroadcastResults, DispatchError> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let session = entries
            .connections
            .get(&id)
            .ok_or(DispatchError::Missing)?
            .session
            .as_ref()
            .ok_or(DispatchError::Missing)?;
        Ok(Self::broadcast_locked(&entries, session, frame))
    }

    /// Deliver a backend event by its authoritative session id, even when the
    /// producer itself is not a WebSocket connection.
    pub fn broadcast_session(&self, session: &str, frame: Frame) -> BroadcastResults {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        Self::broadcast_locked(&entries, session, frame)
    }

    fn broadcast_locked(entries: &Entries, session: &str, frame: Frame) -> BroadcastResults {
        entries
            .sessions
            .get(session)
            .into_iter()
            .flatten()
            .filter_map(|target| {
                entries
                    .connections
                    .get(target)
                    .cloned()
                    .map(|entry| (*target, Self::dispatch_entry(entry, frame.clone())))
            })
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dispatch_is_isolated_bounded_and_released_on_disconnect() {
        let registry = Arc::new(Registry::default());
        let mut a = registry.register(2, 4).unwrap();
        let mut b = registry.register(2, 4).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(
            registry.dispatch(a.id, Frame::Text(Bytes::from_static(b"abcd"))),
            Ok(())
        );
        assert_eq!(
            registry.dispatch(a.id, Frame::Text(Bytes::from_static(b"x"))),
            Err(DispatchError::QueueFull)
        );
        assert_eq!(
            registry.dispatch(b.id, Frame::Binary(Bytes::from_static(b"b"))),
            Ok(())
        );
        assert_eq!(
            b.receiver.recv().await.unwrap().frame,
            Frame::Binary(Bytes::from_static(b"b"))
        );
        assert_eq!(
            registry.dispatch(b.id, Frame::Text(Bytes::from_static(b"hello"))),
            Err(DispatchError::FrameTooLarge)
        );
        let held = a.receiver.recv().await.unwrap();
        assert_eq!(held.frame, Frame::Text(Bytes::from_static(b"abcd")));
        assert_eq!(
            registry.dispatch(a.id, Frame::Text(Bytes::from_static(b"x"))),
            Err(DispatchError::Closed)
        );
        drop(held);
        assert_eq!(
            registry.dispatch(a.id, Frame::Text(Bytes::from_static(b"x"))),
            Err(DispatchError::Closed)
        );
        assert!(*a.overflow.borrow());
        assert!(*b.overflow.borrow());
        let old = a.id;
        drop(a);
        assert_eq!(
            registry.dispatch(old, Frame::Text(Bytes::new())),
            Err(DispatchError::Missing)
        );
        assert_eq!(registry.len(), 1);
        drop(b);
        assert!(registry.is_empty());
    }

    #[test]
    fn invalid_capacity_and_exhausted_ids_fail_closed() {
        let registry = Arc::new(Registry::default());
        assert!(registry.register(0, 1).is_none());
        assert!(registry.register(1, 0).is_none());
        registry.next.store(u64::MAX, Ordering::Relaxed);
        assert!(registry.register(1, 1).is_none());
        assert!(registry.is_empty());
    }

    #[tokio::test]
    async fn broadcast_is_session_scoped_and_does_not_block_healthy_clients() {
        let registry = Arc::new(Registry::default());
        let a = registry.register_session("a".into(), 1, 16).unwrap();
        let mut sibling = registry.register_session("a".into(), 1, 16).unwrap();
        let mut other = registry.register_session("b".into(), 1, 16).unwrap();
        assert_eq!(
            registry.dispatch(a.id, Frame::Text(Bytes::from_static(b"busy"))),
            Ok(())
        );
        let report = registry
            .broadcast_from(a.id, Frame::Text(Bytes::from_static(b"event")))
            .unwrap();
        assert_eq!(
            report,
            vec![(a.id, Err(DispatchError::QueueFull)), (sibling.id, Ok(()))]
        );
        assert!(a.overflow.has_changed().unwrap());
        assert!(*a.overflow.borrow());
        assert!(!*sibling.overflow.borrow());
        assert_eq!(
            sibling.receiver.recv().await.unwrap().frame,
            Frame::Text(Bytes::from_static(b"event"))
        );
        assert!(other.receiver.try_recv().is_err());
        let first = a.id;
        drop(a);
        assert_eq!(
            registry.broadcast_from(first, Frame::Text(Bytes::new())),
            Err(DispatchError::Missing)
        );
        let report = registry
            .broadcast_from(sibling.id, Frame::Text(Bytes::from_static(b"next")))
            .unwrap();
        assert_eq!(report, vec![(sibling.id, Ok(()))]);
        assert_eq!(
            sibling.receiver.recv().await.unwrap().frame,
            Frame::Text(Bytes::from_static(b"next"))
        );
        let report = registry.broadcast_session("a", Frame::Text(Bytes::from_static(b"backend")));
        assert_eq!(report, vec![(sibling.id, Ok(()))]);
        assert_eq!(
            sibling.receiver.recv().await.unwrap().frame,
            Frame::Text(Bytes::from_static(b"backend"))
        );
        assert!(registry
            .broadcast_session("absent", Frame::Text(Bytes::new()))
            .is_empty());
        assert!(other.receiver.try_recv().is_err());
        drop(sibling);
        drop(other);
        assert!(registry.is_empty());
        assert!(registry.entries.lock().unwrap().sessions.is_empty());
    }

    #[tokio::test]
    async fn message_limit_notifies_even_when_bytes_remain() {
        let registry = Arc::new(Registry::default());
        let mut connection = registry.register(1, 128).unwrap();
        assert_eq!(
            registry.dispatch(connection.id, Frame::Text(Bytes::from_static(b"a"))),
            Ok(())
        );
        assert_eq!(
            registry.dispatch(connection.id, Frame::Text(Bytes::from_static(b"b"))),
            Err(DispatchError::QueueFull)
        );
        connection.overflow.changed().await.unwrap();
        assert!(*connection.overflow.borrow());
        assert_eq!(
            registry.dispatch(connection.id, Frame::Text(Bytes::new())),
            Err(DispatchError::Closed)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_broadcasts_have_the_same_order_for_every_client() {
        let registry = Arc::new(Registry::default());
        let mut first = registry.register_session("same".into(), 256, 4096).unwrap();
        let mut second = registry.register_session("same".into(), 256, 4096).unwrap();
        let barrier = Arc::new(tokio::sync::Barrier::new(3));
        let mut tasks = Vec::new();
        for (sender, prefix) in [(first.id, b'A'), (second.id, b'B')] {
            let registry = Arc::clone(&registry);
            let barrier = Arc::clone(&barrier);
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                for n in 0..100_u8 {
                    let results = registry
                        .broadcast_from(sender, Frame::Binary(vec![prefix, n].into()))
                        .unwrap();
                    assert!(results.iter().all(|(_, result)| result.is_ok()));
                }
            }));
        }
        barrier.wait().await;
        for task in tasks {
            task.await.unwrap();
        }
        for _ in 0..200 {
            assert_eq!(
                first.receiver.recv().await.unwrap().frame,
                second.receiver.recv().await.unwrap().frame
            );
        }
    }
}
