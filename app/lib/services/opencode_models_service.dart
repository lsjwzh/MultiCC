import 'dart:convert';

import 'package:http/http.dart' as http;

import 'settings_service.dart';

const openCodeNativeProviderPrefix = 'opencode-native:';

String openCodeNativeProviderId(String provider) =>
    '$openCodeNativeProviderPrefix$provider';

String openCodeNativeProviderOf(String value) =>
    value.startsWith(openCodeNativeProviderPrefix)
    ? value.substring(openCodeNativeProviderPrefix.length)
    : '';

bool isOpenCodeNativeProvider(String value) =>
    openCodeNativeProviderOf(value).isNotEmpty;

/// Display names for OpenCode's own native providers. Mirrors the Web picker's
/// OPENCODE_NATIVE_NAMES (public/chat-ai-config.js) and the synthetic rows
/// created in [mergeOpenCodeNativeProviders]; a provider the table does not
/// know keeps its raw id so nothing is ever mislabelled as another vendor.
///
/// The lane is already OpenCode, so the name no longer repeats it — the old
/// `OpenCode 原生 · OpenCode Go` said the vendor twice.
String openCodeNativeProviderDisplayName(String provider) {
  const names = {'opencode': 'OpenCode Zen', 'opencodego': 'OpenCode Go'};
  final name = names[provider];
  if (name != null) return name;
  return provider.isEmpty ? 'OpenCode' : 'OpenCode · $provider';
}

class OpenCodeModel {
  const OpenCodeModel({
    required this.provider,
    required this.model,
    required this.label,
  });

  final String provider;
  final String model;
  final String label;

  String get value => '$provider/$model';
}

/// Adds the same synthetic native-provider rows used by the Web picker.
///
/// These rows are UI-only. Their `opencode-native:<id>` values are converted
/// back to an empty MultiCC provider when a session is saved; the selected
/// `<id>/<model>` remains the authoritative OpenCode-native model value.
List<Map<String, dynamic>> mergeOpenCodeNativeProviders(
  List<Map<String, dynamic>> managed,
  List<OpenCodeModel> models,
) {
  final grouped = <String, List<OpenCodeModel>>{};
  for (final model in models) {
    if (model.provider.isEmpty || model.model.isEmpty) continue;
    grouped.putIfAbsent(model.provider, () => []).add(model);
  }
  return [
    ...managed,
    for (final entry in grouped.entries)
      {
        'id': openCodeNativeProviderId(entry.key),
        'name': openCodeNativeProviderDisplayName(entry.key),
        'appType': 'opencode',
        'nativeOpenCode': true,
        'nativeProvider': entry.key,
        'modelOptions': entry.value.map((model) => model.value).toList(),
      },
  ];
}

String openCodeNativeProviderForModel(
  String model,
  List<Map<String, dynamic>> providers,
) {
  final slash = model.indexOf('/');
  if (slash <= 0) return '';
  final candidate = openCodeNativeProviderId(model.substring(0, slash));
  return providers.any((provider) => provider['id'] == candidate)
      ? candidate
      : '';
}

List<String> openCodeNativeModelOptions(List<Map<String, dynamic>> providers) {
  final seen = <String>{};
  return [
    for (final provider in providers)
      if (provider['nativeOpenCode'] == true &&
          provider['modelOptions'] is List)
        for (final value in provider['modelOptions'] as List)
          if (value.toString().isNotEmpty && seen.add(value.toString()))
            value.toString(),
  ];
}

/// Account/config-scoped OpenCode catalog shared by App create/edit pickers.
/// The host endpoint is the same one that warms the Web picker's cache.
class OpenCodeModelsService {
  static const Duration _ttl = Duration(hours: 24);
  static const Duration _timeout = Duration(seconds: 20);

  static List<OpenCodeModel>? _cache;
  static DateTime? _cachedAt;
  static Future<List<OpenCodeModel>>? _inflight;

  final SettingsService settings;
  final http.Client? httpClient;

  OpenCodeModelsService({required this.settings, this.httpClient});

  static List<OpenCodeModel> get cached {
    final models = _cache;
    final at = _cachedAt;
    if (models == null || at == null) return const [];
    if (DateTime.now().difference(at) >= _ttl) return const [];
    return models;
  }

  Future<List<OpenCodeModel>> load() {
    final warm = cached;
    if (warm.isNotEmpty) return Future.value(warm);
    return _inflight ??= _fetch().whenComplete(() => _inflight = null);
  }

  Future<List<OpenCodeModel>> _fetch() async {
    try {
      final headers = <String, String>{};
      if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
      final uri = Uri.parse(settings.buildHttpUrl('/api/opencode/models'));
      final response =
          await (httpClient == null
                  ? http.get(uri, headers: headers)
                  : httpClient!.get(uri, headers: headers))
              .timeout(_timeout);
      if (response.statusCode != 200) return const [];
      final body = jsonDecode(utf8.decode(response.bodyBytes));
      if (body is! Map || body['models'] is! List) return const [];
      final models = <OpenCodeModel>[];
      final seen = <String>{};
      for (final raw in body['models'] as List) {
        if (raw is! Map) continue;
        final provider = raw['provider']?.toString().trim() ?? '';
        final model = raw['model']?.toString().trim() ?? '';
        if (provider.isEmpty ||
            model.isEmpty ||
            !seen.add('$provider/$model')) {
          continue;
        }
        final label = raw['label']?.toString().trim() ?? '';
        models.add(
          OpenCodeModel(
            provider: provider,
            model: model,
            label: label.isEmpty ? '$provider/$model' : label,
          ),
        );
      }
      if (models.isNotEmpty) {
        _cache = models;
        _cachedAt = DateTime.now();
      }
      return models;
    } catch (_) {
      return const [];
    }
  }
}
