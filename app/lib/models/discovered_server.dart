import 'package:flutter/foundation.dart';

/// A connectable MultiCC endpoint advertised on the local network.
///
/// Discovery is deliberately limited to address completion. It does not carry
/// credentials and selecting an instance does not imply trust or connection.
@immutable
class DiscoveredServer {
  final String name;
  final String address;
  final int port;

  const DiscoveredServer({
    required this.name,
    required this.address,
    required this.port,
  });

  /// Stable enough to de-duplicate repeated mDNS answers during one scan.
  String get endpointKey => '$address:$port';

  /// Address written into the existing server URL field when the user taps it.
  /// [Uri] adds brackets around IPv6 literals and escapes a scope identifier.
  String get httpUrl =>
      Uri(scheme: 'http', host: address, port: port).toString();

  String get endpointLabel {
    final printableHost = address.contains(':') ? '[$address]' : address;
    return '$printableHost:$port';
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DiscoveredServer &&
          other.name == name &&
          other.address == address &&
          other.port == port;

  @override
  int get hashCode => Object.hash(name, address, port);
}
