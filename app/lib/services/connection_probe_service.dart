import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

enum ConnectionProbeFailure {
  invalidAddress,
  insecureAddress,
  unreachable,
  authentication,
  notMulticc,
  notReady,
  incompatible,
}

class ConnectionProbeResult {
  final bool ok;
  final String normalizedHost;
  final String? serverVersion;
  final bool legacyServer;
  final bool insecureLan;
  final ConnectionProbeFailure? failure;

  const ConnectionProbeResult._({
    required this.ok,
    this.normalizedHost = '',
    this.serverVersion,
    this.legacyServer = false,
    this.insecureLan = false,
    this.failure,
  });

  const ConnectionProbeResult.success({
    required String normalizedHost,
    String? serverVersion,
    bool legacyServer = false,
    bool insecureLan = false,
  }) : this._(
         ok: true,
         normalizedHost: normalizedHost,
         serverVersion: serverVersion,
         legacyServer: legacyServer,
         insecureLan: insecureLan,
       );

  const ConnectionProbeResult.failed(ConnectionProbeFailure failure)
    : this._(ok: false, failure: failure);
}

/// Verifies a host before SetupScreen persists it.
///
/// `/healthz` alone is intentionally insufficient: it is public and therefore
/// cannot prove the access token or even that the endpoint is a compatible
/// MultiCC host. `/api/server-info` is authenticated and carries the native App
/// protocol marker; `/readyz` then prevents a booting host from looking ready.
class ConnectionProbeService {
  static const supportedProtocol = 1;

  final http.Client _client;
  final bool _ownsClient;
  final Duration timeout;

  ConnectionProbeService({
    http.Client? client,
    this.timeout = const Duration(seconds: 8),
  }) : _client = client ?? http.Client(),
       _ownsClient = client == null;

  void close() {
    if (_ownsClient) _client.close();
  }

  Future<ConnectionProbeResult> probe({
    required String host,
    required String token,
  }) async {
    final origin = _normalizeOrigin(host);
    if (origin == null) {
      return const ConnectionProbeResult.failed(
        ConnectionProbeFailure.invalidAddress,
      );
    }
    if (origin.scheme == 'http' && !_isPrivateHost(origin.host)) {
      return const ConnectionProbeResult.failed(
        ConnectionProbeFailure.insecureAddress,
      );
    }

    final headers = <String, String>{'Accept': 'application/json'};
    final trimmedToken = token.trim();
    if (trimmedToken.isNotEmpty) headers['X-Access-Token'] = trimmedToken;

    http.Response identity;
    try {
      identity = await _client
          .get(origin.resolve('/api/server-info'), headers: headers)
          .timeout(timeout);
    } catch (_) {
      return const ConnectionProbeResult.failed(
        ConnectionProbeFailure.unreachable,
      );
    }

    if (identity.statusCode == 401 || identity.statusCode == 403) {
      return const ConnectionProbeResult.failed(
        ConnectionProbeFailure.authentication,
      );
    }
    if (identity.statusCode != 200) {
      return const ConnectionProbeResult.failed(
        ConnectionProbeFailure.unreachable,
      );
    }

    Map<String, dynamic> body;
    try {
      final decoded = jsonDecode(utf8.decode(identity.bodyBytes));
      if (decoded is! Map) throw const FormatException();
      body = decoded.cast<String, dynamic>();
    } catch (_) {
      return const ConnectionProbeResult.failed(
        ConnectionProbeFailure.notMulticc,
      );
    }

    final isMarkedHost = body['product'] == 'multicc';
    final isLegacyHost =
        body['ip'] != null &&
        body['port'] is num &&
        body.containsKey('authRequired') &&
        body.containsKey('startedAt');
    if (!isMarkedHost && !isLegacyHost) {
      return const ConnectionProbeResult.failed(
        ConnectionProbeFailure.notMulticc,
      );
    }

    final protocol = (body['appProtocolVersion'] as num?)?.toInt();
    if (protocol != null && protocol != supportedProtocol) {
      return const ConnectionProbeResult.failed(
        ConnectionProbeFailure.incompatible,
      );
    }

    try {
      final readiness = await _client
          .get(origin.resolve('/readyz'), headers: headers)
          .timeout(timeout);
      if (readiness.statusCode == 503) {
        return const ConnectionProbeResult.failed(
          ConnectionProbeFailure.notReady,
        );
      }
      if (readiness.statusCode != 200) {
        return const ConnectionProbeResult.failed(
          ConnectionProbeFailure.unreachable,
        );
      }
    } catch (_) {
      return const ConnectionProbeResult.failed(
        ConnectionProbeFailure.unreachable,
      );
    }

    return ConnectionProbeResult.success(
      normalizedHost: origin.toString().replaceFirst(RegExp(r'/$'), ''),
      serverVersion: body['version']?.toString(),
      legacyServer: protocol == null,
      insecureLan: origin.scheme == 'http',
    );
  }

  static Uri? _normalizeOrigin(String value) {
    var input = value.trim();
    if (input.isEmpty) return null;
    if (!input.contains('://')) input = 'http://$input';
    Uri uri;
    try {
      uri = Uri.parse(input);
    } catch (_) {
      return null;
    }
    if ((uri.scheme != 'http' && uri.scheme != 'https') ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.query.isNotEmpty ||
        uri.fragment.isNotEmpty ||
        (uri.path.isNotEmpty && uri.path != '/')) {
      return null;
    }
    return uri.replace(path: '', query: null, fragment: null);
  }

  static bool _isPrivateHost(String host) {
    final normalized = host.toLowerCase();
    if (normalized == 'localhost' || normalized.endsWith('.local')) return true;
    final address = InternetAddress.tryParse(normalized);
    if (address == null) return false;
    if (address.isLoopback || address.isLinkLocal) return true;
    final bytes = address.rawAddress;
    if (address.type == InternetAddressType.IPv4 && bytes.length == 4) {
      return bytes[0] == 10 ||
          (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
          (bytes[0] == 192 && bytes[1] == 168) ||
          (bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127);
    }
    return bytes.length == 16 && (bytes[0] & 0xfe) == 0xfc;
  }
}
