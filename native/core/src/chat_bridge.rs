//! Wire codec for the front door <-> Node chat bridge.
//!
//! The front door terminates every `/ws/chat` client socket (handshake, close
//! semantics, ping/pong, the bytes on the wire). While the chat engine still
//! lives in Node, the engine sees each client as a virtual socket reached over
//! one private, mutually authenticated loopback stream. This module is the
//! frame grammar of that stream, and nothing else: no I/O, no state.
//!
//! A frame on the stream is `u32 BE length` followed by that many body bytes.
//! The body starts with a kind byte, then a `u32 BE` connection id, then the
//! kind's fields. Connection ids are allocated by the front door, one per
//! accepted client socket, and are never reused within a bridge generation.
//!
//! Front door -> Node
//! - `0x01 Open`    `info`: JSON (`OpenInfo`), the request the client made.
//! - `0x02 Message` `u8 binary`, payload: one complete client message.
//! - `0x03 Pong`    a pong control frame arrived from the client.
//! - `0x04 Closed`  `u16 code`, `u8 flags` (bit0 close frame received, bit1
//!   close frame sent), reason: the socket is gone. The final frame for an id.
//! - `0x05 Sent`    `u32 seq`, `u8 status` (0 written, 1 failed), message: the
//!   completion of one `Send`, in the order the sends were issued.
//!
//! Node -> front door
//! - `0x11 Send`      `u32 seq`, `u8 flags` (bit0 binary), payload.
//! - `0x12 Close`     `u16 code` (0 = no status), reason: start the close
//!   handshake.
//! - `0x13 Terminate` drop the socket without a close frame.
//! - `0x14 Ping`      send a ping control frame.
//!
//! The grammar is deliberately strict: an unknown kind, a short body or a body
//! with bytes left over is an error, never a best-effort parse. Either end
//! treats an error as the loss of the whole bridge.
use serde::{Deserialize, Serialize};

/// Largest body either side will build or accept. Client messages are capped
/// at 100 MiB by the socket layer; the margin covers the fixed fields.
pub const MAX_BODY: usize = 100 * 1024 * 1024 + 1024;

pub const KIND_OPEN: u8 = 0x01;
pub const KIND_MESSAGE: u8 = 0x02;
pub const KIND_PONG: u8 = 0x03;
pub const KIND_CLOSED: u8 = 0x04;
pub const KIND_SENT: u8 = 0x05;
pub const KIND_SEND: u8 = 0x11;
pub const KIND_CLOSE: u8 = 0x12;
pub const KIND_TERMINATE: u8 = 0x13;
pub const KIND_PING: u8 = 0x14;

/// The request a client made, as the Node connection router needs to see it.
/// Header names are lower case and values are already joined the way Node's
/// `IncomingMessage.headers` joins repeated headers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInfo {
    /// Path and query exactly as received (`req.url`).
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub remote_address: String,
    pub remote_port: u16,
    pub local_address: String,
    pub local_port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToNode {
    Open {
        conn: u32,
        info: OpenInfo,
    },
    Message {
        conn: u32,
        binary: bool,
        data: Vec<u8>,
    },
    Pong {
        conn: u32,
    },
    Closed {
        conn: u32,
        code: u16,
        received: bool,
        sent: bool,
        reason: String,
    },
    Sent {
        conn: u32,
        seq: u32,
        error: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToGateway {
    Send {
        conn: u32,
        seq: u32,
        binary: bool,
        data: Vec<u8>,
    },
    Close {
        conn: u32,
        code: Option<u16>,
        reason: String,
    },
    Terminate {
        conn: u32,
    },
    Ping {
        conn: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    Empty,
    UnknownKind(u8),
    Truncated,
    TrailingBytes,
    BadFlag,
    BadUtf8,
    BadJson,
}

struct Reader<'a> {
    rest: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        if self.rest.len() < n {
            return Err(DecodeError::Truncated);
        }
        let (head, tail) = self.rest.split_at(n);
        self.rest = tail;
        Ok(head)
    }
    fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, DecodeError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Result<u32, DecodeError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn remaining(&mut self) -> &'a [u8] {
        std::mem::take(&mut self.rest)
    }
    fn finish(self) -> Result<(), DecodeError> {
        if self.rest.is_empty() {
            Ok(())
        } else {
            Err(DecodeError::TrailingBytes)
        }
    }
}

fn flag(byte: u8) -> Result<bool, DecodeError> {
    match byte {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(DecodeError::BadFlag),
    }
}

fn text(bytes: &[u8]) -> Result<String, DecodeError> {
    String::from_utf8(bytes.to_vec()).map_err(|_| DecodeError::BadUtf8)
}

fn start(kind: u8, conn: u32, capacity: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + capacity);
    out.push(kind);
    out.extend_from_slice(&conn.to_be_bytes());
    out
}

impl ToNode {
    pub fn encode(&self) -> Vec<u8> {
        match self {
            ToNode::Open { conn, info } => {
                let json = serde_json::to_vec(info).expect("OpenInfo serializes");
                let mut out = start(KIND_OPEN, *conn, json.len());
                out.extend_from_slice(&json);
                out
            }
            ToNode::Message { conn, binary, data } => {
                let mut out = start(KIND_MESSAGE, *conn, 1 + data.len());
                out.push(u8::from(*binary));
                out.extend_from_slice(data);
                out
            }
            ToNode::Pong { conn } => start(KIND_PONG, *conn, 0),
            ToNode::Closed {
                conn,
                code,
                received,
                sent,
                reason,
            } => {
                let mut out = start(KIND_CLOSED, *conn, 3 + reason.len());
                out.extend_from_slice(&code.to_be_bytes());
                out.push(u8::from(*received) | (u8::from(*sent) << 1));
                out.extend_from_slice(reason.as_bytes());
                out
            }
            ToNode::Sent { conn, seq, error } => {
                let message = error.as_deref().unwrap_or("");
                let mut out = start(KIND_SENT, *conn, 5 + message.len());
                out.extend_from_slice(&seq.to_be_bytes());
                out.push(u8::from(error.is_some()));
                out.extend_from_slice(message.as_bytes());
                out
            }
        }
    }

    pub fn decode(body: &[u8]) -> Result<ToNode, DecodeError> {
        let (&kind, rest) = body.split_first().ok_or(DecodeError::Empty)?;
        let mut r = Reader { rest };
        let frame = match kind {
            KIND_OPEN => {
                let conn = r.u32()?;
                let info =
                    serde_json::from_slice(r.remaining()).map_err(|_| DecodeError::BadJson)?;
                return Ok(ToNode::Open { conn, info });
            }
            KIND_MESSAGE => {
                let conn = r.u32()?;
                let binary = flag(r.u8()?)?;
                ToNode::Message {
                    conn,
                    binary,
                    data: r.remaining().to_vec(),
                }
            }
            KIND_PONG => ToNode::Pong { conn: r.u32()? },
            KIND_CLOSED => {
                let conn = r.u32()?;
                let code = r.u16()?;
                let flags = r.u8()?;
                if flags > 3 {
                    return Err(DecodeError::BadFlag);
                }
                ToNode::Closed {
                    conn,
                    code,
                    received: flags & 1 != 0,
                    sent: flags & 2 != 0,
                    reason: text(r.remaining())?,
                }
            }
            KIND_SENT => {
                let conn = r.u32()?;
                let seq = r.u32()?;
                let failed = flag(r.u8()?)?;
                let message = text(r.remaining())?;
                ToNode::Sent {
                    conn,
                    seq,
                    error: failed.then_some(message),
                }
            }
            other => return Err(DecodeError::UnknownKind(other)),
        };
        r.finish()?;
        Ok(frame)
    }

    pub fn conn(&self) -> u32 {
        match self {
            ToNode::Open { conn, .. }
            | ToNode::Message { conn, .. }
            | ToNode::Pong { conn }
            | ToNode::Closed { conn, .. }
            | ToNode::Sent { conn, .. } => *conn,
        }
    }
}

impl ToGateway {
    pub fn encode(&self) -> Vec<u8> {
        match self {
            ToGateway::Send {
                conn,
                seq,
                binary,
                data,
            } => {
                let mut out = start(KIND_SEND, *conn, 5 + data.len());
                out.extend_from_slice(&seq.to_be_bytes());
                out.push(u8::from(*binary));
                out.extend_from_slice(data);
                out
            }
            ToGateway::Close { conn, code, reason } => {
                let mut out = start(KIND_CLOSE, *conn, 2 + reason.len());
                out.extend_from_slice(&code.unwrap_or(0).to_be_bytes());
                out.extend_from_slice(reason.as_bytes());
                out
            }
            ToGateway::Terminate { conn } => start(KIND_TERMINATE, *conn, 0),
            ToGateway::Ping { conn } => start(KIND_PING, *conn, 0),
        }
    }

    pub fn decode(body: &[u8]) -> Result<ToGateway, DecodeError> {
        let (&kind, rest) = body.split_first().ok_or(DecodeError::Empty)?;
        let mut r = Reader { rest };
        let frame = match kind {
            KIND_SEND => {
                let conn = r.u32()?;
                let seq = r.u32()?;
                let binary = flag(r.u8()?)?;
                ToGateway::Send {
                    conn,
                    seq,
                    binary,
                    data: r.remaining().to_vec(),
                }
            }
            KIND_CLOSE => {
                let conn = r.u32()?;
                let code = r.u16()?;
                ToGateway::Close {
                    conn,
                    code: (code != 0).then_some(code),
                    reason: text(r.remaining())?,
                }
            }
            KIND_TERMINATE => ToGateway::Terminate { conn: r.u32()? },
            KIND_PING => ToGateway::Ping { conn: r.u32()? },
            other => return Err(DecodeError::UnknownKind(other)),
        };
        r.finish()?;
        Ok(frame)
    }

    pub fn conn(&self) -> u32 {
        match self {
            ToGateway::Send { conn, .. }
            | ToGateway::Close { conn, .. }
            | ToGateway::Terminate { conn }
            | ToGateway::Ping { conn } => *conn,
        }
    }
}

/// `u32 BE length` + body, ready to write to the stream.
pub fn frame(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    out
}

/// The corpus both implementations are checked against: every kind, the field
/// edges (empty and multi-byte text, both flag states, the largest ids and
/// codes) and the payload edges. `tests/fixtures/chat-bridge-corpus.json` is
/// generated from this list; the Node client asserts it byte for byte.
pub fn corpus() -> (Vec<ToNode>, Vec<ToGateway>) {
    let info = |url: &str, headers: Vec<(&str, &str)>| OpenInfo {
        url: url.into(),
        headers: headers
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        remote_address: "203.0.113.9".into(),
        remote_port: 51234,
        local_address: "127.0.0.1".into(),
        local_port: 8080,
    };
    let payloads: [&[u8]; 4] = [
        b"",
        b"{\"type\":\"ping\"}",
        "\u{4e2d}\u{6587}".as_bytes(),
        &[0, 255, 1, 254],
    ];
    let mut to_node = vec![
        ToNode::Open {
            conn: 1,
            info: info(
                "/ws/chat?session=s",
                vec![("host", "x"), ("cookie", "a=1; b=2")],
            ),
        },
        ToNode::Open {
            conn: u32::MAX,
            info: info("/ws/chat", vec![]),
        },
        ToNode::Pong { conn: 0 },
        ToNode::Pong { conn: u32::MAX },
    ];
    for (i, payload) in payloads.iter().enumerate() {
        to_node.push(ToNode::Message {
            conn: i as u32,
            binary: i % 2 == 1,
            data: payload.to_vec(),
        });
    }
    for (code, received, sent, reason) in [
        (1000_u16, true, true, "bye"),
        (1005, true, false, ""),
        (1006, false, false, ""),
        (4003, true, true, "\u{7535}\u{8111}\u{6388}\u{6743}"),
        (u16::MAX, false, true, "x"),
    ] {
        to_node.push(ToNode::Closed {
            conn: 7,
            code,
            received,
            sent,
            reason: reason.into(),
        });
    }
    to_node.push(ToNode::Sent {
        conn: 7,
        seq: 0,
        error: None,
    });
    to_node.push(ToNode::Sent {
        conn: 7,
        seq: u32::MAX,
        error: Some("write failed".into()),
    });
    let mut to_gateway = Vec::new();
    for (i, payload) in payloads.iter().enumerate() {
        to_gateway.push(ToGateway::Send {
            conn: 9,
            seq: i as u32,
            binary: i % 2 == 0,
            data: payload.to_vec(),
        });
    }
    to_gateway.push(ToGateway::Close {
        conn: 9,
        code: None,
        reason: String::new(),
    });
    to_gateway.push(ToGateway::Close {
        conn: 9,
        code: Some(4003),
        reason: "Forbidden".into(),
    });
    to_gateway.push(ToGateway::Close {
        conn: u32::MAX,
        code: Some(1012),
        reason: "server shutting down".into(),
    });
    to_gateway.push(ToGateway::Terminate { conn: 9 });
    to_gateway.push(ToGateway::Ping { conn: 9 });
    (to_node, to_gateway)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_corpus_frame_round_trips_and_re_encodes_identically() {
        let (to_node, to_gateway) = corpus();
        assert!(to_node.len() >= 14 && to_gateway.len() >= 8);
        for original in to_node {
            let body = original.encode();
            let decoded = ToNode::decode(&body).expect("decodes");
            assert_eq!(decoded, original);
            assert_eq!(decoded.encode(), body);
            assert_eq!(decoded.conn(), original.conn());
        }
        for original in to_gateway {
            let body = original.encode();
            let decoded = ToGateway::decode(&body).expect("decodes");
            assert_eq!(decoded, original);
            assert_eq!(decoded.encode(), body);
        }
    }

    #[test]
    fn every_strict_prefix_of_a_fixed_field_frame_is_rejected() {
        let (to_node, to_gateway) = corpus();
        for original in &to_node {
            let body = original.encode();
            // Open and Message carry a variable tail, so only the fixed
            // prefix (kind + id + the fixed fields) must be present.
            let fixed = match original {
                ToNode::Open { .. } => 5,
                ToNode::Message { .. } => 6,
                ToNode::Pong { .. } => 5,
                ToNode::Closed { .. } => 8,
                ToNode::Sent { .. } => 10,
            };
            for len in 0..fixed {
                assert!(
                    ToNode::decode(&body[..len]).is_err(),
                    "{original:?} accepted a {len} byte prefix"
                );
            }
        }
        for original in &to_gateway {
            let body = original.encode();
            let fixed = match original {
                ToGateway::Send { .. } => 10,
                ToGateway::Close { .. } => 7,
                ToGateway::Terminate { .. } | ToGateway::Ping { .. } => 5,
            };
            for len in 0..fixed {
                assert!(
                    ToGateway::decode(&body[..len]).is_err(),
                    "{original:?} accepted a {len} byte prefix"
                );
            }
        }
    }

    #[test]
    fn fixed_length_frames_reject_trailing_bytes() {
        let mut longer = ToNode::Pong { conn: 3 }.encode();
        longer.push(0);
        assert_eq!(ToNode::decode(&longer), Err(DecodeError::TrailingBytes));
        for body in [
            ToGateway::Terminate { conn: 3 }.encode(),
            ToGateway::Ping { conn: 3 }.encode(),
        ] {
            let mut longer = body.clone();
            longer.push(0);
            assert_eq!(ToGateway::decode(&longer), Err(DecodeError::TrailingBytes));
        }
    }

    #[test]
    fn grammar_violations_are_errors_not_best_effort_parses() {
        assert_eq!(ToNode::decode(&[]), Err(DecodeError::Empty));
        assert_eq!(ToGateway::decode(&[]), Err(DecodeError::Empty));
        // A kind from the other direction is unknown here.
        let send = ToGateway::Ping { conn: 1 }.encode();
        assert_eq!(
            ToNode::decode(&send),
            Err(DecodeError::UnknownKind(KIND_PING))
        );
        let pong = ToNode::Pong { conn: 1 }.encode();
        assert_eq!(
            ToGateway::decode(&pong),
            Err(DecodeError::UnknownKind(KIND_PONG))
        );
        assert_eq!(
            ToNode::decode(&[0xff, 0, 0, 0, 1]),
            Err(DecodeError::UnknownKind(0xff))
        );
        // A flag byte is 0 or 1, never anything else.
        let mut message = ToNode::Message {
            conn: 1,
            binary: false,
            data: vec![],
        }
        .encode();
        message[5] = 2;
        assert_eq!(ToNode::decode(&message), Err(DecodeError::BadFlag));
        // Closed flags use two bits only.
        let mut closed = ToNode::Closed {
            conn: 1,
            code: 1000,
            received: true,
            sent: true,
            reason: String::new(),
        }
        .encode();
        closed[7] = 4;
        assert_eq!(ToNode::decode(&closed), Err(DecodeError::BadFlag));
        // Text fields must be UTF-8.
        let mut bad = ToNode::Closed {
            conn: 1,
            code: 1000,
            received: false,
            sent: false,
            reason: "x".into(),
        }
        .encode();
        *bad.last_mut().unwrap() = 0xff;
        assert_eq!(ToNode::decode(&bad), Err(DecodeError::BadUtf8));
        // Open carries JSON.
        let mut open = vec![KIND_OPEN, 0, 0, 0, 1];
        open.extend_from_slice(b"not json");
        assert_eq!(ToNode::decode(&open), Err(DecodeError::BadJson));
    }

    #[test]
    fn close_without_a_status_round_trips_as_none_and_zero_is_not_a_status() {
        let body = ToGateway::Close {
            conn: 2,
            code: None,
            reason: String::new(),
        }
        .encode();
        assert_eq!(&body[5..7], &[0, 0]);
        assert_eq!(
            ToGateway::decode(&body).unwrap(),
            ToGateway::Close {
                conn: 2,
                code: None,
                reason: String::new()
            }
        );
    }

    #[test]
    fn the_length_prefix_is_big_endian_and_counts_only_the_body() {
        let body = ToGateway::Ping { conn: 0x01020304 }.encode();
        let framed = frame(&body);
        assert_eq!(&framed[..4], &(body.len() as u32).to_be_bytes());
        assert_eq!(&framed[4..], &body[..]);
        assert_eq!(body, vec![KIND_PING, 1, 2, 3, 4]);
    }

    /// The Node client is checked against exactly these bytes. Regenerate with
    /// `UPDATE_CHAT_BRIDGE_CORPUS=1 cargo test -p multicc-core chat_bridge`.
    #[test]
    fn the_checked_in_corpus_matches_this_codec_byte_for_byte() {
        let (to_node, to_gateway) = corpus();
        let hex = |bytes: Vec<u8>| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let value = serde_json::json!({
            "toNode": to_node.iter().map(|f| hex(f.encode())).collect::<Vec<_>>(),
            "toGateway": to_gateway.iter().map(|f| hex(f.encode())).collect::<Vec<_>>(),
        });
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/chat-bridge-corpus.json");
        let rendered = serde_json::to_string_pretty(&value).unwrap() + "\n";
        if std::env::var("UPDATE_CHAT_BRIDGE_CORPUS").as_deref() == Ok("1") {
            std::fs::write(&path, &rendered).unwrap();
        }
        let stored = std::fs::read_to_string(&path).expect("corpus fixture exists");
        assert_eq!(stored, rendered, "the corpus fixture is stale");
    }
}
