//! WebSocket handshake planning for the future front-door host.
//!
//! The output is a complete HTTP/1.1 response in the same order as the `ws`
//! no-server listener. Nothing here claims a production upgrade yet: callers
//! must first acquire the authoritative ticket and the live connection owner.

use base64::{engine::general_purpose::STANDARD, Engine};
use sha1::{Digest, Sha1};
use std::collections::HashSet;

pub struct Request<'a> {
    pub method: &'a str,
    pub upgrade: Option<&'a str>,
    pub key: Option<&'a str>,
    pub version: Option<&'a str>,
    pub protocol: Option<&'a str>,
}

pub struct Plan {
    pub accepted: bool,
    pub response: Vec<u8>,
}

fn reject(status: u16, reason: &str, message: &str, version_header: bool) -> Plan {
    let version = if version_header {
        "Sec-WebSocket-Version: 13, 8\r\n"
    } else {
        ""
    };
    Plan {
        accepted: false,
        response: format!(
            "HTTP/1.1 {status} {reason}\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: {}\r\n{version}\r\n{message}",
            message.len()
        )
        .into_bytes(),
    }
}

fn token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

// Matches ws/lib/subprotocol.js, including its leading/trailing whitespace
// restrictions and case-sensitive duplicate rejection.
fn first_protocol(header: &str) -> Option<&str> {
    let bytes = header.as_bytes();
    let (mut start, mut end) = (None, None);
    let mut seen = HashSet::new();
    let mut first = None;
    for (i, &byte) in bytes.iter().enumerate() {
        if end.is_none() && token(byte) {
            start.get_or_insert(i);
        } else if i != 0 && matches!(byte, b' ' | b'\t') {
            if end.is_none() && start.is_some() {
                end = Some(i);
            }
        } else if byte == b',' {
            let from = start?;
            let protocol = &header[from..end.unwrap_or(i)];
            if !seen.insert(protocol) {
                return None;
            }
            first.get_or_insert(protocol);
            start = None;
            end = None;
        } else {
            return None;
        }
    }
    let from = start?;
    if end.is_some() {
        return None;
    }
    let last = &header[from..];
    if !seen.insert(last) {
        return None;
    }
    Some(first.unwrap_or(last))
}

pub fn plan(request: &Request<'_>) -> Plan {
    if request.method != "GET" {
        return reject(405, "Method Not Allowed", "Invalid HTTP method", false);
    }
    if !request
        .upgrade
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
    {
        return reject(400, "Bad Request", "Invalid Upgrade header", false);
    }
    let Some(key) = request.key.filter(|key| {
        let bytes = key.as_bytes();
        bytes.len() == 24
            && bytes[22..] == *b"=="
            && bytes[..22]
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
    }) else {
        return reject(
            400,
            "Bad Request",
            "Missing or invalid Sec-WebSocket-Key header",
            false,
        );
    };
    let version = request
        .version
        .map(multicc_core::js::number::js_string_to_number);
    if !matches!(version, Some(8.0 | 13.0)) {
        return reject(
            400,
            "Bad Request",
            "Missing or invalid Sec-WebSocket-Version header",
            true,
        );
    }
    let protocol = match request.protocol {
        Some(value) => match first_protocol(value) {
            Some(protocol) => Some(protocol),
            None => {
                return reject(
                    400,
                    "Bad Request",
                    "Invalid Sec-WebSocket-Protocol header",
                    false,
                )
            }
        },
        None => None,
    };
    let mut digest = Sha1::new();
    digest.update(key.as_bytes());
    digest.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    let accept = STANDARD.encode(digest.finalize());
    let protocol = protocol
        .map(|v| format!("Sec-WebSocket-Protocol: {v}\r\n"))
        .unwrap_or_default();
    Plan {
        accepted: true,
        response: format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n{protocol}\r\n").into_bytes(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_node_ws_handshakes_match_byte_for_byte() {
        let corpus: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../docs/rust-migration/differential/ws-handshake-golden.json"
        ))
        .unwrap();
        assert_eq!(corpus.len(), 20);
        for (index, case) in corpus.iter().enumerate() {
            let text = |field: &str| case.get(field).and_then(serde_json::Value::as_str);
            let actual = plan(&Request {
                method: text("method").unwrap(),
                upgrade: text("upgrade"),
                key: text("key"),
                version: text("version"),
                protocol: text("protocol"),
            });
            let expected = STANDARD.decode(text("response").unwrap()).unwrap();
            assert_eq!(actual.response, expected, "oracle case {index}");
        }
    }

    #[test]
    fn handshake_and_first_subprotocol_match_ws_bytes() {
        let request = Request {
            method: "GET",
            upgrade: Some("WebSocket"),
            key: Some("dGhlIHNhbXBsZSBub25jZQ=="),
            version: Some("13"),
            protocol: Some("chat, superchat"),
        };
        let result = plan(&request);
        assert!(result.accepted);
        assert_eq!(result.response, b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\nSec-WebSocket-Protocol: chat\r\n\r\n");
    }

    #[test]
    fn invalid_protocols_and_version_fail_before_upgrade() {
        for protocol in [
            "",
            " chat",
            "chat ",
            "chat,,other",
            "chat, chat",
            "chat;other",
            "chat\tother",
        ] {
            let result = plan(&Request {
                method: "GET",
                upgrade: Some("websocket"),
                key: Some("dGhlIHNhbXBsZSBub25jZQ=="),
                version: Some("13"),
                protocol: Some(protocol),
            });
            assert!(!result.accepted, "{protocol:?}");
            assert!(result
                .response
                .ends_with(b"Invalid Sec-WebSocket-Protocol header"));
        }
        let result = plan(&Request {
            method: "GET",
            upgrade: Some("websocket"),
            key: Some("dGhlIHNhbXBsZSBub25jZQ=="),
            version: Some("12"),
            protocol: None,
        });
        assert_eq!(result.response, b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 47\r\nSec-WebSocket-Version: 13, 8\r\n\r\nMissing or invalid Sec-WebSocket-Version header");
    }
}
