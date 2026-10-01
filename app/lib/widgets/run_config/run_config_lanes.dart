// 「运行配置」面板用的车道/协议事实表。车道 → 它能跑的协议，镜像服务端
// src/providers/auto-provider-config.js 的 AUTO_CLIS 与 appTypesForCli：
// claude 池说 anthropic，codex 池说 openai_responses，opencode / zcode 两个池都
// 能跑，kimi 只认 responses。这份表只决定「哪条线路能挂到哪条车道上」，真正的池
// 兼容性仍由服务端的 GET /api/providers?cli= 说话。
library;

import '../../models/message.dart';
import '../../services/opencode_models_service.dart';

/// 车道 → 它服务的协议，顺序无所谓。供行的 CLI 菜单判断兼容。
const Map<String, List<String>> kLaneProtocols = <String, List<String>>{
  'claude': ['anthropic'],
  'claude-exp': ['anthropic'],
  'codex': ['openai_responses'],
  'codex-exp': ['openai_responses'],
  'opencode': ['anthropic', 'openai_responses'],
  'zcode': ['anthropic', 'openai_responses'],
  'kimi': ['openai_responses'],
};

/// 自动池新建线路可选的车道；旧车道仍由协议表支持，但不再作为新选项。
/// `kimi` 在展示表里但没有 [SessionCli] 枚举值，所以这里用的是车道 id 字符串。
const List<String> kAutoLanes = <String>[
  'claude-exp',
  'codex-exp',
  'opencode',
  'zcode',
  'kimi',
];

/// 需要自带 baseUrl + token 才跑得动的车道（服务端 core.js 的校验）。
const Set<String> kLaneNeedsEndpoint = <String>{'zcode', 'kimi'};

/// 线路记录里说的协议（'anthropic' / 'openai_responses'），拿不到返回 null。
/// 'openai_chat' 是退役写法，服务端仍当 responses 认。
String? providerProtocolOf(Map<String, dynamic> provider) {
  final raw = (provider['protocol'] ?? provider['apiFormat'])?.toString();
  final value = raw == 'openai_chat' ? 'openai_responses' : raw;
  return const {'anthropic', 'openai_responses'}.contains(value) ? value : null;
}

/// 这条车道能不能跑这条协议。协议未知时只有 opencode 认（它是协议无关的）。
bool laneServesProtocol(String lane, String? protocol) {
  if (protocol == null) return lane == 'opencode';
  return (kLaneProtocols[lane] ?? const []).contains(protocol);
}

/// 这条线路能挂到的车道，按 [kAutoLanes] 的顺序。OpenCode 原生线路只有 opencode
/// 能跑；其余按协议过滤。
List<String> lanesForLine(Map<String, dynamic> provider) {
  if (isOpenCodeNativeProvider(provider['id']?.toString() ?? '')) {
    return const ['opencode'];
  }
  final protocol = providerProtocolOf(provider);
  return [
    for (final lane in kAutoLanes)
      if (laneServesProtocol(lane, protocol)) lane,
  ];
}
