//! Bounded per-session replay and ordered client membership for chat.
//!
//! The addon's `RustWsHost` holds one `Sessions` table for `/ws/chat`; its
//! caller is responsible for socket lifetime, serialization and authorization.
use std::collections::{BTreeMap, VecDeque};

pub const REPLAY_CAPACITY: usize = 500;

pub struct Session<T, C> {
    replay: VecDeque<T>,
    clients: Vec<C>,
}

impl<T, C> Default for Session<T, C> {
    fn default() -> Self {
        Self {
            replay: VecDeque::new(),
            clients: Vec::new(),
        }
    }
}

impl<T, C: PartialEq> Session<T, C> {
    pub fn push(&mut self, event: T) {
        self.replay.push_back(event);
        if self.replay.len() > REPLAY_CAPACITY {
            self.replay.pop_front();
        }
    }

    pub fn clear_replay(&mut self) {
        self.replay.clear();
    }
    pub fn replay(&self) -> &VecDeque<T> {
        &self.replay
    }
    pub fn join(&mut self, client: C) {
        if !self.clients.contains(&client) {
            self.clients.push(client);
        }
    }
    pub fn leave(&mut self, client: &C) {
        self.clients.retain(|entry| entry != client);
    }
    pub fn clear_clients(&mut self) {
        self.clients.clear();
    }
    pub fn clients(&self) -> &[C] {
        &self.clients
    }
}

pub struct Sessions<T, C> {
    sessions: BTreeMap<String, Session<T, C>>,
}

impl<T, C> Default for Sessions<T, C> {
    fn default() -> Self {
        Self {
            sessions: BTreeMap::new(),
        }
    }
}

impl<T, C: PartialEq> Sessions<T, C> {
    pub fn session(&mut self, name: &str) -> &mut Session<T, C> {
        self.sessions.entry(name.to_owned()).or_default()
    }
    pub fn get(&self, name: &str) -> Option<&Session<T, C>> {
        self.sessions.get(name)
    }
    pub fn get_mut(&mut self, name: &str) -> Option<&mut Session<T, C>> {
        self.sessions.get_mut(name)
    }
    pub fn remove(&mut self, name: &str) -> Option<Session<T, C>> {
        self.sessions.remove(name)
    }
    pub fn detach(&mut self, client: &C) {
        for session in self.sessions.values_mut() {
            session.leave(client);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::collections::BTreeSet;

    #[test]
    fn captured_reconnect_payloads_survive_the_buffer_byte_for_byte() {
        let golden: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/rust-migration/differential/chat-replay-buffer-golden.json"
        )))
        .unwrap();
        for scenario in golden["scenarios"].as_array().unwrap() {
            let mut expected = Vec::new();
            for frame in scenario["frameBytes"].as_array().unwrap() {
                assert_eq!(frame["binary"], false);
                let bytes = STANDARD.decode(frame["base64"].as_str().unwrap()).unwrap();
                let event: Value = serde_json::from_slice(&bytes).unwrap();
                if event["type"] == "stream_event" {
                    expected.push(bytes);
                }
            }
            assert_eq!(
                expected.len(),
                scenario["replayed"].as_array().unwrap().len()
            );
            let mut session = Session::<Vec<u8>, u64>::default();
            for event in &expected {
                session.push(event.clone());
            }
            assert_eq!(
                session.replay().iter().collect::<Vec<_>>(),
                expected.iter().collect::<Vec<_>>(),
                "captured payloads for {}",
                scenario["name"]
            );
        }
    }

    #[test]
    fn replay_and_client_membership_match_frozen_node_corpus() {
        let corpus: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/rust-migration/differential/chat-replay-buffer-corpus.json"
        )))
        .unwrap();
        let cases = corpus["cases"].as_array().unwrap();
        let captured_bytes = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/rust-migration/differential/chat-replay-buffer-golden.json"
        ));
        let oracle_bytes = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/helpers/legacy-chat-replay-buffer.js"
        ));
        assert_eq!(
            corpus["meta"]["captureSha256"],
            format!("{:x}", Sha256::digest(captured_bytes))
        );
        assert_eq!(
            corpus["meta"]["oracleSha256"],
            format!("{:x}", Sha256::digest(oracle_bytes))
        );
        assert_eq!(cases.len(), 1999);
        let captured = corpus["captured"].as_array().unwrap();
        assert_eq!(captured.len(), 7);
        for (index, case) in cases.iter().chain(captured).enumerate() {
            let mut sessions = Sessions::<u64, u64>::default();
            let mut touched = BTreeSet::new();
            let mut observed = Vec::new();
            let mut seq = 0;
            for line in case["program"].as_array().unwrap() {
                let parts: Vec<_> = line.as_str().unwrap().split(' ').collect();
                let name = parts.get(1).copied().unwrap_or("");
                match parts[0] {
                    "push" | "gpush" => {
                        touched.insert(name.to_owned());
                        for _ in 0..parts[2].parse::<usize>().unwrap() {
                            sessions.session(name).push(seq);
                            seq += 1;
                        }
                    }
                    "clear" => {
                        touched.insert(name.to_owned());
                        sessions.session(name).clear_replay();
                    }
                    "join" => {
                        touched.insert(name.to_owned());
                        sessions.session(name).join(parts[2].parse().unwrap());
                    }
                    "leave" => {
                        touched.insert(name.to_owned());
                        sessions.session(name).leave(&parts[2].parse().unwrap());
                    }
                    "clearc" => {
                        touched.insert(name.to_owned());
                        sessions.session(name).clear_clients();
                    }
                    "detach" => sessions.detach(&name.parse().unwrap()),
                    "drop" => {
                        touched.insert(name.to_owned());
                        let clients = sessions.remove(name).map(|s| s.clients).unwrap_or_default();
                        observed.push(json!({"op":"drop", "terminated":clients}));
                    }
                    "fan" => {
                        touched.insert(name.to_owned());
                        let open = parts[2];
                        let attempted: Vec<_> = sessions
                            .session(name)
                            .clients()
                            .iter()
                            .copied()
                            .filter(|id| open.contains(&id.to_string()))
                            .collect();
                        observed.push(json!({"op":"fan", "attempted":attempted}));
                    }
                    op => panic!("unknown corpus operation {op}"),
                }
            }
            let mut final_state = serde_json::Map::new();
            for name in touched {
                let mut runs: Vec<[u64; 2]> = Vec::new();
                if let Some(session) = sessions.get(&name) {
                    for &n in session.replay() {
                        if let Some(last) = runs.last_mut().filter(|last| last[1] + 1 == n) {
                            last[1] = n;
                        } else {
                            runs.push([n, n]);
                        }
                    }
                    final_state.insert(name, json!({"frames":runs,"clients":session.clients()}));
                } else {
                    final_state.insert(name, json!({"frames":[],"clients":[]}));
                }
            }
            assert_eq!(json!(observed), case["observed"], "observed case {index}");
            assert_eq!(
                Value::Object(final_state),
                case["final"],
                "final case {index}"
            );
        }
    }
}
