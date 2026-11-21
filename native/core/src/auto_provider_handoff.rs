//! Bounded admission identities for Provider continuation handoffs.
use crate::js::JsString;
use std::collections::VecDeque;

const MAX_HANDOFF_KEYS: usize = 2_048;

#[derive(Default)]
pub struct Handoffs {
    scheduled: VecDeque<(JsString, JsString)>,
}
impl Handoffs {
    pub fn contains(&self, key: &JsString) -> bool {
        self.scheduled.iter().any(|(held, _)| held == key)
    }
    pub fn remember(&mut self, key: JsString, session: JsString) {
        if let Some((_, owner)) = self.scheduled.iter_mut().find(|(held, _)| held == &key) {
            *owner = session;
        } else {
            self.scheduled.push_back((key, session));
        }
        if self.scheduled.len() > MAX_HANDOFF_KEYS {
            self.scheduled.pop_front();
        }
    }
    pub fn forget(&mut self, key: &JsString) {
        self.scheduled.retain(|(held, _)| held != key);
    }
    pub fn clear_session(&mut self, session: &JsString) {
        self.scheduled.retain(|(_, owner)| owner != session);
    }
}
