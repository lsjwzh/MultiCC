import 'dart:convert';
import 'package:http/http.dart' as http;

import '../models/message.dart';
import '../models/task_board.dart';
import 'settings_service.dart';

/// Thrown by task-board write endpoints (status / reclassify /
/// reclassify-pending) when the server rejects a non-localhost caller with
/// 403. The host machine owns those mutations; a remote phone must surface
/// "该操作仅本机可用" instead of a generic HTTP error.
class LocalOnlyException implements Exception {
  final String? message;
  const LocalOnlyException([this.message]);

  @override
  String toString() => message ?? 'local-only';
}

/// Thrown by the task-board dispatch endpoints (POST .../send) when the server
/// rejects the route: 409 (no idle/relevant target, or the chosen session is
/// busy) carries a human-readable `note` from the server; 503 (aux-AI
/// unhealthy) and 400 (empty text) carry only an `error` code, so `note` is
/// left empty and the UI maps the `code` to a localized message. 403 still
/// surfaces as [LocalOnlyException] (the dispatch endpoints are localhost-only).
class BoardRouteException implements Exception {
  final String code;
  final String note;
  const BoardRouteException(this.code, this.note);

  @override
  String toString() => note.isEmpty ? code : note;
}

/// Thin REST client for the server-side management endpoints that the web
/// dashboard (manage.html) exposes: scheduled tasks (cron), agent resources
/// (skills / Claude history), temp-upload cache, token usage, access-token,
/// official-oauth, dashboard overview, per-directory events, push channels
/// (Bark / Webhook), external tunnel, and voice settings. Write endpoints that
/// are localhost-only on the server return 403 from a remote phone — callers
/// must surface "仅本机可改" for those.
class ManageService {
  final SettingsService settings;
  ManageService({required this.settings});

  Map<String, String> get _headers {
    final h = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) h['X-Access-Token'] = settings.token;
    return h;
  }

  String _url(String path) => settings.buildHttpUrl(path);

  String? _tryParseError(String body) {
    try {
      final j = jsonDecode(body);
      if (j is Map && j['error'] != null) return j['error'].toString();
    } catch (_) {}
    return null;
  }

  Never _throw(http.Response res) =>
      throw Exception(_tryParseError(res.body) ?? 'HTTP ${res.statusCode}');

  /// Write endpoints that mutate the task board are localhost-only on the
  /// server: a remote phone gets 403. Convert that into a [LocalOnlyException]
  /// so the UI can surface "仅本机可用"; any other failure falls through to
  /// the generic [_throw].
  void _throwWrite(http.Response res) {
    if (res.statusCode == 403) throw const LocalOnlyException();
    _throw(res);
  }

  // ── Cron (定时任务) ─────────────────────────────────────────────────────────

  Future<List<CronTask>> fetchCronTasks() async {
    final res = await http
        .get(Uri.parse(_url('/api/cron')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) _throw(res);
    final list = jsonDecode(utf8.decode(res.bodyBytes)) as List;
    return list
        .map((j) => CronTask.fromJson((j as Map).cast<String, dynamic>()))
        .toList();
  }

  Future<CronTask> createCronTask({
    required String name,
    required String dirId,
    required String prompt,
    required String cron,
    String cli = 'claude',
    bool enabled = true,
  }) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/cron')),
          headers: _headers,
          body: jsonEncode({
            'name': name,
            'dirId': dirId,
            'prompt': prompt,
            'cron': cron,
            'cli': cli,
            'enabled': enabled,
            'createdBy': 'app',
          }),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    return CronTask.fromJson(
      (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>(),
    );
  }

  Future<CronTask> updateCronTask(
    String id, {
    String? name,
    String? dirId,
    String? prompt,
    String? cron,
    String? cli,
    bool? enabled,
  }) async {
    final body = <String, dynamic>{};
    if (name != null) body['name'] = name;
    if (dirId != null) body['dirId'] = dirId;
    if (prompt != null) body['prompt'] = prompt;
    if (cron != null) body['cron'] = cron;
    if (cli != null) body['cli'] = cli;
    if (enabled != null) body['enabled'] = enabled;
    final res = await http
        .patch(
          Uri.parse(_url('/api/cron/$id')),
          headers: _headers,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    return CronTask.fromJson(
      (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>(),
    );
  }

  Future<void> deleteCronTask(String id) async {
    final res = await http
        .delete(Uri.parse(_url('/api/cron/$id')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
  }

  /// Fire a task immediately. Returns the created/reused session id when known.
  Future<Map<String, dynamic>> runCronTask(String id) async {
    final res = await http
        .post(Uri.parse(_url('/api/cron/$id/run')), headers: _headers)
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  // ── Agent resources (skills) ───────────────────────────────────────────────

  /// Returns `{skills: [...], counts: {claude, codex}}`.
  Future<Map<String, dynamic>> fetchSkills() async {
    final res = await http
        .get(Uri.parse(_url('/api/agent-resources/skills')), headers: _headers)
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  // ── Agent resources (Claude history) ───────────────────────────────────────

  /// Returns `{sessions: [...], count, totalSize, protectedCount}`.
  Future<Map<String, dynamic>> fetchClaudeHistory() async {
    final res = await http
        .get(
          Uri.parse(_url('/api/agent-resources/claude-sessions')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 20));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// Bulk-delete history sessions older than [olderThanDays] (linked sessions
  /// are protected server-side). Returns `{ok, deleted, freed}`.
  Future<Map<String, dynamic>> cleanupClaudeHistory(int olderThanDays) async {
    final res = await http
        .delete(
          Uri.parse(
            _url(
              '/api/agent-resources/claude-sessions?olderThanDays=$olderThanDays',
            ),
          ),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 30));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  // ── Providers (cc-switch import + multicc-owned store) ─────────────────────

  /// Returns `{available, ccSwitchAvailable, providers: [...], defaults: {...}}`.
  Future<Map<String, dynamic>> fetchProviders([String? appType]) async {
    final q = (appType == 'claude' || appType == 'codex')
        ? '?appType=$appType'
        : '';
    final res = await http
        .get(Uri.parse(_url('/api/providers$q')), headers: _headers)
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// Import / sync from cc-switch. Returns `{ok, imported, updated, total}`.
  Future<Map<String, dynamic>> importProviders() async {
    final res = await http
        .post(Uri.parse(_url('/api/providers/import')), headers: _headers)
        .timeout(const Duration(seconds: 20));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  Future<void> createProvider({
    required String appType,
    required String name,
    String baseUrl = '',
    String authToken = '',
    String model = '',
    List<String> models = const [],
    bool useChatResponsesProxy = false,
    Map<String, dynamic>? aliasMap,
  }) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/providers')),
          headers: _headers,
          body: jsonEncode({
            'appType': appType,
            'name': name,
            'baseUrl': baseUrl,
            'authToken': authToken,
            'model': model,
            'models': models,
            'useChatResponsesProxy': useChatResponsesProxy,
            if (aliasMap != null) 'aliasMap': aliasMap,
          }),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
  }

  Future<void> updateProvider(
    String appType,
    String id, {
    String? name,
    String? baseUrl,
    String? authToken,
    String? model,
    List<String>? models,
    bool? useChatResponsesProxy,
    Map<String, dynamic>? aliasMap,
  }) async {
    final body = <String, dynamic>{};
    if (name != null) body['name'] = name;
    if (baseUrl != null) body['baseUrl'] = baseUrl;
    if (authToken != null && authToken.isNotEmpty) {
      body['authToken'] = authToken;
    }
    if (model != null) body['model'] = model;
    if (models != null) body['models'] = models;
    if (useChatResponsesProxy != null) {
      body['useChatResponsesProxy'] = useChatResponsesProxy;
    }
    if (aliasMap != null) body['aliasMap'] = aliasMap;
    final res = await http
        .patch(
          Uri.parse(_url('/api/providers/$appType/$id')),
          headers: _headers,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
  }

  Future<void> deleteProvider(String appType, String id) async {
    final res = await http
        .delete(
          Uri.parse(_url('/api/providers/$appType/$id')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
  }

  // ── Aux (AI assistant) ─────────────────────────────────────────────────────
  // Mirrors the /api/aux/* + /api/reclassify-* endpoints the web dashboard
  // drives. The aux helper is a side-channel AI that classifies each session's
  // goal/phase and runs background tasks; these methods cover its config,
  // task history, health, and the reclassify triggers.

  /// Aux task history (newest last). Each entry is a chat_history message
  /// `{role:'user'|'assistant', content, ts, taskType?, meta?, error?, ...}`.
  Future<List<Map<String, dynamic>>> fetchAuxHistory({int limit = 50}) async {
    final res = await http
        .get(
          Uri.parse(_url('/api/aux/history?limit=$limit')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    final list = jsonDecode(utf8.decode(res.bodyBytes));
    if (list is! List) return [];
    return list.map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  /// Aux config + provider lists for the pickers.
  /// `{protocol, providerId?, model?, protocols, providersByProtocol}`.
  Future<Map<String, dynamic>> fetchAuxConfig() async {
    final res = await http
        .get(Uri.parse(_url('/api/aux/config')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// Save aux config. Returns `{ok, protocol, providerId, model, wireApi}`.
  Future<Map<String, dynamic>> saveAuxConfig({
    required String protocol,
    String providerId = '',
    String model = '',
  }) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/aux/config')),
          headers: _headers,
          body: jsonEncode({
            'protocol': protocol,
            'providerId': providerId,
            'model': model,
          }),
        )
        .timeout(const Duration(seconds: 10));
    try {
      final j = (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
          .cast<String, dynamic>();
      if (res.statusCode >= 400 && j['ok'] != true) {
        throw Exception(j['error']?.toString() ?? 'HTTP ${res.statusCode}');
      }
      return j;
    } catch (e) {
      if (e is Exception) rethrow;
      _throw(res);
    }
  }

  /// Reclassify all sessions. `onlyJunk:true` (default server-side) only
  /// re-runs sessions whose goal looks like junk/injected preamble; `false`
  /// re-runs every session. Returns `{ok, count, ids, onlyJunk}`.
  Future<Map<String, dynamic>> reclassifyAll({bool onlyJunk = false}) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/reclassify-all')),
          headers: _headers,
          body: jsonEncode({'onlyJunk': onlyJunk}),
        )
        .timeout(const Duration(seconds: 20));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// Reclassify a single session by id.
  Future<Map<String, dynamic>> reclassifySession(String sessionId) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/sessions/$sessionId/reclassify')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 20));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// Aux health: `{health:{unhealthy, consecutiveFails, lastFailMsg?, sinceAt?}}`.
  Future<Map<String, dynamic>> fetchAuxHealth() async {
    final res = await http
        .get(Uri.parse(_url('/api/aux/health')), headers: _headers)
        .timeout(const Duration(seconds: 8));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// Speed-test one provider. Returns `{ok, ms, status?, model?, error?}` —
  /// mirrors POST /api/providers/:appType/:id/speedtest. On failure `status`
  /// carries the upstream HTTP code (429/404/401…) so the UI can distinguish
  /// rate-limit / quota / misconfig at a glance; timeout/network errors carry
  /// no status.
  Future<Map<String, dynamic>> speedtestProvider(
    String appType,
    String id,
  ) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/providers/$appType/$id/speedtest')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 20));
    // The endpoint always returns 200 with a JSON body describing the probe
    // result (ok:false + error for upstream failures), so parse the body
    // rather than the HTTP status.
    try {
      return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
          .cast<String, dynamic>();
    } catch (_) {
      if (res.statusCode >= 400) _throw(res);
      return {'ok': false, 'ms': 0, 'error': 'HTTP ${res.statusCode}'};
    }
  }

  Future<void> setProviderDefaults({String? claude, String? codex}) async {
    final body = <String, dynamic>{};
    if (claude != null) body['claude'] = claude;
    if (codex != null) body['codex'] = codex;
    final res = await http
        .put(
          Uri.parse(_url('/api/provider-defaults')),
          headers: _headers,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
  }

  // ── Temp uploads cache ─────────────────────────────────────────────────────

  /// Returns `{count, totalSize, dir, files: [...]}`.
  Future<Map<String, dynamic>> fetchUploadStats() async {
    final res = await http
        .get(Uri.parse(_url('/api/uploads/stats')), headers: _headers)
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// Delete all cached temp uploads. Returns `{ok, deleted, freed}`.
  Future<Map<String, dynamic>> cleanupUploads() async {
    final res = await http
        .delete(Uri.parse(_url('/api/uploads/cleanup')), headers: _headers)
        .timeout(const Duration(seconds: 30));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  // ── Skill synchronization ─────────────────────────────────────────────────

  Future<Map<String, dynamic>> fetchSkillSyncStatus() async {
    final res = await http
        .get(Uri.parse(_url('/api/skill-sync/status')), headers: _headers)
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  Future<Map<String, dynamic>> runSkillSync() async {
    final res = await http
        .post(Uri.parse(_url('/api/skill-sync/run')), headers: _headers)
        .timeout(const Duration(seconds: 45));
    if (res.statusCode >= 400) _throw(res);
    final body = (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
    return body['result'] is Map
        ? (body['result'] as Map).cast<String, dynamic>()
        : body;
  }

  // ── Message bridges ───────────────────────────────────────────────────────

  static const _bridgePlatforms = {
    'feishu',
    'telegram',
    'discord',
    'slack',
    'wechat',
  };

  String _bridgePath(String platform, String suffix) {
    if (!_bridgePlatforms.contains(platform)) {
      throw ArgumentError.value(platform, 'platform', 'unsupported bridge');
    }
    return '/api/$platform/$suffix';
  }

  Future<Map<String, dynamic>> fetchBridgeStatus(String platform) async {
    final res = await http
        .get(
          Uri.parse(_url(_bridgePath(platform, 'status'))),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 12));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  Future<Map<String, dynamic>> fetchBridgeConfig(String platform) async {
    final res = await http
        .get(
          Uri.parse(_url(_bridgePath(platform, 'config'))),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 12));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  Future<void> saveBridgeConfig(
    String platform,
    Map<String, dynamic> config,
  ) async {
    final res = await http
        .post(
          Uri.parse(_url(_bridgePath(platform, 'config'))),
          headers: _headers,
          body: jsonEncode(config),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
  }

  Future<void> setBridgeRunning(String platform, bool running) async {
    final res = await http
        .post(
          Uri.parse(_url(_bridgePath(platform, running ? 'start' : 'stop'))),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 30));
    if (res.statusCode >= 400) _throw(res);
  }

  Future<Map<String, dynamic>> setBridgeGateway(
    String platform,
    String cli,
  ) async {
    final res = await http
        .put(
          Uri.parse(_url(_bridgePath(platform, 'gateway'))),
          headers: _headers,
          body: jsonEncode({'cli': cli}),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  Future<void> resetBridgeGateway(String platform) async {
    final res = await http
        .post(
          Uri.parse(_url(_bridgePath(platform, 'gateway/reset'))),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
  }

  Future<void> deleteBridgeGateway(String platform) async {
    final res = await http
        .delete(
          Uri.parse(_url(_bridgePath(platform, 'gateway'))),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
  }

  Future<List<Map<String, dynamic>>> fetchBridgeLog(String platform) async {
    final res = await http
        .get(Uri.parse(_url(_bridgePath(platform, 'log'))), headers: _headers)
        .timeout(const Duration(seconds: 12));
    if (res.statusCode >= 400) _throw(res);
    final list = jsonDecode(utf8.decode(res.bodyBytes));
    if (list is! List) return const [];
    return list.map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  // ── Server-side config: token usage / access-token / official-oauth ─────────
  // These were web-dashboard-only; now surfaced in the app so phone clients can
  // read them. Write endpoints are localhost-only on the server, so a remote
  // phone gets 403 — callers must handle that (read-only fallback).

  /// Global token usage. `force: true` bypasses the server cache (refresh btn).
  /// Returns `{generatedAt, responses, windows:{today,week,month,all:{model:tokens}}, byDay}`.
  Future<Map<String, dynamic>> fetchTokenUsage({bool force = false}) async {
    final q = force ? '?refresh=1' : '';
    final res = await http
        .get(Uri.parse(_url('/api/token-usage/global$q')), headers: _headers)
        .timeout(const Duration(seconds: 20));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// Access-token (remote-login password). Masked; editable only from localhost.
  /// Returns `{hasToken, masked, canEdit}`.
  Future<Map<String, dynamic>> fetchAccessToken() async {
    final res = await http
        .get(Uri.parse(_url('/api/settings/access-token')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// Set/clear the access token. Server rejects non-localhost with 403; the
  /// caller should catch Exception and surface "仅本机可改".
  Future<void> saveAccessToken(String token) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/settings/access-token')),
          headers: _headers,
          body: jsonEncode({'token': token}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
  }

  /// Route claude-official (OAuth subscription) through the proxy.
  /// Returns `{enabled}`. POST is localhost-only.
  Future<bool> fetchOfficialOauth() async {
    final res = await http
        .get(Uri.parse(_url('/api/settings/official-oauth')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)['enabled'] == true;
  }

  Future<void> setOfficialOauth(bool enabled) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/settings/official-oauth')),
          headers: _headers,
          body: jsonEncode({'enabled': enabled}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
  }

  // ── Dashboard (session overview + aggregate stats) ─────────────────────────

  /// All sessions with active flag + lastActivity. Optional `kind` filter.
  /// Returns `{sessions: [...], count}`.
  Future<Map<String, dynamic>> fetchDashboardSessions({String? kind}) async {
    final q = (kind == 'chat' || kind == 'terminal') ? '?kind=$kind' : '';
    final res = await http
        .get(Uri.parse(_url('/api/dashboard/sessions$q')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// Aggregate stats: `{total, active, byCli, byKind}`.
  Future<Map<String, dynamic>> fetchDashboardStats() async {
    final res = await http
        .get(Uri.parse(_url('/api/dashboard/stats')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  // ── Per-directory activity feed (events) ───────────────────────────────────

  /// Recent events for a directory. Returns `{events: [{ts,type,sessionId,sessionLabel,detail}]}`.
  Future<List<Map<String, dynamic>>> fetchDirectoryEvents(String dirId) async {
    final res = await http
        .get(
          Uri.parse(_url('/api/directories/$dirId/events')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    final j = jsonDecode(utf8.decode(res.bodyBytes)) as Map;
    final evs = j['events'] as List? ?? [];
    return evs.map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  // ── Push notification channels (Bark / Webhook) ────────────────────────────

  /// Returns `{barkUrl, hasBark, webhookUrl, hasWebhook}` (URLs masked).
  Future<Map<String, dynamic>> fetchNotifyConfig() async {
    final res = await http
        .get(Uri.parse(_url('/api/settings/notify')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  Future<void> saveNotifyConfig({String? barkUrl, String? webhookUrl}) async {
    final body = <String, dynamic>{};
    if (barkUrl != null) body['barkUrl'] = barkUrl;
    if (webhookUrl != null) body['webhookUrl'] = webhookUrl;
    final res = await http
        .post(
          Uri.parse(_url('/api/settings/notify')),
          headers: _headers,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
  }

  /// Push health: `{subscriptionCount, global, bark:{configured,...}, webhook:{configured,...}, subscriptions:[...]}`.
  Future<Map<String, dynamic>> fetchPushHealth() async {
    final res = await http
        .get(Uri.parse(_url('/api/push/health')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  Future<Map<String, dynamic>> testPush() async {
    final res = await http
        .post(Uri.parse(_url('/api/push/test')), headers: _headers)
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  Future<Map<String, dynamic>> testBark() async {
    final res = await http
        .post(Uri.parse(_url('/api/push/test-bark')), headers: _headers)
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  Future<Map<String, dynamic>> testWebhook() async {
    final res = await http
        .post(Uri.parse(_url('/api/push/test-webhook')), headers: _headers)
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  // ── External tunnel (花生壳 / Tailscale) ───────────────────────────────────

  /// Returns tunnel.getStatus(): `{phddns:{enabled,url,...}, tailscale:{enabled,url,funnel,...}, ...}`.
  Future<Map<String, dynamic>> fetchTunnelStatus() async {
    final res = await http
        .get(Uri.parse(_url('/api/settings/tunnel')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  Future<Map<String, dynamic>> restartTunnel(String provider) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/tunnel/restart/$provider')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 20));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  // ── Voice settings (read-only: keys are sensitive, edit stays on web) ───────

  /// Returns the full voice-config shape (asr / tts / whisper / openrouter).
  Future<Map<String, dynamic>> fetchVoiceSettings() async {
    final res = await http
        .get(Uri.parse(_url('/api/settings/voice')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  // ── Task board (AI-tagged module->task tree) ───────────────────────────────
  // Mirrors /api/task-board/* (see src/routes/task-board.js). Read endpoints are
  // open to any authenticated client; writes (status / reclassify /
  // reclassify-pending) are localhost-only and surface [LocalOnlyException] on
  // 403 so a remote phone shows "仅本机可用".

  /// GET /api/task-board -> { ok, modules, tasks, sessionLabels, backfill }.
  Future<TaskBoard> fetchTaskBoard() async {
    final res = await http
        .get(Uri.parse(_url('/api/task-board')), headers: _headers)
        .timeout(const Duration(seconds: 12));
    if (res.statusCode != 200) _throw(res);
    return TaskBoard.fromJson(
      (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>(),
    );
  }

  /// GET `/api/task-board/tasks/<taskId>/messages` -> durable task detail. New
  /// servers include up to five TaskRuns; old servers omit that field and parse
  /// as an empty run list.
  Future<TaskBoardDetail> fetchTaskDetail(String taskId) async {
    final res = await http
        .get(
          Uri.parse(
            _url(
              '/api/task-board/tasks/${Uri.encodeComponent(taskId)}/messages',
            ),
          ),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 12));
    if (res.statusCode != 200) _throw(res);
    return TaskBoardDetail.fromJson(
      (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>(),
    );
  }

  /// Backwards-compatible message-only reader for callers that do not render
  /// TaskRun history yet.
  Future<List<TaskMessage>> fetchTaskMessages(String taskId) async {
    return (await fetchTaskDetail(taskId)).messages;
  }

  /// Answers the currently waiting question for a hidden TaskRun owned by
  /// [taskId]. The client-generated id is stable across a retry of the same
  /// text, allowing the server to deduplicate an uncertain HTTP outcome.
  Future<Map<String, dynamic>> answerTaskQuestion(
    String taskId, {
    required String requestId,
    required String text,
    required String clientMsgId,
  }) async {
    final res = await http
        .post(
          Uri.parse(
            _url('/api/task-board/tasks/${Uri.encodeComponent(taskId)}/answer'),
          ),
          headers: _headers,
          body: jsonEncode({
            'requestId': requestId,
            'text': text,
            'clientMsgId': clientMsgId,
          }),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode != 200) _throwBoardSend(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// POST .../status body {status}. `status` ∈ active | done | archived.
  /// localhost-only; throws [LocalOnlyException] on 403.
  Future<void> setTaskStatus(String taskId, String status) async {
    final res = await http
        .post(
          Uri.parse(
            _url('/api/task-board/tasks/${Uri.encodeComponent(taskId)}/status'),
          ),
          headers: _headers,
          body: jsonEncode({'status': status}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throwWrite(res);
  }

  /// POST .../reclassify -> re-queue this task's classification.
  /// localhost-only; throws [LocalOnlyException] on 403.
  Future<Map<String, dynamic>> reclassifyTask(String taskId) async {
    final res = await http
        .post(
          Uri.parse(
            _url(
              '/api/task-board/tasks/${Uri.encodeComponent(taskId)}/reclassify',
            ),
          ),
          headers: _headers,
          body: '{}',
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throwWrite(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// POST /api/task-board/reclassify-pending body {dirId?} -> re-queue every
  /// still-pending task, optionally scoped to one directory. localhost-only;
  /// throws [LocalOnlyException] on 403. Returns {ok, queued, skipped}.
  Future<Map<String, dynamic>> reclassifyPending({String? dirId}) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/task-board/reclassify-pending')),
          headers: _headers,
          body: jsonEncode({
            if (dirId != null && dirId.isNotEmpty) 'dirId': dirId,
          }),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throwWrite(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  // ── Task-board dispatch (派发) ─────────────────────────────────────────────
  // POST /api/task-board/send (dir-level) and POST /api/task-board/tasks/:id/send
  // (task-level) route a message to an idle, relevant chat session. Both are
  // localhost-only (403 -> LocalOnlyException). A 409 carries the server's
  // human note (no idle target / target busy); 503 means the aux-AI is
  // unhealthy; 400 empty_text is a backstop the UI also guards client-side.

  /// Converts a dispatch-endpoint failure into the right exception type. 409/400
  /// become [BoardRouteException] (note from the server when present); 503
  /// becomes a code-only [BoardRouteException] the UI localizes; 403 stays
  /// [LocalOnlyException]; anything else falls through to [_throw].
  Never _throwBoardSend(http.Response res) {
    if (res.statusCode == 403) throw const LocalOnlyException();
    if (res.statusCode == 503) {
      throw const BoardRouteException('aux_unhealthy', '');
    }
    if (res.statusCode == 409 || res.statusCode == 400) {
      var code = res.statusCode == 400 ? 'bad_request' : 'route_failed';
      var note = '';
      try {
        final j = jsonDecode(res.body);
        if (j is Map) {
          code = (j['error'] ?? code).toString();
          note = (j['note'] ?? '').toString();
        }
      } catch (_) {}
      throw BoardRouteException(code, note);
    }
    _throw(res);
  }

  /// POST /api/task-board/send -> route [text] to an idle chat session in
  /// [dirId], creating a pending task. Returns `{ok, taskId, target,
  /// targetLabel, ...}`. Throws [LocalOnlyException] / [BoardRouteException].
  Future<Map<String, dynamic>> sendToBoard(
    String dirId, {
    required String text,
    String? target,
    bool goal = false,
    Map<String, dynamic>? goalLimits,
  }) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/task-board/send')),
          headers: _headers,
          body: jsonEncode({
            'text': text,
            'dirId': dirId,
            if (target != null && target.isNotEmpty) 'target': target,
            if (goal) 'goal': true,
            if (goal) 'goalLimits': goalLimits ?? const <String, dynamic>{},
          }),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode != 200) _throwBoardSend(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// POST `/api/task-board/tasks/:taskId/send` -> route [text] to an idle
  /// session relevant to [taskId]. Returns `{ok, target, targetLabel, ...}`.
  /// Throws [LocalOnlyException] / [BoardRouteException].
  Future<Map<String, dynamic>> sendToTask(
    String taskId, {
    required String text,
    String? target,
    bool goal = false,
    Map<String, dynamic>? goalLimits,
  }) async {
    final res = await http
        .post(
          Uri.parse(
            _url('/api/task-board/tasks/${Uri.encodeComponent(taskId)}/send'),
          ),
          headers: _headers,
          body: jsonEncode({
            'text': text,
            if (target != null && target.isNotEmpty) 'target': target,
            if (goal) 'goal': true,
            if (goal) 'goalLimits': goalLimits ?? const <String, dynamic>{},
          }),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode != 200) _throwBoardSend(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// POST /api/task-board/archive-completed -> bulk-archive all done tasks.
  /// Returns {ok, archivedCount, taskIds}. Throws [LocalOnlyException] on 403.
  Future<Map<String, dynamic>> archiveCompletedTasks({String? dirId}) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/task-board/archive-completed')),
          headers: _headers,
          body: jsonEncode({
            if (dirId != null && dirId.isNotEmpty) 'dirId': dirId,
          }),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throwWrite(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// Back-compatible endpoint: manually mark a waiting turn as succeeded.
  /// It does not complete the TaskBoard lifecycle. Returns {ok, classifyState,
  /// turnOutcome}.
  /// 409 = session is streaming; 404 = session not found.
  Future<Map<String, dynamic>> markTurnSucceeded(String sessionId) async {
    final res = await http
        .post(
          Uri.parse(_url('/api/sessions/$sessionId/mark-task-done')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throwWrite(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }
}
