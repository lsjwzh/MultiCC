//! Bounded HTTP readiness probe used by the restart supervisor.
//!
//! A successful `/readyz` response by itself does not identify the instance.
//! The caller supplies a per-attempt generation, and the responder must echo it
//! in `X-Multicc-Restart-Generation`. A different or missing generation means
//! that the socket belongs to an unverified service and must never be killed.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const MAX_RESPONSE: u64 = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum ProbeResult {
    Ready,
    NotReady,
    ForeignService,
    Unreachable,
}

/// Probe only a caller-supplied loopback socket. No redirects, proxy variables,
/// authentication material, or arbitrary user-controlled headers are used.
pub fn probe(address: SocketAddr, generation: &str, timeout: Duration) -> io::Result<ProbeResult> {
    if !address.ip().is_loopback()
        || generation.is_empty()
        || generation.len() > 128
        || !generation
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid restart probe target or generation",
        ));
    }
    if timeout.is_zero() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "probe timeout must be positive",
        ));
    }
    let started = Instant::now();
    let mut socket = match TcpStream::connect_timeout(&address, timeout) {
        Ok(socket) => socket,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::TimedOut
            ) =>
        {
            return Ok(ProbeResult::Unreachable)
        }
        Err(error) => return Err(error),
    };
    socket.set_write_timeout(Some(
        timeout
            .saturating_sub(started.elapsed())
            .max(Duration::from_millis(1)),
    ))?;
    socket.write_all(b"GET /readyz HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n")?;
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let Some(remaining) = timeout.checked_sub(started.elapsed()) else {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "restart probe timed out",
            ));
        };
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "restart probe timed out",
            ));
        }
        socket.set_read_timeout(Some(remaining))?;
        let count = socket.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() as u64 > MAX_RESPONSE {
            break;
        }
    }
    if bytes.len() as u64 > MAX_RESPONSE {
        return Ok(ProbeResult::ForeignService);
    }
    let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
        return Ok(ProbeResult::ForeignService);
    };
    let Ok(headers) = std::str::from_utf8(&bytes[..header_end]) else {
        return Ok(ProbeResult::ForeignService);
    };
    let mut lines = headers.split("\r\n");
    let status = lines.next().and_then(|line| {
        let mut parts = line.split_whitespace();
        let version = parts.next()?;
        if version != "HTTP/1.1" && version != "HTTP/1.0" {
            return None;
        }
        parts.next()?.parse::<u16>().ok()
    });
    let mut identities = lines.filter_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("x-multicc-restart-generation")
            .then_some(value.trim())
    });
    if identities.next() != Some(generation) || identities.next().is_some() {
        return Ok(ProbeResult::ForeignService);
    }
    if status != Some(200) {
        return Ok(ProbeResult::NotReady);
    }
    let body = &bytes[header_end + 4..];
    let ready = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|json| {
            json.get("status")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        })
        .as_deref()
        == Some("ready");
    Ok(if ready {
        ProbeResult::Ready
    } else {
        ProbeResult::NotReady
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, TcpListener};
    use std::thread;

    fn response(message: &'static str, generation: &str) -> ProbeResult {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            let count = socket.read(&mut request).unwrap();
            assert!(request[..count].starts_with(b"GET /readyz HTTP/1.1\r\n"));
            socket.write_all(message.as_bytes()).unwrap();
        });
        let result = probe(address, generation, Duration::from_secs(2)).unwrap();
        server.join().unwrap();
        result
    }

    #[test]
    fn accepts_only_verified_ready_response() {
        assert_eq!(response("HTTP/1.1 200 OK\r\nX-Multicc-Restart-Generation: next-123\r\n\r\n{\"status\":\"ready\"}", "next-123"), ProbeResult::Ready);
        assert_eq!(response("HTTP/1.1 503 Service Unavailable\r\nX-Multicc-Restart-Generation: next-123\r\n\r\n{}", "next-123"), ProbeResult::NotReady);
        assert_eq!(response("HTTP/1.1 200 OK\r\nX-Multicc-Restart-Generation: other\r\n\r\n{\"status\":\"ready\"}", "next-123"), ProbeResult::ForeignService);
        assert_eq!(
            response("HTTP/1.1 200 OK\r\n\r\n{\"status\":\"ready\"}", "next-123"),
            ProbeResult::ForeignService
        );
    }

    #[test]
    fn duplicate_generation_and_invalid_ready_body_are_rejected() {
        assert_eq!(response("HTTP/1.1 200 OK\r\nX-Multicc-Restart-Generation: a\r\nX-Multicc-Restart-Generation: a\r\n\r\n{\"status\":\"ready\"}", "a"), ProbeResult::ForeignService);
        assert_eq!(response("HTTP/1.1 200 OK\r\nX-Multicc-Restart-Generation: a\r\n\r\n{\"status\":\"starting\"}", "a"), ProbeResult::NotReady);
    }

    #[test]
    fn refuses_non_loopback_and_header_injection() {
        assert!(probe(
            "8.8.8.8:80".parse().unwrap(),
            "valid",
            Duration::from_secs(1)
        )
        .is_err());
        assert!(probe(
            "127.0.0.1:1".parse().unwrap(),
            "bad\r\nheader",
            Duration::from_secs(1)
        )
        .is_err());
    }

    #[test]
    fn stalled_response_has_a_bounded_deadline() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            let _ = socket.read(&mut request);
            std::thread::sleep(Duration::from_millis(150));
        });
        let started = Instant::now();
        assert!(probe(address, "a", Duration::from_millis(30)).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        server.join().unwrap();
    }
}
