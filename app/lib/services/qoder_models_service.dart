import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/message.dart';
import 'settings_service.dart';

/// Live Qoder CN model catalog.
///
/// Qoder's catalog is entitlement-scoped and renames models in place — the GA
/// rename of "3.8 Preview" retired the id every session had pinned, and every
/// qoder session started failing with `Model ... is not available`. So the
/// picker must read the account's real list instead of a hardcoded table.
///
/// GET /api/qoder/models runs `qoderclicn --list-models` on the host (cached
/// there for a day). This mirrors the result in-process so repeated sheet opens
/// do not re-fetch, and exposes a synchronous [options] for the option builders
/// that run inside build().
class QoderModelsService {
  static const Duration _ttl = Duration(hours: 24);
  static const Duration _timeout = Duration(seconds: 20);

  static List<MapEntry<String, String>>? _cache;
  static DateTime? _cachedAt;
  static Future<List<MapEntry<String, String>>>? _inflight;

  final SettingsService settings;
  QoderModelsService({required this.settings});

  /// Cached catalog, or `[]` when nothing fresh has been fetched yet.
  static List<MapEntry<String, String>> get cached {
    final at = _cachedAt;
    final list = _cache;
    if (list == null || at == null) return const [];
    if (DateTime.now().difference(at) >= _ttl) return const [];
    return list;
  }

  /// Dropdown options for a qoder session: the live catalog behind the
  /// "follow Qoder CN settings" default, falling back to the built-in routing
  /// tiers while the catalog is unknown (offline / not signed in / first open).
  static List<MapEntry<String, String>> options() {
    final live = cached;
    if (live.isEmpty) return kQoderModelOptions;
    return [kQoderModelOptions.first, ...live];
  }

  /// Fetch (or reuse) the catalog. Never throws — a failure leaves the tiers in
  /// place. Returns `[]` when the catalog could not be read.
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
            Uri.parse(settings.buildHttpUrl('/api/qoder/models')),
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
      // `source: fallback` means the host could not reach the CLI and returned
      // the routing tiers. Do not cache that: it would mask the real catalog
      // for a whole day once the CLI recovers.
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
