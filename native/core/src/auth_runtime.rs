//! The one live credential/shutdown/ticket owner, shared by the addon and the
//! front door. Opaque host metadata stays in the VM; wire metadata is plain JSON.
use crate::auth_security::{self as auth, WsTickets};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub enum Metadata {
    Host(u64),
    Wire(Value),
    Native(crate::js::JsValue),
}

pub struct AuthRuntime {
    pub secret: String,
    pub shutting_down: bool,
    pub revision: u64,
    pub tickets: WsTickets<Metadata>,
    pub retired: Vec<u64>,
}

#[derive(Serialize, Deserialize)]
pub struct Snapshot {
    pub secret: String,
    pub shutting_down: bool,
    pub revision: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Snapshot,
    IssueTicket {
        revision: u64,
        path: String,
        metadata: Value,
    },
    /// Redeem a one-use ticket for `path`. The gateway is the only consumer of
    /// the paths it hosts itself; Node keeps redeeming through the addon for
    /// the rest, so a path must never be consumed on both sides.
    ConsumeTicket {
        ticket: String,
        path: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    Snapshot(Snapshot),
    Ticket {
        ticket: String,
        path: String,
        expires_at: f64,
    },
    /// Metadata that can cross the private control stream.
    Redeemed {
        path: String,
        expires_at: f64,
        metadata: Value,
    },
    Stale,
    Invalid,
}

impl AuthRuntime {
    pub fn new(secret: String) -> Self {
        Self {
            secret,
            shutting_down: false,
            revision: 0,
            tickets: WsTickets::default(),
            retired: Vec::new(),
        }
    }
    /// Keep every accepted credential representable by the bounded private
    /// protocol. Reject before mutation so persistThenApply can roll back.
    pub fn validate_secret(secret: &str) -> Result<(), &'static str> {
        let snapshot = Response::Snapshot(Snapshot {
            secret: secret.into(),
            shutting_down: false,
            revision: u64::MAX,
        });
        if serde_json::to_vec(&snapshot)
            .map_or(true, |bytes| bytes.len() > crate::auth_control::MAX_FRAME)
        {
            Err("access token exceeds authentication control frame limit")
        } else {
            Ok(())
        }
    }
    pub fn set_secret(&mut self, secret: String) -> Result<(), &'static str> {
        Self::validate_secret(&secret)?;
        self.secret = secret;
        self.revision = self.revision.wrapping_add(1);
        Ok(())
    }
    pub fn retire(&mut self, metadata: Metadata) {
        if let Metadata::Host(slot) = metadata {
            self.retired.push(slot);
        }
    }
    pub fn prune(&mut self, now: f64, max: usize) {
        for metadata in self.tickets.prune(now, max) {
            self.retire(metadata);
        }
    }
    pub fn respond(&mut self, request: Request) -> Response {
        match request {
            Request::Snapshot => Response::Snapshot(Snapshot {
                secret: self.secret.clone(),
                shutting_down: self.shutting_down,
                revision: self.revision,
            }),
            Request::IssueTicket {
                revision,
                path,
                metadata,
            } => {
                if !metadata.is_object() {
                    return Response::Invalid;
                }
                self.issue_ticket(revision, &path, Metadata::Wire(metadata))
            }
            Request::ConsumeTicket { ticket, path } => {
                self.consume_ticket(&ticket, &path, now_ms())
            }
        }
    }

    /// The addon's `consume_ws_ticket` rules for a ticket redeemed over the wire:
    /// the record leaves the table before the clock and scope checks, so a
    /// wrong-scope or expired attempt still spends it. Only wire metadata
    /// crosses the stream. Native workspace-sharing metadata is converted to
    /// JSON only when it survives the conversion without loss; a ticket whose
    /// metadata lives in the JS VM is spent and refused, never handed over
    /// half-formed.
    pub fn consume_ticket(&mut self, ticket: &str, path: &str, now: f64) -> Response {
        if ticket.is_empty() {
            return Response::Invalid;
        }
        let Some(scope) = auth::normalize_ws_path(path) else {
            return Response::Invalid;
        };
        let Some(record) = self.tickets.take(ticket) else {
            return Response::Invalid;
        };
        let metadata = match record.metadata {
            Metadata::Wire(value) => Some(value),
            Metadata::Native(value) => {
                let encoded = crate::js::serde::to_serde(&value);
                (crate::js::serde::from_serde(&encoded) == value).then_some(encoded)
            }
            other => {
                self.retire(other);
                None
            }
        };
        if record.expires_at <= now || record.path != scope {
            return Response::Invalid;
        }
        match metadata {
            Some(metadata) => Response::Redeemed {
                path: record.path,
                expires_at: record.expires_at,
                metadata,
            },
            None => Response::Invalid,
        }
    }

    /// Native callers share the existing ticket table without a JSON round trip.
    pub fn issue_ticket(&mut self, revision: u64, path: &str, metadata: Metadata) -> Response {
        if revision != self.revision || self.shutting_down {
            return Response::Stale;
        }
        let Some(path) = auth::normalize_ws_path(path) else {
            return Response::Invalid;
        };
        let Ok(ticket) = auth::random_base64url(24) else {
            return Response::Invalid;
        };
        let now = now_ms();
        self.prune(now, auth::MAX_TICKETS);
        let expires_at = now + auth::TICKET_TTL_MS as f64;
        if let Some(old) = self
            .tickets
            .insert(&ticket, path.clone(), expires_at, metadata)
        {
            self.retire(old);
        }
        Response::Ticket {
            ticket,
            path,
            expires_at,
        }
    }
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ticket_issue_is_atomic_with_rotation_and_shutdown() {
        let mut state = AuthRuntime::new("old".into());
        let issue = |revision| Request::IssueTicket {
            revision,
            path: "/ws/test".into(),
            metadata: json!({"requestId":"r"}),
        };
        state.set_secret("new".into()).unwrap();
        assert!(state
            .set_secret("x".repeat(crate::auth_control::MAX_FRAME))
            .is_err());
        assert_eq!(state.secret, "new");
        assert!(matches!(state.respond(issue(0)), Response::Stale));
        assert_eq!(state.tickets.len(), 0);
        let Response::Ticket { ticket, .. } = state.respond(issue(1)) else {
            panic!("ticket refused")
        };
        let record = state.tickets.take(&ticket).unwrap();
        assert_eq!(record.path, "/ws/test");
        assert!(state.tickets.take(&ticket).is_none());
        state.shutting_down = true;
        assert!(matches!(state.respond(issue(1)), Response::Stale));
        assert_eq!(state.tickets.len(), 0);
    }

    #[test]
    fn a_ticket_is_redeemed_once_with_its_wire_metadata() {
        let mut state = AuthRuntime::new("s".into());
        let mint = |state: &mut AuthRuntime, path: &str| {
            let Response::Ticket { ticket, .. } = state.respond(Request::IssueTicket {
                revision: 0,
                path: path.into(),
                metadata: json!({"machineId":"m1","upstream":{"path":"/ws/x"}}),
            }) else {
                panic!("ticket refused")
            };
            ticket
        };
        let consume = |state: &mut AuthRuntime, ticket: &str, path: &str| {
            state.respond(Request::ConsumeTicket {
                ticket: ticket.into(),
                path: path.into(),
            })
        };
        let ticket = mint(&mut state, "/ws/machines/m1");
        let Response::Redeemed {
            path,
            expires_at,
            metadata,
        } = consume(&mut state, &ticket, "/ws/machines/m1")
        else {
            panic!("not redeemed")
        };
        assert_eq!(path, "/ws/machines/m1");
        assert!(expires_at > now_ms());
        assert_eq!(metadata["machineId"], "m1");
        // One use: the second attempt, with the right path, finds nothing.
        assert!(matches!(
            consume(&mut state, &ticket, "/ws/machines/m1"),
            Response::Invalid
        ));
        // A wrong-scope attempt still spends the ticket.
        let ticket = mint(&mut state, "/ws/machines/m1");
        assert!(matches!(
            consume(&mut state, &ticket, "/ws/machines/m2"),
            Response::Invalid
        ));
        assert!(matches!(
            consume(&mut state, &ticket, "/ws/machines/m1"),
            Response::Invalid
        ));
        // Empty and malformed inputs fail closed without touching the table.
        let spare = mint(&mut state, "/ws/machines/m1");
        assert!(matches!(
            consume(&mut state, "", "/ws/machines/m1"),
            Response::Invalid
        ));
        assert!(matches!(
            consume(&mut state, &spare, "https://elsewhere.example/ws"),
            Response::Invalid
        ));
        assert_eq!(state.tickets.len(), 1);
    }

    #[test]
    fn an_expired_ticket_is_spent_and_refused() {
        let mut state = AuthRuntime::new("s".into());
        let Response::Ticket { ticket, .. } = state.respond(Request::IssueTicket {
            revision: 0,
            path: "/ws/machines/m1".into(),
            metadata: json!({}),
        }) else {
            panic!("ticket refused")
        };
        let late = now_ms() + auth::TICKET_TTL_MS as f64 + 1.0;
        assert!(matches!(
            state.consume_ticket(&ticket, "/ws/machines/m1", late),
            Response::Invalid
        ));
        assert_eq!(state.tickets.len(), 0);
    }

    #[test]
    fn native_workspace_scope_is_redeemed_over_the_wire() {
        let mut state = AuthRuntime::new("s".into());
        let Response::Ticket { ticket, .. } = state.issue_ticket(
            0,
            "/ws/chat",
            Metadata::Native(crate::js::JsValue::object(vec![(
                "fleetSessionId",
                "session-1".into(),
            )])),
        ) else {
            panic!("ticket refused")
        };
        let Response::Redeemed { metadata, .. } =
            state.consume_ticket(&ticket, "/ws/chat", now_ms())
        else {
            panic!("native scope was not redeemed")
        };
        assert_eq!(metadata, json!({"fleetSessionId":"session-1"}));
    }

    #[test]
    fn lossy_native_scope_is_rejected_instead_of_changed() {
        use crate::js::{JsString, JsValue};
        let mut state = AuthRuntime::new("s".into());
        let scope = JsValue::String(JsString::from_units(vec![0xd800]));
        let Response::Ticket { ticket, .. } = state.issue_ticket(
            0,
            "/ws/chat",
            Metadata::Native(JsValue::object(vec![("fleetSessionId", scope)])),
        ) else {
            panic!("ticket refused")
        };
        assert!(matches!(
            state.consume_ticket(&ticket, "/ws/chat", now_ms()),
            Response::Invalid
        ));
        assert_eq!(state.tickets.len(), 0);
    }

    #[test]
    fn a_vm_held_ticket_is_spent_retired_and_never_redeemed_over_the_wire() {
        let mut state = AuthRuntime::new("s".into());
        state.tickets.insert(
            "host-ticket",
            "/ws/machines/m1".into(),
            now_ms() + 60_000.0,
            Metadata::Host(7),
        );
        assert!(matches!(
            state.respond(Request::ConsumeTicket {
                ticket: "host-ticket".into(),
                path: "/ws/machines/m1".into()
            }),
            Response::Invalid
        ));
        assert_eq!(state.tickets.len(), 0);
        // The slot goes back to the VM through the same retirement list.
        assert_eq!(state.retired, vec![7]);
    }

    #[test]
    fn gateway_pruning_retires_host_references_in_the_same_capacity_budget() {
        let mut state = AuthRuntime::new(String::new());
        for i in 0..auth::MAX_TICKETS {
            state.tickets.insert(
                &i.to_string(),
                "/ws/test".into(),
                now_ms() + 60_000.0,
                Metadata::Host(i as u64),
            );
        }
        assert!(matches!(
            state.respond(Request::IssueTicket {
                revision: 0,
                path: "/ws/test".into(),
                metadata: json!({})
            }),
            Response::Ticket { .. }
        ));
        assert_eq!(state.retired, vec![0]);
        assert_eq!(state.tickets.len(), auth::MAX_TICKETS);
        assert!(state.tickets.take("0").is_none());
    }
}
