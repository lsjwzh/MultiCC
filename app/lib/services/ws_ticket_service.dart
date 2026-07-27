import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// WebSocket paths currently understood by the MultiCC host.
abstract final class MulticcWsPath {
  static const terminal = '/';
  static const chat = '/ws/chat';
  static const voice = '/ws/voice';
  static const tts = '/ws/tts';
  static const workspace = '/ws/workspace';
  static const meta = '/ws/meta';
  static const aux = '/ws/aux';
}

// Flutter currently consumes Aux through REST + /ws/workspace events, so it
// does not create a second /ws/aux transport. Voice input now streams over
// /ws/voice (see VoiceDictationService), falling back to the legacy multipart
// /api/voice/stt flow when the socket is unavailable. The constants keep both
// exact ticket scopes ready without silently changing either business state machine.

typedef WsTicketPost =
    Future<http.Response> Function(
      Uri endpoint, {
      required Map<String, String> headers,
      required String body,
    });

Future<http.Response> _postTicket(
  Uri endpoint, {
  required Map<String, String> headers,
  required String body,
}) => http.post(endpoint, headers: headers, body: body);

/// Stable, deliberately non-sensitive ticket failure.
///
/// Neither the response body, access token nor ticket is retained in this
/// object. It is therefore safe for the existing service-level warning logs.
class WsTicketException implements Exception {
  final String code;
  final int? statusCode;

  const WsTicketException(this.code, {this.statusCode});

  @override
  String toString() => statusCode == null
      ? 'WsTicketException($code)'
      : 'WsTicketException($code, HTTP $statusCode)';
}

/// Builds a credential-free WebSocket URI.
///
/// Credentials must subsequently be exchanged by [WsTicketClient]. Query
/// values are encoded by [Uri], never by string concatenation.
Uri buildMulticcWebSocketUri({
  required String host,
  required String path,
  Map<String, String> query = const {},
}) {
  if (!path.startsWith('/') || path.contains('?') || path.contains('#')) {
    throw const FormatException('invalid WebSocket path');
  }
  if (query.containsKey('token') || query.containsKey('ticket')) {
    throw const FormatException('credentials are not WebSocket parameters');
  }

  var normalizedHost = host.trim().replaceAll(RegExp(r'/+$'), '');
  if (normalizedHost.isEmpty) {
    throw const FormatException('empty server host');
  }
  if (!normalizedHost.startsWith('http://') &&
      !normalizedHost.startsWith('https://')) {
    normalizedHost = 'http://$normalizedHost';
  }

  final base = Uri.parse(normalizedHost);
  if (base.host.isEmpty || (base.scheme != 'http' && base.scheme != 'https')) {
    throw const FormatException('invalid server host');
  }
  if (base.userInfo.isNotEmpty ||
      (base.path.isNotEmpty && base.path != '/') ||
      base.query.isNotEmpty ||
      base.fragment.isNotEmpty) {
    throw const FormatException('server host must be an origin');
  }

  return base.replace(
    scheme: base.scheme == 'https' ? 'wss' : 'ws',
    path: path,
    queryParameters: query.isEmpty ? null : query,
  );
}

/// Exchanges the normal REST credential for one short-lived, path-bound
/// WebSocket ticket.
class WsTicketClient {
  final WsTicketPost _post;
  final Duration timeout;

  WsTicketClient({
    WsTicketPost? post,
    this.timeout = const Duration(seconds: 15),
  }) : _post = post ?? _postTicket;

  Future<Uri> authorize({
    required Uri socketUri,
    required Uri ticketEndpoint,
    required String accessToken,
  }) async {
    if ((socketUri.scheme != 'ws' && socketUri.scheme != 'wss') ||
        socketUri.host.isEmpty ||
        socketUri.userInfo.isNotEmpty ||
        socketUri.fragment.isNotEmpty ||
        !socketUri.path.startsWith('/')) {
      throw const WsTicketException('invalid_socket_uri');
    }
    if ((ticketEndpoint.scheme != 'http' && ticketEndpoint.scheme != 'https') ||
        ticketEndpoint.host.isEmpty ||
        ticketEndpoint.userInfo.isNotEmpty ||
        ticketEndpoint.query.isNotEmpty ||
        ticketEndpoint.fragment.isNotEmpty ||
        ticketEndpoint.path != '/api/auth/ws-ticket' ||
        !_sameServerOrigin(socketUri, ticketEndpoint)) {
      throw const WsTicketException('invalid_ticket_endpoint');
    }

    final headers = <String, String>{'Content-Type': 'application/json'};
    if (accessToken.isNotEmpty) {
      // Reuse the exact REST authentication channel; never put it in the URL.
      headers['X-Access-Token'] = accessToken;
    }

    http.Response response;
    try {
      response = await _post(
        ticketEndpoint,
        headers: headers,
        body: jsonEncode({'path': socketUri.path}),
      ).timeout(timeout);
    } catch (_) {
      throw const WsTicketException('ticket_request_failed');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw WsTicketException(
        'ticket_http_error',
        statusCode: response.statusCode,
      );
    }

    dynamic decoded;
    try {
      decoded = jsonDecode(response.body);
    } catch (_) {
      throw const WsTicketException('invalid_ticket_response');
    }
    if (decoded is! Map) {
      throw const WsTicketException('invalid_ticket_response');
    }
    final ticket = decoded['ticket'];
    final issuedPath = decoded['path'];
    if (ticket is! String || ticket.isEmpty || issuedPath != socketUri.path) {
      throw const WsTicketException('invalid_ticket_response');
    }

    final params = <String, dynamic>{};
    for (final entry in socketUri.queryParametersAll.entries) {
      if (entry.key != 'token' && entry.key != 'ticket') {
        params[entry.key] = entry.value;
      }
    }
    params['ticket'] = ticket;
    return socketUri.replace(queryParameters: params);
  }

  bool _sameServerOrigin(Uri socketUri, Uri ticketEndpoint) {
    final expectedHttpScheme = socketUri.scheme == 'wss' ? 'https' : 'http';
    if (ticketEndpoint.scheme != expectedHttpScheme ||
        ticketEndpoint.host.toLowerCase() != socketUri.host.toLowerCase()) {
      return false;
    }
    int effectivePort(Uri uri) {
      if (uri.hasPort) return uri.port;
      return (uri.scheme == 'https' || uri.scheme == 'wss') ? 443 : 80;
    }

    return effectivePort(socketUri) == effectivePort(ticketEndpoint);
  }
}

/// One asynchronous authorization attempt. A completed attempt may only open
/// a socket while [isCurrent] is true.
class WsTicketAttempt {
  final int _generation;
  final WsTicketConnectionGate _owner;
  final Future<Uri> authorizedUri;

  WsTicketAttempt._(this._generation, this._owner, this.authorizedUri);

  bool get isCurrent => _owner._generation == _generation;
}

/// Prevents an old ticket response from opening or replacing a newer socket.
/// Every [begin] call issues a fresh ticket request; [invalidate] also makes an
/// outstanding request harmless without relying on HTTP cancellation support.
class WsTicketConnectionGate {
  final WsTicketClient client;
  int _generation = 0;

  WsTicketConnectionGate(this.client);

  WsTicketAttempt begin({
    required Uri socketUri,
    required Uri ticketEndpoint,
    required String accessToken,
  }) {
    final generation = ++_generation;
    return WsTicketAttempt._(
      generation,
      this,
      client.authorize(
        socketUri: socketUri,
        ticketEndpoint: ticketEndpoint,
        accessToken: accessToken,
      ),
    );
  }

  void invalidate() {
    _generation++;
  }
}
