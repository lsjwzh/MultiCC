import 'dart:convert';

import 'package:http/http.dart' as http;

import 'settings_service.dart';

/// One model from a host CLI's live catalog. [group] is the vendor's own
/// section when the CLI prints one (Command Code: Open Source / Anthropic /
/// OpenAI / ...), `''` otherwise.
class LiveModel {
  const LiveModel(this.id, this.label, {this.group = ''});
  final String id;
  final String label;
  final String group;
}

/// In-process mirror of a server `GET /api/<cli>/models` catalog (server side
/// already caches; this stops repeated sheet opens from re-fetching, and gives
/// the option builders that run inside build() a synchronous [cached]).
///
/// Only `source: cli` responses are kept — `fallback` / `cli-unauthenticated`
/// lists are returned to the caller but never pinned, so the real catalog wins
/// as soon as the CLI recovers or the user signs in.
class LiveModelCatalog {
  LiveModelCatalog({
    required this.path,
    this.ttl = const Duration(hours: 1),
    this.timeout = const Duration(seconds: 30),
  });

  final String path;
  final Duration ttl;
  final Duration timeout;

  List<LiveModel>? _cache;
  DateTime? _cachedAt;
  Future<List<LiveModel>>? _inflight;

  /// The catalog's `current` entry: the model the CLI would run right now with
  /// nothing pinned. Only some catalogs report it (agy does — its pickable ids
  /// are family names, so this is the only way to say what "默认" means).
  LiveModel? _current;

  LiveModel? get current => cached.isEmpty ? null : _current;

  List<LiveModel> get cached {
    final at = _cachedAt;
    final list = _cache;
    if (list == null || at == null) return const [];
    if (DateTime.now().difference(at) >= ttl) return const [];
    return list;
  }

  String groupOf(String id) {
    for (final m in cached) {
      if (m.id == id) return m.group;
    }
    return '';
  }

  /// Never throws; returns `[]` when nothing could be read.
  Future<List<LiveModel>> load(SettingsService settings) {
    final warm = cached;
    if (warm.isNotEmpty) return Future.value(warm);
    return _inflight ??= _fetch(settings).whenComplete(() {
      _inflight = null;
    });
  }

  Future<List<LiveModel>> _fetch(SettingsService settings) async {
    try {
      final headers = <String, String>{};
      if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
      final res = await http
          .get(Uri.parse(settings.buildHttpUrl(path)), headers: headers)
          .timeout(timeout);
      if (res.statusCode != 200) return const [];
      final body = jsonDecode(res.body);
      if (body is! Map || body['models'] is! List) return const [];
      final out = <LiveModel>[];
      for (final entry in body['models'] as List) {
        if (entry is! Map) continue;
        final id = entry['model']?.toString() ?? '';
        if (id.isEmpty) continue;
        final label = entry['label']?.toString() ?? '';
        out.add(
          LiveModel(
            id,
            label.isNotEmpty ? label : id,
            group: entry['group']?.toString() ?? '',
          ),
        );
      }
      if (out.isNotEmpty && body['source']?.toString() == 'cli') {
        _cache = out;
        _cachedAt = DateTime.now();
        _current = _parseCurrent(body['current']);
      }
      return out;
    } catch (_) {
      return const [];
    }
  }

  static LiveModel? _parseCurrent(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['model']?.toString() ?? '';
    if (id.isEmpty) return null;
    final label = raw['label']?.toString() ?? '';
    return LiveModel(id, label.isNotEmpty ? label : id);
  }
}
