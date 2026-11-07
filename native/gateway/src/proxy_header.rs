//! The one PROXY v1 line the front door writes before any client byte.

use std::net::SocketAddr;

/// `PROXY TCP4 <客户端IP> <前门本地IP> <客户端端口> <前门本地端口>\r\n`.
/// `Ipv6Addr`'s Display prints an IPv4-mapped address exactly the way Node's
/// `socket.remoteAddress` does (`::ffff:192.168.1.5`).
pub fn format_proxy_header(client: SocketAddr, local: SocketAddr) -> String {
    match client {
        SocketAddr::V4(address) => format!(
            "PROXY TCP4 {} {} {} {}\r\n",
            address.ip(),
            local.ip(),
            address.port(),
            local.port()
        ),
        SocketAddr::V6(address) => format!(
            "PROXY TCP6 {} {} {} {}\r\n",
            address.ip(),
            local.ip(),
            address.port(),
            local.port()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipv4_addresses_use_tcp4() {
        let client: SocketAddr = "192.168.1.5:51234".parse().unwrap();
        let local: SocketAddr = "0.0.0.0:3000".parse().unwrap();
        assert_eq!(
            format_proxy_header(client, local),
            "PROXY TCP4 192.168.1.5 0.0.0.0 51234 3000\r\n"
        );
    }

    #[test]
    fn ipv6_addresses_use_tcp6() {
        let client: SocketAddr = "[2001:db8::1]:443".parse().unwrap();
        let local: SocketAddr = "[::1]:3000".parse().unwrap();
        assert_eq!(
            format_proxy_header(client, local),
            "PROXY TCP6 2001:db8::1 ::1 443 3000\r\n"
        );
    }

    #[test]
    fn an_ipv4_mapped_client_keeps_nodes_spelling() {
        let client: SocketAddr = "[::ffff:192.168.1.5]:1234".parse().unwrap();
        let local: SocketAddr = "[::ffff:127.0.0.1]:3000".parse().unwrap();
        assert_eq!(
            format_proxy_header(client, local),
            "PROXY TCP6 ::ffff:192.168.1.5 ::ffff:127.0.0.1 1234 3000\r\n"
        );
    }
}
