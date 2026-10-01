import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/services/opencode_models_service.dart';
import 'package:multicc_app/widgets/run_config/run_labels.dart';

/// Reproduction: an opencode session using its native OpenCode Go config saves
/// provider='' (empty) with a native `opencodego/<model>` model id. The chat
/// header chip must then name the native provider — not the first official
/// MultiCC provider in the catalog.
void main() {
  const merged = [
    {'id': 'claude-official', 'name': 'Claude 官方', 'builtinOfficial': true},
    {'id': 'codex-official', 'name': 'Codex 官方', 'builtinOfficial': true},
    {
      'id': 'opencode-native:opencodego',
      'name': 'OpenCode Go',
      'appType': 'opencode',
      'nativeOpenCode': true,
      'nativeProvider': 'opencodego',
      'modelOptions': ['opencodego/kimi-k2', 'opencodego/glm-5.2'],
    },
  ];

  test('opencode native session shows the native provider, not Claude 官方', () {
    expect(
      providerDisplayLabel('', providers: merged, model: 'opencodego/kimi-k2'),
      'OpenCode Go',
    );
    // Catalog row missing (models cache empty): the model prefix still names it.
    expect(
      providerDisplayLabel('', providers: const [], model: 'opencodego/kimi-k2'),
      'OpenCode Go',
    );
  });

  test('plain providerless session still falls back to official Provider', () {
    expect(providerDisplayLabel('', providers: merged), 'Claude 官方');
    expect(providerDisplayLabel('', providers: const []), '官方 Provider');
  });

  test('opencode provider-less with empty model never claims Claude 官方', () {
    // _providerLabel special-cases opencode; assert the underlying helper still
    // resolves native names when the catalog row is missing.
    expect(
      providerDisplayLabel('', providers: merged, model: 'opencodego/glm-5.2'),
      'OpenCode Go',
    );
  });

  test('native display name helper mirrors the picker rows', () {
    // 车道本来就是 OpenCode，名字不再重复一遍厂商。
    expect(openCodeNativeProviderDisplayName('opencodego'), 'OpenCode Go');
    expect(openCodeNativeProviderDisplayName('opencode'), 'OpenCode Zen');
  });
}