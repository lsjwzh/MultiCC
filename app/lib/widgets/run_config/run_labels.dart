// 线路/模型名字的折算 —— 原 model_chip.dart 里的两个纯函数，搬到运行配置这边，
// 因为 chip 与面板两处都要用同一套说法（文件名曾写作 run_config_labels.dart）。
library;

import '../../services/opencode_models_service.dart';
import '../../utils/cli_display.dart';

/// 没有显式线路时的说法（[providerDisplayLabel] 的回落值）。chip 上要摆中文，
/// 所以那里把它换成「官方」，其余调用方仍拿这个半中半英的完整串。
const String officialProviderLabel = '官方 Provider';

/// 会话记录里存的是 Provider id，屏幕上要的是名字。catalog 里有就用 catalog 的
/// （改名立刻跟着变），没有就用服务端随会话下发的解析名（`GET /api/sessions/:id`
/// 的 `providerName`），最后才退回缩写的 id —— 一串 UUID 对用户没有任何意义，
/// Web 的线路胶囊同样只认名字（src/workspace/air-routes.js 的 providerName）。
String providerDisplayLabel(
  String? id, {
  required List<Map<String, dynamic>> providers,
  String? resolved,
  String? model,
}) {
  if (id == null || id.isEmpty) {
    // OpenCode native config (provider-less sessions): the session saves
    // provider='' with a native `opencodego/<model>` id. The provider name must
    // come from that model, not from the first official MultiCC provider in the
    // catalog — otherwise the chip would claim "Claude 官方" for an OpenCode Go
    // session.
    if (model != null && model.isNotEmpty) {
      final slash = model.indexOf('/');
      if (slash > 0) {
        final nativeId = openCodeNativeProviderId(model.substring(0, slash));
        for (final provider in providers) {
          if (provider['id'] == nativeId) {
            return provider['name']?.toString() ?? nativeId;
          }
        }
        // The catalog row may be missing (models cache empty at chip load);
        // the model prefix alone still names the native provider.
        return openCodeNativeProviderDisplayName(model.substring(0, slash));
      }
    }
    for (final provider in providers) {
      final providerId = provider['id']?.toString() ?? '';
      if (provider['builtinOfficial'] == true ||
          isOfficialProviderId(providerId)) {
        return provider['name']?.toString() ?? officialProviderLabel;
      }
    }
    return officialProviderLabel;
  }
  for (final provider in providers) {
    if (provider['id'] == id) return (provider['name'] as String?) ?? id;
  }
  if (resolved != null && resolved.isNotEmpty && resolved != id) {
    return resolved;
  }
  return id.length > 8 ? id.substring(0, 8) : id;
}

/// chip 上的线路段：官方线路就写「官方」，不摆半中半英的「官方 Provider」。
/// 其余情况就是 [providerDisplayLabel] 的说法。
String runProviderChipLabel(
  String? id, {
  required List<Map<String, dynamic>> providers,
  String? resolved,
  String? model,
}) {
  final label = providerDisplayLabel(
    id,
    providers: providers,
    resolved: resolved,
    model: model,
  );
  return label == officialProviderLabel ? '官方' : label;
}

/// 对用户只展示 CLI 产品名；保留旧车道 id 以读取已有会话。
String cliChoiceLabel(String? id) => cliDisplayName(id);

/// Auto 池子在 chip 上的说法：`Auto · <协议> → <本轮真正跑的那条>`。
String autoProviderRouteLabel(String protocol, String? actualProviderName) {
  final protocolLabel = switch (protocol) {
    'anthropic' => 'Anthropic',
    'openai_responses' => 'Responses',
    'openai_chat' => 'OpenAI Chat',
    _ => protocol,
  };
  final actual = actualProviderName == null || actualProviderName.isEmpty
      ? '待路由'
      : actualProviderName;
  return 'Auto · $protocolLabel → $actual';
}

/// 官方线路是「每个已登录账号一条」：`<pool>-official-<16 位账号 id>`；一个账号
/// 都没登录时只剩 `<pool>-official` 这一条「选此登录」占位。
bool isOfficialProviderId(String id, [String? poolKey]) {
  final match = RegExp(
    r'^(claude|codex)-official(-[a-f0-9]{16})?$',
  ).firstMatch(id);
  return match != null && (poolKey == null || match.group(1) == poolKey);
}

/// 该车道的默认官方线路：服务端标了 isDefaultOfficial 的那条，否则第一条官方。
String? defaultOfficialProviderId(
  String poolKey,
  List<Map<String, dynamic>> providers,
) {
  String? first;
  for (final p in providers) {
    final id = p['id']?.toString() ?? '';
    if (p['builtinOfficial'] != true || !isOfficialProviderId(id, poolKey)) {
      continue;
    }
    if (p['isDefaultOfficial'] == true) return id;
    first ??= id;
  }
  return first;
}
