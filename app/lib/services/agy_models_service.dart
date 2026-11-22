import 'live_model_catalog.dart';
import 'settings_service.dart';

/// Antigravity's logical model ids, discovered from its signed-in ACP session
/// (GET /api/agy/models). There is no static table: the ids depend on the
/// account tier, so an empty catalog means the CLI is not usable yet.
class AgyModelsService {
  AgyModelsService({required this.settings});
  final SettingsService settings;

  static final LiveModelCatalog catalog = LiveModelCatalog(
    path: '/api/agy/models',
  );

  static List<LiveModel> get cached => catalog.cached;

  static List<MapEntry<String, String>> options() => [
    const MapEntry('', '默认（跟随 Antigravity 配置）'),
    for (final m in cached) MapEntry(m.id, m.label),
  ];

  /// Shown when the picker has nothing but the pinned default.
  static const emptyHint = '未读到反重力模型，请确认已登录 agy 并检查网络';

  Future<List<LiveModel>> load() => catalog.load(settings);
}
