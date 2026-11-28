import 'package:http/http.dart' as http;

import '../models/message.dart';
import 'live_model_catalog.dart';
import 'settings_service.dart';

/// Antigravity's logical model ids, discovered from its signed-in ACP session
/// (GET /api/agy/models). There is no static table: the ids depend on the
/// account tier, so an empty catalog means the CLI is not usable yet.
class AgyModelsService {
  AgyModelsService({required this.settings, this.httpClient});
  final SettingsService settings;
  final http.Client? httpClient;

  static final _catalogs = <String, LiveModelCatalog>{};
  static LiveModelCatalog forAccount(String? accountId) => _catalogs.putIfAbsent(
    accountId ?? '',
    () => LiveModelCatalog(
      path: Uri(path: '/api/agy/models', queryParameters:
          accountId == null || accountId.isEmpty ? null : {'accountId': accountId}).toString(),
      ttl: const Duration(minutes: 10),
      cacheSources: const {'cli', 'ssh', 'relay'},
      onCatalog: (body) => readAgyEfforts((body['efforts'] as Map?)?['agy'], accountId: accountId),
    ),
  );
  static LiveModelCatalog get catalog => forAccount(null);

  static List<LiveModel> get cached => catalog.cached;

  /// 不传 `--model` 时 agy 实际会跑的那一档（如 `gemini-4-neon-high`）。
  /// 可选项全是族名（`gemini-4-neon`），所以「默认」到底是哪个只能靠目录回报。
  static LiveModel? get current => catalog.current;

  /// 「默认」行的人话：目录已回报当前档位就写出来，否则只写跟随配置。
  static String get defaultLabel => defaultLabelFor(null);
  static String defaultLabelFor(String? accountId) {
    final now = forAccount(accountId).current;
    return now == null ? '默认（跟随 Antigravity 配置）' : '默认 · ${now.label}';
  }

  static List<MapEntry<String, String>> options([String? accountId]) => [
    MapEntry('', defaultLabelFor(accountId)),
    for (final m in forAccount(accountId).cached) MapEntry(m.id, m.label),
  ];

  /// Shown when the picker has nothing but the pinned default.
  static const emptyHint = '未读到反重力模型，请确认已登录 agy 并检查网络';

  Future<List<LiveModel>> load({String? accountId}) =>
      forAccount(accountId).load(settings, httpClient: httpClient);
}
