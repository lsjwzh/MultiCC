import 'dart:convert';
import 'package:http/http.dart' as http;

import '../models/message.dart';
import 'settings_service.dart';

/// Thin REST client for the server-side management endpoints that the web
/// dashboard (manage.html) exposes but the app previously lacked: scheduled
/// tasks (cron), agent resources (skills / Claude history) and the temp-upload
/// cache. All non-sensitive — sensitive server config (voice keys, push
/// channels, tunnel, power) stays on the web dashboard by design.
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
        (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>());
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
        .patch(Uri.parse(_url('/api/cron/$id')),
            headers: _headers, body: jsonEncode(body))
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) _throw(res);
    return CronTask.fromJson(
        (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>());
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
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>();
  }

  // ── Agent resources (skills) ───────────────────────────────────────────────

  /// Returns `{skills: [...], counts: {claude, codex}}`.
  Future<Map<String, dynamic>> fetchSkills() async {
    final res = await http
        .get(Uri.parse(_url('/api/agent-resources/skills')), headers: _headers)
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>();
  }

  // ── Agent resources (Claude history) ───────────────────────────────────────

  /// Returns `{sessions: [...], count, totalSize, protectedCount}`.
  Future<Map<String, dynamic>> fetchClaudeHistory() async {
    final res = await http
        .get(Uri.parse(_url('/api/agent-resources/claude-sessions')),
            headers: _headers)
        .timeout(const Duration(seconds: 20));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>();
  }

  /// Bulk-delete history sessions older than [olderThanDays] (linked sessions
  /// are protected server-side). Returns `{ok, deleted, freed}`.
  Future<Map<String, dynamic>> cleanupClaudeHistory(int olderThanDays) async {
    final res = await http
        .delete(
          Uri.parse(_url(
              '/api/agent-resources/claude-sessions?olderThanDays=$olderThanDays')),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 30));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>();
  }

  // ── Providers (cc-switch import + multicc-owned store) ─────────────────────

  /// Returns `{available, ccSwitchAvailable, providers: [...], defaults: {...}}`.
  Future<Map<String, dynamic>> fetchProviders([String? appType]) async {
    final q = (appType == 'claude' || appType == 'codex') ? '?appType=$appType' : '';
    final res = await http
        .get(Uri.parse(_url('/api/providers$q')), headers: _headers)
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>();
  }

  /// Import / sync from cc-switch. Returns `{ok, imported, updated, total}`.
  Future<Map<String, dynamic>> importProviders() async {
    final res = await http
        .post(Uri.parse(_url('/api/providers/import')), headers: _headers)
        .timeout(const Duration(seconds: 20));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>();
  }

  Future<void> createProvider({
    required String appType,
    required String name,
    String baseUrl = '',
    String authToken = '',
    String model = '',
  }) async {
    final res = await http
        .post(Uri.parse(_url('/api/providers')),
            headers: _headers,
            body: jsonEncode({
              'appType': appType,
              'name': name,
              'baseUrl': baseUrl,
              'authToken': authToken,
              'model': model,
            }))
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
  }) async {
    final body = <String, dynamic>{};
    if (name != null) body['name'] = name;
    if (baseUrl != null) body['baseUrl'] = baseUrl;
    if (authToken != null && authToken.isNotEmpty) body['authToken'] = authToken;
    if (model != null) body['model'] = model;
    final res = await http
        .patch(Uri.parse(_url('/api/providers/$appType/$id')),
            headers: _headers, body: jsonEncode(body))
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
  }

  Future<void> deleteProvider(String appType, String id) async {
    final res = await http
        .delete(Uri.parse(_url('/api/providers/$appType/$id')), headers: _headers)
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) _throw(res);
  }

  Future<void> setProviderDefaults({String? claude, String? codex}) async {
    final body = <String, dynamic>{};
    if (claude != null) body['claude'] = claude;
    if (codex != null) body['codex'] = codex;
    final res = await http
        .put(Uri.parse(_url('/api/provider-defaults')),
            headers: _headers, body: jsonEncode(body))
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
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>();
  }

  /// Delete all cached temp uploads. Returns `{ok, deleted, freed}`.
  Future<Map<String, dynamic>> cleanupUploads() async {
    final res = await http
        .delete(Uri.parse(_url('/api/uploads/cleanup')), headers: _headers)
        .timeout(const Duration(seconds: 30));
    if (res.statusCode >= 400) _throw(res);
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>();
  }
}
