//! Ordered native vault ownership. Host values are opaque handles: returning an
//! entry must retain its identity, while the store and all mutation decisions
//! remain native. Never hold a store borrow while calling host code.
use crate::js::JsString;
use sha2::{Digest, Sha256};
pub const NAME: &str = "^[A-Za-z_][A-Za-z0-9_]{0,63}$";
pub const LEGACY_NAME: &str = "^[A-Za-z0-9_.-]{1,64}$";
pub const NAME_RULE: &str = "name must be a valid env var identifier ([A-Za-z_][A-Za-z0-9_]*, 1-64 chars) so it can be injected as $NAME";
pub const MAX_ENTRIES: usize = 500;
pub const MAX_VALUE: usize = 64 * 1024;
pub const EXCLUDED: [&str; 5] = ["ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "MULTICC_"];
pub struct Store<T> {
    rows: Vec<(JsString, T, u64)>,
    serial: u64,
}
impl<T: Clone> Default for Store<T> {
    fn default() -> Self {
        Self {
            rows: Vec::new(),
            serial: 0,
        }
    }
}
impl<T: Clone> Store<T> {
    pub fn entries(&self) -> Vec<(JsString, T)> {
        self.rows
            .iter()
            .map(|(name, value, _)| (name.clone(), value.clone()))
            .collect()
    }
    pub fn get(&self, name: &JsString) -> Option<T> {
        self.rows
            .iter()
            .find(|(n, _, _)| n == name)
            .map(|(_, value, _)| value.clone())
    }
    pub fn len(&self) -> usize {
        self.rows.len()
    }
    pub fn insert(&mut self, name: JsString, value: T) {
        if let Some((_, existing, _)) = self.rows.iter_mut().find(|(n, _, _)| *n == name) {
            *existing = value;
        } else {
            self.serial = self.serial.saturating_add(1);
            self.rows.push((name, value, self.serial));
        }
    }
    pub fn remove(&mut self, name: &JsString) {
        self.rows.retain(|(n, _, _)| n != name);
    }
    pub fn clear(&mut self) {
        self.rows.clear();
    }
    /// A live Map iterator may observe entries inserted by an entry getter.
    /// Return a clone before entering V8 so no native borrow spans re-entry.
    pub fn next_after(&self, cursor: u64) -> Option<(u64, JsString, T)> {
        self.rows
            .iter()
            .find(|(_, _, serial)| *serial > cursor)
            .map(|(name, value, serial)| (*serial, name.clone(), value.clone()))
    }
}
pub fn digest(parts: &[(JsString, JsString)]) -> String {
    if parts.is_empty() {
        return String::new();
    }
    let mut hash = Sha256::new();
    for (name, value) in parts {
        hash.update(name.utf8_lossy_bytes());
        hash.update([0]);
        hash.update(value.utf8_lossy_bytes());
        hash.update([0]);
    }
    format!("{:x}", hash.finalize())
}
