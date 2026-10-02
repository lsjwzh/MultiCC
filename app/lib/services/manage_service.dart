import 'dart:convert';
import 'package:http/http.dart' as http;

import '../models/docs_registry_entry.dart';
import '../models/message.dart';
import 'settings_service.dart';

/// Version-skew fallback for write endpoints. Since 57bfe99 (2026-07) the
/// server allows ANY authenticated client to perform these writes; older
/// servers rejected non-localhost callers with 403. Keep mapping that 403 so
/// a phone talking to an outdated host still surfaces "该操作仅本机可用"
/// instead of a generic HTTP error.
class LocalOnlyException implements Exception {
  final String? message;
  const LocalOnlyException([this.message]);

  @override
  String toString() => message ?? 'local-only';
}

/// DELETE /api/providers/:appType/:id answered 409: the provider is still
/// wired into sessions / CLI defaults / Aux (`PROVIDER_IN_USE`), or a force
/// delete could not unwire all of them (`PROVIDER_DETACH_FAILED`, the provider
/// was kept). [forceable] is false on servers without `?force=1`.
class ProviderInUseException implements Exception {
  final String code;
  final List<Map<String, dynamic>> references;
  final bool forceable;
  const ProviderInUseException(this.code, this.references, this.forceable);

  bool get detachFailed => code == 'PROVIDER_DETACH_FAILED';

  @override
  String toString() => 'provider is still referenced (${references.length})';
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

  /// Injectable for tests (MockClient); production callers leave it null and
  /// requests go through the package-level `http` functions as before.
  final http.Client? httpClient;
  ManageService({required this.settings, this.httpClient});

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

  /// Writes are open to any authenticated client on current servers; a 403 can
  /// only come from an outdated pre-57bfe99 host. Convert it into a
  /// [LocalOnlyException] so the UI can surface "仅本机可用"; any other failure
  /// falls through to the generic [_throw].
  void _throwWrite(http.Response res) {
    if (res.statusCode == 403) throw const LocalOnlyException();
    _throw(res);
  }

  // ── Cron (定时任务) ─────────────────────────────────────────────────────────

  /// One place for the "injected client when a test gave us one, package-level
  /// helpers otherwise" split. Every caller that needs a request to be
  /// interceptable goes through here instead of duplicating the ternaries.
  Future<http.Response> _send(
    String method,
    String path, {
    Object? body,
    Duration timeout = const Duration(seconds: 10),
  }) {
    final uri = Uri.parse(_url(path));
    final headers = _headers;
    final client = httpClient;
    final call = switch (method) {
      'GET' =>
        client == null
            ? http.get(uri, headers: headers)
            : client.get(uri, headers: headers),
      'POST' =>
        client == null
            ? http.post(uri, headers: headers, body: body)
            : client.post(uri, headers: headers, body: body),
      'PATCH' =>
        client == null
            ? http.patch(uri, headers: headers, body: body)
            : client.patch(uri, headers: headers, body: body),
      'DELETE' =>
        client == null
            ? http.delete(uri, headers: headers)
            : client.delete(uri, headers: headers),
      _ => throw ArgumentError.value(method, 'method', '不支持的方法'),
    };
    return call.timeout(timeout);
  }

  Future<List<CronTask>> fetchCronTasks() async {
    final res = await _send('GET', '/api/cron');
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
    final res = await _send(
      'POST',
      '/api/cron',
      body: jsonEncode({
        'name': name,
        'dirId': dirId,
        'prompt': prompt,
        'cron': cron,
        'cli': cli,
        'enabled': enabled,
        'createdBy': 'app',
      }),
    );
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
    final res = await _send(
      'PATCH',
      '/api/cron/${Uri.encodeComponent(id)}',
      body: jsonEncode(body),
    );
    if (res.statusCode >= 400) _throw(res);
    return CronTask.fromJson(
      (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>(),
    );
  }

  Future<void> deleteCronTask(String id) async {
    final res = await _send('DELETE', '/api/cron/${Uri.encodeComponent(id)}');
    if (res.statusCode >= 400) _throw(res);
  }

  /// Fire a task immediately. Returns the created/reused session id when known.
  Future<Map<String, dynamic>> runCronTask(String id) async {
    final res = await _send(
      'POST',
      '/api/cron/${Uri.encodeComponent(id)}/run',
      timeout: const Duration(seconds: 15),
    );
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
    final uri = Uri.parse(_url('/api/providers$q'));
    final client = httpClient;
    final res =
        await (client == null
                ? http.get(uri, headers: _headers)
                : client.get(uri, headers: _headers))
            .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  /// Provider catalog filtered by the server's CLI compatibility matrix.
  /// This is the endpoint shape used by Web. It matters for OpenCode and ZCode,
  /// which can consume compatible providers from both managed pools.
  Future<Map<String, dynamic>> fetchProvidersForCli(String cli) async {
    final q = '?cli=${Uri.encodeQueryComponent(cli)}';
    final uri = Uri.parse(_url('/api/providers$q'));
    final client = httpClient;
    final res =
        await (client == null
                ? http.get(uri, headers: _headers)
                : client.get(uri, headers: _headers))
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

  /// [force] detaches every reference first (server-side, same rules as the
  /// AI-config dialog). Returns the server body: `{ok}` or, when forced,
  /// `{ok, forced: true, detached: [...]}`.
  Future<Map<String, dynamic>> deleteProvider(
    String appType,
    String id, {
    bool force = false,
  }) async {
    final res = await http
        .delete(
          Uri.parse(
            _url('/api/providers/$appType/$id${force ? '?force=1' : ''}'),
          ),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 30));
    if (res.statusCode == 409) {
      try {
        final j = jsonDecode(res.body);
        if (j is Map && j['references'] is List) {
          throw ProviderInUseException(
            (j['code'] ?? 'PROVIDER_IN_USE').toString(),
            (j['references'] as List)
                .whereType<Map>()
                .map((e) => Map<String, dynamic>.from(e))
                .toList(),
            j['forceable'] == true,
          );
        }
      } on FormatException catch (_) {}
    }
    if (res.statusCode >= 400) _throw(res);
    try {
      final j = jsonDecode(res.body);
      if (j is Map) return Map<String, dynamic>.from(j);
    } catch (_) {}
    return const {};
  }

  /// Batch-move every session whose main route is bound to this provider onto
  /// another one (`POST /api/providers/:appType/:id/reassign-sessions`).
  ///
  /// With no [targetProviderId] (dry run only) it answers the bound sessions
  /// plus the targets at least one of them can use; with a target it previews —
  /// or, when [dryRun] is false, performs — each session's move. The server
  /// moves each session through the same switch the AI-config sheet performs,
  /// so an incompatible model is replaced by the target's default; that reset
  /// is reported per session in the preview.
  Future<Map<String, dynamic>> reassignProviderSessions(
    String appType,
    String id, {
    String? targetProviderId,
    bool dryRun = false,
  }) async {
    final body = <String, dynamic>{'dryRun': dryRun};
    if (targetProviderId != null && targetProviderId.isNotEmpty) {
      body['targetProviderId'] = targetProviderId;
    }
    // `_send` keeps the injectable [httpClient] in play (widget tests stub the
    // wire) and widens the deadline: a fleet-wide move walks up to 200
    // sessions server-side, which a 10s default would cut off mid-way.
    final res = await _send(
      'POST',
      '/api/providers/$appType/$id/reassign-sessions',
      body: jsonEncode(body),
      timeout: const Duration(seconds: 60),
    );
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  // ── Aux (AI assistant) ─────────────────────────────────────────────────────  // Mirrors the /api/aux/* + /api/reclassify-* endpoints the web dashboard
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
    // 走 [_send]，这样可注入的 [httpClient] 才在链路上 —— 控制台的首启配置卡就是
    // 拿这一份判断「亮不亮」，widget 测试靠它把 wire stub 掉；绕过去的话那次请求
    // 会真的打到 settings.host 上去。
    final res = await _send('GET', '/api/aux/config');
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

  // ── Server-side config: token usage / access-token ──────────────────────────
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

  Future<Map<String, dynamic>> barkDeviceAction(Map<String, dynamic> action) async {
    final res = await _send('POST', '/api/push/bark-devices',
        body: jsonEncode(action), timeout: const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>();
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

  // ── Turn outcome ───────────────────────────────────────────────────────────

  /// Back-compatible endpoint: manually mark a waiting turn as succeeded.
  /// Returns {ok, classifyState, turnOutcome}.
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

  // ── Docs & web-services registry (服务与文档) ───────────────────────────────
  // Mirrors /api/docs-registry (src/docs-registry.js) — the /manage panel's
  // registry of agent-published pages/files and user-registered local web
  // services. Unlike the older sections above, these methods route through
  // the injectable [httpClient] so tests can stub the wire.

  /// One request through the injected client (tests) or a package-default
  /// one-shot client that is closed after the call (matching the top-level
  /// http.* calls used by the rest of this file).
  Future<http.Response> _req(String verb, Uri uri, {String? body}) async {
    final injected = httpClient;
    final client = injected ?? http.Client();
    try {
      final res = await switch (verb) {
        'GET' => client.get(uri, headers: _headers),
        'POST' => client.post(uri, headers: _headers, body: body ?? '{}'),
        'PATCH' => client.patch(uri, headers: _headers, body: body ?? '{}'),
        'DELETE' => client.delete(uri, headers: _headers),
        _ => throw StateError('unsupported verb $verb'),
      }.timeout(const Duration(seconds: 15));
      return res;
    } finally {
      if (injected == null) client.close();
    }
  }

  /// List entries: permanent first, then pinned, then newest-first (all
  /// server-side). [dir] scopes the list to one absolute working directory —
  /// the 目录首页 artifact panel asks only for its own directory, and the
  /// server normalizes the value the same way it normalizes a stored `dir`
  /// (task-worktree paths fold into their project). Omitted when blank.
  Future<List<DocsRegistryEntry>> fetchDocsRegistry({String? dir}) async {
    final scope = (dir ?? '').trim();
    final res = await _req(
      'GET',
      Uri.parse(
        _url('/api/docs-registry'),
      ).replace(queryParameters: scope.isEmpty ? null : {'dir': scope}),
    );
    if (res.statusCode >= 400) _throw(res);
    final list = jsonDecode(utf8.decode(res.bodyBytes));
    if (list is! List) return const [];
    return list
        .whereType<Map>()
        .map((m) => DocsRegistryEntry.fromJson(m.cast<String, dynamic>()))
        .toList();
  }

  /// Register (or upsert by URL) a manually-added service row.
  Future<DocsRegistryEntry> registerDocsService({
    required String title,
    required String url,
    String startCmd = '',
    String cwd = '',
  }) async {
    final res = await _req(
      'POST',
      Uri.parse(_url('/api/docs-registry')),
      body: jsonEncode({
        'kind': 'service',
        'title': title,
        'url': url,
        'source': 'user',
        if (startCmd.trim().isNotEmpty) 'startCmd': startCmd.trim(),
        if (cwd.trim().isNotEmpty) 'cwd': cwd.trim(),
      }),
    );
    if (res.statusCode >= 400) _throw(res);
    return DocsRegistryEntry.fromJson(
      (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>(),
    );
  }

  /// PATCH a row (pin / permanent toggles and other editable fields). Every
  /// argument is optional and only the ones actually passed are sent — the
  /// server preserves the rest, so 置顶 and 永久保留 can be toggled
  /// independently without clobbering each other.
  Future<DocsRegistryEntry> updateDocsEntry(
    String id, {
    bool? pinned,
    bool? permanent,
    String? title,
    String? note,
    int? port,
    String? startCmd,
    String? cwd,
  }) async {
    final body = <String, dynamic>{};
    if (pinned != null) body['pinned'] = pinned;
    if (permanent != null) body['permanent'] = permanent;
    if (title != null) body['title'] = title;
    if (note != null) body['note'] = note;
    if (port != null) body['port'] = port;
    if (startCmd != null) body['startCmd'] = startCmd;
    if (cwd != null) body['cwd'] = cwd;
    final res = await _req(
      'PATCH',
      Uri.parse(_url('/api/docs-registry/${Uri.encodeComponent(id)}')),
      body: jsonEncode(body),
    );
    if (res.statusCode >= 400) _throw(res);
    return DocsRegistryEntry.fromJson(
      (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>(),
    );
  }

  /// Remove a registration (published content itself is untouched).
  Future<void> deleteDocsEntry(String id) async {
    final res = await _req(
      'DELETE',
      Uri.parse(_url('/api/docs-registry/${Uri.encodeComponent(id)}')),
    );
    if (res.statusCode >= 400) _throw(res);
  }

  /// POST .../start — spawn startCmd detached. Server refuses with 409 when
  /// already running and 400 when no startCmd is registered; both surface via
  /// [_throw] with the server's own message.
  Future<DocsRegistryEntry> startDocsService(String id) async {
    final res = await _req(
      'POST',
      Uri.parse(_url('/api/docs-registry/${Uri.encodeComponent(id)}/start')),
    );
    if (res.statusCode >= 400) _throw(res);
    return DocsRegistryEntry.fromJson(
      (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>(),
    );
  }

  /// POST .../stop — SIGTERM the supervised pid. 409 when no pid is known.
  Future<DocsRegistryEntry> stopDocsService(String id) async {
    final res = await _req(
      'POST',
      Uri.parse(_url('/api/docs-registry/${Uri.encodeComponent(id)}/stop')),
    );
    if (res.statusCode >= 400) _throw(res);
    return DocsRegistryEntry.fromJson(
      (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>(),
    );
  }

  /// GET .../log — the service's startup log tail as text/plain.
  Future<String> fetchDocsServiceLog(String id) async {
    final res = await _req(
      'GET',
      Uri.parse(_url('/api/docs-registry/${Uri.encodeComponent(id)}/log')),
    );
    if (res.statusCode >= 400) _throw(res);
    return utf8.decode(res.bodyBytes);
  }

  // ── Difficulty routing（Jev 难度路由）──────────────────────────────────
  // The App editor's「测试」action, same route the web editor's routingKey.test()
  // calls (src/routes/auto-provider-routing-test.js). The vault entry is read
  // in-process on the server, so the key itself never travels to the phone —
  // only the verdict comes back. An older server has no such route: 404 is
  // reported as `test_unavailable` rather than thrown, so the panel can say
  // "restart multicc" instead of showing an HTTP error.
  Future<Map<String, dynamic>> testAutoProviderRouting({
    required String apiKeyName,
    required String text,
  }) async {
    final res = await _req(
      'POST',
      Uri.parse(_url('/api/auto-provider/routing/test')),
      body: jsonEncode({'apiKeyName': apiKeyName, 'text': text}),
    );
    if (res.statusCode == 404) {
      return const {'ok': false, 'code': 'test_unavailable'};
    }
    // Every failure shape this route produces carries a JSON verdict (400 for a
    // bad entry name, 200 for a Jev verdict, 500 for an internal failure), so a
    // body that will not decode is reported as such instead of thrown.
    Map<dynamic, dynamic>? decoded;
    try {
      final body = jsonDecode(utf8.decode(res.bodyBytes));
      if (body is Map) decoded = body;
    } catch (_) {
      decoded = null;
    }
    if (decoded == null) {
      if (res.statusCode >= 400) _throw(res);
      return const {'ok': false, 'code': 'invalid_response'};
    }
    return decoded.cast<String, dynamic>();
  }

  // ── Secrets vault（敏感信息保险箱）─────────────────────────────────────
  // Mobile mirror of the /manage「敏感信息」panel. The list endpoint returns
  // metadata only (name/description/source/updatedAt); the value is fetched
  // one entry at a time via /api/secrets/:name/value when the user taps
  // 「显示」, matching the web panel's reveal-on-tap contract.

  /// List vault entries (metadata only — values never ride along).
  Future<List<Map<String, dynamic>>> fetchSecrets() async {
    final res = await _req('GET', Uri.parse(_url('/api/secrets')));
    if (res.statusCode >= 400) _throw(res);
    final decoded = jsonDecode(utf8.decode(res.bodyBytes));
    if (decoded is! List) return const [];
    return [
      for (final item in decoded)
        if (item is Map) item.cast<String, dynamic>(),
    ];
  }

  /// Create or update an entry. 201 on create, 200 on update.
  Future<void> saveSecret(
    String name,
    String value, {
    String? description,
  }) async {
    final res = await _req(
      'POST',
      Uri.parse(_url('/api/secrets')),
      body: jsonEncode({
        'name': name,
        'value': value,
        if (description != null && description.trim().isNotEmpty)
          'description': description.trim(),
      }),
    );
    if (res.statusCode >= 400) _throw(res);
  }

  /// Delete an entry (404 when missing → surfaced via [_throw]).
  Future<void> deleteSecret(String name) async {
    final res = await _req(
      'DELETE',
      Uri.parse(_url('/api/secrets/${Uri.encodeComponent(name)}')),
    );
    if (res.statusCode >= 400) _throw(res);
  }

  /// Reveal one entry's value — only ever called from the row's 显示 action.
  Future<String> revealSecret(String name) async {
    final res = await _req(
      'GET',
      Uri.parse(_url('/api/secrets/${Uri.encodeComponent(name)}/value')),
    );
    if (res.statusCode >= 400) _throw(res);
    final decoded = jsonDecode(utf8.decode(res.bodyBytes)) as Map;
    return (decoded['value'] ?? '') as String;
  }
}
