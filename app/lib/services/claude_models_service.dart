import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/message.dart';
import 'settings_service.dart';

/// Live Claude model list.
///
/// Anthropic ships new models with claude CLI upgrades far more often than the
/// App ships a picker table — claude-opus-5 was unselectable for weeks because
/// the static list still ended at 4.8. GET /api/claude/models extracts the
/// servable ids from the CLI bundle installed on the host (cached there for a
/// day). This mirrors the result in-process so repeated sheet opens do not
/// re-fetch, and exposes a synchronous [options] for the option builders that
/// run inside build().
class ClaudeModelsService {
  static const Duration _ttl = Duration(hours: 24);
  static const Duration _timeout = Duration(seconds: 20);

  static List<MapEntry<String, String>>? _cache;
  static DateTime? _cachedAt;
  static Future<List<MapEntry<String, String>>>? _inflight;

  final SettingsService settings;
  ClaudeModelsService({required this.settings});

  /// Cached list, or `[]` when nothing fresh has been fetched yet.
  static List<MapEntry<String, String>> get cached {
    final at = _cachedAt;
    final list = _cache;
    if (list == null || at == null) return const [];
    if (DateTime.now().difference(at) >= _ttl) return const [];
    return list;
  }

  /// Dropdown options for a claude session: the live list behind the
  /// "follow Claude settings" default, falling back to the built-in table
  /// while the list is unknown (offline / old server / first open).
  static List<MapEntry<String, String>> options() {
    final live = cached;
    if (live.isEmpty) return kClaudeModelOptions;
    return [kClaudeModelOptions.first, ...live];
  }

  /// Fetch (or reuse) the list. Never throws — a failure leaves the static
  /// table in place. Returns `[]` when the list could not be read.
  Future<List<MapEntry<String, String>>> load() {
    final warm = cached;
    if (warm.isNotEmpty) return Future.value(warm);
    return _inflight ??= _fetch().whenComplete(() {
      _inflight = null;
    });
  }

  Future<List<MapEntry<String, String>>> _fetch() async {
    try {
      final headers = <String, String>{};
      if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
      final res = await http
          .get(
            Uri.parse(settings.buildHttpUrl('/api/claude/models')),
            headers: headers,
          )
          .timeout(_timeout);
      if (res.statusCode != 200) return const [];
      final body = jsonDecode(res.body);
      if (body is! Map) return const [];
      final list = body['models'];
      if (list is! List) return const [];
      final out = <MapEntry<String, String>>[];
      for (final entry in list) {
        if (entry is! Map) continue;
        final model = entry['model']?.toString() ?? '';
        if (model.isEmpty) continue;
        final label = entry['label']?.toString() ?? '';
        out.add(MapEntry(model, label.isNotEmpty ? label : model));
      }
      // `source: fallback` means the host could not read the CLI bundle and
      // returned the static table. Do not cache that: it would mask the real
      // list for a whole day once the CLI is readable again.
      if (out.isNotEmpty && body['source']?.toString() != 'fallback') {
        _cache = out;
        _cachedAt = DateTime.now();
      }
      return out;
    } catch (_) {
      return const [];
    }
  }
}
