import 'dart:convert';

import 'package:http/http.dart' as http;

typedef DownloadTicketPost =
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

class MulticcDownloadRequest {
  final Uri uri;
  final Map<String, String> headers;

  const MulticcDownloadRequest({required this.uri, required this.headers});
}

class DownloadTicketException implements Exception {
  final String code;
  final int? statusCode;

  const DownloadTicketException(this.code, {this.statusCode});

  @override
  String toString() => statusCode == null
      ? 'DownloadTicketException($code)'
      : 'DownloadTicketException($code, HTTP $statusCode)';
}

Uri _serverOrigin(String host) {
  var normalized = host.trim().replaceAll(RegExp(r'/+$'), '');
  if (normalized.isEmpty) throw const FormatException('empty server host');
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = 'http://$normalized';
  }
  final origin = Uri.parse(normalized);
  if ((origin.scheme != 'http' && origin.scheme != 'https') ||
      origin.host.isEmpty ||
      origin.userInfo.isNotEmpty ||
      (origin.path.isNotEmpty && origin.path != '/') ||
      origin.query.isNotEmpty ||
      origin.fragment.isNotEmpty) {
    throw const FormatException('server host must be an HTTP origin');
  }
  return origin;
}

MulticcDownloadRequest buildMulticcDownloadRequest({
  required String host,
  required String path,
  required String accessToken,
  bool inline = false,
}) {
  if (path.isEmpty || path.contains('\u0000')) {
    throw const FormatException('invalid download path');
  }
  final query = <String, String>{'path': path};
  if (inline) query['inline'] = '1';
  final uri = _serverOrigin(
    host,
  ).replace(path: '/api/download', queryParameters: query);
  final headers = <String, String>{};
  if (accessToken.isNotEmpty) headers['X-Access-Token'] = accessToken;
  return MulticcDownloadRequest(uri: uri, headers: Map.unmodifiable(headers));
}

class DownloadTicketClient {
  final DownloadTicketPost _post;
  final Duration timeout;

  DownloadTicketClient({
    DownloadTicketPost? post,
    this.timeout = const Duration(seconds: 15),
  }) : _post = post ?? _postTicket;

  Future<Uri> authorize({
    required MulticcDownloadRequest request,
    required Uri ticketEndpoint,
  }) async {
    final uri = request.uri;
    if (uri.path != '/api/download' ||
        uri.userInfo.isNotEmpty ||
        uri.fragment.isNotEmpty ||
        !_validDownloadQuery(uri)) {
      throw const DownloadTicketException('invalid_download_uri');
    }
    if (ticketEndpoint.path != '/api/auth/download-ticket' ||
        ticketEndpoint.userInfo.isNotEmpty ||
        ticketEndpoint.query.isNotEmpty ||
        ticketEndpoint.fragment.isNotEmpty ||
        !_sameHttpOrigin(uri, ticketEndpoint)) {
      throw const DownloadTicketException('invalid_ticket_endpoint');
    }

    final headers = <String, String>{
      'Content-Type': 'application/json',
      ...request.headers,
    };
    http.Response response;
    try {
      response = await _post(
        ticketEndpoint,
        headers: headers,
        body: jsonEncode({
          'path': uri.queryParameters['path'],
          'inline': uri.queryParameters['inline'] == '1',
        }),
      ).timeout(timeout);
    } catch (_) {
      throw const DownloadTicketException('ticket_request_failed');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw DownloadTicketException(
        'ticket_http_error',
        statusCode: response.statusCode,
      );
    }

    dynamic decoded;
    try {
      decoded = jsonDecode(response.body);
    } catch (_) {
      throw const DownloadTicketException('invalid_ticket_response');
    }
    if (decoded is! Map) {
      throw const DownloadTicketException('invalid_ticket_response');
    }
    final ticket = decoded['ticket'];
    final target = decoded['target'];
    if (ticket is! String || ticket.isEmpty || target is! String) {
      throw const DownloadTicketException('invalid_ticket_response');
    }
    final issuedTarget = Uri.tryParse(target);
    if (issuedTarget == null ||
        issuedTarget.hasScheme ||
        issuedTarget.host.isNotEmpty ||
        issuedTarget.userInfo.isNotEmpty ||
        issuedTarget.fragment.isNotEmpty ||
        issuedTarget.path != uri.path ||
        !_sameQuery(issuedTarget.queryParametersAll, uri.queryParametersAll)) {
      throw const DownloadTicketException('invalid_ticket_response');
    }

    return uri.replace(
      queryParameters: {...uri.queryParameters, 'download_ticket': ticket},
    );
  }

  bool _validDownloadQuery(Uri uri) {
    final keys = uri.queryParametersAll.keys.toSet();
    if (!keys.every(const {'path', 'inline'}.contains) ||
        uri.queryParametersAll['path']?.length != 1 ||
        (uri.queryParameters['path'] ?? '').isEmpty) {
      return false;
    }
    final inlineValues = uri.queryParametersAll['inline'];
    return inlineValues == null ||
        (inlineValues.length == 1 && inlineValues.single == '1');
  }

  bool _sameQuery(
    Map<String, List<String>> left,
    Map<String, List<String>> right,
  ) {
    if (left.length != right.length) return false;
    for (final entry in left.entries) {
      final other = right[entry.key];
      if (other == null || other.length != entry.value.length) return false;
      for (var i = 0; i < other.length; i++) {
        if (other[i] != entry.value[i]) return false;
      }
    }
    return true;
  }

  bool _sameHttpOrigin(Uri left, Uri right) {
    if ((left.scheme != 'http' && left.scheme != 'https') ||
        left.scheme != right.scheme ||
        left.host.toLowerCase() != right.host.toLowerCase()) {
      return false;
    }
    int effectivePort(Uri uri) {
      if (uri.hasPort) return uri.port;
      return uri.scheme == 'https' ? 443 : 80;
    }

    return effectivePort(left) == effectivePort(right);
  }
}
