import '../models/message.dart';
import 'live_model_catalog.dart';
import 'settings_service.dart';

/// Command Code is a vendor-native lane: its one line exists only in the Auto
/// Provider pool, and the account/catalog belong to the CLI itself. Mirrors
/// src/providers/native-commandcode.js and the Web `commandcode-native:` id.
const commandCodeNativeProviderPrefix = 'commandcode-native:';
const commandCodeNativeProviderId =
    '${commandCodeNativeProviderPrefix}commandcode';

bool isCommandCodeNativeProvider(String value) =>
    value.startsWith(commandCodeNativeProviderPrefix);

String commandCodeNativeProviderDisplayName() => 'Command Code';

/// Adds the synthetic vendor line used by the Auto Provider pool. These rows
/// are UI-only; saving keeps the synthetic id in providerSelection and leaves
/// the session's concrete provider empty.
List<Map<String, dynamic>> mergeCommandCodeNativeProviders(
  List<Map<String, dynamic>> managed,
  List<LiveModel> models,
) {
  final options = models.isEmpty
      ? [
          for (final entry in kCommandCodeModelOptions)
            if (entry.key.isNotEmpty) entry.key,
        ]
      : [for (final model in models) model.id];
  return [
    ...managed,
    {
      'id': commandCodeNativeProviderId,
      'name': commandCodeNativeProviderDisplayName(),
      'appType': 'commandcode',
      'nativeCommandCode': true,
      'modelOptions': options,
    },
  ];
}

/// Command Code's `--list-models` catalog (GET /api/commandcode/models), grouped
/// by the vendor's own sections. Falls back to [kCommandCodeModelOptions].
class CommandCodeModelsService {
  CommandCodeModelsService({required this.settings});
  final SettingsService settings;

  static final LiveModelCatalog catalog = LiveModelCatalog(
    path: '/api/commandcode/models',
  );

  static List<LiveModel> get cached => catalog.cached;
  static String groupOf(String id) => catalog.groupOf(id);

  /// Default entry pinned first, then the live ids (static table until loaded).
  static List<MapEntry<String, String>> options() {
    final live = cached;
    if (live.isEmpty) return kCommandCodeModelOptions;
    return [
      kCommandCodeModelOptions.first,
      for (final m in live) MapEntry(m.id, m.label),
    ];
  }

  Future<List<LiveModel>> load() => catalog.load(settings);
}

/// Grok Build's `grok models` list (GET /api/grok/models).
class GrokModelsService {
  GrokModelsService({required this.settings});
  final SettingsService settings;

  static final LiveModelCatalog catalog = LiveModelCatalog(
    path: '/api/grok/models',
  );

  static List<LiveModel> get cached => catalog.cached;

  static List<MapEntry<String, String>> options() {
    final live = cached;
    if (live.isEmpty) return kGrokModelOptions;
    return [
      kGrokModelOptions.first,
      for (final m in live) MapEntry(m.id, m.label),
    ];
  }

  Future<List<LiveModel>> load() => catalog.load(settings);
}
