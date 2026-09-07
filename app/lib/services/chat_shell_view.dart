import 'dart:convert';
import 'package:http/http.dart' as http;

/// Keeps the visible conversation stable while its execution cursor moves.
class ChatShellView {
  ChatShellView(this.sourceSessionId);
  final String sourceSessionId;
  String? shellId;
  bool unsupported = false;
  Future<String?>? _opening;

  Future<String> prepare(
    Future<http.Response> Function(String path, String? body) request,
  ) async {
    if (unsupported || sourceSessionId.isEmpty) return sourceSessionId;
    if (shellId == null) {
      _opening ??= () async {
        final response = await request(
          '/api/task-shells',
          jsonEncode({'sessionId': sourceSessionId}),
        );
        final data = jsonDecode(response.body) as Map;
        if (data['code'] == 'unsupported_source') {
          unsupported = true;
          return null;
        }
        if (response.statusCode != 200 || data['id'] is! String) {
          throw StateError('shell open failed: ${response.statusCode}');
        }
        return data['id'] as String;
      }();
      try {
        shellId = await _opening;
      } finally {
        _opening = null;
      }
      if (unsupported) return sourceSessionId;
    }
    final response = await request(
      '/api/task-shells/${Uri.encodeComponent(shellId!)}/chat',
      null,
    );
    final data = jsonDecode(response.body) as Map;
    if (response.statusCode != 200 || data['activeSessionId'] is! String) {
      throw StateError('shell scope failed: ${response.statusCode}');
    }
    return data['activeSessionId'] as String;
  }

  String historyPath(String executionSessionId) => shellId == null
      ? '/api/sessions/${Uri.encodeComponent(executionSessionId)}/history'
      : '/api/task-shells/${Uri.encodeComponent(shellId!)}/history';

  Map<String, dynamic> record(Map<String, dynamic> message, String origin) {
    if (message['sourceSessionId'] != null || message['id'] == null) {
      return message;
    }
    return {
      ...message,
      'id': '$origin:${message['id']}',
      'sourceSessionId': origin,
      'sourceMessageId': message['id'],
    };
  }

  Map<String, dynamic> event(Map<String, dynamic> message, String active) {
    if (shellId == null) return message;
    final origin = message['sourceSessionId']?.toString() ?? active;
    switch (message['type']) {
      case 'chat_msg_meta':
        return {
          ...record(message, origin),
          if (message['message'] is Map)
            'message': record(
              Map<String, dynamic>.from(message['message']),
              origin,
            ),
        };
      case 'chat_history':
      case 'chat_history_reset':
      case 'shell_history_update':
        return {
          ...message,
          'sourceSessionId': origin,
          'messages': [
            for (final m in message['messages'] as List? ?? [])
              record(Map<String, dynamic>.from(m), origin),
          ],
        };
      case 'chat_msg_deleted':
        return {...message, 'id': '$origin:${message['id']}'};
      default:
        return message;
    }
  }
}

({String sessionId, String messageId}) shellMessageOwner(
  String fallback,
  String id,
) {
  final separator = id.indexOf(':');
  return separator > 0
      ? (
          sessionId: id.substring(0, separator),
          messageId: id.substring(separator + 1),
        )
      : (sessionId: fallback, messageId: id);
}
