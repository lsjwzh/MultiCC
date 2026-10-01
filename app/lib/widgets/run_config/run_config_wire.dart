// 「运行配置」面板的 wire 折算层：把面板上的一份草稿折成服务端认的
// provider / providerSelection / model / effort / subagent / agent 六件套。
//
// 与 Web 的 auto-provider-editor.js 同一份契约：
//   固定一条 → providerSelection: null，provider 就是选的那条线路；
//   自动挑选 · 按顺序 → cliSwitch 'failover'，没有 routing、没有 tier、没有 autoModel；
//   自动挑选 · 按难度 · 交给 Jev → routing.tiering 'price'，候选不带 tier；
//   自动挑选 · 按难度 · 我自己标 → 没有 tiering，tier 是 t1..tK（最弱在前）。
//
// 每一条候选都写 `cli`（服务端一旦看到就按跨车道池校验：同一车道上不许混协议、
// 同一条线路在同一车道上只能出现一次）。`protocol` 由服务端从池子里推，这里不写。
library;

import '../../models/message.dart';
import '../../services/auto_provider_routing.dart';
import '../../services/opencode_models_service.dart';
import 'run_config_lanes.dart';

/// 面板顶部的两段：固定一条 / 自动挑选。
enum RunConfigMode { fixed, auto }

/// 自动挑选怎么挑：按顺序（failover）还是按难度（每轮判档）。
enum RunPickOrder { order, difficulty }

/// 按难度时档位从哪来：交给 Jev（按价格）/ 我自己标。
enum RunTiering { jev, manual }

/// 池子里的一行：一条线路挂在哪条车道上、钉什么模型。
class RunPoolRow {
  RunPoolRow({
    required this.lane,
    required this.providerId,
    this.model = '',
    this.autoModel = false,
    this.markedTier,
    this.problem,
    this.sendable = true,
  });

  /// 这条线路挂在哪条车道上（车道 id 字符串；`kimi` 没有 [SessionCli] 枚举值）。
  String lane;
  final String providerId;
  String model;
  bool autoModel;

  /// 「我自己标」下的档位：1 简单 / 2 中等 / 3 复杂；没点过是 null。
  int? markedTier;

  /// 琥珀色高亮的原因（遗留行/需要额外配置）。有值仍然照常上 wire —— 它只是
  /// 提醒，服务端不检查 key 在不在。
  String? problem;

  /// 线路已经不在目录里了（或原生前缀坏了）：上 wire 服务端会整单拒掉，所以
  /// 这一行只留在面板上给用户改/删，不进候选，也不算「有效行」。
  bool sendable;

  String get id => '$lane:$providerId';
}

/// 面板交回去的那份选择。字段名沿用调用方一直读的那套（provider / model /
/// effort + 三个 label），外加 selection / subagent / agent 与「要不要先换车道」。
class RunConfigOutcome {
  const RunConfigOutcome({
    required this.provider,
    required this.model,
    required this.effort,
    required this.providerLabel,
    required this.modelLabel,
    required this.effortLabel,
    this.providerSelection,
    this.subagent,
    this.agent,
    this.switchToCli,
  });

  final String provider;
  final String model;
  final String effort;
  final String providerLabel;
  final String modelLabel;
  final String effortLabel;
  final SessionProviderSelection? providerSelection;
  final SessionSubagent? subagent;
  final String? agent;

  /// 保存前要先切过去的车道（固定一条换了 CLI，或自动挑选的池子里没有会话现在
  /// 这条车道）。null = 车道不动。切换响应里的 pending 由 SessionManager 处理。
  final String? switchToCli;
}

/// 固定一条的折算结果：要么成功，要么带着一句给用户看的话。
class RunWireResult {
  const RunWireResult.success(this.outcome) : error = null;
  const RunWireResult.failure(this.error) : outcome = null;

  final RunConfigOutcome? outcome;
  final String? error;

  bool get ok => outcome != null;
}

String protocolLabelOf(String protocol) => switch (protocol) {
  'anthropic' => 'Anthropic',
  'openai_responses' => 'OpenAI Responses',
  'openai_chat' => 'OpenAI Chat',
  _ => protocol,
};

/// 子任务尾巴的折算：模型有值才算数（只挑线路不挑模型 = 没设）。线路留空时用
/// 这一轮实际生效的主 Provider —— Auto 档下就是排第一的那个有效候选。
SessionSubagent? buildSubagent({
  required String subProviderId,
  required String subModel,
  required String mainProvider,
}) {
  final model = subModel.trim();
  if (model.isEmpty) return null;
  final provider = subProviderId.trim().isEmpty
      ? mainProvider
      : subProviderId.trim();
  return SessionSubagent(providerId: provider, model: model);
}

/// 固定一条。`providerId` 空串 = 用这条车道自己的官方/原生配置。
RunWireResult buildFixedOutcome({
  required SessionCli cli,
  required String currentCli,
  required String providerId,
  required String model,
  required String effort,
  required String providerLabel,
  required String modelLabel,
  required String? subProviderId,
  required String? subModel,
  required bool includeAgent,
  required String? agent,
}) {
  final native = isOpenCodeNativeProvider(providerId);
  var provider = native ? '' : providerId;
  var wireModel = model.trim();
  // OpenCode 原生线路把 `<id>/<model>` 整个存进 model，provider 反而留空。
  final subagent = buildSubagent(
    subProviderId: subProviderId ?? '',
    subModel: subModel ?? '',
    mainProvider: provider,
  );
  return RunWireResult.success(
    RunConfigOutcome(
      provider: provider,
      model: wireModel,
      effort: effort,
      providerLabel: providerLabel,
      modelLabel: modelLabel,
      effortLabel: effortShortNameForCli(cli, effort),
      subagent: subagent,
      agent: includeAgent ? (agent ?? '').trim() : null,
      switchToCli: cli.name == currentCli ? null : cli.name,
    ),
  );
}

/// 自动挑选。返回 null 表示这份草稿存不了（[error] 说明为什么）。
class AutoWireInput {
  const AutoWireInput({
    required this.sessionLane,
    required this.rows,
    required this.pickOrder,
    required this.tiering,
    required this.maxAttempts,
    required this.sticky,
    required this.allowCrossTrust,
    required this.previousRouting,
  });

  final String sessionLane;
  final List<RunPoolRow> rows;
  final RunPickOrder pickOrder;
  final RunTiering tiering;
  final int maxAttempts;
  final bool sticky;
  final bool allowCrossTrust;
  final SessionProviderRouting? previousRouting;
}

class AutoWireResult {
  const AutoWireResult.success({
    required this.selection,
    required this.firstProviderId,
    required this.firstModel,
    required this.protocol,
    required this.switchToCli,
  }) : error = null,
       code = null;

  const AutoWireResult.failure(this.error, {this.code})
    : selection = null,
      firstProviderId = '',
      firstModel = '',
      protocol = '',
      switchToCli = null;

  final SessionProviderSelection? selection;
  final String firstProviderId;
  final String firstModel;
  final String protocol;
  final String? switchToCli;

  /// 给用户看的一句话。
  final String? error;

  /// 服务端本来会回的那个错误码（`provider_routing_requires_tiers` 之类）。
  final String? code;

  bool get ok => selection != null;
}

AutoWireResult buildAutoSelection(AutoWireInput input) {
  final usable = input.rows.where((row) => row.sendable).toList();
  if (usable.length < 2) {
    return const AutoWireResult.failure(
      '至少要有两条能用的线路',
      code: 'insufficient_candidates',
    );
  }
  final protocol = _deriveProtocol(usable);
  final difficulty = input.pickOrder == RunPickOrder.difficulty;
  final priceTiered = difficulty && input.tiering == RunTiering.jev;

  SessionProviderRouting? routing;
  var candidates = <SessionProviderCandidate>[];
  if (difficulty) {
    final order = input.rows.where((row) => row.sendable).toList();
    final result = serializeAutoRouting(
      routes: [
        for (var index = 0; index < order.length; index += 1)
          AutoRoutedRoute(
            providerId: order[index].providerId,
            model: order[index].autoModel || order[index].model.trim().isEmpty
                ? null
                : order[index].model.trim(),
            priority: index + 1,
            rung: priceTiered ? 1 : (order[index].markedTier ?? 0),
          ),
      ],
      onUnknown: 'strong',
      previous: input.previousRouting,
      tiering: priceTiered ? 'price' : 'manual',
    );
    if (!result.ok) {
      return AutoWireResult.failure(
        result.error ?? '档位配置不合法',
        code: result.code,
      );
    }
    routing = result.routing;
    candidates = [
      for (var index = 0; index < order.length; index += 1)
        SessionProviderCandidate(
          providerId: order[index].providerId,
          model: order[index].model.trim().isEmpty
              ? null
              : order[index].model.trim(),
          priority: index + 1,
          enabled: true,
          tier: result.candidates[index].tier,
          cli: order[index].lane,
          autoModel: priceTiered && order[index].autoModel,
        ),
    ];
  } else {
    candidates = [
      for (var index = 0; index < usable.length; index += 1)
        SessionProviderCandidate(
          providerId: usable[index].providerId,
          model: usable[index].model.trim().isEmpty
              ? null
              : usable[index].model.trim(),
          priority: index + 1,
          enabled: true,
          cli: usable[index].lane,
        ),
    ];
  }
  final maxAttempts = input.maxAttempts.clamp(
    2,
    usable.length.clamp(2, kAutoMaxAttempts),
  );
  final selection = SessionProviderSelection(
    protocol: protocol,
    candidates: candidates,
    maxAttempts: maxAttempts,
    sticky: input.sticky,
    allowCrossTrust: input.allowCrossTrust,
    routing: routing,
    cliSwitch: difficulty ? 'routing' : 'failover',
  );
  final lane = candidates.first.cli;
  return AutoWireResult.success(
    selection: selection,
    firstProviderId: candidates.first.providerId,
    firstModel: candidates.first.model ?? '',
    protocol: protocol,
    switchToCli: lane == null || lane == input.sessionLane ? null : lane,
  );
}

/// 池子的协议：第一条能说话的线路说了算；全是 OpenCode 原生（协议无关）就用
/// 服务端那个中性默认 anthropic。
String _deriveProtocol(List<RunPoolRow> rows) {
  for (final row in rows) {
    if (isOpenCodeNativeProvider(row.providerId)) continue;
    final protocol = kLaneProtocols[row.lane];
    if (protocol != null && protocol.isNotEmpty) return protocol.first;
  }
  return 'anthropic';
}
