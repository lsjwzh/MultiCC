//! Ordered chat replay and connection membership for a future front-door host.
//!
//! This hub is not registered on `/ws/chat`: the Node authorization, live
//! session and event bridges are still required. Callers must admit a session
//! before using it, send the returned replay before consuming live frames, and
//! apply the existing replay byte and backpressure limits at the socket.
use std::sync::{Arc, Mutex, Weak};

use hyper::body::Bytes;
use multicc_core::chat_replay_buffer::Sessions;

use crate::ws_registry::{BroadcastResults, Connection, DispatchError, Frame, Registry};

#[derive(Default)]
pub struct ChatHub {
    sessions: Mutex<Sessions<Bytes, u64>>,
    registry: Arc<Registry>,
}

/// A connection's replay snapshot is taken at the same ordering boundary as
/// registration. Subsequent events go into its bounded live queue.
pub struct Attached {
    pub connection: Connection,
    pub replay: Vec<Bytes>,
    session: String,
    hub: Weak<ChatHub>,
}

impl Drop for Attached {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            let mut sessions = hub.sessions.lock().unwrap_or_else(|e| e.into_inner());
            if sessions.get(&self.session).is_some() {
                sessions.session(&self.session).leave(&self.connection.id);
            }
        }
        // `connection` is dropped immediately afterwards and unregisters its
        // sender. Publishing uses the session's membership, so no new event is
        // sent in the interval between those two removals.
    }
}

impl ChatHub {
    /// Send to one already admitted connection. Broadcasts and replay writes
    /// must go through `publish` to preserve their shared ordering boundary.
    pub fn send(&self, id: u64, frame: Frame) -> Result<(), DispatchError> {
        self.registry.dispatch(id, frame)
    }

    pub fn attach(
        self: &Arc<Self>,
        session: &str,
        max_messages: usize,
        max_bytes: usize,
    ) -> Option<Attached> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let connection = self.registry.register(max_messages, max_bytes)?;
        let state = sessions.session(session);
        let replay = state.replay().iter().cloned().collect();
        state.join(connection.id);
        Some(Attached {
            connection,
            replay,
            session: session.to_owned(),
            hub: Arc::downgrade(self),
        })
    }

    /// Serialize buffer writes and live queue inserts with attachment. `replay`
    /// selects the events the existing turn engine actually buffers; other
    /// events fan out without entering the replay window.
    pub fn publish(&self, session: &str, event: Bytes, replay: bool) -> BroadcastResults {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let state = sessions.session(session);
        if replay {
            state.push(event.clone());
        }
        state
            .clients()
            .iter()
            .map(|id| (*id, self.registry.dispatch(*id, Frame::Text(event.clone()))))
            .collect()
    }

    pub fn clear_replay(&self, session: &str) {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if sessions.get(session).is_some() {
            sessions.session(session).clear_replay();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ws_registry::DispatchError;

    #[tokio::test]
    async fn session_isolation_replay_and_overflow_are_independent() {
        let hub = Arc::new(ChatHub::default());
        hub.publish("a", Bytes::from_static(b"old"), true);
        hub.publish("a", Bytes::from_static(b"transient"), false);
        let slow = hub.attach("a", 1, 32).unwrap();
        let mut healthy = hub.attach("a", 4, 32).unwrap();
        let mut other = hub.attach("b", 4, 32).unwrap();
        assert_eq!(slow.replay, vec![Bytes::from_static(b"old")]);
        assert_eq!(healthy.replay, slow.replay);
        assert!(other.replay.is_empty());
        assert!(hub
            .publish("a", Bytes::from_static(b"one"), true)
            .iter()
            .all(|(_, r)| r.is_ok()));
        let results = hub.publish("a", Bytes::from_static(b"two"), true);
        assert_eq!(
            results[0],
            (slow.connection.id, Err(DispatchError::QueueFull))
        );
        assert_eq!(results[1], (healthy.connection.id, Ok(())));
        assert!(*slow.connection.overflow.borrow());
        assert_eq!(
            healthy.connection.receiver.recv().await.unwrap().frame,
            Frame::Text(Bytes::from_static(b"one"))
        );
        assert_eq!(
            healthy.connection.receiver.recv().await.unwrap().frame,
            Frame::Text(Bytes::from_static(b"two"))
        );
        assert!(other.connection.receiver.try_recv().is_err());
        drop(slow);
        drop(healthy);
        hub.clear_replay("a");
        let fresh = hub.attach("a", 2, 32).unwrap();
        assert!(fresh.replay.is_empty());
        assert_eq!(hub.publish("a", Bytes::from_static(b"new"), true).len(), 1);
    }

    #[tokio::test]
    async fn replay_burst_does_not_consume_the_live_message_queue() {
        let hub = Arc::new(ChatHub::default());
        for n in 0..620_u16 {
            hub.publish("a", Bytes::copy_from_slice(&n.to_be_bytes()), true);
        }
        let mut attached = hub.attach("a", 1, 4).unwrap();
        assert_eq!(attached.replay.len(), 500);
        assert_eq!(
            attached.replay.first().unwrap().as_ref(),
            120_u16.to_be_bytes()
        );
        assert_eq!(
            attached.replay.last().unwrap().as_ref(),
            619_u16.to_be_bytes()
        );
        assert!(hub.publish("a", Bytes::from_static(b"ok"), false)[0]
            .1
            .is_ok());
        assert_eq!(
            attached.connection.receiver.recv().await.unwrap().frame,
            Frame::Text(Bytes::from_static(b"ok"))
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn attach_racing_with_events_has_no_gap_or_duplicate() {
        for _ in 0..20 {
            let hub = Arc::new(ChatHub::default());
            let barrier = Arc::new(tokio::sync::Barrier::new(2));
            let producer = {
                let hub = Arc::clone(&hub);
                let barrier = Arc::clone(&barrier);
                tokio::spawn(async move {
                    barrier.wait().await;
                    for n in 0..200_u16 {
                        hub.publish("a", Bytes::copy_from_slice(&n.to_be_bytes()), true);
                        tokio::task::yield_now().await;
                    }
                })
            };
            barrier.wait().await;
            let mut attached = hub.attach("a", 256, 2048).unwrap();
            producer.await.unwrap();
            let mut seen = attached.replay.clone();
            while let Ok(frame) = attached.connection.receiver.try_recv() {
                match frame.frame {
                    Frame::Text(bytes) => seen.push(bytes),
                    _ => panic!("unexpected frame"),
                }
            }
            let actual: Vec<_> = seen
                .iter()
                .map(|b| u16::from_be_bytes([b[0], b[1]]))
                .collect();
            assert_eq!(actual, (0..200_u16).collect::<Vec<_>>());
        }
    }
}
