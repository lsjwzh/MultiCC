//! State machines for the native workspace subscription owner.
//!
//! The owner itself lives in the addon (it holds opaque host handles); this
//! module keeps the parts that are pure bookkeeping: which client is scoped to
//! which directory, the recent-event ring, per-socket heartbeat bookkeeping and
//! the backpressure queue. Keeping them here lets `cargo test` pin the rules
//! without a JavaScript engine.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

/// `notes-store.js` keeps the last 200 events of a directory in memory.
pub const RING_CAPACITY: usize = 200;
/// `connection-router.js` tolerates three completed unanswered ping windows.
pub const MAX_MISSED_PONGS: u32 = 3;

/// Where a socket's broadcasts are scoped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    Directory(String),
    /// The `/ws/meta` fleet channel: every directory plus a `dirId` tag.
    Fleet,
}

/// The result of one heartbeat window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeartbeatTick {
    /// Already timed out (or no work): the old loop skipped this socket.
    Idle,
    Ping,
    Terminate,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Heartbeat {
    pending: bool,
    missed: u32,
    timed_out: bool,
}

impl Heartbeat {
    pub fn on_pong(&mut self) {
        self.pending = false;
        self.missed = 0;
    }

    /// One 30s window. Counting completed unanswered windows (not the first
    /// ping) is what gives a delayed relay pong ~90s before the close.
    pub fn tick(&mut self) -> HeartbeatTick {
        if self.timed_out {
            return HeartbeatTick::Idle;
        }
        if self.pending {
            self.missed += 1;
        }
        if self.missed >= MAX_MISSED_PONGS {
            self.timed_out = true;
            return HeartbeatTick::Terminate;
        }
        self.pending = true;
        HeartbeatTick::Ping
    }

    pub fn missed_pongs(&self) -> u32 {
        self.missed
    }

    pub fn timed_out(&self) -> bool {
        self.timed_out
    }

    pub fn pending(&self) -> bool {
        self.pending
    }
}

/// Client registry. Ids increase monotonically, so a `BTreeSet` iterates in the
/// same insertion order as the JavaScript `Set` it replaces, and scoped sends
/// stay byte-for-byte deterministic.
#[derive(Default)]
pub struct Clients {
    next: u64,
    scopes: BTreeMap<u64, Scope>,
    by_dir: HashMap<String, BTreeSet<u64>>,
    fleet: BTreeSet<u64>,
}

impl Clients {
    pub fn insert(&mut self, scope: Scope) -> u64 {
        let id = self.next + 1;
        self.next = id;
        match &scope {
            Scope::Directory(dir) => {
                self.by_dir.entry(dir.clone()).or_default().insert(id);
            }
            Scope::Fleet => {
                self.fleet.insert(id);
            }
        }
        self.scopes.insert(id, scope);
        id
    }

    pub fn remove(&mut self, id: u64) -> Option<Scope> {
        let scope = self.scopes.remove(&id)?;
        match &scope {
            Scope::Directory(dir) => {
                if let Some(set) = self.by_dir.get_mut(dir) {
                    set.remove(&id);
                    if set.is_empty() {
                        self.by_dir.remove(dir);
                    }
                }
            }
            Scope::Fleet => {
                self.fleet.remove(&id);
            }
        }
        Some(scope)
    }

    pub fn scoped(&self, dir: &str) -> Vec<u64> {
        self.by_dir
            .get(dir)
            .map(|set| set.iter().copied().collect())
            .unwrap_or_default()
    }

    pub fn fleet(&self) -> Vec<u64> {
        self.fleet.iter().copied().collect()
    }

    pub fn directory_clients(&self, dir: &str) -> usize {
        self.by_dir.get(dir).map_or(0, BTreeSet::len)
    }

    pub fn has_directory(&self, dir: &str) -> bool {
        self.by_dir.contains_key(dir)
    }

    pub fn directory_count(&self) -> usize {
        self.by_dir.len()
    }

    pub fn fleet_len(&self) -> usize {
        self.fleet.len()
    }

    pub fn len(&self) -> usize {
        self.scopes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.scopes.is_empty()
    }

    pub fn scope(&self, id: u64) -> Option<&Scope> {
        self.scopes.get(&id)
    }

    pub fn ids(&self) -> Vec<u64> {
        self.scopes.keys().copied().collect()
    }
}

/// Per-directory recent-event ring, hydrated lazily from the JSONL log.
pub struct Replay<V> {
    rings: HashMap<String, VecDeque<V>>,
}

impl<V> Default for Replay<V> {
    fn default() -> Self {
        Self {
            rings: HashMap::new(),
        }
    }
}

impl<V> Replay<V> {
    pub fn has(&self, dir: &str) -> bool {
        self.rings.contains_key(dir)
    }

    /// Replace a ring with values loaded from disk, keeping the newest
    /// `RING_CAPACITY` entries. Returns the number kept.
    pub fn hydrate(&mut self, dir: &str, values: Vec<V>) -> usize {
        let skip = values.len().saturating_sub(RING_CAPACITY);
        let ring: VecDeque<V> = values.into_iter().skip(skip).collect();
        let kept = ring.len();
        self.rings.insert(dir.to_string(), ring);
        kept
    }

    /// Append one event. Returns the evicted front entry when the ring overflows.
    pub fn push(&mut self, dir: &str, value: V) -> Option<V> {
        let ring = self.rings.entry(dir.to_string()).or_default();
        ring.push_back(value);
        if ring.len() > RING_CAPACITY {
            ring.pop_front()
        } else {
            None
        }
    }

    pub fn len(&self, dir: &str) -> usize {
        self.rings.get(dir).map_or(0, VecDeque::len)
    }

    pub fn get(&self, dir: &str) -> Option<&VecDeque<V>> {
        self.rings.get(dir)
    }

    pub fn remove(&mut self, dir: &str) -> Option<VecDeque<V>> {
        self.rings.remove(dir)
    }

    pub fn clear(&mut self) -> Vec<VecDeque<V>> {
        self.rings.drain().map(|(_, ring)| ring).collect()
    }
}

/// Limits mirror `src/ws-backpressure.js` `DEFAULTS`.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub high_water_bytes: usize,
    pub max_queue_bytes: usize,
    pub max_queue_messages: usize,
    pub max_congestion_ms: f64,
    pub max_frame_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            high_water_bytes: 1024 * 1024,
            max_queue_bytes: 2 * 1024 * 1024,
            max_queue_messages: 4096,
            max_congestion_ms: 15_000.0,
            max_frame_bytes: 8 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Queued<H> {
    pub data: H,
    pub key: Option<String>,
    pub bytes: usize,
}

/// Everything one backpressure transition wants the transport to do. Handles in
/// `retire` must be dropped by the caller; `send` carries the frame to pass to
/// the socket.
pub struct Effects<H> {
    pub send: Option<H>,
    pub retire: Vec<H>,
    pub depth: Option<usize>,
    pub coalesced: bool,
    pub overflow: bool,
    pub high_water: bool,
    pub schedule: bool,
    pub disconnect: Option<&'static str>,
    pub disconnect_queue: Option<(usize, usize)>,
    pub closed_reject: bool,
}

impl<H> Default for Effects<H> {
    fn default() -> Self {
        Self {
            send: None,
            retire: Vec::new(),
            depth: None,
            coalesced: false,
            overflow: false,
            high_water: false,
            schedule: false,
            disconnect: None,
            disconnect_queue: None,
            closed_reject: false,
        }
    }
}

impl<H> Effects<H> {
    fn absorb(&mut self, mut other: Effects<H>) {
        if other.send.is_some() {
            self.send = other.send.take();
        }
        self.retire.append(&mut other.retire);
        if other.depth.is_some() {
            self.depth = other.depth;
        }
        self.coalesced |= other.coalesced;
        self.overflow |= other.overflow;
        self.high_water |= other.high_water;
        self.schedule |= other.schedule;
        if self.disconnect.is_none() {
            self.disconnect = other.disconnect;
            self.disconnect_queue = other.disconnect_queue;
        }
        self.closed_reject |= other.closed_reject;
    }
}

pub struct Backpressure<H> {
    queue: VecDeque<Queued<H>>,
    bytes: usize,
    sending: bool,
    congested_at: f64,
    closed: bool,
}

impl<H> Default for Backpressure<H> {
    fn default() -> Self {
        Self {
            queue: VecDeque::new(),
            bytes: 0,
            sending: false,
            congested_at: 0.0,
            closed: false,
        }
    }
}

impl<H> Backpressure<H> {
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn is_sending(&self) -> bool {
        self.sending
    }

    pub fn queue_len(&self) -> usize {
        self.queue.len()
    }

    pub fn queue_bytes(&self) -> usize {
        self.bytes
    }

    fn close_clearing(&mut self, effects: &mut Effects<H>) {
        self.closed = true;
        effects
            .retire
            .extend(self.queue.drain(..).map(|item| item.data));
        self.bytes = 0;
    }

    fn disconnect(&mut self, reason: &'static str) -> Effects<H> {
        let mut effects = Effects::default();
        if self.closed {
            return effects;
        }
        effects.disconnect_queue = Some((self.bytes, self.queue.len()));
        self.close_clearing(&mut effects);
        effects.disconnect = Some(reason);
        effects
    }

    /// Enqueue one already-encoded frame. `buffered` is the transport's
    /// `socket.bufferedAmount` at this instant; `now` is the host clock.
    pub fn enqueue(
        &mut self,
        item: Queued<H>,
        bounded: bool,
        limits: &Limits,
        buffered: f64,
        now: f64,
    ) -> Effects<H> {
        let mut effects = Effects::default();
        if self.closed {
            effects.closed_reject = true;
            effects.retire.push(item.data);
            return effects;
        }
        if let Some(key) = item.key.as_ref() {
            if let Some(index) = self
                .queue
                .iter()
                .position(|queued| queued.key.as_ref() == Some(key))
            {
                let old = self.queue.remove(index).expect("position from iter");
                self.bytes -= old.bytes;
                self.bytes += item.bytes;
                self.queue.insert(index, item);
                effects.retire.push(old.data);
                effects.coalesced = true;
                effects.absorb(self.flush(buffered, now, limits));
                return effects;
            }
        }
        let queue_ceiling = limits.max_queue_bytes + limits.max_frame_bytes;
        let over_bytes =
            item.bytes > limits.max_frame_bytes || self.bytes + item.bytes > queue_ceiling;
        let over_messages = bounded && self.queue.len() >= limits.max_queue_messages;
        if over_bytes || over_messages {
            effects.overflow = true;
            effects.retire.push(item.data);
            let mut failed = self.disconnect("queue_overflow");
            effects.disconnect = failed.disconnect;
            effects.disconnect_queue = failed.disconnect_queue;
            effects.retire.append(&mut failed.retire);
            return effects;
        }
        self.queue.push_back(item);
        self.bytes += self.queue.back().map_or(0, |queued| queued.bytes);
        effects.depth = Some(self.queue.len());
        effects.absorb(self.flush(buffered, now, limits));
        effects
    }

    /// Continue draining. Call after a send completes with the transport's new
    /// buffered amount.
    pub fn send_result(
        &mut self,
        ok: bool,
        limits: &Limits,
        buffered: f64,
        now: f64,
    ) -> Effects<H> {
        self.sending = false;
        if self.closed {
            return Effects::default();
        }
        if !ok {
            return self.disconnect("send_error");
        }
        self.flush(buffered, now, limits)
    }

    pub fn flush(&mut self, buffered: f64, now: f64, limits: &Limits) -> Effects<H> {
        let mut effects = Effects::default();
        if self.closed || self.sending || self.queue.is_empty() {
            return effects;
        }
        if buffered >= limits.high_water_bytes as f64 {
            if self.congested_at == 0.0 {
                self.congested_at = now;
            }
            effects.high_water = true;
            if now - self.congested_at >= limits.max_congestion_ms {
                // The frozen queue counted the high-water event and then the
                // disconnect in the same congested window.
                let mut disconnect = self.disconnect("high_water_timeout");
                disconnect.high_water = true;
                return disconnect;
            }
            effects.schedule = true;
            return effects;
        }
        self.congested_at = 0.0;
        let item = self.queue.pop_front().expect("non-empty queue");
        self.bytes -= item.bytes;
        self.sending = true;
        effects.send = Some(item.data);
        effects
    }

    /// Explicit disconnect with no transport callback (client closed).
    pub fn disconnect_now(&mut self, reason: &'static str) -> Effects<H> {
        self.disconnect(reason)
    }

    /// Drop everything when the socket closes. Returns handles to release.
    pub fn close(&mut self) -> Vec<H> {
        let mut effects = Effects::default();
        self.close_clearing(&mut effects);
        self.sending = false;
        effects.retire
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> Limits {
        Limits {
            high_water_bytes: 100,
            max_queue_bytes: 200,
            max_queue_messages: 3,
            max_congestion_ms: 1000.0,
            max_frame_bytes: 10_000,
        }
    }

    fn item(data: u8, bytes: usize, key: Option<&str>) -> Queued<u8> {
        Queued {
            data,
            bytes,
            key: key.map(str::to_string),
        }
    }

    #[test]
    fn scoped_and_fleet_clients_share_one_id_space() {
        let mut clients = Clients::default();
        assert_eq!(clients.insert(Scope::Directory("d1".into())), 1);
        let fleet = clients.insert(Scope::Fleet);
        assert_eq!(fleet, 2);
        assert_eq!(clients.insert(Scope::Directory("d1".into())), 3);
        assert_eq!(clients.scoped("d1"), vec![1, 3]);
        assert_eq!(clients.fleet(), vec![2]);
        assert_eq!(clients.directory_clients("d1"), 2);
        assert_eq!(clients.remove(1), Some(Scope::Directory("d1".into())));
        assert_eq!(clients.scoped("d1"), vec![3]);
        assert_eq!(clients.remove(3), Some(Scope::Directory("d1".into())));
        assert!(!clients.has_directory("d1"));
        assert_eq!(clients.directory_count(), 0);
        assert_eq!(clients.len(), 1);
    }

    #[test]
    fn replay_hydrates_to_capacity_and_evicts_the_front() {
        let mut replay = Replay::default();
        assert!(!replay.has("d"));
        let values: Vec<u32> = (0..250).collect();
        assert_eq!(replay.hydrate("d", values), RING_CAPACITY);
        assert_eq!(replay.len("d"), RING_CAPACITY);
        assert_eq!(replay.get("d").unwrap().front(), Some(&50));
        assert_eq!(replay.get("d").unwrap().back(), Some(&249));
        assert_eq!(replay.push("d", 999), Some(50));
        assert_eq!(replay.get("d").unwrap().back(), Some(&999));
        assert_eq!(replay.len("d"), RING_CAPACITY);
    }

    #[test]
    fn replay_push_on_unknown_directory_starts_a_ring() {
        let mut replay = Replay::default();
        assert_eq!(replay.push("new", 1u8), None);
        assert!(replay.has("new"));
        assert_eq!(replay.len("new"), 1);
    }

    #[test]
    fn heartbeat_counts_completed_windows_before_terminating() {
        let mut heartbeat = Heartbeat::default();
        assert_eq!(heartbeat.tick(), HeartbeatTick::Ping);
        assert_eq!(heartbeat.tick(), HeartbeatTick::Ping);
        assert_eq!(heartbeat.missed_pongs(), 1);
        heartbeat.on_pong();
        assert_eq!(heartbeat.missed_pongs(), 0);
        assert_eq!(heartbeat.tick(), HeartbeatTick::Ping);
        assert_eq!(heartbeat.tick(), HeartbeatTick::Ping);
        assert_eq!(heartbeat.tick(), HeartbeatTick::Ping);
        assert_eq!(heartbeat.tick(), HeartbeatTick::Terminate);
        assert!(heartbeat.timed_out());
        assert_eq!(heartbeat.tick(), HeartbeatTick::Idle);
    }

    #[test]
    fn enqueue_sends_immediately_below_high_water() {
        let mut bp = Backpressure::<u8>::default();
        let effects = bp.enqueue(item(1, 10, None), true, &limits(), 0.0, 0.0);
        assert_eq!(effects.send, Some(1));
        assert_eq!(effects.depth, Some(1));
        assert!(bp.is_sending());
        let effects = bp.send_result(true, &limits(), 0.0, 1.0);
        assert!(effects.send.is_none());
    }

    #[test]
    fn high_water_defers_then_times_out() {
        let mut bp = Backpressure::<u8>::default();
        let limits = limits();
        bp.enqueue(item(1, 10, None), true, &limits, 0.0, 0.0);
        bp.send_result(true, &limits, 0.0, 0.0);
        // The first frame is in flight; the next enqueue queues.
        let effects = bp.enqueue(item(2, 10, None), true, &limits, 100.0, 5.0);
        assert!(effects.high_water);
        assert!(effects.schedule);
        assert_eq!(effects.send, None);
        let effects = bp.flush(100.0, 1005.0, &limits);
        assert_eq!(effects.disconnect, Some("high_water_timeout"));
        assert_eq!(effects.disconnect_queue, Some((10, 1)));
        assert!(
            effects.high_water,
            "the timing-out window still counts as high water"
        );
        assert!(bp.is_closed());
    }

    #[test]
    fn coalescing_replaces_in_place_and_retires_the_old_handle() {
        let mut bp = Backpressure::<u8>::default();
        let limits = limits();
        bp.enqueue(item(1, 10, None), true, &limits, 0.0, 0.0);
        // First frame in flight, so the next two both queue.
        let first = bp.enqueue(item(2, 10, Some("task_state:d")), true, &limits, 0.0, 1.0);
        assert_eq!(first.send, None);
        let second = bp.enqueue(item(3, 12, Some("task_state:d")), true, &limits, 0.0, 2.0);
        assert!(second.coalesced);
        assert_eq!(second.retire, vec![2]);
        assert_eq!(bp.queue_len(), 1);
        assert_eq!(bp.queue_bytes(), 12);
        let resumed = bp.send_result(true, &limits, 0.0, 3.0);
        assert_eq!(resumed.send, Some(3));
    }

    #[test]
    fn byte_cap_and_message_cap_disconnect() {
        let mut bp = Backpressure::<u8>::default();
        let limits = limits();
        bp.enqueue(item(1, 10, None), true, &limits, 0.0, 0.0);
        let effects = bp.enqueue(item(2, 20_000, None), true, &limits, 0.0, 1.0);
        assert!(effects.overflow);
        assert_eq!(effects.disconnect, Some("queue_overflow"));
        assert_eq!(effects.retire, vec![2]);

        let mut bp = Backpressure::<u8>::default();
        bp.enqueue(item(1, 1, None), true, &limits, 0.0, 0.0);
        for data in 2..=4 {
            let effects = bp.enqueue(item(data, 1, None), true, &limits, 0.0, 1.0);
            assert_ne!(effects.disconnect, Some("queue_overflow"));
        }
        let effects = bp.enqueue(item(5, 1, None), true, &limits, 0.0, 1.0);
        assert!(effects.overflow);
        assert_eq!(effects.disconnect, Some("queue_overflow"));
    }

    #[test]
    fn replay_burst_skips_the_message_count_cap_but_keeps_the_byte_cap() {
        let mut bp = Backpressure::<u8>::default();
        let limits = limits();
        bp.enqueue(item(1, 1, None), true, &limits, 0.0, 0.0);
        for data in 2..=4 {
            bp.enqueue(item(data, 1, None), true, &limits, 0.0, 1.0);
        }
        // Bounded enqueue would overflow here; unbounded replay does not.
        let effects = bp.enqueue(item(5, 1, None), false, &limits, 0.0, 1.0);
        assert!(!effects.overflow);
        let effects = bp.enqueue(item(6, 30_000, None), false, &limits, 0.0, 1.0);
        assert!(effects.overflow);
    }

    #[test]
    fn send_failure_disconnects_and_clears_the_queue() {
        let mut bp = Backpressure::<u8>::default();
        let limits = limits();
        bp.enqueue(item(1, 1, None), true, &limits, 0.0, 0.0);
        bp.enqueue(item(2, 1, None), true, &limits, 0.0, 1.0);
        let effects = bp.send_result(false, &limits, 0.0, 2.0);
        assert_eq!(effects.disconnect, Some("send_error"));
        assert_eq!(effects.disconnect_queue, Some((1, 1)));
        assert!(bp.is_closed());
    }

    #[test]
    fn close_releases_queued_handles() {
        let mut bp = Backpressure::<u8>::default();
        let limits = limits();
        bp.enqueue(item(1, 1, None), true, &limits, 0.0, 0.0);
        let effects = bp.enqueue(item(2, 1, Some("snapshot:d")), true, &limits, 0.0, 1.0);
        assert_eq!(effects.send, None);
        assert_eq!(bp.close(), vec![2]);
        assert!(bp.is_closed());
    }
}
