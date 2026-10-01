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
          providerId == 'claude-official' ||
          providerId == 'codex-official') {
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

/// 一行文字里对一条车道的叫法。家族名分不开同一家族的两条车道（claude 与
/// claude-exp 都叫 Claude），所以单行位置（下拉项、分组标题、行首 chip）补上引擎
/// 当区分，但引擎里重复家族名的那截去掉 —— `Claude` / `Claude · Agent SDK`、
/// `Codex` / `Codex · App Server`。家族名已经唯一的（OpenCode / Kimi Code）不补。
/// 镜像 Web run-config.js 的 cliChoiceLabel / shortEngine。
String cliChoiceLabel(String? id) {
  final family = cliDisplayName(id);
  final suffix = _shortEngine(family, cliEngine(id), id);
  return suffix.isEmpty ? family : '$family · $suffix';
}

String _shortEngine(String family, String engine, String? id) {
  final value = engine.trim();
  if (value.isEmpty) return '';
  final lower = value.toLowerCase();
  final name = family.trim().toLowerCase();
  if (lower == name || lower == (id ?? '').trim().toLowerCase()) return '';
  if (name.isNotEmpty && lower.startsWith('$name ')) {
    return value.substring(name.length + 1).trim();
  }
  return value;
}

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
