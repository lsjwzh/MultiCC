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

  Future<SessionCliConfig> fetchSessionCliConfig(String id) async {
    final res = await http
        .get(Uri.parse(_url('/api/sessions/$id')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    return SessionCliConfig.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  Future<SessionCliConfig> switchSessionCli(
    String id,
    SessionCli cli, {
    bool fresh = false,
  }) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/sessions/$id/switch-cli')),
          headers: _headers,
          body: jsonEncode({
            'cli': cli.name,
            'fresh': fresh,
            'force': true,
          }),
        )
        .timeout(const Duration(seconds: 20));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    return SessionCliConfig.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  // ── CLI install (three-endpoint contract shared with web/CLI) ──────────────

  /// Fetch install specs for all supported CLIs. Returns the parsed response
  /// map `{ok, specs:{<cli>:{auto, command?, display?, manual?}}}`. On HTTP
  /// error sets `ok: false` + `error` so callers can degrade gracefully.
  Future<Map<String, dynamic>> fetchCliInstallSpecs() async {
    final res = await http
        .get(Uri.parse(_url('/api/cli/install-specs')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    final body = jsonDecode(res.body);
    final map = body is Map<String, dynamic> ? body : <String, dynamic>{};
    if (res.statusCode >= 400) {
      map['ok'] = false;
      map['error'] ??= '${res.statusCode}';
    }
    return map;
  }

  /// Kick off an install for [cli]. Returns the whole parsed response map so
  /// the caller can branch on status: 200 already-installed, 202 started
  /// (jobId), 400 unsupported/manual, 409 already-running (jobId). The HTTP
  /// statusCode is folded into the map as `statusCode` for that branching.
  Future<Map<String, dynamic>> installCli(String cli) async {
    final res = await http
        .post(Uri.parse(_url('/api/cli/$cli/install')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    final body = jsonDecode(res.body);
    final map = body is Map<String, dynamic> ? body : <String, dynamic>{};
    map['statusCode'] = res.statusCode;
    if (res.statusCode >= 400) {
      map['ok'] = false;
      map['error'] ??= _tryParseError(res.body) ?? '${res.statusCode}';
    }
    return map;
  }

  /// Poll the status of an install job. Returns `{ok, job:{id, cli, status,
  /// command, startedAt, endedAt, exitCode, error, logTail}}` plus an
  /// `availability` map (keyed by CLI name, each `{available}`). On HTTP
  /// error (e.g. 404 unknown job) sets `ok: false` + `error`.
  Future<Map<String, dynamic>> fetchCliInstallStatus(String jobId) async {
    final res = await http
        .get(
          Uri.parse(_url('/api/cli/install-status/$jobId')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 10));
    final body = jsonDecode(res.body);
    final map = body is Map<String, dynamic> ? body : <String, dynamic>{};
    if (res.statusCode >= 400) {
      map['ok'] = false;
      map['error'] ??= _tryParseError(res.body) ?? '${res.statusCode}';
    }
    return map;
  }

  Future<void> deleteSession(String id) async {
    final res = await http
        .delete(Uri.parse(_url('/api/sessions/$id')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) throw Exception('${res.statusCode}');
  }

  /// Terminal-only: kills the tmux session and respawns the CLI with a fresh
  /// conversation. The server rejects chat sessions here — they use
  /// [restartSpawn], which has the opposite conversation semantics.
  Future<void> restartSession(String id) async {
    final res = await http
        .post(Uri.parse(_url('/api/sessions/$id/restart')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) throw Exception('${res.statusCode}');
  }

  /// Chat-only: destroys the CLI process and the server-side runtime state that
  /// outlives it, so a session wedged mid-turn can be recovered without losing
  /// the conversation — the next message respawns against the same native
  /// session. Returns the server's `before` snapshot of what was torn down.
  Future<Map<String, dynamic>> restartSpawn(String id) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/sessions/$id/restart-spawn')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 15));
    var map = <String, dynamic>{};
    try {
      final body = jsonDecode(res.body);
      if (body is Map<String, dynamic>) map = body;
    } catch (_) {
      // A tunnel or proxy can answer with HTML; fall through to the status code.
    }
    if (res.statusCode >= 400) {
      throw Exception(map['error'] ?? '${res.statusCode}');
    }
    return map;
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

  /// Resolve an in-progress rebase: 'continue' marks conflicts resolved and
  /// proceeds; 'abort' rolls the worktree back to the pre-rebase state. Mirrors
  /// web manage's rebase-resolve flow. On remaining conflicts (409) the result
  /// map carries `ok: false` and an updated `conflicts` list.
  Future<Map<String, dynamic>> rebaseSession(String id,
      {String action = 'continue'}) async {
    final res = await http
        .post(Uri.parse(_url('/api/sessions/$id/rebase')),
            headers: _headers, body: jsonEncode({'action': action}))
        .timeout(const Duration(seconds: 30));
    final body = jsonDecode(res.body);
    final map = body is Map<String, dynamic> ? body : <String, dynamic>{};
    if (res.statusCode >= 400) {
      map['ok'] = false;
      map['error'] ??= '${res.statusCode}';
    }
    return map;
  }

  /// Relocate a session to a different directory: drops the old worktree and
  /// creates a fresh one in the target directory's repo. The session keeps its
  /// id but its worktreePath/branch/dirId change. Used when a session's work
  /// belongs under a different project.
  Future<Map<String, dynamic>> relocateSession(String id, String targetDirId) async {
    final res = await http
        .post(Uri.parse(_url('/api/sessions/$id/relocate')),
            headers: _headers, body: jsonEncode({'dirId': targetDirId}))
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

  /// Fetch the worktree diff file list against the directory's base branch.
  /// Returns `{baseBranch, branch, files:[{path, oldPath, status, additions,
  /// deletions, binary}], totalFiles, totalAdditions, totalDeletions,
  /// truncated, mergeState, error}`. On HTTP error sets `ok: false` + `error`.
  Future<Map<String, dynamic>> fetchDiffFiles(String id) async {
    final res = await http
        .get(Uri.parse(_url('/api/sessions/$id/diff/files')), headers: _headers)
        .timeout(const Duration(seconds: 20));
    final body = jsonDecode(res.body);
    final map = body is Map<String, dynamic> ? body : <String, dynamic>{};
    if (res.statusCode >= 400) {
      map['ok'] = false;
      map['error'] ??= '${res.statusCode}';
    }
    return map;
  }

  /// Fetch the unified-diff patch for a single file. Returns `{path, patch,
  /// truncated, error}`. `patch` is the raw `git diff --no-color BASE -- path`
  /// text (with `diff --git` header), truncated to 256KB. On HTTP error sets
  /// `ok: false` + `error`.
  Future<Map<String, dynamic>> fetchFileDiff(String id, String path) async {
    final res = await http
        .get(
          Uri.parse(_url(
              '/api/sessions/$id/diff/file?path=${Uri.encodeQueryComponent(path)}')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 20));
    final body = jsonDecode(res.body);
    final map = body is Map<String, dynamic> ? body : <String, dynamic>{};
    if (res.statusCode >= 400) {
      map['ok'] = false;
      map['error'] ??= '${res.statusCode}';
    }
    return map;
  }

  /// Enqueue an aux AI task. Body: `{id, type, prompt, meta}`. Returns
  /// `{ok, result, error, taskId}`. Pass a [client] so the caller can close it
  /// to cancel the in-flight request (the resulting http.ClientException is
  /// rethrown so the caller can identify it as a cancellation). Timeout 130s
  /// (the aux queue may wait behind other tasks).
  Future<Map<String, dynamic>> enqueueAux({
    required String id,
    required String type,
    required String prompt,
    Map<String, dynamic>? meta,
    http.Client? client,
  }) async {
    final c = client ?? http.Client();
    final ownsClient = client == null;
    final body = <String, dynamic>{
      'id': id,
      'type': type,
      'prompt': prompt,
    };
    if (meta != null) body['meta'] = meta;
    try {
      final res = await c
          .post(
            Uri.parse(_url('/api/aux/enqueue')),
            headers: _headers,
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 130));
      final parsed = jsonDecode(res.body);
      final map = parsed is Map<String, dynamic> ? parsed : <String, dynamic>{};
      if (res.statusCode >= 400) {
        map['ok'] = false;
        map['error'] ??= '${res.statusCode}';
      }
      return map;
    } finally {
      if (ownsClient) c.close();
    }
  }

  /// Cancel an aux task by id. Best-effort: swallows all errors. Idempotent
  /// (server always returns `{ok: true}`). Missing/empty id is a no-op.
  Future<void> cancelAux(String taskId) async {
    if (taskId.isEmpty) return;
    try {
      await http
          .post(Uri.parse(_url('/api/aux/cancel')),
              headers: _headers, body: jsonEncode({'id': taskId}))
          .timeout(const Duration(seconds: 5));
    } catch (_) {
      // Best-effort cancel; ignore.
    }
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

  // Transport-level liveness for one session: {state: working|idle|stalled,
  // reason, silentMs, phase}. Used by the chat header pill to tell "working"
  // from "idle" and "stalled" at a glance.
  Future<Map<String, dynamic>> fetchLiveness(String id) async {
    final res = await http
        .get(
          Uri.parse(_url('/api/sessions/$id/liveness')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 10));
    final body = jsonDecode(res.body);
    final map = body is Map<String, dynamic> ? body : <String, dynamic>{};
    if (res.statusCode >= 400) {
      map['state'] = 'unknown';
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

  /// Switch Claude Code effort for a session. Empty string = follow default.
  /// Supported values: low, medium, high, xhigh, max, ultracode.
  Future<void> updateSessionEffort(String id, String effort) async {
    final res = await http
        .patch(
          Uri.parse(_url('/api/sessions/$id')),
          headers: _headers,
          body: jsonEncode({'effort': effort}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  /// Switch provider, model and effort/reasoning level together.
  /// Optionally also set/clear the per-session subagent override in the same
  /// atomic PATCH (subagent = null + clearSubagent = true → server stores null
  /// = 随主).
  Future<void> updateSessionAIConfig(
    String id, {
    required String provider,
    required String model,
    required String effort,
    SessionSubagent? subagent,
    bool clearSubagent = false,
    String? agent,
  }) async {
    final body = <String, dynamic>{
      'provider': provider,
      'model': model,
      'effort': effort,
    };
    if (agent != null) body['agent'] = agent;
    if (clearSubagent) {
      body['subagent'] = null;
    } else if (subagent != null && !subagent.isEmpty) {
      body['subagent'] = subagent.toJson();
    }
    final res = await http
        .patch(
          Uri.parse(_url('/api/sessions/$id')),
          headers: _headers,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  /// Switch the per-session provider (cc-switch). Empty string clears the
  /// override → the session falls back to the default login / subscription.
  /// Applies on the next chat turn. Returns the updated model that the server
  /// auto-filled from the new provider's model list (null if the provider
  /// supplies its own default via env).
  Future<String?> updateSessionProvider(String id, String provider) async {
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
    try {
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final m = body['model'];
      return (m is String && m.isNotEmpty) ? m : null;
    } catch (_) {
      return null;
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

  /// Read the session's current distilled memory fresh (the aux AI may have
  /// updated it since the dashboard list was loaded).
  Future<String> fetchSessionMemory(String id) async {
    final res = await http
        .get(Uri.parse(_url('/api/sessions/$id')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) return '';
    try {
      final j = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      return (j['memory'] ?? '').toString();
    } catch (_) {
      return '';
    }
  }

  Future<void> updateSessionMemory(String id, String memory) async {
    final res = await http
        .patch(
          Uri.parse(_url('/api/sessions/$id')),
          headers: _headers,
          body: jsonEncode({'memory': memory}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  // ── Folder-based memory library (own + shared .md files) ───────────────────
  // Mirrors the web openMemoryEditor(): GET returns {own:{dir,primary,files},
  // shared:{dir,files}, legacy}; each file in `files` is {name, content}.

  Future<Map<String, dynamic>> fetchSessionMemoryFiles(String id) async {
    final res = await http
        .get(Uri.parse(_url('/api/sessions/$id/memory')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  /// Create or overwrite one memory file. Returns the refreshed file list
  /// (each {name, content}) the server echoes back.
  Future<List<Map<String, dynamic>>> putMemoryFile(
    String id, {
    required String scope,
    required String name,
    required String content,
  }) async {
    final res = await http
        .put(
          Uri.parse(_url('/api/sessions/$id/memory')),
          headers: _headers,
          body: jsonEncode({'scope': scope, 'name': name, 'content': content}),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    final list = (data['files'] as List? ?? []);
    return list.map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  /// Delete one memory file. Returns the refreshed file list.
  Future<List<Map<String, dynamic>>> deleteMemoryFile(
    String id, {
    required String scope,
    required String name,
  }) async {
    final res = await http
        .delete(
          Uri.parse(_url('/api/sessions/$id/memory')),
          headers: _headers,
          body: jsonEncode({'scope': scope, 'name': name}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    final list = (data['files'] as List? ?? []);
    return list.map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  /// List all active shares for a session.
  Future<List<Map<String, dynamic>>> listShares(String id) async {
    final res = await http
        .get(Uri.parse(_url('/api/sessions/$id/shares')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    final list = (data['shares'] as List? ?? []);
    return list.map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  /// Revoke (delete) a share by its token.
  Future<void> deleteShare(String sessionId, String token) async {
    final res = await http
        .delete(
          Uri.parse(_url('/api/sessions/$sessionId/share/$token')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  /// Delete a single message from this session's persisted chat history.
  /// Display-history only: the CLI's own transcript/context is not rewritten,
  /// so the model may still "remember" the content. The server broadcasts
  /// chat_msg_deleted afterwards, so callers may also remove it locally and
  /// rely on the broadcast being a no-op idempotent refresh.
  Future<void> deleteMessage(String sessionId, String msgId) async {
    final res = await http
        .delete(
          Uri.parse(_url('/api/sessions/$sessionId/messages/$msgId')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
  }

  /// Fork a session at [atMessageId] (or at the latest message if null).
  /// Returns the new session id. Mirrors the web chat's per-message fork.
  Future<String> forkSession(String sessionId, {String? atMessageId}) async {
    final body = <String, dynamic>{};
    if (atMessageId != null && atMessageId.isNotEmpty) body['atMessageId'] = atMessageId;
    final res = await http
        .post(
          Uri.parse(_url('/api/sessions/$sessionId/fork')),
          headers: _headers,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 20));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    final d = jsonDecode(res.body) as Map<String, dynamic>;
    return d['sessionId'] as String;
  }

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

  /// Fetch a window of history centered on [messageId] from
  /// `GET /api/sessions/:id/history?around=<messageId>`. Used by the deep-link
  /// focus flow (task-board message -> open chat scrolled to that message): the
  /// server returns the page containing the target plus `found` / `hasMore` /
  /// `hasNewer` flags. `found` is false when the message was trimmed from
  /// history. The raw message maps reuse [ChatMessage.fromHistory] at the call
  /// site, the same parser as [fetchHistory].
  Future<({List<Map<String, dynamic>> messages, bool found, bool hasMore, bool hasNewer})>
      fetchHistoryAround(String sessionId, String messageId) async {
    final res = await http
        .get(
          Uri.parse(_url(
            '/api/sessions/${Uri.encodeComponent(sessionId)}/history'
            '?around=${Uri.encodeQueryComponent(messageId)}',
          )),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    final list = (data['messages'] as List? ?? []);
    return (
      messages: list.map((e) => (e as Map).cast<String, dynamic>()).toList(),
      found: data['found'] == true,
      hasMore: data['hasMore'] == true,
      hasNewer: data['hasNewer'] == true,
    );
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

  /// Fetch this session's dispatch summary (durable operations joined with the
  /// target session's queue state — the authoritative projection).
  /// relation=both covers both directions: dispatches this session owns (sent
  /// to workers) and dispatches targeting it (received from commanders).
  /// `recentTerminalLimit=5` bounds terminal history without letting it evict
  /// live work inside the endpoint's established response cap.
  /// Throws on transport/HTTP failure; the caller keeps the last snapshot.
  Future<List<Map<String, dynamic>>> fetchDispatchQueue(String id) async {
    final res = await http
        .get(
          Uri.parse(
            _url(
              '/api/sessions/$id/dispatches?activeOnly=false&relation=both&recentTerminalLimit=5',
            ),
          ),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      final err = _tryParseError(res.body);
      throw Exception(err ?? '${res.statusCode}');
    }
    final body = jsonDecode(res.body);
    final list = body is Map<String, dynamic> ? body['dispatches'] : null;
    if (list is! List) return const [];
    return list
        .whereType<Map>()
        .map((m) => Map<String, dynamic>.from(m))
        .toList();
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
            Uri.parse(
              _url('/api/fs/list?path=${Uri.encodeQueryComponent(path)}'),
            ),
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

  /// List uncommitted files in a directory's main working tree (dir.path), so
  /// the UI can warn before a session worktree merge tangles with dirty main.
  /// Returns `{files: [{status, path}, ...]}`.
  Future<Map<String, dynamic>> fetchUncommitted(String id) async {
    final res = await http
        .get(Uri.parse(_url('/api/directories/$id/uncommitted')), headers: _headers)
        .timeout(const Duration(seconds: 15));
    final body = jsonDecode(res.body);
    final map = body is Map<String, dynamic> ? body : <String, dynamic>{};
    if (res.statusCode >= 400) {
      map['error'] ??= _tryParseError(res.body) ?? '${res.statusCode}';
    }
    return map;
  }

  /// Quick-commit-all on the directory's main working tree. Used by the "未提交"
  /// warning affordance to clear a dirty main before merging session branches.
  /// `message` optional; server falls back to an auto message when empty.
  Future<Map<String, dynamic>> commitAll(String id, {String? message}) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/directories/$id/commit')),
          headers: _headers,
          body: jsonEncode({'message': message ?? ''}),
        )
        .timeout(const Duration(seconds: 30));
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
    String? provider,
    String? effort,
    String? agent,
    String? rolePrompt,
  }) async {
    final body = <String, dynamic>{'cli': cli.name, 'kind': kind.name};
    if (label != null && label.isNotEmpty) body['label'] = label;
    if (model != null && model.isNotEmpty) body['model'] = model;
    if (provider != null) body['provider'] = provider;
    if (effort != null && effort.isNotEmpty) body['effort'] = effort;
    if (agent != null && agent.isNotEmpty) body['agent'] = agent;
    if (rolePrompt != null && rolePrompt.isNotEmpty) {
      body['rolePrompt'] = rolePrompt;
    }
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
