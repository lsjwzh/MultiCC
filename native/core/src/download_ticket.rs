//! Download tickets: short-lived capabilities that open exactly one
//! `/api/download` target for clients that cannot attach `X-Access-Token`
//! (the Flutter App's image and file viewers).
//!
//! Was `issueDownloadTicket` / `verifyDownloadTicket` /
//! `normalizeDownloadTarget` in src/auth-security.js and the route
//! `POST /api/auth/download-ticket` in src/routes/auth.js; the store now lives
//! in the Rust front door, the only process that issues and checks them.
//!
//! One difference: Node capped WebSocket and download tickets together at
//! 2048; WebSocket tickets stayed in Node, so this cap counts download
//! tickets only.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use url::Url;

/// `DEFAULT_TICKET_TTL_MS`.
pub const TICKET_TTL_MS: i64 = 30 * 1000;
/// `maxTickets`.
pub const MAX_TICKETS: usize = 2048;

const BASE: &str = "http://multicc.local";
const TARGET_PATH: &str = "/api/download";

/// `normalizeDownloadTarget(value)`: the canonical
/// `/api/download?path=…[&inline=1]` a ticket is bound to, or `None` when
/// `value` is not exactly one download target.
pub fn normalize_download_target(value: &str) -> Option<String> {
    let base = Url::parse(BASE).ok()?;
    let parsed = base.join(value).ok()?;
    if parsed.origin().ascii_serialization() != BASE || parsed.path() != TARGET_PATH {
        return None;
    }
    let mut paths = Vec::new();
    let mut inline = Vec::new();
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "path" => paths.push(value.into_owned()),
            "inline" => inline.push(value.into_owned()),
            "download_ticket" => {}
            _ => return None,
        }
    }
    if paths.len() != 1 || paths[0].is_empty() || paths[0].contains('\0') || inline.len() > 1 {
        return None;
    }
    if inline.first().is_some_and(|value| value != "1") {
        return None;
    }
    Some(target(&paths[0], !inline.is_empty()))
}

/// `/api/download?${new URLSearchParams({ path })}` plus `inline=1`.
pub fn target(path: &str, inline: bool) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("path", path);
    if inline {
        query.append_pair("inline", "1");
    }
    format!("{TARGET_PATH}?{}", query.finish())
}

fn hash(ticket: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(ticket.as_bytes()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issued {
    pub ticket: String,
    pub expires_at: i64,
    pub target: String,
}

struct Record {
    hash: String,
    target: String,
    expires_at: i64,
}

/// The ticket map, oldest first (JS `Map` insertion order).
#[derive(Default)]
pub struct DownloadTickets {
    records: Vec<Record>,
}

impl DownloadTickets {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    fn prune(&mut self, now: i64) {
        self.records.retain(|record| record.expires_at > now);
        while self.records.len() >= MAX_TICKETS {
            self.records.remove(0);
        }
    }

    /// `issueDownloadTicket(target)` with `randomBytes(24)` supplied, so
    /// tests are deterministic. `None` = the TypeError Node threw.
    pub fn issue_with(&mut self, target: &str, now: i64, random: [u8; 24]) -> Option<Issued> {
        let scope = normalize_download_target(target)?;
        self.prune(now);
        let ticket = URL_SAFE_NO_PAD.encode(random);
        let expires_at = now + TICKET_TTL_MS;
        self.records.push(Record {
            hash: hash(&ticket),
            target: scope.clone(),
            expires_at,
        });
        Some(Issued {
            ticket,
            expires_at,
            target: scope,
        })
    }

    pub fn issue(&mut self, target: &str, now: i64) -> Option<Issued> {
        let mut random = [0u8; 24];
        getrandom::fill(&mut random).expect("the OS random source is available");
        self.issue_with(target, now, random)
    }

    /// `verifyDownloadTicket(ticket, req.originalUrl)`. A ticket stays
    /// usable until it expires (range/retry requests reuse it).
    pub fn verify(&mut self, ticket: &str, original_url: &str, now: i64) -> bool {
        if ticket.is_empty() {
            return false;
        }
        let Some(scope) = normalize_download_target(original_url) else {
            return false;
        };
        let hashed = hash(ticket);
        let Some(index) = self.records.iter().position(|record| record.hash == hashed) else {
            return false;
        };
        if self.records[index].expires_at <= now {
            self.records.remove(index);
            return false;
        }
        self.records[index].target == scope
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_normalize_like_node() {
        // Expected values come from src/auth-security.js normalizeDownloadTarget
        // (Node 26) on the same inputs.
        let cases: &[(&str, Option<&str>)] = &[
            (
                "/api/download?path=%2Fa%2Fb.png",
                Some("/api/download?path=%2Fa%2Fb.png"),
            ),
            (
                "/api/download?path=/a/b c.png&inline=1",
                Some("/api/download?path=%2Fa%2Fb+c.png&inline=1"),
            ),
            (
                "/api/download?inline=1&path=%2Fx",
                Some("/api/download?path=%2Fx&inline=1"),
            ),
            (
                "/api/download?path=%2Fx&download_ticket=abc",
                Some("/api/download?path=%2Fx"),
            ),
            (
                "/api/download?path=%E4%B8%AD%E6%96%87.png",
                Some("/api/download?path=%E4%B8%AD%E6%96%87.png"),
            ),
            (
                "/api/download?path=a*b-c._~!'()",
                Some("/api/download?path=a*b-c._%7E%21%27%28%29"),
            ),
            (
                "/api/download?path=%FF",
                Some("/api/download?path=%EF%BF%BD"),
            ),
            ("/api/./download?path=%2Fx", Some("/api/download?path=%2Fx")),
            ("/api/download?path=%2Fx&inline=0", None),
            ("/api/download?path=%2Fx&inline=1&inline=1", None),
            ("/api/download?path=a&path=b", None),
            ("/api/download?path=", None),
            ("/api/download?path=a%00b", None),
            ("/api/download?path=%2Fx&extra=1", None),
            ("/api/download?path=%2Fx&=1", None),
            ("/api/download", None),
            ("/api/Download?path=%2Fx", None),
            ("/api/%64ownload?path=%2Fx", None),
            ("//evil.example/api/download?path=%2Fx", None),
            ("https://multicc.local/api/download?path=%2Fx", None),
            (
                "http://multicc.local/api/download?path=%2Fx",
                Some("/api/download?path=%2Fx"),
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(
                normalize_download_target(input).as_deref(),
                *expected,
                "{input}"
            );
        }
    }

    #[test]
    fn a_ticket_opens_its_target_until_it_expires() {
        let mut store = DownloadTickets::new();
        let issued = store
            .issue_with("/api/download?path=%2Fa", 1_000, [7; 24])
            .unwrap();
        assert_eq!(issued.ticket, "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH");
        assert_eq!(issued.expires_at, 31_000);
        assert_eq!(issued.target, "/api/download?path=%2Fa");
        let url = format!("/api/download?path=%2Fa&download_ticket={}", issued.ticket);
        assert!(store.verify(&issued.ticket, &url, 2_000));
        assert!(
            store.verify(&issued.ticket, &url, 3_000),
            "reusable within the TTL"
        );
        // Wrong scope: refused, but the ticket survives.
        assert!(!store.verify(&issued.ticket, "/api/download?path=%2Fb", 3_000));
        assert!(!store.verify(&issued.ticket, &format!("{url}&inline=1"), 3_000));
        assert_eq!(store.len(), 1);
        assert!(!store.verify("other", &url, 3_000));
        assert!(!store.verify("", &url, 3_000));
        // Expired: refused and dropped.
        assert!(!store.verify(&issued.ticket, &url, 31_000));
        assert!(store.is_empty());
    }

    // Ported from tests/test-security-observability.js (the Node test went
    // with the Node implementation).
    #[test]
    fn the_scope_ignores_order_and_the_ticket_but_not_extra_keys() {
        let mut store = DownloadTickets::new();
        let target = "/api/download?path=%2Ftmp%2Freport+one.pdf&inline=1";
        let issued = store.issue_with(target, 0, [1; 24]).unwrap();
        assert_eq!(issued.target, target);
        let ticket = &issued.ticket;
        assert!(store.verify(ticket, &format!("{target}&download_ticket={ticket}"), 1));
        let reordered = "/api/download?inline=1&path=%2Ftmp%2Freport+one.pdf&download_ticket=x";
        assert!(store.verify(ticket, reordered, 1));
        let other = "/api/download?path=%2Ftmp%2Fother.pdf&inline=1&download_ticket=x";
        assert!(!store.verify(ticket, other, 1));
        assert!(!store.verify(ticket, &format!("{target}&token=secret"), 1));
        assert!(!store.verify(ticket, target, TICKET_TTL_MS + 1));
    }

    #[test]
    fn invalid_targets_issue_nothing_and_the_cap_drops_the_oldest() {
        let mut store = DownloadTickets::new();
        assert!(store
            .issue_with("/api/download?path=", 0, [0; 24])
            .is_none());
        assert!(store
            .issue_with("/api/other?path=%2Fa", 0, [0; 24])
            .is_none());
        for index in 0..MAX_TICKETS + 5 {
            let mut random = [0u8; 24];
            random[..8].copy_from_slice(&(index as u64).to_le_bytes());
            store
                .issue_with("/api/download?path=%2Fa", 0, random)
                .unwrap();
        }
        assert_eq!(store.len(), MAX_TICKETS);
        let first = URL_SAFE_NO_PAD.encode([0u8; 24]);
        assert!(!store.verify(&first, "/api/download?path=%2Fa", 1));
        let mut last = [0u8; 24];
        last[..8].copy_from_slice(&((MAX_TICKETS + 4) as u64).to_le_bytes());
        assert!(store.verify(&URL_SAFE_NO_PAD.encode(last), "/api/download?path=%2Fa", 1));
        // Expired entries are pruned on the next issue.
        store
            .issue_with("/api/download?path=%2Fa", TICKET_TTL_MS, [9; 24])
            .unwrap();
        assert_eq!(store.len(), 1);
    }
}
