import 'dart:convert';
import 'package:http/http.dart' as http;

import '../models/message.dart';
import 'settings_service.dart';

class SessionService {
  final SettingsService settings;

  SessionService({required this.settings});

  Map<String, String> get _headers {
    final h = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) {
      h['X-Access-Token'] = settings.token;
    }
    return h;
  }

  String _url(String path) => settings.buildHttpUrl(path);

  // ── Sessions ──────────────────────────────────────────────────────────────

  Future<List<Session>> fetchSessions() async {
    final res = await http
        .get(Uri.parse(_url('/api/sessions')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) throw Exception('${res.statusCode}');
    final list = jsonDecode(res.body) as List;
    return list
        .map((j) => Session.fromJson(j as Map<String, dynamic>))
        .toList();
  }

  Future<void> deleteSession(String id) async {
    final res = await http
        .delete(Uri.parse(_url('/api/sessions/$id')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) throw Exception('${res.statusCode}');
  }

  Future<void> restartSession(String id) async {
    final res = await http
        .post(Uri.parse(_url('/api/sessions/$id/restart')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) throw Exception('${res.statusCode}');
  }

  /// Merge a session's worktree branch back into the directory's base branch.
  /// Returns the parsed server response. On conflict (409) the result map
  /// contains `ok: false` and a `conflicts` list.
  Future<Map<String, dynamic>> mergeSession(String id) async {
    final res = await http
        .post(Uri.parse(_url('/api/sessions/$id/merge')), headers: _headers)
        .timeout(const Duration(seconds: 30));
    final body = jsonDecode(res.body);
    final map = body is Map<String, dynamic> ? body : <String, dynamic>{};
    if (res.statusCode >= 400) {
      map['ok'] = false;
      map['error'] ??= '${res.statusCode}';
    }
    return map;
  }

  /// Sync: pull the base branch INTO this session's worktree (catch a stale
  /// worktree up to main). Inverse of mergeSession. On conflict (409) the
  /// result map contains `ok: false` and a `conflicts` list.
  Future<Map<String, dynamic>> syncSession(String id) async {
    final res = await http
        .post(Uri.parse(_url('/api/sessions/$id/sync')), headers: _headers)
        .timeout(const Duration(seconds: 30));
    final body = jsonDecode(res.body);
    final map = body is Map<String, dynamic> ? body : <String, dynamic>{};
    if (res.statusCode >= 400) {
      map['ok'] = false;
      map['error'] ??= '${res.statusCode}';
    }
    return map;
  }

  /// Fetch the worktree diff against the directory's base branch. Returns the
  /// parsed server response: `{branch, baseBranch, stat, diff, truncated,
  /// mergeState, error}`. On HTTP error sets `ok: false` + `error`.
  Future<Map<String, dynamic>> fetchDiff(String id) async {
    final res = await http
        .get(Uri.parse(_url('/api/sessions/$id/diff')), headers: _headers)
        .timeout(const Duration(seconds: 20));
    final body = jsonDecode(res.body);
    final map = body is Map<String, dynamic> ? body : <String, dynamic>{};
    if (res.statusCode >= 400) {
      map['ok'] = false;
      map['error'] ??= '${res.statusCode}';
    }
    return map;
  }

  Future<Map<String, dynamic>> fetchMergeStatus(String id) async {
    final res = await http
        .get(
          Uri.parse(_url('/api/sessions/$id/merge-status')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 10));
    final body = jsonDecode(res.body);
    final map = body is Map<String, dynamic> ? body : <String, dynamic>{};
    if (res.statusCode >= 400) {
      map['ok'] = false;
      map['error'] ??= '${res.statusCode}';
    }
    return map;
  }

  /// Leave a passive note for another session in the same directory. The note
  /// is delivered to the target agent at the start of its next chat turn.
  Future<void> postNote({
    required String fromSessionId,
    required String toSessionId,
    required String body,
  }) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/sessions/$fromSessionId/notes')),
          headers: _headers,
          body: jsonEncode({'toSessionId': toSessionId, 'body': body}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  /// Switch the model of an existing claude session. Empty string = follow
  /// the server-side /model default. Chat sessions pick it up next turn.
  Future<void> updateSessionModel(String id, String model) async {
    final res = await http
        .patch(
          Uri.parse(_url('/api/sessions/$id')),
          headers: _headers,
          body: jsonEncode({'model': model}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  /// Switch the per-session provider (cc-switch). Empty string clears the
  /// override → the session falls back to the default login / subscription.
  /// Applies on the next chat turn.
  Future<void> updateSessionProvider(String id, String provider) async {
    final res = await http
        .patch(
          Uri.parse(_url('/api/sessions/$id')),
          headers: _headers,
          body: jsonEncode({'provider': provider}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  /// Set the per-session role prompt (system prompt override). Empty string
  /// clears the override → the session inherits the directory default. Applies
  /// on the next chat turn.
  Future<void> updateSessionRolePrompt(String id, String rolePrompt) async {
    final res = await http
        .patch(
          Uri.parse(_url('/api/sessions/$id')),
          headers: _headers,
          body: jsonEncode({'rolePrompt': rolePrompt}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  /// Create an external share link for a session. access: 'view' | 'operate'
  /// ('operate' requires a non-empty password). Returns the share record incl.
  /// `url` (built server-side from the request host, so it matches the base URL
  /// the app is configured with). The recipient always opens a web page.
  Future<Map<String, dynamic>> createShare(
    String id, {
    required String access,
    String? password,
    int? expiresAt,
  }) async {
    final body = <String, dynamic>{'access': access};
    if (password != null && password.isNotEmpty) body['password'] = password;
    if (expiresAt != null) body['expiresAt'] = expiresAt;
    final res = await http
        .post(
          Uri.parse(_url('/api/sessions/$id/share')),
          headers: _headers,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Fetch the persisted chat history for a session. Returns the raw message
  /// maps (role/content/ts/tools/cost) in their server-side order — the index
  /// of each entry is the authoritative index for [shareMessages].
  Future<List<Map<String, dynamic>>> fetchHistory(String id) async {
    final res = await http
        .get(Uri.parse(_url('/api/sessions/$id/history')), headers: _headers)
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    final list = (data['messages'] as List? ?? []);
    return list.map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  /// Create a read-only snapshot share of selected messages (by index into the
  /// session history). Returns the share record incl. `url`.
  Future<Map<String, dynamic>> shareMessages(
    String id, {
    required List<int> indices,
    String? password,
    String? label,
  }) async {
    final body = <String, dynamic>{'indices': indices};
    if (password != null && password.isNotEmpty) body['password'] = password;
    if (label != null && label.isNotEmpty) body['label'] = label;
    final res = await http
        .post(
          Uri.parse(_url('/api/sessions/$id/share-messages')),
          headers: _headers,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<void> updateSessionLabel(String id, String? label) async {
    final res = await http
        .patch(
          Uri.parse(_url('/api/sessions/$id')),
          headers: _headers,
          body: jsonEncode({'label': label ?? ''}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  // ── Directories ──────────────────────────────────────────────────────────

  Future<List<Directory>> fetchDirectories() async {
    final res = await http
        .get(Uri.parse(_url('/api/directories')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) throw Exception('${res.statusCode}');
    final list = jsonDecode(res.body) as List;
    return list
        .map((j) => Directory.fromJson(j as Map<String, dynamic>))
        .toList();
  }

  Future<Directory> createDirectory({
    required String name,
    required String path,
  }) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/directories')),
          headers: _headers,
          body: jsonEncode({'name': name, 'path': path}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    return Directory.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  /// List subdirectories for the directory picker. If [path] is a partial (its
  /// parent exists but the full path doesn't), the server returns the parent's
  /// children whose name prefix-matches the trailing segment.
  Future<List<Map<String, String>>> fetchFsList(String path) async {
    try {
      final res = await http
          .get(
            Uri.parse(_url('/api/fs/list?path=${Uri.encodeQueryComponent(path)}')),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return [];
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      final entries = (data['entries'] as List? ?? []);
      return entries
          .map<Map<String, String>>(
            (e) => {
              'name': (e['name'] ?? '').toString(),
              'path': (e['path'] ?? '').toString(),
            },
          )
          .toList();
    } catch (_) {
      return [];
    }
  }

  Future<Map<String, dynamic>> fetchMemo(String dirId) async {
    final res = await http
        .get(Uri.parse(_url('/api/directories/$dirId/memo')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<void> saveMemo(String dirId, String text) async {
    final res = await http
        .put(
          Uri.parse(_url('/api/directories/$dirId/memo')),
          headers: _headers,
          body: jsonEncode({'text': text}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  Future<void> sendMemoLine(String dirId, String sessionId, String text) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/directories/$dirId/memo/send')),
          headers: _headers,
          body: jsonEncode({'sessionId': sessionId, 'text': text}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  Future<void> updateDirectoryName(String id, String name) async {
    final res = await http
        .patch(
          Uri.parse(_url('/api/directories/$id')),
          headers: _headers,
          body: jsonEncode({'name': name}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  /// Push all of a directory's worktree branches (and the base branch) to the
  /// configured git remote. Returns the parsed server response: on success
  /// `{ok: true, pushed, before: {ahead, remote, remoteBranch}, ...}`. On HTTP
  /// error sets `ok: false` + `error`.
  Future<Map<String, dynamic>> pushDirectory(String id) async {
    final res = await http
        .post(Uri.parse(_url('/api/directories/$id/push')), headers: _headers)
        .timeout(const Duration(seconds: 60));
    final body = jsonDecode(res.body);
    final map = body is Map<String, dynamic> ? body : <String, dynamic>{};
    if (res.statusCode >= 400) {
      map['ok'] = false;
      map['error'] ??= _tryParseError(res.body) ?? '${res.statusCode}';
    }
    return map;
  }

  Future<void> deleteDirectory(String id, {bool force = true}) async {
    final qs = force ? '?force=1' : '';
    final res = await http
        .delete(Uri.parse(_url('/api/directories/$id$qs')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  /// Create a new session inside a directory. Server does not spawn the
  /// underlying CLI until the WebSocket connects.
  Future<Session> createSessionInDir({
    required String dirId,
    required SessionCli cli,
    required SessionKind kind,
    String? label,
    String? model,
  }) async {
    final body = <String, dynamic>{'cli': cli.name, 'kind': kind.name};
    if (label != null && label.isNotEmpty) body['label'] = label;
    if (model != null && model.isNotEmpty) body['model'] = model;
    final res = await http
        .post(
          Uri.parse(_url('/api/directories/$dirId/sessions')),
          headers: _headers,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    return Session.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  String? _tryParseError(String body) {
    try {
      final j = jsonDecode(body);
      if (j is Map && j['error'] != null) return j['error'].toString();
    } catch (_) {}
    return null;
  }
}
