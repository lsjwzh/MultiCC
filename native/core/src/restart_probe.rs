//! Bounded HTTP readiness probe used by the restart supervisor.
//!
//! A successful `/readyz` response by itself does not identify the instance.
//! The caller supplies a per-attempt generation, and the responder must echo it
//! in `X-Multicc-Restart-Generation`. A different or missing generation means
//! that the socket belongs to an unverified service and must never be killed.

use std::io::{self, Read, Write};
#[cfg(windows)]
use std::net::TcpListener;
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const MAX_RESPONSE: u64 = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum ProbeResult {
    Ready,
    NotReady,
    ForeignService,
    Unreachable,
}

/// Only interfaces assigned to this host are valid restart targets.
pub fn is_local_address(ip: IpAddr) -> bool {
    if ip.is_unspecified() || ip.is_multicast() {
        return false;
    }
    if let IpAddr::V4(address) = ip {
        if address == std::net::Ipv4Addr::BROADCAST {
            return false;
        }
    }
    if ip.is_loopback() {
        return true;
    }
    local_interface_contains(ip)
}

#[cfg(unix)]
fn local_interface_contains(ip: IpAddr) -> bool {
    let mut head = std::ptr::null_mut();
    // SAFETY: getifaddrs initializes a linked list which is freed exactly once.
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return false;
    }
    let mut cursor = head;
    let mut found = false;
    while !cursor.is_null() {
        let address = unsafe { (*cursor).ifa_addr };
        if !address.is_null() {
            let family = unsafe { (*address).sa_family as i32 };
            let candidate = if family == libc::AF_INET {
                let address = unsafe { &*(address as *const libc::sockaddr_in) };
                Some(IpAddr::V4(std::net::Ipv4Addr::from(u32::from_be(
                    address.sin_addr.s_addr,
                ))))
            } else if family == libc::AF_INET6 {
                let address = unsafe { &*(address as *const libc::sockaddr_in6) };
                Some(IpAddr::V6(std::net::Ipv6Addr::from(
                    address.sin6_addr.s6_addr,
                )))
            } else {
                None
            };
            if candidate == Some(ip) {
                found = true;
                break;
            }
        }
        cursor = unsafe { (*cursor).ifa_next };
    }
    unsafe {
        libc::freeifaddrs(head);
    }
    found
}

#[cfg(windows)]
fn local_interface_contains(ip: IpAddr) -> bool {
    // Windows refuses binding unassigned unicast addresses by default.
    TcpListener::bind(SocketAddr::new(ip, 0)).is_ok()
}

/// Identify the gateway that currently owns the selected local socket.
pub fn gateway_pid(address: SocketAddr, timeout: Duration) -> io::Result<Option<u32>> {
    if !is_local_address(address.ip()) || timeout.is_zero() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid gateway probe target",
        ));
    }
    let start = Instant::now();
    let mut socket = TcpStream::connect_timeout(&address, timeout)?;
    socket.set_write_timeout(Some(
        timeout
            .saturating_sub(start.elapsed())
            .max(Duration::from_millis(1)),
    ))?;
    socket.write_all(b"GET /readyz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 2048];
    while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
        let remaining = timeout
            .checked_sub(start.elapsed())
            .filter(|v| !v.is_zero())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "gateway probe timed out"))?;
        socket.set_read_timeout(Some(remaining))?;
        let count = socket.read(&mut buffer)?;
        if count == 0 {
            return Ok(None);
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > 32 * 1024 {
            return Ok(None);
        }
    }
    let end = bytes
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .unwrap();
    let Ok(headers) = std::str::from_utf8(&bytes[..end]) else {
        return Ok(None);
    };
    let mut pids = headers.lines().skip(1).filter_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("x-multicc-gateway-pid")
            .then_some(value.trim())
    });
    let first = pids.next().and_then(|value| value.parse::<u32>().ok());
    if pids.next().is_some() {
        return Ok(None);
    }
    Ok(first)
}

/// Probe only a caller-supplied address assigned to this host. No redirects, proxy variables,
/// authentication material, or arbitrary user-controlled headers are used.
pub fn probe(address: SocketAddr, generation: &str, timeout: Duration) -> io::Result<ProbeResult> {
    if !is_local_address(address.ip())
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

    #[test]
    fn original_gateway_pid_must_be_present_and_unambiguous() {
        for (response, expected) in [
            ("HTTP/1.1 503 Unavailable\r\nX-Multicc-Gateway-Pid: 1234\r\n\r\n", Some(1234)),
            ("HTTP/1.1 200 OK\r\nX-Multicc-Gateway-Pid: 1234\r\nX-Multicc-Gateway-Pid: 1234\r\n\r\n", None),
            ("HTTP/1.1 200 OK\r\n\r\n", None),
        ] {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = [0; 1024]; let _ = socket.read(&mut request);
                socket.write_all(response.as_bytes()).unwrap();
            });
            assert_eq!(gateway_pid(address, Duration::from_secs(2)).unwrap(), expected);
            server.join().unwrap();
        }
    }
}
