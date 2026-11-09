//! Serial admission across the live source-context port. Queue and password
//! failure windows are host-independent; dropping any reservation unblocks the
//! next request without counting an unfinished attempt as a wrong password.
use super::*;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::oneshot;

pub const FAILURE_WINDOW_MS: f64 = 15.0 * 60_000.0;
pub const MAX_PASSWORD_FAILURES: u32 = 10;
struct Failure {
    started_at: f64,
    count: u32,
}
struct Active {
    id: u64,
    key: Option<JsString>,
    settled: bool,
}
#[derive(Default)]
struct State {
    next_id: u64,
    active: Option<Active>,
    pending: VecDeque<(u64, oneshot::Sender<()>)>,
    failures: HashMap<JsString, Failure>,
}
#[derive(Default)]
pub struct Gate {
    state: Mutex<State>,
}
pub struct Reservation {
    gate: Arc<Gate>,
    id: u64,
    receiver: Mutex<Option<oneshot::Receiver<()>>>,
    released: AtomicBool,
}
fn internal() -> Error {
    Error::new("WORKSPACE_SHARING_INTERNAL", "工作区分享操作失败", 500)
}
fn advance(state: &mut State) {
    while state.active.is_none() {
        let Some((id, sender)) = state.pending.pop_front() else {
            return;
        };
        if sender.send(()).is_ok() {
            state.active = Some(Active {
                id,
                key: None,
                settled: false,
            });
        }
    }
}
impl Gate {
    /// Reserve synchronously, before scheduling an async wait, to preserve FIFO
    /// even if workers first poll their futures in a different order.
    pub fn reserve(self: &Arc<Self>) -> Result<Reservation> {
        let mut state = self.state.lock().map_err(|_| internal())?;
        let id = state.next_id;
        state.next_id = id.checked_add(1).ok_or_else(internal)?;
        let (sender, receiver) = oneshot::channel();
        state.pending.push_back((id, sender));
        advance(&mut state);
        Ok(Reservation {
            gate: self.clone(),
            id,
            receiver: Mutex::new(Some(receiver)),
            released: AtomicBool::new(false),
        })
    }
    fn release(&self, id: u64) {
        if let Ok(mut state) = self.state.lock() {
            if state.active.as_ref().is_some_and(|a| a.id == id) {
                state.active = None;
            } else {
                state.pending.retain(|(key, _)| *key != id);
            }
            advance(&mut state);
        }
    }
}
impl Reservation {
    pub async fn ready(&self) -> Result<()> {
        let receiver = self
            .receiver
            .lock()
            .map_err(|_| internal())?
            .take()
            .ok_or_else(internal)?;
        receiver.await.map_err(|_| internal())?;
        let state = self.gate.state.lock().map_err(|_| internal())?;
        if state.active.as_ref().is_some_and(|a| a.id == self.id) {
            Ok(())
        } else {
            Err(internal())
        }
    }
    pub fn admit(&self, input: &V, now: f64) -> Result<V> {
        let mut state = self.gate.state.lock().map_err(|_| internal())?;
        let active = state
            .active
            .as_mut()
            .filter(|a| a.id == self.id && a.key.is_none() && !a.settled)
            .ok_or_else(internal)?;
        // Preserve the legacy `${token}:${req.ip || socket.remoteAddress || 'unknown'}` key.
        let peer = if truth(get(input, "ip")) {
            get(input, "ip")
        } else if truth(get(input, "remoteAddress")) {
            get(input, "remoteAddress")
        } else {
            &V::Undefined
        };
        let mut key = js::js_to_string(get(input, "token"));
        key.push_str(":");
        key.push(&if matches!(peer, V::Undefined) {
            JsString::from_rust_str("unknown")
        } else {
            js::js_to_string(peer)
        });
        active.key = Some(key.clone());
        if state
            .failures
            .get(&key)
            .is_some_and(|e| now - e.started_at > FAILURE_WINDOW_MS)
        {
            state.failures.remove(&key);
        }
        if state
            .failures
            .get(&key)
            .is_some_and(|e| e.count >= MAX_PASSWORD_FAILURES)
        {
            state.active.as_mut().unwrap().settled = true;
            return Err(
                Error::new("SHARE_RATE_LIMITED", "尝试过于频繁，请稍后再试", 429).meta(V::object(
                    vec![
                        ("category", "rate_limit".into()),
                        ("retryable", true.into()),
                        ("action", "retry_later".into()),
                        ("scope", "request".into()),
                    ],
                )),
            );
        }
        Ok(V::Null)
    }
    pub fn finish(&self, success: bool, code: &str, now: f64) -> Result<()> {
        let mut state = self.gate.state.lock().map_err(|_| internal())?;
        let Some(active) = state
            .active
            .as_mut()
            .filter(|a| a.id == self.id && !a.settled)
        else {
            return Ok(());
        };
        active.settled = true;
        let Some(key) = active.key.clone() else {
            return Ok(());
        };
        if success {
            state.failures.remove(&key);
        } else if code == "WRONG_PASSWORD" {
            let entry = state.failures.entry(key).or_insert(Failure {
                started_at: now,
                count: 0,
            });
            if now - entry.started_at > FAILURE_WINDOW_MS {
                *entry = Failure {
                    started_at: now,
                    count: 0,
                };
            }
            entry.count += 1;
        }
        Ok(())
    }
    pub fn release(&self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            self.gate.release(self.id);
        }
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(peer: &str) -> V {
        V::object(vec![("token", "shared-token".into()), ("ip", peer.into())])
    }
    async fn attempt(
        gate: &Arc<Gate>,
        now: f64,
        peer: &str,
        success: bool,
        code: &str,
    ) -> Result<V> {
        let r = gate.reserve()?;
        r.ready().await?;
        r.admit(&input(peer), now)?;
        r.finish(success, code, now)?;
        Ok(V::Null)
    }
    #[tokio::test]
    async fn window_boundary_success_reset_and_only_wrong_password_counts() {
        let gate = Arc::new(Gate::default());
        for _ in 0..9 {
            attempt(&gate, 0.0, "a", false, "WRONG_PASSWORD")
                .await
                .unwrap();
        }
        for code in [
            "SHARE_NOT_FOUND",
            "SHARE_EXHAUSTED",
            "FLEET_NOT_FOUND",
            "WORKSPACE_SHARING_INTERNAL",
        ] {
            attempt(&gate, 0.0, "a", false, code).await.unwrap();
        }
        attempt(&gate, 0.0, "a", true, "").await.unwrap();
        for _ in 0..10 {
            attempt(&gate, 0.0, "a", false, "WRONG_PASSWORD")
                .await
                .unwrap();
        }
        assert_eq!(
            attempt(&gate, FAILURE_WINDOW_MS, "a", true, "")
                .await
                .unwrap_err()
                .code,
            "SHARE_RATE_LIMITED"
        );
        attempt(&gate, FAILURE_WINDOW_MS, "b", true, "")
            .await
            .unwrap();
        attempt(&gate, FAILURE_WINDOW_MS + 1.0, "a", true, "")
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn reservations_are_fifo_and_cancelling_middle_does_not_skip_active() {
        let gate = Arc::new(Gate::default());
        let first = gate.reserve().unwrap();
        let middle = gate.reserve().unwrap();
        let last = gate.reserve().unwrap();
        first.ready().await.unwrap();
        drop(middle);
        assert!(last.admit(&input("a"), 0.0).is_err());
        first.release();
        last.ready().await.unwrap();
        last.admit(&input("a"), 0.0).unwrap();
        first.release(); // stale completion cannot release the active successor
        let next = gate.reserve().unwrap();
        assert!(next.admit(&input("a"), 0.0).is_err());
        drop(last);
        next.ready().await.unwrap();
        next.admit(&input("a"), 0.0).unwrap();
    }
    #[tokio::test]
    async fn abandoned_or_repeated_completion_never_corrupts_a_window() {
        let gate = Arc::new(Gate::default());
        let ended = gate.reserve().unwrap();
        ended.ready().await.unwrap();
        ended.finish(true, "", 0.0).unwrap();
        assert!(ended.admit(&input("a"), 0.0).is_err());
        drop(ended);
        for _ in 0..9 {
            attempt(&gate, 0.0, "a", false, "WRONG_PASSWORD")
                .await
                .unwrap();
        }
        let r = gate.reserve().unwrap();
        r.ready().await.unwrap();
        r.admit(&input("a"), 0.0).unwrap();
        drop(r);
        let r = gate.reserve().unwrap();
        r.ready().await.unwrap();
        r.admit(&input("a"), 0.0).unwrap();
        r.finish(false, "WRONG_PASSWORD", 0.0).unwrap();
        r.finish(true, "", 0.0).unwrap();
        drop(r);
        assert_eq!(
            attempt(&gate, 0.0, "a", true, "").await.unwrap_err().status,
            429
        );
    }

    #[tokio::test]
    async fn unicode_keys_remain_distinct_and_failed_admission_releases_queue() {
        let gate = Arc::new(Gate::default());
        let value = |unit| {
            V::object(vec![
                ("token", V::String(JsString::from_units(vec![unit]))),
                ("ip", "中文😀".into()),
            ])
        };
        for _ in 0..10 {
            let r = gate.reserve().unwrap();
            r.ready().await.unwrap();
            r.admit(&value(0xd800), 0.0).unwrap();
            r.finish(false, "WRONG_PASSWORD", 0.0).unwrap();
        }
        let refused = gate.reserve().unwrap();
        let next = gate.reserve().unwrap();
        refused.ready().await.unwrap();
        assert_eq!(refused.admit(&value(0xd800), 0.0).unwrap_err().status, 429);
        drop(refused);
        next.ready().await.unwrap();
        next.admit(&value(0xd801), 0.0).unwrap();
        next.finish(true, "", 0.0).unwrap();
    }
}
