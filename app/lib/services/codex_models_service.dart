import 'dart:convert';

import 'package:http/http.dart' as http;

import 'settings_service.dart';

class CodexModelCatalog {
  final List<MapEntry<String, String>> models;
  final String source;
  final String diagnosticCode;
  final String diagnosticMessage;
  final String cliVersion;
  final bool stale;

  const CodexModelCatalog({
    required this.models,
    required this.source,
    required this.diagnosticCode,
    required this.diagnosticMessage,
    required this.cliVersion,
    required this.stale,
  });

  static const unavailable = CodexModelCatalog(
    models: [],
    source: 'fallback',
    diagnosticCode: 'unavailable',
    diagnosticMessage: '',
    cliVersion: '',
    stale: false,
  );
}

/// Account-scoped Codex model catalog shared by the App's create/edit pickers.
///
/// The server calls Codex app-server `model/list`, so each row keeps the
/// display name separate from the wire model id and already reflects rollout
/// and workspace policy for the signed-in account. No model ids are hardcoded
/// here. A short memory cache avoids persisting revoked entitlements on-device.
class CodexModelsService {
  static const Duration _ttl = Duration(minutes: 1);
  static const Duration _timeout = Duration(seconds: 20);

  static CodexModelCatalog? _cache;
  static DateTime? _cachedAt;
  static Future<CodexModelCatalog>? _inflight;

  final SettingsService settings;
  CodexModelsService({required this.settings});

  static CodexModelCatalog get cached {
    final value = _cache;
    final at = _cachedAt;
    if (value == null || at == null) return CodexModelCatalog.unavailable;
    if (DateTime.now().difference(at) >= _ttl) {
      return CodexModelCatalog.unavailable;
    }
    return value;
  }

  static List<MapEntry<String, String>> options() => [
    const MapEntry('', '默认（跟随 Codex 设置）'),
    ...cached.models,
  ];

  static String labelFor(String model) {
    if (model.isEmpty) return '默认（跟随 Codex 设置）';
    for (final entry in cached.models) {
      if (entry.key == model) return entry.value;
    }
    return model;
  }

  static CodexModelCatalog parseCatalog(dynamic body) {
    if (body is! Map) return CodexModelCatalog.unavailable;
    final models = <MapEntry<String, String>>[];
    final seen = <String>{};
    final rawModels = body['models'];
    if (rawModels is List) {
      for (final entry in rawModels) {
        if (entry is! Map) continue;
        final model = entry['model']?.toString().trim() ?? '';
        if (model.isEmpty || model.length > 160 || !seen.add(model)) continue;
        final rawLabel = entry['label']?.toString().trim() ?? '';
        models.add(MapEntry(model, rawLabel.isEmpty ? model : rawLabel));
      }
    }
    final diag = body['diagnostic'];
    return CodexModelCatalog(
      models: List.unmodifiable(models),
      source: body['source']?.toString() ?? 'fallback',
      diagnosticCode: diag is Map ? (diag['code']?.toString() ?? '') : '',
      diagnosticMessage: diag is Map ? (diag['message']?.toString() ?? '') : '',
      cliVersion: body['cliVersion']?.toString() ?? '',
      stale: body['stale'] == true,
    );
  }

  Future<CodexModelCatalog> load({bool forceRefresh = false}) {
    final warm = cached;
    if (!forceRefresh && warm != CodexModelCatalog.unavailable) {
      return Future.value(warm);
    }
    return _inflight ??= _fetch(forceRefresh: forceRefresh).whenComplete(() {
      _inflight = null;
    });
  }

  Future<CodexModelCatalog> _fetch({required bool forceRefresh}) async {
    try {
      final headers = <String, String>{};
      if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
      final suffix = forceRefresh ? '?refresh=1' : '';
      final res = await http
          .get(
            Uri.parse(settings.buildHttpUrl('/api/codex/models$suffix')),
            headers: headers,
          )
          .timeout(_timeout);
      if (res.statusCode != 200) return cached;
      final parsed = parseCatalog(jsonDecode(utf8.decode(res.bodyBytes)));
      // Authoritative empty responses are cached too: they revoke any old
      // entitlement list and leave only the safe Codex-default/custom choices.
      _cache = parsed;
      _cachedAt = DateTime.now();
      return parsed;
    } catch (_) {
      return cached;
    }
  }

  static void resetForTest() {
    _cache = null;
    _cachedAt = null;
    _inflight = null;
  }

  static void setCatalogForTest(CodexModelCatalog value) {
    _cache = value;
    _cachedAt = DateTime.now();
  }
}
