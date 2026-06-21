import 'dart:convert';
import 'package:http/http.dart' as http;

import '../models/agent_preset.dart';
import 'settings_service.dart';

/// Read-only access to the server's role-prompt preset catalogue.
///
/// The index (`/api/agent-presets`) is cached in memory after the first fetch;
/// pass `forceRefresh: true` to bypass the cache. Individual prompt bodies
/// (`/api/agent-presets/:id`) are fetched on demand.
class AgentPresetService {
  final SettingsService settings;

  AgentPresetService({required this.settings});

  // Process-lifetime cache shared across instances.
  static AgentPresetIndex? _cachedIndex;

  Map<String, String> get _headers {
    final h = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) {
      h['X-Access-Token'] = settings.token;
    }
    return h;
  }

  String _url(String path) => settings.buildHttpUrl(path);

  /// Fetch the preset index. Returns the in-memory cached copy when available
  /// unless [forceRefresh] is set.
  Future<AgentPresetIndex> fetchIndex({bool forceRefresh = false}) async {
    if (!forceRefresh && _cachedIndex != null) return _cachedIndex!;
    final res = await http
        .get(Uri.parse(_url('/api/agent-presets')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      throw Exception(_tryParseError(res.body) ?? '${res.statusCode}');
    }
    final data = jsonDecode(res.body);
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    final index = AgentPresetIndex.fromJson(map);
    _cachedIndex = index;
    return index;
  }

  /// Fetch the full prompt body for a single preset id.
  Future<String> fetchPrompt(String id) async {
    final res = await http
        .get(Uri.parse(_url('/api/agent-presets/$id')), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode >= 400) {
      throw Exception(_tryParseError(res.body) ?? '${res.statusCode}');
    }
    final data = jsonDecode(res.body);
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    return (map['prompt'] ?? '').toString();
  }

  /// Drop the cached index (e.g. on logout / base-url change).
  static void clearCache() {
    _cachedIndex = null;
  }

  String? _tryParseError(String body) {
    try {
      final j = jsonDecode(body);
      if (j is Map && j['error'] != null) return j['error'].toString();
    } catch (_) {}
    return null;
  }
}
